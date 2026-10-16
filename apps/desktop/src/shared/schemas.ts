/**
 * IPC 契约 zod schema（02-系统架构设计.md §4.3：所有 IPC 走 invoke/handle，
 * 通道即契约，入参用 zod 校验——preload 侧与 ipcMain.handle 侧共用本文件）。
 */
import { z } from 'zod';
import { BROWSER_PLATFORMS, KEY_PROVIDER_IDS, NAV_VIEWS, SELECTION_DIMENSIONS_SCHEMA, type IpcChannel } from './channels';

/* app:info —— 壳层运行时信息（M0 唯一"数据"通道，无业务含义） */
export const AppInfoParamsSchema = z.strictObject({});

export const AppInfoResultSchema = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  platform: z.string(),
  contractVersion: z.string(),
});

/* app:navigate —— 九视图导航（渲染进程切换 DOM 前经主进程记录，返回成功才切换） */
export const NavigateParamsSchema = z.strictObject({ view: z.enum(NAV_VIEWS) });

export const NavigateResultSchema = z.object({
  ok: z.literal(true),
  view: z.enum(NAV_VIEWS),
});

/* logs:ping —— 白名单/zod 校验链路的往返探针 */
export const LogsPingParamsSchema = z.strictObject({
  message: z.string().min(1).max(200),
});

export const LogsPingResultSchema = z.object({
  pong: z.string(),
  at: z.string(),
});

/* logs:query —— 五类日志查询（FR-10.1：分类可查可筛；FR-10.2：按 trace_id 串联） */
export const LOG_CATEGORIES_SCHEMA = [
  'user-action',
  'automation-step',
  'llm-call',
  'network-meta',
  'system-error',
] as const;

