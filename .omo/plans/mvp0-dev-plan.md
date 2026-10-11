# mvp0-dev-plan - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**Who this is for and what changes for them:** 开发执行者（工程师或 AI 执行代理）今天只有一行式任务卡，交付后拿到的是零面试可开工的 M0 地基执行计划；发起人在 M0 启动会可直接会签派发一份经双审的计划。

**What you'll get:** 从空工作区到 M0 门禁演示就绪：Monorepo+CI+打包、Electron 壳、可登录可兑换可签发的服务端、license 授权链、CDP 接管小红书、日志与合规骨架、三个技术 spike 结论（SQLite 写入、调试口、BYOK 能力矩阵）。

**Why this approach:** 完全沿用已三方评审的 05 基线，不另立基线；spike 用预置降级分支避免阻塞后续波次；激活码最小兑换补上基线内"门禁要求开卡 vs 兑换在 M5"的矛盾（已批准，启动会追认）。

**What it will NOT do:** 不做 M1+ 任何功能（采集/报告/选品/发布/推广/支付/B 端/词库）；不改 01~09 基线文档；本计划本身不写代码——执行归 /ulw-execute。

**Effort:** XL
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** Medium - spike 结论与原生扩展打包是主要不确定点，均已预置降级分支；不利时最差 M0 延 1 周从 M6 缓冲扣（05 §7）
**Decisions to sanity-check:** 双审构成=plan-consultant+plan-reviewer；D9 最小兑换入 M0（需启动会追认）；D7 最小任务运行器并入日志卡；C-3 预算按 03:230 分解

Your next move: 双审进行中——plan-consultant 缺口分析后交 plan-reviewer 终审；交付后由 /ulw-execute mvp0-dev-plan 启动执行。Full execution detail follows below.

---

> TL;DR (machine): XL / Medium / 从零建 Monorepo+Electron 壳+auth+license+CDP 接管+日志+合规+3 spike，M0 门禁演示就绪；11 实现 todo+4 终验，双审后交付

## Scope
### Affected user and ideal state
**Affected user:** 开发执行者（客户端/服务端/Agent 工程师或 AI 执行代理，今天只有 05 的一行式任务卡，交付后零面试开工）；用户本人（M0 启动会主持，交付后有一份双审过的执行计划可直接会签派发）；03~09 评审链与 05 基线（计划只做执行细化并回指，不产生第二基线）

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | 执行者对 M0 全部 11 张任务卡获得零面试可执行的开发计划行：精确文件/模块引用、agent 可执行验收标准、happy+failure QA 场景与证据路径、推荐执行路由 | 05 卡片仅一行内容+负责+产出+依赖（05:56-66），无验收与 QA |
| IS-2 | 计划与 05 v1.1、PRD v1.3、架构 v1.1 零漂移，Must-NOT-Have 护栏禁止 M1+ 与基线修改 | 范围变更须走 05 §8 三方会签，执行计划不得私改基线 |
| IS-3 | M0 退出门禁 6 项（05:68-77）逐项映射到计划内 QA 场景与证据路径 | 门禁表仅有证据类型，无逐项 QA 场景 |
| IS-4 | 计划经双审并留回执：plan-consultant 缺口分析修订 + plan-reviewer 高精度终审通过 | 用户明确要求"计划双审" |
| IS-5 | spike 卡（T-M0-04/05/06）不利结论的处理分支固化在计划内（预置降级方案，不让 spike 阻塞 Wave 5） | 05 §7 有风险应对文字但未固化为任务分支 |
| GAP-1 | 不存在任何 M0 执行级开发计划 | 本文件即产物 |
| GAP-2 | 05 各 M0 卡缺验收标准/QA/证据路径/执行路由，执行者无法零面试开工 | 每个实现 todo 对应关闭 |
| GAP-3 | spike 不利结论分支未固化 | spike 类 todo 的 failure QA 分支关闭 |
| GAP-4 | 双审未发生 | plan-consultant + plan-reviewer 两道审关闭 |

### Must have
- T-M0-01~11 全部 11 卡的执行级 todo（与基线一一对账，D9/D7 扩展显式标注）
- 入口前置说明（T-PRE-01~03/05 已完成，T-PRE-04 启动会为用户主持的人工前置，05:38-44）
- 05:68-77 门禁 6 项 → Success criteria 逐项映射
- F1~F4 最终验证波
- M0 并行行政线 checklist（owner=发起人，非实现 todo）：商户号申请启动、ICP 备案、等保二级、Sentry 部署地域方案（05 §7 风险表"M0 即启动商户号"、05:221 T-M6-05"M0 起行政并行，M6 收口"）——M0 窗口内无人启动将直接威胁 M5 支付与 M6 资质门禁

