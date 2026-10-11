/**
 * license-manager 纯逻辑单测（todo 8 验收核心）：
 * - 离线验签：happy / 篡改 payload / 过期 / 算法混淆（HS256 公钥当 secret、RS256、alg:none、typ 混淆）/ 损坏结构
 * - 72h 宽限 + 锁定状态机：无 license / 宽限内 / 宽限边界（72h 整点即锁）/ exp 边界 / 损坏 lastVerifiedAt
 * - envelope 持久化 roundtrip
 * 验签用临时 Ed25519 密钥对（不依赖内置公钥；内置公钥与 server 测试密钥对的一致性由 e2e 验证）。
 */
import { describe, expect, it } from 'vitest';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  sign as edSign,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  computeLicenseStatus,
  fingerprintHash,
  LICENSE_GRACE_HOURS,
  loadEnvelope,
  saveEnvelope,
  verifyLicenseJwt,
  type LicenseEnvelope,
} from './license-manager';

const HOUR_MS = 60 * 60 * 1000;

/* ---------- 测试侧 JWT 工具（独立实现，模拟签发方） ---------- */

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

const pair = generateKeyPairSync('ed25519');
const PRIVATE_PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signLicense(
  payload: Record<string, unknown>,
  options?: { header?: Record<string, unknown>; keyPem?: string },
): string {
  const header = options?.header ?? { alg: 'EdDSA', typ: 'license', kid: 'test-1' };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const signature = edSign(null, Buffer.from(signingInput, 'utf8'), createPrivateKey(asString(options?.keyPem ?? PRIVATE_PEM)));
  return `${signingInput}.${signature.toString('base64url')}`;
}

function claimsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-1',
    typ: 'license',
    plan: 'month',
    tier: 'personal',
    device_limit: 1,
    exp: Math.floor(Date.now() / 1000) + 31 * 24 * 3600,
    device_hash: '',
    jti: 'jti-1',
    ...overrides,
  };
}

const asString = (value: string | Buffer): string => value.toString('utf8');

/* ---------- 验签 ---------- */

