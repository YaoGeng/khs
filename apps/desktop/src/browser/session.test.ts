/**
 * 三态会话状态机 + 让位标志 + 登录失效规则单测（todo 10 = T-M0-08；FR-3.4/3.5、FR-4.5）。
 */
import { describe, expect, it } from 'vitest';
import {
  isLoginExpiredUrl,
  resolveSessionTransition,
  YieldFlag,
  type BrowserSessionEvent,
  type BrowserSessionState,
} from './session';

describe('三态状态机（FR-3.5：未接管/已接管/登录失效）', () => {
  const cases: Array<[BrowserSessionState, BrowserSessionEvent, BrowserSessionState]> = [
    ['detached', { type: 'TAKEOVER_OK' }, 'attached'],
    ['attached', { type: 'DISCONNECT', reason: 'user' }, 'detached'],
    ['attached', { type: 'BROWSER_LOST', reason: 'r' }, 'detached'],
    ['attached', { type: 'LOGIN_EXPIRED', url: 'https://www.xiaohongshu.com/login' }, 'login-expired'],
    ['login-expired', { type: 'LOGIN_RECOVERED', url: 'https://www.xiaohongshu.com/' }, 'attached'],
    ['login-expired', { type: 'DISCONNECT', reason: 'user' }, 'detached'],
    ['login-expired', { type: 'BROWSER_LOST', reason: 'r' }, 'detached'],
    ['login-expired', { type: 'TAKEOVER_OK' }, 'attached'],
  ];
  for (const [from, event, to] of cases) {
    it(`${from} --${event.type}--> ${to}`, () => {
      expect(resolveSessionTransition(from, event)).toBe(to);
    });
  }

  it('非法迁移返回 null（detached 下不能直接失效/丢失）', () => {
    expect(resolveSessionTransition('detached', { type: 'BROWSER_LOST', reason: 'r' })).toBeNull();
    expect(resolveSessionTransition('detached', { type: 'LOGIN_EXPIRED', url: 'x' })).toBeNull();
    expect(resolveSessionTransition('detached', { type: 'DISCONNECT', reason: 'r' })).toBeNull();
  });
});

describe('登录失效 URL 规则（FR-3.4 M0 从简口径：仅 URL 层）', () => {
  it('xhs：/login 路径命中；首页/详情不误报', () => {
    expect(isLoginExpiredUrl('https://www.xiaohongshu.com/login?next=/explore', 'xhs')).toBe(true);
    expect(isLoginExpiredUrl('https://www.xiaohongshu.com/explore', 'xhs')).toBe(false);
    expect(isLoginExpiredUrl('https://www.xiaohongshu.com/', 'xhs')).toBe(false);
  });

  it('1688：login 子域整域命中', () => {
    expect(isLoginExpiredUrl('https://login.1688.com/member/signin.htm', '1688')).toBe(true);
    expect(isLoginExpiredUrl('https://www.1688.com/', '1688')).toBe(false);
  });

  it('非法 URL / 其他域名不误报', () => {
    expect(isLoginExpiredUrl('not-a-url', 'xhs')).toBe(false);
    expect(isLoginExpiredUrl('https://evil.example/login', 'xhs')).toBe(false);
  });
});

describe('YieldFlag（FR-4.5 让位机制：状态标志 + 自动化门）', () => {
  it('engage → snapshot / release 幂等语义', () => {
    const flag = new YieldFlag();
    expect(flag.snapshot()).toEqual({ yielded: false, reason: null, source: null, since: null });
    flag.engage('user-input', 'user-activity', new Date('2026-10-11T00:00:00Z'));
    expect(flag.snapshot()).toEqual({ yielded: true, reason: 'user-activity', source: 'user-input', since: '2026-10-11T00:00:00.000Z' });
    // 重复 engage 幂等（计数只 +1）
    flag.engage('manual', 'second', new Date('2026-10-11T00:00:01Z'));
    expect(flag.yieldCount).toBe(1);
    expect(flag.release()).toBe(true);
    expect(flag.snapshot().yielded).toBe(false);
    expect(flag.release()).toBe(false);
  });

  it('whenAutomationAllowed：让位期间挂起，release 后放行（M1 自动化队列门）', async () => {
    const flag = new YieldFlag();
    await flag.whenAutomationAllowed(); // 未让位：直通
    flag.engage('e2e-hook', 'test', new Date());
    let released = false;
    const gate = flag.whenAutomationAllowed().then(() => (released = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(released).toBe(false);
    flag.release();
    await gate;
    expect(released).toBe(true);
  });
});
