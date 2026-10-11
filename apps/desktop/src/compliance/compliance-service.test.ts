/**
 * 合规服务单测（todo 9 / FR-1.9+FR-12.6）：真实 better-sqlite3（electron-as-node ABI 130）
 * + worker 内核直连的 store 桩——验证服务语义与**真实落库**：
 * 首启门态 / 接受留痕（版本号+时间戳）/ 拒绝锁 / 版本升级重确认 / 遥测开关持久化 / 守卫接线。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAndMigrate } from '../store/db';
import { handleStoreRequest } from '../store/worker';
import type { StoreClient } from '../store/client';
import type { ConsentInput, ConsentRowView } from '../store/protocol';
import type { SqliteDatabase } from 'better-sqlite3';
import { EULA_LOCKED_VIEWS } from '../shared/channels';
import { EULA_VERSION_DEFAULT } from './eula';
import type { TelemetryLocalRecord } from './telemetry-guard';
import { createComplianceService, type ComplianceService } from './compliance-service';

let dir: string;
let db: SqliteDatabase;
let records: TelemetryLocalRecord[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-compliance-'));
  db = openAndMigrate(path.join(dir, 'c.db')).db;
  records = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** store 桩：consent 请求直连 worker 内核 + 真实 DB（其余方法不需要） */
function makeStoreStub(database: SqliteDatabase): StoreClient {
  let nextId = 100;
  const req = (request: { type: string } & Record<string, unknown>): { data: unknown } => {
    const { data } = handleStoreRequest(database, { id: (nextId += 1), ...request } as never);
    return { data };
  };
  return {
    whenReady: async () => 2,
    putConsent: async (consent: ConsentInput) => req({ type: 'putConsent', consent }).data as { written: boolean; id: number },
    getLatestConsents: async () =>
      req({ type: 'getLatestConsents' }).data as { eula: ConsentRowView | null; telemetry: ConsentRowView | null },
  } as unknown as StoreClient;
}

function makeService(eulaVersion = EULA_VERSION_DEFAULT, database: SqliteDatabase = db): ComplianceService {
  return createComplianceService({
    store: makeStoreStub(database),
    eulaVersion,
    lockedViews: EULA_LOCKED_VIEWS,
    onLocalRecord: (r) => records.push(r),
  });
}

async function waitForSnapshot(service: ComplianceService): Promise<void> {
  await service.whenSnapshotLoaded;
}

describe('首启门态（无确认记录）', () => {
  it('unconfirmed + 工作流视图全锁 + logs/settings/report 可达 + 遥测 unasked', async () => {
    const service = makeService();
    await waitForSnapshot(service);
    const state = await service.ipc.state();
    expect(state.eulaStatus).toBe('unconfirmed');
    expect(state.requiresConfirm).toBe(true);
    expect(state.confirmedVersion).toBeNull();
    expect(state.confirmedAt).toBeNull();
    expect(state.telemetryConsent).toBe('unasked');
    for (const view of EULA_LOCKED_VIEWS) expect(service.ipc.isViewAllowed(view)).toBe(false);
    for (const view of ['logs', 'settings', 'report']) expect(service.ipc.isViewAllowed(view)).toBe(true);
  });
});

describe('接受 → 留痕 → 解锁', () => {
  it('acceptEula 落库（版本号+时间戳+遥测选择）并解锁工作流视图', async () => {
    const service = makeService();
    await waitForSnapshot(service);
    const after = await service.ipc.acceptEula({ telemetryConsent: true });
    expect(after.eulaStatus).toBe('accepted');
    expect(after.requiresConfirm).toBe(false);
    expect(after.confirmedVersion).toBe(EULA_VERSION_DEFAULT);
    expect(Number.isNaN(Date.parse(after.confirmedAt ?? ''))).toBe(false);
    expect(after.telemetryConsent).toBe('granted');
    for (const view of EULA_LOCKED_VIEWS) expect(service.ipc.isViewAllowed(view)).toBe(true);

    // 留痕可见（本地记录出口）
    expect(records.some((r) => r.code === 'EULA-ACCEPTED')).toBe(true);
  });

  it('重启语义：同库重建服务 → accepted 保持（SQLite 持久化，非内存态）', async () => {
    const first = makeService();
    await waitForSnapshot(first);
    const written = await first.ipc.acceptEula({ telemetryConsent: false });
    const confirmedAt = written.confirmedAt;

    const second = makeService(EULA_VERSION_DEFAULT, db);
    const state = await second.ipc.state();
    expect(state.eulaStatus).toBe('accepted');
    expect(state.confirmedVersion).toBe(EULA_VERSION_DEFAULT);
    expect(state.confirmedAt).toBe(confirmedAt);
    expect(state.telemetryConsent).toBe('denied');
    expect(second.ipc.isViewAllowed('publish')).toBe(true);
  });
});

