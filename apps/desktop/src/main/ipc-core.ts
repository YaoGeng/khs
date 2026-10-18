/**
 * IPC 注册表与入参校验核心（纯逻辑，不 import electron，vitest 可直接单测）。
 * 02 §4.3：所有 IPC 走 invoke/handle，通道即契约，入参 zod 校验。
 */
import { z } from 'zod';
import { E_EULA_LOCKED, IPC_CHANNELS, IPC_ERRORS, type IpcChannel } from '../shared/channels';
import {
  AppInfoResultSchema,
  AutomationTierResultSchema,
  BrowserDisconnectResultSchema,
  BrowserInstallBuiltinResultSchema,
  BrowserOpenPlatformResultSchema,
  BrowserStatusResultSchema,
  channelParamsSchemas,
  CircuitConfirmResumeResultSchema,
  CircuitStatusResultSchema,
  CollectRemaindersResultSchema,
  CollectStartParams,
  CollectStatsParams,
  CollectStatsResultSchema,
  ConsentStateResultSchema,
  GateConfirmResultSchema,
  GateListResultSchema,
  GateRejectResultSchema,
  KeysGetMaskedResultSchema,
  KeysPrecallConfirmResultSchema,
  KeysScanTestResultSchema,
  KeysSetResultSchema,
  KeysTestResultSchema,
  LicenseStatusResultSchema,
  LogsQueryResultSchema,
  MirrorStartResultSchema,
  MirrorStopResultSchema,
  NotesListResultSchema,
  OutreachDecideResultSchema,
  OutreachStartResultSchema,
  OutreachStatusResultSchema,
  ProductsListResultSchema,
  ProductsOpenSourceResultSchema,
  SourcingAkClearResultSchema,
  SourcingAkSetResultSchema,
  SourcingAkStatusResultSchema,
  SelectionSetCheckedResultSchema,
  ReportChartDataResultSchema,
  ReportExportPdfResultSchema,
  ReportGetResultSchema,
  ReportsListResultSchema,
  SelectionCandidatesResultSchema,
  SelectionConfigResultSchema,
  SelectionInsertFixtureResultSchema,
  SelectionListResultSchema,
  SelectionSetPinnedResultSchema,
  SelectionSetWeightsResultSchema,
  TasksCancelResultSchema,
  TasksCreateDemoResultSchema,
  TasksListResultSchema,
  TasksResumeResultSchema,
  UsageSetPricingResultSchema,
  UsageSetRpmResultSchema,
  UsageSummaryResultSchema,
  ViralGenerateRationaleResultSchema,
  ViralListResultSchema,
  ViralRefreshResultSchema,
  type AppInfoResult,
  type AutomationGetTierResult,
  type AutomationSetTierParams,
  type AutomationSetTierResult,
  type BrowserDisconnectResult,
  type BrowserInstallBuiltinResult,
  type BrowserOpenPlatformParams,
  type BrowserOpenPlatformResult,
  type BrowserStatusResult,
  type CircuitConfirmResumeResult,
  type CircuitStatusResult,
  type CollectRemaindersResult,
  type CollectStatsResult,
  type ConsentStateResult,
  type GateConfirmParams,
  type GateConfirmResult,
  type GateListResult,
  type GateRejectParams,
  type GateRejectResult,
  type KeysGetMaskedResult,
  type KeysPrecallConfirmParams,
  type KeysPrecallConfirmResult,
  type KeysScanTestParams,
  type KeysScanTestResult,
  type KeysSetParams,
  type KeysSetResult,
  type KeysTestParams,
  type KeysTestResult,
  type LicenseActivateParams,
  type LicenseStatusResult,
  type LogsQueryParams,
  type LogsQueryResult,
  type NotesListParams,
  type NotesListResult,
  type OutreachDecideParams,
  type OutreachDecideResult,
  type OutreachStartParams,
  type ProductsListParams,
  type ProductsOpenSourceParams,
  type SourcingAkClearParams,
  type SourcingAkClearResult,
  type SourcingAkSetParams,
  type SourcingAkSetResult,
  type SourcingAkStatusParams,
  type SourcingAkStatusResult,
  type ReportChartDataResult,
  type ReportExportPdfResult,
  type ReportGetResult,
  type ReportInsertFixtureParams,
  type ReportsListResult,
  type OutreachStartResult,
  type OutreachStatusResult,
  type ProductsListResult,
  type ProductsOpenSourceResult,
  type SelectionCandidatesParams,
  type SelectionCandidatesResult,
  type SelectionConfigResult,
  type SelectionInsertFixtureParams,
  type SelectionInsertFixtureResult,
  type SelectionListResult,
  type SelectionSetCheckedParams,
  type SelectionSetCheckedResult,
  type SelectionSetPinnedParams,
  type SelectionSetPinnedResult,
  type SelectionSetWeightsParams,
  type SelectionSetWeightsResult,
  type TasksListResult,
  type UsageSetPricingParams,
  type UsageSetPricingResult,
  type UsageSetRpmParams,
  type UsageSetRpmResult,
  type UsageSummaryParams,
  type UsageSummaryResult,
  type ViralGenerateRationaleParams,
  type ViralGenerateRationaleResult,
  type ViralListParams,
  type ViralListResult,
  type ViralRefreshParams,
  type ViralRefreshResult,
} from '../shared/schemas';
import { isChannelAllowed } from './security';

export type IpcEntry = {
  readonly paramsSchema: z.ZodType;
  readonly handle: (payload: never) => unknown;
};

export type IpcRegistry = ReadonlyMap<IpcChannel, IpcEntry>;

/** license 链路依赖注入面（main 进程 binding 在 main/license-service.ts；纯 stub 可单测） */
export interface LicenseIpcDeps {
  readonly activate: (params: LicenseActivateParams) => LicenseStatusResult;
  readonly status: () => LicenseStatusResult;
}

/** 日志/任务链路依赖注入面（todo 11；main binding 在 main/store-service.ts；pauseTask 归 todo 7 扩态） */
export interface LogTaskIpcDeps {
  readonly queryLogs: (params: LogsQueryParams) => Promise<LogsQueryResult>;
  readonly createDemoTask: () => Promise<{ taskId: string }>;
  readonly listTasks: () => Promise<TasksListResult>;
  readonly resumeTask: (taskId: string) => Promise<{ taskId: string; status: string }>;
  /** M1 扩态：running→paused（FR-4.5 用户暂停；跨日续采面） */
  readonly pauseTask?: (taskId: string) => Promise<{ taskId: string; status: string }>;
  readonly cancelTask: (taskId: string) => Promise<{ taskId: string; status: string }>;
}

