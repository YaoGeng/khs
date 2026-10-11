import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { login, registerUser, resetState } from './helpers.js';
import { loginLockKey } from '../src/auth/redis-keys.js';
import { RedisService } from '../src/infrastructure/redis.service.js';
import { createTestApp } from './helpers.js';

const URL_BASE = '/api/v1/auth';

describe('auth e2e（supertest + embedded-postgres + ioredis-mock）', () => {
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

  describe('POST /auth/email-code + /auth/register（FR-1.1）', () => {
    it('注册成功：dev 传输返回 6 位验证码，注册 201', async () => {
      const codeRes = await request(app.getHttpServer())
        .post(`${URL_BASE}/email-code`)
        .send({ email: 'alice@example.com' });
      expect(codeRes.status).toBe(200);
      expect(codeRes.body.code).toMatch(/^\d{6}$/);

      const res = await request(app.getHttpServer())
        .post(`${URL_BASE}/register`)
        .send({ email: 'alice@example.com', password: 'Passw0rd123', code: codeRes.body.code });
      expect(res.status).toBe(201);
      expect(typeof res.body.userId).toBe('string');
      expect(res.body.userId.length).toBeGreaterThan(0);
    });

    it('验证码错误拒绝（400 EMAIL_CODE_INVALID）', async () => {
      await request(app.getHttpServer())
        .post(`${URL_BASE}/email-code`)
        .send({ email: 'bob@example.com' });
      const res = await request(app.getHttpServer())
        .post(`${URL_BASE}/register`)
        .send({ email: 'bob@example.com', password: 'Passw0rd123', code: '000000' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('EMAIL_CODE_INVALID');
    });

    it('弱密码拒绝（400 VALIDATION_ERROR：须 ≥8 位且含字母数字）', async () => {
      const res = await request(app.getHttpServer())
        .post(`${URL_BASE}/register`)
        .send({ email: 'weak@example.com', password: 'short1', code: '123456' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('邮箱重复注册拒绝（409 EMAIL_TAKEN）', async () => {
      await registerUser(app, 'dup@example.com');
      const codeRes = await request(app.getHttpServer())
        .post(`${URL_BASE}/email-code`)
        .send({ email: 'dup@example.com' });
      const res = await request(app.getHttpServer())
        .post(`${URL_BASE}/register`)
        .send({
          email: 'dup@example.com',
          password: 'Passw0rd123',
          code: (codeRes.body as { code: string }).code,
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('EMAIL_TAKEN');
    });
  });

  describe('POST /auth/login（FR-1.2：图形验证码 + 锁定）', () => {
    it('图形验证码错误拒绝（400 CAPTCHA_INVALID）', async () => {
      const user = await registerUser(app, 'cap@example.com');
      const { res } = await login(app, user, { captchaAnswer: '999' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CAPTCHA_INVALID');
    });

    it('密码错误拒绝（401 INVALID_CREDENTIALS，含剩余尝试数）', async () => {
      const user = await registerUser(app, 'pw@example.com');
      const { res, body } = await login(app, user, { password: 'WrongPass123' });
      expect(res.status).toBe(401);
      expect(body.error).toBe('INVALID_CREDENTIALS');
      expect(body.remainingAttempts).toBe(4);
    });

    it('错误密码 5 次后锁定：第 6 次返回 423 LOGIN_LOCKED（15 分钟）', async () => {
      const user = await registerUser(app, 'lock@example.com');
      for (let i = 0; i < 5; i++) {
        const { res, body } = await login(app, user, { password: 'WrongPass123' });
        expect(res.status).toBe(401);
        expect(body.error).toBe('INVALID_CREDENTIALS');
        expect(body.remainingAttempts).toBe(4 - i);
      }
      const redis = app.get(RedisService);
      expect(await redis.raw.ttl(loginLockKey(user.email))).toBeGreaterThan(0);

      const sixth = await login(app, user);
      expect(sixth.res.status).toBe(423);
      expect(sixth.body.error).toBe('LOGIN_LOCKED');
      expect(sixth.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(sixth.body.retryAfterSeconds).toBeLessThanOrEqual(900);
    });

    it('登录成功：accessToken 解出 sub；未兑换时 claims 不含会员字段', async () => {
      const user = await registerUser(app, 'ok@example.com');
      const { res, body } = await login(app, user);
      expect(res.status).toBe(200);
      expect(typeof body.accessToken).toBe('string');
      expect(typeof body.refreshToken).toBe('string');
      expect(body.user.email).toBe(user.email);
      expect(body.membership).toBeNull();

      const claims = jwt.decode(body.accessToken);
      if (claims === null || typeof claims === 'string') throw new Error('token 未解出');
      expect(claims['sub']).toBe(user.userId);
      expect(claims['typ']).toBe('access');
      expect(claims['plan']).toBeUndefined();
      expect(claims['tier']).toBeUndefined();
    });

    it('连续失败后正确密码可恢复（计数被清零）', async () => {
      const user = await registerUser(app, 'recover@example.com');
      await login(app, user, { password: 'WrongPass123' });
      await login(app, user, { password: 'WrongPass123' });
      const { res } = await login(app, user);
      expect(res.status).toBe(200);
      const { res: resAgain } = await login(app, user, { password: 'WrongPass123' });
      expect(resAgain.status).toBe(401);
      expect((resAgain.body as { remainingAttempts: number }).remainingAttempts).toBe(4);
    });
  });

  describe('POST /auth/refresh（旋转）', () => {
    it('刷新成功：新 access 有效、refresh 轮换', async () => {
      const user = await registerUser(app, 'refresh@example.com');
      const { body } = await login(app, user);
      const res = await request(app.getHttpServer())
        .post(`${URL_BASE}/refresh`)
        .send({ refreshToken: body.refreshToken });
      expect(res.status).toBe(200);
      const claims = jwt.decode(res.body.accessToken);
      if (claims === null || typeof claims === 'string') throw new Error('token 未解出');
      expect(claims['sub']).toBe(user.userId);
      expect(res.body.refreshToken).not.toBe(body.refreshToken);
    });

    it('篡改的 refresh 拒绝（401 TOKEN_INVALID）', async () => {
      const user = await registerUser(app, 'tamper@example.com');
      const { body } = await login(app, user);
      const bad = body.refreshToken.slice(0, -3) + 'aaa';
      const res = await request(app.getHttpServer())
        .post(`${URL_BASE}/refresh`)
        .send({ refreshToken: bad });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('TOKEN_INVALID');
    });

    it('access token 不能当 refresh 用（typ 不符，401）', async () => {
      const user = await registerUser(app, 'typeconf@example.com');
      const { body } = await login(app, user);
      const res = await request(app.getHttpServer())
        .post(`${URL_BASE}/refresh`)
        .send({ refreshToken: body.accessToken });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('TOKEN_INVALID');
    });
  });
});
