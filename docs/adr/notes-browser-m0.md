# 受控浏览器接管 M0 实现取舍（notes-browser-m0）

> 映射 T-M0-08（计划 todo 10）；前置结论：`docs/spike/s6-debug-port.md`（T7，pipe 可用）；
> 证据：`.omo/evidence/mvp0-dev-plan/task-10-mvp0-dev-plan.log`。
> 本文只记录实现取舍与简化口径，不改 01~09 基线。

## 1. 选型：裸 CDP-over-pipe 客户端（不引 playwright-core 运行时依赖）

**决策**：`apps/desktop/src/browser/cdp.ts` + `launcher.ts` 自研 CDP 客户端，`child_process.spawn(chrome, [...], { stdio: ['ignore','pipe','pipe','pipe','pipe'] })`，fd3 写命令 / fd4 读响应、`\0` 分帧（T7 `bench/s6-debug/a1-pipe-raw.mjs` 验证过的配方，Chrome 154 / Edge 155 实测）。

**取舍理由**：
- T7 主集成形态建议是 Playwright `launchPersistentContext` 托管 pipe；根 devDeps 的 `@playwright/test` 确实可 require 其 playwright-core，但把它加进 desktop **运行时依赖**需要改 apps/desktop/package.json + pnpm-lock（本轮禁止 pnpm add/install）。裸客户端零新增依赖，且 M0 需要的 CDP 面很小（`Browser.getVersion` / `Target.getTargets` / `Target.createTarget` / `Target.attachToTarget` / `Page.navigate` / `Browser.close` + 事件监听），自研成本可控。
- 协议层（编解码/id 关联/事件扇出）是真实实现并单测覆盖（`cdp.test.ts` 10 例）；e2e 走真实 Chrome（非 mock）。
- **升级条款**：M1 采集自动化需要 page 级 API（选择器/等待/截图）时，引 playwright-core 替换 launcher 内部实现是局部改造（`BrowserService` 的 `ensureLaunched` 一个注入点），届时按 05 §7 变更流程走。

## 2. 连接韧性形态（02 §5.3 的 M0 落地）

- 主路径 = pipe（零 TCP 暴露面）；`XINGLIAN_CDP_TRANSPORT=port` 为显式 fallback 配置项（默认关闭），实现为 `port-fallback*.ts`：`--remote-debugging-port=0` + `DevToolsActivePort` 端口发现 + netstat 仅 loopback 断言 + CIM 进程树 PID 校验（**校验不进热路径**，S6 §3.2 教训）+ 运行时全局 `WebSocket` 判定（Electron 33 主进程 Node 20 无该全局量 → 明确报 `E-BROWSER-FALLBACK-UNAVAILABLE`，不静默换路）。纯逻辑单测覆盖，无 e2e（S6 结论）。
- **port 模式边界（S6 §5，必须遵守）**：对外来本机进程无接入层拒绝能力——M0 的 port fallback 只做「发现+处置」的校验层（防串台/假浏览器），不声称防恶意本机进程；pipe 路线该威胁在机制上不存在。
- 崩溃联动：CDP 管道关闭/健康 ping 失败 → 会话丢失 → `suspendRunningTasks('browser-lost')`（T11 runner 新增 `suspend(taskId, reason)`，XState running→suspended，事件落 `task_events`）→ 同 Profile 自动重拉（重试上限 3）→ 任务由人工 `tasks:resume` 按检查点续跑（02 §9.1：suspended→running 须人工确认）。
- 修掉的两个实现 bug 留痕：`waitForClose` 初版带 5s 超时（超时返回 `{code:null}` 被误判为浏览器丢失 → 假重拉）；`Target.getTargets` 响应字段是 `targetInfos`（初版按 `targets` 解析恒为空）。

## 3. 「断开人工浏览」语义：CDP 连接 + 浏览器进程一并关闭

