/**
 * IPC 通道白名单常量（02-系统架构设计.md §4.3「通道即契约」、§11.2「preload 白名单 IPC」）。
 *
 * 目录边界（docs/dev/工程规范.md）：本文件是桌面内部契约，放 apps/desktop/src/shared；
 * 只有 C 端↔服务端跨端契约才进 packages/protocol。
 *
 * M0 范围壳层通道 + license 通道（todo 8）+ 日志/store/任务通道（todo 11：logs:query /
 * tasks:createDemo / tasks:list / tasks:resume / tasks:cancel）+ 合规通道（todo 9：
 * consent:state / consent:acceptEula / consent:rejectEula / consent:setTelemetry，
 * 同一注册表模式）+ 受控浏览器通道（todo 10 = T-M0-08：browser:status / browser:openPlatform /
 * browser:disconnect——FR-3.1/3.2/3.5 一键拉起接管、平台快捷入口、三态标题栏与一键断开）；
 * workflow:/review:/keys: 等业务通道仍归 M1+，见 02 §4.3 示例表——
 * M0 一律不注册，渲染进程越权调用将被白名单拒绝并返回稳定错误码。
 */
export const IPC_CHANNELS = [
  'app:info',
  'app:navigate',
  'browser:disconnect',
  'browser:openPlatform',
  'browser:status',
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

/**
 * 受控浏览器稳定错误码（todo 10 = T-M0-08；renderer/e2e 据此渲染引导）。
 * 红线（FR-3.1/02 §5.2）：这些错误路径永不涉及读取/存储平台账号密码——登录态只靠 Profile 目录。
 */
export const BROWSER_ERRORS = {
  /** 本机未探测到 Chrome/Edge 且用户未设置浏览器路径（便携 Chromium 降级分支 M0 只记录不实现） */
  NOT_FOUND: 'E-BROWSER-NOT-FOUND',
  /** 浏览器进程拉起失败（路径存在但启动失败/秒退） */
  LAUNCH_FAILED: 'E-BROWSER-LAUNCH-FAILED',
  /** CDP pipe 握手失败（Browser.getVersion 超时/管道早闭） */
  CDP_ATTACH_FAILED: 'E-BROWSER-CDP-ATTACH-FAILED',
  /** fallback（port=0）运行时不可用：当前运行时无全局 WebSocket 客户端（见 docs/adr/notes-browser-m0.md） */
  FALLBACK_UNAVAILABLE: 'E-BROWSER-FALLBACK-UNAVAILABLE',
  /** 平台 Profile 被其他浏览器进程占用（如人工未关掉上次 detached 残留——见 ADR 断开语义） */
  PROFILE_BUSY: 'E-BROWSER-PROFILE-BUSY',
} as const;

/** 受控平台白名单（FR-3.2 快捷入口；M0 单平台单 Profile，多账号多 Profile 并行 = P2/FR-3.6） */
export const BROWSER_PLATFORMS = ['xhs', '1688'] as const;

export type BrowserPlatformId = (typeof BROWSER_PLATFORMS)[number];

/** 平台 → 首页 URL 与 Profile 子目录名（FR-3.3：每平台独立 Profile 目录持久化登录态） */
export const BROWSER_PLATFORM_URLS: Record<BrowserPlatformId, string> = {
  xhs: 'https://www.xiaohongshu.com',
  '1688': 'https://www.1688.com',
};
