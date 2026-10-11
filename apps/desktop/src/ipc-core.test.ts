/**
 * IPC 注册表/调用核心单测（electron-free）：
 * - 注册表键集 === IPC_CHANNELS 白名单（防漏注册/私加通道）；
 * - invokeIpcEntry：合法入参直通、非法入参 E-IPC-INVALID-PARAMS、越权通道 E-IPC-UNKNOWN-CHANNEL。
 */
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, IPC_ERRORS } from './shared/channels';
import { buildIpcRegistry, invokeIpcEntry, type AppInfoDeps, type IpcInvokeResult } from './main/ipc-core';

const deps: AppInfoDeps = {
  appInfo: () => ({
    appVersion: '0.1.0',
    electronVersion: '33.4.11',
    platform: 'win32',
    contractVersion: 'm0-ipc-1',
  }),
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
});
