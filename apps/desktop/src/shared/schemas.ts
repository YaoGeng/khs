/**
 * IPC 契约 zod schema（02-系统架构设计.md §4.3：所有 IPC 走 invoke/handle，
 * 通道即契约，入参用 zod 校验——preload 侧与 ipcMain.handle 侧共用本文件）。
 */
import { z } from 'zod';
import { NAV_VIEWS, type IpcChannel } from './channels';

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

/* logs:ping —— 白名单/zod 校验链路的往返探针（M0 无日志业务，logs:query 归 M1+） */
export const LogsPingParamsSchema = z.strictObject({
  message: z.string().min(1).max(200),
});

export const LogsPingResultSchema = z.object({
  pong: z.string(),
  at: z.string(),
});

export type AppInfoParams = z.infer<typeof AppInfoParamsSchema>;
export type AppInfoResult = z.infer<typeof AppInfoResultSchema>;
export type NavigateParams = z.infer<typeof NavigateParamsSchema>;
export type NavigateResult = z.infer<typeof NavigateResultSchema>;
export type LogsPingParams = z.infer<typeof LogsPingParamsSchema>;
export type LogsPingResult = z.infer<typeof LogsPingResultSchema>;

/** 通道 → 入参 schema。preload 与 main 侧都从这里取，保证两侧校验一致。 */
export const channelParamsSchemas: Record<IpcChannel, z.ZodType> = {
  'app:info': AppInfoParamsSchema,
  'app:navigate': NavigateParamsSchema,
  'logs:ping': LogsPingParamsSchema,
};
