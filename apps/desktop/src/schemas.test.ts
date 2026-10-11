/**
 * zod IPC 契约校验用例（02 §4.3：通道即契约，入参 zod 校验）。
 * 覆盖合法/非法入参；schema 同时服务 preload 侧与 ipcMain.handle 侧。
 */
import { describe, expect, it } from 'vitest';
import {
  AppInfoParamsSchema,
  AppInfoResultSchema,
  LogsPingParamsSchema,
  NavigateParamsSchema,
  NavigateResultSchema,
} from './shared/schemas';

describe('AppInfoParamsSchema', () => {
  it('合法：空对象', () => {
    expect(AppInfoParamsSchema.safeParse({}).success).toBe(true);
  });

  it('非法：携带多余键（strict 拒绝）', () => {
    expect(AppInfoParamsSchema.safeParse({ evil: 'payload' }).success).toBe(false);
  });

  it('非法：undefined / null / 标量', () => {
    expect(AppInfoParamsSchema.safeParse(undefined).success).toBe(false);
    expect(AppInfoParamsSchema.safeParse(null).success).toBe(false);
    expect(AppInfoParamsSchema.safeParse(1).success).toBe(false);
  });
});

describe('AppInfoResultSchema', () => {
  const valid = {
    appVersion: '0.1.0',
    electronVersion: '33.4.11',
    platform: 'win32',
    contractVersion: 'm0-ipc-1',
  };

  it('合法：完整出口数据', () => {
    expect(AppInfoResultSchema.safeParse(valid).success).toBe(true);
  });

  it('非法：缺字段', () => {
    expect(AppInfoResultSchema.safeParse({ ...valid, appVersion: undefined }).success).toBe(false);
  });
});

describe('NavigateParamsSchema（九视图白名单）', () => {
  it.each([
    'dashboard',
    'insight',
    'report',
    'sourcing',
    'publish',
    'promo',
    'review',
    'logs',
    'settings',
  ] as const)('合法：view=%s', (view) => {
    expect(NavigateParamsSchema.safeParse({ view }).success).toBe(true);
  });

  it('非法：业务通道风格视图名（workflow 视图不属于九视图）', () => {
    expect(NavigateParamsSchema.safeParse({ view: 'workflow' }).success).toBe(false);
  });

  it('非法：非字符串 / 缺键 / 多余键', () => {
    expect(NavigateParamsSchema.safeParse({ view: 42 }).success).toBe(false);
    expect(NavigateParamsSchema.safeParse({}).success).toBe(false);
    expect(NavigateParamsSchema.safeParse({ view: 'dashboard', extra: 1 }).success).toBe(false);
  });
});

describe('NavigateResultSchema', () => {
  it('合法：ok 恒为 true', () => {
    expect(NavigateResultSchema.safeParse({ ok: true, view: 'logs' }).success).toBe(true);
  });

  it('非法：ok=false / 视图越权', () => {
    expect(NavigateResultSchema.safeParse({ ok: false, view: 'logs' }).success).toBe(false);
    expect(NavigateResultSchema.safeParse({ ok: true, view: 'anything-else' }).success).toBe(false);
  });
});

describe('LogsPingParamsSchema', () => {
  it('合法：1~200 字符消息', () => {
    expect(LogsPingParamsSchema.safeParse({ message: 'hi' }).success).toBe(true);
    expect(LogsPingParamsSchema.safeParse({ message: 'x'.repeat(200) }).success).toBe(true);
  });

  it('非法：空串 / 超长 / 非字符串', () => {
    expect(LogsPingParamsSchema.safeParse({ message: '' }).success).toBe(false);
    expect(LogsPingParamsSchema.safeParse({ message: 'x'.repeat(201) }).success).toBe(false);
    expect(LogsPingParamsSchema.safeParse({ message: 42 }).success).toBe(false);
  });
});
