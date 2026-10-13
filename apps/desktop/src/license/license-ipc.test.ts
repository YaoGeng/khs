/**
 * license IPC 通道单测（todo 8：走 T4 注册表模式——白名单 + zod 入参 + 出口契约校验）。
 * deps.license 用 stub 隔离真实验签逻辑（其本身在 license-manager.test.ts 覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, IPC_ERRORS } from '../shared/channels';
import {
  LicenseActivateParamsSchema,
  LicenseStatusParamsSchema,
  LicenseStatusResultSchema,
} from '../shared/schemas';
import { buildIpcRegistry, invokeIpcEntry, type AppInfoDeps, type LicenseIpcDeps, type IpcInvokeResult } from '../main/ipc-core';
import type { ConsentStateResult } from '../shared/schemas';

const unlockedStatus = {
  state: 'unlocked' as const,
  reason: 'WITHIN_GRACE',
  plan: 'month',
  tier: 'personal',
  deviceLimit: 1,
  expiresAt: '2026-11-11T00:00:00.000Z',
  lastVerifiedAt: '2026-10-11T09:00:00.000Z',
  graceEndsAt: '2026-10-14T09:00:00.000Z',
  deviceHash: 'a'.repeat(64),
  licenseDeviceHash: '',
};

/** todo 11：日志/任务依赖 stub（license 测试只保注册表契约） */
const logTaskStub = {
  queryLogs: async () => ({ rows: [] }),
  createDemoTask: async () => ({ taskId: 'stub' }),
  listTasks: async () => ({ tasks: [] }),
  resumeTask: async (taskId: string) => ({ taskId, status: 'running' }),
  cancelTask: async (taskId: string) => ({ taskId, status: 'cancelled' }),
};

/** todo 9：合规依赖 stub（真实逻辑在 compliance/*.test.ts 单测；license 测试只保注册表契约） */
const acceptedState: ConsentStateResult = {
  eulaVersion: '0.1.0-draft',
  eulaStatus: 'accepted',
  requiresConfirm: false,
  confirmedVersion: '0.1.0-draft',
  confirmedAt: '2026-10-11T00:00:00.000Z',
  rejectedAt: null,
  telemetryConsent: 'unasked',
};
const consentStub = {
  state: async () => acceptedState,
  acceptEula: async () => acceptedState,
  rejectEula: async () => acceptedState,
  setTelemetry: async () => acceptedState,
  isViewAllowed: () => true,
};

/** todo 10：浏览器依赖 stub（真实逻辑在 browser/*.test.ts 单测；license 测试只保注册表契约） */
const browserStub = {
  status: async () => ({
    state: 'detached' as const,
    yielded: false,
    yieldReason: null,
    browserVersion: null,
    browserPid: null,
    browserPath: null,
    browserSource: null,
    profileDir: 'C:/profile-root',
    currentPlatform: null,
    openTabs: null,
    attachedAt: null,
    lastError: null,
  }),
  openPlatform: async (params: { platform: string }) => ({
    ok: true as const,
    state: 'attached' as const,
    platform: params.platform as 'xhs' | '1688',
    url: 'https://example.invalid',
    targetId: null,
    launchedNow: true,
    browserVersion: null,
  }),
  disconnect: async () => ({ ok: true as const, state: 'detached' as const, browserClosed: true }),
};

function makeDeps(license: Partial<LicenseIpcDeps>): AppInfoDeps {
  return {
    appInfo: () => ({
      appVersion: '0.1.0',
      electronVersion: '33.4.11',
      platform: 'win32',
      contractVersion: 'm0-ipc-1',
    }),
    license: {
      activate: license.activate ?? (() => unlockedStatus),
      status: license.status ?? (() => unlockedStatus),
    },
    logTask: logTaskStub,
    browser: browserStub,
    consent: consentStub,
  };
}

