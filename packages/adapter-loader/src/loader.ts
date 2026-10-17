import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ADAPTER_DSL_FILE,
  ADAPTER_MANIFEST_FILE,
  AdapterDslSchema,
  AdapterManifestSchema,
  isEngineCompatible,
  manifestSignablePayload,
  normalizePem,
  type AdapterDsl,
  type AdapterManifest,
} from '@xinglian/protocol';
import { createLinkedomSelfcheckRunner } from './selfcheck.js';

/**
 * 当前引擎的 DSL 引擎版本；与适配包的 minEngineVersion 做兼容判定。
 * 1.1.0（2026-10-18 契约扩展卡）：AdapterDslSchema.flows 扩展 favorite/inquiry +
 * confirm 声明；桌面组合根注入源在 apps/desktop/src/shared/engine-constants.ts（两处同步）。
 */
export const ENGINE_DSL_VERSION = '1.1.0';

export const ACTIVE_FILE = 'active.json';

/** 遥测注入接口（M0 形态=本地留存；真实通道 todo 9 接）。包不依赖 app 的 telemetry-guard。 */
export type EmitTelemetry = (event: string, payload?: unknown) => void;

export interface SelfcheckFeature {
  /** 已解析为实际 CSS selector（非 selectors 表键名） */
  selector: string;
  minCount: number;
}

export interface SelfcheckRunnerResult {
  passed: boolean;
  failed: SelfcheckFeature[];
}

/** 自检执行器：在 fixture HTML 上回放选择器（默认实现=linkedom，见 selfcheck.ts） */
export type SelfcheckRunner = (html: string, features: readonly SelfcheckFeature[]) => SelfcheckRunnerResult;

export interface ActivationRecord {
  platform: string;
  version: string;
  activatedAt: string;
}

export type AdapterRejectReason =
  | 'package_not_found'
  | 'manifest_invalid'
  | 'integrity_mismatch'
  | 'signature_invalid'
  | 'schema_invalid'
  | 'dsl_manifest_mismatch'
  | 'incompatible_engine'
  | 'selfcheck_failed';

export type LoadResult =
  | { ok: true; platform: string; version: string; dsl: AdapterDsl; record: ActivationRecord }
  | { ok: false; reason: AdapterRejectReason; detail: string; keptVersion: string | null };

export interface LoadAdapterOptions {
  /** `<userData>/adapters`（包目录布局：`<adaptersRoot>/<platform>/<semver>/`） */
  adaptersRoot: string;
  platform: string;
  /** 候选包版本 */
  version: string;
  /** 本引擎的 DSL 引擎版本 */
  engineVersion: string;
  /** 引擎随包分发的 Ed25519 公钥（PEM 文本，容忍头部注释；或 SPKI DER Buffer） */
  publicKey: string | Buffer;
  emitTelemetry?: EmitTelemetry;
  selfcheckRunner?: SelfcheckRunner;
}

function importPublicKey(publicKey: string | Buffer): KeyObject {
  if (Buffer.isBuffer(publicKey)) {
    return createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  }
  return createPublicKey(normalizePem(publicKey));
}

