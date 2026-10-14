/**
 * FR-2.6 RPM 令牌桶单测（todo 12；01:131）：fake clock 确定性复现——
 * 100/min 配置下前 100 个请求直通、第 101 个挂起到下一个可用令牌；
 * 平滑补充速率=rpm/60s；rpm=0 直通；composeLimiters 顺序串联。
 */
import { describe, it, expect } from 'vitest';
import { TokenBucketLimiter, composeLimiters } from './ratelimit.js';
import { LlmGateway } from './gateway.js';

/** fake clock：now 可手动推进；sleep 推进时钟（模拟真实等待） */
function fakeClock() {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleep: async (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('FR-2.6 TokenBucketLimiter', () => {
  it('100/min：前 100 个请求直通，第 101 个挂起到下一可用令牌（fake clock）', async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ rpm: 100, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 100; i += 1) {
      const before = clock.now();
      await limiter.acquire();
      expect(clock.now()).toBe(before); // 满桶直通：零等待
    }
    const waits: number[] = [];
    const waitLimiter = new TokenBucketLimiter({ rpm: 100, now: clock.now, sleep: async (ms) => { waits.push(ms); clock.advance(ms); } });
    for (let i = 0; i < 100; i += 1) await waitLimiter.acquire();
    const before = clock.now();
    await waitLimiter.acquire(); // 第 101 个：桶空，挂起
    const waited = clock.now() - before;
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waited).toBeGreaterThan(0);
    // 平滑补充：60000ms/100 = 每令牌 600ms（容忍多次小段等待合计 ≥600ms）
    expect(waited).toBeGreaterThanOrEqual(599);
    expect(waited).toBeLessThan(60_000); // 平滑桶不等整窗
  });

  it('rpm=0 不限流（直通；不调 sleep）', async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ rpm: 0, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 1000; i += 1) await limiter.acquire();
    expect(clock.now()).toBe(1_000_000);
  });

  it('时间流逝自动回补令牌：60s 后恢复 100 发容量', async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ rpm: 100, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 100; i += 1) await limiter.acquire();
    clock.advance(60_000);
    for (let i = 0; i < 100; i += 1) await limiter.acquire(); // 回补满，直通
    expect(clock.now()).toBe(1_000_000 + 60_000);
  });

  it('composeLimiters 顺序串联：全局桶耗尽时即使任务桶满也等待', async () => {
    const clock = fakeClock();
    const global = new TokenBucketLimiter({ rpm: 100, now: clock.now, sleep: clock.sleep });
    const task = new TokenBucketLimiter({ rpm: 100, now: clock.now, sleep: clock.sleep });
    const composed = composeLimiters(global, task);
    for (let i = 0; i < 100; i += 1) await composed.acquire();
    const before = clock.now();
    await composed.acquire();
    expect(clock.now() - before).toBeGreaterThanOrEqual(599);
  });
});

describe('FR-2.6 网关集成：limiter 注入后每次 HTTP 请求前 acquire', () => {
  const base = { provider: 'mock-provider', baseUrl: 'https://mock.local/v1', apiKey: 'sk-test', model: 'mock-model' };

  it('chat 每请求过桶：退避重试也各占一个令牌', async () => {
    const clock = fakeClock();
    let acquires = 0;
    let n = 0;
    const gateway = new LlmGateway({
      ...base,
      limiter: { acquire: async () => { acquires += 1; } },
      fetchImpl: (async () => {
        n += 1;
        if (n === 1) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
      sleep: clock.sleep,
    });
    const result = await gateway.chat({ user: 'hi' });
    expect(result.content).toBe('ok');
    expect(acquires).toBe(2); // 首试 + 一次退避重试
  });
});
