/**
 * IPC 契约 zod schema（02-系统架构设计.md §4.3：所有 IPC 走 invoke/handle，
 * 通道即契约，入参用 zod 校验——preload 侧与 ipcMain.handle 侧共用本文件）。
 */
import { z } from 'zod';
import { BROWSER_PLATFORMS, NAV_VIEWS, type IpcChannel } from './channels';

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

/* tasks:* —— demo 任务（D7 最小运行器；门禁④演示载体） */
export const TASK_STATUSES_SCHEMA = [
  'idle',
  'running',
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
  browserSource: z.enum(['user-setting', 'registry', 'path-probe']).nullable(),
  profileDir: z.string(),
  currentPlatform: z.enum(BROWSER_PLATFORMS).nullable(),
  /** 最近一次 Target.getTargets 真实往返的 page 目标（「已接管」断言证据面） */
  openTabs: z.array(z.object({ targetId: z.string(), url: z.string() })).nullable(),
  attachedAt: z.string().nullable(),
  lastError: z.string().nullable(),
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

/** 通道 → 入参 schema。preload 与 main 侧都从这里取，保证两侧校验一致。 */
export const channelParamsSchemas: Record<IpcChannel, z.ZodType> = {
  'app:info': AppInfoParamsSchema,
  'app:navigate': NavigateParamsSchema,
  'browser:disconnect': BrowserDisconnectParamsSchema,
  'browser:openPlatform': BrowserOpenPlatformParamsSchema,
  'browser:status': BrowserStatusParamsSchema,
  'consent:state': ConsentStateParamsSchema,
  'consent:acceptEula': ConsentAcceptParamsSchema,
  'consent:rejectEula': ConsentRejectParamsSchema,
  'consent:setTelemetry': ConsentSetTelemetryParamsSchema,
  'logs:ping': LogsPingParamsSchema,
  'logs:query': LogsQueryParamsSchema,
  'license:activate': LicenseActivateParamsSchema,
  'license:status': LicenseStatusParamsSchema,
  'tasks:createDemo': TasksCreateDemoParamsSchema,
  'tasks:list': TasksListParamsSchema,
  'tasks:resume': TasksResumeParamsSchema,
  'tasks:cancel': TasksCancelParamsSchema,
};