describe('拒绝 → 锁定保持', () => {
  it('rejectEula → rejected + 工作流视图持续锁定 + 留痕', async () => {
    const service = makeService();
    await waitForSnapshot(service);
    const after = await service.ipc.rejectEula();
    expect(after.eulaStatus).toBe('rejected');
    expect(after.requiresConfirm).toBe(true);
    expect(after.rejectedAt).toBeTruthy();
    for (const view of EULA_LOCKED_VIEWS) expect(service.ipc.isViewAllowed(view)).toBe(false);
    for (const view of ['logs', 'settings']) expect(service.ipc.isViewAllowed(view)).toBe(true);
    expect(records.some((r) => r.code === 'EULA-REJECTED')).toBe(true);

    // 拒绝后重启：锁定保持
    const second = makeService(EULA_VERSION_DEFAULT, db);
    const state = await second.ipc.state();
    expect(state.eulaStatus).toBe('rejected');
    expect(second.ipc.isViewAllowed('dashboard')).toBe(false);
  });

  it('拒绝不写遥测选择（telemetryConsent 保持 unasked——拒绝 EULA ≠ 拒绝遥测）', async () => {
    const service = makeService();
    await waitForSnapshot(service);
    const after = await service.ipc.rejectEula();
    expect(after.telemetryConsent).toBe('unasked');
  });
});

describe('版本升级重确认（FR-1.9）', () => {
  it('旧版已确认 + 应用侧版本升级 → version-changed + 仍锁 + 旧记录保留；重接受后解锁', async () => {
    const old = makeService('0.1.0-draft');
    await waitForSnapshot(old);
    const acceptedAt = (await old.ipc.acceptEula({ telemetryConsent: true })).confirmedAt;

    const upgraded = makeService('0.2.0-draft');
    const state = await upgraded.ipc.state();
    expect(state.eulaStatus).toBe('version-changed');
    expect(state.requiresConfirm).toBe(true);
    expect(state.confirmedVersion).toBe('0.1.0-draft');
    expect(state.confirmedAt).toBe(acceptedAt);
    expect(upgraded.ipc.isViewAllowed('dashboard')).toBe(false);

    const reaccepted = await upgraded.ipc.acceptEula({ telemetryConsent: false });
    expect(reaccepted.eulaStatus).toBe('accepted');
    expect(reaccepted.confirmedVersion).toBe('0.2.0-draft');
    expect(upgraded.ipc.isViewAllowed('dashboard')).toBe(true);
  });
});

describe('遥测开关（FR-12.6：设置可随时开关）+ 守卫接线', () => {
  it('setTelemetry 落库并即时反映到守卫快照：granted → local-only；denied → blocked 零网络', async () => {
    const service = makeService();
    await waitForSnapshot(service);

    const enabled = await service.ipc.setTelemetry({ enabled: true });
    expect(enabled.telemetryConsent).toBe('granted');

    const granted = await service.sendTelemetry({ name: 'funnel.test', payload: { step: 1 } });
    expect(granted.ok).toBe(true);
    expect(granted.disposition).toBe('local-only');

    const disabled = await service.ipc.setTelemetry({ enabled: false });
    expect(disabled.telemetryConsent).toBe('denied');

    const blocked = await service.sendTelemetry({ name: 'funnel.test' });
    expect(blocked.ok).toBe(false);
    expect(blocked.disposition).toBe('blocked');
    expect(blocked.code).toBe('E-TELEMETRY-CONSENT-OFF');
    expect(records.some((r) => r.code === 'E-TELEMETRY-CONSENT-OFF' && r.msg.includes('被拦截的遥测尝试'))).toBe(true);
  });

  it('重确认弹窗勾选更新遥测选择（acceptEula 携带 telemetryConsent）', async () => {
    const service = makeService();
    await waitForSnapshot(service);
    const after = await service.ipc.acceptEula({ telemetryConsent: false });
    expect(after.telemetryConsent).toBe('denied');
    expect(service.telemetryConsent()).toBe(false);
  });
});