### Must NOT have (guardrails, anti-slop, scope boundaries)
- M1+ 任何功能实现（采集/报告/选品/发布/推广/支付/B 端页面/词库/新手引导）
- 对 01~09 基线文档的任何修改
- P1 提前（FR-2.4~2.6、FR-12.2/12.3 等）
- 任何超出 05 §8 变更机制的范围调整（D9 最小兑换为例外，已经用户 2026-10-10 批准并须 T-PRE-04 三方追认）
- 本计划不写产品代码——执行归 /ulw-execute

## Verification strategy
> Zero human intervention - all verification is agent-executed.
> 人工动作白名单（计划外的项目机制，非 QA）：T-PRE-04 启动会（会签/追认 D9 与验证码投递收窄）、spike 评审签发与 M0 门禁会（agent 备材料包与纪要草稿，见 F3 ③；05 §8）、最终完成确认。
- Test decision: tests-after + agent-executed QA。单测 vitest（全仓 TS，02:164 §3.3）、服务端 e2e supertest、C 端 e2e Playwright（headful 真实浏览器链路）。框架为默认选择（02 §3.3 未指定），执行器可按仓库实际微调，但不得移除 e2e 断言。
- Evidence: .omo/evidence/mvp0-dev-plan/task-<N>-mvp0-dev-plan.<ext>（本计划不在 ulw-loop 内，统一用 .omo/evidence/mvp0-dev-plan/）

## Execution strategy
### Parallel execution waves
> 05§1"每次只派一个 READY 任务"是人工派发节奏；AI 执行按波次推进，卡间依赖不得越序，卡内串行。
- Wave 1（并行 3）：todo 1（Monorepo/CI/打包）∥ todo 2（服务端 auth+最小兑换）∥ todo 3（工程规范）
- Wave 2（并行 2）：todo 4（Electron 壳）∥ todo 5（BYOK 矩阵+sqlite-vec）
- Wave 3（2）：todo 6（S3 spike）∥ todo 7（S6 spike）——注：两卡在 05 同属客户端 TL（05:59-60），人工执行时串行；AI 执行可并行
- Wave 4（并行 2）：todo 8（授权链路）∥ todo 9（EULA/遥测）
- Wave 5（并行 2）：todo 10（CDP 接管）∥ todo 11（日志/store+任务运行器）
- 最终验证波：F1∥F2∥F3∥F4 全过 + 用户确认后才算完成

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | 无（T-PRE 文档基线已齐，05:44） | 4, 5 | 2, 3 |
| 2 | 无 | 8 | 1, 3 |
| 3 | 无 | — | 1, 2 |
| 4 | 1 | 6, 7, 9, 10 | 5 |
| 5 | 1 | — | 4 |
| 6 | 4 | 11 | 7 |
| 7 | 4 | 10 | 6 |
| 8 | 2（05:62）；4（客户端侧，推断） | — | 9 |
| 9 | 4（05:66）；T-PRE-05 已完成 | — | 8 |
| 10 | 7（05:63） | — | 11 |
| 11 | 6（05:64） | — | 10 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Monorepo+CI+打包管线与启动性能预算（映射 T-M0-01）
  What to do / Must NOT do: 工作区根 git init 并建 pnpm workspace Monorepo（全仓 TS，02:164-166 §3.3）：apps/desktop（Electron 空壳）、apps/server（NestJS 空模块）、apps/admin（仅目录占位，M5 范围）、packages/{protocol,workflow,logger,llm-gateway,agents,humanize,adapters-xhs,adapters-1688}（包名对齐 02:197-215 §4.2 模块清单与 §6/§7/§8 各包）；根 pnpm-workspace.yaml+tsconfig base+vitest/playwright 脚手架；本地质量门脚本 lint+test+build 三关（CI-ready，pnpm ci:all；托管 CI 待 git 远端建立后接入——无远端不设假 CI）；electron-builder asar 打包空壳走通；签名/notarize 按 M0 降级默认：产出未签名安装包+docs/perf/packaging-status.md 记录"证书缺失降级"并注记 M5 T-M5-04 自动更新前必须补齐（Win 证书与 Apple Developer $99/年均为付费项且 macOS runner 当前不可得；发起人可随时改判采购升级管线，可逆）（05:56 基线含签名/notarize，02:751-766 §15.1）；产出 docs/perf/cold-start-budget.md：按 03:230 C-3 分解启动性能预算（主进程延迟加载、V8 snapshot、渲染首屏骨架），总预算对照 NFR-1 ≤3s（01:262）。既有 01~09 文档与 c端原型.html 原样首次提交入库不改内容。Must NOT do：不实现业务模块内部逻辑；不建 B 端页面；不改 01~09 文档。
  Closes: GAP-1, GAP-2
  Parallelization: Wave 1 | Blocked by: 无（T-PRE 文档基线已齐，05:44） | Blocks: 4, 5
  References (executor has NO interview context - be exhaustive): 05:56（卡定义）；02:135-151（§3.1 选型总表=强制栈）；02:164-185（§3.3 Monorepo/工程规范）；02:197-215（§4.2 主进程模块清单→包结构）；02:751-766（§15.1 发布管线）；03:230（C-3 预算要求）；01:262（NFR-1）；04:94（S11 打包验证挂 M0 的原因）
  Acceptance criteria (agent-executable): `pnpm install && pnpm -r lint && pnpm -r test && pnpm -r build` 全绿；`pnpm --filter desktop dist`（或等价脚本）产出安装包产物且 packaging-status.md 含签名/notarize 状态列（已签/降级记录）；docs/perf/cold-start-budget.md 存在且含预算分解表与 NFR-1 对照行
  QA scenarios (name the exact tool + invocation): happy=`pnpm -r test` 全绿且安装包产物存在（bash 校验 dist 路径）；failure=故意引入 lint 错误验证 CI 拦截（`pnpm -r lint` 非零退出）, Evidence .omo/evidence/mvp0-dev-plan/task-1-mvp0-dev-plan.log
  Commit: Y | feat(infra): init pnpm monorepo, CI gates, packaging pipeline, cold-start budget
  Recommended task executor category: unspecified-high（多包工程搭建，标准多文件特性）
