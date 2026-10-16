/**
 * 受控浏览器拉起（todo 10 = T-M0-08；S6 结论路线 A = --remote-debugging-pipe 托管）。
 *
 * 配方（bench/s6-debug/a1-pipe-raw.mjs 实测验证）：
 *   spawn(exe, [...args], { stdio: ['ignore','pipe','pipe','pipe','pipe'] })
 *   → fd3 写 CDP 命令 / fd4 读响应，`\0` 分帧；
 *   → 握手 = Browser.getVersion 真实往返（attach 就绪判据）。
 *
 * 红线：buildLaunchArgs 在 pipe 模式绝不产生 --remote-debugging-port*（S6：pipe 零 TCP 暴露面
 * 是选型核心理由）；port 模式只允许经 transport:'port' 显式配置（D6 fallback，默认关闭）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CdpConnection } from './cdp';

export type CdpTransportMode = 'pipe' | 'port';

export interface LaunchArgsOptions {
  profileDir: string;
  transport: CdpTransportMode;
  headless?: boolean;
}

/** 拉起参数（02 §5.1 + S6 §6：减面参数组；登录态全靠 --user-data-dir 专用 Profile） */
export function buildLaunchArgs(options: LaunchArgsOptions): string[] {
  const args = [
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    // 渲染节流三禁（2026-10-16 实采根因：窗口被应用窗遮挡/未激活时 Chromium 对
    // occluded window 节流 rAF/定时器，React hydration 拖过补轮窗——133+19 条互动数
    // 全 0；离屏实验 scripts/out/probe-engagement.json mountTimeline 证实可见窗口
    // 2.5s 挂载、离屏 10s 不挂载。本浏览器是应用自起的受控实例，渲染策略属工程配置，
    // 不涉及平台风控绕过；flag 不产生可检测的自动化指纹）
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  if (options.transport === 'pipe') {
    args.push('--remote-debugging-pipe');
  } else {
    args.push('--remote-debugging-port=0');
  }
  if (options.headless) args.push('--headless=new');
  args.push('about:blank');
  return args;
}

/** 红线自检：pipe 模式参数组不得出现任何调试端口参数 */
export function assertNoPortArgs(args: readonly string[]): void {
  const offender = args.find((arg) => arg.startsWith('--remote-debugging-port'));
  if (offender) {
    throw new Error(`E-BROWSER-LAUNCH-FAILED: pipe 模式禁止调试端口参数（出现 ${offender}）`);
  }
}

/** 单个子进程 stdio 元组类型（node 类型定义对 stdio 数组的收窄） */
export type BrowserStdio = ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'];

export interface PipeSpawnOptions {
  exePath: string;
  spawnImpl?: typeof spawn;
}

/** pipe 传输的 spawn 参数：stdio 五元组是协议要求（fd3/fd4），不是可调项 */
export function pipeSpawnOptions(): { stdio: BrowserStdio; windowsHide: boolean } {
  return { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true };
}

function io(child: ChildProcess): { fd3: NodeJS.WritableStream; fd4: NodeJS.ReadableStream } | null {
  const fd3 = child.stdio?.[3];
  const fd4 = child.stdio?.[4];
  if (!fd3 || !fd4) return null;
  return { fd3: fd3 as NodeJS.WritableStream, fd4: fd4 as NodeJS.ReadableStream };
}

export interface LaunchedPipeBrowser {
  child: ChildProcess;
  connection: CdpConnection;
  /** Browser.getVersion 真实往返结果（product/version/protocolVersion） */
  version: { product: string; version: string; protocolVersion: string };
  profileDir: string;
}

/**
 * pipe 路线拉起 + 握手（FR-3.1「自动通过 CDP 接管」）。
 * 失败模式：秒退（exit）/ 管道早闭（fd4 end）/ 握手超时——统一抛 E-BROWSER-* 稳定码。
 */
export async function launchPipeBrowser(options: PipeSpawnOptions & LaunchArgsOptions): Promise<LaunchedPipeBrowser> {
  const { exePath, profileDir, transport, headless } = options;
  const args = buildLaunchArgs({ profileDir, transport, headless });
  assertNoPortArgs(args);
  mkdirSync(profileDir, { recursive: true });

  const child = (options.spawnImpl ?? spawn)(exePath, args, pipeSpawnOptions());
  const streams = io(child);
  if (!streams) {
    child.kill();
    throw new Error('E-BROWSER-LAUNCH-FAILED: pipe stdio 五元组不可用（fd3/fd4 缺失）');
  }

  const connection = new CdpConnection({
    write: (frame) => {
      if (!streams.fd3.write(frame)) streams.fd3.once('drain', () => {});
    },
    onData: (handler) => streams.fd4.on('data', handler),
    onClose: (handler) => {
      child.once('exit', (code) => handler({ code }));
      streams.fd4.once('end', () => handler({ code: null }));
    },
    onError: (handler) => {
      streams.fd4.once('error', handler);
      streams.fd3.once('error', handler);
    },
    end: () => streams.fd3.end(),
  });

  // 握手期失败监视：握手成功后置位——此后进程退出走 onClose 通道，不产生未处理 rejection
  let handshakeDone = false;
  const exitWatcher = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      if (!handshakeDone) reject(new Error(`E-BROWSER-LAUNCH-FAILED: 浏览器进程在握手前退出（exit code=${code}）`));
    });
    child.once('error', (error) => {
      if (!handshakeDone) reject(new Error(`E-BROWSER-LAUNCH-FAILED: 进程错误 ${error.message}`));
    });
  });
  exitWatcher.catch(() => {}); // 竞态落败方向的清理（race 已消费的 rejection 无需上报）

  const handshake = connection
    .send<{ product?: string; version?: string; protocolVersion?: string }>('Browser.getVersion')
    .then((result) => ({
      product: result?.product ?? 'unknown',
      version: result?.version ?? 'unknown',
      protocolVersion: result?.protocolVersion ?? 'unknown',
    }));

  const version = await Promise.race([handshake, exitWatcher]);
  handshakeDone = true;
  return { child, connection, version, profileDir };
}

/** 平台可执行文件预检（探测到的路径必须真实存在才允许 spawn） */
export function assertExecutableAvailable(exePath: string): void {
  if (!exePath.toLowerCase().endsWith('.exe') || !existsSync(exePath)) {
    throw new Error(`E-BROWSER-NOT-FOUND: 探测结果不可用（${path.basename(exePath)}）`);
  }
}
