/**
 * 1688 官方 AI 网关客户端测试（T-M2-05a）。
 *
 * 签名金标向量：按 next-1688/1688-shopkeeper `_auth.py build_signature` 语义独立
 * 转写计算（body/ak/timestamp/nonce 固定），硬编码于此防算法漂移；真伪终验 =
 * scripts/probe-1688-api.mjs 用真实 AK 打网关（用户侧验收步骤）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApiCallError,
  API_1688_SEARCH_LIMIT,
  buildSignedHeaders,
  extractAkKeys,
  searchOffers1688,
  type FetchLike,
} from './api-client.js';

describe('extractAkKeys（AI版 AK 拆分：前 32 = secret，其余 = id）', () => {
  it('base64url 形态：先解码再拆分', () => {
    const secret = 'S'.repeat(32);
    const raw = Buffer.from(`${secret}AKID12345`, 'utf8').toString('base64url');
    const parts = extractAkKeys(raw);
    expect(parts).toEqual({ accessKeyId: 'AKID12345', accessKeySecret: secret });
  });

  it('原文形态（base64url 字符集外 → 直接按原文拆分）', () => {
    // 含 ':' 不在 base64url 字符集 → charset 门直接走原文
    const raw = `${'K'.repeat(32)}:ID123`;
    expect(extractAkKeys(raw)).toEqual({ accessKeyId: ':ID123', accessKeySecret: 'K'.repeat(32) });
  });

  it('可 base64 解码但解码产物非合法 UTF-8 → 回退原文（对齐 Python 异常回退）', () => {
    const raw = Buffer.alloc(40, 0xff).toString('base64url');
    const parts = extractAkKeys(raw);
    expect(parts).not.toBeNull();
    expect(parts?.accessKeySecret).toBe(raw.slice(0, 32));
    expect(parts?.accessKeyId).toBe(raw.slice(32));
  });

  it('过短（<32）与恰好 32（id 为空）→ null', () => {
    expect(extractAkKeys('short')).toBeNull();
    expect(extractAkKeys('K'.repeat(32))).toBeNull();
    expect(extractAkKeys('')).toBeNull();
  });
});

describe('buildSignedHeaders（x-csk 签名）', () => {
  // 金标向量：scratch 按 _auth.py 语义独立计算（POST + application/json + 五头字典序 + path）
  const GOLDEN = {
    body: '{"query":"test","channel":"douyin"}',
    md5b64: 'PAUfU0MCKZPtT540rBi+Ug==',
    sign: '4hVm32088595CL31uArl4zFglsXgj7uRKe5uhTHi1F8=',
  };

  it('固定入参 → 与金标向量逐头一致', () => {
    const headers = buildSignedHeaders({
      method: 'POST',
      path: '/1688claw/skill/searchoffer',
      body: GOLDEN.body,
      contentType: 'application/json',
      accessKeyId: 'AKIDEXAMPLE12345',
      accessKeySecret: 'S'.repeat(32),
      timestampSeconds: 1_760_000_000,
      nonce: 'deadbeef',
    });
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-csk-ak']).toBe('AKIDEXAMPLE12345');
    expect(headers['x-csk-time']).toBe('1760000000');
    expect(headers['x-csk-nonce']).toBe('deadbeef');
    expect(headers['x-csk-content-md5']).toBe(GOLDEN.md5b64);
    expect(headers['x-csk-version']).toBe('1.0.1');
    expect(headers['x-csk-sign']).toBe(GOLDEN.sign);
    // content-md5 必须是对实际发送 body 的 MD5（防「签 A 发 B」）
    expect(createHash('md5').update(GOLDEN.body, 'utf8').digest('base64')).toBe(GOLDEN.md5b64);
  });

  it('body 变化 → 签名随之变化', () => {
    const base = {
      method: 'POST',
      path: '/1688claw/skill/searchoffer',
      contentType: 'application/json',
      accessKeyId: 'ID',
      accessKeySecret: 'S'.repeat(32),
      timestampSeconds: 1,
      nonce: 'n1',
    };
    const a = buildSignedHeaders({ ...base, body: '{"a":1}' });
    const b = buildSignedHeaders({ ...base, body: '{"a":2}' });
    expect(a['x-csk-sign']).not.toBe(b['x-csk-sign']);
    expect(a['x-csk-content-md5']).not.toBe(b['x-csk-content-md5']);
  });
});

/** 构造固定 200 响应桩 */
function fetchOk(payload: unknown): {
  fetchImpl: FetchLike;
  calls: { url: string; init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal } }[];
} {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal } }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
}

