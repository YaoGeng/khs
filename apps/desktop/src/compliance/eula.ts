/**
 * EULA 首启确认门 —— 纯逻辑核（todo 9 = T-M0-11；FR-1.9；electron-free，vitest 直测）。
 *
 * 依据：
 * - 01-需求说明书.md:120 FR-1.9：未确认锁定主功能；版本变更重新确认；确认记录（EULA 版本号+时间戳）本地留痕；
 * - 06-产品合规评审报告.md PC-01：EULA 措辞四段式（风险告知/用户承诺/内容责任/责任边界），
 *   隐私政策列明收集清单——本文件占位文本按该结构编写，法律终稿 M6 T-M6-02 定稿；
 * - 确认记录经 T11 store 落 SQLite consents 表（留痕），本文件只负责「记录 → 门态」的纯解析。
 */

/** 当前应用侧 EULA 版本（法律终稿定稿前使用 draft 版本号机制；改此常量即触发全量重确认） */
export const EULA_VERSION_DEFAULT = '0.1.0-draft';

/**
 * dev/test seam（与 XINGLIAN_LICENSE_FILE / XINGLIAN_DB_FILE 同风格，main.ts 注入）：
 * e2e 经 XINGLIAN_EULA_VERSION 覆盖「本版 EULA 版本号」模拟升级重确认流。
 * 不是确认流旁路——确认/拒绝/落库全链路照常执行，仅版本字符串不同。
 */
export function resolveEulaVersion(env: { XINGLIAN_EULA_VERSION?: string } = process.env): string {
  const override = env.XINGLIAN_EULA_VERSION?.trim();
  return override && override.length > 0 ? override : EULA_VERSION_DEFAULT;
}

/** EULA 占位文本（PC-01 四段式结构 + 隐私政策收集清单；渲染进程展示，法律终稿 M6 替换） */
export const EULA_PLACEHOLDER = [
  '【占位法律文本 · 版本机制先行——EULA 与隐私政策终稿由 M6 T-M6-02 法务定稿】',
  '',
  '一、平台协议风险告知',
  '本软件可按你的指令对第三方平台（如小红书、1688）执行自动化操作。此类操作可能被平台认定违反其用户协议，进而导致限流、内容下架或账号封禁等后果。你应自行评估并承担在平台账号侧的风险。',
  '浏览器说明：本软件驱动的浏览器为应用托管的独立进程（内置便携 Chromium 或你本机已安装的 Chrome/Edge）。平台登录由你本人在该可见浏览器窗口内完成，本软件不读取、不存储你的平台账号密码。',
  '',
  '二、用户承诺条款',
  '你承诺在合法范围内使用本软件，遵守目标平台的用户协议与相关法律法规，不利用本软件从事虚假宣传、恶意营销或其他侵权行为。',
  '',
  '三、内容责任归属',
  '你通过本软件发布的内容（含 AI 生成的草稿）由你作为责任主体审核确认后发布；软件内置的合规过滤为辅助手段，不构成对内容合法性的担保。',
  '',
  '四、责任边界',
  '对于与你的使用行为直接相关的平台处罚后果（账号限流、封禁等），本软件在法律允许范围内不承担相应责任；本条不构成概括性免责。',
  '',
  '隐私政策（占位）：本软件本地留存日志与任务数据。如你开通账号或在线服务，可能收集：邮箱、密码哈希、订单信息、设备指纹哈希（仅哈希上行）、以及在你明确同意后发送的匿名遥测数据。收集清单终稿见隐私政策正式版。',
].join('\n');

/**
 * EULA 版本比较（semver 风格纯函数）：主.次.补丁[-预发布]，逐段数值比较；
 * 预发布 < 正式版（semver 第 11 条）；预发布段按字典序。无法解析的版本按字符串序兜底
 * （解析失败只影响排序方向，不影响「相等/不等」判定——重确认门只关心差零不差零）。
 */
