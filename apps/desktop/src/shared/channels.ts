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
 * M1（m1 todo 11 = T-M1-06）：报告 UI + 确认闸门九通道入白名单——notes:list（FR-4.6 采集列表/
 * CSV 数据源）、reports:list/reports:get/report:chartData（FR-5.3 图表数据）、report:exportPdf
 * （printToPDF 管线，禁第三方 PDF 库）、report:insertFixture（QA failure 组，debug 门控装配）、
 * gate:list/gate:confirm/gate:reject（02:274 E 步关键词确认闸门）。
 * M1（m1 todo 12 = FR-2.4~2.6）：usage:* 三通道入白名单——usage:summary（llm_calls 聚合+
 * 自填单价估算+探测档展示，01:130/04:63）、usage:setPricing（自填单价表）、usage:setRpm
 * （FR-2.6 全局 RPM，0=不限流）。
 * M2（m2-builtin-browser-plan B2）：browser:installBuiltin 入白名单——内置便携 Chromium
 * 按需下载安装触发（进度经 browser:status.builtinInstall 轮询回流，不另设推送通道）。
 * M2（05 T-M2-03 候选清单 UI）：selection:* 六通道入白名单——selection:list /
 * selection:candidates / selection:config（读面，FR-6.3 对比表格数据源）+
 * selection:setWeights / selection:setPinned（偏好写面，FR-6.2 权重可调/FR-6.3 置顶，
 * 与 usage:set* 同为设置性质不设 EULA 门）+ selection:insertFixture（QA 播种，
 * debug 门控装配）。权重重算 = 读时纯算术（库内 rank/total 保留 Agent 原始评分溯源）。
 * M2 产品三卡（2026-10-15 用户新增需求，docs/01 FR-4.7/FR-12.7）：
 * - automation:getTier / automation:setTier——自动化档位（semi 默认 / auto 全自动），
 *   设置性质不设 EULA 门（同 usage:set* 口径）；档位只作用于关键词闸门自动确认，
 *   收藏/询盘等对外发送前的人工确认不受档位影响（合规红线）；
 * - mirror:start / mirror:stop——应用内浏览器镜像预览（CDP Page.screencast 只读投流，
 *   不派发任何输入事件；start 与 browser:openPlatform 同受 EULA 门，stop 为安全动作）；
 * - viral:list / viral:refresh / viral:generateRationale——爆款清单 v1（确定性热度分
 *   读时纯算术 + LLM 解读单次调用；refresh/generateRationale 为 insight 业务写面，
 *   EULA 门与 gate:confirm 同口径）。
 * M2 T-M2-04（05：selection DAG 后半）：
 * - selection:setChecked——候选勾选写面（FR-6.3，kv 集合，setPinned 同款设置性质）；
 * - outreach:start / outreach:decide / outreach:status——收藏/询盘执行批次
 *   （start 为 sourcing 视图业务写入口，EULA 门与 collect:start 同口径；每候选收藏与
 *   询盘发送各经 confirm 闸——FR-6.4 红线永远人工确认，不受 FR-12.7 档位影响；
 *   decide 回传用户决定 + 可编辑话术；status 供渲染层轮询对齐）；
 * - products:list / products:openSource——商品卡片列表（FR-6.5 展示面）+ 打开货源页
 *   （shell.openExternal；只读动作不设 EULA 门）。
 * M2 T-M2-06（FR-7 工作流转场）：
 * - products:setStatus——商品状态手动簿记面（已对接判定 FR-7.1 + 看板拖拽流转 FR-7.3；
 *   选品中三态互转/待发布撤回与推进/推广中↔已完成；→待发布 唯一入口是 enterPublish，
 *   违规迁移稳定错误 E-PRODUCT-TRANSITION-INVALID；本地簿记性质不设 EULA 门，
 *   同 selection:setChecked 口径）；
 * - products:enterPublish——一键转场（FR-7.2）：已对接 → 待发布，落 PRODUCT_ENTER_PUBLISH
 *   审计事件 + 返回上下文摘要（素材计数/供应商/报告 topic，可推导引用不复制本体）。
 */