**决策**（二选一，选关闭进程）：`browser:disconnect` 先 `Browser.close`（内核优雅退出 + Profile 冲刷），3s 未退再 `taskkill /T /F` 兜底。

**理由**：pipe 模式下 detached 后的浏览器**没有可重连端点**（S6 §2.4：connectOverCDP 只认 http/ws；pipe 无端点）——保留进程会让「再次接管」在两步内死锁：新浏览器进程撞上旧进程的 Profile 单例锁（`E-BROWSER-PROFILE-BUSY`）。关闭进程不损失登录态（FR-3.3：cookies/storage 已落盘专用 Profile）。

**代价与缓解**：用户丢一个窗口（含未提交表单）；app 退出路径用两段式 quit（`will-quit` preventDefault → 浏览器优雅退出 → 再 quit），不留孤儿 Chrome。

## 4. 会话健康检测规则（FR-3.4，M0 从简口径）

- **连接层**：周期 10s（`XINGLIAN_BROWSER_HEALTH_MS` 可覆盖）`Browser.getVersion` ping，3s 内无响应 = 连接丢失 → 崩溃联动。
- **会话层**：`Target.getTargets` 里平台标签 URL 命中登录特征集（`session.ts` `LOGIN_EXPIRED_URL_RULES`：xhs = `xiaohongshu.com/login*`；1688 = `login.1688.com` / `member.1688.com/member/login*`）→ 三态切「登录失效」+ 引导横幅（FR-3.4）；URL 离开特征集 → 自动回「已接管」。
- **从简边界**：只看 URL，不做「登录后元素」页面探测（02 §5.1 第 4 步的元素级探测归 M1 随采集工作流落地——它需要 Runtime.evaluate 注入页面，M0 不碰平台页面内容）。e2e 以受控导航（我们自己 `Target.attachToTarget` + `Page.navigate`）驱动到登录特征 URL 演示判定与引导，属客户端自身动作、非平台自动化。

## 5. 人工输入让位（FR-4.5/02 §9.1，M0 简化口径 —— 如实记录）

**M0 落地 = 机制桩**：
- `session.ts` `YieldFlag`：让位状态标志 + `whenAutomationAllowed()` 自动化动作门（M1 队列在执行动作前 await）；e2e 经 `XINGLIAN_DEBUG_HOOKS=1` 的进程内钩子驱动 → UI「人工接管中 · 自动化已让位」指示 + `data-browser-yielded` 断言标记。
- **未接线真实输入信号**：CDP `Input.dispatchKeyEvent` 是我方下发的命令（不是用户输入事件），Chrome 不向调试口上报本机用户输入；真实信号源（CDP 页面注入监听 / 原生 `SetWindowsHookEx` 钩子 / 前台窗口轮询）各有页面注入或权限面代价，M0 无业务自动化、无从让位，故只落机制与钩子。**M1 首个工作流落地时必须接真实信号并回到 02 §9.1 的 yielded 状态语义**（现状没有 `yielded` 任务态，是状态标志，S9 边界内）。

## 6. 便携 Chromium 降级分支：M0 只记录，不实现

FR-3.1 的「内置便携版 Chromium（按需下载+哈希校验）」M0 **不做**：本机探测（用户设置 `XINGLIAN_BROWSER_PATH` seam → 注册表 App Paths HKLM/HKCU → 常见路径）全空时 `openPlatform` 报 `E-BROWSER-NOT-FOUND`，`logger.systemError('browser-detect-degraded')` 留痕，UI 状态章保持「未接管」。下载校验链（源、哈希、打包集成、cold-start 影响）归 M1+ 单独立卡。

## 7. 其他边界注记

