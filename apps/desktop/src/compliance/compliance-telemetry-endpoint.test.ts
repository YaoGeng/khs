/**
 * 合规服务遥测装配 e2e（todo 9 = T-M1-07）：env XINGLIAN_TELEMETRY_ENDPOINT seam。
 * mock 本地 http 端点（node:http 真实收包）验证装配链路：
 * endpoint 注入 + consent=true → 真实收到批量契约事件（含失败重试 ≤1）；
 * consent=false → 零网络（M0 零网络断言模式沿用）；env 缺省 → M0 本地留存路径零回退。
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAndMigrate } from '../store/db';
import { handleStoreRequest } from '../store/worker';
import type { StoreClient } from '../store/client';
import type { ConsentInput, ConsentRowView } from '../store/protocol';
import type { SqliteDatabase } from 'better-sqlite3';
import { EULA_LOCKED_VIEWS } from '../shared/channels';
import { EULA_VERSION_DEFAULT } from './eula';
import { ANON_INSTALL_ID_KV_KEY } from './telemetry-reporter';
import { createComplianceService, type ComplianceService } from './compliance-service';

const ENDPOINT_ENV = 'XINGLIAN_TELEMETRY_ENDPOINT';

/** 真实 DB store 桩：consent + kv 直连 worker 内核（上报器安装 id 走真实 kv_config 表） */
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
    kvSet: async (key: string, value: string | Buffer) => req({ type: 'kvSet', key, value }).data as { set: boolean },
    kvGet: async (key: string) => (req({ type: 'kvGet', key }).data as { value: string | Buffer | null }).value,
  } as unknown as StoreClient;
}

interface CaptureServer {
  readonly url: string;
  readonly bodies: string[];
  /** 已收到的 POST 次数（含重试；零网络断言用） */
  received(): number;
  close(): Promise<void>;
}

