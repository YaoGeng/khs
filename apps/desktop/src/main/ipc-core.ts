/**
 * IPC 注册表与入参校验核心（纯逻辑，不 import electron，vitest 可直接单测）。
 * 02 §4.3：所有 IPC 走 invoke/handle，通道即契约，入参 zod 校验。
 */
import { z } from 'zod';
import { IPC_CHANNELS, IPC_ERRORS, type IpcChannel } from '../shared/channels';
import {
  AppInfoResultSchema,
  channelParamsSchemas,
  LicenseStatusResultSchema,
  type AppInfoResult,
  type LicenseActivateParams,
  type LicenseStatusResult,
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

export interface AppInfoDeps {
  /** 注入 app/appVersion 等运行时读取，保持本模块 electron-free 可单测 */
  readonly appInfo: () => AppInfoResult;
  /** todo 8：license 链路（离线验签/锁定状态机）依赖 */
  readonly license: LicenseIpcDeps;
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
        // 入参 zod enum 已把 view 收敛为九视图之一，直接回显（M0 不做业务导航副作用）
        handle: (payload: { view: string }) => ({ ok: true as const, view: payload.view }),
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
