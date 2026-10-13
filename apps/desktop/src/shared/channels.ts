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
 * workflow:/review: 等业务通道仍归 M1+，见 02 §4.3 示例表——
 * M0 一律不注册，渲染进程越权调用将被白名单拒绝并返回稳定错误码。
 * M1（m1 todo 10 = T-M1-08）：keys:* 五通道入白名单（keys:set/keys:get-masked/keys:test/
 * keys:precall-confirm/keys:scan-test——BYOK Key 配置 + 词库扫描验证通道）。
 */
export const IPC_CHANNELS = [
  'app:info',
  'app:navigate',
  'browser:disconnect',
  'browser:openPlatform',
  'browser:status',
  'circuit:status',
  'circuit:confirmResume',
  'collect:remainders',
  'collect:start',
  'collect:stats',
  'consent:state',
  'consent:acceptEula',
  'consent:rejectEula',
  'consent:setTelemetry',
  'keys:get-masked',
  'keys:precall-confirm',
  'keys:scan-test',
  'keys:set',
  'keys:test',
  'logs:ping',
  'logs:query',
  'license:activate',
  'license:status',
  'tasks:createDemo',
  'tasks:list',
  'tasks:pause',
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

/**
 * BYOK Key 服务商 id（m1 todo 10 = T-M1-08①；FR-2.1 五家预设 + custom）。
 * 五家与 packages/llm-gateway presets.ts PROVIDER_IDS 镜像（desktop 不依赖 llm-gateway 包，
 * 镜像面靠两侧单测互链守护）；custom = 自定义 base_url 网关（用户决策 D11：M1 真实跑 LLM
 * 走 BYOK 自定义网关，属运行时/dev 通道——不加第六预设）。
 */
export const KEY_PROVIDER_IDS = ['deepseek', 'tongyi', 'zhipu', 'openai', 'siliconflow', 'custom'] as const;

export type KeyProviderId = (typeof KEY_PROVIDER_IDS)[number];

/**
 * keys:* 稳定错误码（FR-2.7 / PC-03①；renderer 与 e2e 据此渲染引导而非裸错误）。
 * 明文降级不是拒绝错误：存储成功但 encryption='plaintext-fallback' + 告警文案随结果返回。
 */
export const KEY_ERRORS = {
  /** 未配置 Key 时点「测试连接」→ 阻止并指向配置入口 */
  NOT_CONFIGURED: 'E-KEY-NOT-CONFIGURED',
  /** masked 出口断言触发：IPC 响应中出现完整 Key 值（防御性，触发即契约被破坏） */
  MASKED_VIOLATION: 'E-KEY-MASKED-VIOLATION',
  /** custom 服务商未提供 base_url */
  BASE_URL_REQUIRED: 'E-KEY-BASE-URL-REQUIRED',
  /** 词库未就绪（active 配置包缺失/全部损坏） */
  WORDLIST_NOT_READY: 'E-WORDLIST-NOT-READY',
} as const;

/** 平台 → 首页 URL 与 Profile 子目录名（FR-3.3：每平台独立 Profile 目录持久化登录态） */
export const BROWSER_PLATFORM_URLS: Record<BrowserPlatformId, string> = {
  xhs: 'https://www.xiaohongshu.com',
  '1688': 'https://www.1688.com',
};
