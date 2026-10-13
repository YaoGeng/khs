/**
 * webPreferences 安全基线测试（02 §11.2：sandbox + contextIsolation + 禁用 nodeIntegration）。
 * security.ts 为纯函数（不 import electron），vitest 直接断言 + 快照。
 */
import { describe, expect, it } from 'vitest';
import { isChannelAllowed, isViewId, webPreferencesBaseline } from './main/security';

describe('webPreferencesBaseline（安全基线快照）', () => {
  it('快照：基线字段值锁定', () => {
    expect(webPreferencesBaseline('C:/app/out/preload.js')).toMatchSnapshot();
  });

  it('§11.2 三项硬基线：contextIsolation/sandbox 为 true，nodeIntegration 为 false', () => {
    const baseline = webPreferencesBaseline('x');
    expect(baseline.contextIsolation).toBe(true);
    expect(baseline.sandbox).toBe(true);
    expect(baseline.nodeIntegration).toBe(false);
    expect(baseline.preload).toBe('x');
  });

  it('Object.freeze：运行期篡改静默失败（strict mode 下抛错）', () => {
    const baseline = webPreferencesBaseline('x');
    expect(Object.isFrozen(baseline)).toBe(true);
    expect(() => {
      'use strict';
      (baseline as { nodeIntegration?: boolean }).nodeIntegration = true;
    }).toThrow();
  });

  it('每次调用返回新对象（防止共享可变引用）', () => {
    expect(webPreferencesBaseline('a')).not.toBe(webPreferencesBaseline('a'));
  });
});

describe('通道白名单（§4.3 + §11.2 preload 白名单）', () => {
  it('白名单内通道允许', () => {
    expect(isChannelAllowed('app:info')).toBe(true);
    expect(isChannelAllowed('app:navigate')).toBe(true);
    expect(isChannelAllowed('logs:ping')).toBe(true);
  });

  it('业务通道越权被拒（M0 未注册，M1+ 才有）', () => {
    expect(isChannelAllowed('workflow:start')).toBe(false);
    expect(isChannelAllowed('review:list')).toBe(false);
    expect(isChannelAllowed('keys:set')).toBe(false);
  });

  it('todo 10：受控浏览器通道进入 M0 白名单（FR-3.1/3.2/3.5）', () => {
    expect(isChannelAllowed('browser:status')).toBe(true);
    expect(isChannelAllowed('browser:openPlatform')).toBe(true);
    expect(isChannelAllowed('browser:disconnect')).toBe(true);
  });

  it('任意伪造通道被拒', () => {
    expect(isChannelAllowed('fs:readFile')).toBe(false);
    expect(isChannelAllowed('')).toBe(false);
  });
});

describe('九视图白名单（c端原型.html 九视图）', () => {
  it('九个视图 id 全部合法', () => {
    for (const view of [
      'dashboard',
      'insight',
      'report',
      'sourcing',
      'publish',
      'promo',
      'review',
      'logs',
      'settings',
    ]) {
      expect(isViewId(view)).toBe(true);
    }
  });

  it('登录视图不在九视图白名单（本地路由，不经 IPC）', () => {
    expect(isViewId('login')).toBe(false);
  });
});
