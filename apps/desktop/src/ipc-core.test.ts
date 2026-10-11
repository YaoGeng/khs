/**
 * IPC 注册表/调用核心单测（electron-free）：
 * - 注册表键集 === IPC_CHANNELS 白名单（防漏注册/私加通道）；
 * - invokeIpcEntry：合法入参直通、非法入参 E-IPC-INVALID-PARAMS、越权通道 E-IPC-UNKNOWN-CHANNEL。
 */
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, IPC_ERRORS } from './shared/channels';
import { buildIpcRegistry, invokeIpcEntry, type AppInfoDeps, type IpcInvokeResult } from './main/ipc-core';
import type { ConsentStateResult } from './shared/schemas';

/** todo 8：license 依赖 stub（真实逻辑在 license-manager.test.ts 单测；此处只保注册表契约） */
const licenseStub = {
  activate: () => ({ state: 'locked' as const, reason: 'NO_LICENSE' }),
  status: () => ({ state: 'locked' as const, reason: 'NO_LICENSE' }),
};

/** todo 9：合规依赖 stub（真实逻辑在 compliance/*.test.ts 单测；此处只保注册表契约） */
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

/** todo 11：日志/任务依赖 stub（真实逻辑在 store/*.test.ts、tasks/*.test.ts 单测） */
const logTaskStub = {
  queryLogs: async () => ({ rows: [] }),
  createDemoTask: async () => ({ taskId: 'stub-task-id' }),
  listTasks: async () => ({ tasks: [] }),
  resumeTask: async (taskId: string) => ({ taskId, status: 'running' }),
  cancelTask: async (taskId: string) => ({ taskId, status: 'cancelled' }),
};

const deps: AppInfoDeps = {
  appInfo: () => ({
    appVersion: '0.1.0',
    electronVersion: '33.4.11',
    platform: 'win32',
    contractVersion: 'm0-ipc-1',
  }),
  license: licenseStub,
  logTask: logTaskStub,
  consent: consentStub,
};

function expectOk(result: IpcInvokeResult): { data: unknown } {
  expect(result.ok, `应为成功，实际 ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return { data: result.data };
}

function expectFail(result: IpcInvokeResult, code: string): void {
  expect(result.ok, `应为失败(${code})，实际 ${JSON.stringify(result)}`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.code).toBe(code);
  expect(result.message.startsWith(code)).toBe(true);
}

describe('buildIpcRegistry（白名单不变量）', () => {
  it('注册表键集与 IPC_CHANNELS 完全一致', () => {
    const registry = buildIpcRegistry(deps);
    expect([...registry.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
  });
});

describe('invokeIpcEntry（ipcMain.handle 走的同一条路径）', () => {
  it('app:info 合法：返回契约内出口数据', () => {
    const { data } = expectOk(invokeIpcEntry(buildIpcRegistry(deps), 'app:info', {}));
    expect(data).toEqual(deps.appInfo());
  });

  it('app:info 非法入参（strict 拒绝多余键）→ E-IPC-INVALID-PARAMS', () => {
    expectFail(invokeIpcEntry(buildIpcRegistry(deps), 'app:info', { injected: true }), IPC_ERRORS.INVALID_PARAMS);
  });

  it('越权通道（workflow:start）→ E-IPC-UNKNOWN-CHANNEL', () => {
    expectFail(
      invokeIpcEntry(buildIpcRegistry(deps), 'workflow:start', { kind: 'selection' }),
      IPC_ERRORS.UNKNOWN_CHANNEL,
    );
  });

  it('伪造通道（fs:readFile）→ E-IPC-UNKNOWN-CHANNEL', () => {
    expectFail(
      invokeIpcEntry(buildIpcRegistry(deps), 'fs:readFile', { path: 'C:/secrets' }),
      IPC_ERRORS.UNKNOWN_CHANNEL,
    );
  });

  it('app:navigate 合法：九视图内视图回显', () => {
    const { data } = expectOk(invokeIpcEntry(buildIpcRegistry(deps), 'app:navigate', { view: 'settings' }));
    expect(data).toEqual({ ok: true, view: 'settings' });
  });

  it('app:navigate 非法视图 → E-IPC-INVALID-PARAMS', () => {
    expectFail(
      invokeIpcEntry(buildIpcRegistry(deps), 'app:navigate', { view: 'evil' }),
      IPC_ERRORS.INVALID_PARAMS,
    );
  });

  it('logs:ping 合法：往返回显', () => {
    const { data } = expectOk(invokeIpcEntry(buildIpcRegistry(deps), 'logs:ping', { message: 'hello' }));
    const pong = data as { pong: string; at: string };
    expect(pong.pong).toContain('hello');
    expect(Number.isNaN(Date.parse(pong.at))).toBe(false);
  });

  it('logs:ping 非法入参（空串/超长/类型错）→ E-IPC-INVALID-PARAMS', () => {
    const registry = buildIpcRegistry(deps);
    for (const payload of [{ message: '' }, { message: 'x'.repeat(201) }, { message: 42 }]) {
      expectFail(invokeIpcEntry(registry, 'logs:ping', payload), IPC_ERRORS.INVALID_PARAMS);
    }
  });

  it('logs:query 注册且走注入依赖（todo 11）', async () => {
    const registry = buildIpcRegistry(deps);
    const entry = registry.get('logs:query');
    expect(entry).toBeDefined();
    const result = await entry!.handle({} as never);
    expect(result).toEqual({ rows: [] });
  });

  it('logs:query 非法入参（category 不在五类）→ E-IPC-INVALID-PARAMS', () => {
    const registry = buildIpcRegistry(deps);
    expectFail(
      invokeIpcEntry(registry, 'logs:query', { category: 'evil' }),
      IPC_ERRORS.INVALID_PARAMS,
    );
  });

  it('tasks:createDemo / tasks:list / tasks:resume / tasks:cancel 注册且走注入依赖（todo 11）', async () => {
    const registry = buildIpcRegistry(deps);
    expect((await registry.get('tasks:createDemo')!.handle({} as never))).toEqual({ taskId: 'stub-task-id' });
    expect((await registry.get('tasks:list')!.handle({} as never))).toEqual({ tasks: [] });
    expect((await registry.get('tasks:resume')!.handle({ taskId: 't1' } as never))).toEqual({ taskId: 't1', status: 'running' });
    expect((await registry.get('tasks:cancel')!.handle({ taskId: 't1' } as never))).toEqual({ taskId: 't1', status: 'cancelled' });
  });

  it('tasks:resume 非法入参（空 taskId）→ E-IPC-INVALID-PARAMS', () => {
    const registry = buildIpcRegistry(deps);
    expectFail(invokeIpcEntry(registry, 'tasks:resume', { taskId: '' }), IPC_ERRORS.INVALID_PARAMS);
  });
});
