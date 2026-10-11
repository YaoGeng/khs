/**
 * todo 8（T-M0-07）授权链路 e2e —— 05:72 门禁① 全流程：
 * 注册→生成卡→兑换（响应含 license JWT）→Ed25519 验签→设备绑定→第 2 台阻断（个人版）
 * →解绑→30 天限 1 次→篡改/过期/算法混淆（HS256/RS256/alg:none/typ 混淆）拒绝。
 *
 * 密钥：M0 固定测试密钥对（apps/server/keys/*.pem，scripts/license-keys.mjs 生成，
 * 权衡与 M5 轮换策略见 docs/adr/notes-license-m0.md §1）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createCard, createTestApp, deviceHashFor, login, registerUser, resetState } from './helpers.js';
import { PrismaService } from '../src/infrastructure/prisma.service.js';
import { LicenseSigningService, LICENSE_JWT_KID } from '../src/license/license-signing.service.js';

const REDEEM_URL = '/api/v1/cards/redeem';
const ACTIVATE_URL = '/api/v1/license/activate';
const UNBIND_URL = '/api/v1/devices/unbind';

const enc = (s: string): string => Buffer.from(s).toString('base64url');
const DAY_MS = 24 * 60 * 60 * 1000;

/** 用测试私钥手工构造 EdDSA license（typ 可指定——typ 混淆用例需要 typ:'access'） */
function craftEd25519Token(
  privateKeyPem: string,
  payload: Record<string, unknown>,
  header = { alg: 'EdDSA', typ: 'license', kid: LICENSE_JWT_KID },
): string {
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const signature = edSign(null, Buffer.from(signingInput, 'utf8'), createPrivateKey(privateKeyPem));
  return `${signingInput}.${enc(signature)}`;
}

