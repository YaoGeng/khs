/**
 * license-manager（todo 8 = T-M0-07；main 进程模块，渲染进程不可见）。
 *
 * 职责（01-需求说明书.md FR-1.4/1.5/1.6、02-系统架构设计.md §9.5/§12.3）：
 * - 离线验签：node:crypto Ed25519（header.alg 严格白名单 'EdDSA'——算法混淆防线；
 *   header.typ/payload.typ 必须 'license'）；公钥内置（public-key.ts）。
 * - 72h 离线宽限：以 envelope.last_verified_at 起算，宽限期内工作流可用，超期锁定（FR-1.5）。
 * - 到期锁定状态机：无 license / 验签失败 / exp 过期 / 宽限超期 → locked（FR-1.6）；
 *   锁定只锁工作流写入口，logs/settings/report 路由保持可达（renderer 按 state 渲染）。
 * - license 文件持久化：userData 目录 JSON envelope（路径可经 XINGLIAN_LICENSE_FILE 覆盖，dev/test seam）。
 *
 * M0 边界（docs/adr/notes-license-m0.md §2/§3）：
 * - 激活走本地注入路径（不联网签发）；真机联网激活流归 M5。
 * - last_verified_at 仅在激活/离线验签成功时推进；M0 无在线复验触发器，
 *   故宽限窗从激活时间起算（M5 接入周期性在线验签后按服务端口径推进）。
 * - jti 在线吊销归 M5 配置中心；客户端 M0 不查吊销名单。
 *
 * 本文件不 import electron（纯 node），vitest 直接单测。
 */
import { createHash } from 'node:crypto';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** FR-1.5：72h 离线宽限 */
export const LICENSE_GRACE_HOURS = 72;

export interface LicenseClaims {
  sub: string;
  typ: string;
  plan: string;
  tier: string;
  device_limit: number;
  exp: number;
  device_hash: string;
  jti: string;
}

export type VerifyRejectReason =
  | 'MALFORMED'
  | 'ALG_REJECTED'
  | 'TYPE_REJECTED'
  | 'SIGNATURE_INVALID'
  | 'EXPIRED';

export type VerifyResult =
  | { readonly ok: true; readonly claims: LicenseClaims }
  | { readonly ok: false; readonly reason: VerifyRejectReason };

/** 锁定状态机的稳定 reason（renderer/e2e/单测共用；与服务端错误码语义对齐） */
export type LicenseStatusReason =
  | 'WITHIN_GRACE'
  | 'NO_LICENSE'
  | 'MALFORMED'
  | 'ALG_REJECTED'
  | 'TYPE_REJECTED'
  | 'SIGNATURE_INVALID'
  | 'EXPIRED'
  | 'GRACE_EXCEEDED'
  | 'NO_VERIFICATION'
  | 'DEVICE_MISMATCH';

export interface LicenseEnvelope {
  licenseJwt: string;
  /** 最近一次验签成功时间（ISO）。72h 宽限起算点（FR-1.5） */
  lastVerifiedAt: string;
  /** 本机设备指纹哈希（sha256 hex）；与 license.device_hash 对账用 */
  deviceHash: string;
}

export type LicenseStatus = Readonly<{
  state: 'unlocked' | 'locked';
  reason: LicenseStatusReason;
  plan?: string;
  tier?: string;
  deviceLimit?: number;
  /** license exp（ISO） */
  expiresAt?: string;
  lastVerifiedAt?: string;
  /** 宽限窗截止（ISO）= lastVerifiedAt + 72h */
  graceEndsAt?: string;
  /** 本机指纹哈希 */
  deviceHash?: string;
  /** license 内绑定指纹哈希（''=未绑定） */
  licenseDeviceHash?: string;
}>;

const HOUR_MS = 60 * 60 * 1000;