/** 合规链路依赖注入面（todo 9；main binding 在 compliance/compliance-service.ts） */
export interface ConsentDeps {
  readonly state: () => Promise<ConsentStateResult>;
  readonly acceptEula: (params: { telemetryConsent: boolean }) => Promise<ConsentStateResult>;
  readonly rejectEula: () => Promise<ConsentStateResult>;
  readonly setTelemetry: (params: { enabled: boolean }) => Promise<ConsentStateResult>;
  readonly isViewAllowed: (view: string) => boolean;
}

/** 受控浏览器链路依赖注入面（todo 10；main binding 在 browser/browser-service.ts） */
export interface BrowserIpcDeps {
  readonly status: () => Promise<BrowserStatusResult>;
  readonly openPlatform: (params: BrowserOpenPlatformParams) => Promise<BrowserOpenPlatformResult>;
  readonly disconnect: () => Promise<BrowserDisconnectResult>;
  /** M2 B2：内置便携 Chromium 按需安装（未装配时通道显式报未就绪） */
  readonly installBuiltin?: () => Promise<BrowserInstallBuiltinResult>;
  /** M2 产品卡①：应用内镜像预览（screencast 只读投流） */
  readonly startMirror?: () => Promise<{ started: boolean; state: string }>;
  readonly stopMirror?: () => Promise<{ stopped: boolean }>;
}

/** 自动化档位链路依赖注入面（M2 产品卡③；main binding 在 main/automation-tier.ts） */
export interface AutomationIpcDeps {
  readonly getTier: () => Promise<AutomationGetTierResult>;
  readonly setTier: (params: AutomationSetTierParams) => Promise<AutomationSetTierResult>;
}

/** 爆款清单链路依赖注入面（M2 产品卡②；main binding 在 main/viral-service.ts） */
export interface ViralIpcDeps {
  readonly list: (params: ViralListParams) => Promise<ViralListResult>;
  readonly refresh: (params: ViralRefreshParams) => Promise<ViralRefreshResult>;
  readonly generateRationale: (params: ViralGenerateRationaleParams) => Promise<ViralGenerateRationaleResult>;
}

/** 采集/熔断链路依赖注入面（todo 7 = T-M1-04；main binding 在 main/collect-binding.ts） */
export interface CollectIpcDeps {
  readonly start: (params: CollectStartParams) => Promise<{ taskId: string }>;
  readonly remainders: () => Promise<CollectRemaindersResult>;
  readonly stats: (params: CollectStatsParams) => Promise<CollectStatsResult>;
  readonly circuitStatus: () => Promise<CircuitStatusResult>;
  readonly circuitConfirmResume: () => Promise<CircuitConfirmResumeResult>;
}

/** BYOK Key 链路依赖注入面（m1 todo 10 = T-M1-08①；main binding 在 main/key-service.ts） */
export interface KeysIpcDeps {
  readonly setKey: (params: KeysSetParams) => Promise<KeysSetResult>;
  readonly getMasked: () => Promise<KeysGetMaskedResult>;
  /**
   * keys:get-masked 出口断言输入：明文形态 Key 全值列表（仅主进程内存，永不出 IPC）。
   * 出口 handler 对响应 JSON 深扫描该列表，任一全值出现即抛 E-KEY-MASKED-VIOLATION。
   */
  readonly exitAuditRawValues: () => Promise<string[]>;
  readonly test: (params: KeysTestParams) => Promise<KeysTestResult>;
  readonly precallConfirm: (params: KeysPrecallConfirmParams) => Promise<KeysPrecallConfirmResult>;
  readonly scanTest: (params: KeysScanTestParams) => Promise<KeysScanTestResult>;
}

/**
 * 报告 UI + 确认闸门链路依赖注入面（m1 todo 11 = T-M1-06；main binding 在 main.ts →
 * report-service）。读面（notes/reports/chartData/pdf）无需 EULA 门；gate:confirm/reject
 * 是 insight 视图的业务写入口，与 collect:start 同受 EULA 路由锁约束。
 */
export interface ReportIpcDeps {
  readonly listNotes: (params: NotesListParams) => Promise<NotesListResult>;
  readonly listReports: () => Promise<ReportsListResult>;
  readonly getReport: (params: { reportId: number }) => Promise<ReportGetResult>;
  readonly chartData: (params: { reportId: number }) => Promise<ReportChartDataResult>;
  /** main 进程 webContents.printToPDF（03:220 B-6 渲染打印管线；禁 pdf-lib/puppeteer） */
  readonly exportPdf: () => Promise<ReportExportPdfResult>;
  /** 仅 debug 门控装配（XINGLIAN_DEBUG_HOOKS=1）；缺省显式报未就绪 */
  readonly insertFixture?: (params: ReportInsertFixtureParams) => Promise<{ id: number }>;
  readonly listGates: () => Promise<GateListResult>;
  readonly confirmGate: (params: GateConfirmParams) => Promise<GateConfirmResult>;
  readonly rejectGate: (params: GateRejectParams) => Promise<GateRejectResult>;
}

