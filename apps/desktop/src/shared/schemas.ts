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

/** 通道 → 入参 schema。preload 与 main 侧都从这里取，保证两侧校验一致。 */
export const channelParamsSchemas: Record<IpcChannel, z.ZodType> = {
  'app:info': AppInfoParamsSchema,
  'app:navigate': NavigateParamsSchema,
  'logs:ping': LogsPingParamsSchema,
  'license:activate': LicenseActivateParamsSchema,
  'license:status': LicenseStatusParamsSchema,
};
