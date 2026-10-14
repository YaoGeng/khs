/**
 * BYOK Key 服务单测（m1 todo 10 = T-M1-08①验收①）：
 * - keys set→masked 读回 + DB 文件字节级断言不含明文 Key；
 * - safeStorage 不可用 → 明文降级前审计条目（顺序断言）+ 告警文案；
 * - kv Buffer（safeStorage 密文形态）经真实 store transport（真实 worker 内核 + 真实 sqlite）往返；
 * - keys:test 网络链路（fetch 注入：happy/401/网络错误/未配置阻止）；
 * - scanTest → keyword_hits 落库含 wordlist_version（与词库服务联装）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStoreClient, type StoreClient } from '../store/client';
import { handleStoreRequest } from '../store/worker';
import { openAndMigrate } from '../store/db';
import type { StoreRequest } from '../store/protocol';
import type { SqliteDatabase } from 'better-sqlite3';
import { createKeyService, maskKey, KV_WORDLIST_ACTIVE, type KeyService, type SafeStoragePort } from './key-service';
import { createWordlistService } from '../compliance/wordlist-service';
import { SCAN_FIXTURE_TEXT } from '../compliance/wordlist-fixture';

let dir: string;
let dbFile: string;
let db: SqliteDatabase | null = null;
let clients: StoreClient[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-key-service-'));
  dbFile = path.join(dir, 'kv.db');
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 真实内核 transport：业务请求走 handleStoreRequest + 真实 better-sqlite3（client.test.ts 同款） */
function makeRealStoreClient(): StoreClient {
  let messageHandler: ((m: unknown) => void) | null = null;
  const respond = (message: unknown): void => {
    messageHandler?.(message);
  };
  const processMessage = (message: unknown): void => {
    const envelope = message as { type?: string; dbFile?: string };
    if (envelope.type === '__init') {
      db?.close();
      const opened = openAndMigrate(envelope.dbFile as string);
      db = opened.db;
      respond({ type: '__ready', dbFile: envelope.dbFile, schemaVersion: opened.migration?.toVersion ?? 0 });
      return;
    }
    if (envelope.type === '__close') return;
    try {
      const { data, writeMs } = handleStoreRequest(db as SqliteDatabase, message as StoreRequest);
      respond({ id: (message as StoreRequest).id, ok: true, data, writeMs });
    } catch (error) {
      respond({ id: (message as StoreRequest).id, ok: false, code: 'E-STORE-DB', err: String((error as Error).message) });
    }
  };
  const client = createStoreClient({
    dbFile,
    createTransport: () => ({
      send: (message) => {
        setTimeout(() => processMessage(message), 0);
      },
      onMessage: (h) => {
        messageHandler = h;
      },
      onExit: () => {},
      kill: () => {},
    }),
  });
  clients.push(client);
  return client;
}

function xorBuffer(input: Buffer): Buffer {
  const copy = Buffer.from(input);
  for (let i = 0; i < copy.length; i += 1) copy[i] ^= 0x5a;
  return copy;
}

const safeStorageOk: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => xorBuffer(Buffer.from(plain, 'utf8')),
  decryptString: (encrypted) => xorBuffer(Buffer.from(encrypted)).toString('utf8'),
};

