/** ak-store 单测（electron-free：kv 用内存 Map，safeStorage 注入 fake） */
import { describe, expect, it } from 'vitest';
import { createAkStore, maskAkId } from './ak-store';
import type { SafeStoragePort } from './key-service';
import type { KvValue } from '../store/protocol';

function fakeKv() {
  const map = new Map<string, KvValue>();
  return {
    map,
    kvGet: async (key: string) => map.get(key) ?? null,
    kvSet: async (key: string, value: KvValue) => {
      map.set(key, value);
      return { set: true };
    },
  };
}

function fakeSafeStorage(available = true): SafeStoragePort & { decryptCalls: number } {
  const store = { decryptCalls: 0 };
  return {
    ...store,
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      store.decryptCalls += 1;
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this fake');
      return text.slice(4);
    },
  } as SafeStoragePort & { decryptCalls: number };
}

// 官方 clawhub 实发形态：带 = padding 的标准 base64（新语义 %4==0 才解码，padding 必带）
const RAW_AK = Buffer.from(`${'S'.repeat(32)}AKID-1234`, 'utf8').toString('base64');

describe('createAkStore', () => {
  it('set + get 往返：密文落库（Buffer），get 还原 id/secret 拆分', async () => {
    const kv = fakeKv();
    const safe = fakeSafeStorage();
    const store = createAkStore({ store: kv, safeStorage: safe });
    const result = await store.setRaw(RAW_AK);
    expect(result).toEqual({ accessKeyIdMasked: '****1234', encryption: 'safeStorage' });
    expect(Buffer.isBuffer(kv.map.get('sourcing:ak:v1'))).toBe(true);
    const parts = await store.get();
    expect(parts).toEqual({ accessKeyId: 'AKID-1234', accessKeySecret: 'S'.repeat(32) });
    const status = await store.status();
    expect(status).toMatchObject({ configured: true, accessKeyIdMasked: '****1234', encryption: 'safeStorage' });
    expect(status.setAt).toBeTruthy();
  });

  it('非法 AK：抛 E-SOURCING-AK-INVALID 且不落库', async () => {
    const kv = fakeKv();
    const store = createAkStore({ store: kv, safeStorage: fakeSafeStorage() });
    await expect(store.setRaw('short')).rejects.toMatchObject({
      message: expect.stringContaining('E-SOURCING-AK-INVALID'),
    });
    expect(kv.map.size).toBe(0);
  });

  it('safeStorage 不可用 → 先审计后明文落库（显式降级），告警随结果返回', async () => {
    const kv = fakeKv();
    const auditOrder: string[] = [];
    const store = createAkStore({
      store: {
        kvGet: kv.kvGet,
        kvSet: async (key, value) => {
          auditOrder.push(`kvSet:${key}`);
          return kv.kvSet(key, value);
        },
      },
      safeStorage: null,
      onAudit: (msg) => {
        auditOrder.push(`audit:${msg}`);
      },
    });
    const result = await store.setRaw(RAW_AK);
    expect(result.encryption).toBe('plaintext-fallback');
    expect(result.warning).toContain('明文');
    // 审计条目必须先于明文落库（key-service 同款纪律）
    expect(auditOrder[0]).toBe('audit:sourcing:ak-stored-plaintext-fallback');
    expect(auditOrder[1]).toBe('kvSet:sourcing:ak:v1');
    expect(kv.map.get('sourcing:ak:v1')).toBe(RAW_AK);
    expect(await store.get()).toMatchObject({ accessKeyId: 'AKID-1234' });
    expect((await store.status()).encryption).toBe('plaintext-fallback');
  });

  it('clear：状态回未配置，get 返回 null', async () => {
    const kv = fakeKv();
    const store = createAkStore({ store: kv, safeStorage: fakeSafeStorage() });
    await store.setRaw(RAW_AK);
    await store.clear();
    expect(await store.status()).toEqual({ configured: false, accessKeyIdMasked: null, encryption: null, setAt: null });
    expect(await store.get()).toBeNull();
  });

  it('kv 返回普通 Uint8Array（store worker 进程边界丢失 Buffer 原型）→ 仍按密文解密', async () => {
    const kv = fakeKv();
    const safe = fakeSafeStorage();
    const store = createAkStore({ store: kv, safeStorage: safe });
    await store.setRaw(RAW_AK);
    const stored = kv.map.get('sourcing:ak:v1') as Buffer;
    // 模拟超出 KvValue 契约的运行时形态（结构化克隆后 Buffer 原型丢失）——故显式断言转换
    kv.map.set('sourcing:ak:v1', new Uint8Array(stored) as unknown as KvValue);
    expect(Buffer.isBuffer(kv.map.get('sourcing:ak:v1'))).toBe(false);
    expect(await store.get()).toMatchObject({ accessKeyId: 'AKID-1234' });
  });

  it('maskAkId：`****` + akId 后 4 位', () => {
    expect(maskAkId('AKID-1234')).toBe('****1234');
    expect(maskAkId('x')).toBe('****x');
  });
});