/** mock 本地 http 遥测端点：127.0.0.1 随机端口，按脚本返回状态码并记录请求体 */
function startCaptureServer(statusScript: (requestIndex: number) => number = () => 202): Promise<CaptureServer> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const server: Server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      req.on('end', () => {
        bodies.push(data);
        res.statusCode = statusScript(bodies.length);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/api/v1/telemetry/events`,
        bodies,
        received: () => bodies.length,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function makeService(database: SqliteDatabase, records: Array<{ code: string }>): ComplianceService {
  return createComplianceService({
    store: makeStoreStub(database),
    eulaVersion: EULA_VERSION_DEFAULT,
    lockedViews: EULA_LOCKED_VIEWS,
    onLocalRecord: (record) => records.push(record),
  });
}

interface WireBatch {
  readonly consent: boolean;
  readonly event: string;
  readonly anon_user_hash: string;
  readonly payload: unknown;
  readonly at: string;
}

describe('遥测装配：env 注入端点（真实本地 http）', () => {
  let dir: string;
  let db: SqliteDatabase;
  let records: Array<{ code: string }>;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'xinglian-telemetry-ep-'));
    db = openAndMigrate(path.join(dir, 'c.db')).db;
    records = [];
    savedEnv = process.env[ENDPOINT_ENV];
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENDPOINT_ENV];
    else process.env[ENDPOINT_ENV] = savedEnv;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('consent=true + 端点注入：4 类事件经批量契约送达端点（consent:true + 64hex 假名 + 安装 id 落 kv）', async () => {
    const server = await startCaptureServer();
    process.env[ENDPOINT_ENV] = server.url;
    const service = makeService(db, records);
    await service.whenSnapshotLoaded;
    await service.ipc.acceptEula({ telemetryConsent: true });

    const kinds = ['circuit_open', 'circuit_half_open', 'circuit_closed', 'selfcheck_fail'] as const;
    for (const kind of kinds) {
      const outcome = await service.sendTelemetry({ name: kind, payload: kind === 'selfcheck_fail' ? { platform: 'xhs', version: '1.0.0', failedCases: 1 } : { reason: 'captcha-hit' } });
      expect(outcome.ok).toBe(true);
      expect(outcome.disposition).toBe('sent');
    }
    // 等 http 回包收尾（fetch 已 await，此处仅幂等留缓冲）
    expect(server.received()).toBe(4);

    const kindsReceived: string[] = [];
    for (const body of server.bodies) {
      const batch = JSON.parse(body) as WireBatch[];
      expect(batch).toHaveLength(1);
      expect(batch[0]!.consent).toBe(true);
      expect(batch[0]!.anon_user_hash).toMatch(/^[0-9a-f]{64}$/);
      kindsReceived.push(batch[0]!.event);
    }
    expect(new Set(kindsReceived)).toEqual(new Set(kinds));
    // 安装 id 已持久化（kv_config 真实落库）
    expect(db.prepare('SELECT value_blob FROM kv_config WHERE key = ?').get(ANON_INSTALL_ID_KV_KEY)).toBeTruthy();
    await server.close();
  });

  it('5xx 瞬时失败 → 静默重试恰 1 次（服务端共收 2 次，事件仍算 sent）', async () => {
    const server = await startCaptureServer((index) => (index === 1 ? 500 : 202));
    process.env[ENDPOINT_ENV] = server.url;
    const service = makeService(db, records);
    await service.whenSnapshotLoaded;
    await service.ipc.acceptEula({ telemetryConsent: true });

    const outcome = await service.sendTelemetry({ name: 'circuit_open', payload: { reason: 'http-429-401-burst' } });
    expect(outcome.disposition).toBe('sent');
    expect(server.received()).toBe(2);
    await server.close();
  });

  it('consent=false → blocked 且零网络（端点已注入仍不发起任何请求）', async () => {
    const server = await startCaptureServer();
    process.env[ENDPOINT_ENV] = server.url;
    const service = makeService(db, records);
    await service.whenSnapshotLoaded;
    await service.ipc.setTelemetry({ enabled: false });

    const outcome = await service.sendTelemetry({ name: 'first_collection_completed', payload: { collectedCount: 3 } });
    expect(outcome.ok).toBe(false);
    expect(outcome.disposition).toBe('blocked');
    expect(outcome.code).toBe('E-TELEMETRY-CONSENT-OFF');
    expect(server.received()).toBe(0);
    await server.close();
  });

  it('env 缺省（未注入端点）→ M0 形态零回退：同意态事件仅本地留存', async () => {
    delete process.env[ENDPOINT_ENV];
    const service = makeService(db, records);
    await service.whenSnapshotLoaded;
    await service.ipc.acceptEula({ telemetryConsent: true });

    const outcome = await service.sendTelemetry({ name: 'first_report_generated', payload: { topicId: 't1' } });
    expect(outcome.ok).toBe(true);
    expect(outcome.disposition).toBe('local-only');
    expect(outcome.code).toBe('TELEMETRY-LOCAL-ONLY');
    expect(records.some((r) => r.code === 'TELEMETRY-LOCAL-ONLY')).toBe(true);
  });

  it('重启语义：同库重建服务 → 安装 id 复用（anon_user_hash 稳定）', async () => {
    const server = await startCaptureServer();
    process.env[ENDPOINT_ENV] = server.url;
    const first = makeService(db, records);
    await first.whenSnapshotLoaded;
    await first.ipc.acceptEula({ telemetryConsent: true });
    await first.sendTelemetry({ name: 'circuit_open' });

    const second = makeService(db, records);
    await second.whenSnapshotLoaded;
    await second.sendTelemetry({ name: 'circuit_closed' });

    const [firstBatch, secondBatch] = server.bodies.map((body) => (JSON.parse(body) as WireBatch[])[0]!);
    expect(firstBatch!.anon_user_hash).toBe(secondBatch!.anon_user_hash);
    await server.close();
  });
});