export const LogsQueryParamsSchema = z.strictObject({
  traceId: z.string().min(1).max(64).optional(),
  spanId: z.string().min(1).max(32).optional(),
  category: z.enum(LOG_CATEGORIES_SCHEMA).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const LogRowSchema = z.object({
  id: z.number().int(),
  ts: z.string(),
  createdAt: z.string(),
  level: z.number().int(),
  levelName: z.string(),
  category: z.string(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  msg: z.string(),
  payload: z.unknown(),
});

export const LogsQueryResultSchema = z.object({
  rows: z.array(LogRowSchema),
});

export type LogsQueryParams = z.infer<typeof LogsQueryParamsSchema>;
export type LogsQueryResult = z.infer<typeof LogsQueryResultSchema>;
export type LogRowView = z.infer<typeof LogRowSchema>;

/* tasks:* —— demo 任务（D7）+ M1 扩态（todo 7：queued/awaiting_user/yielded/paused） */
export const TASK_STATUSES_SCHEMA = [
  'idle',
  'queued',
  'running',
  'awaiting_user',
  'yielded',
  'paused',
  'suspended',
  'completed',
  'failed',
  'cancelled',
] as const;

export const TaskStepSchema = z.object({
  stepId: z.string(),
  seq: z.number().int(),
  status: z.string(),
  output: z.unknown(),
  checkpointAt: z.string().nullable(),
});

export const TaskViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(TASK_STATUSES_SCHEMA),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** kind 专属 payload（collect 输入/remainder、selection 的 idempotency_key/keywords；无敏感字段） */
  payload: z.unknown().optional(),
  steps: z.array(TaskStepSchema),
});

export const TasksCreateDemoParamsSchema = z.strictObject({});
export const TasksCreateDemoResultSchema = z.object({ taskId: z.string() });

export const TasksListParamsSchema = z.strictObject({});
export const TasksListResultSchema = z.object({ tasks: z.array(TaskViewSchema) });
export type TasksListResult = z.infer<typeof TasksListResultSchema>;

export const TasksResumeParamsSchema = z.strictObject({ taskId: z.string().min(1).max(64) });
export const TasksResumeResultSchema = z.object({ taskId: z.string(), status: z.enum(TASK_STATUSES_SCHEMA) });

export const TasksCancelParamsSchema = z.strictObject({ taskId: z.string().min(1).max(64) });
export const TasksCancelResultSchema = z.object({ taskId: z.string(), status: z.enum(TASK_STATUSES_SCHEMA) });

export const TasksPauseParamsSchema = z.strictObject({ taskId: z.string().min(1).max(64) });
export const TasksPauseResultSchema = z.object({ taskId: z.string(), status: z.enum(TASK_STATUSES_SCHEMA) });

/* collect:* —— 采集工作流（todo 7 = T-M1-04；FR-4.1 三种输入 / FR-4.5 跨日续采 / 门禁①计数器） */

export const COLLECT_INPUT_TYPES_SCHEMA = ['keyword', 'user', 'note_url'] as const;

export const CollectStartParamsSchema = z
  .object({
    inputType: z.enum(COLLECT_INPUT_TYPES_SCHEMA),
    /** inputType=keyword：B-4 词项组合（1..5 词） */
    terms: z.array(z.string().min(1).max(64)).min(1).max(5).optional(),
    operator: z.enum(['and', 'or']).optional(),
    /** inputType=keyword 单词便捷形态（与 terms 二选一） */
    keyword: z.string().min(1).max(64).optional(),
    /** inputType=user：竞品账号主页链接 */
    userUrl: z.string().url().optional(),
    /** inputType=note_url：笔记链接直达 */
    noteUrl: z.string().url().optional(),
    topicId: z.string().min(1).max(64),
    /** 主题采集总量（缺省 200；可配 50–1000，日配额 300 双轨硬上限） */
    targetTotal: z.number().int().min(50).max(1000).optional(),
  })
  .superRefine((params, ctx) => {
    const missing = (field: string): void => {
      ctx.addIssue({ code: 'custom', message: `inputType=${params.inputType} 时必须提供 ${field}`, path: [field] });
    };
    if (params.inputType === 'keyword' && !params.keyword && !params.terms) missing('keyword|terms');
    if (params.inputType === 'user' && !params.userUrl) missing('userUrl');
    if (params.inputType === 'note_url' && !params.noteUrl) missing('noteUrl');
  });

export const CollectStartResultSchema = z.object({ taskId: z.string() });

export const CollectRemainderSchema = z.object({
  taskId: z.string(),
  topicId: z.string(),
  /** 剩余目标条数（目标总量 − 该 run 已采 unique 数） */
  remaining: z.number().int().min(0),
  /** 触发暂停那天的本地日历日键（YYYY-MM-DD） */
  dayKey: z.string(),
  pausedAt: z.string(),
  reason: z.string(),
});

export const CollectRemaindersResultSchema = z.object({ remainders: z.array(CollectRemainderSchema) });

export const CollectRunStatsSchema = z.object({
  runId: z.string(),
  completedUnique: z.number().int(),
  duplicate: z.number().int(),
  noResult: z.number().int(),
  rateLimited: z.number().int(),
  captchaConsumed: z.number().int(),
});

export const CollectStatsParamsSchema = z.object({ runId: z.string().min(1), topicId: z.string().min(1).optional() });

export const CollectStatsResultSchema = z.object({
  stats: CollectRunStatsSchema.nullable(),
  /** notes 表中该 run 对应主题（或全局）行数 */
  notesCount: z.number().int(),
  /** note_snapshots 行数（FR-4.4 二次采集追加观测断言面） */
  snapshotsCount: z.number().int(),
  taskStatus: z.enum(TASK_STATUSES_SCHEMA).nullable(),
});

/* circuit:* —— 熔断联动（todo 7⑥；FR-9.5：OPEN 挂起 + 人工确认恢复经 IPC） */

export const CircuitStatusParamsSchema = z.strictObject({});

export const CircuitStatusResultSchema = z.object({
  state: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
  openedAt: z.string().nullable(),
  cooldownMs: z.number(),
  cooldownRemainingMs: z.number(),
  /** 最近事件流水（circuit_events 本地账本，倒序，≤50 条；只含事件元数据不含笔记内容） */
  events: z.array(z.object({ kind: z.string(), at: z.string(), meta: z.unknown() })),
});

export const CircuitConfirmResumeParamsSchema = z.strictObject({});
export const CircuitConfirmResumeResultSchema = z.object({
  ok: z.boolean(),
  state: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
  /** false 时的拒绝原因（未到冷却期满 / 非 OPEN 态） */
  reason: z.string().optional(),
});

export type CollectStartParams = z.infer<typeof CollectStartParamsSchema>;
export type CollectStartResult = z.infer<typeof CollectStartResultSchema>;
export type CollectRemainder = z.infer<typeof CollectRemainderSchema>;
export type CollectRemaindersResult = z.infer<typeof CollectRemaindersResultSchema>;
export type CollectRunStatsView = z.infer<typeof CollectRunStatsSchema>;
export type CollectStatsParams = z.infer<typeof CollectStatsParamsSchema>;
export type CollectStatsResult = z.infer<typeof CollectStatsResultSchema>;
export type CircuitStatusResult = z.infer<typeof CircuitStatusResultSchema>;
export type CircuitConfirmResumeResult = z.infer<typeof CircuitConfirmResumeResultSchema>;

export type TaskView = z.infer<typeof TaskViewSchema>;
export type TaskStepView = z.infer<typeof TaskStepSchema>;

/* license:activate —— 激活（M0 本地注入路径：main 进程离线验签 + license 文件持久化；不联网，02 §9.5 联网流归 M5） */
export const LicenseActivateParamsSchema = z.strictObject({
  /** 兑换签发/换发的 Ed25519 license JWT（紧凑三段式） */
  licenseJwt: z.string().min(1).max(8000),
});

export const LicenseStatusParamsSchema = z.strictObject({});

/** license 状态机出口（license:activate / license:status 共用；renderer 据此渲染锁定态，FR-1.5/1.6） */
export const LicenseStatusResultSchema = z.object({
  state: z.enum(['unlocked', 'locked']),
  /** 稳定 reason 码：WITHIN_GRACE / NO_LICENSE / ALG_REJECTED / EXPIRED / GRACE_EXCEEDED ... */
  reason: z.string().min(1),
  plan: z.string().optional(),
  tier: z.string().optional(),
  deviceLimit: z.number().int().positive().optional(),
  expiresAt: z.string().optional(),
  lastVerifiedAt: z.string().optional(),
  graceEndsAt: z.string().optional(),
  deviceHash: z.string().optional(),
  licenseDeviceHash: z.string().optional(),
});

export type KeysSetParams = z.infer<typeof KeysSetParamsSchema>;
export type KeysSetResult = z.infer<typeof KeysSetResultSchema>;
export type KeysGetMaskedResult = z.infer<typeof KeysGetMaskedResultSchema>;
export type KeyMaskedEntry = z.infer<typeof KeyMaskedEntrySchema>;
export type KeysTestParams = z.infer<typeof KeysTestParamsSchema>;
export type KeysTestResult = z.infer<typeof KeysTestResultSchema>;
export type KeysPrecallConfirmParams = z.infer<typeof KeysPrecallConfirmParamsSchema>;
export type KeysPrecallConfirmResult = z.infer<typeof KeysPrecallConfirmResultSchema>;
export type KeysScanTestParams = z.infer<typeof KeysScanTestParamsSchema>;
export type KeysScanTestResult = z.infer<typeof KeysScanTestResultSchema>;
export type KeywordHitView = z.infer<typeof KeywordHitViewSchema>;

export type NotesListParams = z.infer<typeof NotesListParamsSchema>;
export type NotesListResult = z.infer<typeof NotesListResultSchema>;
export type NoteView = z.infer<typeof NoteViewSchema>;
export type ReportsListResult = z.infer<typeof ReportsListResultSchema>;
export type ReportSummary = z.infer<typeof ReportSummarySchema>;
export type ReportGetResult = z.infer<typeof ReportGetResultSchema>;
export type KeywordFilterView = z.infer<typeof KeywordFilterViewSchema>;
export type ReportChartDataResult = z.infer<typeof ReportChartDataResultSchema>;
export type ReportExportPdfResult = z.infer<typeof ReportExportPdfResultSchema>;
export type ReportInsertFixtureParams = z.infer<typeof ReportInsertFixtureParamsSchema>;
export type GateView = z.infer<typeof GateViewSchema>;
export type GateListResult = z.infer<typeof GateListResultSchema>;
export type GateConfirmParams = z.infer<typeof GateConfirmParamsSchema>;
export type GateConfirmResult = z.infer<typeof GateConfirmResultSchema>;
export type GateRejectParams = z.infer<typeof GateRejectParamsSchema>;
export type GateRejectResult = z.infer<typeof GateRejectResultSchema>;

export type AppInfoParams = z.infer<typeof AppInfoParamsSchema>;
export type AppInfoResult = z.infer<typeof AppInfoResultSchema>;
export type NavigateParams = z.infer<typeof NavigateParamsSchema>;
export type NavigateResult = z.infer<typeof NavigateResultSchema>;
export type LogsPingParams = z.infer<typeof LogsPingParamsSchema>;
export type LogsPingResult = z.infer<typeof LogsPingResultSchema>;
export type LicenseActivateParams = z.infer<typeof LicenseActivateParamsSchema>;
export type LicenseStatusParams = z.infer<typeof LicenseStatusParamsSchema>;
export type LicenseStatusResult = z.infer<typeof LicenseStatusResultSchema>;

export type BrowserSessionState = z.infer<typeof BrowserStatusResultSchema>['state'];
export type BrowserStatusResult = z.infer<typeof BrowserStatusResultSchema>;
export type BrowserInstallBuiltinResult = z.infer<typeof BrowserInstallBuiltinResultSchema>;
export type BrowserOpenPlatformParams = z.infer<typeof BrowserOpenPlatformParamsSchema>;
export type BrowserOpenPlatformResult = z.infer<typeof BrowserOpenPlatformResultSchema>;
export type BrowserDisconnectResult = z.infer<typeof BrowserDisconnectResultSchema>;

/* consent:* —— 合规同意门（todo 9 = T-M0-11：FR-1.9 EULA 首启确认 / FR-12.6 遥测 opt-in） */

export const ConsentStateParamsSchema = z.strictObject({});
export const ConsentAcceptParamsSchema = z.strictObject({
  /** 弹窗内遥测勾选（独立于 EULA 同意；默认不勾 = opt-in） */
  telemetryConsent: z.boolean(),
});
export const ConsentRejectParamsSchema = z.strictObject({});
export const ConsentSetTelemetryParamsSchema = z.strictObject({
  enabled: z.boolean(),
});

/**
 * consent 门态统一出口（四个 consent 通道共用；renderer 据此渲染弹窗/路由锁/遥测开关）。
 * eulaStatus：unconfirmed=无记录（首启）；accepted=已确认当前版；
 * rejected=已拒绝当前版；version-changed=有记录但版本不匹配（重确认）。
 */
export const ConsentStateResultSchema = z.object({
  eulaVersion: z.string().min(1),
  eulaStatus: z.enum(['unconfirmed', 'accepted', 'rejected', 'version-changed']),
  requiresConfirm: z.boolean(),
  confirmedVersion: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  telemetryConsent: z.enum(['granted', 'denied', 'unasked']),
});

export type ConsentStateResult = z.infer<typeof ConsentStateResultSchema>;
export type ConsentAcceptParams = z.infer<typeof ConsentAcceptParamsSchema>;
export type ConsentSetTelemetryParams = z.infer<typeof ConsentSetTelemetryParamsSchema>;

/* browser:* —— 受控浏览器接管（todo 10 = T-M0-08；FR-3.1/3.2/3.4/3.5） */

export const BROWSER_SESSION_STATES_SCHEMA = ['detached', 'attached', 'login-expired'] as const;

/** 三态标题栏出口（FR-3.5：未接管/已接管/登录失效）+ 让位标志（FR-4.5） */
export const BrowserStatusParamsSchema = z.strictObject({});

export const BrowserStatusResultSchema = z.object({
  state: z.enum(BROWSER_SESSION_STATES_SCHEMA),
  /** FR-4.5 人工输入让位：M0 为状态标志 + 机制测试钩子（无业务自动化，见 notes-browser-m0.md） */
  yielded: z.boolean(),
  yieldReason: z.string().nullable(),
  /** 真实 CDP 往返回填（Browser.getVersion 的 product 字段，如 "Chrome/154.0.8037.98"） */
  browserVersion: z.string().nullable(),
  browserPid: z.number().int().nullable(),
  browserPath: z.string().nullable(),
  /** M2 B2：内置便携 Chromium 为探测链第二优先（user-setting → builtin → chrome → edge） */
  browserSource: z.enum(['user-setting', 'builtin', 'registry', 'path-probe']).nullable(),
  profileDir: z.string(),
  currentPlatform: z.enum(BROWSER_PLATFORMS).nullable(),
  /** 最近一次 Target.getTargets 真实往返的 page 目标（「已接管」断言证据面） */
  openTabs: z.array(z.object({ targetId: z.string(), url: z.string() })).nullable(),
  attachedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** M2 B2：内置浏览器安装状态（进度经 1s 轮询回流；主进程未装配内置链路时为 null） */
  builtinInstall: z
    .object({
      state: z.enum(['idle', 'downloading', 'extracting', 'installed', 'failed']),
      receivedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
      error: z.string().nullable(),
    })
    .nullable(),
});

export const BrowserInstallBuiltinParamsSchema = z.strictObject({});

export const BrowserInstallBuiltinResultSchema = z.strictObject({
  /** true = 本次调用已触发安装；false = 已在安装中/已安装（state 给出现状） */
  started: z.boolean(),
  state: z.enum(['idle', 'downloading', 'extracting', 'installed', 'failed']),
});

export const BrowserOpenPlatformParamsSchema = z.strictObject({ platform: z.enum(BROWSER_PLATFORMS) });

export const BrowserOpenPlatformResultSchema = z.object({
  ok: z.literal(true),
  state: z.enum(BROWSER_SESSION_STATES_SCHEMA),
  platform: z.enum(BROWSER_PLATFORMS),
  url: z.string(),
  targetId: z.string().nullable(),
  /** 本次调用是否新拉起了浏览器进程（false = 复用既有接管会话） */
  launchedNow: z.boolean(),
  browserVersion: z.string().nullable(),
});

export const BrowserDisconnectParamsSchema = z.strictObject({});

export const BrowserDisconnectResultSchema = z.object({
  ok: z.literal(true),
  state: z.literal('detached'),
  /** ADR 断开语义：CDP 连接 + 浏览器进程一并关闭（登录态留在 Profile，见 notes-browser-m0.md §3） */
  browserClosed: z.boolean(),
});

/* keys:* —— BYOK Key 配置（m1 todo 10 = T-M1-08①；FR-2.1/FR-2.7/PC-03①） */

/** Key 存储形态（出口字段）：safeStorage=OS 级加密；plaintext-fallback=显式降级（带告警） */
export const KEY_ENCRYPTION_MODES_SCHEMA = ['safeStorage', 'plaintext-fallback'] as const;

export const KeysSetParamsSchema = z
  .strictObject({
    provider: z.enum(KEY_PROVIDER_IDS),
    /** API Key 全值（仅主进程经 safeStorage 加密落 kv_config；masked 读回 sk-****+后 4 位） */
    key: z.string().min(8).max(400),
    /** FR-2.4 备用 Key（同 provider；主 Key 401/403 时网关单调轮换；逐把独立加密） */
    backupKeys: z.array(z.string().min(8).max(400)).max(5).optional(),
    /** 自定义网关 base_url（custom 必填；预设五家可覆盖官方默认） */
    baseUrl: z.string().url().max(300).optional(),
    /** 测试连接/后续调用用的模型名（custom 必填；预设五家有缺省表） */
    model: z.string().min(1).max(120).optional(),
  })
  .superRefine((params, ctx) => {
    if (params.provider === 'custom' && !params.baseUrl) {
      ctx.addIssue({ code: 'custom', message: 'provider=custom 时必须提供 baseUrl（自定义网关）', path: ['baseUrl'] });
    }
  });

export const KeysSetResultSchema = z.object({
  provider: z.enum(KEY_PROVIDER_IDS),
  /** 仅 masked（sk-****+后 4 位）；全值永不回渲染层 */
  masked: z.string(),
  /** FR-2.4 备用 Key 的 masked 列表（保存几把回显几把） */
  backupMasked: z.array(z.string()).default([]),
  encryption: z.enum(KEY_ENCRYPTION_MODES_SCHEMA),
  /** 明文降级时非空：界面告警 toast 文案（绝不静默） */
  warning: z.string().optional(),
});

export const KeysGetMaskedParamsSchema = z.strictObject({});

/** 单服务商 masked 读回项（未配置=各字段 null）；任何字段都不含 Key 全值 */
export const KeyMaskedEntrySchema = z.object({
  provider: z.enum(KEY_PROVIDER_IDS),
  masked: z.string().nullable(),
  backupMasked: z.array(z.string()).default([]),
  encryption: z.enum(KEY_ENCRYPTION_MODES_SCHEMA).nullable(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  setAt: z.string().nullable(),
});

export const KeysGetMaskedResultSchema = z.object({ keys: z.array(KeyMaskedEntrySchema) });

export const KeysTestParamsSchema = z.strictObject({
  provider: z.enum(KEY_PROVIDER_IDS),
  /** 运行时覆盖（custom 未存 baseUrl 时必传） */
  baseUrl: z.string().url().max(300).optional(),
  model: z.string().min(1).max(120).optional(),
});

export const KeysTestResultSchema = z.object({
  ok: z.boolean(),
  provider: z.enum(KEY_PROVIDER_IDS),
  model: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  httpStatus: z.number().int().nullable(),
  /** 稳定摘要（不含 Key、不含请求头、不含原始响应体——防机密回显） */
  error: z.string().nullable(),
});

export const KeysPrecallConfirmParamsSchema = z.strictObject({
  provider: z.enum(KEY_PROVIDER_IDS),
  /** check=查询是否需弹；confirm=用户确认（本会话该 provider 不再弹）；reset=设置页重置提示状态 */
  action: z.enum(['check', 'confirm', 'reset']),
});

export const KeysPrecallConfirmResultSchema = z.object({ needConfirm: z.boolean() });

export const KeysScanTestParamsSchema = z
  .strictObject({
    text: z.string().min(1).max(20000).optional(),
    keywords: z.array(z.string().min(1).max(100)).max(50).optional(),
    topicId: z.string().min(1).max(64).optional(),
  })
  .superRefine((params, ctx) => {
    if (!params.text && !params.keywords) {
      ctx.addIssue({ code: 'custom', message: 'text 与 keywords 至少提供其一', path: ['text'] });
    }
  });

export const KeywordHitViewSchema = z.object({
  term: z.string(),
  category: z.string().nullable(),
  kind: z.enum(['extreme', 'redirect', 'blacklist']),
  source: z.enum(['text', 'keyword']),
});

export const KeysScanTestResultSchema = z.object({
  wordlistVersion: z.string(),
  hits: z.array(KeywordHitViewSchema),
  /** 落 keyword_hits 行数（wordlist_version 随行持久化） */
  persisted: z.number().int(),
});

/* notes:/reports:/report:/gate: —— 报告 UI + 确认闸门（m1 todo 11 = T-M1-06；FR-4.6/5.3/5.4、02:274 E 步） */

export const NotesListParamsSchema = z.strictObject({
  topicId: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const NoteViewSchema = z.object({
  id: z.number().int(),
  noteId: z.string(),
  title: z.string().nullable(),
  author: z.unknown(),
  likes: z.number().int(),
  collects: z.number().int(),
  comments: z.number().int(),
  publishedAt: z.string().nullable(),
  collectedAt: z.string(),
});

export const NotesListResultSchema = z.object({ notes: z.array(NoteViewSchema) });

export const ReportsListParamsSchema = z.strictObject({});

export const ReportSummarySchema = z.object({
  id: z.number().int(),
  topic: z.string(),
  createdAt: z.string(),
  model: z.string().nullable(),
  tokenCost: z.number().int().nullable(),
});

export const ReportsListResultSchema = z.object({ reports: z.array(ReportSummarySchema) });

export const ReportGetParamsSchema = z.strictObject({ reportId: z.number().int().min(1) });

/** ⑦章黑名单过滤面（命中词剔除 + keyword_hits 留痕计数；wordlist_version 随行） */
export const KeywordFilterViewSchema = z.object({
  allowed: z.array(z.string()),
  removed: z.array(
    z.object({
      bullet: z.string(),
      term: z.string(),
      kind: z.string(),
      category: z.string().nullable(),
    }),
  ),
  wordlistVersion: z.string().nullable(),
  persisted: z.number().int(),
});

export const ReportGetResultSchema = z.object({
  reportId: z.number().int(),
  /** 八章节 JSON（结构校验在渲染层 error boundary——渲染 bundle 不携带 zod） */
  report: z.unknown().nullable(),
  contentMd: z.string().nullable(),
  keywordFilter: KeywordFilterViewSchema.nullable(),
});

export const ReportChartDataParamsSchema = z.strictObject({ reportId: z.number().int().min(1) });

export const ReportChartDataResultSchema = z.object({
  sampleSize: z.number().int(),
  clusters: z.array(
    z.object({
      label: z.string(),
      size: z.number().int(),
      avgLikes: z.number(),
      avgCollects: z.number(),
      topTerms: z.array(z.string()),
    }),
  ),
  priceBuckets: z.object({ ranges: z.array(z.string()), counts: z.array(z.number().int()) }),
  wordcloud: z.array(z.object({ term: z.string(), weight: z.number() })),
});

export const ReportExportPdfParamsSchema = z.strictObject({});

export const ReportExportPdfResultSchema = z.object({
  /** webContents.printToPDF 产物的 base64（渲染层解码为 Blob 下载；禁第三方 PDF 库） */
  dataBase64: z.string(),
});

/** QA failure 组专用（XINGLIAN_DEBUG_HOOKS=1 才装配）：注入缺⑧章的 mock 报告 → error boundary 断言 */
export const ReportInsertFixtureParamsSchema = z.strictObject({
  topic: z.string().min(1).max(120),
  report: z.unknown(),
  contentMd: z.string().max(2_000_000).optional(),
});

export const ReportInsertFixtureResultSchema = z.object({ id: z.number().int() });

/** 闸门类型枚举（两值；02:274 E 步 + Key 未配置分支——文档化契约） */
export const GATE_TYPES_SCHEMA = ['keyword_confirm', 'llm_key_config'] as const;

export const GateListParamsSchema = z.strictObject({});

export const GateViewSchema = z.object({
  taskId: z.string(),
  kind: z.string(),
  status: z.enum(TASK_STATUSES_SCHEMA),
  gate: z.enum(GATE_TYPES_SCHEMA),
  reportId: z.number().int().nullable(),
  topicId: z.string().nullable(),
  topic: z.string().nullable(),
  createdAt: z.string(),
  keywords: KeywordFilterViewSchema.nullable(),
});

export const GateListResultSchema = z.object({ gates: z.array(GateViewSchema) });

export const GateConfirmParamsSchema = z.strictObject({ taskId: z.string().min(1).max(64) });

export const GateConfirmResultSchema = z.object({
  /** false = 幂等 no-op（同 idempotency_key 的 selection 占位已存在，行数不变） */
  created: z.boolean(),
  selectionTaskId: z.string().nullable(),
  idempotencyKey: z.string(),
});

export const GateRejectParamsSchema = z.strictObject({ taskId: z.string().min(1).max(64) });

export const GateRejectResultSchema = z.object({ taskId: z.string(), status: z.enum(TASK_STATUSES_SCHEMA) });

/* selection:* —— 候选清单 UI（05 T-M2-03；FR-6.2 权重可调 / FR-6.3 对比表格） */

/** 权重表：五维齐全、0-100 整数（相对权重，重算时归一化——Σw=0 视为非法由 refine 拦截） */
export const SelectionWeightsSchema = z
  .record(z.enum(SELECTION_DIMENSIONS_SCHEMA), z.number().int().min(0).max(100))
  .refine((weights) => {
    const values = SELECTION_DIMENSIONS_SCHEMA.map((id) => weights[id] ?? 0);
    return values.some((v) => v > 0);
  }, '五维权重不能全为 0');

export type SelectionWeights = z.infer<typeof SelectionWeightsSchema>;

export const SelectionListParamsSchema = z.strictObject({});

/** 选品任务卡（selection:list 出口；excludedJunk 高企 = 匿名检索推荐流的「需登录」诚实信号） */
export const SelectionSummarySchema = z.object({
  taskId: z.string(),
  topic: z.string(),
  topicId: z.string().nullable(),
  /** 闸门放行的检索词（term——理由 复合格式原样） */
  keywords: z.array(z.string()),
  status: z.enum(TASK_STATUSES_SCHEMA),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** selection-persist 步骤产出的落库候选数（TopN 口径） */
  candidateCount: z.number().int().nonnegative(),
  /** stats kv 聚合的推荐流剔除数（需登录信号；任务未跑到 score/persist 时为 null） */
  excludedJunk: z.number().int().nonnegative().nullable(),
  generatedAt: z.string().nullable(),
});

export const SelectionListResultSchema = z.object({ selections: z.array(SelectionSummarySchema) });

export const SelectionCandidatesParamsSchema = z.strictObject({ taskId: z.string().min(1).max(64) });

/** 候选行（store SourcingCandidateRowView 镜像；dimensions = DimensionScore[] 含 reason） */
export const SelectionCandidateViewSchema = z.object({
  id: z.number().int(),
  taskId: z.string(),
  selectionId: z.string(),
  rank: z.number().int(),
  offerId: z.string(),
  keyword: z.string(),
  total: z.number(),
  dimensions: z.unknown(),
  title: z.string(),
  priceText: z.string().nullable(),
  salesText: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierAddress: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  createdAt: z.string(),
});

export const SelectionCandidatesResultSchema = z.object({
  candidates: z.array(SelectionCandidateViewSchema),
  /** 该任务置顶的 offerId 集（kv `selection:pinned:<taskId>`） */
  pinned: z.array(z.string()),
});

export const SelectionConfigParamsSchema = z.strictObject({});

export const SelectionDimensionMetaSchema = z.object({
  id: z.enum(SELECTION_DIMENSIONS_SCHEMA),
  title: z.string(),
  /** Agent 默认权重（0-100 整数形态，如 relevance=30） */
  default: z.number().int().min(0).max(100),
});

export const SelectionConfigResultSchema = z.object({
  dimensions: z.array(SelectionDimensionMetaSchema),
  weights: SelectionWeightsSchema,
  /** 用户是否已保存过自定义权重（kv 有记录即 true） */
  customized: z.boolean(),
});

export const SelectionSetWeightsParamsSchema = z.strictObject({ weights: SelectionWeightsSchema });

export const SelectionSetWeightsResultSchema = SelectionConfigResultSchema;

export const SelectionSetPinnedParamsSchema = z.strictObject({
  taskId: z.string().min(1).max(64),
  offerId: z.string().min(1).max(64),
  pinned: z.boolean(),
});

export const SelectionSetPinnedResultSchema = z.object({
  taskId: z.string(),
  offerIds: z.array(z.string()),
});

/** QA 播种专用（XINGLIAN_DEBUG_HOOKS=1 才装配）：直接落 completed 任务 + 候选 + 三步 + stats */
export const SelectionInsertFixtureParamsSchema = z.strictObject({
  topic: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1).max(200)).min(1).max(5),
  candidates: z
    .array(
      z.strictObject({
        offerId: z.string().min(1).max(64),
        keyword: z.string().min(1).max(200),
        title: z.string().min(1).max(500),
        priceText: z.string().max(100).optional(),
        salesText: z.string().max(100).optional(),
        supplierName: z.string().max(200).optional(),
        supplierAddress: z.string().max(300).optional(),
        sourceUrl: z.string().max(500).optional(),
        /** 缺省由服务生成确定性五维分（含 reason），保证 e2e 可预测 */
        dimensions: z.array(z.strictObject({ name: z.enum(SELECTION_DIMENSIONS_SCHEMA), title: z.string(), score: z.number().min(0).max(100), weight: z.number(), reason: z.string() })).optional(),
        total: z.number().min(0).max(100).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const SelectionInsertFixtureResultSchema = z.object({ taskId: z.string(), inserted: z.number().int() });

export type SelectionListResult = z.infer<typeof SelectionListResultSchema>;
export type SelectionSummary = z.infer<typeof SelectionSummarySchema>;
export type SelectionCandidatesParams = z.infer<typeof SelectionCandidatesParamsSchema>;
export type SelectionCandidatesResult = z.infer<typeof SelectionCandidatesResultSchema>;
export type SelectionCandidateView = z.infer<typeof SelectionCandidateViewSchema>;
export type SelectionConfigResult = z.infer<typeof SelectionConfigResultSchema>;
export type SelectionDimensionMeta = z.infer<typeof SelectionDimensionMetaSchema>;
export type SelectionSetWeightsParams = z.infer<typeof SelectionSetWeightsParamsSchema>;
export type SelectionSetWeightsResult = z.infer<typeof SelectionSetWeightsResultSchema>;
export type SelectionSetPinnedParams = z.infer<typeof SelectionSetPinnedParamsSchema>;
export type SelectionSetPinnedResult = z.infer<typeof SelectionSetPinnedResultSchema>;
export type SelectionInsertFixtureParams = z.infer<typeof SelectionInsertFixtureParamsSchema>;
export type SelectionInsertFixtureResult = z.infer<typeof SelectionInsertFixtureResultSchema>;

/* usage:* —— FR-2.5 用量面板 + FR-2.6 全局 RPM（m1 todo 12；聚合数据源=llm_calls 计量元数据） */

export const UsageSummaryParamsSchema = z.strictObject({
  /** 统计窗口天数（默认 30，1~365） */
  days: z.number().int().min(1).max(365).optional(),
});

export const UsageBucketSchema = z.object({
  key: z.string(),
  calls: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /** 网关已知成本（GatewayConfig.pricing 注入时 llm_calls 自带） */
  costKnown: z.number(),
  /** 自填单价估算成本（usage:setPricing） */
  costEstimated: z.number(),
  /** 无任何定价依据的调用数（不造数，显式计数） */
  unestimatedCalls: z.number().int().nonnegative(),
});

export const UsageSummaryResultSchema = z.object({
  sinceDays: z.number().int().min(1).max(365),
  totals: UsageBucketSchema,
  byDay: z.array(UsageBucketSchema),
  byWorkflow: z.array(UsageBucketSchema),
  byProviderModel: z.array(UsageBucketSchema),
  pricing: z.record(z.string(), z.object({ inputPer1k: z.number().nonnegative().optional(), outputPer1k: z.number().nonnegative().optional() })),
  /** FR-2.6 全局 RPM（0=不限流） */
  rpmGlobal: z.number().int().nonnegative(),
  /** 能力矩阵探测档展示（04:63；tierSource=documented 时 UI 显示「文档源，待实测」角标，R9） */
  providers: z.array(
    z.object({
      provider: z.string(),
      label: z.string(),
      tier: z.string(),
      tierSource: z.enum(['documented', 'probed', 'network-unreachable']),
      reachability: z.string(),
    }),
  ),
});

export const UsageSetPricingParamsSchema = z.strictObject({
  pricing: z.record(z.string(), z.object({ inputPer1k: z.number().nonnegative().optional(), outputPer1k: z.number().nonnegative().optional() })),
});
export const UsageSetPricingResultSchema = z.object({ set: z.boolean() });

export const UsageSetRpmParamsSchema = z.strictObject({
  /** 每分钟请求上限；0=不限流（FR-2.6） */
  rpm: z.number().int().min(0).max(10000),
});
export const UsageSetRpmResultSchema = z.object({ set: z.boolean() });

export type UsageSummaryParams = z.infer<typeof UsageSummaryParamsSchema>;
export type UsageSummaryResult = z.infer<typeof UsageSummaryResultSchema>;
export type UsageSetPricingParams = z.infer<typeof UsageSetPricingParamsSchema>;
export type UsageSetPricingResult = z.infer<typeof UsageSetPricingResultSchema>;
export type UsageSetRpmParams = z.infer<typeof UsageSetRpmParamsSchema>;
export type UsageSetRpmResult = z.infer<typeof UsageSetRpmResultSchema>;

/** 通道 → 入参 schema。preload 与 main 侧都从这里取，保证两侧校验一致。 */
export const channelParamsSchemas: Record<IpcChannel, z.ZodType> = {
  'app:info': AppInfoParamsSchema,
  'app:navigate': NavigateParamsSchema,
  'browser:disconnect': BrowserDisconnectParamsSchema,
  'browser:installBuiltin': BrowserInstallBuiltinParamsSchema,
  'browser:openPlatform': BrowserOpenPlatformParamsSchema,
  'browser:status': BrowserStatusParamsSchema,
  'circuit:status': CircuitStatusParamsSchema,
  'circuit:confirmResume': CircuitConfirmResumeParamsSchema,
  'collect:remainders': z.strictObject({}),
  'collect:start': CollectStartParamsSchema,
  'collect:stats': CollectStatsParamsSchema,
  'consent:state': ConsentStateParamsSchema,
  'consent:acceptEula': ConsentAcceptParamsSchema,
  'consent:rejectEula': ConsentRejectParamsSchema,
  'consent:setTelemetry': ConsentSetTelemetryParamsSchema,
  'keys:get-masked': KeysGetMaskedParamsSchema,
  'keys:precall-confirm': KeysPrecallConfirmParamsSchema,
  'keys:scan-test': KeysScanTestParamsSchema,
  'keys:set': KeysSetParamsSchema,
  'keys:test': KeysTestParamsSchema,
  'logs:ping': LogsPingParamsSchema,
  'logs:query': LogsQueryParamsSchema,
  'license:activate': LicenseActivateParamsSchema,
  'license:status': LicenseStatusParamsSchema,
  'notes:list': NotesListParamsSchema,
  'report:chartData': ReportChartDataParamsSchema,
  'report:exportPdf': ReportExportPdfParamsSchema,
  'report:insertFixture': ReportInsertFixtureParamsSchema,
  'reports:get': ReportGetParamsSchema,
  'reports:list': ReportsListParamsSchema,
  'gate:confirm': GateConfirmParamsSchema,
  'gate:list': GateListParamsSchema,
  'gate:reject': GateRejectParamsSchema,
  'selection:candidates': SelectionCandidatesParamsSchema,
  'selection:config': SelectionConfigParamsSchema,
  'selection:insertFixture': SelectionInsertFixtureParamsSchema,
  'selection:list': SelectionListParamsSchema,
  'selection:setPinned': SelectionSetPinnedParamsSchema,
  'selection:setWeights': SelectionSetWeightsParamsSchema,
  'tasks:createDemo': TasksCreateDemoParamsSchema,
  'tasks:list': TasksListParamsSchema,
  'tasks:pause': TasksPauseParamsSchema,
  'tasks:resume': TasksResumeParamsSchema,
  'tasks:cancel': TasksCancelParamsSchema,
  'usage:setPricing': UsageSetPricingParamsSchema,
  'usage:setRpm': UsageSetRpmParamsSchema,
  'usage:summary': UsageSummaryParamsSchema,
};