- [x] 2. 服务端骨架：auth+最小激活码兑换（映射 T-M0-03+D9 扩展）
  What to do / Must NOT do: apps/server 建 NestJS 模块化单体（ORM=Prisma，02:147 §3.1 选型总表强制栈；02:635-645 §12.1，仅账户与授权模块）：POST /auth/register（邮箱+验证码：Redis 存取 5 分钟有效（02 §13 接口摘要）；M0 投递走 dev 传输——QA 直读 Redis/非生产环境随响应返回，生产 SMTP 随 T-M5 落地并记 ADR 注记，与 D9 同批在 T-PRE-04 追认）、POST /auth/login（密码 BCrypt 哈希入库；图形验证码（SVG 算术码，答案入 Redis，01:113 FR-1.2 P0）+连续失败 5 次锁 15 分钟，01:112-113 FR-1.1/1.2、02:618-624 §11.3）、POST /auth/refresh；users/memberships 表含 tier 列（T-PRE-02 已落架构 v1.1，02:719-732 §14.2）；PG+Redis docker-compose.yml（02:767-775 §15.3）；D9 批准的最小兑换：POST /cards/redeem（cards 表{code_hash,status,plan,tier,redeemed_by,redeemed_at}、单码生成脚本 scripts/gen-card.mjs、防重放=事务内 status 条件更新、兑换写审计记录），签发 JWT claims 含 sub/plan/tier/device_limit（02:660-665 §12.3）。Must NOT do：不做支付/商户号（M5，05:190）；不做 B 端页面；不做卡批次管理/导出/防爆破全量（T-M5-02 范围）；不做邮件通知（FR-12.3，P1）与生产 SMTP 集成（M0 用 dev 传输）。
  Closes: GAP-2
  Parallelization: Wave 1 | Blocked by: 无 | Blocks: 8
  References (executor has NO interview context - be exhaustive): 05:58（卡定义）；05:72（门禁 1 要求开卡）；05:190（兑换全量在 T-M5-02，本 todo 只做最小闭环）；02:135-151（§3.1 选型总表，含 02:147 Prisma）；02:635-645（§12.1）；02:660-665（§12.3 claims）；02:673-696（§13 接口摘要）；02:697-732（§14 数据模型）；02:767-775（§15.3）；01:112-114（FR-1.1/1.2/1.3）；草稿 D9（用户 2026-10-10 批准）
  Acceptance criteria (agent-executable): `pnpm --filter server test` 覆盖注册/登录（含图形验证码）/锁定/兑换/重复兑换拒绝/篡改码拒绝全绿；supertest e2e：注册→生成码→兑换→登录→JWT 解出 tier/device_limit
  QA scenarios (name the exact tool + invocation): happy=supertest 注册→兑换→登录断言 200 与 claims；failure=同码二次兑换 409、错误密码第 6 次触发 15 分钟锁定断言, Evidence .omo/evidence/mvp0-dev-plan/task-2-mvp0-dev-plan.log
  Commit: Y | feat(server): auth skeleton + minimal card redeem (D9)
  Recommended task executor category: unspecified-high（标准多文件后端特性）
