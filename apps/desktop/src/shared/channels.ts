/**
 * IPC 通道白名单常量（02-系统架构设计.md §4.3「通道即契约」、§11.2「preload 白名单 IPC」）。
 *
 * 目录边界（docs/dev/工程规范.md）：本文件是桌面内部契约，放 apps/desktop/src/shared；
 * 只有 C 端↔服务端跨端契约才进 packages/protocol。
 *
 * M0 范围壳层通道 + license 通道（todo 8）+ 日志/store/任务通道（todo 11：logs:query /
 * tasks:createDemo / tasks:list / tasks:resume / tasks:cancel）+ 合规通道（todo 9：
 * consent:state / consent:acceptEula / consent:rejectEula / consent:setTelemetry，
 * 同一注册表模式）；workflow:/browser:/review:/keys: 等业务通道归 M1+，见 02 §4.3 示例表——
 * M0 一律不注册，渲染进程越权调用将被白名单拒绝并返回稳定错误码。
 */
export const IPC_CHANNELS = [
  'app:info',
  'app:navigate',
  'consent:state',
  'consent:acceptEula',
  'consent:rejectEula',
  'consent:setTelemetry',
  'logs:ping',
  'logs:query',
  'license:activate',
  'license:status',
  'tasks:createDemo',
  'tasks:list',
  'tasks:resume',
  'tasks:cancel',
] as const;

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

/**
 * EULA 首启确认门（todo 9 / FR-1.9）：未确认时六个工作流视图被主进程 app:navigate 拒绝，
 * logs/settings 保持可达（settings 承载遥测开关，FR-12.6）。
 * 视图集合与 license 锁定面（FR-1.6 工作流写入口）一致。
 */
export const EULA_LOCKED_VIEWS = ['dashboard', 'insight', 'sourcing', 'publish', 'promo', 'review'] as const;

/** EULA 路由锁拒绝的稳定错误码（app:navigate 拒绝消息前缀；renderer/e2e 据此判定） */
export const E_EULA_LOCKED = 'E-COMPLIANCE-EULA-LOCKED';
