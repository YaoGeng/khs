/**
 * IPC 通道白名单常量（02-系统架构设计.md §4.3「通道即契约」、§11.2「preload 白名单 IPC」）。
 *
 * 目录边界（docs/dev/工程规范.md）：本文件是桌面内部契约，放 apps/desktop/src/shared；
 * 只有 C 端↔服务端跨端契约才进 packages/protocol。
 *
 * M0 范围仅三个壳层通道（不接业务 API，workflow:/browser:/review:/keys:/logs:query 等业务通道归 M1+，
 * 见 02 §4.3 示例表——M0 一律不注册，渲染进程越权调用将被白名单拒绝并返回稳定错误码）。
 */
export const IPC_CHANNELS = ['app:info', 'app:navigate', 'logs:ping'] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** 契约版本：preload 暴露给渲染进程，主进程回填 app:info，便于后续契约演进对账 */
export const CONTRACT_VERSION = 'm0-ipc-1';

/**
 * 九视图导航（映射 T-M0-02：对应 c端原型.html 的 data-view 九视图结构，仅路由占位）。
 * c端原型.html 1126-1139 行：dashboard/insight/report/sourcing/publish/promo/review/logs/settings。
 */
export const NAV_VIEWS = [
  'dashboard',
  'insight',
  'report',
  'sourcing',
  'publish',
  'promo',
  'review',
  'logs',
  'settings',
] as const;

export type ViewId = (typeof NAV_VIEWS)[number];

/** 稳定错误码：preload 与主进程共用，e2e 据此断言越权/非法入参被拒 */
export const IPC_ERRORS = {
  /** 通道不在白名单（IPC 越权） */
  UNKNOWN_CHANNEL: 'E-IPC-UNKNOWN-CHANNEL',
  /** 入参未通过 zod 校验（§4.3：入参 zod 校验） */
  INVALID_PARAMS: 'E-IPC-INVALID-PARAMS',
} as const;