- [x] 3. 编码规范固化：XState/DAG 边界+任务卡制度（映射 T-M0-10）
  What to do / Must NOT do: docs/dev/工程规范.md 固化：状态机只管任务生命周期、DAG 只管步骤拓扑与检查点、禁止步骤级状态进 XState（04:92 S9、02:145 选型行）；任务卡派发/完成报告四段式制度（产物/证据/自测/风险，05 §8 机制 3）；目录边界约定（apps 不得互 import，跨端只经 packages/protocol）落到独立 lint 配置切片 eslint.boundaries.mjs（独立文件，避免与 todo 1 并行写根配置冲突）。Must NOT do：不写业务代码；不改 05 门禁标准。
  Closes: GAP-2
  Parallelization: Wave 1 | Blocked by: 无 | Blocks: 无（约束性文档，todos 1-11 遵循）
  References (executor has NO interview context - be exhaustive): 05:65（卡定义）；05 §8（变更与门禁机制）；04:92（S9 边界要求）；02:145（XState v5+自研 DAG 选型）；02:164-185（§3.3 工程规范基础）
  Acceptance criteria (agent-executable): docs/dev/工程规范.md 含 S9 边界节、任务卡四段式模板、目录边界节三部分；lint 配置存在目录边界规则
  QA scenarios (name the exact tool + invocation): happy=文档三节齐全+`pnpm -r lint` 边界规则生效；failure=在 apps 间故意建 import 验证 lint 报错, Evidence .omo/evidence/mvp0-dev-plan/task-3-mvp0-dev-plan.md
  Commit: Y | docs(dev): engineering standards, S9 boundary, task-card protocol
  Recommended task executor category: writing（纯规范文档）
- [x] 4. Electron 壳：进程模型+IPC 契约（映射 T-M0-02）
  What to do / Must NOT do: apps/desktop 建 main/preload/renderer 三进程（02:188-196 §4.1）：webPreferences{contextIsolation:true,nodeIntegration:false,sandbox:true}（02:610-617 §11.2）；preload 经 contextBridge 仅暴露白名单通道，ipcMain.handle 入参 zod 校验（02:216-231 §4.3）；CSP self；单实例锁（02:204 附近 §4.2）；九视图导航骨架（dashboard/insight/report/sourcing/publish/promo/review/logs/settings，对应 c端原型.html，仅路由占位）；C-3 三招落地：主进程延迟加载、V8 snapshot、首屏骨架（03:230）。Must NOT do：不实现业务视图内容；不接业务 API（仅登录页占位）；不引入 workflow 逻辑。
  Closes: GAP-2
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6, 7, 9, 10
  References (executor has NO interview context - be exhaustive): 05:57（卡定义）；02:188-231（§4.1-§4.3）；02:610-617（§11.2）；c端原型.html（九视图结构，只读参照）；03:230（C-3 三招）；01:262（NFR-1）
  Acceptance criteria (agent-executable): `pnpm --filter desktop test` 含 IPC 越权用例全绿；dev 启动出九视图骨架；webPreferences 安全基线快照测试通过；空壳冷启动本地实测写入 docs/perf/cold-start-measured.md（必含机器规格行；判定协议：同档或以上规格 p50 ≤3s 即过，超预算→按 todo 1 预算分解表定位超支项→转新实现行）
  QA scenarios (name the exact tool + invocation): happy=Playwright e2e 九视图导航可达；failure=渲染进程尝试 Node 通道被拒（断言 window.require undefined）, Evidence .omo/evidence/mvp0-dev-plan/task-4-mvp0-dev-plan.log
  Commit: Y | feat(desktop): electron shell, IPC contract, CSP, cold-start measures
  Recommended task executor category: unspecified-high（标准多文件桌面特性）
