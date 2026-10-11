/**
 * 合规 IPC 通道单测（todo 9：走 T4 注册表模式——白名单 + zod 入参 + 出口契约校验）。
 * deps.consent 用 stub（服务语义与持久化在 compliance-service.test.ts / eula / telemetry-guard 单测覆盖，
 * 此处保「注册表契约 + 入参校验 + app:navigate 主进程路由锁」）。
 */
import { describe, expect, it } from 'vitest';
import { E_EULA_LOCKED, EULA_LOCKED_VIEWS, IPC_CHANNELS, IPC_ERRORS } from '../shared/channels';
import {
  ConsentAcceptParamsSchema,
  ConsentSetTelemetryParamsSchema,
  ConsentStateResultSchema,
} from '../shared/schemas';
import { buildIpcRegistry, invokeIpcEntry, type AppInfoDeps, type ConsentDeps, type IpcInvokeResult } from '../main/ipc-core';
import type { ConsentStateResult } from '../shared/schemas';

const acceptedState: ConsentStateResult = {
  eulaVersion: '0.1.0-draft',
  eulaStatus: 'accepted',
  requiresConfirm: false,
  confirmedVersion: '0.1.0-draft',
  confirmedAt: '2026-10-11T00:00:00.000Z',
  rejectedAt: null,
  telemetryConsent: 'unasked',
};

const logTaskStub = {
  queryLogs: async () => ({ rows: [] }),
  createDemoTask: async () => ({ taskId: 'stub' }),
  listTasks: async () => ({ tasks: [] }),
  resumeTask: async (taskId: string) => ({ taskId, status: 'running' }),
  cancelTask: async (taskId: string) => ({ taskId, status: 'cancelled' }),
};

const consentStub: ConsentDeps = {
  state: async () => acceptedState,
  acceptEula: async () => acceptedState,
  rejectEula: async () => acceptedState,
  setTelemetry: async () => acceptedState,
  isViewAllowed: () => true,
};

function makeDeps(consent: Partial<ConsentDeps> = {}): AppInfoDeps {
  return {
    appInfo: () => ({
      appVersion: '0.1.0',
      electronVersion: '33.4.11',
      platform: 'win32',
      contractVersion: 'm0-ipc-1',
    }),
    license: {
      activate: () => ({ state: 'locked' as const, reason: 'NO_LICENSE' }),
      status: () => ({ state: 'locked' as const, reason: 'NO_LICENSE' }),
    },
    logTask: logTaskStub,
    consent: { ...consentStub, ...consent },
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

describe('consent 通道注册（T4 注册表模式延续）', () => {
  it('注册表键集与 IPC_CHANNELS 完全一致（含新增 consent 四通道）', () => {
    const registry = buildIpcRegistry(makeDeps());
    expect([...registry.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
    for (const channel of ['consent:state', 'consent:acceptEula', 'consent:rejectEula', 'consent:setTelemetry']) {
      expect(registry.has(channel as (typeof IPC_CHANNELS)[number])).toBe(true);
    }
  });
});

describe('consent:* zod 入参与出口契约', () => {
  it('consent:state 走注入依赖并通过出口 schema 校验', async () => {
    const registry = buildIpcRegistry(makeDeps());
    const entry = registry.get('consent:state');
    expect(entry).toBeDefined();
    const data = (await entry!.handle({} as never)) as ConsentStateResult;
    expect(ConsentStateResultSchema.safeParse(data).success).toBe(true);
    expect(data.eulaStatus).toBe('accepted');
  });

  it('consent:acceptEula 合法入参转发；缺 telemetryConsent/多余键被拒', async () => {
    const received: unknown[] = [];
    const registry = buildIpcRegistry(
      makeDeps({ acceptEula: (params) => (received.push(params), Promise.resolve(acceptedState)) }),
    );
    await registry.get('consent:acceptEula')!.handle({ telemetryConsent: true } as never);
    expect(received).toEqual([{ telemetryConsent: true }]);

    for (const bad of [{}, { telemetryConsent: 'yes' }, { telemetryConsent: true, extra: 1 }]) {
      expectFail(invokeIpcEntry(buildIpcRegistry(makeDeps()), 'consent:acceptEula', bad), IPC_ERRORS.INVALID_PARAMS);
    }
  });

  it('consent:rejectEula 合法（空参）；带键被拒（strict）', async () => {
    const registry = buildIpcRegistry(makeDeps());
    await expect(registry.get('consent:rejectEula')!.handle({} as never)).resolves.toBeTruthy();
    expectFail(invokeIpcEntry(buildIpcRegistry(makeDeps()), 'consent:rejectEula', { evil: true }), IPC_ERRORS.INVALID_PARAMS);
  });

  it('consent:setTelemetry 合法 enabled 布尔转发；缺键/非布尔被拒', async () => {
    const received: unknown[] = [];
    const registry = buildIpcRegistry(
      makeDeps({ setTelemetry: (params) => (received.push(params), Promise.resolve(acceptedState)) }),
    );
    await registry.get('consent:setTelemetry')!.handle({ enabled: false } as never);
    expect(received).toEqual([{ enabled: false }]);
    expect(ConsentSetTelemetryParamsSchema.safeParse({ enabled: 1 }).success).toBe(false);
    expect(ConsentSetTelemetryParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe('app:navigate EULA 路由锁（FR-1.9 主进程强制点）', () => {
  it('门未确认（isViewAllowed=false）：六个工作流视图全部拒绝且错误码稳定', () => {
    const registry = buildIpcRegistry(makeDeps({ isViewAllowed: () => false }));
    for (const view of EULA_LOCKED_VIEWS) {
      let message = '';
      try {
        invokeIpcEntry(registry, 'app:navigate', { view });
        expect.unreachable(`view=${view} 应被拒绝`);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `view=${view}`).toContain(E_EULA_LOCKED);
    }
  });

  it('门确认后（isViewAllowed=true）：九视图全部放行（原契约回显不变）', () => {
    const registry = buildIpcRegistry(makeDeps({ isViewAllowed: () => true }));
    for (const view of ['dashboard', 'insight', 'report', 'sourcing', 'publish', 'promo', 'review', 'logs', 'settings']) {
      const { data } = expectOk(invokeIpcEntry(registry, 'app:navigate', { view }));
      expect(data).toEqual({ ok: true, view });
    }
  });

  it('路由锁只拦工作流视图：logs/settings 恒可达（isViewAllowed 按视图判定）', () => {
    const registry = buildIpcRegistry(makeDeps({ isViewAllowed: (view) => !(EULA_LOCKED_VIEWS as readonly string[]).includes(view) }));
    for (const view of ['logs', 'settings', 'report']) {
      expectOk(invokeIpcEntry(registry, 'app:navigate', { view }));
    }
    expect(() => invokeIpcEntry(registry, 'app:navigate', { view: 'publish' })).toThrow(E_EULA_LOCKED);
  });
});

describe('入参 schema 独立抽查（shared 契约面）', () => {
  it('ConsentAcceptParamsSchema：telemetryConsent 必须是布尔（opt-in 显式选择，不允许缺省）', () => {
    expect(ConsentAcceptParamsSchema.safeParse({ telemetryConsent: false }).success).toBe(true);
    expect(ConsentAcceptParamsSchema.safeParse({ telemetryConsent: undefined }).success).toBe(false);
    expect(ConsentAcceptParamsSchema.safeParse(null).success).toBe(false);
  });
});
