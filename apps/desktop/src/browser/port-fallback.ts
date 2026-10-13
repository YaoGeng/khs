/**
 * D6 fallback：port=0 + 仅 loopback + PID 校验（todo 10 = T-M0-08；S6 §3 预置降级分支）。
 *
 * 默认不启用（S6 结论：pipe 可用，port 仅在「未来内核/打包形态不支持 pipe」时启用）。
 * 配置项：XINGLIAN_CDP_TRANSPORT=port（pipe 默认）。
 *
 * S6 边界（必须遵守）：port 模式对外来本机进程**无接入层拒绝能力**（Chrome 不做客户端隔离），
 * 本模块只做「发现+处置」所需的校验层：
 *   1. DevToolsActivePort 文件解析（端口发现，250-400ms 内出现）；
 *   2. netstat LISTENING 行解析 + 仅 loopback 断言；
 *   3. 监听进程 PID 在浏览器进程树内校验（防假浏览器/串台；**不进 CDP 可用性热路径**，
 *      S6 教训：CIM 查询 ~3s 会污染时延测量）；
 *   4. ws 连接用运行时全局 WebSocket（Electron 33 主进程 Node 20 无该全局量 → 明确报
 *      E-BROWSER-FALLBACK-UNAVAILABLE，不静默降级）。
 * 纯逻辑（1/2/3）与本文件拆开可 mock 直测；不设 e2e（S6 结论：fallback 无需 e2e）。
 */

/** DevToolsActivePort 文件内容 → 端口（首行 = 端口，次行 = 浏览器 ws path） */
export function parseDevToolsActivePort(content: string): number | null {
  const firstLine = content.split(/\r?\n/)[0]?.trim() ?? '';
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  if (port < 1 || port > 65535) return null;
  return port;
}

export interface NetstatRow {
  localAddr: string;
  port: number;
  remote: string;
  state: string;
  pid: number;
}

/** `netstat -ano -p tcp` 文本 → 结构化行（宽松解析，忽略表头/空行） */
export function parseNetstatRows(output: string): NetstatRow[] {
  const rows: NetstatRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+(\S+)\s+(\S+)\s+(\d+)$/i);
    if (m) {
      rows.push({ localAddr: m[1] ?? '', port: Number(m[2]), remote: m[3] ?? '', state: (m[4] ?? '').toUpperCase(), pid: Number(m[5]) });
    }
  }
  return rows;
}

export function isLoopbackAddress(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '[::1]';
}

export interface PortExposureCheck {
  ok: boolean;
  listener: NetstatRow | null;
  reason: string | null;
}

/**
 * 校验给定端口：有且仅有一条 LISTENING 行、绑定地址仅 loopback、owning pid 在预期集合内。
 * （S6：port 模式的 PID 校验防的是「连到假浏览器/串台」，不是防外来连接。）
 */
export function checkPortExposure(
  rows: readonly NetstatRow[],
  port: number,
  allowedPids: ReadonlySet<number>,
): PortExposureCheck {
  const listeners = rows.filter((r) => r.port === port && r.state === 'LISTENING');
  if (listeners.length === 0) return { ok: false, listener: null, reason: `端口 ${port} 无 LISTENING 行（浏览器未就绪或已退出）` };
  if (listeners.length > 1) return { ok: false, listener: listeners[0] ?? null, reason: `端口 ${port} 出现 ${listeners.length} 条 LISTENING 行（异常）` };
  const listener = listeners[0] as NetstatRow;
  if (!isLoopbackAddress(listener.localAddr)) return { ok: false, listener, reason: `端口 ${port} 绑定在非 loopback（${listener.localAddr}）——拒绝接管` };
  if (!allowedPids.has(listener.pid)) return { ok: false, listener, reason: `端口 ${port} 的监听进程 pid=${listener.pid} 不在浏览器进程树内（疑似串台）` };
  return { ok: true, listener, reason: null };
}

/** 进程表行（CIM Win32_Process 投影；isInProcessTree 沿 ParentProcessId 回溯） */
export interface ProcessInfoRow {
  pid: number;
  ppid: number;
  name: string;
}

/** targetPid 是否在 rootPid 的进程树内（S6 lib/util.mjs 同算法，32 跳上限防环） */
export function isInProcessTree(targetPid: number, rootPid: number, procs: readonly ProcessInfoRow[]): boolean {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let current = targetPid;
  for (let hop = 0; hop < 32; hop += 1) {
    if (current === rootPid) return true;
    const node = byPid.get(current);
    if (!node || node.ppid === current) return false;
    current = node.ppid;
  }
  return false;
}

/** fallback 运行时判据：全局 WebSocket 客户端存在性（Electron 33 主进程 Node 20 无） */
export function hasGlobalWebSocket(runtime: unknown): boolean {
  return typeof (runtime as { WebSocket?: unknown }).WebSocket === 'function';
}