- [x] 5. BYOK 能力探测矩阵+sqlite-vec 打包验证（映射 T-M0-06，S4+S11）
  What to do / Must NOT do: packages/llm-gateway 探测脚本 scripts/probe-providers.mjs：对 DeepSeek/通义/智谱/OpenAI/硅基流动（01:126 FR-2.1 预设）各探 json_schema 结构化输出、tool calling、embeddings 三能力（实测+官方文档双源核对，无 Key 者标注文档源），产出 docs/adr/provider-matrix.md 矩阵（含境外可达性风险列）+能力分档预设结论（05 §7 R9 降级链），能力分档预设常量落 packages/llm-gateway/src/presets.ts（逐档标注[实测/文档]来源，与矩阵互链——IS-5 的 M0 内下游引用凭证）；better-sqlite3+sqlite-vec 原生扩展在 electron-builder asar 打包后加载验证脚本（Win 必做，macOS 有条件则补，04:94、02:699-718 §14.1）；不利结论 fallback：能力分档预设（05 §7 R9）+本地嵌入缓存表设计注记（02:69 附近 §3.1）写入矩阵。探测 Key 只来自环境变量（契约：PROBE_<PROVIDER>_API_KEY / PROBE_<PROVIDER>_BASE_URL）。Must NOT do：不实现真实 LLM 业务调用链（M1）；不上传任何真实用户 Key。
  Closes: GAP-2, GAP-3
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 无（M1 的 T-M1-05/T-M1-01 消费，05:87,91）
  References (executor has NO interview context - be exhaustive): 05:61（卡定义）；04:59-68（S4 问题与建议）；04:94（S11 打包验证）；05 §7 R9 行；01:126（FR-2.1 五家预设）；02:143（§3.1 选型表 sqlite-vec 行）
  Acceptance criteria (agent-executable): docs/adr/provider-matrix.md 含 5×3 矩阵且每格标注[实测/文档]；packages/llm-gateway/src/presets.ts 存在并与矩阵互链；打包产物内 sqlite-vec 加载脚本运行成功或明确记录不可行 fallback
  QA scenarios (name the exact tool + invocation): happy=有 Key（env 契约）者标[实测]并跑通（≥1 家），其余标[文档]，全部无 Key 时升级发起人申请测试 Key；failure=错误 base_url 验证探测失败分支可读, Evidence .omo/evidence/mvp0-dev-plan/task-5-mvp0-dev-plan.log
  Commit: Y | feat(llm-gateway): provider capability matrix + sqlite-vec packaging validation
  Recommended task executor category: deep-low（探测验证类，外部依赖碎片化，可自证）
- [x] 6. Spike S3：主进程 SQLite 写阻塞实测→ADR-8（映射 T-M0-04）
  What to do / Must NOT do: bench/sqlite-write-bench.mjs 合成写负载：对比主进程直写（better-sqlite3 同步）vs utilityProcess 托管写 vs 事务粒度约束三方案的事件循环阻塞毫秒与吞吐（04:52-58 S3）；数值化判定标准（如单次阻塞 p95 >50ms 不可接受）写入 docs/adr/ADR-8-sqlite-write.md，含选型结论+迁移约束；按 D6 fallback：同步写超标且 utilityProcess 改造代价超预算时，结论锁定为"utilityProcess 托管写"并给改造清单；不利结论无论是否落 D6 预置分支，均在评审材料包中标注并当周升级架构师确认（05 §7）。Must NOT do：不实现正式 store 层（todo 11）；不改 apps/desktop 业务代码。
  Closes: GAP-2, GAP-3
  Parallelization: Wave 3 | Blocked by: 4（05:59） | Blocks: 11（05:64）
  References (executor has NO interview context - be exhaustive): 05:59（卡定义）；04:52-58（S3 全文）；04:111（放行条件：spike 报告 M0 内）；05 §7 spike 风险行（不利当周升级、最差 M0+1 周从 M6 扣）；02:699-703（§14.1 WAL）
  Acceptance criteria (agent-executable): bench 可重复运行输出三方案 median/p95；ADR-8 含数值结论+判定标准+选型；结论被 todo 11 引用
  QA scenarios (name the exact tool + invocation): happy=基准三次运行输出稳定（脚本打印 median/p95）；failure=人为锁库验证阻塞检测路径触发, Evidence .omo/evidence/mvp0-dev-plan/task-6-mvp0-dev-plan.log
  Commit: Y | docs(adr): ADR-8 sqlite write strategy with benchmark evidence
  Recommended task executor category: deep-low（实验测量，结论可自证）
- [x] 7. Spike S6：CDP 调试口方案（映射 T-M0-05）
  What to do / Must NOT do: 出结论报告 docs/spike/s6-debug-port.md：(a) --remote-debugging-pipe + Playwright connectOverCDP 支持度实测；(b) 来源 PID 校验方案（DevToolsActivePort+进程树校验）；按 02:248-254 §5.3 与 02:610-617 §11.2 安全要求给出口径：pipe 可行则 pipe，否则 port=0+loopback+PID 校验（D6 fallback）；渗透级验证留 M6（04:114）；不利结论无论是否落 D6 预置分支，均在评审材料包中标注并当周升级架构师确认（05 §7）。Must NOT do：不实现 browser-service 全量（todo 10）；不做 M6 渗透项。
  Closes: GAP-2, GAP-3
  Parallelization: Wave 3 | Blocked by: 4（05:60） | Blocks: 10（05:63）
  References (executor has NO interview context - be exhaustive): 05:60（卡定义）；04:73-77（S6 全文）；04:114（放行条件）；02:248-254（§5.3 连接韧性）；02:610-617（§11.2）
  Acceptance criteria (agent-executable): 报告含两路线实测证据（命令+输出）与明确选型；结论成为 todo 10 的配置项
  QA scenarios (name the exact tool + invocation): happy=选型路线本地复现成功（attach 成功且实测时延记录在案）；failure=模拟外来进程连接调试口被拒（PID 校验生效）, Evidence .omo/evidence/mvp0-dev-plan/task-7-mvp0-dev-plan.log
  Commit: Y | docs(spike): S6 CDP debug-port strategy with evidence
  Recommended task executor category: deep-low（安全实验，结论可自证）
