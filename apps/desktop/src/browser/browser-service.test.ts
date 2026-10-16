/**
 * 受控浏览器服务装配单测（todo 10 = T-M0-08）。
 *
 * 诚实性边界：CDP 连接层/编解码/关联逻辑为真实实现（复用 cdp.ts/launcher.ts），
 * 仅 OS 进程与注册表/文件系统探测用假实现替换——「已接管」判定走真实 Browser.getVersion /
 * Target.getTargets 往返，不 mock 协议层。真实 Chrome 的端到端证据在 e2e/browser-takeover.spec.ts。
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { BrowserService } from './browser-service';
import type { BuiltinInstallResult } from './builtin';
import { encodeCdpFrame, type CdpMessage } from './cdp';
import type { Logger } from '@xinglian/logger';

/* ------------------------------ 假 CDP 浏览器（fd3/fd4 对端） ------------------------------ */

interface SpawnCall {
  exePath: string;
  args: string[];
}

function createFakeBrowser(pid: number) {
  // fd3 = 父进程写命令端（假浏览器消费）；fd4 = 假浏览器写响应端（父进程读）
  const fd3 = new PassThrough();
  const fd4 = new PassThrough();
  /** 收到的全部 CDP 命令（method + params；镜像测试断言面） */
  const cdpCalls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const child = new EventEmitter() as EventEmitter & { kill: () => boolean; pid?: number; exitCode: number | null; stdio: unknown[] };
  child.pid = pid;
  child.exitCode = null;
  child.stdio = [null, null, null, fd3, fd4];

  let currentUrl = 'https://www.xiaohongshu.com/';
  let targetSeq = 0;
  let rx = Buffer.alloc(0);
  fd3.on('data', (chunk: Buffer) => {
    rx = Buffer.concat([rx, chunk]);
    for (;;) {
      const zero = rx.indexOf(0);
      if (zero < 0) break;
      const raw = rx.subarray(0, zero).toString('utf8');
      rx = rx.subarray(zero + 1);
      if (!raw) continue;
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        continue;
      }
      const reply = (result: unknown): void => {
        fd4.write(encodeCdpFrame({ id: message.id, result: result as never }));
      };
      cdpCalls.push({ method: message.method ?? '', params: (message.params ?? {}) as Record<string, unknown>, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
      switch (message.method) {
        case 'Browser.getVersion':
          reply({ product: 'Chrome/154.0.8037.98', version: '154.0.8037.98', protocolVersion: '1.3' });
          break;
        case 'Target.createTarget':
          targetSeq += 1;
          currentUrl = (message.params as { url?: string })?.url ?? currentUrl;
          reply({ targetId: `target-${targetSeq}` });
          break;
        case 'Target.getTargets':
          reply({ targetInfos: [{ targetId: `target-${targetSeq}`, type: 'page', url: currentUrl, title: '' }] });
          break;
        case 'Target.attachToTarget':
          reply({ sessionId: 'sess-1' });
          break;
        case 'Page.navigate':
          currentUrl = (message.params as { url?: string })?.url ?? currentUrl;
          reply({});
          break;
        case 'Browser.close':
          reply({});
          child.exitCode = 0;
          setImmediate(() => {
            child.emit('exit', 0);
          });
          break;
        default:
          reply({});
      }
    }
  });

  return {
    child: child as unknown as ChildProcess,
    kill: () => {
      child.exitCode = 1;
      child.emit('exit', 1);
    },
    setUrl: (url: string) => {
      currentUrl = url;
    },
    cdpCalls,
    /** 假浏览器主动推一帧 screencast（sessionId='sess-1' 平台标签 flat 会话） */
    pushScreencastFrame: (data: string, screencastSessionId: string) => {
      fd4.write(
        encodeCdpFrame({
          method: 'Page.screencastFrame',
          params: { data, sessionId: screencastSessionId, metadata: { surfaceWidth: 800, surfaceHeight: 600 } },
          sessionId: 'sess-1',
        }),
      );
    },
  };
}

const silentLogger: Logger = {
  categories: ['user-action', 'automation-step', 'llm-call', 'network-meta', 'system-error'],
  log: () => {},
  userAction: () => {},
  automationStep: () => {},
  llmCall: () => {},
  networkMeta: () => {},
  systemError: () => {},
  child: () => silentLogger,
  startSpan: () => ({ spanId: 's', logger: silentLogger, end: () => {} }),
  getBuffer: () => [],
  enforceRetention: async () => ({ filesDeleted: 0, sinkRowsDeleted: {} }),
  flush: async () => {},
  close: async () => {},
} as unknown as Logger;

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function makeService(overrides: {
  suspendRunningTasks?: (reason: string) => Promise<string[]>;
  healthIntervalMs?: number;
} = {}) {
  const spawnCalls: SpawnCall[] = [];
  const fakeBrowsers: ReturnType<typeof createFakeBrowser>[] = [];
  const spawnImpl = vi.fn((_exePath: string, args: readonly string[]) => {
    const fake = createFakeBrowser(42000 + spawnCalls.length + 1);
    fakeBrowsers.push(fake);
    spawnCalls.push({ exePath: _exePath, args: [...args] });
    return fake.child;
  });
  const suspendSpy = overrides.suspendRunningTasks ?? vi.fn(async () => []);
  const service = new BrowserService({
    logger: silentLogger,
    profileRoot: mkdtempSync(path.join(tmpdir(), 'xhs-browser-svc-')),
    healthIntervalMs: overrides.healthIntervalMs ?? 3600_000,
    relaunchDelayMs: 10,
    relaunchMaxAttempts: 2,
    spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    suspendRunningTasks: suspendSpy,
    detect: {
      registryQuery: async (key) => (key.includes('chrome.exe') ? CHROME_EXE : null),
      fileExists: (p) => p === CHROME_EXE,
    },
  });
  return { service, spawnCalls, spawnImpl, fakeBrowsers, suspendSpy };
}

describe('BrowserService（真实 CDP 层 + 假进程面）', () => {
  it('初始 status：detached / 未让位', async () => {
    const { service } = makeService();
    const status = await service.status();
    expect(status.state).toBe('detached');
    expect(status.yielded).toBe(false);
  });

  it('openPlatform：探测 → 拉起 → Browser.getVersion/Target.getTargets 真实往返 → attached + xiaohongshu 标签', async () => {
    const { service, spawnCalls } = makeService();
    const result = await service.openPlatform({ platform: 'xhs' });
    expect(result.ok).toBe(true);
    expect(result.launchedNow).toBe(true);
    expect(result.browserVersion).toBe('Chrome/154.0.8037.98');
    expect(result.url).toBe('https://www.xiaohongshu.com');

    const status = await service.status();
    expect(status.state).toBe('attached');
    expect(status.browserVersion).toBe('Chrome/154.0.8037.98');
    expect(status.browserPid).toBeTruthy();
    expect(status.browserSource).toBe('registry');
    expect(status.openTabs?.some((t) => t.url.includes('xiaohongshu.com'))).toBe(true);
    // Profile 目录 = <root>/xiaohongshu（FR-3.3 每平台独立）
    expect(status.profileDir.toLowerCase()).toContain('xiaohongshu');
    // 红线（S6 选型核心）：spawn 参数走 pipe、绝不携带调试端口
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toContain('--remote-debugging-pipe');
    expect(spawnCalls[0]!.args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
    expect(spawnCalls[0]!.args.some((a) => a.startsWith('--user-data-dir='))).toBe(true);
  });

  it('探测全空 → E-BROWSER-NOT-FOUND + 降级记录 + lastError', async () => {
    const service = new BrowserService({
      logger: silentLogger,
      profileRoot: mkdtempSync(path.join(tmpdir(), 'xhs-browser-svc-')),
      suspendRunningTasks: async () => [],
      detect: { registryQuery: async () => null, fileExists: () => false },
    });
    await expect(service.openPlatform({ platform: 'xhs' })).rejects.toThrow(/E-BROWSER-NOT-FOUND/);
    const status = await service.status();
    expect(status.state).toBe('detached');
    expect(status.lastError).toContain('E-BROWSER-NOT-FOUND');
  });

  it('崩溃联动：浏览器进程死亡 → 挂起任务（T11 runner）→ 同 Profile 自动重拉 → 回到 attached', async () => {
    const { service, fakeBrowsers, suspendSpy } = makeService();
    await service.openPlatform({ platform: 'xhs' });
    const firstStatus = await service.status();
    const firstPid = firstStatus.browserPid;

    // 真实 CDP 通道感知的对端假进程死亡（等价 e2e 的 taskkill）
    fakeBrowsers[0].kill();

    await vi.waitFor(async () => {
      const status = await service.status();
      if (status.state !== 'attached') throw new Error('not relaunched yet');
      expect(status.state).toBe('attached');
      expect(status.browserPid).not.toBe(firstPid);
    }, { timeout: 3000, interval: 30 });

    expect(suspendSpy).toHaveBeenCalledWith('browser-lost');
    const after = await service.status();
    expect(after.profileDir).toBe(firstStatus.profileDir); // 同 Profile（FR-3.3）
    expect(after.openTabs?.some((t) => t.url.includes('xiaohongshu.com'))).toBe(true);
  });

  it('一键断开（FR-3.5）：CDP + 进程一并关闭，不触发挂起/重拉', async () => {
    const suspend = vi.fn(async () => []);
    const { service, fakeBrowsers } = makeService({ suspendRunningTasks: suspend });
    await service.openPlatform({ platform: 'xhs' });
    const result = await service.disconnect();
    expect(result).toEqual({ ok: true, state: 'detached', browserClosed: true });
    const status = await service.status();
    expect(status.state).toBe('detached');
    expect(status.browserPid).toBeNull();
    expect(suspend).not.toHaveBeenCalled();
    // Browser.close 真实往返后进程优雅退出
    await new Promise((r) => setTimeout(r, 30));
    expect(fakeBrowsers[0].child.exitCode).toBe(0);
  });

  it('健康检测（FR-3.4 从简规则）：平台标签命中登录特征 → login-expired；离开 → 自动恢复 attached', async () => {
    const { service, fakeBrowsers } = makeService({ healthIntervalMs: 25 });
    await service.openPlatform({ platform: 'xhs' });
    const fake = fakeBrowsers[0];

    fake.setUrl('https://www.xiaohongshu.com/login?next=%2Fexplore');
    await vi.waitFor(async () => {
      const status = await service.status();
      if (status.state !== 'login-expired') throw new Error('not expired yet');
      expect(status.state).toBe('login-expired');
    }, { timeout: 3000, interval: 30 });

    fake.setUrl('https://www.xiaohongshu.com/explore');
    await vi.waitFor(async () => {
      const status = await service.status();
      if (status.state !== 'attached') throw new Error('not recovered yet');
      expect(status.state).toBe('attached');
    }, { timeout: 3000, interval: 30 });
  });

  it('让位标志（FR-4.5 M0 机制桩）：yieldToUser/resumeFromYield 经 status 出口', async () => {
    const { service } = makeService();
    service.yieldToUser('e2e-hook', 'test-yield');
    let status = await service.status();
    expect(status.yielded).toBe(true);
    expect(status.yieldReason).toBe('test-yield');
    expect(service.resumeFromYield()).toBe(true);
    status = await service.status();
    expect(status.yielded).toBe(false);
    expect(service.resumeFromYield()).toBe(false);
  });
});

describe('BrowserService：内置便携 Chromium（M2 B2）', () => {
  const BUILTIN_EXE = 'C:\\browsers\\chromium-1710741\\chrome-win\\chrome.exe';

  function makeBuiltinService(installResult: 'installed' | 'failed' = 'installed') {
    let installCalls = 0;
    let progressSink: ((received: number) => void) | null = null;
    let resolveInstall: ((result: BuiltinInstallResult) => void) | null = null;
    const service = new BrowserService({
      logger: silentLogger,
      profileRoot: mkdtempSync(path.join(tmpdir(), 'xhs-browser-svc-builtin-')),
      healthIntervalMs: 3600_000,
      spawnImpl: vi.fn(() => createFakeBrowser(43001).child) as unknown as typeof import('node:child_process').spawn,
      suspendRunningTasks: async () => [],
      detect: {
        registryQuery: async (key) => (key.includes('chrome.exe') ? CHROME_EXE : null),
        fileExists: (p) => p === CHROME_EXE,
      },
      builtin: {
        probe: async () => null, // 初始未安装
        install: (onProgress) => {
          installCalls += 1;
          progressSink = onProgress;
          // 手工控制 resolve：让测试能在 downloading 中间态做断言
          return new Promise<BuiltinInstallResult>((resolve) => {
            resolveInstall = resolve;
          });
        },
      },
    });
    const finishInstall = (): void => {
      resolveInstall?.(
        installResult === 'installed'
          ? { status: 'installed', exePath: BUILTIN_EXE, sha256: 'a'.repeat(64) }
          : { status: 'failed', code: 'E-BUILTIN-HASH-MISMATCH', attempts: 3, message: 'x' },
      );
    };
    return { service, getInstallCalls: () => installCalls, emitProgress: (n: number) => progressSink?.(n), finishInstall };
  }

  it('未装配 builtin → status.builtinInstall 为 null', async () => {
    const { service } = makeService();
    expect((await service.status()).builtinInstall).toBeNull();
  });

  it('安装触发 → 状态机 downloading→installed，进度字节回流，重复触发不重入', async () => {
    const { service, emitProgress, finishInstall, getInstallCalls } = makeBuiltinService();
    expect((await service.status()).builtinInstall).toMatchObject({ state: 'idle' });

    const started = await service.installBuiltin();
    expect(started).toEqual({ started: true, state: 'downloading' });
    emitProgress(1234);
    expect((await service.status()).builtinInstall).toMatchObject({ state: 'downloading', receivedBytes: 1234 });

    // 安装中重复触发：不重入
    const again = await service.installBuiltin();
    expect(again.started).toBe(false);

    finishInstall();
    await vi.waitFor(async () => {
      expect((await service.status()).builtinInstall).toMatchObject({ state: 'installed', receivedBytes: 360101018 });
    }, { timeout: 1000, interval: 20 });
    expect(getInstallCalls()).toBe(1);
  });

  it('安装失败 → failed + 错误留痕，不改变既有探测面', async () => {
    const { service, finishInstall } = makeBuiltinService('failed');
    await service.installBuiltin();
    finishInstall();
    await vi.waitFor(async () => {
      expect((await service.status()).builtinInstall).toMatchObject({ state: 'failed', attempts: 3 });
    }, { timeout: 1000, interval: 20 });
  });

  it('探测链经 deps.builtin.probe 命中内置（openPlatform 拉起的是探测返回的 exe）', async () => {
    const spawnedExe: string[] = [];
    const service = new BrowserService({
      logger: silentLogger,
      profileRoot: mkdtempSync(path.join(tmpdir(), 'xhs-browser-svc-builtin2-')),
      healthIntervalMs: 3600_000,
      spawnImpl: vi.fn((exePath: string) => {
        spawnedExe.push(exePath);
        return createFakeBrowser(44001).child;
      }) as unknown as typeof import('node:child_process').spawn,
      suspendRunningTasks: async () => [],
      detect: {
        registryQuery: async (key) => (key.includes('chrome.exe') ? CHROME_EXE : null),
        fileExists: (p) => p === CHROME_EXE,
      },
      builtin: {
        // assertExecutableAvailable 用真实 existsSync 预检——probe 返回真实存在的 exe 路径
        probe: async () => ({ exePath: CHROME_EXE }),
        install: () => Promise.resolve({ status: 'already-installed', exePath: CHROME_EXE }),
      },
    });
    await service.openPlatform({ platform: 'xhs' });
    expect(spawnedExe[0]).toBe(CHROME_EXE);
    const status = await service.status();
    expect(status.browserSource).toBe('builtin');
    expect(status.browserPath).toBe(CHROME_EXE);
  });
});

describe('BrowserService：应用内镜像预览（M2 产品卡①，screencast 只读投流）', () => {
  it('未接管浏览器 → startMirror 抛 E-BROWSER-CDP-ATTACH-FAILED', async () => {
    const { service } = makeService();
    await expect(service.startMirror()).rejects.toThrow('E-BROWSER-CDP-ATTACH-FAILED');
  });

  it('openPlatform 后 startMirror：attach 平台标签 + Page.startScreencast(jpeg)；帧事件 → ack 回传 + sink 转发', async () => {
    const { service, fakeBrowsers } = makeService();
    const frames: Array<{ dataBase64: string; width: number | null; height: number | null }> = [];
    service.attachMirrorSink((frame) => frames.push(frame));
    await service.openPlatform({ platform: 'xhs' });

    const result = await service.startMirror();
    expect(result.started).toBe(true);
    expect(service.mirrorActive).toBe(true);
    const fake = fakeBrowsers[0]!;
    const startCall = fake.cdpCalls.find((c) => c.method === 'Page.startScreencast');
    expect(startCall?.params).toMatchObject({ format: 'jpeg', maxWidth: 1024 });
    expect(startCall?.sessionId).toBe('sess-1');

    fake.pushScreencastFrame('aGk=', 'sc-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ dataBase64: 'aGk=', width: 800, height: 600 });
    // ack 必须带回帧的 screencast sessionId（否则浏览器停止推帧）
    const ackCall = fake.cdpCalls.find((c) => c.method === 'Page.screencastFrameAck');
    expect(ackCall?.params).toMatchObject({ sessionId: 'sc-1' });
    expect(ackCall?.sessionId).toBe('sess-1');

    await service.shutdown();
  });

  it('帧转发节流：200ms 内的第二帧被丢弃但仍 ack', async () => {
    const { service, fakeBrowsers } = makeService();
    const frames: unknown[] = [];
    service.attachMirrorSink((frame) => frames.push(frame));
    await service.openPlatform({ platform: 'xhs' });
    await service.startMirror();
    const fake = fakeBrowsers[0]!;

    fake.pushScreencastFrame('ZjE=', 'sc-1');
    fake.pushScreencastFrame('ZjI=', 'sc-2');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).toHaveLength(1);
    expect((frames[0] as { dataBase64: string }).dataBase64).toBe('ZjE=');
    expect(fake.cdpCalls.filter((c) => c.method === 'Page.screencastFrameAck')).toHaveLength(2);

    await service.shutdown();
  });

  it('stopMirror：Page.stopScreencast + 幂等；disconnect 联动清理（再 start 报未接管）', async () => {
    const { service, fakeBrowsers } = makeService();
    await service.openPlatform({ platform: 'xhs' });
    await service.startMirror();
    const fake = fakeBrowsers[0]!;

    const stop = await service.stopMirror();
    expect(stop.stopped).toBe(true);
    expect(service.mirrorActive).toBe(false);
    expect(fake.cdpCalls.some((c) => c.method === 'Page.stopScreencast')).toBe(true);
    // 幂等二次停止
    expect((await service.stopMirror()).stopped).toBe(true);

    // 断开联动：镜像态清空，浏览器关闭后再 start 需重新接管
    await service.disconnect();
    await expect(service.startMirror()).rejects.toThrow('E-BROWSER-CDP-ATTACH-FAILED');
  });
});