export function compareEulaVersions(a: string, b: string): number {
  if (a === b) return 0;
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i += 1) {
      if (pa.core[i] !== pb.core[i]) return pa.core[i]! < pb.core[i]! ? -1 : 1;
    }
    // 预发布：无预发布 > 有预发布；同有则逐标识符比较
    if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
    if (pa.prerelease.length === 0) return 1;
    if (pb.prerelease.length === 0) return -1;
    const len = Math.max(pa.prerelease.length, pb.prerelease.length);
    for (let i = 0; i < len; i += 1) {
      const ai = pa.prerelease[i];
      const bi = pb.prerelease[i];
      if (ai === bi) continue;
      if (ai === undefined) return -1;
      if (bi === undefined) return 1;
      return ai < bi ? -1 : 1;
    }
    return 0;
  }
  return a < b ? -1 : 1;
}

function parseVersion(v: string): { core: [number, number, number]; prerelease: string[] } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/**
 * 版本变更重确认判定（FR-1.9）：无确认记录或版本不相等即需重确认。
 * 降级（app 版本 < 已确认版本）同样重确认——合法默认是「确认过的那版文本」，
 * 与当前展示版本不一致就必须重问，方向无关。
 */
export function needsReconfirm(confirmedVersion: string | null, appEulaVersion: string): boolean {
  if (!confirmedVersion) return true;
  return compareEulaVersions(confirmedVersion, appEulaVersion) !== 0;
}

/** store 侧留痕行的最小结构面（client.getLatestConsents 的 ConsentRowView 子集） */
export interface EulaConsentRow {
  readonly action: string;
  readonly eulaVersion: string | null;
  readonly telemetryConsent: boolean | null;
  readonly createdAt: string;
}

export type EulaGateStatus = 'unconfirmed' | 'accepted' | 'rejected' | 'version-changed';
export type TelemetryConsentValue = 'granted' | 'denied' | 'unasked';

export interface EulaGateInput {
  readonly appEulaVersion: string;
  /** consents 表 subject='eula' 的最新一行（无记录 = 首启） */
  readonly eulaRow: EulaConsentRow | null;
  /** consents 表 telemetry_consent 非空的最新一行（eula 接受行与设置开关行统一按 id 时序） */
  readonly telemetryRow: EulaConsentRow | null;
}

export interface EulaGateState {
  readonly eulaVersion: string;
  readonly eulaStatus: EulaGateStatus;
  readonly requiresConfirm: boolean;
  readonly confirmedVersion: string | null;
  readonly confirmedAt: string | null;
  readonly rejectedAt: string | null;
  readonly telemetryConsent: TelemetryConsentValue;
}

/** 留痕记录 → 门态（纯函数）：门态是「最新一条 eula 动作行 + 版本对账」的投影 */
export function resolveEulaGate(input: EulaGateInput): EulaGateState {
  const row = input.eulaRow;
  let eulaStatus: EulaGateStatus = 'unconfirmed';
  let confirmedVersion: string | null = null;
  let confirmedAt: string | null = null;
  let rejectedAt: string | null = null;

  if (row && row.action === 'accepted') {
    confirmedVersion = row.eulaVersion;
    confirmedAt = row.createdAt;
    eulaStatus = needsReconfirm(row.eulaVersion, input.appEulaVersion) ? 'version-changed' : 'accepted';
  } else if (row && row.action === 'rejected') {
    rejectedAt = row.createdAt;
    eulaStatus = row.eulaVersion === input.appEulaVersion ? 'rejected' : 'version-changed';
  }

  const telemetryConsent: TelemetryConsentValue =
    input.telemetryRow === null ? 'unasked' : input.telemetryRow.telemetryConsent ? 'granted' : 'denied';

  return {
    eulaVersion: input.appEulaVersion,
    eulaStatus,
    requiresConfirm: eulaStatus !== 'accepted',
    confirmedVersion,
    confirmedAt,
    rejectedAt,
    telemetryConsent,
  };
}
