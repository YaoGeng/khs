/**
 * 日配额记账（T-M1-03 / 02-系统架构设计.md §7.1 :331）。
 *
 * §7.5 参数表引用值（照抄）：
 *   quota.daily_hard_cap  采集 300 条 / 评论 30 条 / 发布 10 条；硬上限，UI 只能下调 §7.1（:331）
 *
 * 持久化经注入式 QuotaStore（宿主接 kv_config，见 todo-6 表设计）；重置 = 本地日历日 00:00
 * ——用量按「本地日期键」分桶存储，换日自然读到 0，无需定时器。
 * 本模块零外部依赖，不直接触 fs/sqlite/electron。
 */

export type QuotaKind = 'collect' | 'comment' | 'publish';

export const QUOTA_KINDS = ['collect', 'comment', 'publish'] as const;

/** 硬上限（§7.1 :331）：任何配置源都不得越过；只能向下收紧。 */
export const DAILY_HARD_CAPS: Readonly<Record<QuotaKind, number>> = Object.freeze({
  collect: 300,
  comment: 30,
  publish: 10,
});

/** 注入式持久化接口（宿主 todo-6/7 以 kv_config 适配；键值均为字符串）。 */
export interface QuotaStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** 内存 QuotaStore（测试与无持久化环境的缺省实现）。 */
export function createMemoryQuotaStore(): QuotaStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

/** 本地日历日键（YYYY-MM-DD，本地时区）——重置语义的锚点。 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const usageKey = (kind: QuotaKind, d: Date): string => `quota:v1:${kind}:${localDateKey(d)}`;
const limitKey = (kind: QuotaKind): string => `quota:v1:${kind}:limit`;

export type QuotaBlockReason = 'quota-exhausted';

export interface QuotaDecision {
  allowed: boolean;
  kind: QuotaKind;
  /** 本次请求量 */
  requested: number;
  used: number;
  limit: number;
  remaining: number;
  reason?: QuotaBlockReason;
}

export class QuotaHardCapViolationError extends Error {
  readonly code = 'E-QUOTA-ABOVE-HARD-CAP';
  constructor(kind: QuotaKind, requested: number, hardCap: number) {
    super(`quota limit for ${kind} cannot exceed hard cap: requested ${requested} > ${hardCap} (02 §7.1 :331, 下调不可上调)`);
    this.name = 'QuotaHardCapViolationError';
  }
}

export class QuotaLimitInvalidError extends Error {
  readonly code = 'E-QUOTA-LIMIT-INVALID';
  constructor(limit: number) {
    super(`quota limit must be a positive integer: ${limit}`);
    this.name = 'QuotaLimitInvalidError';
  }
}

export interface DailyQuotaLedgerOptions {
  kind: QuotaKind;
  store: QuotaStore;
  /** 时钟注入（本地日历日与重置判定都经此） */
  now: () => Date;
}

/**
 * 单一类目的日配额账本：
 * - 用量键含本地日期 → 本地日历日 00:00 自动重置（02 §7.1 :331 语义）；
 * - 上限只能 ≤ 硬上限（下调），越界即抛错；
 * - consume 原子性由调用方持久层保证（M1 单浏览器串行 + 单写者 store，无并发账本竞争）。
 */
export class DailyQuotaLedger {
  private readonly kind: QuotaKind;
  private readonly store: QuotaStore;
  private readonly now: () => Date;

  constructor(opts: DailyQuotaLedgerOptions) {
    this.kind = opts.kind;
    this.store = opts.store;
    this.now = opts.now;
  }

  get quotaKind(): QuotaKind {
    return this.kind;
  }

  hardCap(): number {
    return DAILY_HARD_CAPS[this.kind];
  }

  /** 当前生效上限：持久化值（可下调）或缺省硬上限。 */
  async limit(): Promise<number> {
    const raw = await this.store.get(limitKey(this.kind));
    if (raw === null) return this.hardCap();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > this.hardCap()) return this.hardCap();
    return parsed;
  }

  /**
   * 下调（或恢复 ≤ 硬上限的）配额上限；超过硬上限一律拒绝。
   * 「只能下调」语义（02 §7.1 :331）：以硬上限为天花板，UI/配置源不得越过。
   */
  async setLimit(limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1) throw new QuotaLimitInvalidError(limit);
    if (limit > this.hardCap()) throw new QuotaHardCapViolationError(this.kind, limit, this.hardCap());
    await this.store.set(limitKey(this.kind), String(limit));
  }

  /** 今日已用量（本地日历日口径）。 */
  async used(): Promise<number> {
    const raw = await this.store.get(usageKey(this.kind, this.now()));
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  async remaining(): Promise<number> {
    return Math.max(0, (await this.limit()) - (await this.used()));
  }

  /** 记账消费：不超限则落账并放行，超限拒绝（幂等：拒绝不落账）。 */
  async consume(n = 1): Promise<QuotaDecision> {
    const limit = await this.limit();
    const used = await this.used();
    const remaining = Math.max(0, limit - used);
    if (n > remaining) {
      return { allowed: false, kind: this.kind, requested: n, used, limit, remaining: 0, reason: 'quota-exhausted' };
    }
    const nextUsed = used + n;
    await this.store.set(usageKey(this.kind, this.now()), String(nextUsed));
    return {
      allowed: true,
      kind: this.kind,
      requested: n,
      used: nextUsed,
      limit,
      remaining: Math.max(0, limit - nextUsed),
    };
  }
}
