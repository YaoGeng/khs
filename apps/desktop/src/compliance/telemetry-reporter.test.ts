/**
 * 遥测上报器单测（todo 9 = T-M1-07）：guard fetchFn 适配层的批量契约翻译、
 * 安装 id 假名稳定性（kv 持久化 / 故障降级）、失败静默重试 ≤1、绝不上抛。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANON_INSTALL_ID_KV_KEY,
  createAnonUserHash,
  createTelemetryUploader,
  type AnonIdKvStore,
} from './telemetry-reporter';

/** kv 桩：内存 map（可注入故障模式） */
function makeKv(options: { broken?: boolean } = {}): AnonIdKvStore & { map: Map<string, string>; sets: string[] } {
  const map = new Map<string, string>();
  const sets: string[] = [];
  return {
    map,
    sets,
    async kvGet(key: string) {
      if (options.broken) throw new Error('kv unavailable');
      return map.get(key) ?? null;
    },
    async kvSet(key: string, value: string | Buffer) {
      if (options.broken) throw new Error('kv unavailable');
      map.set(key, typeof value === 'string' ? value : value.toString('utf8'));
      sets.push(key);
      return { set: true };
    },
  };
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** fetch 桩：按脚本返回（throw / status），记录调用 */
function makeFetch(script: Array<'throw' | number>): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const action = script[Math.min(calls.length - 1, script.length - 1)];
    if (action === 'throw') throw new Error('ECONNREFUSED');
    return new Response(null, { status: action });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function guardInit(event: { name: string; payload?: unknown; at?: string }): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: event.name, payload: event.payload ?? null, at: event.at ?? '2026-10-01T00:00:00.000Z' }),
  };
}

describe('anon_user_hash 假名（HMAC 安装随机 id）', () => {
  it('HMAC-SHA256 → 64hex', () => {
    expect(createAnonUserHash('install-id-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(createAnonUserHash('install-id-1')).toBe(createAnonUserHash('install-id-1'));
    expect(createAnonUserHash('install-id-2')).not.toBe(createAnonUserHash('install-id-1'));
  });
});

describe('上报器：guard wire 体 → 服务端 v1.2 批量契约', () => {
  let kv: ReturnType<typeof makeKv>;

  beforeEach(() => {
    kv = makeKv();
  });

  afterEach(() => {
    kv.map.clear();
  });

  it('批量契约翻译：consent:true + event + anon_user_hash(64hex) + payload + at，POST 到 endpoint', async () => {
    const { fetchFn, calls } = makeFetch([202]);
    const uploader = createTelemetryUploader({ endpoint: 'http://127.0.0.1:1/api/v1/telemetry/events', kv, fetchFn });
    const res = await uploader('http://ignored', guardInit({ name: 'circuit_open', payload: { reason: 'captcha-hit' } }));
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:1/api/v1/telemetry/events');
    const batch = JSON.parse(String(calls[0]!.init?.body)) as Array<{
      consent: boolean;
      event: string;
      anon_user_hash: string;
      payload: unknown;
      at: string;
    }>;
    expect(batch).toHaveLength(1);
    expect(batch[0]!.consent).toBe(true);
    expect(batch[0]!.event).toBe('circuit_open');
    expect(batch[0]!.anon_user_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(batch[0]!.payload).toEqual({ reason: 'captcha-hit' });
    expect(batch[0]!.at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('安装 id 持久化：首次生成写 kv，后续复用；跨「重启」（同 kv 重建 uploader）hash 稳定', async () => {
    const hashes: string[] = [];
    const record = makeFetch([202, 202, 202]);
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await record.fetchFn(url, init);
      const batch = JSON.parse(String(init?.body)) as Array<{ anon_user_hash: string }>;
      hashes.push(batch[0]!.anon_user_hash);
      return res;
    }) as typeof fetch;

    const first = createTelemetryUploader({ endpoint: 'http://e', kv, fetchFn });
    await first('http://ignored', guardInit({ name: 'selfcheck_fail' }));
    await first('http://ignored', guardInit({ name: 'selfcheck_fail' }));
    expect(kv.sets).toEqual([ANON_INSTALL_ID_KV_KEY]);

    // 跨「重启」：同 kv 重建 uploader（重新解析安装 id），hash 仍一致
    const restarted = createTelemetryUploader({ endpoint: 'http://e', kv, fetchFn });
    await restarted('http://ignored', guardInit({ name: 'selfcheck_fail' }));

    expect(hashes).toHaveLength(3);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(createAnonUserHash(kv.map.get(ANON_INSTALL_ID_KV_KEY)!));
  });

  it('kv 故障 → 会话级临时 id 兜底，仍产出 64hex 假名且不上抛', async () => {
    const brokenKv = makeKv({ broken: true });
    const { fetchFn, calls } = makeFetch([202]);
    const uploader = createTelemetryUploader({ endpoint: 'http://e', kv: brokenKv, fetchFn });
    const res = await uploader('http://ignored', guardInit({ name: 'circuit_closed' }));
    expect(res.status).toBe(202);
    const batch = JSON.parse(String(calls[0]!.init?.body)) as Array<{ anon_user_hash: string }>;
    expect(batch[0]!.anon_user_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('失败静默重试 ≤1：网络异常→补发 1 次成功；持续异常→恰 2 次调用且不 reject', async () => {
    const once = makeFetch(['throw', 202]);
    const uploader1 = createTelemetryUploader({ endpoint: 'http://e', kv, fetchFn: once.fetchFn });
    const ok = await uploader1('http://ignored', guardInit({ name: 'first_collection_completed' }));
    expect(ok.status).toBe(202);
    expect(once.calls).toHaveLength(2);

    const always = makeFetch(['throw']);
    const uploader2 = createTelemetryUploader({ endpoint: 'http://e', kv, fetchFn: always.fetchFn });
    const res = await uploader2('http://ignored', guardInit({ name: 'key_failover' }));
    expect(always.calls).toHaveLength(2);
    expect(res.status).toBe(599);
  });

  it('5xx 瞬时不可用 → 补发 1 次；4xx 永久拒收 → 不重试', async () => {
    const fiveThenOk = makeFetch([500, 202]);
    const uploader1 = createTelemetryUploader({ endpoint: 'http://e', kv, fetchFn: fiveThenOk.fetchFn });
    expect((await uploader1('http://ignored', guardInit({ name: 'first_report_generated' }))).status).toBe(202);
    expect(fiveThenOk.calls).toHaveLength(2);

    const four = makeFetch([422]);
    const uploader2 = createTelemetryUploader({ endpoint: 'http://e', kv, fetchFn: four.fetchFn });
    expect((await uploader2('http://ignored', guardInit({ name: 'circuit_open' }))).status).toBe(422);
    expect(four.calls).toHaveLength(1);
  });

  it('异常入参（空 init）不上抛：合成 599 响应', async () => {
    const { fetchFn, calls } = makeFetch([202]);
    const uploader = createTelemetryUploader({ endpoint: 'http://e', kv, fetchFn });
    const res = await uploader('http://ignored', undefined);
    expect(calls).toHaveLength(0);
    expect(res.status).toBe(599);
  });
});