function expectOk(result: IpcInvokeResult): { data: unknown } {
  expect(result.ok, `应为成功，实际 ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return { data: result.data };
}

function expectFail(result: IpcInvokeResult, code: string): void {
  expect(result.ok, `应为失败(${code})，实际 ${JSON.stringify(result)}`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.code).toBe(code);
}

describe('license 通道注册（T4 注册表模式延续）', () => {
  it('注册表键集与 IPC_CHANNELS 完全一致（含新增 license 两通道）', () => {
    const registry = buildIpcRegistry(makeDeps({}));
    expect([...registry.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
    expect(registry.has('license:activate')).toBe(true);
    expect(registry.has('license:status')).toBe(true);
  });
});

describe('license:activate（zod 入参 + 出口契约）', () => {
  it('合法入参：转发给 deps.activate 并回传状态机出口', () => {
    let received: unknown = null;
    const registry = buildIpcRegistry(
      makeDeps({
        activate: (params) => {
          received = params;
          return unlockedStatus;
        },
      }),
    );
    const { data } = expectOk(invokeIpcEntry(registry, 'license:activate', { licenseJwt: 'x'.repeat(40) }));
    expect(received).toEqual({ licenseJwt: 'x'.repeat(40) });
    expect(data).toMatchObject({ state: 'unlocked', reason: 'WITHIN_GRACE' });
  });

  it('非法入参：缺 licenseJwt / 非字符串 / 多余键 → E-IPC-INVALID-PARAMS', () => {
    const registry = buildIpcRegistry(makeDeps({}));
    for (const payload of [{}, { licenseJwt: '' }, { licenseJwt: 42 }, { licenseJwt: 'x', evil: 1 }]) {
      expectFail(invokeIpcEntry(registry, 'license:activate', payload), IPC_ERRORS.INVALID_PARAMS);
    }
  });

  it('出口数据损坏（缺 reason/state 非法）→ 抛稳定错误码', () => {
    const registry = buildIpcRegistry(
      makeDeps({ activate: () => ({ state: 'weird' } as unknown as ReturnType<LicenseIpcDeps['activate']>) }),
    );
    // 出口契约校验失败：handle 内 throw（与 app:info 同模式）→ ipcMain.handle 层转为 promise 拒绝
    expect(() => invokeIpcEntry(registry, 'license:activate', { licenseJwt: 'x'.repeat(40) })).toThrow(
      /E-IPC-INVALID-PARAMS/,
    );
  });
});

describe('license:status（zod 入参 + 出口契约）', () => {
  it('合法空参：返回锁定状态机快照', () => {
    const lockedStatus = { state: 'locked' as const, reason: 'NO_LICENSE' };
    const registry = buildIpcRegistry(makeDeps({ status: () => lockedStatus }));
    const { data } = expectOk(invokeIpcEntry(registry, 'license:status', {}));
    expect(data).toEqual(lockedStatus);
  });

  it('多余键 → E-IPC-INVALID-PARAMS（strict）', () => {
    const registry = buildIpcRegistry(makeDeps({}));
    expectFail(invokeIpcEntry(registry, 'license:status', { evil: true }), IPC_ERRORS.INVALID_PARAMS);
  });
});

describe('license zod schema（preload 侧同一份契约）', () => {
  it('LicenseActivateParamsSchema：非空串通过；空串/超长/多余键/非对象拒绝', () => {
    expect(LicenseActivateParamsSchema.safeParse({ licenseJwt: 'a.b.c' }).success).toBe(true);
    expect(LicenseActivateParamsSchema.safeParse({ licenseJwt: 'x'.repeat(8000) }).success).toBe(true);
    expect(LicenseActivateParamsSchema.safeParse({ licenseJwt: '' }).success).toBe(false);
    expect(LicenseActivateParamsSchema.safeParse({ licenseJwt: 'x'.repeat(8001) }).success).toBe(false);
    expect(LicenseActivateParamsSchema.safeParse({ licenseJwt: 'x', extra: 1 }).success).toBe(false);
    expect(LicenseActivateParamsSchema.safeParse(null).success).toBe(false);
  });

  it('LicenseStatusParamsSchema：仅空对象', () => {
    expect(LicenseStatusParamsSchema.safeParse({}).success).toBe(true);
    expect(LicenseStatusParamsSchema.safeParse({ x: 1 }).success).toBe(false);
  });

  it('LicenseStatusResultSchema：完整出口通过；缺 reason / 非法 state 拒绝', () => {
    expect(LicenseStatusResultSchema.safeParse(unlockedStatus).success).toBe(true);
    expect(LicenseStatusResultSchema.safeParse({ state: 'locked', reason: 'NO_LICENSE' }).success).toBe(true);
    expect(LicenseStatusResultSchema.safeParse({ state: 'locked' }).success).toBe(false);
    expect(LicenseStatusResultSchema.safeParse({ state: 'maybe', reason: 'X' }).success).toBe(false);
    expect(LicenseStatusResultSchema.safeParse({ state: 'locked', reason: 'X', deviceLimit: 0 }).success).toBe(false);
  });
});
