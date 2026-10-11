/**
 * Ed25519 license JWT 签发/验签（todo 8 = T-M0-07，02-系统架构设计.md §9.5 时序 + §12.3 授权模型）。
 *
 * 设计要点：
 * - 与 token.service（HS256 access/refresh/authorization）分开：license 是独立信任锚
 *   （Ed25519 公钥内置客户端，验签完全离线，02 §12.3「吊销通过 jti 名单随配置下发」归 M5）。
 * - 不经 jsonwebtoken 的多算法分派，签名/验签用 node:crypto 直控：
 *   header.alg 严格白名单 === 'EdDSA'（拒绝 HS256/RS256/alg:none 等一切算法混淆，
 *   这是 license 验签的安全关键——混淆测试见 test/license.e2e.test.ts 与 desktop 侧单测）。
 * - header.typ === 'license'（typ 头区分 access/license）；payload.typ 亦为 'license'，双保险。
 * - claims：sub / plan / tier / device_limit / exp / device_hash / jti（02 §12.3 全集）。
 * - jti 每次签发随机（randomUUID）；M0 仅在审计中记录、不在线吊销（docs/adr/notes-license-m0.md §3）。
 * - exp 取会员期结束（membership.endsAt），到期即锁定（FR-1.6 的服务端侧）。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as edSign, verify as edVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import type { Plan, Tier } from '../generated/prisma/client.js';

/** server 根目录（src/license → apps/server；dist/license → apps/server，两条编译路径一致） */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** M0 固定测试密钥对的 kid；M5 轮换时按 kid 选钥（docs/adr/notes-license-m0.md §1） */
export const LICENSE_JWT_KID = 'm0-license-test-1';

export type LicenseClaims = Readonly<{
  sub: string;
  typ: 'license';
  plan: Plan;
  tier: Tier;
  device_limit: number;
  /** epoch 秒；= 会员期结束时间 */
  exp: number;
  /** 设备指纹哈希（sha256 hex，64 位）；'' = 未绑定（兑换时签发的待激活 license） */
  device_hash: string;
  jti: string;
}>;

export type SignLicenseInput = Readonly<{
  sub: string;
  plan: Plan;
  tier: Tier;
  deviceLimit: number;
  deviceHash: string;
  expiresAt: Date;
  jti?: string;
}>;

/** 验签失败的稳定原因（HTTP 401，error 字段；desktop 侧状态机复用同一套语义） */
export type LicenseRejectReason = 'LICENSE_MALFORMED' | 'LICENSE_ALG_REJECTED' | 'LICENSE_TYPE_REJECTED' | 'LICENSE_SIGNATURE_INVALID' | 'LICENSE_EXPIRED';

export class LicenseVerificationError extends UnauthorizedException {
  constructor(readonly reason: LicenseRejectReason) {
    super({ error: reason });
  }
}

const enc = (input: string | Buffer): string => Buffer.from(input).toString('base64url');
const dec = (input: string): string => Buffer.from(input, 'base64url').toString('utf8');

interface JwtHeader {
  alg: string;
  typ: string;
  kid?: string;
}

@Injectable()
export class LicenseSigningService {
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly publicKey: ReturnType<typeof createPublicKey>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const privatePath = this.resolve(config.XINGLIAN_LICENSE_PRIVATE_KEY_PATH);
    const publicPath = this.resolve(config.XINGLIAN_LICENSE_PUBLIC_KEY_PATH);
    const privatePem = this.readPem(privatePath);
    if (!privatePem) {
      if (config.NODE_ENV === 'production') {
        throw new Error(`license private key missing: ${privatePath}（生产必须显式提供，见 docs/adr/notes-license-m0.md §1）`);
      }
      // dev/test 兜底：文件缺失时生成临时密钥对（仅本进程有效，签名不会通过 desktop 内置公钥），
      // 保证不含 keys/ 的工作副本不因密钥缺失而起不来；license 链路测试一律显式提供密钥路径。
      console.warn(`[license] private key not found at ${privatePath}; using EPHEMERAL dev keypair (not trusted by desktop built-in public key)`);
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
      return;
    }
    this.privateKey = createPrivateKey(privatePem);
    const publicPem = this.readPem(publicPath);
    this.publicKey = publicPem ? createPublicKey(publicPem) : createPublicKey(this.privateKey);
  }

  /** 签发 license JWT；返回 token 与本次 jti（调用方写入审计 = M0 的「jti 仅记录」） */
  signLicense(input: SignLicenseInput): { token: string; jti: string } {
    const jti = input.jti ?? randomUUID();
    const header: JwtHeader = { alg: 'EdDSA', typ: 'license', kid: LICENSE_JWT_KID };
    const claims: LicenseClaims = {
      sub: input.sub,
      typ: 'license',
      plan: input.plan,
      tier: input.tier,
      device_limit: input.deviceLimit,
      exp: Math.floor(input.expiresAt.getTime() / 1000),
      device_hash: input.deviceHash,
      jti,
    };
    const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(claims))}`;
    const signature = edSign(null, Buffer.from(signingInput, 'utf8'), this.privateKey);
    return { token: `${signingInput}.${enc(signature)}`, jti };
  }

  /**
   * 严格验签（服务端在激活时重验客户端出示的 license）。失败抛 LicenseVerificationError（401）。
   * 顺序：结构 → header.alg 白名单 → header.typ → Ed25519 签名 → payload.typ → exp。
   */
  verifyLicense(token: string): LicenseClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new LicenseVerificationError('LICENSE_MALFORMED');
    const [rawHeader, rawPayload, rawSignature] = parts;

    let header: JwtHeader;
    try {
      header = JSON.parse(dec(rawHeader)) as JwtHeader;
    } catch {
      throw new LicenseVerificationError('LICENSE_MALFORMED');
    }
    // 算法混淆防线：只接受 EdDSA（Ed25519）。HS256（用公钥当 HMAC secret）、RS256、alg:none 全部在此拒绝。
    if (header.alg !== 'EdDSA') throw new LicenseVerificationError('LICENSE_ALG_REJECTED');
    if (header.typ !== 'license') throw new LicenseVerificationError('LICENSE_TYPE_REJECTED');

    let claims: LicenseClaims;
    try {
      claims = JSON.parse(dec(rawPayload)) as LicenseClaims;
    } catch {
      throw new LicenseVerificationError('LICENSE_MALFORMED');
    }
    let signatureOk: boolean;
    try {
      signatureOk = edVerify(null, Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8'), this.publicKey, Buffer.from(rawSignature, 'base64url'));
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) throw new LicenseVerificationError('LICENSE_SIGNATURE_INVALID');
    if (claims.typ !== 'license') throw new LicenseVerificationError('LICENSE_TYPE_REJECTED');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
      throw new LicenseVerificationError('LICENSE_EXPIRED');
    }
    return claims;
  }

  /** 供测试/e2e 交叉验签使用 */
  publicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  private resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.join(SERVER_ROOT, p);
  }

  private readPem(p: string): string | null {
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }
}
