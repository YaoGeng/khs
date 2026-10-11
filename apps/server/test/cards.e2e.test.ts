import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createCard, createTestApp, registerUser, resetState } from './helpers.js';
import { PrismaService } from '../src/infrastructure/prisma.service.js';

const REDEEM_URL = '/api/v1/cards/redeem';

describe('cards e2e（D9 最小兑换：注册→生成卡→兑换）', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
  });

  it('兑换成功：membership 入账 + 授权 JWT claims（sub/plan/tier/device_limit）+ 审计留痕', async () => {
    const user = await registerUser(app, 'redeem@example.com');
    const code = await createCard(app, 'month', 'personal');

    const res = await request(app.getHttpServer())
      .post(REDEEM_URL)
      .send({ code, email: user.email });
    expect(res.status).toBe(200);
    expect(res.body.membership.plan).toBe('month');
    expect(res.body.membership.tier).toBe('personal');
    expect(res.body.membership.deviceLimit).toBe(1);

    const claims = jwt.decode(res.body.authorizationJwt);
    if (claims === null || typeof claims === 'string') throw new Error('token 未解出');
    expect(claims['sub']).toBe(user.userId);
    expect(claims['plan']).toBe('month');
    expect(claims['tier']).toBe('personal');
    expect(claims['device_limit']).toBe(1);
    expect(claims['typ']).toBe('authorization');

    const cardRow = await prisma.card.findFirst({ where: { plan: 'month' } });
    expect(cardRow?.status).toBe('redeemed');
    expect(cardRow?.redeemedBy).toBe(user.userId);
    expect(cardRow?.redeemedAt).not.toBeNull();

    const membershipRow = await prisma.membership.findFirst({ where: { userId: user.userId } });
    expect(membershipRow?.source).toBe('card');
    expect(membershipRow?.deviceLimit).toBe(1);

    const auditRow = await prisma.auditLog.findFirst({
      where: { actor: user.userId, action: 'card.redeem' },
    });
    expect(auditRow?.action).toBe('card.redeem');
    expect((auditRow?.payloadJson as { cardId?: string }).cardId).toBe(cardRow?.id);
  });

  it('团队版卡：device_limit=3（02 §12.3 tier 映射）', async () => {
    const user = await registerUser(app, 'team@example.com');
    const code = await createCard(app, 'year', 'team');
    const res = await request(app.getHttpServer())
      .post(REDEEM_URL)
      .send({ code, email: user.email });
    expect(res.status).toBe(200);
    expect(res.body.membership.deviceLimit).toBe(3);
    const claims = jwt.decode(res.body.authorizationJwt);
    if (claims === null || typeof claims === 'string') throw new Error('token 未解出');
    expect(claims['device_limit']).toBe(3);
    expect(claims['plan']).toBe('year');
  });

  it('同码二次兑换拒绝（409 CARD_ALREADY_REDEEMED）', async () => {
    const user = await registerUser(app, 'twice@example.com');
    const code = await createCard(app);
    const first = await request(app.getHttpServer()).post(REDEEM_URL).send({ code, email: user.email });
    expect(first.status).toBe(200);
    const second = await request(app.getHttpServer()).post(REDEEM_URL).send({ code, email: user.email });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('CARD_ALREADY_REDEEMED');
  });

  it('并发同码兑换：恰好一次成功，其余 409（防重放）', async () => {
    const user = await registerUser(app, 'concurrent@example.com');
    const code = await createCard(app);
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        request(app.getHttpServer()).post(REDEEM_URL).send({ code, email: user.email }),
      ),
    );
    const statuses = attempts.map((r) => (r.status === 'fulfilled' ? r.value.status : 599));
    const okCount = statuses.filter((s) => s === 200).length;
    const conflictCount = statuses.filter((s) => s === 409).length;
    expect(okCount).toBe(1);
    expect(conflictCount).toBe(3);

    const memberships = await prisma.membership.findMany({ where: { userId: user.userId } });
    expect(memberships.length).toBe(1);
  });

  it('未知码拒绝（404 CARD_NOT_FOUND）', async () => {
    const user = await registerUser(app, 'unknown@example.com');
    const res = await request(app.getHttpServer())
      .post(REDEEM_URL)
      .send({ code: 'XXXX-XXXX-XXXX-XXXX', email: user.email });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CARD_NOT_FOUND');
  });

  it('篡改码（改动 1 字符）拒绝（404）', async () => {
    const user = await registerUser(app, 'tamper@example.com');
    const code = await createCard(app);
    const last = code.slice(-1);
    const tampered = code.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    const res = await request(app.getHttpServer())
      .post(REDEEM_URL)
      .send({ code: tampered, email: user.email });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CARD_NOT_FOUND');
  });

  it('未注册邮箱拒绝（404 USER_NOT_FOUND）', async () => {
    const code = await createCard(app);
    const res = await request(app.getHttpServer())
      .post(REDEEM_URL)
      .send({ code, email: 'ghost@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('USER_NOT_FOUND');
    const cardRow = await prisma.card.findFirst({});
    expect(cardRow?.status).toBe('unused');
  });

  it('非法入参拒绝（400 VALIDATION_ERROR）', async () => {
    const res = await request(app.getHttpServer())
      .post(REDEEM_URL)
      .send({ code: 'short', email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('小写输入码归一化后可兑换（Crockford 大写契约）', async () => {
    const user = await registerUser(app, 'lower@example.com');
    const code = await createCard(app);
    const res = await request(app.getHttpServer())
      .post(REDEEM_URL)
      .send({ code: code.toLowerCase(), email: user.email });
    expect(res.status).toBe(200);
  });
});
