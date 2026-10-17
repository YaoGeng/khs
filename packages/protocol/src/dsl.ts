import { z } from 'zod';

// 适配层 DSL v1.1 契约；唯一真源 = 02-系统架构设计.md §7.5「DSL v1.1 规范参数表」。
// 纯数据、不含可执行 JS（安全边界）；app 引擎与适配包共同依赖的唯一跨层通道。
// 2026-10-18 契约扩展卡（T-M2-01 范围收尾）：flows 增可选 favorite/inquiry 写操作 flow
// + flow 级 confirm 声明（发送前人工确认红线，FR-6.4/FR-12.7）；引擎侧执行语义见 §7.5。

export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const SHA256_RE = /^[0-9a-fA-F]{64}$/;

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(input: string): ParsedSemver | null {
  const match = SEMVER_RE.exec(input);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  // semver.org #11.4/#11.5：数字标识符按数值比较，且恒小于字母数字标识符
  if (numericA) return -1;
  if (numericB) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** semver.org #11 优先级比较，返回 -1 | 0 | 1；构建元数据不参与。 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null) throw new Error(`非法 semver: ${a}`);
  if (pb === null) throw new Error(`非法 semver: ${b}`);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // 规则 #11.3：无先决版本 > 有先决版本
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const c = comparePrereleaseIdentifier(pa.prerelease[i], pb.prerelease[i]);
    if (c !== 0) return c;
  }
  // 规则 #11.6：前缀全等时，标识符更多者更大
  if (pa.prerelease.length !== pb.prerelease.length) {
    return pa.prerelease.length < pb.prerelease.length ? -1 : 1;
  }
  return 0;
}

/** 02 §7.5 S10：minEngineVersion 高于引擎版本 → 拒绝激活；等号兼容。 */
export function isEngineCompatible(minEngineVersion: string, engineVersion: string): boolean {
  return compareSemver(engineVersion, minEngineVersion) >= 0;
}

/** B-4 客户端过滤口径：AND = 单查询 + 标题/正文必须全词命中 */
export type ClientFilter = 'all_terms_in_title_or_content' | null;

export interface KeywordQueryPlan {
  /** OR=逐词分次提交；AND=单次合并查询 */
  queries: string[];
  /** AND 时引擎须本地全词过滤；OR 为 null（并集按 note_id 去重由引擎执行） */
  clientFilter: ClientFilter;
}

/** B-4 语义（02:389）：把 terms 组合折叠为平台查询计划。 */
export function planKeywordQueries(query: { terms: string[]; operator: 'and' | 'or' }): KeywordQueryPlan {
  if (query.operator === 'or') {
    return { queries: [...query.terms], clientFilter: null };
  }
  return { queries: [query.terms.join(' ')], clientFilter: 'all_terms_in_title_or_content' };
}

// schema 一律 strict：未知字段拒绝，前向兼容走 minEngineVersion 升档。

export const SelectorMapSchema = z.record(z.string().min(1), z.string().min(1));
export type SelectorMap = z.infer<typeof SelectorMapSchema>;

/** selector 字段 = selectors 表键名引用；minCount = 最少命中次数 */
export const PageFeatureSchema = z.strictObject({
  selector: z.string().min(1),
  minCount: z.number().int().min(1).default(1),
});
export type PageFeature = z.infer<typeof PageFeatureSchema>;