const safeStorageUnavailable: SafeStoragePort = {
  isEncryptionAvailable: () => false,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fetchStub(status: number, body: unknown = { choices: [{ message: { content: 'pong' } }] }) {
  const calls: FetchCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const FULL_KEY = 'sk-test-1234567890abcdef';

function makeKeyService(store: StoreClient, options: { safeStorage?: SafeStoragePort; fetch?: typeof fetch } = {}): KeyService {
  const wordlist = createWordlistService({
    root: path.join(dir, 'config', 'wordlist'),
    kvGet: (key) => store.kvGet(key),
    kvSet: (key, value) => store.kvSet(key, value),
    watchEnabled: false,
  });
  return createKeyService({
    store,
    safeStorage: options.safeStorage ?? safeStorageOk,
    fetchFn: options.fetch ?? fetchStub(200).fn,
    wordlist,
  });
}

describe('maskKey（masked 读回格式）', () => {
  it('sk- 前缀保留 + 后 4 位；非 sk 前缀只出后 4 位', () => {
    expect(maskKey('sk-abcdef1234')).toBe('sk-****1234');
    expect(maskKey('abcdefgh')).toBe('****efgh');
  });
});

describe('验收①：set→masked 读回 + DB 字节级断言不含明文 Key', () => {
  it('safeStorage 可用：密文 Buffer 落库，masked=sk-****+后4位，DB 字节无全值', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const service = makeKeyService(store);
    const setResult = await service.setKey({ provider: 'zhipu', key: FULL_KEY });
    expect(setResult).toEqual({ provider: 'zhipu', masked: 'sk-****cdef', backupMasked: [], encryption: 'safeStorage' });

    const masked = await service.getMasked();
    const entry = masked.keys.find((k) => k.provider === 'zhipu');
    expect(entry?.masked).toBe('sk-****cdef');
    expect(entry?.encryption).toBe('safeStorage');
    expect(JSON.stringify(masked)).not.toContain(FULL_KEY);

    // kv 原始值 = XOR 密文 Buffer（todo-6 KvValue Buffer 形态）
    const raw = await store.kvGet('byok:key:zhipu');
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(safeStorageOk.decryptString(raw as Buffer)).toBe(FULL_KEY);

    // DB 文件字节级断言：全值（含密文前后任何形态）不出现在库文件字节中
    const bytes = readFileSync(dbFile);
    expect(bytes.indexOf(Buffer.from(FULL_KEY, 'utf8'))).toBe(-1);
    expect(bytes.includes('sk-test-1234567890abcdef')).toBe(false);

    // 出口断言输入：明文形态全值列表此时为空（密文形态不适用 JSON 泄漏面）
    expect(await service.exitAuditRawValues()).toEqual([]);
  });

  it('FR-2.4 备用 Key：逐把加密落库、masked 回显、exitAudit 深扫描含备用、reader 解密列表', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const service = makeKeyService(store);
    const PRIMARY = 'sk-primary-aaaa1234';
    const BACKUP_A = 'sk-backup-bbbb5678';
    const BACKUP_B = 'sk-backup-cccc9012';
    const result = await service.setKey({ provider: 'custom', key: PRIMARY, backupKeys: [BACKUP_A, BACKUP_B], baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
    expect(result.backupMasked).toEqual([maskKey(BACKUP_A), maskKey(BACKUP_B)]);

    const entry = (await service.getMasked()).keys.find((k) => k.provider === 'custom');
    expect(entry?.backupMasked).toHaveLength(2);
    expect(JSON.stringify(await service.getMasked())).not.toContain(BACKUP_A);

    // 出口断言输入（masked 出口深扫描）：主 Key 为 safeStorage 密文不入列（既有语义，
    // 密文形态不适用 JSON 泄漏面）；备用 Key 的解密形态入列——防御其明文形态漏进出口
    const audit = await service.exitAuditRawValues();
    expect(audit).not.toContain(PRIMARY);
    expect(audit).toContain(BACKUP_A);
    expect(audit).toContain(BACKUP_B);

    // DB 字节无备用 Key 明文（逐把 safeStorage 加密）
    const bytes = readFileSync(dbFile);
    expect(bytes.indexOf(Buffer.from(BACKUP_A, 'utf8'))).toBe(-1);

    // 网关 reader：主 Key 在前 + 备用按序解密
    const { createGatewayKeyReader } = await import('./key-service');
    const reader = createGatewayKeyReader(store, safeStorageOk);
    const gatewayEntry = await reader('custom');
    expect(gatewayEntry?.apiKey).toBe(PRIMARY);
    expect(gatewayEntry?.backupKeys).toEqual([BACKUP_A, BACKUP_B]);
  });

  it('safeStorage 不可用：明文落库**前**先写审计条目（顺序断言）+ 告警文案随结果返回', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const callOrder: string[] = [];
    const service = makeKeyService(store, { safeStorage: safeStorageUnavailable });
    // 以代理记录调用顺序（审计条目必须先于明文 kvSet）
    const proxied = createKeyService({
      store: {
        kvGet: (key) => store.kvGet(key),
        kvSet: async (key, value) => {
          callOrder.push(`kvSet:${key}`);
          return store.kvSet(key, value);
        },
        kvDel: (key) => store.kvDel(key),
        insertLogs: async (rows) => {
          callOrder.push(`insertLogs:${rows.map((r) => r.msg).join(',')}`);
          return store.insertLogs(rows);
        },
        insertKeywordHit: (hit) => store.insertKeywordHit(hit),
      },
      safeStorage: safeStorageUnavailable,
      fetchFn: fetchStub(200).fn,
      wordlist: createWordlistService({
        root: path.join(dir, 'config', 'wordlist'),
        kvGet: (key) => store.kvGet(key),
        kvSet: (key, value) => store.kvSet(key, value),
        watchEnabled: false,
      }),
    });
    const result = await proxied.setKey({ provider: 'custom', key: FULL_KEY, baseUrl: 'https://gw.example.com/v1' });
    expect(result.encryption).toBe('plaintext-fallback');
    expect(result.warning).toContain('safeStorage 不可用');
    expect(result.warning).toContain('审计');
    expect(callOrder.indexOf('insertLogs:keys:key-stored-plaintext-fallback')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('insertLogs:keys:key-stored-plaintext-fallback')).toBeLessThan(callOrder.indexOf('kvSet:byok:key:custom'));

    // 审计条目真实落 logs 表（category=user-action，payload 带 provider 与 safeStorageAvailable=false）
    const rows = await store.queryLogs({ category: 'user-action', limit: 100 });
    const audit = rows.find((r) => r.msg === 'keys:key-stored-plaintext-fallback');
    expect(audit).toBeDefined();
    expect((audit?.payload as { provider?: string; safeStorageAvailable?: boolean })?.provider).toBe('custom');
    expect((audit?.payload as { safeStorageAvailable?: boolean })?.safeStorageAvailable).toBe(false);

    // masked 读回仍不含全值；exitAuditRawValues 此时含全值（供 ipc-core 出口断言深扫描）
    const masked = await service.getMasked();
    expect(JSON.stringify(masked)).not.toContain(FULL_KEY);
    expect(await service.exitAuditRawValues()).toContain(FULL_KEY);
  });

  it('kv Buffer 密文经真实 store transport 往返：get→decrypt 与原值一致', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const service = makeKeyService(store);
    await service.setKey({ provider: 'openai', key: 'sk-roundtrip-9876543210' });
    // 显式 kv 往返（主进程 client ↔ 真实 worker 内核 ↔ sqlite value_blob）
    const raw = await store.kvGet('byok:key:openai');
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(safeStorageOk.decryptString(raw as Buffer)).toBe('sk-roundtrip-9876543210');
  });
});