export const IPC_CHANNELS = [
  'app:info',
  'app:navigate',
  'automation:getTier',
  'automation:setTier',
  'browser:disconnect',
  'browser:installBuiltin',
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
  'gate:confirm',
  'gate:list',
  'gate:reject',
  'keys:get-masked',
  'keys:precall-confirm',
  'keys:scan-test',
  'keys:set',
  'keys:test',
  'logs:ping',
  'logs:query',
  'license:activate',
  'license:status',
  'mirror:start',
  'mirror:stop',
  'notes:list',
  'outreach:decide',
  'outreach:start',
  'outreach:status',
  'products:enterPublish',
  'products:list',
  'products:openSource',
  'products:setStatus',
  'report:chartData',
  'report:exportPdf',
  'report:insertFixture',
  'reports:get',
  'reports:list',
  'selection:candidates',
  'selection:config',
  'selection:insertFixture',
  'selection:list',
  'selection:setChecked',
  'selection:setPinned',
  'selection:setWeights',
  'sourcing:akClear',
  'sourcing:akSet',
  'sourcing:akStatus',
  'tasks:createDemo',
  'tasks:list',
  'tasks:pause',
  'tasks:resume',
  'tasks:cancel',
  'usage:setPricing',
  'usage:setRpm',
  'usage:summary',
  'viral:generateRationale',
  'viral:list',
  'viral:refresh',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/**
 * main→renderer 推送通道白名单（单向推送，非 invoke 面，不进 IPC_CHANNELS 注册表）。
 * preload 的 onPush 门面只放行这里的通道；payload 契约见 schemas.ts 对应 *PushSchema。
 * M2 T-M2-04：outreach:confirm（收藏/询盘人工确认请求——FR-6.4 红线弹窗数据）+
 * outreach:progress（批次进度；渲染层据 phase 驱动执行按钮态）。
 */
export const MIRROR_FRAME_CHANNEL = 'mirror:frame';
export const OUTREACH_CONFIRM_CHANNEL = 'outreach:confirm';
export const OUTREACH_PROGRESS_CHANNEL = 'outreach:progress';

export const PUSH_CHANNELS = [MIRROR_FRAME_CHANNEL, OUTREACH_CONFIRM_CHANNEL, OUTREACH_PROGRESS_CHANNEL] as const;

export type PushChannel = (typeof PUSH_CHANNELS)[number];

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

/**
 * 选品维度 id（05 T-M2-03 / FR-6.2 权重调整面；repurchase 为 T-M2-05b 补 PRD
 * 「销量/复购」口径，仅官方 API 检索通道有数据）。与 packages/agents selection-agent
 * SELECTION_DIMENSIONS 键集互链镜像（渲染 bundle 不携带 agents 包，镜像面靠
 * selection-view-service 启动期一致性断言守护——键集不符即抛，防两表漂移）。
 */
export const SELECTION_DIMENSIONS_SCHEMA = ['relevance', 'price', 'sales', 'supplier', 'gallery', 'repurchase'] as const;

export type SelectionDimensionId = (typeof SELECTION_DIMENSIONS_SCHEMA)[number];

/**
 * 自动化档位枚举（M2 产品卡③；docs/01 FR-12.7）：
 * - semi（默认）：关键词闸门等人工确认点保持用户手动点击；
 * - auto：报告⑦章关键词闸门自动确认并推进 selection 占位任务（审计事件 gate:auto-confirmed）。
 * 档位边界（合规红线）：收藏/询盘等对外发送前的人工确认永远保留，不受档位影响。
 */
export const AUTOMATION_TIERS = ['semi', 'auto'] as const;

export type AutomationTierId = (typeof AUTOMATION_TIERS)[number];

/**
 * 关键词确认闸门稳定错误码（m1 todo 11 = T-M1-06②；renderer/e2e 据此判定拒绝原因）。
 * 闸门状态机：collect 任务 awaiting_user → 确认（selection 占位 queued）/拒绝（cancelled）。
 * T-M2-03b 起三值枚举：+sourcing_login（selection 任务检索全被推荐流剔除 → 挂起待
 * 人工登录 1688；只可 tasks:resume，confirm/reject 被两错误码拦下）。
 */
export const GATE_ERRORS = {
  /** 目标任务不在 awaiting_user 态（已收口/不存在） */
  NOT_AWAITING: 'E-GATE-NOT-AWAITING',
  /** 挂起闸门不是 keyword_confirm（如 llm_key_config 不可确认） */
  NOT_KEYWORD_CONFIRM: 'E-GATE-NOT-KEYWORD-CONFIRM',
  /** 无挂起闸门记录（kv 指针缺失） */
  NOT_PENDING: 'E-GATE-NOT-PENDING',
} as const;

/**
 * 收藏/询盘执行稳定错误码（T-M2-04；renderer/e2e 据此渲染引导）。
 * 红线语义：BUSY = 单浏览器串行（ADR-6）；DETACHED = 浏览器未接管先引导接管；
 * EMPTY/NO_CANDIDATE = 勾选面与候选快照不一致的诚实反馈（不臆造批次）。
 */
export const OUTREACH_ERRORS = {
  BUSY: 'E-OUTREACH-BUSY',
  DETACHED: 'E-OUTREACH-BROWSER-DETACHED',
  EMPTY: 'E-OUTREACH-EMPTY',
  NO_CANDIDATE: 'E-OUTREACH-NO-CANDIDATE',
  CONFIRM_ID_INVALID: 'E-OUTREACH-CONFIRM-ID-INVALID',
} as const;

/**
 * 商品工作流转场稳定错误码（T-M2-06；renderer/e2e 据此渲染引导）。
 * NOT_FOUND = 商品不存在；TRANSITION_INVALID = 违规状态迁移（→待发布 必须走
 * enterPublish、跨阶段回退受限）；NOT_CONNECTED = 未「已对接」不可进入发布。
 */
export const PRODUCT_ERRORS = {
  NOT_FOUND: 'E-PRODUCT-NOT-FOUND',
  TRANSITION_INVALID: 'E-PRODUCT-TRANSITION-INVALID',
  NOT_CONNECTED: 'E-PRODUCT-NOT-CONNECTED',
} as const;

/**
 * 1688 官方 API 检索（T-M2-05a）稳定错误码：INVALID = AK 串无法解析（存面拒绝）；
 * MISSING = 已走 API 通道但 AK 未配置（防御性，正常路由不会出现）。
 * 与 adapters-1688 api-client 的 E-1688-API-{AUTH|RATELIMIT|PARAM|SERVICE|NETWORK}
 * 前缀同族——后者随错误消息透传，renderer 按前缀归因。
 */
export const SOURCING_AK_ERRORS = {
  INVALID: 'E-SOURCING-AK-INVALID',
  MISSING: 'E-SOURCING-AK-MISSING',
} as const;

/** 平台 → 首页 URL 与 Profile 子目录名（FR-3.3：每平台独立 Profile 目录持久化登录态） */
export const BROWSER_PLATFORM_URLS: Record<BrowserPlatformId, string> = {
  xhs: 'https://www.xiaohongshu.com',
  '1688': 'https://www.1688.com',
};
