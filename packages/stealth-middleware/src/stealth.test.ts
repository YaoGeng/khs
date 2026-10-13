import { describe, it, expect } from 'vitest';
import {
  STEALTH_LAUNCH_ARGS,
  RemoteDebuggingArgError,
  UA_VIEWPORT_POLICY,
  WEBDRIVER_FLAG_REMOVAL_SCRIPT,
  assertNoRemoteDebuggingArgs,
} from './stealth.js';

describe('stealth: navigator.webdriver 去标志（02 §7.2 :339 保守降噪①）', () => {
  it('行为级：fake navigator 上 webdriver getter 返回 undefined，其余属性不受影响', () => {
    const nav = { webdriver: true, userAgent: 'Mozilla/5.0 (real)', languages: ['zh-CN'] };
    const run = new Function('navigator', WEBDRIVER_FLAG_REMOVAL_SCRIPT);
    expect(() => run(nav)).not.toThrow();
    expect(nav.webdriver).toBeUndefined();
    expect(nav.userAgent).toBe('Mozilla/5.0 (real)');
    expect(nav.languages).toEqual(['zh-CN']);
  });

  it('脚本为声明式降噪（无任何功能/网络/写入面）', () => {
    expect(WEBDRIVER_FLAG_REMOVAL_SCRIPT).toContain('webdriver');
    expect(WEBDRIVER_FLAG_REMOVAL_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|eval\(|innerHTML|document\.cookie/);
  });
});

describe('stealth: 自动化提示条抑制 launch 参数形态（:339 保守降噪②）', () => {
  it('形态 = AutomationControlled 禁用标志，只读冻结', () => {
    expect(STEALTH_LAUNCH_ARGS).toContain('--disable-blink-features=AutomationControlled');
    expect(Object.isFrozen(STEALTH_LAUNCH_ARGS)).toBe(true);
  });

  it('形态内不含任何 remote-debugging 参数（M0 红线内建）', () => {
    expect(() => assertNoRemoteDebuggingArgs([...STEALTH_LAUNCH_ARGS])).not.toThrow();
    expect(STEALTH_LAUNCH_ARGS.join(' ')).not.toMatch(/remote-debugging-port/i);
  });

  it('assertNoRemoteDebuggingArgs：红线参数抛错，常规参数放行', () => {
    expect(() => assertNoRemoteDebuggingArgs(['--disable-blink-features=AutomationControlled', '--no-first-run'])).not.toThrow();
    expect(() => assertNoRemoteDebuggingArgs(['--remote-debugging-port=0'])).toThrow(RemoteDebuggingArgError);
    expect(() => assertNoRemoteDebuggingArgs(['--REMOTE-DEBUGGING-PORT=9222'])).toThrow(RemoteDebuggingArgError);
  });
});

describe('stealth: UA/视口真实一致策略（:339 保守降噪③ + 底线）', () => {
  it('不伪造 UA/视口；Canvas/WebGL 深度伪装明确不做（02:339 底线）', () => {
    expect(UA_VIEWPORT_POLICY.mode).toBe('real-browser-consistent');
    expect(UA_VIEWPORT_POLICY.fabrication).toBe(false);
    expect(UA_VIEWPORT_POLICY.canvasWebglDeepFake).toBe(false);
    expect(Object.isFrozen(UA_VIEWPORT_POLICY)).toBe(true);
  });
});