describe('verifyLicenseJwt（离线 Ed25519 验签）', () => {
  it('happy：合法 license 通过并解出 claims', () => {
    const token = signLicense(claimsFor());
    const result = verifyLicenseJwt(token, PUBLIC_PEM);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('user-1');
      expect(result.claims.plan).toBe('month');
      expect(result.claims.tier).toBe('personal');
      expect(result.claims.device_limit).toBe(1);
      expect(result.claims.device_hash).toBe('');
    }
  });

  it('篡改 payload（提权 device_limit）→ SIGNATURE_INVALID', () => {
    const token = signLicense(claimsFor({ device_limit: 99 }));
    const [h, , s] = token.split('.');
    const forgedPayload = enc(JSON.stringify(claimsFor({ device_limit: 99, jti: 'jti-2' })));
    const tampered = `${h}.${forgedPayload}.${s}`;
    expect(verifyLicenseJwt(tampered, PUBLIC_PEM)).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
  });

  it('换签名不换 payload / 换 payload 不换签名 均失败', () => {
    const tokenA = signLicense(claimsFor());
    const tokenB = signLicense(claimsFor({ sub: 'user-2' }));
    const spliced = `${tokenA.split('.')[0]}.${tokenA.split('.')[1]}.${tokenB.split('.')[2]}`;
    expect(verifyLicenseJwt(spliced, PUBLIC_PEM).ok).toBe(false);
  });

  it('过期（exp < now）→ EXPIRED；exp 整点=now 即过期', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const past = verifyLicenseJwt(signLicense(claimsFor({ exp: nowSec - 1 })), PUBLIC_PEM);
    expect(past).toEqual({ ok: false, reason: 'EXPIRED' });
    const boundary = verifyLicenseJwt(
      signLicense(claimsFor({ exp: nowSec })),
      PUBLIC_PEM,
      new Date(nowSec * 1000 + 900),
    );
    expect(boundary).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('exp 非数字 → EXPIRED（不信任未经验签语义的字段类型）', () => {
    const token = signLicense(claimsFor({ exp: 'soon' }));
    expect(verifyLicenseJwt(token, PUBLIC_PEM)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  describe('算法混淆（安全关键，不得跳过）', () => {
    it('HS256（公钥当 HMAC secret）→ ALG_REJECTED', () => {
      const header = enc(JSON.stringify({ alg: 'HS256', typ: 'license', kid: 'test-1' }));
      const payload = enc(JSON.stringify(claimsFor({ device_limit: 99 })));
      const signature = createHmac('sha256', PUBLIC_PEM).update(`${header}.${payload}`).digest('base64url');
      const evil = `${header}.${payload}.${signature}`;
      expect(verifyLicenseJwt(evil, PUBLIC_PEM)).toEqual({ ok: false, reason: 'ALG_REJECTED' });
    });

    it('RS256（攻击者 RSA 密钥重签）→ ALG_REJECTED', () => {
      const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const header = enc(JSON.stringify({ alg: 'RS256', typ: 'license', kid: 'test-1' }));
      const payload = enc(JSON.stringify(claimsFor({ device_limit: 99 })));
      const signature = createSign('sha256')
        .update(`${header}.${payload}`)
        .sign(attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
        .toString('base64url');
      const evil = `${header}.${payload}.${signature}`;
      expect(verifyLicenseJwt(evil, PUBLIC_PEM)).toEqual({ ok: false, reason: 'ALG_REJECTED' });
    });

    it('alg:none（空签名）→ ALG_REJECTED', () => {
      const evil = `${enc(JSON.stringify({ alg: 'none', typ: 'license' }))}.${enc(JSON.stringify(claimsFor({ device_limit: 99 })))}.`;
      expect(verifyLicenseJwt(evil, PUBLIC_PEM)).toEqual({ ok: false, reason: 'ALG_REJECTED' });
    });

    it('EdDSA 签名但 typ=access（access token 冒充 license）→ TYPE_REJECTED', () => {
      const evil = signLicense(claimsFor(), { header: { alg: 'EdDSA', typ: 'access' } });
      expect(verifyLicenseJwt(evil, PUBLIC_PEM)).toEqual({ ok: false, reason: 'TYPE_REJECTED' });
    });

    it('EdDSA 签名但 payload.typ=access → TYPE_REJECTED', () => {
      const evil = signLicense(claimsFor({ typ: 'access' }));
      expect(verifyLicenseJwt(evil, PUBLIC_PEM)).toEqual({ ok: false, reason: 'TYPE_REJECTED' });
    });

    it('用其他 Ed25519 密钥对签名 → SIGNATURE_INVALID（信任锚不匹配）', () => {
      const other = generateKeyPairSync('ed25519');
      const evil = signLicense(claimsFor({ device_limit: 99 }), {
        keyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      });
      expect(verifyLicenseJwt(evil, PUBLIC_PEM)).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    });
  });

  it('损坏结构（非三段 / 非 base64url / 非 JSON）→ MALFORMED', () => {
    expect(verifyLicenseJwt('not-a-jwt', PUBLIC_PEM).ok).toBe(false);
    expect(verifyLicenseJwt('a.b', PUBLIC_PEM).ok).toBe(false);
    expect(verifyLicenseJwt('!!!.???...', PUBLIC_PEM).ok).toBe(false);
    const garbage = `${enc('not-json')}.${enc('not-json')}.${enc('sig')}`;
    expect(verifyLicenseJwt(garbage, PUBLIC_PEM)).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

/* ---------- 72h 宽限 + 锁定状态机 ---------- */

const NOW = new Date('2026-10-11T10:00:00.000Z');

function envelopeFor(licenseJwt: string, lastVerifiedAt: string): LicenseEnvelope {
  return { licenseJwt, lastVerifiedAt, deviceHash: 'a'.repeat(64) };
}

function statusOf(
  input: Partial<Parameters<typeof computeLicenseStatus>[0]> & { now?: Date; envelope?: LicenseEnvelope | null },
) {
  return computeLicenseStatus({
    // 注意：'in' 判定而非 ??（?? 会把显式 null 视为缺省，吞掉「无 license」用例）
    envelope: 'envelope' in input ? (input.envelope ?? null) : envelopeFor(signLicense(claimsFor()), NOW.toISOString()),
    publicKeyPem: PUBLIC_PEM,
    now: input.now ?? NOW,
    graceHours: input.graceHours,
    localDeviceHash: 'a'.repeat(64),
  });
}

describe('computeLicenseStatus（锁定状态机 / FR-1.5、FR-1.6）', () => {
  it('无 license / 空 envelope → locked NO_LICENSE', () => {
    expect(statusOf({ envelope: null })).toEqual({ state: 'locked', reason: 'NO_LICENSE', deviceHash: 'a'.repeat(64) });
    expect(statusOf({ envelope: { licenseJwt: '', lastVerifiedAt: NOW.toISOString(), deviceHash: '' } }).reason).toBe('NO_LICENSE');
  });

  it('宽限内（激活后 1h）→ unlocked WITHIN_GRACE，回显套餐/到期/宽限窗', () => {
    const status = statusOf({ envelope: envelopeFor(signLicense(claimsFor()), new Date(NOW.getTime() - 1 * HOUR_MS).toISOString()) });
    expect(status.state).toBe('unlocked');
    expect(status.reason).toBe('WITHIN_GRACE');
    expect(status.plan).toBe('month');
    expect(status.tier).toBe('personal');
    expect(status.deviceLimit).toBe(1);
    expect(status.graceEndsAt).toBeTruthy();
    expect(new Date(status.lastVerifiedAt ?? '').getTime()).toBeLessThan(NOW.getTime());
  });

  it('宽限边界：71h59m59s 解锁；72h 整点锁定（FR-1.5）', () => {
    const last = new Date(NOW.getTime() - LICENSE_GRACE_HOURS * HOUR_MS).toISOString();
    const justInside = statusOf({ envelope: envelopeFor(signLicense(claimsFor()), last), now: new Date(NOW.getTime() - 1) });
    expect(justInside.state).toBe('unlocked');
    const atBoundary = statusOf({ envelope: envelopeFor(signLicense(claimsFor()), last) });
    expect(atBoundary.state).toBe('locked');
    expect(atBoundary.reason).toBe('GRACE_EXCEEDED');
  });

  it('73h → locked GRACE_EXCEEDED（超期锁定，FR-1.5）', () => {
    const status = statusOf({
      envelope: envelopeFor(signLicense(claimsFor()), new Date(NOW.getTime() - 73 * HOUR_MS).toISOString()),
    });
    expect(status).toMatchObject({ state: 'locked', reason: 'GRACE_EXCEEDED' });
    expect(status.graceEndsAt).toBeTruthy();
  });

  it('license 过期 → locked EXPIRED（即便宽限窗未满，FR-1.6）', () => {
    const status = statusOf({
      envelope: envelopeFor(signLicense(claimsFor({ exp: Math.floor(NOW.getTime() / 1000) - 3600 })), NOW.toISOString()),
    });
    expect(status).toMatchObject({ state: 'locked', reason: 'EXPIRED' });
  });

  it('验签失败的 envelope → locked（篡改/混淆在状态机同样锁定）', () => {
    const evil = `${enc(JSON.stringify({ alg: 'none', typ: 'license' }))}.${enc(JSON.stringify(claimsFor()))}.`;
    expect(statusOf({ envelope: envelopeFor(evil, NOW.toISOString()) })).toMatchObject({
      state: 'locked',
      reason: 'ALG_REJECTED',
    });
  });

  it('lastVerifiedAt 损坏 → locked NO_VERIFICATION（不误放行）', () => {
    const status = statusOf({ envelope: envelopeFor(signLicense(claimsFor()), 'not-a-date') });
    expect(status).toMatchObject({ state: 'locked', reason: 'NO_VERIFICATION' });
  });

  it('宽限期可注入（graceHours 参数化，供单测/未来策略调整）', () => {
    const status = statusOf({
      envelope: envelopeFor(signLicense(claimsFor()), new Date(NOW.getTime() - 5 * HOUR_MS).toISOString()),
      graceHours: 4,
    });
    expect(status).toMatchObject({ state: 'locked', reason: 'GRACE_EXCEEDED' });
  });
});

/* ---------- envelope 持久化 ---------- */

describe('envelope 持久化（license 文件）', () => {
  it('save → load roundtrip；损坏 JSON → null（按无 license 处理，不抛错）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'license-'));
    try {
      const file = path.join(dir, 'nested', 'license.json');
      const envelope = envelopeFor('token-abc', NOW.toISOString());
      saveEnvelope(file, envelope);
      expect(loadEnvelope(file)).toEqual(envelope);
      writeFileSync(file, '{broken', 'utf8');
      expect(loadEnvelope(file)).toBeNull();
      expect(loadEnvelope(path.join(dir, 'missing.json'))).toBeNull();
      // 文件内容确实落盘（JSON 文本）
      expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺字段的 JSON → null（schema 校验拒绝半损坏 envelope）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'license-'));
    try {
      const file = path.join(dir, 'license.json');
      writeFileSync(file, JSON.stringify({ licenseJwt: 'x' }), 'utf8');
      expect(loadEnvelope(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ---------- 设备指纹 ---------- */

describe('fingerprintHash（设备指纹仅存哈希，02 §11.4）', () => {
  it('输出 sha256 hex 64 位', () => {
    const hash = fingerprintHash({ hostname: 'DESKTOP-ABC', cpuModel: 'Intel i7', mac: 'AA-BB-CC-DD-EE-FF' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('相同输入 → 稳定输出（重激活幂等的前提）', () => {
    const a = fingerprintHash({ hostname: 'PC1', cpuModel: 'X', mac: 'M' });
    const b = fingerprintHash({ hostname: 'PC1', cpuModel: 'X', mac: 'M' });
    expect(a).toBe(b);
  });

  it('规范化：大小写/首尾空白不改变哈希（M0 弱化口径的宽容性）', () => {
    const a = fingerprintHash({ hostname: ' PC1 ', cpuModel: 'x', mac: 'm' });
    const b = fingerprintHash({ hostname: 'pc1', cpuModel: 'X', mac: 'M' });
    expect(a).toBe(b);
  });

  it('任一输入变化 → 哈希变化（绑定语义）', () => {
    const base = fingerprintHash({ hostname: 'PC1', cpuModel: 'X', mac: 'M' });
    expect(fingerprintHash({ hostname: 'PC2', cpuModel: 'X', mac: 'M' })).not.toBe(base);
    expect(fingerprintHash({ hostname: 'PC1', cpuModel: 'Y', mac: 'M' })).not.toBe(base);
    expect(fingerprintHash({ hostname: 'PC1', cpuModel: 'X', mac: 'N' })).not.toBe(base);
  });

  it('与手算 sha256 规范化拼接一致（算法契约锁定）', () => {
    const hash = fingerprintHash({ hostname: 'PC1', cpuModel: 'X', mac: 'M' });
    expect(hash).toBe(
      createHash('sha256').update(['pc1', 'x', 'm'].join('\n'), 'utf8').digest('hex'),
    );
  });
});