- [x] 8. 授权链路：license 签发/验签/设备绑定（映射 T-M0-07）
  What to do / Must NOT do: 服务端 Ed25519 私钥签发 license（claims：sub/plan/tier/device_limit/exp/device_hash/jti，02:660-665 §12.3、02:548-566 §9.5 时序）；客户端 license-manager 离线验签（公钥内置）+设备指纹仅存哈希（02:625-632 §11.4）+72h 离线宽限（01:116 FR-1.5）+到期锁定（工作流入口锁、历史查看+日志导出路由保留，01:117 FR-1.6）+个人版第 2 台设备阻断（01:115 FR-1.4）+解绑 30 天限 1 次（01:115）；与 todo 2 兑换联动：兑换→会员生效→签发全链通（05:72 门禁 1）。jti 在线吊销需配置中心（M5）——M0 仅记录不吊销，写入 ADR 注记。Must NOT do：不做支付；不做 B 端设备管理页；团队版 3 台只做校验逻辑，门禁验收以个人版第 2 台阻断为准。
  Closes: GAP-2
  Parallelization: Wave 4 | Blocked by: 2（05:62）；4（客户端侧，推断） | Blocks: 无
  References (executor has NO interview context - be exhaustive): 05:62（卡定义）；02:548-566（§9.5）；02:660-665（§12.3）；01:115-118（FR-1.4/1.5/1.6）；02:625-632（§11.4）；05:72（门禁 1）
  Acceptance criteria (agent-executable): e2e：注册→兑换→签发→激活→第 2 台阻断→离线 72h 内可用→模拟到期→执行入口锁定且日志/历史路由不锁（占位路由可达断言；真实导出能力归 M1/M5 对应卡）；验签测试含篡改 payload/过期/算法混淆用例
  QA scenarios (name the exact tool + invocation): happy=supertest+Playwright 联合 e2e 全流程脚本化断言；failure=篡改 license 验签失败、宽限期外锁定, Evidence .omo/evidence/mvp0-dev-plan/task-8-mvp0-dev-plan.log
  Commit: Y | feat(license): ed25519 license chain, device binding, grace, tier limit
  Recommended task executor category: unspecified-high（跨端安全链路，标准多文件特性）
- [ ] 9. EULA+遥测合规基础（映射 T-M0-11）
  What to do / Must NOT do: apps/desktop 合规模块：FR-1.9 首启 EULA+隐私政策弹窗（未确认锁定主功能路由守卫；版本变更重确认；确认记录{eula_version,confirmed_at} 落 SQLite 留痕，01:120）；FR-12.6 遥测 opt-in 开关（首启征求、设置可关、界面匿名化口径声明文案位，01:244）；本地守卫：遥测发送唯一出口断言 consent===true（真实上报器 M1 T-M1-07 才有，05:93——本 todo 只做开关+守卫+留痕）。Must NOT do：不接真实上报通道；不写隐私政策法律终稿（M6 T-M6-02 定稿，05 §4 M6——用占位文本+版本号机制）。
  Closes: GAP-2
  Parallelization: Wave 4 | Blocked by: 4（05:66） | Blocks: 无（T-M1-07 消费同意标志，05:93）
  References (executor has NO interview context - be exhaustive): 05:66（卡定义）；01:120（FR-1.9 全文）；01:244（FR-12.6 全文）；05:93（T-M1-07 依赖）；06-产品合规评审报告.md PC-01/PC-02（合规依据）
  Acceptance criteria (agent-executable): 未确认 EULA 时主功能路由被锁且确认后解锁（Playwright 断言）；确认记录落库含版本号+时间戳；关闭遥测后无任何网络发送（本地断言）
  QA scenarios (name the exact tool + invocation): happy=首启确认流 e2e；failure=拒绝 EULA→功能锁→版本升级→重确认弹窗, Evidence .omo/evidence/mvp0-dev-plan/task-9-mvp0-dev-plan.log
  Commit: Y | feat(compliance): EULA first-run gate + telemetry opt-in guard
  Recommended task executor category: unspecified-high（标准多文件桌面特性，合规硬验收）
