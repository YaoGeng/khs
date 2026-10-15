# M2 内置浏览器整体切换计划（m2-builtin-browser-plan）

> 决策来源：用户指示（2026-10-15）「先 todo 13，然后整体调整为内置浏览器」；决策记录见
> `docs/adr/notes-browser-builtin.md`。
> **顺序约束**：M1 todo 13 真实窗口先行收口——真实采集证据基于现架构（用户本机 Chrome/Edge）
> 采集，作为内置版日后的风控对照基线。B1 之前不动任何 pilot 路径（doctor / launch / runbook
> 保持原样），保证 todo 13 在干净已提交基线上执行。

## 0. 决策解读（如与意图不符请纠正）

- **内置浏览器 = 应用自带便携版 Chromium**：npmmirror 快照镜像按需下载 + SHA-256 校验，
  **独立外部进程**，走现有 `launcher.ts` pipe 链路——cdp / automation / 让位 / 熔断 / 配额
  全部零改动（这是选外部进程形态的最大工程红利）。
- **不是** Electron WebContentsView 应用内嵌（合规定位理由见 ADR，维持暂缓）；
  **不是** Patchright 构建（补丁在 Playwright 驱动层，本仓无 Playwright 驱动，不适用）。
- 目标形态：**内置优先、用户浏览器兜底**——内置 Chromium 下载完成并校验通过后成为默认
  采集浏览器；本机 Chrome/Edge 保留为降级路径与下载失败兜底；设置项可显式切换优先级。

## 1. 技术要点

- 下载源（与仓内中国镜像模式一致，npmmirror 已实测存活，最新 revision 1710741 / 2026-10）：
  `https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Win_x64/<revision>/chrome-win.zip`；
  备源 Google 快照（境内通常不可达，仅记录不依赖）。
- **双 pin**：revision + 包体 SHA-256 写死进代码（实施时一次性真实下载计算留证）；更新策略
  = 应用发版携带新 pin，不做运行时自动跟版。
- 存储根：`%LOCALAPPDATA%/xinglian-workbench/browsers/chromium-<rev>/chrome-win/chrome.exe`
  （与 cdp-profiles 同根；`XINGLIAN_BUILTIN_BROWSER_ROOT` 为 dev/e2e seam）。
- 校验：下载流式 SHA-256；不符 → 删除重下（上限 3 次）→ 仍败降级用户浏览器 +
  `browser-detect-degraded` 留痕（复用 M0 降级口径）。
- 解压：**不新增 zip 运行时依赖**——extractor 经端口注入，生产实现用 Windows 自带
  `tar -xf`（Win10 1803+ 系统组件，支持 zip），测试用假实现。
- UA 诚实原则不变：真实 `Chromium/x.y.z` UA，不伪装（02:339 保持真实 UA 口径）。
- 磁盘空间预检（≥2× 包体）+ 下载进度 IPC 回流。

## 2. 分卡（四段式逐卡验收）

| 卡 | 内容 | 边界 |
|---|---|---|
| B1 ✅(9457d77) | `browser/builtin.ts`：URL 组装、双 pin 常量、流式哈希、原子落盘（临时目录→rename）、幂等安装检测（已存在且哈希匹配→跳过）、磁盘预检；单测全假注入 | 纯增量不接线，不动 detect/doctor |
| B2 ✅(5e41a51) | 接线：detect 顺序变更为 user-setting → built-in → chrome → edge、下载进度 IPC（channels/schemas/ipc-core 三面镜像）、设置 UI（下载按钮+进度+优先级开关）、doctor 输出内置状态、openPlatform 下载引导 | 待 todo 13 收口后动工 |
| B3 ✅(c87d432) | 文档与合规：ADR 定稿、01 §7.5 / 02 §5.1 授权段落变更走 tm101-diff-check 白名单流程、EULA 与文案 PC-12 复查、「仅驱动用户自有浏览器」表述重新锚定、pilot-runbook 更新 | 02 改动未过门禁不得合入 |
| B4 ✅ | 验收：fixture e2e（下载→校验→哈希不符拒绝→重下→激活）、一次性真实下载留证（独立脚本，非 ci）、`pnpm ci:all` 全绿、台账 + 证据落 `.omo/evidence/m2-builtin-browser/` | ~180MB 真实下载不进 ci:all |

## 3. 风险

- npmmirror revision 被清理/不可达 → 双 pin + 首次下载留证；文档记录备源与本地缓存路径。
- 快照 Chromium 无数字签名，杀软误报面 → 哈希 pin 自证 + 保留用户浏览器降级路径 + 文档告知。
- ~180MB 冷启动下载 → 进度 UI + 失败重试；v1 不做断点续传（已知限制，如实记录）。
- 「仅驱动用户自有浏览器」合规定位需重新锚定（01 §7.5）→ B3 流程处理：改为「应用托管的
  独立浏览器进程，用户本人在可见窗口完成登录，应用不读不存账密」（FR-3.1 红线不变）。
- 指纹面：Chromium 快照无 Chrome 品牌组件，UA 与真实 Chrome 存在可观测差异 → 保持真实
  UA 不伪装；todo 13 真实窗口的风控数据作为对照基线，后续在 bench/ 评估是否需要加码。

## 4. 验收（MUST）

1. 无浏览器机器全链可用：下载 → 校验 → pipe launch → openPlatform。
2. 哈希不符拒绝激活并自动重下，重下超限降级用户浏览器。
3. detect 顺序与设置开关生效；doctor 报告内置浏览器状态。
4. `pnpm ci:all` 全绿；tm101-diff-check 绿（02 改动在授权段落内）。
5. 每卡证据四段式（产物/证据/自测/风险）落档，台账逐卡记录。