function parseSegment(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 严格离线验签。顺序：结构 → header.alg 白名单 → header.typ → Ed25519 签名 → payload.typ → exp。
 * 签名不通过前不信任 payload 任何字段；alg 只收 'EdDSA'（HS256/RS256/alg:none 一律 ALG_REJECTED，
 * 防止「用公钥当 HMAC secret」「换算法重签」等混淆攻击——单测见 license-manager.test.ts）。
 */
export function verifyLicenseJwt(token: string, publicKeyPem: string, now: Date = new Date()): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = parseSegment(rawHeader);
  if (!header || typeof header['alg'] !== 'string') return { ok: false, reason: 'MALFORMED' };
  if (header['alg'] !== 'EdDSA') return { ok: false, reason: 'ALG_REJECTED' };
  if (header['typ'] !== 'license') return { ok: false, reason: 'TYPE_REJECTED' };

  const payload = parseSegment(rawPayload);
  if (!payload) return { ok: false, reason: 'MALFORMED' };

  let signatureOk: boolean;
  try {
    signatureOk = edVerify(
      null,
      Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(rawSignature, 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: 'SIGNATURE_INVALID' };

  if (payload['typ'] !== 'license') return { ok: false, reason: 'TYPE_REJECTED' };
  const exp = payload['exp'];
  if (typeof exp !== 'number' || exp * 1000 <= now.getTime()) return { ok: false, reason: 'EXPIRED' };

  return {
    ok: true,
    claims: {
      sub: String(payload['sub'] ?? ''),
      typ: String(payload['typ']),
      plan: String(payload['plan'] ?? ''),
      tier: String(payload['tier'] ?? ''),
      device_limit: Number(payload['device_limit'] ?? 0),
      exp,
      device_hash: String(payload['device_hash'] ?? ''),
      jti: String(payload['jti'] ?? ''),
    },
  };
}

function locked(reason: LicenseStatusReason, extra?: Partial<LicenseStatus>): LicenseStatus {
  return { state: 'locked', reason, ...extra };
}

/**
 * 锁定状态机（FR-1.5/1.6 纯逻辑核）：
 * 无 license → locked NO_LICENSE；验签失败 → locked（按失败原因）；exp 过 → locked EXPIRED；
 * now ≥ lastVerifiedAt + 72h → locked GRACE_EXCEEDED（边界值取锁：72h 整点已超期）；
 * 其余 → unlocked WITHIN_GRACE（M0 全程处于 72h 宽限窗内，见文件头 M0 边界注记）。
 */
export function computeLicenseStatus(input: {
  envelope: LicenseEnvelope | null;
  publicKeyPem: string;
  now: Date;
  graceHours?: number;
  localDeviceHash?: string;
}): LicenseStatus {
  const graceHours = input.graceHours ?? LICENSE_GRACE_HOURS;
  const envelope = input.envelope;
  const common = { deviceHash: input.localDeviceHash };
  if (!envelope || typeof envelope.licenseJwt !== 'string' || envelope.licenseJwt.length === 0) {
    return locked('NO_LICENSE', common);
  }
  const verified = verifyLicenseJwt(envelope.licenseJwt, input.publicKeyPem, input.now);
  if (!verified.ok) return locked(verified.reason, common);
  const claims = verified.claims;
  const lastMs = Date.parse(envelope.lastVerifiedAt);
  if (!Number.isFinite(lastMs)) return locked('NO_VERIFICATION', { ...common, licenseDeviceHash: claims.device_hash });
  const graceEndsMs = lastMs + graceHours * HOUR_MS;
  if (input.now.getTime() >= graceEndsMs) {
    return locked('GRACE_EXCEEDED', {
      ...common,
      licenseDeviceHash: claims.device_hash,
      lastVerifiedAt: envelope.lastVerifiedAt,
      graceEndsAt: new Date(graceEndsMs).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    });
  }
  return {
    state: 'unlocked',
    reason: 'WITHIN_GRACE',
    ...common,
    licenseDeviceHash: claims.device_hash,
    plan: claims.plan,
    tier: claims.tier,
    deviceLimit: claims.device_limit,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    lastVerifiedAt: envelope.lastVerifiedAt,
    graceEndsAt: new Date(graceEndsMs).toISOString(),
  };
}

/* ---------- envelope 持久化（license 文件，userData 目录） ---------- */

export function isLicenseEnvelope(value: unknown): value is LicenseEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['licenseJwt'] === 'string' &&
    v['licenseJwt'].length > 0 &&
    typeof v['lastVerifiedAt'] === 'string' &&
    typeof v['deviceHash'] === 'string'
  );
}

/** 读取 license 文件；缺失/损坏一律返回 null（状态机走 NO_LICENSE/无 license 路径，不抛错）。 */
export function loadEnvelope(filePath: string): LicenseEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return isLicenseEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveEnvelope(filePath: string, envelope: LicenseEnvelope): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');
}

/* ---------- 设备指纹（02 §11.4：仅哈希上行，原始指纹不出机器） ---------- */

export interface FingerprintInputs {
  readonly hostname: string;
  readonly cpuModel: string;
  readonly mac: string;
}

/**
 * M0 指纹算法（任务卡指定，弱化实现）：规范化(小写+去空白)拼接 → sha256 hex。
 * 02 §12.3 的目标算法（主板序列号+磁盘序列号+随机安装 ID）需平台原生 API，M5 再强化——
 * 已知弱化点：hostname/机器名可被用户修改导致换绑；M5 引入安装 ID 兜底。
 */
export function fingerprintHash(inputs: FingerprintInputs): string {
  const normalize = (s: string): string => s.trim().toLowerCase();
  const canonical = [inputs.hostname, inputs.cpuModel, inputs.mac].map(normalize).join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
