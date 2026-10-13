/**
 * IPC 注册表与入参校验核心（纯逻辑，不 import electron，vitest 可直接单测）。
 * 02 §4.3：所有 IPC 走 invoke/handle，通道即契约，入参 zod 校验。
 */
import { z } from 'zod';
import { E_EULA_LOCKED, IPC_CHANNELS, IPC_ERRORS, type IpcChannel } from '../shared/channels';
import {
  AppInfoResultSchema,
  BrowserDisconnectResultSchema,
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
  LicenseStatusResultSchema,
  LogsQueryResultSchema,
  TasksCancelResultSchema,
  TasksCreateDemoResultSchema,
  TasksListResultSchema,
  TasksResumeResultSchema,
  type AppInfoResult,
  type BrowserDisconnectResult,
  type BrowserOpenPlatformParams,
  type BrowserOpenPlatformResult,
  type BrowserStatusResult,
  type CircuitConfirmResumeResult,
  type CircuitStatusResult,
  type CollectRemaindersResult,
  type CollectStatsResult,
  type ConsentStateResult,
  type LicenseActivateParams,
  type LicenseStatusResult,
  type LogsQueryParams,
  type LogsQueryResult,
  type TasksListResult,
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
}

/** 采集/熔断链路依赖注入面（todo 7 = T-M1-04；main binding 在 main/collect-binding.ts） */
export interface CollectIpcDeps {
  readonly start: (params: CollectStartParams) => Promise<{ taskId: string }>;
  readonly remainders: () => Promise<CollectRemaindersResult>;
  readonly stats: (params: CollectStatsParams) => Promise<CollectStatsResult>;
  readonly circuitStatus: () => Promise<CircuitStatusResult>;
  readonly circuitConfirmResume: () => Promise<CircuitConfirmResumeResult>;
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