export interface AppInfoDeps {
  /** 注入 app/appVersion 等运行时读取，保持本模块 electron-free 可单测 */
  readonly appInfo: () => AppInfoResult;
  /** todo 8：license 链路（离线验签/锁定状态机）依赖 */
  readonly license: LicenseIpcDeps;
  /** todo 11：store/日志查询 + demo 任务运行器依赖 */
  readonly logTask: LogTaskIpcDeps;
  /** todo 9：EULA 首启确认门 + 遥测 opt-in 依赖 */
  readonly consent: ConsentDeps;
  /** todo 10：受控浏览器接管（三态标题栏/快捷入口/一键断开）依赖 */
  readonly browser: BrowserIpcDeps;
  /** todo 7：采集管道 + 熔断联动（T-M1-04）依赖；未装配时 collect:/circuit: 通道显式报未就绪 */
  readonly collect?: CollectIpcDeps;
  /** m1 todo 10：BYOK Key 链路（T-M1-08①）依赖；未装配时 keys: 通道显式报未就绪 */
  readonly keys?: KeysIpcDeps;
  /** m1 todo 11：报告 UI + 确认闸门（T-M1-06）依赖；未装配时 notes:/reports:/gate: 通道显式报未就绪 */
  readonly report?: ReportIpcDeps;
  /** m1 todo 12：用量面板 + 全局 RPM（FR-2.5/2.6）依赖；未装配时 usage: 通道显式报未就绪 */
  readonly usage?: UsageIpcDeps;
  /** 05 T-M2-03：选品候选清单（FR-6.2/6.3）依赖；未装配时 selection: 通道显式报未就绪 */
  readonly selection?: SelectionIpcDeps;
  /** T-M2-04：收藏/询盘执行依赖；未装配时 outreach: 通道显式报未就绪 */
  readonly outreach?: OutreachIpcDeps;
  /** T-M2-04：商品卡片（FR-6.5）依赖；未装配时 products: 通道显式报未就绪 */
  readonly products?: ProductsIpcDeps;
  /** T-M2-05a：1688 官方 API AK 配置依赖；未装配时 sourcing:ak* 通道显式报未就绪 */
  readonly sourcingAk?: SourcingAkIpcDeps;
  /** M2 产品卡③：自动化档位依赖；未装配时 automation: 通道显式报未就绪 */
  readonly automation?: AutomationIpcDeps;
  /** M2 产品卡②：爆款清单依赖；未装配时 viral: 通道显式报未就绪 */
  readonly viral?: ViralIpcDeps;
}

/**
 * 用量链路依赖注入面（m1 todo 12 = FR-2.5/2.6；main binding 在 main.ts → usage-service）。
 * 读面/设置面均为 settings 视图消费，无需 EULA 门。
 */
export interface UsageIpcDeps {
  readonly summary: (params: UsageSummaryParams) => Promise<UsageSummaryResult>;
  readonly setPricing: (params: UsageSetPricingParams) => Promise<UsageSetPricingResult>;
  readonly setRpm: (params: UsageSetRpmParams) => Promise<UsageSetRpmResult>;
}

/**
 * 选品候选清单链路依赖注入面（05 T-M2-03；main binding 在 main.ts →
 * selection-view-service）。读面（list/candidates/config）与偏好写面（setWeights/
 * setPinned，settings 性质同 usage:set*）均不设 EULA 门；insertFixture 仅 debug 门控装配。
 */
export interface SelectionIpcDeps {
  readonly list: () => Promise<SelectionListResult>;
  readonly candidates: (params: SelectionCandidatesParams) => Promise<SelectionCandidatesResult>;
  readonly config: () => Promise<SelectionConfigResult>;
  readonly setWeights: (params: SelectionSetWeightsParams) => Promise<SelectionSetWeightsResult>;
  readonly setPinned: (params: SelectionSetPinnedParams) => Promise<SelectionSetPinnedResult>;
  /** T-M2-04：FR-6.3 勾选集写面（kv，setPinned 同款设置性质） */
  readonly setChecked: (params: SelectionSetCheckedParams) => Promise<SelectionSetCheckedResult>;
  /** QA 播种专用（XINGLIAN_DEBUG_HOOKS=1 才装配）；缺省显式报未就绪 */
  readonly insertFixture?: (params: SelectionInsertFixtureParams) => Promise<SelectionInsertFixtureResult>;
}

/**
 * 收藏/询盘执行链路依赖注入面（T-M2-04；main binding 在 main.ts → outreach-service）。
 * start = sourcing 视图业务写入口（EULA 门与 collect:start 同口径，FR-1.9）；decide =
 * FR-6.4 红线人工确认的回传面（永远人工，不受 FR-12.7 档位影响）；status 只读。
 */
export interface OutreachIpcDeps {
  readonly start: (params: OutreachStartParams) => Promise<OutreachStartResult>;
  readonly decide: (params: OutreachDecideParams) => Promise<OutreachDecideResult>;
  readonly status: () => Promise<OutreachStatusResult>;
}

/** 商品卡片链路依赖注入面（T-M2-04；FR-6.5）。list 只读不设门；openSource = 打开货源页。 */
export interface ProductsIpcDeps {
  readonly list: (params: ProductsListParams) => Promise<ProductsListResult>;
  readonly openSource: (params: ProductsOpenSourceParams) => Promise<ProductsOpenSourceResult>;
}

/**
 * 1688 官方 API AK 配置链路依赖注入面（T-M2-05a；ak-store main binding）。
 * 设置性质不设 EULA 门（同 usage:set*）；AK 原始串/secret 全值永不出口（schemas 兜底剥离）。
 */
export interface SourcingAkIpcDeps {
  readonly status: (params: SourcingAkStatusParams) => Promise<SourcingAkStatusResult>;
  readonly set: (params: SourcingAkSetParams) => Promise<SourcingAkSetResult>;
  readonly clear: (params: SourcingAkClearParams) => Promise<SourcingAkClearResult>;
}