describe('keys:test（fetch 注入）', () => {
  it('未配置 Key → 稳定错误码 + 指向配置入口（不报裸错误）', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const service = makeKeyService(store);
    await expect(service.test({ provider: 'deepseek' })).rejects.toThrow('E-KEY-NOT-CONFIGURED');
    await expect(service.test({ provider: 'deepseek' })).rejects.toThrow('保存');
  });

  it('happy：POST {baseUrl}/chat/completions、Bearer 全值、max_tokens≥8192（todo-8 注记）', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const { fn, calls } = fetchStub(200);
    const service = makeKeyService(store, { fetch: fn });
    await service.setKey({ provider: 'zhipu', key: FULL_KEY });
    const result = await service.test({ provider: 'zhipu' });
    expect(result).toMatchObject({ ok: true, provider: 'zhipu', model: 'glm-4.7-flash', httpStatus: 200, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${FULL_KEY}`);
    expect(JSON.parse(String(calls[0]?.init.body)).max_tokens).toBeGreaterThanOrEqual(8192);
    expect(JSON.stringify(result)).not.toContain(FULL_KEY);
  });

  it('custom 网关缺 base_url → E-KEY-BASE-URL-REQUIRED 指向配置', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const { fn } = fetchStub(200);
    const service = makeKeyService(store, { fetch: fn });
    await service.setKey({ provider: 'custom', key: FULL_KEY });
    await expect(service.test({ provider: 'custom' })).rejects.toThrow('E-KEY-BASE-URL-REQUIRED');
  });

  it('401 → ok:false + httpStatus 401（不外泄请求头/Key）', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const { fn, calls } = fetchStub(401, { error: 'bad key' });
    const service = makeKeyService(store, { fetch: fn });
    await service.setKey({ provider: 'deepseek', key: FULL_KEY });
    const result = await service.test({ provider: 'deepseek' });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(401);
    expect(result.error).toBe('HTTP 401');
    expect(JSON.stringify(result)).not.toContain(FULL_KEY);
    expect(JSON.stringify(calls[0]?.init.headers)).not.toContain('x-opencode-session');
  });

  it('网络异常 → ok:false + httpStatus null + 稳定摘要', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const fn = (async () => {
      throw new Error('UND_ERR_CONNECT_TIMEOUT');
    }) as typeof fetch;
    const service = makeKeyService(store, { fetch: fn });
    await service.setKey({ provider: 'openai', key: FULL_KEY });
    const result = await service.test({ provider: 'openai' });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBeNull();
    expect(result.error).toContain('UND_ERR_CONNECT_TIMEOUT');
  });
});

describe('precall confirm（FR-2.7③：每 provider 每会话一次；reset 可重置）', () => {
  it('check→confirm→check 幂等；另一 provider 互不影响；reset 恢复提示', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const service = makeKeyService(store);
    expect(await service.precallConfirm({ provider: 'zhipu', action: 'check' })).toEqual({ needConfirm: true });
    expect(await service.precallConfirm({ provider: 'zhipu', action: 'confirm' })).toEqual({ needConfirm: false });
    expect(await service.precallConfirm({ provider: 'zhipu', action: 'check' })).toEqual({ needConfirm: false });
    expect(await service.precallConfirm({ provider: 'openai', action: 'check' })).toEqual({ needConfirm: true });
    expect(await service.precallConfirm({ provider: 'zhipu', action: 'reset' })).toEqual({ needConfirm: true });
    expect(await service.precallConfirm({ provider: 'zhipu', action: 'check' })).toEqual({ needConfirm: true });
  });
});

describe('scanTest（验收②持久化半：keyword_hits 行数=N 且 wordlist_version 随行）', () => {
  it('fixture 6 命中 → 落库 6 行、版本号一致、listKeywordHits 可查', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const service = makeKeyService(store);
    const result = await service.scanTest({ text: SCAN_FIXTURE_TEXT, topicId: 'topic-scan-e2e' });
    expect(result.wordlistVersion).toBe('1.0.0');
    expect(result.hits).toHaveLength(6);
    expect(result.persisted).toBe(6);
    const rows = await store.listKeywordHits({ topicId: 'topic-scan-e2e' });
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.wordlistVersion === '1.0.0')).toBe(true);
    expect(rows.map((r) => r.term).sort()).toEqual(['100%有效', '加V', '医美', '最好', '薇信', '全网第一'].sort());
    // 词库 active 指针已固化进 kv（todo-6 kv 面）
    expect(await store.kvGet(KV_WORDLIST_ACTIVE)).toBe('1.0.0');
  });

  it('词库未就绪（root 指向空）→ E-WORDLIST-NOT-READY', async () => {
    const store = makeRealStoreClient();
    await store.whenReady();
    const wordlist = createWordlistService({
      root: path.join(dir, 'config', 'wordlist'),
      kvGet: (key) => store.kvGet(key),
      kvSet: (key, value) => store.kvSet(key, value),
      watchEnabled: false,
      seed: {
        kind: 'wordlist',
        version: '1.0.0',
        effectiveAt: 'x',
        extremeTerms: [],
        redirectPatterns: [],
        categoryBlacklist: [],
      },
    });
    // seed 非法（空数组不过 min(1)）→ whenReady 后 active 仍 null
    await wordlist.whenReady;
    const service = createKeyService({
      store,
      safeStorage: safeStorageOk,
      fetchFn: fetchStub(200).fn,
      wordlist,
    });
    await expect(service.scanTest({ text: '最好' })).rejects.toThrow('E-WORDLIST-NOT-READY');
  });
});