describe('license 授权链路 e2e（门禁①：签发/验签/绑定/阻断/解绑/冷却/混淆拒绝）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let licenses: LicenseSigningService;
  let privatePem: string;
  let publicPem: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    licenses = app.get(LicenseSigningService);
    privatePem = readFileSync(new URL('../keys/license-private.pem', import.meta.url), 'utf8');
    publicPem = licenses.publicKeyPem();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
  });

  interface ChainFixture {
    email: string;
    userId: string;
    redeemRes: request.Response;
    unboundLicenseJwt: string;
  }

  /** 注册→生成卡→兑换（门禁①前三步） */
  async function redeemChain(email: string, tier: 'personal' | 'team' = 'personal', plan: 'month' | 'quarter' | 'year' = 'month'): Promise<ChainFixture> {
    const user = await registerUser(app, email);
    const code = await createCard(app, plan, tier);
    const redeemRes = await request(app.getHttpServer()).post(REDEEM_URL).send({ code, email });
    expect(redeemRes.status).toBe(200);
    const licenseJwt = redeemRes.body.licenseJwt as string;
    expect(typeof licenseJwt).toBe('string');
    return { email, userId: user.userId, redeemRes, unboundLicenseJwt: licenseJwt };
  }

  it('门禁①全链：兑换响应含 license JWT → 验签 → 激活设备① → 第 2 台阻断（个人版）', async () => {
    const { email, userId, unboundLicenseJwt } = await redeemChain('gate2@example.com');

    // 兑换签发的 license：header EdDSA/typ license + claims 全集（02 §12.3），device_hash=''（未绑定）
    const claims = licenses.verifyLicense(unboundLicenseJwt);
    expect(claims.sub).toBe(userId);
    expect(claims.typ).toBe('license');
    expect(claims.tier).toBe('personal');
    expect(claims.plan).toBe('month');
    expect(claims.device_limit).toBe(1);
    expect(claims.device_hash).toBe('');
    expect(claims.jti).toBeTruthy();
    const [h] = unboundLicenseJwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))).toEqual({
      alg: 'EdDSA',
      typ: 'license',
      kid: LICENSE_JWT_KID,
    });

    // 独立验签（测试进程持密钥交叉验证，模拟 desktop 离线验签姿态：只用公钥校 Ed25519）
    const [h2, p2, s2] = unboundLicenseJwt.split('.');
    const pubFromPrivate = createPublicKey(createPrivateKey(privatePem));
    expect(edVerify(null, Buffer.from(`${h2}.${p2}`, 'utf8'), pubFromPrivate, Buffer.from(s2, 'base64url'))).toBe(true);

    // 激活设备①：绑定 + 换发绑定版 license + 审计
    const hashA = deviceHashFor('device-A');
    const activateRes = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: unboundLicenseJwt, device_hash: hashA });
    expect(activateRes.status).toBe(200);
    const boundClaims = licenses.verifyLicense(activateRes.body.licenseJwt);
    expect(boundClaims.device_hash).toBe(hashA);
    expect(boundClaims.jti).not.toBe(claims.jti); // 换发 = 新 jti
    const deviceRow = await prisma.device.findUnique({
      where: { userId_deviceHash: { userId, deviceHash: hashA } },
    });
    expect(deviceRow?.revokedAt).toBeNull();
    const activateAudit = await prisma.auditLog.findFirst({ where: { actor: userId, action: 'license.activate' } });
    expect((activateAudit?.payloadJson as { jti?: string }).jti).toBe(boundClaims.jti);
    const issueAudit = await prisma.auditLog.findFirst({ where: { actor: userId, action: 'license.issue' } });
    expect((issueAudit?.payloadJson as { jti?: string }).jti).toBe(claims.jti);

    // 个人版第 2 台 → 409 阻断 + 审计 license.blocked（FR-1.4 / 门禁①验收口径）
    const hashB = deviceHashFor('device-B');
    const second = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: unboundLicenseJwt, device_hash: hashB });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('DEVICE_LIMIT_REACHED');
    const blockedAudit = await prisma.auditLog.findFirst({ where: { actor: userId, action: 'license.blocked' } });
    expect(blockedAudit).not.toBeNull();
    const deviceCount = await prisma.device.count({ where: { userId, revokedAt: null } });
    expect(deviceCount).toBe(1);
  });

  it('团队版 device_limit=3：第 3 台放行、第 4 台阻断（校验逻辑通用，验收以个人版为准）', async () => {
    const { email, unboundLicenseJwt } = await redeemChain('team3@example.com', 'team', 'year');
    for (const seed of ['t1', 't2', 't3']) {
      const res = await request(app.getHttpServer())
        .post(ACTIVATE_URL)
        .send({ email, licenseJwt: unboundLicenseJwt, device_hash: deviceHashFor(seed) });
      expect(res.status).toBe(200);
    }
    const fourth = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: unboundLicenseJwt, device_hash: deviceHashFor('t4') });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error).toBe('DEVICE_LIMIT_REACHED');
  });

  it('重复激活同一设备幂等（更新 lastSeenAt，不新增行、不触发上限）', async () => {
    const { email, userId, unboundLicenseJwt } = await redeemChain('again@example.com');
    const hash = deviceHashFor('same');
    const first = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: unboundLicenseJwt, device_hash: hash });
    expect(first.status).toBe(200);
    const again = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: unboundLicenseJwt, device_hash: hash });
    expect(again.status).toBe(200);
    expect(await prisma.device.count({ where: { userId } })).toBe(1);
  });

  it('解绑 → 30 天内再解绑被拒（冷却）→ 改库回拨 revokedAt 后放行（FR-1.5 配套语义）', async () => {
    const { email, userId, unboundLicenseJwt } = await redeemChain('unbind@example.com');
    const hashA = deviceHashFor('ua');
    await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: unboundLicenseJwt, device_hash: hashA });

    // 解绑成功（revokedAt 落库 + 审计）
    const unbindRes = await request(app.getHttpServer()).post(UNBIND_URL).send({ email, device_hash: hashA });
    expect(unbindRes.status).toBe(200);
    expect(unbindRes.body.ok).toBe(true);
    expect(typeof unbindRes.body.nextUnbindAllowedAt).toBe('string');
    const row = await prisma.device.findUnique({ where: { userId_deviceHash: { userId, deviceHash: hashA } } });
    expect(row?.revokedAt).not.toBeNull();

    // 重新绑定另一台后立刻再解绑 → 403 冷却（上次解绑时间戳 = 刚才那次）
    const hashC = deviceHashFor('uc');
    await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: unboundLicenseJwt, device_hash: hashC });
    const early = await request(app.getHttpServer()).post(UNBIND_URL).send({ email, device_hash: hashC });
    expect(early.status).toBe(403);
    expect(early.body.error).toBe('UNBIND_COOLDOWN');
    expect(early.body.retryAfterDays).toBe(30);
    const blockedAudit = await prisma.auditLog.findFirst({ where: { actor: userId, action: 'device.unbind.blocked' } });
    expect(blockedAudit).not.toBeNull();

    // 直接改 DB：把「已解绑」行的 revokedAt 回拨 31 天（只回拨已撤销行，别动激活中的设备）→ 冷却解除，再解绑成功
    await prisma.device.updateMany({
      where: { userId, revokedAt: { not: null } },
      data: { revokedAt: new Date(Date.now() - 31 * DAY_MS) },
    });
    const later = await request(app.getHttpServer()).post(UNBIND_URL).send({ email, device_hash: hashC });
    expect(later.status).toBe(200);
  });

  it('解绑边界：未知设备 404 / 已解绑重复 409 / 未知邮箱 404', async () => {
    const { email, unboundLicenseJwt } = await redeemChain('unbind-edge@example.com');
    const missing = await request(app.getHttpServer())
      .post(UNBIND_URL)
      .send({ email, device_hash: deviceHashFor('ghost') });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('DEVICE_NOT_FOUND');

    const hash = deviceHashFor('edge');
    await request(app.getHttpServer()).post(ACTIVATE_URL).send({ email, licenseJwt: unboundLicenseJwt, device_hash: hash });
    await request(app.getHttpServer()).post(UNBIND_URL).send({ email, device_hash: hash });
    const twice = await request(app.getHttpServer()).post(UNBIND_URL).send({ email, device_hash: hash });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('DEVICE_ALREADY_UNBOUND');

    const ghostUser = await request(app.getHttpServer())
      .post(UNBIND_URL)
      .send({ email: 'nobody@example.com', device_hash: hash });
    expect(ghostUser.status).toBe(404);
    expect(ghostUser.body.error).toBe('USER_NOT_FOUND');
  });

  it('篡改 license payload → 验签失败（激活 401 LICENSE_SIGNATURE_INVALID）', async () => {
    const { email, unboundLicenseJwt } = await redeemChain('tamper2@example.com');
    const [h, p, s] = unboundLicenseJwt.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { device_limit: number };
    claims.device_limit = 99; // 提权篡改
    const tampered = `${h}.${enc(JSON.stringify(claims))}.${s}`;
    const res = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: tampered, device_hash: deviceHashFor('x') });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('LICENSE_SIGNATURE_INVALID');
    expect(() => licenses.verifyLicense(tampered)).toThrow();
  });

  it('过期 license 拒绝（401 LICENSE_EXPIRED）', async () => {
    const user = await registerUser(app, 'expired@example.com');
    const expired = licenses.signLicense({
      sub: user.userId,
      plan: 'month',
      tier: 'personal',
      deviceLimit: 1,
      deviceHash: '',
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const res = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email: user.email, licenseJwt: expired.token, device_hash: deviceHashFor('e') });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('LICENSE_EXPIRED');
  });

  it('无会员用户激活（伪造有效签名 license）→ 403 MEMBERSHIP_INACTIVE', async () => {
    const user = await registerUser(app, 'nomember@example.com');
    const forgedValid = licenses.signLicense({
      sub: user.userId,
      plan: 'month',
      tier: 'personal',
      deviceLimit: 1,
      deviceHash: '',
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
    });
    const res = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email: user.email, licenseJwt: forgedValid.token, device_hash: deviceHashFor('n') });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MEMBERSHIP_INACTIVE');
  });

  it('绑定到其他设备的 license 在本机激活 → 403 DEVICE_MISMATCH', async () => {
    const { email, unboundLicenseJwt } = await redeemChain('mismatch@example.com');
    // 先在设备 X 激活得到绑定版 license
    const hashX = deviceHashFor('owner');
    const activated = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: unboundLicenseJwt, device_hash: hashX });
    const boundJwt = activated.body.licenseJwt as string;
    // 拿绑定版 license 到设备 Y 激活（个人版上限也会拦，但绑定校验先行）
    const res = await request(app.getHttpServer())
      .post(ACTIVATE_URL)
      .send({ email, licenseJwt: boundJwt, device_hash: deviceHashFor('other') });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DEVICE_MISMATCH');
  });

  describe('算法混淆（安全关键，拒绝断言）', () => {
    it('HS256 用「公钥当 HMAC secret」冒充 license → 401 LICENSE_ALG_REJECTED', async () => {
      const { email, unboundLicenseJwt } = await redeemChain('confuse-hs@example.com');
      const claims = JSON.parse(Buffer.from(unboundLicenseJwt.split('.')[1], 'base64url').toString('utf8'));
      claims.device_limit = 100;
      const evil = jwt.sign(claims, publicPem, { algorithm: 'HS256', header: { typ: 'license', kid: LICENSE_JWT_KID } });
      const res = await request(app.getHttpServer())
        .post(ACTIVATE_URL)
        .send({ email, licenseJwt: evil, device_hash: deviceHashFor('hs') });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('LICENSE_ALG_REJECTED');
    });

    it('alg:none（无签名）→ 401 LICENSE_ALG_REJECTED', async () => {
      const { email, unboundLicenseJwt } = await redeemChain('confuse-none@example.com');
      const claims = JSON.parse(Buffer.from(unboundLicenseJwt.split('.')[1], 'base64url').toString('utf8'));
      claims.device_limit = 100;
      const evil = `${enc(JSON.stringify({ alg: 'none', typ: 'license' }))}.${enc(JSON.stringify(claims))}.`;
      const res = await request(app.getHttpServer())
        .post(ACTIVATE_URL)
        .send({ email, licenseJwt: evil, device_hash: deviceHashFor('none') });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('LICENSE_ALG_REJECTED');
    });

    it('RS256（攻击者自造 RSA 密钥）→ 401 LICENSE_ALG_REJECTED', async () => {
      const { email, unboundLicenseJwt } = await redeemChain('confuse-rsa@example.com');
      const claims = JSON.parse(Buffer.from(unboundLicenseJwt.split('.')[1], 'base64url').toString('utf8'));
      claims.device_limit = 100;
      const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const evil = jwt.sign(claims, attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
        algorithm: 'RS256',
        header: { typ: 'license', kid: LICENSE_JWT_KID },
      });
      const res = await request(app.getHttpServer())
        .post(ACTIVATE_URL)
        .send({ email, licenseJwt: evil, device_hash: deviceHashFor('rsa') });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('LICENSE_ALG_REJECTED');
    });

    it('EdDSA 签名但 typ=access（access token 冒充 license）→ 401 LICENSE_TYPE_REJECTED', async () => {
      const { email } = await redeemChain('confuse-typ@example.com');
      const user = await prisma.user.findUnique({ where: { email } });
      const evil = craftEd25519Token(privatePem, {
        sub: user?.id,
        typ: 'access',
        plan: 'year',
        tier: 'personal',
        device_limit: 99,
        exp: Math.floor(Date.now() / 1000) + 3600,
        device_hash: '',
        jti: 'fake-typ',
      });
      const res = await request(app.getHttpServer())
        .post(ACTIVATE_URL)
        .send({ email, licenseJwt: evil, device_hash: deviceHashFor('typ') });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('LICENSE_TYPE_REJECTED');
    });

    it('登录 HS256 accessToken 冒充 license → 401 LICENSE_ALG_REJECTED', async () => {
      const user = await registerUser(app, 'confuse-login@example.com');
      const { body } = await login(app, user);
      const res = await request(app.getHttpServer())
        .post(ACTIVATE_URL)
        .send({ email: user.email, licenseJwt: body.accessToken, device_hash: deviceHashFor('login') });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('LICENSE_ALG_REJECTED');
    });

    it('结构损坏（缺段/非 JWT）→ 401 LICENSE_MALFORMED', async () => {
      const { email } = await redeemChain('malformed@example.com');
      for (const evil of ['not-a-jwt', 'a.b.c.d', `${'x'.repeat(30)}.`]) {
        const res = await request(app.getHttpServer())
          .post(ACTIVATE_URL)
          .send({ email, licenseJwt: evil, device_hash: deviceHashFor('m') });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('LICENSE_MALFORMED');
      }
    });

    it('非法入参（device_hash 非 64 位 hex）→ 400 VALIDATION_ERROR', async () => {
      const { email, unboundLicenseJwt } = await redeemChain('badhash@example.com');
      const res = await request(app.getHttpServer())
        .post(ACTIVATE_URL)
        .send({ email, licenseJwt: unboundLicenseJwt, device_hash: 'raw-fingerprint-not-hashed' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });
});