/** 校验并执行一次 IPC 调用（主进程 handle 与单测共用同一路径） */
export type IpcInvokeResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${at}: ${issue.message}`;
    })
    .join('; ');
}

/** 出口契约校验（async 通道共用：主进程出口数据也必须过 zod，防契约漂移） */
export function validateExit<T>(schema: z.ZodType<T>, data: unknown, channel: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${IPC_ERRORS.INVALID_PARAMS}: ${channel} 出口数据不符合契约 ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * 构建注册表。不变量：注册表键集 === IPC_CHANNELS 白名单（两表靠编译期常量绑定，
 * 运行期再次断言，防止后续开发加通道时漏改白名单）。
 */
export function buildIpcRegistry(deps: AppInfoDeps): IpcRegistry {
  const map = new Map<IpcChannel, IpcEntry>([
    [
      'app:info',
      {
        paramsSchema: channelParamsSchemas['app:info'],
        handle: () => {
          const parsed = AppInfoResultSchema.safeParse(deps.appInfo());
          if (!parsed.success) {
            throw new Error(`${IPC_ERRORS.INVALID_PARAMS}: app:info 出口数据不符合契约 ${formatZodIssues(parsed.error)}`);
          }
          return parsed.data;
        },
      },
    ],
    [
      'app:navigate',
      {
        paramsSchema: channelParamsSchemas['app:navigate'],
        // 入参 zod enum 已把 view 收敛为九视图之一；EULA 门（FR-1.9）在主进程强制：
        // 未确认（或版本变更重确认）时六个工作流视图直接拒绝（稳定码 E-COMPLIANCE-EULA-LOCKED）
        handle: (payload: { view: string }) => {
          if (!deps.consent.isViewAllowed(payload.view)) {
            throw new Error(
              `${E_EULA_LOCKED}: 视图 "${payload.view}" 已被 EULA 首启确认门锁定（FR-1.9）——请先完成《用户协议与隐私政策》确认`,
            );
          }
          return { ok: true as const, view: payload.view };
        },
      },
    ],
    [
      'automation:getTier',
      {
        paramsSchema: channelParamsSchemas['automation:getTier'],
        // 设置性质读面（FR-12.7）：与 usage:summary 同口径不设 EULA 门
        handle: async () => {
          if (!deps.automation) throw new Error('E-IPC-DEP-MISSING: automation 链路未装配');
          return validateExit(AutomationTierResultSchema, await deps.automation.getTier(), 'automation:getTier');
        },
      },
    ],
    [
      'automation:setTier',
      {
        paramsSchema: channelParamsSchemas['automation:setTier'],
        // 设置性质写面：与 usage:set* 同口径不设 EULA 门；档位不改变对外发送人工确认红线
        handle: async (payload: AutomationSetTierParams) => {
          if (!deps.automation) throw new Error('E-IPC-DEP-MISSING: automation 链路未装配');
          return validateExit(AutomationTierResultSchema, await deps.automation.setTier(payload), 'automation:setTier');
        },
      },
    ],
    [
      'mirror:start',
      {
        paramsSchema: channelParamsSchemas['mirror:start'],
        // 镜像依附于受控浏览器接管：EULA 门语义与 browser:openPlatform 一致（FR-1.9）
        handle: async () => {
          if (!deps.consent.isViewAllowed('dashboard')) {
            throw new Error(`${E_EULA_LOCKED}: 浏览器镜像已被 EULA 首启确认门锁定（FR-1.9）——请先完成协议确认`);
          }
          if (!deps.browser.startMirror) throw new Error('E-IPC-DEP-MISSING: mirror 链路未装配');
          return validateExit(MirrorStartResultSchema, await deps.browser.startMirror(), 'mirror:start');
        },
      },
    ],
    [
      'mirror:stop',
      {
        paramsSchema: channelParamsSchemas['mirror:stop'],
        // 停止是安全动作（回归纯外部窗口浏览），与 browser:disconnect 同口径不设门
        handle: async () => {
          if (!deps.browser.stopMirror) throw new Error('E-IPC-DEP-MISSING: mirror 链路未装配');
          return validateExit(MirrorStopResultSchema, await deps.browser.stopMirror(), 'mirror:stop');
        },
      },
    ],
    [
      'browser:status',
      {
        paramsSchema: channelParamsSchemas['browser:status'],
        handle: async () => {
          const result = await deps.browser.status();
          return validateExit(BrowserStatusResultSchema, result, 'browser:status');
        },
      },
    ],
    [
      'browser:openPlatform',
      {
        paramsSchema: channelParamsSchemas['browser:openPlatform'],
        // FR-3.1 接管是业务工作流的底座：EULA 门语义一致——未确认前不开放（拒绝码与路由锁相同）
        handle: async (payload: BrowserOpenPlatformParams) => {
          if (!deps.consent.isViewAllowed('dashboard')) {
            throw new Error(`${E_EULA_LOCKED}: 受控浏览器接管已被 EULA 首启确认门锁定（FR-1.9）——请先完成协议确认`);
          }
          const result = await deps.browser.openPlatform(payload);
          return validateExit(BrowserOpenPlatformResultSchema, result, 'browser:openPlatform');
        },
      },
    ],
    [
      'browser:disconnect',
      {
        paramsSchema: channelParamsSchemas['browser:disconnect'],
        // 断开是安全动作（人工浏览模式回归），不受 EULA/license 锁约束
        handle: async () => {
          const result = await deps.browser.disconnect();
          return validateExit(BrowserDisconnectResultSchema, result, 'browser:disconnect');
        },
      },
    ],
    [
      'browser:installBuiltin',
      {
        paramsSchema: channelParamsSchemas['browser:installBuiltin'],
        // M2 B2：安装动作不受 EULA 锁约束（与 browser:status 同性质的基础设施动作）；
        // 进度经 browser:status.builtinInstall 1s 轮询回流（渲染层既有轮询，无推送面扩张）
        handle: async () => {
          if (!deps.browser.installBuiltin) {
            throw new Error(`${IPC_ERRORS.UNKNOWN_CHANNEL}: browser:installBuiltin 未装配（内置浏览器链路未启用）`);
          }
          const result = await deps.browser.installBuiltin();
          return validateExit(BrowserInstallBuiltinResultSchema, result, 'browser:installBuiltin');
        },
      },
    ],
    [
      'consent:state',
      {
        paramsSchema: channelParamsSchemas['consent:state'],
        handle: async () => {
          const result = await deps.consent.state();
          return validateExit(ConsentStateResultSchema, result, 'consent:state');
        },
      },
    ],
    [
      'consent:acceptEula',
      {
        paramsSchema: channelParamsSchemas['consent:acceptEula'],
        handle: async (payload: { telemetryConsent: boolean }) => {
          const result = await deps.consent.acceptEula(payload);
          return validateExit(ConsentStateResultSchema, result, 'consent:acceptEula');
        },
      },
    ],
    [
      'consent:rejectEula',
      {
        paramsSchema: channelParamsSchemas['consent:rejectEula'],
        handle: async () => {
          const result = await deps.consent.rejectEula();
          return validateExit(ConsentStateResultSchema, result, 'consent:rejectEula');
        },
      },
    ],
    [
      'consent:setTelemetry',
      {
        paramsSchema: channelParamsSchemas['consent:setTelemetry'],
        handle: async (payload: { enabled: boolean }) => {
          const result = await deps.consent.setTelemetry(payload);
          return validateExit(ConsentStateResultSchema, result, 'consent:setTelemetry');
        },
      },
    ],
    [
      'logs:ping',
      {
        paramsSchema: channelParamsSchemas['logs:ping'],
        handle: (payload: { message: string }) => ({
          pong: `pong: ${payload.message}`,
          at: new Date().toISOString(),
        }),
      },
    ],
    [
      'license:activate',
      {
        paramsSchema: channelParamsSchemas['license:activate'],
        handle: (payload: LicenseActivateParams) => {
          const result = deps.license.activate(payload);
          const parsed = LicenseStatusResultSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `${IPC_ERRORS.INVALID_PARAMS}: license:activate 出口数据不符合契约 ${formatZodIssues(parsed.error)}`,
            );
          }
          return parsed.data;
        },
      },
    ],
    [
      'license:status',
      {
        paramsSchema: channelParamsSchemas['license:status'],
        handle: () => {
          const result = deps.license.status();
          const parsed = LicenseStatusResultSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `${IPC_ERRORS.INVALID_PARAMS}: license:status 出口数据不符合契约 ${formatZodIssues(parsed.error)}`,
            );
          }
          return parsed.data;
        },
      },
    ],
    [
      'logs:query',
      {
        paramsSchema: channelParamsSchemas['logs:query'],
        handle: async (payload: LogsQueryParams) => {
          const result = await deps.logTask.queryLogs(payload);
          const parsed = LogsQueryResultSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `${IPC_ERRORS.INVALID_PARAMS}: logs:query 出口数据不符合契约 ${formatZodIssues(parsed.error)}`,
            );
          }
          return parsed.data;
        },
      },
    ],
    [
      'tasks:createDemo',
      {
        paramsSchema: channelParamsSchemas['tasks:createDemo'],
        handle: async () => {
          const result = await deps.logTask.createDemoTask();
          const parsed = TasksCreateDemoResultSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `${IPC_ERRORS.INVALID_PARAMS}: tasks:createDemo 出口数据不符合契约 ${formatZodIssues(parsed.error)}`,
            );
          }
          return parsed.data;
        },
      },
    ],
    [
      'tasks:list',
      {
        paramsSchema: channelParamsSchemas['tasks:list'],
        handle: async () => {
          const result = await deps.logTask.listTasks();
          const parsed = TasksListResultSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `${IPC_ERRORS.INVALID_PARAMS}: tasks:list 出口数据不符合契约 ${formatZodIssues(parsed.error)}`,
            );
          }
          return parsed.data;
        },
      },
    ],
    [
      'tasks:resume',
      {
        paramsSchema: channelParamsSchemas['tasks:resume'],
        handle: async (payload: { taskId: string }) => {
          const result = await deps.logTask.resumeTask(payload.taskId);
          const parsed = TasksResumeResultSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `${IPC_ERRORS.INVALID_PARAMS}: tasks:resume 出口数据不符合契约 ${formatZodIssues(parsed.error)}`,
            );
          }
          return parsed.data;
        },
      },
    ],
    [
      'tasks:cancel',
      {
        paramsSchema: channelParamsSchemas['tasks:cancel'],
        handle: async (payload: { taskId: string }) => {
          const result = await deps.logTask.cancelTask(payload.taskId);
          const parsed = TasksCancelResultSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `${IPC_ERRORS.INVALID_PARAMS}: tasks:cancel 出口数据不符合契约 ${formatZodIssues(parsed.error)}`,
            );
          }
          return parsed.data;
        },
      },
    ],
    [
      'tasks:pause',
      {
        paramsSchema: channelParamsSchemas['tasks:pause'],
        handle: async (payload: { taskId: string }) => {
          if (!deps.logTask.pauseTask) throw new Error('E-IPC-DEP-MISSING: tasks:pause 链路未装配');
          const result = await deps.logTask.pauseTask(payload.taskId);
          const parsed = TasksResumeResultSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error(
              `${IPC_ERRORS.INVALID_PARAMS}: tasks:pause 出口数据不符合契约 ${formatZodIssues(parsed.error)}`,
            );
          }
          return parsed.data;
        },
      },
    ],
    [
      'collect:start',
      {
        paramsSchema: channelParamsSchemas['collect:start'],
        // 采集是业务工作流：EULA 门语义一致（FR-1.9 未确认前不开放）
        handle: async (payload: CollectStartParams) => {
          if (!deps.consent.isViewAllowed('insight')) {
            throw new Error(`${E_EULA_LOCKED}: 采集已被 EULA 首启确认门锁定（FR-1.9）——请先完成协议确认`);
          }
          if (!deps.collect) throw new Error('E-IPC-DEP-MISSING: collect 链路未装配');
          const result = await deps.collect.start(payload);
          return validateExit(z.object({ taskId: z.string() }), result, 'collect:start');
        },
      },
    ],
    [
      'collect:remainders',
      {
        paramsSchema: channelParamsSchemas['collect:remainders'],
        handle: async () => {
          if (!deps.collect) throw new Error('E-IPC-DEP-MISSING: collect 链路未装配');
          const result = await deps.collect.remainders();
          return validateExit(CollectRemaindersResultSchema, result, 'collect:remainders');
        },
      },
    ],
    [
      'collect:stats',
      {
        paramsSchema: channelParamsSchemas['collect:stats'],
        handle: async (payload: CollectStatsParams) => {
          if (!deps.collect) throw new Error('E-IPC-DEP-MISSING: collect 链路未装配');
          const result = await deps.collect.stats(payload);
          return validateExit(CollectStatsResultSchema, result, 'collect:stats');
        },
      },
    ],
    [
      'circuit:status',
      {
        paramsSchema: channelParamsSchemas['circuit:status'],
        handle: async () => {
          if (!deps.collect) throw new Error('E-IPC-DEP-MISSING: collect 链路未装配');
          const result = await deps.collect.circuitStatus();
          return validateExit(CircuitStatusResultSchema, result, 'circuit:status');
        },
      },
    ],
    [
      'circuit:confirmResume',
      {
        paramsSchema: channelParamsSchemas['circuit:confirmResume'],
        // FR-9.5 人工确认恢复（HALF_OPEN 推进）走 IPC 人工动作
        handle: async () => {
          if (!deps.collect) throw new Error('E-IPC-DEP-MISSING: collect 链路未装配');
          const result = await deps.collect.circuitConfirmResume();
          return validateExit(CircuitConfirmResumeResultSchema, result, 'circuit:confirmResume');
        },
      },
    ],
    [
      'keys:set',
      {
        paramsSchema: channelParamsSchemas['keys:set'],
        handle: async (payload: KeysSetParams) => {
          if (!deps.keys) throw new Error('E-IPC-DEP-MISSING: keys 链路未装配');
          const result = await deps.keys.setKey(payload);
          return validateExit(KeysSetResultSchema, result, 'keys:set');
        },
      },
    ],
    [
      'keys:get-masked',
      {
        paramsSchema: channelParamsSchemas['keys:get-masked'],
        // 出口断言（FR-2.7/PC-03①）：masked 响应永不含 Key 全值——对明文形态全值深扫描，
        // 出现即抛 E-KEY-MASKED-VIOLATION（防御性：契约被破坏时快速失败而非泄漏）
        handle: async () => {
          if (!deps.keys) throw new Error('E-IPC-DEP-MISSING: keys 链路未装配');
          const result = await deps.keys.getMasked();
          const validated = validateExit(KeysGetMaskedResultSchema, result, 'keys:get-masked');
          const json = JSON.stringify(validated);
          for (const raw of await deps.keys.exitAuditRawValues()) {
            if (raw && json.includes(raw)) {
              throw new Error('E-KEY-MASKED-VIOLATION: keys:get-masked 出口泄漏完整 Key 值（出口断言触发）');
            }
          }
          return validated;
        },
      },
    ],
    [
      'keys:test',
      {
        paramsSchema: channelParamsSchemas['keys:test'],
        handle: async (payload: KeysTestParams) => {
          if (!deps.keys) throw new Error('E-IPC-DEP-MISSING: keys 链路未装配');
          const result = await deps.keys.test(payload);
          return validateExit(KeysTestResultSchema, result, 'keys:test');
        },
      },
    ],
    [
      'keys:precall-confirm',
      {
        paramsSchema: channelParamsSchemas['keys:precall-confirm'],
        handle: async (payload: KeysPrecallConfirmParams) => {
          if (!deps.keys) throw new Error('E-IPC-DEP-MISSING: keys 链路未装配');
          const result = await deps.keys.precallConfirm(payload);
          return validateExit(KeysPrecallConfirmResultSchema, result, 'keys:precall-confirm');
        },
      },
    ],
    [
      'keys:scan-test',
      {
        paramsSchema: channelParamsSchemas['keys:scan-test'],
        handle: async (payload: KeysScanTestParams) => {
          if (!deps.keys) throw new Error('E-IPC-DEP-MISSING: keys 链路未装配');
          const result = await deps.keys.scanTest(payload);
          return validateExit(KeysScanTestResultSchema, result, 'keys:scan-test');
        },
      },
    ],
    [
      'notes:list',
      {
        paramsSchema: channelParamsSchemas['notes:list'],
        // 只读面（FR-4.6 采集列表 + CSV 数据源）：不设 EULA 门（历史数据可访问语义一致）
        handle: async (payload: NotesListParams) => {
          if (!deps.report) throw new Error('E-IPC-DEP-MISSING: report 链路未装配');
          const result = await deps.report.listNotes(payload);
          return validateExit(NotesListResultSchema, result, 'notes:list');
        },
      },
    ],
    [
      'reports:list',
      {
        paramsSchema: channelParamsSchemas['reports:list'],
        handle: async () => {
          if (!deps.report) throw new Error('E-IPC-DEP-MISSING: report 链路未装配');
          const result = await deps.report.listReports();
          return validateExit(ReportsListResultSchema, result, 'reports:list');
        },
      },
    ],
    [
      'reports:get',
      {
        paramsSchema: channelParamsSchemas['reports:get'],
        handle: async (payload: { reportId: number }) => {
          if (!deps.report) throw new Error('E-IPC-DEP-MISSING: report 链路未装配');
          const result = await deps.report.getReport(payload);
          return validateExit(ReportGetResultSchema, result, 'reports:get');
        },
      },
    ],
    [
      'report:chartData',
      {
        paramsSchema: channelParamsSchemas['report:chartData'],
        handle: async (payload: { reportId: number }) => {
          if (!deps.report) throw new Error('E-IPC-DEP-MISSING: report 链路未装配');
          const result = await deps.report.chartData(payload);
          return validateExit(ReportChartDataResultSchema, result, 'report:chartData');
        },
      },
    ],
    [
      'report:exportPdf',
      {
        paramsSchema: channelParamsSchemas['report:exportPdf'],
        handle: async () => {
          if (!deps.report) throw new Error('E-IPC-DEP-MISSING: report 链路未装配');
          const result = await deps.report.exportPdf();
          return validateExit(ReportExportPdfResultSchema, result, 'report:exportPdf');
        },
      },
    ],
    [
      'report:insertFixture',
      {
        paramsSchema: channelParamsSchemas['report:insertFixture'],
        // QA failure 组专用：仅组合根显式装配（XINGLIAN_DEBUG_HOOKS=1）时存在
        handle: async (payload: ReportInsertFixtureParams) => {
          if (!deps.report?.insertFixture) throw new Error('E-IPC-DEP-MISSING: report:insertFixture 未装配（debug 门控）');
          return validateExit(z.object({ id: z.number().int() }), await deps.report.insertFixture(payload), 'report:insertFixture');
        },
      },
    ],
    [
      'gate:list',
      {
        paramsSchema: channelParamsSchemas['gate:list'],
        handle: async () => {
          if (!deps.report) throw new Error('E-IPC-DEP-MISSING: report 链路未装配');
          const result = await deps.report.listGates();
          return validateExit(GateListResultSchema, result, 'gate:list');
        },
      },
    ],
    [
      'gate:confirm',
      {
        paramsSchema: channelParamsSchemas['gate:confirm'],
        // 确认闸门 = insight 视图业务写入口：EULA 门语义与 collect:start 一致（FR-1.9）
        handle: async (payload: GateConfirmParams) => {
          if (!deps.report) throw new Error('E-IPC-DEP-MISSING: report 链路未装配');
          if (!deps.consent.isViewAllowed('insight')) {
            throw new Error(`${E_EULA_LOCKED}: 闸门确认已被 EULA 首启确认门锁定（FR-1.9）——请先完成协议确认`);
          }
          const result = await deps.report.confirmGate(payload);
          return validateExit(GateConfirmResultSchema, result, 'gate:confirm');
        },
      },
    ],
    [
      'gate:reject',
      {
        paramsSchema: channelParamsSchemas['gate:reject'],
        handle: async (payload: GateRejectParams) => {
          if (!deps.report) throw new Error('E-IPC-DEP-MISSING: report 链路未装配');
          if (!deps.consent.isViewAllowed('insight')) {
            throw new Error(`${E_EULA_LOCKED}: 闸门拒绝已被 EULA 首启确认门锁定（FR-1.9）——请先完成协议确认`);
          }
          const result = await deps.report.rejectGate(payload);
          return validateExit(GateRejectResultSchema, result, 'gate:reject');
        },
      },
    ],
    [
      'selection:list',
      {
        paramsSchema: channelParamsSchemas['selection:list'],
        // 只读面（FR-6.3 候选清单数据源）：不设 EULA 门（历史数据可访问语义一致）
        handle: async () => {
          if (!deps.selection) throw new Error('E-IPC-DEP-MISSING: selection 链路未装配');
          const result = await deps.selection.list();
          return validateExit(SelectionListResultSchema, result, 'selection:list');
        },
      },
    ],
    [
      'selection:candidates',
      {
        paramsSchema: channelParamsSchemas['selection:candidates'],
        handle: async (payload: SelectionCandidatesParams) => {
          if (!deps.selection) throw new Error('E-IPC-DEP-MISSING: selection 链路未装配');
          const result = await deps.selection.candidates(payload);
          return validateExit(SelectionCandidatesResultSchema, result, 'selection:candidates');
        },
      },
    ],
    [
      'selection:config',
      {
        paramsSchema: channelParamsSchemas['selection:config'],
        handle: async () => {
          if (!deps.selection) throw new Error('E-IPC-DEP-MISSING: selection 链路未装配');
          const result = await deps.selection.config();
          return validateExit(SelectionConfigResultSchema, result, 'selection:config');
        },
      },
    ],
    [
      'selection:setWeights',
      {
        paramsSchema: channelParamsSchemas['selection:setWeights'],
        // 偏好写面（FR-6.2 权重可调）：settings 性质，与 usage:set* 同口径不设 EULA 门
        handle: async (payload: SelectionSetWeightsParams) => {
          if (!deps.selection) throw new Error('E-IPC-DEP-MISSING: selection 链路未装配');
          const result = await deps.selection.setWeights(payload);
          return validateExit(SelectionSetWeightsResultSchema, result, 'selection:setWeights');
        },
      },
    ],
    [
      'selection:setPinned',
      {
        paramsSchema: channelParamsSchemas['selection:setPinned'],
        // 偏好写面（FR-6.3 置顶）：同 setWeights 口径
        handle: async (payload: SelectionSetPinnedParams) => {
          if (!deps.selection) throw new Error('E-IPC-DEP-MISSING: selection 链路未装配');
          const result = await deps.selection.setPinned(payload);
          return validateExit(SelectionSetPinnedResultSchema, result, 'selection:setPinned');
        },
      },
    ],
    [
      'selection:insertFixture',
      {
        paramsSchema: channelParamsSchemas['selection:insertFixture'],
        // QA 播种专用：仅组合根显式装配（XINGLIAN_DEBUG_HOOKS=1）时存在
        handle: async (payload: SelectionInsertFixtureParams) => {
          if (!deps.selection?.insertFixture) throw new Error('E-IPC-DEP-MISSING: selection:insertFixture 未装配（debug 门控）');
          return validateExit(SelectionInsertFixtureResultSchema, await deps.selection.insertFixture(payload), 'selection:insertFixture');
        },
      },
    ],
    [
      'selection:setChecked',
      {
        paramsSchema: channelParamsSchemas['selection:setChecked'],
        // 勾选集写面（FR-6.3）：kv 偏好，setPinned 同款设置性质不设 EULA 门
        handle: async (payload: SelectionSetCheckedParams) => {
          if (!deps.selection) throw new Error('E-IPC-DEP-MISSING: selection 链路未装配');
          const result = await deps.selection.setChecked(payload);
          return validateExit(SelectionSetCheckedResultSchema, result, 'selection:setChecked');
        },
      },
    ],
    [
      'outreach:start',
      {
        paramsSchema: channelParamsSchemas['outreach:start'],
        // sourcing 视图业务写入口：EULA 门语义与 collect:start 一致（FR-1.9）。
        // 批次内每候选的收藏/询盘仍各经 FR-6.4 红线确认弹窗（outreach:confirm 推送 +
        // outreach:decide 回传），永远人工，不受 FR-12.7 自动化档位影响。
        handle: async (payload: OutreachStartParams) => {
          if (!deps.consent.isViewAllowed('sourcing')) {
            throw new Error(`${E_EULA_LOCKED}: 选品执行已被 EULA 首启确认门锁定（FR-1.9）——请先完成协议确认`);
          }
          if (!deps.outreach) throw new Error('E-IPC-DEP-MISSING: outreach 链路未装配');
          const result = await deps.outreach.start(payload);
          return validateExit(OutreachStartResultSchema, result, 'outreach:start');
        },
      },
    ],
    [
      'outreach:decide',
      {
        paramsSchema: channelParamsSchemas['outreach:decide'],
        // FR-6.4 红线确认回传：主进程审计（OUTREACH_CONFIRM）在 service 内落 task_events
        handle: async (payload: OutreachDecideParams) => {
          if (!deps.outreach) throw new Error('E-IPC-DEP-MISSING: outreach 链路未装配');
          const result = await deps.outreach.decide(payload);
          return validateExit(OutreachDecideResultSchema, result, 'outreach:decide');
        },
      },
    ],
    [
      'outreach:status',
      {
        paramsSchema: channelParamsSchemas['outreach:status'],
        handle: async () => {
          if (!deps.outreach) throw new Error('E-IPC-DEP-MISSING: outreach 链路未装配');
          return validateExit(OutreachStatusResultSchema, await deps.outreach.status(), 'outreach:status');
        },
      },
    ],
    [
      'products:list',
      {
        paramsSchema: channelParamsSchemas['products:list'],
        // 只读面（FR-6.5 商品卡片数据源）：不设 EULA 门（历史数据可访问语义一致）
        handle: async (payload: ProductsListParams) => {
          if (!deps.products) throw new Error('E-IPC-DEP-MISSING: products 链路未装配');
          return validateExit(ProductsListResultSchema, await deps.products.list(payload), 'products:list');
        },
      },
    ],
    [
      'products:openSource',
      {
        paramsSchema: channelParamsSchemas['products:openSource'],
        // 打开货源页（FR-6.5「打开货源页」按钮）：只读动作；仅放行 1688 域（防任意 URL 外开）
        handle: async (payload: ProductsOpenSourceParams) => {
          if (!deps.products) throw new Error('E-IPC-DEP-MISSING: products 链路未装配');
          const host = new URL(payload.link).hostname;
          if (host !== 'detail.1688.com' && !host.endsWith('.1688.com')) {
            throw new Error(`${IPC_ERRORS.INVALID_PARAMS}: products:openSource 仅放行 1688 域链接（got ${host}）`);
          }
          return validateExit(ProductsOpenSourceResultSchema, await deps.products.openSource(payload), 'products:openSource');
        },
      },
    ],
    [
      'sourcing:akStatus',
      {
        paramsSchema: channelParamsSchemas['sourcing:akStatus'],
        // 设置性质读面（同 usage:* 口径）：masked 出口，无 EULA 门
        handle: async (payload: SourcingAkStatusParams) => {
          if (!deps.sourcingAk) throw new Error('E-IPC-DEP-MISSING: sourcingAk 链路未装配');
          return validateExit(SourcingAkStatusResultSchema, await deps.sourcingAk.status(payload), 'sourcing:akStatus');
        },
      },
    ],
    [
      'sourcing:akSet',
      {
        paramsSchema: channelParamsSchemas['sourcing:akSet'],
        // AK 原始串经 preload zod 校验 + ak-store 二次解析；密文/降级纪律归 ak-store
        handle: async (payload: SourcingAkSetParams) => {
          if (!deps.sourcingAk) throw new Error('E-IPC-DEP-MISSING: sourcingAk 链路未装配');
          return validateExit(SourcingAkSetResultSchema, await deps.sourcingAk.set(payload), 'sourcing:akSet');
        },
      },
    ],
    [
      'sourcing:akClear',
      {
        paramsSchema: channelParamsSchemas['sourcing:akClear'],
        handle: async (payload: SourcingAkClearParams) => {
          if (!deps.sourcingAk) throw new Error('E-IPC-DEP-MISSING: sourcingAk 链路未装配');
          return validateExit(SourcingAkClearResultSchema, await deps.sourcingAk.clear(payload), 'sourcing:akClear');
        },
      },
    ],
    [
      'usage:summary',
      {
        paramsSchema: channelParamsSchemas['usage:summary'],
        handle: async (payload: UsageSummaryParams) => {
          if (!deps.usage) throw new Error('E-IPC-DEP-MISSING: usage 链路未装配');
          return validateExit(UsageSummaryResultSchema, await deps.usage.summary(payload), 'usage:summary');
        },
      },
    ],
    [
      'usage:setPricing',
      {
        paramsSchema: channelParamsSchemas['usage:setPricing'],
        handle: async (payload: UsageSetPricingParams) => {
          if (!deps.usage) throw new Error('E-IPC-DEP-MISSING: usage 链路未装配');
          return validateExit(UsageSetPricingResultSchema, await deps.usage.setPricing(payload), 'usage:setPricing');
        },
      },
    ],
    [
      'usage:setRpm',
      {
        paramsSchema: channelParamsSchemas['usage:setRpm'],
        handle: async (payload: UsageSetRpmParams) => {
          if (!deps.usage) throw new Error('E-IPC-DEP-MISSING: usage 链路未装配');
          return validateExit(UsageSetRpmResultSchema, await deps.usage.setRpm(payload), 'usage:setRpm');
        },
      },
    ],
    [
      'viral:list',
      {
        paramsSchema: channelParamsSchemas['viral:list'],
        // 只读面（FR-4.7 爆款清单数据源）：不设 EULA 门（历史数据可访问语义一致）
        handle: async (payload: ViralListParams) => {
          if (!deps.viral) throw new Error('E-IPC-DEP-MISSING: viral 链路未装配');
          return validateExit(ViralListResultSchema, await deps.viral.list(payload), 'viral:list');
        },
      },
    ],
    [
      'viral:refresh',
      {
        paramsSchema: channelParamsSchemas['viral:refresh'],
        // 业务写面（重算快照）：EULA 门与 gate:confirm 同口径（insight 视图业务入口）
        handle: async (payload: ViralRefreshParams) => {
          if (!deps.consent.isViewAllowed('insight')) {
            throw new Error(`${E_EULA_LOCKED}: 爆款清单重算已被 EULA 首启确认门锁定（FR-1.9）——请先完成协议确认`);
          }
          if (!deps.viral) throw new Error('E-IPC-DEP-MISSING: viral 链路未装配');
          return validateExit(ViralRefreshResultSchema, await deps.viral.refresh(payload), 'viral:refresh');
        },
      },
    ],
    [
      'viral:generateRationale',
      {
        paramsSchema: channelParamsSchemas['viral:generateRationale'],
        // 业务写面 + 真实 BYOK 外呼（单次）：EULA 门与 gate:confirm 同口径
        handle: async (payload: ViralGenerateRationaleParams) => {
          if (!deps.consent.isViewAllowed('insight')) {
            throw new Error(`${E_EULA_LOCKED}: 爆款解读已被 EULA 首启确认门锁定（FR-1.9）——请先完成协议确认`);
          }
          if (!deps.viral) throw new Error('E-IPC-DEP-MISSING: viral 链路未装配');
          return validateExit(ViralGenerateRationaleResultSchema, await deps.viral.generateRationale(payload), 'viral:generateRationale');
        },
      },
    ],
  ]);

  for (const channel of map.keys()) {
    if (!isChannelAllowed(channel)) {
      throw new Error(`IPC 注册表出现白名单外的通道: ${String(channel)}`);
    }
  }
  if (map.size !== IPC_CHANNELS.length) {
    throw new Error('IPC 注册表与 IPC_CHANNELS 白名单数量不一致（有通道漏注册或多余）');
  }
  return map;
}

/** 主进程侧统一入口：先查白名单，再 zod 校验，最后执行（结果或稳定错误码） */
export function invokeIpcEntry(
  registry: IpcRegistry,
  channel: string,
  payload: unknown,
): IpcInvokeResult {
  const entry = registry.get(channel as IpcChannel);
  if (!entry) {
    return {
      ok: false,
      code: IPC_ERRORS.UNKNOWN_CHANNEL,
      message: `${IPC_ERRORS.UNKNOWN_CHANNEL}: channel "${channel}" 不在 IPC 白名单`,
    };
  }
  const parsed = entry.paramsSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      code: IPC_ERRORS.INVALID_PARAMS,
      message: `${IPC_ERRORS.INVALID_PARAMS}: ${formatZodIssues(parsed.error)}`,
    };
  }
  return { ok: true, data: entry.handle(parsed.data as never) };
}