function zodDetail(error: unknown): string {
  const issues = (error as { issues?: Array<{ path: Array<string | number | symbol>; message: string }> }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return '未知 schema 错误';
  return issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; ');
}

/** 读取当前激活记录（任一失败→null，不抛错） */
export async function readActiveRecord(adaptersRoot: string, platform: string): Promise<ActivationRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(adaptersRoot, platform, ACTIVE_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ActivationRecord>;
    if (
      typeof parsed.platform === 'string' &&
      typeof parsed.version === 'string' &&
      typeof parsed.activatedAt === 'string'
    ) {
      return { platform: parsed.platform, version: parsed.version, activatedAt: parsed.activatedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/** 原子写 active.json（tmp + rename；Windows 下 rename 覆盖已存在文件） */
async function writeActiveRecord(adaptersRoot: string, record: ActivationRecord): Promise<void> {
  const dir = join(adaptersRoot, record.platform);
  await mkdir(dir, { recursive: true });
  const target = join(dir, ACTIVE_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

async function runSelfcheck(
  pkgDir: string,
  dsl: AdapterDsl,
  runner: SelfcheckRunner,
): Promise<{ passed: boolean; failedCases: Array<{ name: string; detail: string }> }> {
  const failedCases: Array<{ name: string; detail: string }> = [];
  for (const check of dsl.selfcheck) {
    let html: string;
    try {
      html = await readFile(join(pkgDir, check.fixture), 'utf8');
    } catch {
      failedCases.push({ name: check.name, detail: `fixture 读取失败: ${check.fixture}` });
      continue;
    }
    const features: SelfcheckFeature[] = [];
    const unresolved: string[] = [];
    for (const expect of check.expect) {
      const css = dsl.selectors[expect.selector];
      if (css === undefined) {
        unresolved.push(expect.selector);
        continue;
      }
      features.push({ selector: css, minCount: expect.minCount });
    }
    if (unresolved.length > 0) {
      failedCases.push({ name: check.name, detail: `未知 selector 引用: ${unresolved.join(', ')}` });
      continue;
    }
    const result = runner(html, features);
    if (!result.passed) {
      const missed = result.failed.map((f) => f.selector).join(', ');
      failedCases.push({ name: check.name, detail: `选择器未命中: ${missed}` });
    }
  }
  return { passed: failedCases.length === 0, failedCases };
}

/**
 * 适配包加载链（02 §7.5 v1.1 热更链路 + §15.2）：
 * 读包目录 → sha256 完整性 → Ed25519 验签 → DSL schema 校验 → semver/minEngineVersion
 * 兼容检查（不兼容拒激活）→ 自检（fixture 无害页回放，全过才激活）→ 原子写 active.json。
 * 任一步失败：拒绝激活且不改写 active.json（last-good 保留）；自检失败追加 selfcheck_fail 遥测。
 */
export async function loadAdapterPackage(options: LoadAdapterOptions): Promise<LoadResult> {
  const { adaptersRoot, platform, version, engineVersion } = options;
  const keptVersion = (await readActiveRecord(adaptersRoot, platform))?.version ?? null;
  const pkgDir = join(adaptersRoot, platform, version);
  const reject = (reason: AdapterRejectReason, detail: string): LoadResult => ({
    ok: false,
    reason,
    detail,
    keptVersion,
  });

  // 1. 读包目录
  let manifestRaw: string;
  let dslBytes: Buffer;
  try {
    manifestRaw = await readFile(join(pkgDir, ADAPTER_MANIFEST_FILE), 'utf8');
    dslBytes = await readFile(join(pkgDir, ADAPTER_DSL_FILE));
  } catch (error) {
    return reject('package_not_found', `包目录/文件缺失: ${pkgDir}（${(error as Error).message}）`);
  }

  // 2a. manifest schema
  let manifest: AdapterManifest;
  try {
    manifest = AdapterManifestSchema.parse(JSON.parse(manifestRaw));
  } catch (error) {
    return reject('manifest_invalid', `manifest.json 非法: ${zodDetail(error)}`);
  }

  // 2b. sha256 完整性
  const actualSha256 = createHash('sha256').update(dslBytes).digest('hex');
  if (actualSha256 !== manifest.sha256.toLowerCase()) {
    return reject(
      'integrity_mismatch',
      `dsl.json sha256 不匹配（manifest=${manifest.sha256}, actual=${actualSha256}）`,
    );
  }

  // 3. Ed25519 验签（公钥随引擎分发，02:616）
  let publicKey: KeyObject;
  try {
    publicKey = importPublicKey(options.publicKey);
  } catch (error) {
    return reject('signature_invalid', `引擎公钥非法: ${(error as Error).message}`);
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(manifest.sig, 'base64');
  } catch {
    return reject('signature_invalid', 'sig 不是合法 base64');
  }
  const payload = Buffer.from(manifestSignablePayload(manifest), 'utf8');
  if (signature.length !== 64 || !ed25519Verify(null, payload, publicKey, signature)) {
    return reject('signature_invalid', 'Ed25519 验签失败');
  }

  // 4. DSL schema 校验（纯数据 JSON 即安全边界）+ 与 manifest 一致性
  let dsl: AdapterDsl;
  try {
    dsl = AdapterDslSchema.parse(JSON.parse(dslBytes.toString('utf8')));
  } catch (error) {
    return reject('schema_invalid', `dsl.json 不符合 DSL v1.1: ${zodDetail(error)}`);
  }
  if (dsl.platform !== manifest.platform || dsl.version !== manifest.version) {
    return reject(
      'dsl_manifest_mismatch',
      `dsl 与 manifest 不一致（dsl=${dsl.platform}@${dsl.version}, manifest=${manifest.platform}@${manifest.version}）`,
    );
  }

  // 5. semver/minEngineVersion 兼容检查（不兼容拒激活，不降级运行）
  if (!isEngineCompatible(manifest.minEngineVersion, engineVersion)) {
    return reject(
      'incompatible_engine',
      `引擎 DSL 版本 ${engineVersion} 低于包要求的 minEngineVersion ${manifest.minEngineVersion}`,
    );
  }

  // 6. 激活前自检
  const runner = options.selfcheckRunner ?? createLinkedomSelfcheckRunner();
  const selfcheck = await runSelfcheck(pkgDir, dsl, runner);
  if (!selfcheck.passed) {
    options.emitTelemetry?.('selfcheck_fail', { platform, version, failedCases: selfcheck.failedCases });
    return reject(
      'selfcheck_failed',
      `自检未全过: ${selfcheck.failedCases.map((c) => `${c.name}(${c.detail})`).join('; ')}`,
    );
  }

  // 7. 激活
  const record: ActivationRecord = { platform, version, activatedAt: new Date().toISOString() };
  await writeActiveRecord(adaptersRoot, record);
  return { ok: true, platform, version, dsl, record };
}

/** 引导路径：按 active.json 重新走完整加载链（每次启动都重验，02 §15.2） */
export async function loadActivePackage(
  options: Omit<LoadAdapterOptions, 'version'>,
): Promise<LoadResult> {
  const active = await readActiveRecord(options.adaptersRoot, options.platform);
  if (active === null) {
    return {
      ok: false,
      reason: 'package_not_found',
      detail: 'active.json 不存在，尚无激活包',
      keptVersion: null,
    };
  }
  return loadAdapterPackage({ ...options, version: active.version });
}