- **红线**：全链路不读取/存储平台账号密码，不触碰任何 Login/Cookie 写路径；登录态完全靠专用 Profile（`%LOCALAPPDATA%/xinglian-workbench/cdp-profiles/<platform>`，`XINGLIAN_CDP_PROFILE_ROOT` 为 e2e/dev seam）。e2e 的 cookies 证据是**文件存在 + host_key 域名字节命中**（只看域名存在性，不读 cookie 值——02 §5.2「客户端永不读取/导出 Cookie 内容」）。
- **锁语义**：`browser:openPlatform` 受 EULA 首启确认门约束（复用 T9 `isViewAllowed('dashboard')` 快照，拒绝码同为 `E-COMPLIANCE-EULA-LOCKED`）；`browser:status`（被动查询）与 `browser:disconnect`（安全动作）不受 EULA/license 锁约束。T8 的 license 锁定面（工作流写入口）未被触碰。
- **调试口红线**：pipe 路线绝不传 `--remote-debugging-port*`（`assertNoPortArgs` 启动期自检 + 单测锁定）；任何排障例外须显式 opt-in 并留档。
- 通道面变化：`browser:status / browser:openPlatform / browser:disconnect` 进入 M0 IPC 白名单（todo 10 授权范围）；`workflow:/review:/keys:` 仍归 M1+，越权拒绝 e2e 已改用这三个通道保持覆盖。

## 8. 让位机制的真实输入信号形态（M1 T-M1-03 塔基：passive 监听 + automation-window）

**决策**（M1 执行计划 todo 5 / T-M1-03；宿主接线归 T-M1-04）：真实输入信号采用 CDP `Page.addScriptToEvaluateOnNewDocument` 注入的 **passive 输入监听脚本**——只监听 `keydown`/`pointerdown` 两类事件、`{ passive: true }`、1s 节流写页面内全局时间戳 `window.__khs_yield__`；配合宿主侧 automation-window（每个 CDP 动作记录 start/end 时间戳，窗口内到达的输入判「自动化回声」丢弃，防自触发回环）与让位分类器（动作窗外的用户输入 → 让位；静默期满默认 3s → 恢复）。三者均为 `packages/stealth-middleware` 导出的纯常量/纯类（T-M1-03 交付），注入时机、`Runtime.evaluate` 轮询与 `whenAutomationAllowed()`（browser-service.ts 唯一入口）的对接归 todo 7——兑现本文件 §5 注记的「M1 首个工作流落地时必须接真实信号」。

**红线解释（与 01 §7.5 :386「不向平台页面注入脚本」的相容性）**：01:386 禁止的是**功能注入**——改变页面行为、伪装平台功能、绕过平台机制的脚本（该句同时把本产品与社区规范 2.3.1 所列「外挂程序」划清界限，依据恰是「本产品仅驱动用户自有浏览器」）。passive 监听脚本不属于功能注入，理由逐条对齐：
- **只读不干预**：仅登记事件监听读取用户自己的输入事件，不模拟、不拦截、不修改任何页面行为；`{ passive: true }` 在机制上排除 `preventDefault`，`capture` 只影响读取时机——对页面可观察行为为零改变；
- **不触碰平台数据面**：不读 DOM 内容、不发网络请求、不写 storage，唯一副作用是写一个页面内时间戳全局量，供宿主轮询判定「用户是否在操作」；
- **方向恰是红线承诺本身**：它存在的目的就是让自动化在用户亲手操作时**让位**（FR-4.5），是「仅驱动用户自有浏览器」承诺的落实件，与 M0 §5 的 `YieldFlag` 机制同一目标，本节为其补上真实信号源；
- 同类的 `navigator.webdriver` 去标志脚本（02 §7.2 :339 指纹降噪保守项）同为声明性降噪（getter 返回 undefined）而非功能伪造，且 02:339 已划死底线：不做 Canvas/WebGL 深度伪装、保持真实 UA/视口。

**边界**：不接真实采集流程（T-M1-04）；不做 Canvas/WebGL 深度伪装（02:339）；脚本内容以 `packages/stealth-middleware` 导出常量为唯一真源（含单测：节流 1s、幂等安装、passive 选项），宿主不得内联复制脚本字符串。