- [ ] 10. 受控浏览器接管 browser-service（映射 T-M0-08）
  What to do / Must NOT do: 主进程 browser-service 模块（按 todo 3 规范定界，放 apps/desktop 或 packages/）：一键拉起独立 Chrome/Edge（优先用户设置→依次探测本机 Chrome/Edge 安装路径→无则按需下载随包便携 Chromium（哈希校验，02:234-240 §5.1）；M0 主路径覆盖本机已装 Chrome/Edge，下载分支作降级记录，01:138 FR-3.1）；按 todo 7 选型接 CDP（pipe 或 port=0+PID 校验）；每平台独立 Profile 目录持久化登录态（01:140 FR-3.3）；会话健康检测+失效引导重登（01:141 FR-3.4）；三态标题栏（已接管/未接管/登录失效）+一键断开人工浏览（01:142 FR-3.5）；人工输入让位（检测到真实输入事件即暂停自动化，01:154 FR-4.5、02:428-454 §9.1）；平台快捷入口小红书/1688 新标签（01:139 FR-3.2）；绝不读取/存储平台账号密码（01:139、02:242-247 §5.2）。Must NOT do：不做采集/发布/评论任何自动化（M1-M4）；不做多账号多 Profile 并行（P2，01:143 FR-3.6）。
  Closes: GAP-2
  Parallelization: Wave 5 | Blocked by: 7（05:63） | Blocks: 无（M1 采集消费）
  References (executor has NO interview context - be exhaustive): 05:63（卡定义）；02:232-254（§5 全章）；01:138-143（FR-3.1~3.6）；01:154（FR-4.5）；02:428-454（§9.1）
  Acceptance criteria (agent-executable): 一键打开小红书→CDP 接管成功→标题栏"已接管"→重启客户端登录态保持（脚本断言+录屏）；健康检测失效场景引导重登
  QA scenarios (name the exact tool + invocation): happy=e2e 全链路（headful 真实浏览器）；failure=杀浏览器进程→任务 suspended→重拉恢复到检查点（与 todo 11 联动）, Evidence .omo/evidence/mvp0-dev-plan/task-10-mvp0-dev-plan.log
  Commit: Y | feat(browser): controlled browser launch, CDP takeover, session health
  Recommended task executor category: unspecified-high（标准多文件桌面特性，真实浏览器集成）
- [ ] 11. 日志/store+最小任务运行器（映射 T-M0-09+D7 扩展）
  What to do / Must NOT do: packages/logger+apps/desktop store：pino NDJSON 五类日志（用户操作/自动化步骤/LLM 调用/网络元数据/系统错误，01:218 FR-10.1、02:569-578 §10.1）+logs 表 SQLite 索引+trace_id/span_id 贯穿（02:579-583 §10.2）+本地 90 天/网络元数据 30 天保留（01:220 FR-10.3）；better-sqlite3+drizzle WAL+版本迁移链（02:197-215 §4.2，按 todo 6 ADR-8 结论落位）；D7 批准的最小任务运行器：tasks/task_steps/task_events 三表（02:709-710）+XState v5 任务生命周期（02:428-454 §9.1）+启动恢复 running→suspended 降级（02:453）+按 task_steps 检查点续跑（02:257-262 §6.1）；内置 kind=demo 合成任务（2-3 个带 checkpoint 的哑步骤）作为门禁④唯一演示载体（M0 无业务 DAG，禁止为演示提前实现业务步骤）。Must NOT do：不实现采集/发布 DAG 具体步骤（M1-M3）；不做日志导出 UI；不做 LLM 成本计量。
  Closes: GAP-2
  Parallelization: Wave 5 | Blocked by: 6（05:64） | Blocks: 无（M1 DAG 消费）
  References (executor has NO interview context - be exhaustive): 05:64（卡定义）；02:569-596（§10 全章）；02:699-710（§14.1 表，含 02:709-710 task_steps/task_events）；02:428-454（§9.1，02:453 持久化规则）；02:257-262（§6.1 检查点）；01:218-220（FR-10.1/10.3）；todo 6 ADR-8 结论
  Acceptance criteria (agent-executable): 迁移链升级与回滚测试覆盖；崩溃恢复 e2e：造 running 的 kind=demo 合成任务→kill 进程→重启→状态 suspended→按检查点续跑完成（05:68-77 门禁 4 证据）；五类日志各产样例且可按 trace_id 串联查询
  QA scenarios (name the exact tool + invocation): happy=kill-recover 脚本化 e2e 断言；failure=损坏 DB 文件→迁移失败→回滚上一版本且报错可读, Evidence .omo/evidence/mvp0-dev-plan/task-11-mvp0-dev-plan.log
  Commit: Y | feat(logger,store): pino ndjson pipeline, migration chain, minimal task runner
  Recommended task executor category: unspecified-high（跨模块持久化+状态机，标准多文件特性）

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. 计划符合性与基线对账审计
  What to do: 对照本计划与 05 v1.1 基线：11 个实现 todo 与 T-M0-01~11 一一对应无遗漏（D9/D7 扩展已标注且有用户批准记录）；Must NOT have 清单零违反；05:68-77 门禁 6 项在 Success criteria 全有映射；草稿台账（.omo/drafts/mvp0-dev-plan.md）决策 D1~D9 在计划中有落点。
  Acceptance: 对账表三列（05 卡号↔todo↔差异说明）零未解释差异, Evidence .omo/evidence/mvp0-dev-plan/f1-audit.md
