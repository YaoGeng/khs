import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createCard, createTestApp, login, registerUser, resetState } from './helpers.js';

/**
 * 05:72 门禁① 的 M0 最小链路：注册→生成卡→兑换→登录→JWT 解出 tier/device_limit。
 * （签发 Ed25519 license、第 2 台阻断属 todo 8 / T-M0-07，此处只验证兑换与登录 claims。）
 */
describe('门禁①最小链路（注册→兑换→登录→claims）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
  });

  it('注册→生成卡→兑换→登录→JWT 解出 tier/device_limit', async () => {
    // ① 注册（dev 传输返回验证码）
    const email = 'gate@example.com';
    const codeRes = await request(app.getHttpServer())
      .post('/api/v1/auth/email-code')
      .send({ email });
    expect(codeRes.status).toBe(200);
    const registerRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Passw0rd123', code: codeRes.body.code });
    expect(registerRes.status).toBe(201);
    const userId = registerRes.body.userId as string;

    // ② 生成卡（等价 scripts/gen-card.mjs 的产物入库）
    const code = await createCard(app, 'quarter', 'personal');

    // ③ 兑换（code+email 绑定）
    const redeemRes = await request(app.getHttpServer())
      .post('/api/v1/cards/redeem')
      .send({ code, email });
    expect(redeemRes.status).toBe(200);
    const redeemClaims = jwt.decode(redeemRes.body.authorizationJwt);
    if (redeemClaims === null || typeof redeemClaims === 'string') throw new Error('token 未解出');
    expect(redeemClaims['sub']).toBe(userId);

    // ④ 登录 → JWT 解出 tier/device_limit
    const user = { email, password: 'Passw0rd123', userId };
    const { res, body } = await login(app, user);
    expect(res.status).toBe(200);
    const claims = jwt.decode(body.accessToken);
    if (claims === null || typeof claims === 'string') throw new Error('token 未解出');
    expect(claims['tier']).toBe('personal');
    expect(claims['device_limit']).toBe(1);
    expect(claims['plan']).toBe('quarter');
    expect(body.membership?.endsAt).toBeTruthy();
  });

  it('兑换后 refresh 仍携带会员 claims', async () => {
    const email = 'gate-refresh@example.com';
    const user = await registerUser(app, email);
    const code = await createCard(app, 'year', 'team');
    await request(app.getHttpServer()).post('/api/v1/cards/redeem').send({ code, email });

    const { body } = await login(app, user);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: body.refreshToken });
    expect(res.status).toBe(200);
    const claims = jwt.decode(res.body.accessToken);
    if (claims === null || typeof claims === 'string') throw new Error('token 未解出');
    expect(claims['tier']).toBe('team');
    expect(claims['device_limit']).toBe(3);
    expect(claims['plan']).toBe('year');
  });
});
