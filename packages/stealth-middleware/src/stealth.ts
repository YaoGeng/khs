/**
 * stealth 保守三项（T-M1-03 / 02-系统架构设计.md §7.2 :339 指纹降噪底线）。
 *
 * §7.5 参数表引用值（照抄）：
 *   humanizer.fingerprint_floor  仅保守降噪（去 navigator.webdriver、关自动化提示条、真实 UA/视口）；
 *                                不做 Canvas/WebGL 深度伪造（单一真实 Profile 原则）  §7.2（:339）
 *
 * 只导出常量/类型——宿主（todo-7）在 launch/注入时应用；本包不做任何进程/CDP 调用。
 */

/**
 * navigator.webdriver 去标志注入脚本源码（§7.2 :339 保守降噪第 1 项）。
 * 声明性降噪（属性 getter 返回 undefined），非功能伪造；宿主经
 * `Page.addScriptToEvaluateOnNewDocument` 注入，执行时机与失败兜底归宿主。
 */
export const WEBDRIVER_FLAG_REMOVAL_SCRIPT = `(function () {
  'use strict';
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: function () { return undefined; },
      configurable: true,
    });
  } catch (e) { /* 降噪失败不影响页面 */ }
})();`;

/**
 * 自动化提示条抑制的 launch 参数形态（§7.2 :339 保守降噪第 2 项）。
 * 只含声明式禁用标志；绝不包含任何 `--remote-debugging-port*`（M0 红线：
 * docs/adr/notes-browser-m0.md §7「pipe 路线绝不传 remote-debugging-port*」）。
 */
export const STEALTH_LAUNCH_ARGS: readonly string[] = Object.freeze(['--disable-blink-features=AutomationControlled']);

export class RemoteDebuggingArgError extends Error {
  readonly code = 'E-STEALTH-REMOTE-DEBUGGING-ARG';
  constructor(arg: string) {
    super(`forbidden launch arg (M0 red line, notes-browser-m0 §7): ${arg}`);
    this.name = 'RemoteDebuggingArgError';
  }
}

/** launch 参数红线守卫：出现 remote-debugging-port 形态参数即抛错（宿主组装参数后调用）。 */
export function assertNoRemoteDebuggingArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (/^--remote-debugging-port/i.test(arg)) throw new RemoteDebuggingArgError(arg);
  }
}

/**
 * UA/视口真实一致策略（§7.2 :339 保守降噪第 3 项）：
 * UA 与视口保持用户真实浏览器原值，不伪造、不覆盖；Canvas/WebGL 深度伪装明确不做。
 */
export const UA_VIEWPORT_POLICY = Object.freeze({
  mode: 'real-browser-consistent',
  /** 不伪造 UA / 视口 */
  fabrication: false,
  /** 明确不做 Canvas/WebGL 深度伪装（02:339 底线） */
  canvasWebglDeepFake: false,
  rationale: '02 §7.2（:339）: 保持真实 UA/视口；单一真实 Profile 原则，避免指纹自相矛盾触发风控。',
} as const);

export type StealthUaViewportPolicy = typeof UA_VIEWPORT_POLICY;