- [ ] F2. 代码质量评审
  What to do: 全仓 `pnpm -r lint && pnpm -r test` 重跑全绿；S9 边界抽查（步骤级状态不进 XState，对照 todo 3 规范）；02:610-624 §11.2/§11.3 安全清单核对（CSP、contextIsolation、BCrypt、锁定策略、指纹哈希）；`pnpm audit` 高危清零或记录豁免理由。
  Acceptance: 四项检查全过或问题转新实现行, Evidence .omo/evidence/mvp0-dev-plan/f2-quality.md
- [ ] F3. 真实手动 QA（门禁演示面，agent 代人执行并留证）
  What to do: 逐项执行 05:68-77 六项门禁并固化证据：①注册→兑换→登录→签发→第 2 台阻断（todo 2/8）；②一键接管+重启登录态保持（todo 10）；③agent 产出 spike 评审材料包（报告+fallback 对照+建议决议）并起草评审纪要归档 evidence，纪要签发属人工白名单动作，不利结论当周升级架构师（05 §7、05:74 门禁③证据=报告+评审纪要）；④崩溃恢复 running→suspended→续跑（todo 11，kind=demo 合成任务）；⑤冷启动实测对照 NFR-1 ≤3s（判定协议见 todo 4：机器规格行+p50 判定+超支转新实现行）（todo 1/4，03:230）；⑥EULA 未确认锁功能+遥测未同意不上报（todo 9）。
  Acceptance: 六项证据表每项含操作记录+断言结果+产物路径, Evidence .omo/evidence/mvp0-dev-plan/f3-gate-evidence.md
- [ ] F4. 理想态保真
  What to do: IS-1~IS-5 逐行对照交付物（对账 .omo/drafts/mvp0-dev-plan.md 台账）；任何落差转新 `- [ ] N.` 实现行，不允许以备注形式放过。
  Acceptance: 五行 IS 全部有交付物证据且无未决落差, Evidence .omo/evidence/mvp0-dev-plan/f4-fidelity.md

## Commit strategy

- 仓库由 todo 1 git init；既有 01~09 文档与 c端原型.html 首次提交原样入库（不改内容）。
- 每 todo 一个 conventional commit（见各 todo Commit 行）；分支 main。
- 双审修订记录于草稿台账 review 块与计划正文（双审发生在 todo 1 git init 之前，无法独立 commit）；随 todo 1 首次提交入库，SHA 回执存台账。
- F1~F4 全过且用户明确确认后 tag m0-gate；不预设任何发布/推送动作。

## Success criteria
> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 1-11 | 每 todo 验收标准与 happy/failure QA 全过 | .omo/evidence/mvp0-dev-plan/task-{1..11}-mvp0-dev-plan.* |
| IS-2 | F1 | 对账表零漂移、Must NOT have 零违反 | .omo/evidence/mvp0-dev-plan/f1-audit.md |
| IS-3 | 2,8（门禁①）/10（②）/5,6,7（③）/11（④）/1,4（⑤）/9（⑥） | F3 六项门禁证据表 | .omo/evidence/mvp0-dev-plan/f3-gate-evidence.md |
| IS-4 | 双审（plan-consultant+plan-reviewer） | plan-reviewer 终审 approved 回执且 live plan SHA 一致 | .omo/drafts/mvp0-dev-plan.md review 台账 |
| IS-5 | 5,6,7 | provider 矩阵/ADR-8/S6 报告均含 fallback 分支；矩阵的 M0 内下游引用=presets.ts 互链（todo 5） | .omo/evidence/mvp0-dev-plan/task-{5,6,7}-mvp0-dev-plan.* |
