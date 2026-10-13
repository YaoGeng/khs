import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import type { LoginResult } from '../src/auth/auth.service.js';
import { PrismaService } from '../src/infrastructure/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis.service.js';
import type { Plan, Tier } from '../src/generated/prisma/client.js';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

/** 测试间清库清缓存（fileParallelism=false，单 PG 实例顺序消费）。 */
export async function resetState(app: INestApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.alert.deleteMany();
  await prisma.telemetryEvent.deleteMany();
  await prisma.device.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.card.deleteMany();
  await prisma.user.deleteMany();
  const redis = app.get(RedisService);
  await redis.raw.flushall();
}

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

/** 与 scripts/gen-card.mjs 的 codeHash 契约一致：sha256(明文码)。 */
export async function createCard(
  app: INestApplication,
  plan: Plan = 'month',
  tier: Tier = 'personal',
): Promise<string> {
  const code = `XLM0-TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}-CARD`;
  const prisma = app.get(PrismaService);
  await prisma.card.create({ data: { codeHash: sha256Hex(code), plan, tier } });
  return code;
}

export interface RegisteredUser {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
}

/** todo 8（T-M0-07）：测试用设备指纹哈希——sha256(seed) hex 64 位（契约与真实客户端一致：仅哈希上行）。 */
export function deviceHashFor(seed: string): string {
  return sha256Hex(`device:${seed}`);
}

/** 注册流程（dev 传输：email-code 随响应返回验证码）。 */
export async function registerUser(
  app: INestApplication,
  email: string,
  password = 'Passw0rd123',
): Promise<RegisteredUser> {
  const codeRes = await request(app.getHttpServer())
    .post('/api/v1/auth/email-code')
    .send({ email });
  const code = codeRes.body.code as string;
  const regRes = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password, code });
  return { email, password, userId: regRes.body.userId as string };
}

/** 登录流程：图形验证码答案按 QA 约定直读 Redis（dev 环境许可，见 docs/adr/notes-dev-transports.md）。 */
export async function login(
  app: INestApplication,
  user: RegisteredUser,
  overrides?: Partial<{ captchaAnswer: string; password: string }>,
): Promise<{ res: request.Response; body: LoginResult & { error?: string } }> {
  const captchaRes = await request(app.getHttpServer()).post('/api/v1/auth/captcha');
  const { captchaId } = captchaRes.body as { captchaId: string };
  let captchaAnswer = overrides?.captchaAnswer;
  if (captchaAnswer === undefined) {
    const redis = app.get(RedisService);
    captchaAnswer = (await redis.raw.get(`m0:captcha:${captchaId}`)) ?? '??';
  }
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({
    email: user.email,
    password: overrides?.password ?? user.password,
    captchaId,
    captchaAnswer,
  });
  return { res, body: res.body as LoginResult & { error?: string } };
}
