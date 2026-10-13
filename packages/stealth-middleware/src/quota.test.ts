import { describe, it, expect } from 'vitest';
import {
  DAILY_HARD_CAPS,
  DailyQuotaLedger,
  QUOTA_KINDS,
  QuotaHardCapViolationError,
  QuotaLimitInvalidError,
  createMemoryQuotaStore,
  localDateKey,
  type QuotaKind,
} from './quota.js';

/** 本地时刻构造：new Date(y, m0, d, h, min, s, ms) */
const local = (h: number, min = 0, s = 0, ms = 0, day = 13): Date => new Date(2026, 9, day, h, min, s, ms);

describe('quota: 硬上限表（02 §7.1 :331 照抄）', () => {
  it('采集 300 / 评论 30 / 发布 10', () => {
    expect(DAILY_HARD_CAPS).toEqual({ collect: 300, comment: 30, publish: 10 });
    expect(Object.isFrozen(DAILY_HARD_CAPS)).toBe(true);
    expect([...QUOTA_KINDS]).toEqual(['collect', 'comment', 'publish']);
  });

  it('各类目账本缺省上限 = 各自硬上限', async () => {
    for (const kind of QUOTA_KINDS) {
      const ledger = new DailyQuotaLedger({ kind, store: createMemoryQuotaStore(), now: () => local(12) });
      expect(ledger.hardCap()).toBe(DAILY_HARD_CAPS[kind as QuotaKind]);
      await expect(ledger.limit()).resolves.toBe(DAILY_HARD_CAPS[kind as QuotaKind]);
    }
  });
});

describe('quota: 记账消费与触顶', () => {
  it('限量内消费放行且余额递减', async () => {
    const ledger = new DailyQuotaLedger({ kind: 'comment', store: createMemoryQuotaStore(), now: () => local(12) });
    const d1 = await ledger.consume();
    expect(d1.allowed).toBe(true);
    expect(d1.remaining).toBe(29);
    const d2 = await ledger.consume(2);
    expect(d2.allowed).toBe(true);
    expect(d2.used).toBe(3);
    expect(d2.remaining).toBe(27);
  });

  it('触顶：超限请求拒绝且不落账（幂等）', async () => {
    const ledger = new DailyQuotaLedger({ kind: 'publish', store: createMemoryQuotaStore(), now: () => local(12) });
    const d1 = await ledger.consume(10);
    expect(d1.allowed).toBe(true);
    expect(d1.remaining).toBe(0);
    const d2 = await ledger.consume(1);
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toBe('quota-exhausted');
    await expect(ledger.used()).resolves.toBe(10);
    const d3 = await ledger.consume(1);
    expect(d3.allowed).toBe(false);
    await expect(ledger.used()).resolves.toBe(10);
  });

  it('collect 300 全量记账到触顶边界（299→300 放行，第 301 拒绝）', async () => {
    const ledger = new DailyQuotaLedger({ kind: 'collect', store: createMemoryQuotaStore(), now: () => local(9) });
    for (let i = 0; i < 299; i += 1) {
      const d = await ledger.consume();
      expect(d.allowed).toBe(true);
    }
    const edge = await ledger.consume();
    expect(edge.allowed).toBe(true);
    expect(edge.used).toBe(300);
    const over = await ledger.consume();
    expect(over.allowed).toBe(false);
  });
});

describe('quota: 本地日历日 00:00 重置（02 §7.1 :331）', () => {
  it('23:59:59.999 记账后，00:00:00.000 换日用量归零', async () => {
    let now = local(23, 59, 59, 999);
    const ledger = new DailyQuotaLedger({ kind: 'collect', store: createMemoryQuotaStore(), now: () => now });
    await expect(ledger.consume(5)).resolves.toMatchObject({ allowed: true, used: 5 });
    now = local(0, 0, 0, 0, 14);
    await expect(ledger.used()).resolves.toBe(0);
    const d = await ledger.consume(1);
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(1);
  });

  it('昨日用量不泄漏：日期键分桶隔离', async () => {
    let now = local(10);
    const ledger = new DailyQuotaLedger({ kind: 'collect', store: createMemoryQuotaStore(), now: () => now });
    await ledger.consume(300);
    now = local(10, 0, 0, 0, 14);
    await expect(ledger.used()).resolves.toBe(0);
    await expect(ledger.remaining()).resolves.toBe(300);
  });

  it('localDateKey 为本地时区 YYYY-MM-DD', () => {
    expect(localDateKey(local(9, 5, 3, 120))).toBe('2026-10-13');
    expect(localDateKey(new Date(2026, 0, 2, 0, 0, 0, 0))).toBe('2026-01-02');
  });
});

describe('quota: 只可下调（硬上限天花板）', () => {
  it('setLimit ≤ 硬上限持久化（跨账本实例经 store 读回）', async () => {
    const store = createMemoryQuotaStore();
    const a = new DailyQuotaLedger({ kind: 'collect', store, now: () => local(12) });
    await a.setLimit(50);
    const b = new DailyQuotaLedger({ kind: 'collect', store, now: () => local(12) });
    await expect(b.limit()).resolves.toBe(50);
  });

  it('setLimit > 硬上限抛 QuotaHardCapViolationError（300 只能下调）', async () => {
    const ledger = new DailyQuotaLedger({ kind: 'collect', store: createMemoryQuotaStore(), now: () => local(12) });
    await expect(ledger.setLimit(301)).rejects.toThrow(QuotaHardCapViolationError);
    await expect(ledger.limit()).resolves.toBe(300);
  });

  it('setLimit 恰等于硬上限允许（=300 合法）', async () => {
    const ledger = new DailyQuotaLedger({ kind: 'collect', store: createMemoryQuotaStore(), now: () => local(12) });
    await expect(ledger.setLimit(300)).resolves.toBeUndefined();
    await expect(ledger.limit()).resolves.toBe(300);
  });

  it('非法上限（0 / 负数 / 小数）抛 QuotaLimitInvalidError', async () => {
    const ledger = new DailyQuotaLedger({ kind: 'comment', store: createMemoryQuotaStore(), now: () => local(12) });
    await expect(ledger.setLimit(0)).rejects.toThrow(QuotaLimitInvalidError);
    await expect(ledger.setLimit(-5)).rejects.toThrow(QuotaLimitInvalidError);
    await expect(ledger.setLimit(1.5)).rejects.toThrow(QuotaLimitInvalidError);
  });

  it('下调后的上限约束消费（limit=50 → 第 51 条拒绝）', async () => {
    let now = local(8);
    const ledger = new DailyQuotaLedger({ kind: 'collect', store: createMemoryQuotaStore(), now: () => now });
    await ledger.setLimit(50);
    for (let i = 0; i < 50; i += 1) await ledger.consume();
    now = local(9);
    const d = await ledger.consume();
    expect(d.allowed).toBe(false);
    expect(d.limit).toBe(50);
  });

  it('各类目账本互相独立（collect 用量不影响 publish）', async () => {
    const store = createMemoryQuotaStore();
    const collect = new DailyQuotaLedger({ kind: 'collect', store, now: () => local(12) });
    const publish = new DailyQuotaLedger({ kind: 'publish', store, now: () => local(12) });
    await collect.consume(300);
    await expect(publish.used()).resolves.toBe(0);
    await expect(publish.remaining()).resolves.toBe(10);
  });
});
