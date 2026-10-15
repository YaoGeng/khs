# 内置浏览器决策记录（notes-browser-builtin）

> 决策日：2026-10-15（用户指示）；状态：**已实施**（2026-10-16：B1 模块 9457d77 / B2 接线
> 5e41a51 / B4 一次性真实安装 PASS feada7b / B3 文档合规定稿本提交）。
> 双 pin 落地：revision `1710741` = Chromium `157.0.8086.0`，包体 360,101,018 B，
> SHA-256 `5b5f9d389007ad17e8b9246312ed459cf2f2e5b4c353909709fb0705b30cfe78`
> （实下载留证 `.omo/evidence/m2-builtin-browser/b1-evidence.md` + `b4-real-install.md`）。
> （分卡计划见 `.omo/plans/m2-builtin-browser-plan.md`）。
> 前置与承接：`notes-browser-m0.md` §6（便携 Chromium 下载分支当时「只记录不实现」）——
> 本决策将其从「降级分支」升级为「默认路径」，并附实施形态约束。01 §7.5 / 02 §5.1 的
> 授权段落变更已随 B3 走 tm101-diff-check 白名单流程（§5.1 区追加，授权链见脚本注释）。

## 1. 决策

浏览器获取策略整体调整为**应用自带便携版 Chromium**：

- 来源：npmmirror `chromium-browser-snapshots/Win_x64/<revision>/chrome-win.zip`
  （与仓内 electron/better-sqlite3 的中国镜像模式一致）；revision 与包体 SHA-256 双 pin
  进代码，更新随应用发版。
- 形态：**独立外部进程**，经现有 `launcher.ts` `--remote-debugging-pipe` 链路托管；
  CDP 客户端、采集自动化、让位、熔断、配额全部零改动。
- 优先级：内置优先；用户本机 Chrome/Edge 保留为降级兜底；设置项可切换。

## 2. 明确不做的两个形态

- **Electron WebContentsView 应用内嵌**：UA 带 Electron 标识、Chromium 版本钉死在
  Electron 发版节奏（当前 33 = Chromium 130，与真实 Chrome 差距随时间拉大）、升级跑步机
  放大既有 better-sqlite3 ABI 重编成本，且把用户登录会话放进应用进程。维持暂缓，
  重开条件 = 试点实测风控数据支持 + 01 §7.5 合规定位重新论证通过。
- **Patchright 构建**：其反检测补丁位于 Playwright 驱动层（本仓无 Playwright 驱动，
  泄漏面天然不存在），作为浏览器二进制分发还需自建下载/更新/签名链，不适用。

## 3. 理由

- 用户体验：不再依赖用户本机浏览器（探测失败是 onboarding 硬阻塞）；版本由应用控制，
  行为一致，减少「浏览器太旧」类支持面。
- 工程红利：外部进程形态让 pipe 零 TCP 暴露面红线、让位回声抑制、配额熔断全部原样保留，
  改动收敛在「浏览器从哪来」，不碰「浏览器怎么被驱动」。
- 合规姿态可重新锚定：应用托管的独立浏览器进程、用户本人在可见窗口完成登录（FR-3.1
  不读不存账密红线不变）、自动化让位于人工（FR-4.5 不变）；「仅驱动用户自有浏览器」
  表述在 01 §7.5 按白名单流程调整为上述口径。

## 4. 后果与风险

- 快照 Chromium 无数字签名 → 杀软误报面；缓解：双 pin 自证、保留用户浏览器降级路径、
  文档告知。
- ~180MB 冷启动下载 → 进度 UI + 重试；v1 无断点续传（已知限制）。
- UA 为真实 `Chromium/x.y.z`（无 Chrome 品牌组件），与真实 Chrome 存在可观测差异 →
  保持真实 UA 不伪装（02:339 口径不变）；M1 todo 13 真实窗口（用户本机 Chrome）的风控
  数据作为对照基线，差异是否需要加码由 bench/ 实验决定。