/** B-4：terms 1..5 + operator and|or */
export const SearchQuerySchema = z.strictObject({
  terms: z.array(z.string().min(1)).min(1).max(5),
  operator: z.enum(['and', 'or']),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const StepActionSchema = z.enum(['navigate', 'click', 'type', 'scroll', 'waitFor', 'extract']);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z.strictObject({
  id: z.string().min(1),
  action: StepActionSchema,
  target: z.string().min(1).optional(),
  /** navigate=URL 模板（{{input.xxx}}）；type=键入文本；extract=输出键名 */
  value: z.string().optional(),
  /** 执行前须核验的预期页面特征（02:391：页面改版变成可检测事件） */
  expect: z.array(PageFeatureSchema).max(16).optional(),
  /** S2（02:387）：不可重入步骤，引擎强制要求对应 verify 声明存在 */
  nonReentrant: z.boolean().optional(),
  description: z.string().optional(),
});
export type Step = z.infer<typeof StepSchema>;

/** verify 声明（S2）：不可重入步骤恢复时的「页面是否已成功」核对声明 */
export const VerifyDeclSchema = z.strictObject({
  step: z.string().min(1),
  description: z.string().min(1),
  expect: z.array(PageFeatureSchema).min(1),
});
export type VerifyDecl = z.infer<typeof VerifyDeclSchema>;

/**
 * confirm 声明（契约扩展卡，2026-10-18）：对外写操作 flow（收藏/询盘等）的人工确认红线。
 * 引擎侧执行语义（02 §7.5）：执行本 flow 首个 nonReentrant 步骤前，必须完成 app 人工确认
 * 弹窗（**不受 FR-12.7 自动化档位影响，永远人工**）+ 审计事件留痕
 * （taskId/offerId/用户决定/时间戳）；expect = 人工确认后、不可逆动作执行前引擎须核验的
 * 平台侧界面特征（如旺旺会话窗、收藏按钮在场）。执行端实现归 T-M2-04。
 */
export const ConfirmDeclSchema = z.strictObject({
  description: z.string().min(1),
  expect: z.array(PageFeatureSchema).min(1),
});
export type ConfirmDecl = z.infer<typeof ConfirmDeclSchema>;

/** 风控特征（验证码容器等，02:388）：命中 → 上报风控信号 → 熔断器介入 */
export const BlockedFeatureSchema = z.strictObject({
  name: z.string().min(1),
  selectors: z.array(z.string().min(1)).min(1),
  description: z.string().optional(),
});
export type BlockedFeature = z.infer<typeof BlockedFeatureSchema>;

/** 自检用例（02:390）：在无害 fixture 页回放选择器，全部命中才激活 */
export const SelfcheckCaseSchema = z.strictObject({
  name: z.string().min(1),
  fixture: z.string().min(1),
  expect: z.array(PageFeatureSchema).min(1),
  description: z.string().optional(),
});
export type SelfcheckCase = z.infer<typeof SelfcheckCaseSchema>;

const FlowBaseSchema = z.strictObject({
  description: z.string().optional(),
  query: SearchQuerySchema.optional(),
  /** 输出字段位点：字段名 → selectors 表键名（detail flow 用） */
  fields: z.record(z.string().min(1), z.string().min(1)).optional(),
  steps: z.array(StepSchema).min(1).optional(),
  /** 按输入类型路由（search 的 keyword/user/note_url 三种输入用） */
  routes: z.record(z.string().min(1), z.array(StepSchema).min(1)).optional(),
  /** 对外写操作的人工确认声明（favorite/inquiry 用；见 ConfirmDeclSchema 注释） */
  confirm: ConfirmDeclSchema.optional(),
});

export const FlowSchema = FlowBaseSchema.superRefine((flow, ctx) => {
  const hasSteps = flow.steps !== undefined;
  const hasRoutes = flow.routes !== undefined;
  if (hasSteps === hasRoutes) {
    ctx.addIssue({
      code: 'custom',
      message: 'flow 必须且只能包含 steps 与 routes 之一',
      path: hasSteps ? ['steps'] : ['routes'],
    });
  }
});
export type Flow = z.infer<typeof FlowSchema>;

function collectFlowSteps(flow: Flow): Step[] {
  if (flow.steps !== undefined) return flow.steps;
  const routed: Step[] = [];
  for (const steps of Object.values(flow.routes ?? {})) routed.push(...steps);
  return routed;
}

/**
 * DSL v1.1 顶层 schema。加载期校验前置（02:387，不留给运行时）：
 * nonReentrant 步骤必须有 verify 声明；verify.step 必须存在；
 * 声明 confirm 的 flow 必须含至少一个 nonReentrant 步骤（不可逆动作锚点）；
 * 所有 selector 引用必须落在 selectors 表内。
 */
export const AdapterDslSchema = z
  .strictObject({
    platform: z.string().min(1),
    version: z.string().regex(SEMVER_RE, 'version 必须是合法 semver'),
    minEngineVersion: z.string().regex(SEMVER_RE, 'minEngineVersion 必须是合法 semver'),
    selectors: SelectorMapSchema,
    flows: z.strictObject({
      search: FlowSchema,
      detail: FlowSchema,
      /** 契约扩展卡（2026-10-18）：对外写操作 flow 为可选键（xhs 等只读包不含仍合法） */
      favorite: FlowSchema.optional(),
      inquiry: FlowSchema.optional(),
    }),
    selfcheck: z.array(SelfcheckCaseSchema).min(1),
    verify: z.array(VerifyDeclSchema).default([]),
    blockedFeatures: z.array(BlockedFeatureSchema).default([]),
  })
  .superRefine((dsl, ctx) => {
    const flowEntries = Object.entries(dsl.flows) as Array<[string, Flow]>;
    const allSteps = flowEntries.flatMap(([, flow]) => collectFlowSteps(flow));

    const stepIds = new Set<string>();
    for (const step of allSteps) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({ code: 'custom', message: `步骤 id 重复: ${step.id}`, path: ['flows'] });
      }
      stepIds.add(step.id);
    }

    // 契约扩展卡：confirm 声明 → 本 flow 至少一个 nonReentrant 步骤
    //（不可逆动作锚点；该步骤经下方 S2 检查强制配对 verify 声明）
    for (const [flowKey, flow] of flowEntries) {
      if (flow.confirm !== undefined && !collectFlowSteps(flow).some((step) => step.nonReentrant === true)) {
        ctx.addIssue({
          code: 'custom',
          message: `声明 confirm 的 flow 缺少 nonReentrant 步骤: ${flowKey}`,
          path: ['flows', flowKey, 'confirm'],
        });
      }
    }

    const verifiedSteps = new Set(dsl.verify.map((decl) => decl.step));
    for (const step of allSteps) {
      if (step.nonReentrant === true && !verifiedSteps.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `nonReentrant 步骤缺少 verify 声明: ${step.id}`,
          path: ['verify'],
        });
      }
    }
    for (const decl of dsl.verify) {
      if (!stepIds.has(decl.step)) {
        ctx.addIssue({
          code: 'custom',
          message: `verify 声明指向不存在的步骤: ${decl.step}`,
          path: ['verify'],
        });
      }
    }

    const unknown: Array<{ path: (string | number)[]; name: string }> = [];
    const checkFeature = (feature: PageFeature, path: (string | number)[]): void => {
      if (dsl.selectors[feature.selector] === undefined) unknown.push({ path, name: feature.selector });
    };
    for (const [flowKey, flow] of Object.entries(dsl.flows) as Array<[string, Flow]>) {
      collectFlowSteps(flow).forEach((step, i) => {
        if (step.target !== undefined && dsl.selectors[step.target] === undefined) {
          unknown.push({ path: ['flows', flowKey, 'steps', i, 'target'], name: step.target });
        }
        step.expect?.forEach((exp, j) => checkFeature(exp, ['flows', flowKey, 'steps', i, 'expect', j]));
      });
      for (const [field, selectorName] of Object.entries(flow.fields ?? {})) {
        if (dsl.selectors[selectorName] === undefined) {
          unknown.push({ path: ['flows', flowKey, 'fields', field], name: selectorName });
        }
      }
      flow.confirm?.expect.forEach((exp, j) => checkFeature(exp, ['flows', flowKey, 'confirm', 'expect', j]));
    }
    dsl.selfcheck.forEach((check, i) =>
      check.expect.forEach((exp, j) => checkFeature(exp, ['selfcheck', i, 'expect', j])),
    );
    dsl.verify.forEach((decl, i) =>
      decl.expect.forEach((exp, j) => checkFeature(exp, ['verify', i, 'expect', j])),
    );
    dsl.blockedFeatures.forEach((feature, i) =>
      feature.selectors.forEach((name, j) => {
        if (dsl.selectors[name] === undefined) unknown.push({ path: ['blockedFeatures', i, 'selectors', j], name });
      }),
    );
    for (const item of unknown) {
      ctx.addIssue({
        code: 'custom',
        message: `selector 引用未在 selectors 表定义: ${item.name}`,
        path: item.path,
      });
    }
  });

export type AdapterDsl = z.infer<typeof AdapterDslSchema>;
export type AdapterDslInput = z.input<typeof AdapterDslSchema>;

export const ADAPTER_MANIFEST_FILE = 'manifest.json';
export const ADAPTER_DSL_FILE = 'dsl.json';

/**
 * 包验封清单（02:807 Ed25519 包签名）。sha256 = dsl.json 字节摘要；
 * sig = 对 manifestSignablePayload(manifest) 的 Ed25519 签名（base64）。
 */
export const AdapterManifestSchema = z.strictObject({
  platform: z.string().min(1),
  version: z.string().regex(SEMVER_RE, 'version 必须是合法 semver'),
  minEngineVersion: z.string().regex(SEMVER_RE, 'minEngineVersion 必须是合法 semver'),
  sha256: z.string().regex(SHA256_RE, 'sha256 必须是 64 位 hex'),
  sig: z.string().min(1),
});
export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;
