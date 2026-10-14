/**
 * keys:* 通道注册表单测（m1 todo 10 = T-M1-08①）：注册表契约 + zod 入参校验 + masked 出口断言
 * （越权依赖返回全值 → E-KEY-MASKED-VIOLATION；未装配 → E-IPC-DEP-MISSING；custom 缺 base_url 入参拒绝）。
 */
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../shared/channels';
import { buildIpcRegistry, invokeIpcEntry, type AppInfoDeps, type IpcInvokeResult, type KeysIpcDeps } from './ipc-core';

const logTaskStub = {
  queryLogs: async () => ({ rows: [] }),
  createDemoTask: async () => ({ taskId: 'stub' }),
  listTasks: async () => ({ tasks: [] }),
  resumeTask: async (taskId: string) => ({ taskId, status: 'running' }),
  cancelTask: async (taskId: string) => ({ taskId, status: 'cancelled' }),
};

const acceptedState = {
  eulaVersion: '0.1.0-draft',
  eulaStatus: 'accepted' as const,
  requiresConfirm: false,
  confirmedVersion: '0.1.0-draft',
  confirmedAt: '2026-10-11T00:00:00.000Z',
  rejectedAt: null,
  telemetryConsent: 'unasked' as const,
};

const consentStub = {
  state: async () => acceptedState,
  acceptEula: async () => acceptedState,
  rejectEula: async () => acceptedState,
  setTelemetry: async () => acceptedState,
  isViewAllowed: () => true,
};

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

const keysStub: KeysIpcDeps = {
  setKey: async () => ({ provider: 'zhipu', masked: 'sk-****abcd', backupMasked: [], encryption: 'safeStorage' }),
  getMasked: async () => ({
    keys: [
      {
        provider: 'zhipu',
        masked: 'sk-****abcd',
        backupMasked: [],
        encryption: 'safeStorage',
        baseUrl: null,
        model: null,
        setAt: '2026-10-14T00:00:00.000Z',
      },
    ],
  }),
  exitAuditRawValues: async () => [],
  test: async () => ({ ok: true, provider: 'zhipu', model: 'glm-4.7-flash', latencyMs: 100, httpStatus: 200, error: null }),
  precallConfirm: async () => ({ needConfirm: true }),
  scanTest: async () => ({ wordlistVersion: '1.0.0', hits: [], persisted: 0 }),
};

function makeDeps(keys?: KeysIpcDeps): AppInfoDeps {
  return {
    appInfo: () => ({ appVersion: '0.1.0', electronVersion: '33', platform: 'win32', contractVersion: 'm0-ipc-1' }),
    license: {
      activate: () => ({ state: 'locked' as const, reason: 'NO_LICENSE' }),
      status: () => ({ state: 'locked' as const, reason: 'NO_LICENSE' }),
    },
    browser: browserStub,
    logTask: logTaskStub,
    consent: consentStub,
    ...(keys ? { keys } : {}),
  };
}

function expectOk(result: IpcInvokeResult): { data: unknown } {
  expect(result.ok, `应为成功，实际 ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return { data: result.data };
}

describe('keys:* 通道注册（T4 注册表模式延续）', () => {
  it('注册表键集与 IPC_CHANNELS 完全一致（含 keys 五通道）', () => {
    const registry = buildIpcRegistry(makeDeps(keysStub));
    expect([...registry.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
    for (const channel of ['keys:set', 'keys:get-masked', 'keys:test', 'keys:precall-confirm', 'keys:scan-test']) {
      expect(registry.has(channel as (typeof IPC_CHANNELS)[number])).toBe(true);
    }
  });

  it('keys:set happy：出口过 zod（masked 形态）', async () => {
    const registry = buildIpcRegistry(makeDeps(keysStub));
    const { data } = expectOk(invokeIpcEntry(registry, 'keys:set', { provider: 'zhipu', key: 'sk-abcdef123456' }));
    await expect(data).resolves.toEqual({
      provider: 'zhipu',
      masked: 'sk-****abcd',
      backupMasked: [],
      encryption: 'safeStorage',
    });
  });

  it('keys:set 入参拒绝：Key 过短 / custom 缺 baseUrl → E-IPC-INVALID-PARAMS', () => {
    const registry = buildIpcRegistry(makeDeps(keysStub));
    const shortKey = invokeIpcEntry(registry, 'keys:set', { provider: 'zhipu', key: 'sk' });
    expect(shortKey.ok).toBe(false);
    if (!shortKey.ok) expect(shortKey.code).toBe('E-IPC-INVALID-PARAMS');
    const noBaseUrl = invokeIpcEntry(registry, 'keys:set', { provider: 'custom', key: 'sk-abcdef123456' });
    expect(noBaseUrl.ok).toBe(false);
    if (!noBaseUrl.ok) expect(noBaseUrl.code).toBe('E-IPC-INVALID-PARAMS');
  });

  it('masked 出口断言：依赖异常把全值放进出口 → 抛 E-KEY-MASKED-VIOLATION（响应永不携全值）', async () => {
    const FULL = 'sk-rogue-full-key-value';
    const rogue: KeysIpcDeps = {
      ...keysStub,
      // 模拟「出口结构合法但值泄漏」的契约破坏：masked 字段被错误写成全值
      getMasked: async () => ({
        keys: [{ provider: 'zhipu', masked: FULL, backupMasked: [], encryption: 'safeStorage', baseUrl: null, model: null, setAt: null }],
      }),
      exitAuditRawValues: async () => [FULL],
    };
    const registry = buildIpcRegistry(makeDeps(rogue));
    const { data } = expectOk(invokeIpcEntry(registry, 'keys:get-masked', {}));
    await expect(data).rejects.toThrow('E-KEY-MASKED-VIOLATION');
  });

  it('keys 链路未装配 → E-IPC-DEP-MISSING（不静默）', async () => {
    const registry = buildIpcRegistry(makeDeps());
    const { data } = expectOk(invokeIpcEntry(registry, 'keys:set', { provider: 'zhipu', key: 'sk-abcdef123456' }));
    await expect(data).rejects.toThrow('E-IPC-DEP-MISSING');
  });

  it('keys:precall-confirm / keys:scan-test 出口契约往返', async () => {
    const registry = buildIpcRegistry(makeDeps(keysStub));
    const confirm = expectOk(invokeIpcEntry(registry, 'keys:precall-confirm', { provider: 'zhipu', action: 'check' }));
    await expect(confirm.data).resolves.toEqual({ needConfirm: true });
    const scan = expectOk(invokeIpcEntry(registry, 'keys:scan-test', { text: '最好' }));
    await expect(scan.data).resolves.toEqual({
      wordlistVersion: '1.0.0',
      hits: [],
      persisted: 0,
    });
  });
});
