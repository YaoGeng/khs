import { describe, expect, it } from 'vitest';
import { randomArithmetic, renderCaptchaSvg, CaptchaService } from '../src/auth/captcha.service.js';
import { parseEnv } from '../src/config/env.js';
import { RedisService } from '../src/infrastructure/redis.service.js';
import { captchaKey } from '../src/auth/redis-keys.js';

const config: ReturnType<typeof parseEnv> = parseEnv({
  XINGLIAN_REDIS_DRIVER: 'mock',
  JWT_SECRET: 'm0-unit-secret-0123456789abcdef',
});

describe('randomArithmetic 单测', () => {
  it('算式与答案一致（加法）', () => {
    const { question, answer } = randomArithmetic();
    const m = question.match(/^(\d+) ([+-]) (\d+) = \?$/) as RegExpMatchArray;
    const a = Number(m[1]);
    const op = m[2];
    const b = Number(m[3]);
    expect(op === '+' ? a + b : a - b).toBe(answer);
    expect(answer).toBeGreaterThanOrEqual(0);
  });
});

describe('renderCaptchaSvg 单测', () => {
  /** 提取 SVG 中所有 text 节点内容（坐标数字不影响断言）。 */
  const svgText = (svg: string): string =>
    [...svg.matchAll(/>([^<>]*)</g)].map((m) => m[1]).join('');

  it('SVG 文本包含算式且不泄露答案', () => {
    const text = svgText(renderCaptchaSvg('7 + 5 = ?'));
    expect(text).toContain('7');
    expect(text).toContain('+');
    expect(text).toContain('5');
    expect(text).toContain('?');
    expect(text).not.toContain('12');
  });
});

describe('CaptchaService（ioredis-mock）', () => {
  it('创建→答对一次→再答被消费拒绝', async () => {
    const redis = new RedisService(config);
    const captcha = new CaptchaService(config, redis);
    const { captchaId, svg } = await captcha.create();
    expect(captchaId.length).toBeGreaterThan(16);
    expect(svg).toContain('<svg');
    const expected = await redis.raw.get(captchaKey(captchaId));
    expect(expected).not.toBeNull();
    expect(await redis.raw.ttl(captchaKey(captchaId))).toBeGreaterThan(0);
    expect(await captcha.verify(captchaId, expected as string)).toBe(true);
    expect(await captcha.verify(captchaId, expected as string)).toBe(false);
    await redis.onModuleDestroy();
  });

  it('错误答案拒绝且同样被消费', async () => {
    const redis = new RedisService(config);
    const captcha = new CaptchaService(config, redis);
    const { captchaId } = await captcha.create();
    expect(await captcha.verify(captchaId, '99')).toBe(false);
    expect(await captcha.verify(captchaId, '1')).toBe(false);
    expect(await redis.raw.get(captchaKey(captchaId))).toBeNull();
    await redis.onModuleDestroy();
  });

  it('验证码 TTL 默认 5 分钟（02 §13 契约）', () => {
    expect(config.XINGLIAN_CODE_TTL_SECONDS).toBe(300);
  });
});
