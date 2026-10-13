/**
 * D6 fallback 拉起（port=0 路线的 node 侧装配；默认不启用）。
 * 纯校验逻辑在纯函数区（parseDevToolsActivePort/checkPortExposure/isInProcessTree），
 * 本文件只做 spawn/文件轮询/进程查询的接线；ws 客户端用运行时全局 WebSocket。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CdpConnection, type CdpTransport } from './cdp';
import {
  checkPortExposure,
  hasGlobalWebSocket,
  isInProcessTree,
  parseDevToolsActivePort,
  parseNetstatRows,
  type ProcessInfoRow,
} from './port-fallback';

const pExecFile = promisify(execFile);

export interface PortFallbackOptions {
  exePath: string;
  profileDir: string;
  spawnImpl?: typeof spawn;
  /** DevToolsActivePort 轮询窗口（S6 实测 250-400ms 出现；留足余量） */
  portFileTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** 失败即明确报错（E-BROWSER-FALLBACK-UNAVAILABLE），绝不静默换路——降级是显式决策 */
async function requireGlobalWebSocket(): Promise<typeof WebSocket> {
  if (!hasGlobalWebSocket(globalThis)) {
    throw new Error('E-BROWSER-FALLBACK-UNAVAILABLE: 当前运行时无全局 WebSocket 客户端（pipe 路线不需要；port fallback 仅在支持该全局量的运行时可用）');
  }
  return (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
}

const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** 进程表单次快照（CIM 查询 ~3s：只在 attach 后校验用，禁止进热路径——S6 §3.2 教训） */
export async function listProcessesForGuard(): Promise<ProcessInfoRow[]> {
  const { stdout } = await pExecFile(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as Partial<Record<'ProcessId' | 'ParentProcessId' | 'Name', unknown>> | Array<Partial<Record<'ProcessId' | 'ParentProcessId' | 'Name', unknown>>>;
  const list = Array.isArray(data) ? data : [data];
  return list.map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name ?? '') }));
}

/**
 * port=0 fallback 拉起 + 校验 + ws 接管（整链路；默认配置不走到这里）。
 * 顺序（S6 §6 降级路径）：spawn → 轮询 DevToolsActivePort → attach 后校验（loopback+PID 树）→ ws。
 */
export async function launchPortFallbackBrowser(options: PortFallbackOptions): Promise<{
  child: ChildProcess;
  connection: CdpConnection;
  port: number;
  version: { product: string; version: string; protocolVersion: string };
}> {
  await requireGlobalWebSocket();
  const { exePath, profileDir } = options;
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    'about:blank',
  ];
  const child = (options.spawnImpl ?? spawn)(exePath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore'], windowsHide: true });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + (options.portFileTimeoutMs ?? 10_000);
  let port: number | null = null;
  while (Date.now() < deadline) {
    try {
      port = parseDevToolsActivePort(await readFile(portFile, 'utf8'));
      if (port !== null) break;
    } catch {
      // 文件未出现：继续轮询
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (port === null) {
    child.kill();
    throw new Error('E-BROWSER-LAUNCH-FAILED: DevToolsActivePort 未在窗口期内出现（port fallback）');
  }

  // loopback + PID 树校验（attach 后守卫位，非热路径）
  try {
    const { stdout } = await pExecFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true });
    const procs = await listProcessesForGuard();
    const treePids = new Set(procs.filter((p) => isInProcessTree(p.pid, child.pid ?? -1, procs)).map((p) => p.pid));
    const check = checkPortExposure(parseNetstatRows(stdout), port, new Set([...treePids, child.pid ?? -1]));
    if (!check.ok) {
      child.kill();
      throw new Error(`E-BROWSER-LAUNCH-FAILED: ${check.reason ?? 'port fallback 校验未通过'}`);
    }
  } catch (error) {
    child.kill();
    if (String((error as Error).message).startsWith('E-BROWSER-')) throw error;
    throw new Error(`E-BROWSER-LAUNCH-FAILED: port fallback 校验执行失败（${String((error as Error).message)}）`, { cause: error });
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('E-BROWSER-CDP-ATTACH-FAILED: fallback ws 握手失败')), { once: true });
  });

  const transport: CdpTransport = {
    write: (frame) => ws.send(new Uint8Array(frame)),
    onData: (handler) => ws.addEventListener('message', (event) => handler(Buffer.from(event.data as ArrayBuffer))),
    onClose: (handler) => {
      ws.addEventListener('close', () => handler({ code: ws.readyState === WebSocket.CLOSED ? 0 : null }));
      child.once('exit', (code) => handler({ code }));
    },
    onError: (handler) => ws.addEventListener('error', () => handler(new Error('fallback ws error'))),
    end: () => ws.close(),
  };
  const connection = new CdpConnection(transport);
  const result = (await connection.send<{ product?: string; version?: string; protocolVersion?: string }>(
    'Browser.getVersion',
  )) as { product?: string; version?: string; protocolVersion?: string };
  return {
    child,
    connection,
    port,
    version: {
      product: result.product ?? 'unknown',
      version: result.version ?? 'unknown',
      protocolVersion: result.protocolVersion ?? 'unknown',
    },
  };
}
