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
import { encodeCdpFrame, type CdpMessage } from './cdp';
// eslint-disable-next-line no-restricted-imports -- todo 10：Logger 类型源=logger 基础设施包（边界例外同 tasks/runner.ts）
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