describe('searchOffers1688（searchoffer 调用）', () => {
  const ak = { accessKeyId: 'AKID12345', accessKeySecret: 'S'.repeat(32) };

  it('success 响应：data map → 归一化条目（salesText 按 stats 形态映射）', async () => {
    const { fetchImpl, calls } = fetchOk({
      success: true,
      model: {
        data: {
          '740123': { title: '不锈钢收纳架', price: '3.5', image: 'https://cbu01.alicdn.com/a.jpg', stats: { last30DaysSales: 8500, repurchaseRate: 0.23 } },
          '740124': { title: '收纳盒', price: 12.9, stats: { last30DaysSales: '1.2万+' } },
          '740125': { title: '无 stats 商品', price: null },
        },
      },
    });
    const items = await searchOffers1688({ fetchImpl, ak, query: '收纳' });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      offerId: '740123',
      title: '不锈钢收纳架',
      priceText: '3.5',
      imageUrl: 'https://cbu01.alicdn.com/a.jpg',
      salesText: '8500件',
    });
    expect(items[0].stats).toEqual({ last30DaysSales: 8500, repurchaseRate: 0.23 });
    expect(items[1].salesText).toBe('1.2万+');
    expect(items[1].priceText).toBe('12.9');
    expect(items[2].salesText).toBeNull();
    expect(items[2].imageUrl).toBeNull();
    // 请求面：URL/方法/签名头/body 三要素
    expect(calls[0].url).toBe('https://ainext.1688.com/1688claw/skill/searchoffer');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-csk-ak']).toBe('AKID12345');
    expect(calls[0].init.body).toBe('{"query":"收纳","channel":""}');
    expect(calls[0].init.method).toBe('POST');
  });

  it('success:false → 按 msgCode 状态码归一（\\b 词边界语义如实转写 _http.py）', async () => {
    // 独立「429」命中边界 → ratelimit
    const limited = fetchOk({ success: false, msgCode: '429', msgInfo: '请求过快' });
    await expect(searchOffers1688({ fetchImpl: limited.fetchImpl, ak, query: 'x' })).rejects.toMatchObject({
      kind: 'ratelimit',
      msgCode: '429',
    });
    // 「FAIL_SYS_FLOW_429」中 _429 无词边界（Python \b 同样不命中）→ 归 service
    const embedded = fetchOk({ success: false, msgCode: 'FAIL_SYS_FLOW_429', msgInfo: '请求过快' });
    await expect(searchOffers1688({ fetchImpl: embedded.fetchImpl, ak, query: 'x' })).rejects.toMatchObject({
      kind: 'service',
      message: expect.stringContaining('请求过快'),
    });
    // 未知码 → service（msgInfo 优先于 msgCode）
    const other = fetchOk({ success: false, msgCode: 'BIZ_UNKNOWN', msgInfo: '系统繁忙' });
    await expect(searchOffers1688({ fetchImpl: other.fetchImpl, ak, query: 'x' })).rejects.toMatchObject({
      kind: 'service',
      message: expect.stringContaining('系统繁忙'),
    });
  });

  it('HTTP 401 → auth 且不重试；HTTP 400 → param', async () => {
    let calls401 = 0;
    const fetch401: FetchLike = async () => {
      calls401 += 1;
      return { status: 401, text: async () => 'unauthorized' };
    };
    await expect(searchOffers1688({ fetchImpl: fetch401, ak, query: 'x' })).rejects.toBeInstanceOf(ApiCallError);
    expect(calls401).toBe(1);
    const fetch400: FetchLike = async () => ({ status: 400, text: async () => 'bad' });
    await expect(searchOffers1688({ fetchImpl: fetch400, ak, query: 'x' })).rejects.toMatchObject({ kind: 'param' });
  });

  it('网络异常 → 重试至 maxAttempts 后 network 错误（退避注入瞬时化）', async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchFail: FetchLike = async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    };
    await expect(
      searchOffers1688({
        fetchImpl: fetchFail,
        ak,
        query: 'x',
        maxRetries: 3,
        delayFn: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it('超时 abort → 归 network 类', async () => {
    const fetchHang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      });
    await expect(
      searchOffers1688({ fetchImpl: fetchHang, ak, query: 'x', timeoutMs: 20, maxRetries: 1 }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('limit 常量对齐官方 SEARCH_LIMIT=20（端口层切片依据）', () => {
    expect(API_1688_SEARCH_LIMIT).toBe(20);
  });
});
