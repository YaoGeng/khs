import { Inject, Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { RedisService } from '../infrastructure/redis.service.js';
import { captchaKey } from './redis-keys.js';

export type CaptchaChallenge = Readonly<{ captchaId: string; svg: string }>;
export type ArithmeticQuestion = Readonly<{ question: string; answer: number }>;

/** 服务端生成随机算式（如 "7 + 5 = ?"）；保证结果非负。 */
export function randomArithmetic(): ArithmeticQuestion {
  const a = randomInt(2, 10);
  const b = randomInt(2, 10);
  const op: '+' | '-' = randomInt(0, 2) === 0 ? '+' : '-';
  const left = op === '-' && b > a ? b : a;
  const right = op === '-' && b > a ? a : b;
  const answer = op === '+' ? left + right : left - right;
  return { question: `${left} ${op} ${right} = ?`, answer };
}

const escapeSvgText = (ch: string): string =>
  ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;

/** 纯手写 SVG 模板（不引额外依赖）：逐字符轻旋转/位移，足以脱离机器自动人眼识别；答案只存 Redis，不进 SVG。 */
export function renderCaptchaSvg(question: string): string {
  const chars = [...question];
  const texts = chars.map((ch, i) => {
    const rotate = ((ch.charCodeAt(0) * (i + 7)) % 21) - 10;
    const x = 22 + i * 20;
    const y = 42 + (((ch.charCodeAt(0) + i * 13) % 9) - 4);
    return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" font-size="26" font-family="monospace" fill="#e5e7eb">${escapeSvgText(ch)}</text>`;
  });
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="64" viewBox="0 0 200 64">',
    '<rect width="200" height="64" fill="#111827"/>',
    ...texts,
    '</svg>',
  ].join('');
}

@Injectable()
export class CaptchaService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {
    this.ttlSeconds = config.XINGLIAN_CODE_TTL_SECONDS;
  }

  async create(): Promise<CaptchaChallenge> {
    const { question, answer } = randomArithmetic();
    const captchaId = randomUUID();
    await this.redis.setWithTtl(captchaKey(captchaId), String(answer), this.ttlSeconds);
    return { captchaId, svg: renderCaptchaSvg(question) };
  }

  /** 一次性校验：无论对错都消费，防止对同一题重复试答案。 */
  async verify(captchaId: string, answer: string): Promise<boolean> {
    const key = captchaKey(captchaId);
    const expected = await this.redis.get(key);
    await this.redis.del(key);
    return expected !== null && expected === answer.trim();
  }
}
