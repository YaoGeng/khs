/**
 * FR-2.6 RPM 令牌桶限流器（01:131 / 03:220「RPM 入 llm-gateway」定论）。
 *
 * - 平滑补充令牌：容量=rpm、补充速率=rpm/60000 每毫秒；acquire() 令牌不足时
 *   排队等待到下一个可用令牌（挂起非报错，01:131 语义）；
 * - now/sleep 可注入（fake clock 测试：sleep 推进 fake 时钟即可确定性复现）；
 * - rpm≤0 = 不限流（直通）；组合根把「全局桶 + 任务桶」经 composeLimiters 串联注入 GatewayConfig.limiter。
 */
export interface TokenBucketOptions {
  /** 每分钟请求数上限（>0 生效；0/负数=不限流） */
  rpm: number;
  /** 测试注入时钟（毫秒）；默认 Date.now */
  now?: () => number;
  /** 测试注入 sleep；默认 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

export class TokenBucketLimiter {
  private readonly rpm: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillMs: number;

  constructor(options: TokenBucketOptions) {
    this.rpm = options.rpm;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.tokens = Math.max(0, options.rpm);
    this.lastRefillMs = this.now();
  }

  /** 距上次取用以来平滑补充令牌（容量=rpm 封顶） */
  private refill(): void {
    const nowMs = this.now();
    const elapsed = nowMs - this.lastRefillMs;
    if (elapsed > 0 && this.rpm > 0) {
      this.tokens = Math.min(this.rpm, this.tokens + (elapsed / 60_000) * this.rpm);
    }
    this.lastRefillMs = nowMs;
  }

  /** 取一个令牌；不足时挂起到下一个可用令牌（排队语义，绝不抛错） */
  async acquire(): Promise<void> {
    if (this.rpm <= 0) return;
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.rpm) * 60_000));
      await this.sleep(waitMs);
    }
  }
}

/** 组合限流面：顺序 acquire 全部桶（全局桶在前、任务桶在后——任一不足即等待） */
export function composeLimiters(...limiters: Array< { acquire(): Promise<void> } | undefined>): { acquire(): Promise<void> } {
  const active = limiters.filter((l): l is { acquire(): Promise<void> } => Boolean(l));
  return {
    async acquire(): Promise<void> {
      for (const limiter of active) await limiter.acquire();
    },
  };
}
