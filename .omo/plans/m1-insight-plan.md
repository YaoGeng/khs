# m1-insight-plan - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->

**Who this is for and what changes for them:** 开发执行者（工程师或 AI 执行代理）今天只有 05 基线里 M1 的八张一行式任务卡，交付后拿到的是零面试可开工的 M1 洞察（采集→清洗→报告闭环 + 适配层热更机制 v1）执行计划；用户在联调窗口提供真实登录态浏览器与 LLM Key，在 M1 门禁评审会直接对着证据包验收。

**What you'll get:** 小红书账号一键采集笔记（关键词/竞品账号/笔记链接三种输入，拟人节奏+日配额+验证码熔断保护）、一键生成八章需求洞察报告（真实 LLM、数据可去标识化、MD/PDF 导出）、选品关键词确认闸门、适配层热更包「签名→验签→自检→激活→回滚」全流程、遥测上报（熔断/自检告警/漏斗）、BYOK Key 界面与违禁词库首版。

**Why this approach:** 完全沿用 05 v1.1 基线的八卡结构，不另立基线；M0 已交付的机制面（任务运行器、遥测唯一出口、单写者 store、CDP 接管）全部按其预留的「M1 接线点」消费，不重建；用户已拍板真实 Key 与开发期真实联调，故探测矩阵升 [实测] 档、门禁演示用真实数据。

**What it will NOT do:** 不做 M2+ 任何功能（1688 适配/选品/发布/推广/支付/B 端）；基线文档只改 05:87 授权的 02 架构 v1.2 六处；不做热更的服务端下发模块（M1 用本地包路径）；不做 FR-10.3 留存清理管线（M5）。

**Effort:** XL
**Risk:** Medium-High——主要不确定点：真实采集受平台端波动（剔除口径已结构化+两轮增量证据先行）、OpenAI 直连不可达（矩阵按格落档不造数据）、并行合并序（store v3 提前+片段所有权纪律已内置）。
**Decisions to sanity-check:** 真实 LLM Key 由用户在 Wave 1 注入（已拍板）；开发期真实联调 10–20 条小批量+F 波 100 条（已拍板）；FR-2.4 预授权顺延 M2 前条款；嵌入缓存单表单 dim；热更 M1 本地下发。

Your next move: 双审中——plan-reviewer 终审通过后交付，由 /ulw-execute m1-insight-plan 启动执行。Full execution detail follows below.

---

> TL;DR (machine): XL / Medium-High / M1 洞察八卡（T-M1-01~08）+P1 追加卡（FR-2.4~2.6）+门禁证据包，5 波次 13 todo，双审后交付

## Scope
### Affected user and ideal state
**Affected user:** 开发执行者（客户端/服务端/Agent 工程师或 AI 执行代理，今天只有 05 的 M1 一行式任务卡，交付后零面试开工）；用户本人（提供真实 LLM Key 与真实登录态浏览器、主持 M1 门禁评审会）；03~09 评审链与 05 基线（计划只做执行细化并回指，不产生第二基线）

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | 执行者对 M1 全部八卡+2 张前置卡（探测复跑/sqlite-vec 复跑）+1 张 P1 追加卡获得零面试可执行计划行：精确文件/模块引用、agent 可执行验收标准、happy+failure QA 场景与证据路径、推荐执行路由 | 05:87-94 卡片仅一行内容+负责+产出+依赖，无验收与 QA |
| IS-2 | 计划与 05 v1.1（M1 节+§6 P1 插入行）零漂移；基线文档修改仅限 05:87 授权的 02 架构 v1.2 同步（§6.2/§7.5/§12.1/§13/§4.2/版本头六处），其余 01~09 禁改 | 05 §8：范围变更须三方会签；T-M1-01 的产出物本身就是 05 基线定义的架构 v1.2 |
| IS-3 | M1 退出门禁 5 项（05:100-104）逐项映射到计划内 QA 场景与证据路径 | 门禁表仅有证据类型，无逐项 QA 场景与命令 |
| IS-4 | 计划经 plan-reviewer 高精度终审通过并留回执 | 沿用 mvp0 双审惯例（D3） |
| IS-5 | 不利结论分支固化：探测不可达格落档、嵌入不可用降级统计聚类、真实联调风控升级条款、FR-2.4 预授权顺延、采集不达标不降门槛 | 05 §7 有风险文字但未固化为任务分支 |
| GAP-1 | 不存在 M1 执行级计划 | 本文件即产物 |
| GAP-2 | 05 八卡缺验收/QA/证据路径/路由 | 每个实现 todo 对应关闭 |

### Must have
- T-M1-01~08 全部八卡的执行级 todo（与基线 1:1 对账）+ FR-2.4/2.5/2.6 追加卡（05:253「M1（llm-gateway 成熟时）」）+ T-M1-01 前置的探测复跑与 sqlite-vec pnpm 复跑两张前置卡
- M1 门禁 5 项（05:100-104）→ findable evidence 逐项映射（todo 13 gate-evidence.md）
- M0 遗留接口按预留接线点消费：telemetry 装配注入（compliance-service.ts:123）、任务运行器 store Pick 面（runner.ts:15-33）、whenAutomationAllowed()（browser-service.ts:492）、迁移链 v3+（migrations.ts:140-144）、DSL zod 进 protocol、新包 eslint 禁运 group 登记
- 真实联调两窗口节奏：Wave 3 起小批量 10–20 条（熔断器/配额先就位）+ F 波 100 条门禁轮；调试期兜底走 fixture/mock CDP 与既有 kind=demo
- 新包登记 checklist（pnpm-workspace 收纳、tsconfig、eslint.boundaries.mjs 禁运 group、pnpm audit --prod=0、pnpm ci:all 全绿）
- 05:87 授权的架构 v1.2 文档同步 + 书面复审材料包（复审=人工白名单，agent 只产材料）

### Must NOT have (guardrails, anti-slop, scope boundaries)
- M2+ 任何功能（1688 适配层/选品 Agent/发布/推广/支付/B 端页面/新手引导）；报告⑦章关键词只产「确认闸门+selection 任务占位记录」，不执行选品
- 对 01~09 基线文档的修改，**除 02-系统架构设计.md 的六处授权区**（§6.2、§7.5、§12.1、§13、§4.2、版本头/变更记录）外——05:87 明文授权；其余私改一律视为护栏违规
- FR-10.3 笔记留存设置/清理管线（05:16 已定 M5，T-M5-08）
- 热更的服务端下发与配置模块（M1 用本地包路径+dev 签名 CLI；02:687 服务端端点属 M2+ 评估）；多 dim 分表矩阵（单表单 dim 已定）；遥测看板/灰度/邮件企微通道（T-M5-05）；durable outbox（M5 再议）
- PDF 第三方库（必须 webContents.printToPDF）；真 .xlsx（CSV UTF-8 BOM 即终）；echarts 全量或手写 D3（按需模块+wordcloud 插件）
- 适配层通用插件框架/JS 沙箱（DSL 纯数据 JSON 即安全边界）；Canvas/WebGL 深度伪装（02:339 底线）；rebrowser patches 全量
- AgentRuntime planner/reflect 工具环（M2 selection 需求）；workflow 通用引擎（循环/并行分支/优先级）
- 为凑探测 5/5 造数据；上传或入库任何真实 Key；OpenAI 不可达格伪装 [实测]
- 熔断 OPEN 态自动重试/自动切换代理（FR-9.5，M1 门禁抽查项）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
> 人工动作白名单（计划外的项目机制，非 QA）：①用户在 Wave 1 注入真实 LLM Key（env）；②用户在 Wave 3 / F 波联调窗口提供已登录小红书的本机 Chrome（M0 gate-2 同款环境）；③T-M1-02 dev 签名私钥的保管（仅本地 dev 用来，不入库）；④词库首版内容的人工复核勾选；⑤T-M1-01 架构 diff 的书面复审确认（04:118）；⑥M1 门禁评审会（agent 备齐材料包+录屏指引，05 §8）；⑦最终完成确认。
- Test decision: tests-after + agent-executed QA。单测 vitest、服务端 e2e supertest、C 端 e2e Playwright（真实链路）+ mock CDP fixture 页（调试期兜底）。真实 LLM/真实采集仅在指定 todo 的指定窗口使用。
- Evidence: .omo/evidence/m1-insight-plan/task-<N>-m1-insight-plan.<ext> + gate-evidence.md（todo 13 汇总）

## Execution strategy
### Parallel execution waves
> AI 执行按波次推进，卡间依赖不得越序，卡内串行；「人工动作白名单」条目阻塞对应 todo 时在台账显式记录等待。
- Wave 1（并行 2）：todo 1（真实 Key 探测复跑）∥ todo 2（sqlite-vec pnpm 复跑）
- Wave 1→2 串行：todo 3（T-M1-01 架构文档，blocked by 1）
- Wave 2（并行 3）：todo 4（T-M1-02 适配层框架，blocked by 3）∥ todo 5（T-M1-03 反爬中间件塔基，无依赖）∥ todo 6（store v3，blocked by 2）
- Wave 3（并行 4）：todo 7（T-M1-04 采集 DAG，blocked by 3/4/5/6）∥ todo 8（T-M1-05 报告 Agent，blocked by 1/3/6）∥ todo 9（T-M1-07 遥测，blocked by 6）∥ todo 10（T-M1-08 key-config+词库，blocked by 6）
- Wave 4（并行 2）：todo 11（T-M1-06 报告 UI，blocked by 7/8/10）∥ todo 12（FR-2.4~2.6，blocked by 8）
- 最终验证波：todo 13（真实联调收尾+门禁证据包，blocked by 4~12）+ 根闸门 lint/test/build/audit 全绿 → 用户确认完成

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | 无（用户注入 Key=人工白名单，todo 启动时在台账等待记录） | 3, 8, 10 | 2 |
| 2 | 无 | 6 | 1 |
| 3 | 1 | 4, 7, 8 | — |
| 4 | 3 | 7, 13 | 5, 6 |
| 5 | 无 | 7 | 4, 6 |
| 6 | 2 | 7, 8, 9, 10 | 4, 5 |
| 7 | 3, 4, 5, 6 | 11, 13 | 8, 9, 10 |
| 8 | 1, 3, 6 | 11, 12, 13 | 7, 9, 10 |
| 9 | 6 | 13 | 7, 8, 10 |
| 10 | 6 | 11, 13 | 7, 8, 9 |
| 11 | 7, 8, 10 | 13 | 12 |
| 12 | 8 | 13 | 11 |
| 13 | 4, 5, 6, 7, 8, 9, 10, 11, 12 | —（M1 完成） | — |

> 片段所有权纪律（合并序护栏）：仅 todo 6 可改 store protocol/migrations/worker/client；仅 todo 8 可改 llm-gateway 核心；仅 todo 9 可改 telemetry zod server 端；仅 todo 10 可改 keyConfig zod/IPC；仅 todo 3 可改 02 文档。每 todo 验收前置=本 todo 启动时 `pnpm -r lint && pnpm ci:all` 全绿。

## Todos
> Implementation + Test = ONE todo. Never separate.
- [x] 1. 真实 Key 探测复跑：能力矩阵升 [实测] 档（S4 关闭前置）
  What to do / Must NOT do: 用户提供真实 Key 后（env 契约 PROBE_DEEPSEEK_API_KEY / PROBE_TONGYI_API_KEY / PROBE_ZHIPU_API_KEY / PROBE_SILICONFLOW_API_KEY / PROBE_OPENAI_API_KEY(+可选 _BASE_URL/_MODEL/_EMBEDDING_MODEL)，packages/llm-gateway/scripts/probe-providers.mjs:8-32 已定义）复跑 `pnpm --filter @xinglian/llm-gateway probe`；逐格升级：可测格在 presets.ts:61-207 将 tierSource 'documented'→'probed' 并更新逐格 note 与 probe-report.json 引用；探测网络不可达格（provider-matrix.md 实测 openai 直连 UND_ERR_CONNECT_TIMEOUT）落 [network-unreachable] 档+脱敏存档，不得凑 5/5 造数据；docs/adr/provider-matrix.md 矩阵同步更新（§1/§4 结论句改写为实测口径）；R9「预设模板只承诺探测通过的能力档」解除条件记录：实测通过格的 UI 文案「文档源，待实测」角标可解除（解除动作在 todo 8/10 消费）。probe-report.json 存档 evidence。Must NOT do：不实现任何 LLM 调用链（todo 8）；不把 Key 写进任何入库文件/文档/日志（仅 env）；不改 presets 降级链常量语义。
  Closes: IS-5（探测不可达格分支）；S4 的「M1 报告 Agent 按探测结果路由」输入就绪（04:112）
  Parallelization: Wave 1 | Blocked by: 无（用户 Key=人工白名单） | Blocks: 3, 8, 10
  References (executor has NO interview context - be exhaustive): packages/llm-gateway/scripts/probe-providers.mjs:8-32（Key 契约）；packages/llm-gateway/src/presets.ts:19-31（档位定义）、:59-231（矩阵常量/降级链/互链）、:9-11（无 Key 注记）；docs/adr/provider-matrix.md:58（实测升级规则）、:64（文档源兜底现状）、:91-93（嵌入缓存注记）；04:63-64（S4 建议与 M1 路由）、04:103（R9）；05:272（R9 缓解行）
  Acceptance criteria (agent-executable): `pnpm --filter @xinglian/llm-gateway probe` 退出码 0；probe-report.json 至少 3 家含 [实测] 结果且 openai 格为 network-unreachable（有 UND_ERR 错误码存档）；`pnpm --filter @xinglian/llm-gateway test` 全绿（presets.test.ts 新增「probed 档 tierSource 与矩阵互链」断言）；provider-matrix.md 含实测格行且每行附 evidence json 相对路径
  QA scenarios (name the exact tool + invocation): happy=重跑 probe 两次 exit 0 且两次矩阵 diff 仅时间戳字段；failure=注入伪造 Key（PROBE_ZHIPU_API_KEY=bogus）→ probe 以退出码 1 结束且坏结论不入矩阵, Evidence .omo/evidence/m1-insight-plan/task-1-m1-insight-plan.log + probe-report.json
  Commit: Y | chore(llm-gateway): re-probe with real keys, promote matrix to probed tiers
  Recommended task executor category: quick（脚本复跑+常量更新）
- [x] 2. sqlite-vec 在 pnpm workspace 布局复跑打包验证（ADR 强制注记）
  What to do / Must NOT do: 复跑 docs/adr/sqlite-vec-packaging-validation.md §3-③ 强制项：在 workspace（pnpm）依赖树下重跑 asar 打包加载验证——apps/desktop/package.json 显式声明 sqlite-vec 依赖（现状 node_modules 有传递安装但未声明，M1 store 引用前置）；复用 bench/sqlite-vec-electron 验证模式：electron-builder 打包→app.asar 包内 loadExtension→vec0 KNN 实测 exit 0；重点验证 pnpm 符号链接布局下 `node_modules/sqlite-vec/node_modules/sqlite-vec-windows-x64` 路径假设与 asarUnpack 通配是否成立（ADR :78-80 风险注记原文）；产出 ADR 新附录节「pnpm 布局复验（M1）」：loadablePath 实测值、pack-result 摘要、若路径假设变化给出新 asPath 替换规则。Must NOT do：不改 migrations/worker/业务代码；Windows 必做，macOS 无环境则按 M0 口径记「有条件则补」。
  Closes: IS-5（pnpm 布局路径变化分支）；为 todo 6 的向量表接入解除打包风险
  Parallelization: Wave 1 | Blocked by: 无 | Blocks: 6
  References (executor has NO interview context - be exhaustive): docs/adr/sqlite-vec-packaging-validation.md:5（结论）、:54-60（§3-② dll 加载 asPath 替换参考实现）、:78-91（§3-③ pnpm 风险注记+rowid BigInt+ABI130）、:128（§6 复跑义务原文）；bench/sqlite-vec-electron/（M0 验证工程，main.js/pack-result.json）；apps/desktop/package.json、apps/desktop/electron-builder.yml（asarUnpack）；pnpm-workspace.yaml:1-4
  Acceptance criteria (agent-executable): workspace 内验证脚本 exit 0 且产物 pack-result.json 含 loadablePathInsideUnpacked=true；docs/adr/sqlite-vec-packaging-validation.md 新增「§7 pnpm 布局复验（M1）」含退出码与实测 loadablePath；apps/desktop/package.json 声明 sqlite-vec 且 `pnpm --filter desktop lint/test` 不回退
  QA scenarios (name the exact tool + invocation): happy=验证脚本 exit 0 + ADR 附录含实测路径；failure=临时移除 asPath 替换逻辑复跑同一脚本→断言报 SqliteError「找不到指定的模块」且退出码非 0（证明验证有效性），随后恢复逻辑复跑 exit 0, Evidence .omo/evidence/m1-insight-plan/task-2-m1-insight-plan.log
  Commit: Y | chore(desktop): revalidate sqlite-vec under pnpm layout, declare dep
  Recommended task executor category: quick（验证复跑+依赖声明）
- [x] 3. T-M1-01 架构文档：ADR-7 + DSL v1.1 + 架构 v1.2 合规同步（映射 T-M1-01，S2/S5/S10）
  What to do / Must NOT do: 三件产出+一份复审材料：①docs/adr/ADR-7-embedding-source.md：定论按 03:219/04:66-70——V1 默认用户 LLM 嵌入接口（运行态一次性探针：首次调 provider /embeddings 成功→kv_config 记 {provider,dim,probed_at}；失败→降级统计聚类且 24h 内不重试同一 provider）；降级统计聚类=char-3gram TF-IDF + KMeans，K=clamp(round(sqrt(N)),3,8)；本地模型（BGE 等）列二期；向量表单表单 dim（dim 按实测默认档锁定，变更=缓存重建）；rowid BigInt 陷阱与 asPath 加载引用 ADR 注记。②02-系统架构设计.md §7.5 升 DSL v1.1：schema 字段补 version(semver)/minEngineVersion/verify 声明（与 flows 同级同签名热更）/nonReentrant（引擎强制 verify 存在）/blockedFeatures（验证码特征选择器列表）/terms 组合建模（terms[]≤5 + operator:and|or；OR=分次查询并集按 note_id 去重，AND=单查询+标题正文必须全词出现——B-4 语义写死）；新增一节「DSL v1.1 规范参数表」（节奏/Humanizer/熔断/配额参数引用值表，02:327-332/336-339/344-354 数值入表，供 todo 4/5 直接抄）；③02 → v1.2 同步：§6.2 发布 DAG 补三道闸节点（生成后拦截/待审标红/执行前终检，标注归 M3 实现）、§12.1 遥测服务与 §13 协议补事件字段（consent 标志、event 枚举：circuit_open/circuit_half_open/circuit_closed/selfcheck_fail/first_collection_completed/first_report_generated/key_failover、匿名 user 口径 anon_user_hash）、§4.2 llm-gateway 补「调用前预处理去标识化（默认开启，PC-03）」行；文档版本头 v1.1→v1.2+变更记录段。④复审材料包 .omo/evidence/m1-insight-plan/tm101-review-pack.md：S2/S5/S10 逐条对照 04:110-113 放行条件+diff 摘要+自检清单（书面复审=人工白名单 04:118，agent 只产材料不代签）。同时产出 scripts/tm101-diff-check.mjs：校验 02 文档 diff 仅触六授权区（§6.2/§7.5/§12.1/§13/§4.2/版本头），越区即退出码 1。Must NOT do：不改 02 之外任何基线文档；不在文档写入基线外的新承诺（如新门禁、新里程碑）；不动任何代码。
  Closes: S2/S5/S10 计划内产出（04:110-113）；B-4/B-5 的「M1 前」缺口（03:269）
  Parallelization: Wave 1→2 | Blocked by: 1（ADR-7 须引用实测矩阵与选定默认嵌入档） | Blocks: 4, 7, 8
  References (executor has NO interview context - be exhaustive): 05:87（卡定义=授权依据）；04:43-48（S2 verify+nonReentrant+M2 前时限）、04:66-71（S5 ADR-7 定论与时限）、04:93（S10 semver/minEngineVersion）、04:110-113（放行条件汇总）、04:118（书面复审）；03:218-219（B-4/B-5 原定论）、03:257/269（时限强制力）；06:177-180（§3.2 架构侧四项落点）；02:369-371（现行 DSL/热更/特征校验）、02:616（Ed25519 热更）、02:762-765（生效与失败行为）、02:327-354（参数表数据源）、02:285-293（§6.2 发布 DAG 现状，修订对象）；docs/adr/provider-matrix.md:68-93（embeddings 设计注记→ADR-7 引用）
  Acceptance criteria (agent-executable): `node scripts/tm101-diff-check.mjs` exit 0（diff 仅授权区）；对 02 文档 grep 断言逐条命中：`minEngineVersion`、`nonReentrant`、`terms`、`blockedFeatures`、`三道闸`、`consent`（§12.1）、`去标识化`（§4.2）；docs/adr/ADR-7-embedding-source.md 存在且含降级链三段（嵌入接口探针/统计聚类 K 公式/缓存重建策略）与实测矩阵引用；tm101-review-pack.md 含 S2/S5/S10 三对照表
  QA scenarios (name the exact tool + invocation): happy=diff-check exit 0 + grep 断言全命中；failure=临时在 02 §14.1 加一行→diff-check 退出码 1 且报越区行号（探针即删，复跑 exit 0）, Evidence .omo/evidence/m1-insight-plan/tm101-review-pack.md + task-3-m1-insight-plan.log
  Commit: Y | docs(arch): ADR-7 + DSL v1.1 + arch v1.2 compliance sync (T-M1-01)
  Recommended task executor category: writing（纯架构文档+校验脚本）
- [x] 4. T-M1-02 适配层框架：adapter-loader + adapters-xhs v1（映射 T-M1-02，门禁④载体）
  What to do / Must NOT do: 三包一链：①packages/protocol 增 DSL zod schema 与包验封 schema（按 todo 3 的 DSL v1.1：platform/version(semver)/minEngineVersion/selectors/flows{search,detail}/selfcheck[]/verify/nonReentrant/blockedFeatures/terms 组合；manifest{version,minEngineVersion,platform,sha256,sig}）——protocol 是 app 与包共同依赖的唯一跨层通道（eslint.boundaries.mjs:25-49 先例）。②新包 packages/adapter-loader：加载顺序=读 `<userData>/adapters/<platform>/<semver>/` 包目录→Ed25519 验签（公钥随引擎分发常量，02:616；dev 签名 CLI scripts/adapter-sign.mjs 用本地 dev key，仅 dev 用，私钥不入库不入 git——人工白名单③）→ semver/minEngineVersion 兼容检查（不兼容拒激活，02:765）→ 激活前自检（selfcheck 选择器在 fixture 无害页回放，全部命中才激活）→ 任一失败自动回滚 last-good（`<userData>/adapters/<platform>/active.json` 持久化当前激活版本）→ 事件上报 sendTelemetry('selfcheck_fail', …)（经 guard 三态，M0 形态=本地留存；真实通道 todo 9 接）。③packages/adapters-xhs v1（替换 1 行 stub）：xhs-search flow（关键词搜索/竞品账号→用户笔记列表/笔记链接→笔记页三种输入的导航 DSL 序列；terms 组合语义按 DSL v1.1）+ xhs-detail flow（标题/正文/互动数/标签/作者字段位点 DSL）+ selfcheck 用例（搜索框特征+用户入口特征，同时充当「登录态探测特征」供 todo 7 preflight 复用）+ blockedFeatures（验证码容器特征选择器）。热更 M1 下发=本地包目录（CLI 打包落盘→loader 热加载），服务端端点不做。登记 checklist：eslint.boundaries.mjs:33-42 禁运 group 增 '@xinglian/adapter-loader'、'@xinglian/adapters-xhs'（此前直 import 即 lint 红线）；`pnpm audit --prod` 保持 0。Must NOT do：DSL 不含可执行 JS（纯数据 JSON）；不做通用多平台插件框架/JS 沙箱；不做服务端下发端点；不做 1688 flow（M2）与发布/评论 flow（M3/M4）；自检不在真实线上页面跑（fixture 页）。
  Closes: T-M1-02 主体（门禁④脚本载体在 todo 13 收口）
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 7, 13
  References (executor has NO interview context - be exhaustive): 05:88（卡定义）；02:369-371（DSL 结构/热更链路/预期页面特征）、02:210（adapter-loader 模块落点）、02:616（Ed25519+私钥离线）、02:762-765（激活链与失败行为）、02:177（adapters-xhs 包源）、02:312（故障→自检复验→热更）；04:47-48/93；02-系统架构设计.md §7.5 v1.1（todo 3 产出）；eslint.boundaries.mjs:25-49；packages/protocol/src/index.ts（stub 现状）；apps/desktop/src/compliance/telemetry-guard.ts:71-115（sendTelemetry 消费面）
  Acceptance criteria (agent-executable): `pnpm --filter @xinglian/adapter-loader test` 全绿且必含四组用例：合法包激活成功/篡改 payload 验签拒绝且 active 保持上一版/不兼容 minEngineVersion 拒绝/selfcheck 失败自动回滚 last-good；`pnpm --filter @xinglian/adapters-xhs test` 全绿（search/detail/selfcheck/terms 组合 schema 校验）；`pnpm -r lint` 全绿（新包已登记禁运 group）；复核 `pnpm audit --prod` 仍为 0
  QA scenarios (name the exact tool + invocation): happy=构造合法 v1 包→`pnpm adapter:sign`→loader load 断言 activeVersion=v1 且 manifest 验签通过；failure=v1→v2 篡改一字节后 load→退出码非 0 且 active.json 仍 v1, Evidence .omo/evidence/m1-insight-plan/task-4-m1-insight-plan.log + activation-transcript.json
  Commit: Y | feat(adapters): adapter-loader (Ed25519+semver+selfcheck+rollback) + adapters-xhs v1
  Recommended task executor category: unspecified-high（标准多文件新包特性）
- [x] 5. T-M1-03 反爬中间件 v1 塔基：humanize + stealth-middleware（fakes 单测墙，映射 T-M1-03）
  What to do / Must NOT do: 两包一机制：①packages/humanize（替换 stub）：节奏引擎纯函数（页面间停留截断正态 N(5s,2s)∈[3,8]、详情阅读 N(8s,3s)∈[4,15]、滚动 300–700px/次、02:00–07:00 禁跑判定、单条预算≤8s 校验钩子——02:327-332/01:262）、Humanizer 纯函数（贝塞尔鼠标轨迹点序列、逐字符 60–180ms 键入计划、元素 bbox 内高斯偏移、「禁 JS 直取 DOM 写入」的 API 约束导出——CDP 注入由调用方执行，本包不依赖 electron/cdp）。②新包 packages/stealth-middleware：日配额记账（采集 300 条硬上限，UI/sources 只能下调，kv_config 持久化+本地日历日 00:00 重置——02:331）、熔断状态机（CLOSED→OPEN：验证码特征命中 / 5min 滚窗 429|401≥3 / 任务失败率>20%/10min；OPEN→HALF_OPEN：冷却 30min（构造可注入 clock 覆盖）+人工确认信号；HALF_OPEN→OPEN：试探失败冷却×2；HALF_OPEN→CLOSED：试探成功——02:344-350）、窗口计数 hook 协议（network 429/401 计数、adapter blockedFeatures 匹配——协议本卡定义，信号源 todo 4/7 接线）、熔断事件 emit（走 sendTelemetry 唯一出口：circuit_open/half_open/closed，事件不含任何笔记内容字段——02:354）、OPEN 态任务挂起回调接口（供 todo 7 注册）、FR-9.5 固化：OPEN 态重试策略导出 abort-no-retry（非 retry≤3）+代理配置零改动承诺（不自动切换代理）。③stealth 保守三项（02:339 底线内）：navigator.webdriver 去标志注入脚本、自动化提示条抑制的 launch 参数形态、UA/视口与真实浏览器一致（不伪造）。④让位机制落地：CDP `Page.addScriptToEvaluateOnNewDocument` 注入 passive 输入监听（keydown/pointerdown，1s 节流写 window.__khs_yield__）；宿主侧 automation-window（每个 CDP 动作 start/end 时间戳）窗口内输入丢弃防自触发回环；静默恢复阈值默认 3s；红线解释写入 docs/adr/notes-browser-m0.md 新节（passive 监听=「驱动用户自有浏览器」的既定形态，非 01:386 功能/外挂注入）。登记 checklist：eslint.boundaries.mjs 禁运 group 增 '@xinglian/stealth-middleware'。Must NOT do：不把任何动作接到真实采集流程（接线归 todo 7）；不实现代理轮换/代理池（FR-9.5 禁+决策 PC-11）；不做 Canvas/WebGL 深度伪装（02:339 禁）；不写采集 flow（todo 4）；熔断状态机不落 XState（S9 边界：任务生命周期才进 XState）。
  Closes: T-M1-03 基础件全量（真实联调验证在 todo 7/13；FR-9.5 抽查在 todo 13）
  Parallelization: Wave 2 | Blocked by: 无 | Blocks: 7
  References (executor has NO interview context - be exhaustive): 05:89（卡定义）；02:321（定位红线）、02:327-332（§7.1 参数硬数值）、02:336-339（§7.2 Humanizer+底线）、02:344-354（§7.3 状态机+遥测）、02:208-209（模块落点）、02:89（装配顺序）、02:313（挂起语义）；01:151（FR-4.3）、01:208-209（FR-9.5 语义）、01:304/308-312（§5.3 五层）、01:262（≤8s）、01:366-367（熔断/登录态验收）；07:46（FR-9.5 挂卡注记）；cdp.ts:144-171（send/onEvent）、session.ts:85-124（YieldFlag 现机制）、browser-service.ts:478-495（让位入口/动作队列）、docs/adr/notes-browser-m0.md（红线注记落点）；mvp0 计划:172（「真实输入信号接线归 M1」注记）
  Acceptance criteria (agent-executable): `pnpm --filter @xinglian/humanize test` 全绿：节奏抽样 1000 次全落截断区间、禁跑窗口边界、滚动范围、键入间隔范围；`pnpm --filter @xinglian/stealth-middleware test` 全绿（≥30 用例）：状态机全迁移表（含试探失败冷却×2）、3 次/5min 窗口计数边界、配额重置/触顶/只可下调、abort-no-retry 策略、让位分类器（合成事件流+automation-window 抑制+3s 恢复）；`pnpm -r lint` 全绿（新包已登记）
  QA scenarios (name the exact tool + invocation): happy=fake clock 全链 CLOSED→OPEN→30min→HALF_OPEN→试探成功→CLOSED，断言事件序列与冷却×2 未触发；failure=OPEN 态调用重试策略断言返回 abort-no-retry 且代理配置对象深比较不变（FR-9.5）, Evidence .omo/evidence/m1-insight-plan/task-5-m1-insight-plan.log
  Commit: Y | feat(humanize/stealth): pacing, humanizer, circuit breaker, quota, yield base
  Recommended task executor category: unspecified-high（双新包+纯函数测试墙）
- [x] 6. store v3 迁移 + sqlite-vec 集成（M1 业务表地基，blocked by todo 2）
  What to do / Must NOT do: migrations.ts 追加 v3 步（up/down 成对，禁回改 v1/v2）：notes（id,note_id 唯一,title,content,author_json[本地最小化保留原文],likes,collects,comments,tags_json,cover_url,image_urls_json,published_at,collected_at）、topic_notes（topic_id,note_id,seen_at,UNIQUE）、note_snapshots（note_id,likes,collects,comments,captured_at——FR-4.4）、reports（id,topic,report_json,content_md,model,token_cost,gate_state,created_at）、llm_calls（trace_id,provider,model,tokens_in,tokens_out,cost,latency_ms,at——02:714）、circuit_events（kind,at,meta_json——熔断/配额触顶/自检失败本地账本，门禁①剔除口径与 FR-9.5 抽查证据源）、keyword_hits（wordlist_version,term,category,topic_id,at——FR-9.6 命中留痕）、kv_config（key 唯一,value_blob,updated_at——safeStorage 加密 Key、嵌入探针缓存、配额与词库 active 指针）、collect_run_stats（run_id,completed_unique,duplicate,no_result,rate_limited,captcha_consumed——门禁①分母公式数据源）、embeddings_cache（provider,model,input_sha256,dim,created_at,last_used_at,UNIQUE(provider,model,input_sha256)）+embeddings_vec USING vec0(embedding float[N])（N=todo 1 实测默认档 dim；单表单 dim；dim 变更=缓存重建+vec 表 DROP 重建，策略写迁移注释）、加载路径按 ADR §3-② asPath 替换封装、rowid 全 BigInt（:82-87）。五面同步：protocol.ts StoreRequest 扩变体→worker.ts switch case→client.ts 方法→schema.ts drizzle 投影→migrations.ts DDL 真源；批量≤100 行（worker.ts:15 MAX_BATCH_ROWS 沿用）；safeStorage 不可用环境显式降级（明文前告警+审计条目，不静默）。Must NOT do：不动 v1/v2 已发布迁移内容；不建词库内容表（词库走配置包 JSON+active 指针，02:763）；不建服务端 PG 表（todo 9）；不做多 dim 分表矩阵；不写业务读写调用方（todos 7-10 消费）。
  Closes: M1 store 地基→五卡公共前置
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 7, 8, 9, 10
  References (executor has NO interview context - be exhaustive): 02:703-710（notes/note_snapshots/reports/tasks 表设计）、02:714-715（llm_calls/logs）、02:143（sqlite-vec 选型行）；docs/adr/provider-matrix.md:72-93（embeddings_cache DDL 注记+rowid 陈规+保留策略 N 由 M1 定→本卡定 N=180，对齐 FR-10.3 默认口径并在 ADR 注释引用）；docs/adr/sqlite-vec-packaging-validation.md:60-91；client.ts:60-82/263-274（背压与崩溃恢复）、worker.ts:15/66-286/350-399、protocol.ts:140-207、migrations.ts:11-16/141-144/187-281、schema.ts:1-107、db.ts:10-14/54-65、main/store-service.ts:44-87（retention 调度沿用）
  Acceptance criteria (agent-executable): `pnpm --filter desktop test` 全绿且新增：v3 升级/回滚成对用例（v2 库→up→v3→down→v2 数据完好）、五面同步 e2e（client 新方法→worker case 全走通：notes insert/upsert 快照/reports/llm_calls/circuit_events/keyword_hits/kv/collect_run_stats/embeddings upsert+KNN top3）、BigInt rowid 断言；现有 299+26 用例零回退
  QA scenarios (name the exact tool + invocation): happy=vec 插入 5 行 KNN 查询 top3 id 序断言+fallback asPath 路径解析单测；failure=构造 v3 up 中途抛错（迁移用例注入）→断言版本留 v2 且 runMigrations 记账回滚、库可复开, Evidence .omo/evidence/m1-insight-plan/task-6-m1-insight-plan.log
  Commit: Y | feat(store): v3 schema (notes/reports/llm_calls/circuit/hits/kv/vec) + five-face sync
  Recommended task executor category: HEAVY（迁移链+原生扩展+五面同步）
- [x] 7. T-M1-04 采集工作流 DAG：扩态+让位接线+真实联调小批量（映射 T-M1-04）
  What to do / Must NOT do: 一执行器一管道一接线：①packages/workflow（替换 stub）：串行 DAG 执行器（节点拓扑+检查点落 task_steps+指数退避重试≤3——熔断 OPEN 态切换为 todo 5 的 abort-no-retry 策略+取消/挂起安全点+yield 钩子；不建循环/并行分支/优先级）。②tasks 五面同步扩态：TaskStatus 增 queued/awaiting_user/yielded/paused（machine.ts:8「M1+ 按需扩充」注记启用点）——machine.ts 枚举与 resolveTransition 迁移表、runner.ts recoverOnBoot 谓词（boot 恢复：yielded/paused→suspended，awaiting_user 原样保留幂等重提示）、protocol.ts task_events 值域校验、client.ts/worker.ts 枚举镜像、runner.ts applyLifecycle 落值——各面均带镜像断言测试（五面任一漏改即测试红）。③kind='collect' 管道：preflight（selfcheck 登录态特征探测失败→任务 suspended+桌面通知引导重登——01:367）→输入路由（关键词/竞品账号链接/笔记链接三种，FR-4.1）→search（B-4 组合：OR=N 次查询并集按 note_id 去重、AND=单查询+全词过滤；超平台能力的组合分次检索本地合并，DSL v1.1 语义）→detail 批读（节奏+Humanizer+配额+熔断全经 stealth-middleware，量额语义 02:281：主题总量 200 默认可配 50–1000 与日配额 300 硬上限双轨，超出跨日续采）→清洗去重（note_id 全局去重；重复仅更新互动数据+追加 note_snapshots 快照——FR-4.4）→落 collect_run_stats 计数器。④控制语义：暂停/继续/终止（FR-4.5）；跨日续采=配额触顶→任务 paused 落 remainder（input_json 记剩余目标）→应用启动扫描昨日未完 remainder+UI「继续采集」；本地日历日 00:00 重置换日即采。⑤让位接线（FR-4.5 真实信号）：todo 5 的 passive 监听+automation-window 接入 main 进程真实源（M0 debug 钩子保留为 env 测试后门）；CDP 动作全部经 whenAutomationAllowed()（browser-service.ts:492 唯一入口）。⑥熔断联动：OPEN→全部 running 任务挂起+Notification 通知+设置页人工确认恢复（冷却后）。⑦遥测：first_collection_completed 事件（首次成功 run 落库后 emit 一次，kv_config 幂等位防重）。⑧真实联调小批量（用户已拍板；人工白名单②）：真实登录态 Chrome 一轮 10–20 条；保底条款=联调窗口必须在熔断器/配额联动账本就位后开跑、先 fixture/mock CDP 调试、配额用保守低配值（≤50/日），风控异常（触熔断）立即停窗并记录升级（不做任何绕过尝试，02:321 红线）。Must NOT do：不实现报告生成（todo 8）/选品（M2）/发布评论 flow（M3/M4）；不自动重试熔断 OPEN 态、不自动切代理（FR-9.5）；不下载图片素材（只存 URL，M3 挑图才下）；不做多账号多 Profile（P2）；awaiting_user 语义不进 XState 步骤级（S9）。
  Closes: T-M1-04 全量（门禁①载体在 todo 13 收口；todo 5 的 OPEN 挂起回调契约）
  Parallelization: Wave 3 | Blocked by: 3, 4, 5, 6 | Blocks: 11, 13
  References (executor has NO interview context - be exhaustive): 05:90（卡定义）；01:149-154（FR-4.1~4.5 全条目）、01:362（采集验收行）、01:264（NFR-3 断点续跑 100%）、01:367（登录态）；03:68/218（B-4 定论）、03:206-265（D-03 量额语义）；02:271-274（selection DAG 前半）、02:281（量额语义）、02:240（让位机制）、02:703-704/708-710（表）、02:315（启动恢复口径）；runner.ts:15-33/78-142/167-182（Pick 面与恢复）、machine.ts:8-23/30-98、index.ts:5-8（导出面）、docs/dev/工程规范.md:5-9（S9 边界）；mvp0 计划:181（M1 DAG 解禁注记）；02-系统架构设计.md §7.5 DSL v1.1（todo 3）
  Acceptance criteria (agent-executable): ①`pnpm --filter desktop test` 新增全绿：XState 五面镜像断言、B-4 组合语义（OR 并集去重计数/AND 全词过滤）、去重快照行为（重复采集 notes 行数不增+snapshots 追加）、跨日续采（fake clock 换日→remainder 恢复任务不重建）、collect_run_stats 落库断言；②Playwright e2e（mock CDP+fixture 页 20 条）：运行 collect 任务→notes=20 行且二次运行快照更新；③让位 e2e：注入输入事件序列→任务转 yielded→静默 3s 后恢复→检查点续跑断言（steps 未重跑）；④真实联调一轮 10–20 条：产出 collect-run-stats.json（计数器四细分全零异常）+platform 响应截图证据+一轮 circuit_events 无 OPEN 记录
  QA scenarios (name the exact tool + invocation): happy=上述②③；failure=fixture 页注入验证码特征→熔断 OPEN→断言 running 任务全部挂起、重试策略 abort-no-retry、代理配置不变、circuit_open 事件入账本（FR-9.5+门禁⑤预演）, Evidence .omo/evidence/m1-insight-plan/task-7-m1-insight-plan.log + collect-run-stats.json
  Commit: Y | feat(workflow/tasks): collection DAG, state extensions, yield wiring, real-env pilot (T-M1-04)
  Recommended task executor category: HEAVY（执行器+五面扩态+e2e 双层）
- [x] 8. T-M1-05 报告 Agent + llm-gateway 调用链（映射 T-M1-05，PC-03）
  What to do / Must NOT do: 一网关一管道：①packages/llm-gateway 从 stub 变实（presets 常量保留互链）：openai 兼容 chat 调用（自定义 base_url、重试/退避≤3、token 计量落 llm_calls、响应双档：chat+结构化；不做流式/多模态）、JSON Schema 三段降级链按 schemaInjectionForTier 实测档驱动（native-json_schema→prompt-embedded-schema→regex-extraction-fallback，presets.ts:213-231 既有常量；实测不过的档直接跳）、embeddings 接口（ADR-7 运行态探针+embeddings_cache 命中/写缓存+sqlite-vec 索引）、去标识化前置层（06:179 默认开启，设在 gateway 调用前统一入口，M3 文案链免费复用）：author_json 的昵称/ID→稳定假名「author_」+本地盐 hash 前 8 hex（本地可重放、构建不可逆、不上传映射表）、粉丝数→量级分桶（<100/100–1k/1k–1w/1w+）；仅对发往 LLM 的 payload 清洗，本地 notes 原文不动。②packages/agents/report-agent（替换 stub）：确定性流水线（02:394，无 planner/reflect 工具环——M2 selection 才需要）：输入 topic+清洗后笔记集→去标识化→聚类（嵌入探针可用=向量嵌入+KMeans；不可用=统计聚类 char-3gram TF-IDF+KMeans，K=clamp(round(sqrt(N)),3,8)——ADR-7 降级链）→分章 LLM 分析（八章独立 prompt+章节 JSON）→合并八章节报告 JSON（⑧章数据来源与方法说明必含：各章样本量/数据窗口/清洗规则/置信度四字段——01:161、03:192）→zod schema 校验失败纠偏重试≤2（02:394）→reports 落库+first_report_generated 遥测（幂等位防重）。Agent 产出永不直接执行（仅落 reports，02:394）。③真实 LLM 验证轮（人工白名单①Key）：注入 Key 后端到端生成一份真实样例报告→evidence/report-sample.md（真实输出；质量不做量化阈值，门禁②只查八章节结构齐全+可导出）。Must NOT do：不做 AgentRuntime planner/reflect/多 Agent（M2）；不做文案生成（M3）；不做成本优化调度；UI 能力承诺文案只对实测通过档解除「文档源，待实测」角标（R9）；不把去标识化做成可关闭的默认开关（默认开启，仅设置页可显式确认后关闭并留痕——06:54②「默认开启」语义）。
  Closes: T-M1-05 全量（门禁②载体在 todo 13 收口）
  Parallelization: Wave 3 | Blocked by: 1（实测档路由）, 3（ADR-7/K 公式/去标识化 v1.2 定义）, 6（reports/llm_calls/embeddings 表） | Blocks: 11, 12, 13
  References (executor has NO interview context - be exhaustive): 05:91（卡定义）；01:160-161（FR-5.1/5.2 八章枚举）、01:362（验收）、01:250（Note 去标识化口径）；06:49-55（PC-03 ①②③）、06:161、06:179（§4.2 落点）；04:63-64（S4 按探测路由）、04:70-71（S5 降级链）、04:103 R9；05:272（R9 行）；02:400-402（§8.2 输入/工具/产出）、02:143/391（sqlite-vec）、02:394（结构化+纠偏+永不直接执行）、02:144（openai SDK 选型）；03:79/219（B-5）；packages/llm-gateway/src/presets.ts:61-231；docs/adr/ADR-7（todo 3）；provider-matrix.md:68-93（缓存表注记）
  Acceptance criteria (agent-executable): ①`pnpm --filter @xinglian/llm-gateway test` 全绿：降级链三档切换（mock tier 注入）、去标识化 golden fixtures（昵称→假名 8hex、粉丝→分桶、原文不动）、重试退避计数、llm_calls 写入断言；②`pnpm --filter @xinglian/agents test` 全绿：20 条 fixture 笔记+mock JSON 端点→八章节 JSON 全章非空+⑧章四字段齐+zod 校验通过+纠偏重试≤2 后终判（mock 恒返回坏 JSON→failed 断言）；③真实 Key 端到端一轮产出 report-sample.md（含八章节+token 消耗行）
  QA scenarios (name the exact tool + invocation): happy=上述②全绿 e2e；failure=mock provider 恒返 schema 违例 JSON→重试 2 次断言后任务 failed 且 llm_calls 有 3 次 400-level 记录, Evidence .omo/evidence/m1-insight-plan/task-8-m1-insight-plan.log + report-sample.md
  Commit: Y | feat(llm-gateway/agents): call chain, de-id pipeline, report agent v1 (T-M1-05)
  Recommended task executor category: HEAVY（网关+Agent+真实端到端）
- [x] 9. T-M1-07 遥测 v1：服务端 ingest + 桌面上报器装配（映射 T-M1-07，R1 告警）
  What to do / Must NOT do: 服务端一模块一告警一装配：①apps/server telemetry 模块（app.module.ts:12-15「M1+ 不预建」注记解禁）：POST /api/v1/telemetry/events（02:689 批量+采样，固定采样率常量默认 1.0）；事件 zod schema（06:178 同意标志+匿名化字段）：{consent:boolean, event:enum[circuit_open,circuit_half_open,circuit_closed,selfcheck_fail,first_collection_completed,first_report_generated,key_failover], anon_user_hash(64hex 匿名用户 id), payload(事件白名单字段), at}；未同意或 consent!=true→422 拒收（schema 层强制）；PG 表 telemetry_events（02:731：id,user_id 匿名,kind,payload_json,at）；重试=客户端侧 ≤1 次静默。②R1 告警（04:99 硬规格「24h 从自检失败率告警触发起算」）：服务端滚动 24h 窗口统计 selfcheck_fail（telemetry_events kind 聚合）；阈值默认 ≥5 次/24h 或 24h 失败率>20%→写 alerts 记录行+服务端日志；不接邮件/企微/蜂群通知通道（M5）；告警记录含 triggered_at 字段（24h SLA 起算锚点）；dev/测试注入 fake timer 覆盖窗口边界。③desktop 上报器装配：compliance-service.ts:123 创建 TelemetryGuard 处注入 endpoint+fetchFn（env：XINGLIAN_TELEMETRY_ENDPOINT，缺省不注入=路径行为与 T-M0-11 时的唯一出口守卫完全一致——本地留存而非报错）；per-event 经唯一出口发送；接既有事件源：circuit_*（todo 5 emit）、selfcheck_fail（todo 4 loader 失败）、first_collection_completed（todo 7）、first_report_generated（todo 8）、key_failover（todo 12）；同意 gate 继承 guard 语义（未同意：不给端点发也不留半条）。Must NOT do：不做看板/灰度/分簇 AI 聚类（T-M5-05）；不做 durable outbox/断网重放队列（M5 再议）；不做 B 端配置模块；不把任何笔记内容字段添进遥测 payload（02:354）；不改 telemetry-guard 既有三态语义（只动装配注入）。
  Closes: T-M1-07 全量（R1 告警口径可验收；同意闭环复用 M0 consent 基础 05:93 依赖行）
  Parallelization: Wave 3 | Blocked by: 6（kv_config 审计与上报事件本地留存路径依赖，防波次脱序） | Blocks: 13
  References (executor has NO interview context - be exhaustive): 05:93（卡定义）；04:99（R1 监控口径原文）；01:244（FR-12.6）、01:369（遥测验收）、01:374（漏斗点必含首次采集/首份报告）；06:39-45（PC-02）、06:178（§12.1/§13 同意+匿名化）；02:643/689（服务端落点）、02:731（telemetry_events 设计）、02:354（不含内容）；apps/desktop/src/compliance/telemetry-guard.ts:44-66/71-115（注入面）、compliance-service.ts:35-38/123-127/152（装配点注释原文「M1 T-M1-07 接入时在装配处注入」）、apps/server/src/app.module.ts:12-15（解禁注记）、apps/server/src/infrastructure/*（PG/Redis 模式）
  Acceptance criteria (agent-executable): `pnpm --filter server test` 全绿且新增：同意事件批次 202 入库+行数断言、consent!=true 422、anon_user_hash 64hex 断言、R1 fake-timer 注入 6 事件 24h 窗触发 alerts 行+滑动窗口恰 24h 边界断言（旧事件滑出窗口后不再计入）；desktop `pnpm --filter desktop test` 新增：mock 本地 http 端点注入后 consent=true 收到≥4 类事件、consent=false 计数=0（零网络断言沿用 M0 模式）
  QA scenarios (name the exact tool + invocation): happy=supertest 批量入库+R1 告警行断言；failure=关闭同意→mock fetch 计数=0 且 guard 走本地留存分支（沿用 task-9/M0 零网络断言模式）, Evidence .omo/evidence/m1-insight-plan/task-9-m1-insight-plan.log
  Commit: Y | feat(server/desktop): telemetry v1 ingest + R1 selfcheck alert (T-M1-07)
  Recommended task executor category: HEAVY（服务端模块+双端 e2e）
- [x] 10. T-M1-08 key-config + 词库 v1（映射 T-M1-08，PC-03 ①/PC-05）
  What to do / Must NOT do: 一界面一词库一扫描器：①key-config IPC+UI：IPC_CHANNELS 增 keys:*（key:set/key:get-masked/key:test+调用前再提示确认通道）、channelParamsSchemas+ipc-core 注册表三处同步（shared/channels.ts:15-33+shared/schemas.ts:235-253+main/ipc-core.ts:112-376 现有模式照抄）+主进程 key-service（electron-free 服务，经 safeStorage 加密落库）：kv_config 加密落 key（可用性探测失败→显式降级：明文前告警+审计条目，不静默）；masked 读回仅 sk-****+后 4 位（全值永不 IPC 回渲染）；settings/key-config 视图渲染（原型 c端原型.html 只读参照）：FR-2.7 固定展示「调用内容发送范围说明」+服务商境内外标注（数据源=provider-matrix 风险列：deepseek/tongyi/zhipu/siliconflow=境内、openai=境外+可达性注记）+每次 LLM 首次调用前 modal「内容将发送至你所配置的 LLM 服务商」（会话内每 provider 一次；设置页可重置提示状态）。注意 UI 预设模板能力承诺文案：仅实测通过段解除「文档源，待实测」角标（R9）。②词库 v1（配置包路径，02:763）：`<userData>/config/wordlist/<semver>/wordlist.json` + manifest{version,sha256,effective_at}；三件套（01:331-333+08 条款行号引用）：广告法极限词首版（约 60 条）、导流变体正则集（谐音/符号穿插/emoji 替换；适用范围=文案与评论（09:55-59 XHS-03 修订口径），M1 阶段实接消费口=报告⑦章关键词）、类目黑名单（涉政时事/医疗含医美整形与器械 3.1.3[08:132]/金融投资与违禁物品 2.3.1[08:88]）；版本化+reloadConfig()「bump 版本→不重启进程即时生效」+keyword_hits 命中留痕落库（FR-9.6 修订[01:210/06:74-75]）；packages/protocol 附 wordlist zod schema；scanner：scan(text|keyword[])→hits[]（M1 仅挂报告⑦章过滤；M3 三道闸只消费同一 scanner 接口）。词表首版内容=agent 按 08 条款起草+条款行号引用+人工复核勾选记录（人工白名单④）。Must NOT do：不做 B 端词库运营后台（FR-11.6 M4 前）；不做三道闸执行链（M3：生成后闸/待审标红/执行前终检）；不做分品类宣称规则（M4 前 T-M4-02）；不做词库服务端下发（配置包本地）；不把 scanner 挂到采集/展示链路（M1 消费口=报告⑦章）。
  Closes: T-M1-08 全量（M3 三道闸与 M1 依赖它的任务卡的词库前置）
  Parallelization: Wave 3 | Blocked by: 6（kv_config+keyword_hits 表） | Blocks: 11, 13
  References (executor has NO interview context - be exhaustive): 05:94（卡定义）、05:258（§6 插入行）；01:132（FR-2.7 全文）、01:210（FR-9.6）、01:299（§5.2 出境提示口径）、01:331-334（§5.5 词库三件套）；06:49-55（PC-03）、06:74-75/167/195（PC-05+「M1 前」清单）；08:88/132/138-140（词源条款）；09:126/55-59（XHS-03 修订范围）；02:763（配置包路径）；shared/channels.ts:7-33、shared/schemas.ts:235-253、main/ipc-core.ts:112-376、main/loadHeavyModules（heavy.ts:7-9）、preload.ts:18-34（IPC 加法样板）；provider-matrix.md 风险列（境内外标注数据源）
  Acceptance criteria (agent-executable): ①桌面端单测：keys set→masked 读回断言+DB 文件字节级断言不含明文 key（导出 db 二进制经 grep 全值不存在）；safeStorage 不可用 mock→明文降级前审计条目+告警 toast 断言；②scanner 单测：fixture 极限词×3+导流变体正则×2+医疗类目×1 全命中且 keyword_hits 行数=N+版本号随 hits 落库；③热更即时：bump wordlist manifest→reloadConfig()→同一输入命中行为改变且进程不重启（fs watch/poll 触发）；④Playwright e2e：FR-2.7 三要素渲染断言+调用前 modal 出现一次+第二次不再弹（会话内幂等）
  QA scenarios (name the exact tool + invocation): happy=上述①②④；failure=未配置 Key 时点「测试连接」→断言阻止且指向配置而非报裸错误, Evidence .omo/evidence/m1-insight-plan/task-10-m1-insight-plan.log + wordlist-review-checklist.md（条款行号+人工复核栏）
  Commit: Y | feat(desktop): byok key-config (safeStorage) + wordlist v1 scanner (T-M1-08)
  Recommended task executor category: HEAVY（IPC 三处同步+加密存储+词库管线）
- [ ] 11. T-M1-06 报告 UI：八章节渲染+图表+导出+确认闸门（映射 T-M1-06，B-6）
  What to do / Must NOT do: 一页一闸门：①insight/report 页（c端原型.html 只读参照）：八章节渲染（章节卡+⑧章数据来源四字段展示），读取 reports 表与任务视图数据；FR-5.3 图表=echarts 按需模块（气泡图/价格带直方图/echarts-wordcloud 词云）+getDataURL 导出 PNG（01:162「可导出 PNG」）；FR-5.4 导出 MD（Blob 下载）+PDF=main 进程 webContents.printToPDF 经 IPC 触发（渲染进程打印管线 03:220 B-6 口径，禁 pdf-lib/puppeteer）；FR-4.6 采集列表（insight 视图）导出 CSV（UTF-8 BOM——Excel 可开，不造假 .xlsx）。②选品关键词确认闸门（02:274 E 步；门禁③载体）：报告落库后 collect 工作流进入 gate 等待——tasks 表 status=awaiting_user+payload_json{gate:'keyword_confirm',report_id}（awaiting_user=todo 7 扩出的第 7 态启用点）；确认→写 idempotency_key=sha256(topic+report_id) 推进 selection 任务占位记录（queued，执行归 M2 T-M2-02——不执行选品本体）；拒绝→cancelled；重复确认幂等 no-op（同 idempotency_key 不新建任务）；⑦章建议关键词在展示与确认前过词库黑名单（todo 10 scanner：命中词剔除+keyword_hits 留痕）。Must NOT do：不做选品执行/权重排序（M2 T-M2-02/03）；不引 PDF 第三方库/echarts 全量/D3 手写；真 .xlsx 不做；不做看板/工作流转场（M2 T-M2-06）；不做多语言/主题切换（无基线）。
  Closes: T-M1-06 全量（门禁②③载体在此多方交付，门禁证据在 todo 13 收口）
  Parallelization: Wave 4 | Blocked by: 7（collect/awaiting_user 数据源）, 8（reports 表消费）, 10（scanner+keys） | Blocks: 13
  References (executor has NO interview context - be exhaustive): 05:92（卡定义）、05:254（FR-4.6/5.3/5.4 M1 随报告 UI 插入）；01:161-163（渲染/图表/导出）、01:362（验收）；03:82/220（B-6 定论：PDF=渲染进程打印管线）；05:102（门禁③幂等推进演示）；02:274（E 步人工确认）、02:708-710（idempotency_key）；c端原型.html（insight/report 视图参照）；runner/machine（awaiting_user 扩态，todo 7）；wordlist scanner（todo 10）
  Acceptance criteria (agent-executable): Playwright e2e 全绿：8 个章节 section 选择器齐+⑧章四字段渲染断言、词云/气泡/直方图 canvas≥1 各一、导出 MD 文件内容含 `## `≥8 处+PDF 产物字节数>0、CSV 含表头行（UTF-8 BOM 字节头断言）、闸门状态机：awaiting_user→确认→新建 selection 占位任务含 idempotency_key→重复确认不新建任务（行数不变）、黑名单命中词不出现在⑦章渲染且 keyword_hits 有留痕
  QA scenarios (name the exact tool + invocation): happy=上述 e2e；failure=mock 报告缺⑧章→渲染区显示显式错误提示而非空白页（e2e 断言 error 边界提示）, Evidence .omo/evidence/m1-insight-plan/task-11-m1-insight-plan.log + exported-md-sample.md/pdf
  Commit: Y | feat(desktop): report UI, charts, MD/PDF/CSV exports, keyword gate (T-M1-06)
  Recommended task executor category: HEAVY（UI+导出管线+状态机衔接）
- [ ] 12. FR-2.4/2.5/2.6 追加卡：多 Key 故障转移+用量面板+RPM 限额（05:253「M1（llm-gateway 成熟时）」）
  What to do / Must NOT do: 三件：①FR-2.4 多 Key 配置与故障转移（01:129）：KeyProvider 接口+同任务内主 Key 失败自动切备用（同 provider 多 Key；不跨 provider 混用）+转移时遥测 key_failover 事件；②FR-2.5 用量面板（01:130）：settings/usage 视图=llm_calls 按天/按工作流聚合+自填单价（或预设价）估算+provider 探测档展示（04:63 建议行「探测表纳入用量面板展示」）；③FR-2.6 RPM 限额器（01:131/03:220）：网关层令牌桶（全局+单任务设置界面），超限=排队等待非报错。Must NOT do：不做成本预警推送（无基线）；不做跨 provider 自动调优；不做额度上限熔断（无基线）；FR-2.4 若 Wave 4 中点未合，按预授权顺延条款降级至「M2 前闭合」（触发条件=该时点主功能未合+台账记录证据+用户追认 05 §8；FR-2.5/2.6 不可顺延——体量小且删了会破坏 05:253 插入承诺）。
  Closes: 05:253 P1 插入条款（M1 承诺）+04:63 探测表展示
  Parallelization: Wave 4 | Blocked by: 8（llm-gateway 调用链「成熟」条件） | Blocks: 13
  References (executor has NO interview context - be exhaustive): 05:253（插入行原文）；01:129-131（三条 FR 全文）；03:51（RPM 未显式设计的缺口）、03:220（RPM 入 llm-gateway 定论）；04:63（探测表入面板）；02:714（llm_calls 计量）；07:44（负载注记：FR-2.4~2.6 所属工程师=Agent 工程师）
  Acceptance criteria (agent-executable): `pnpm --filter @xinglian/llm-gateway test` 新增：主 Key 401→同轮自动切备用 Key 断言+key_failover 事件入遥测；全部 Key 失败→任务失败且每 Key 恰试一次（无死循环）；RPM 令牌桶 100/min 配置→第 101 请求被挂起到下一窗口（fake clock）断言；`pnpm --filter desktop test`：usage IPC 聚合+自填单价计算断言+面板渲染 e2e
  QA scenarios (name the exact tool + invocation): happy=三件 e2e 全绿；failure=全 Key 失败场景恰一次尝试数断言, Evidence .omo/evidence/m1-insight-plan/task-12-m1-insight-plan.log
  Commit: Y | feat(llm-gateway): multi-key failover, RPM limiter, usage panel (FR-2.4~2.6)
  Recommended task executor category: unspecified-high（网关能力扩展+面板）
- [ ] 13. M1 真实联调收尾+门禁证据包（最终验证波，门禁五项 05:100-104）
  What to do / Must NOT do: 逐门禁证据（.omo/evidence/m1-insight-plan/gate-evidence.md 汇总表，每项=证据路径+命令+退出码）：①门禁①100 条采集测试报告：真实登录态环境（人工白名单②）跑 collect-target=100 轮；证据=collect_run_stats 落库断言+完成率公式写死：完成率=collected_unique_notes/(collected_unique_notes+no_result_in_scope)（剔除口径四细分 no_result/rate_limited/captcha_consumed/duplicate 全部计数器化，不做口头剔除）；「默认配额无触发风控」可观察=circuit_events 表该轮 OPEN 行数=0。②门禁②样例报告：todo 8 真实 LLM 样例+MD/PDF 导出产物存档（八章节齐全+⑧章数据来源）。③门禁③闸门演示：Playwright e2e 断言（挂起/确认/幂等推进，todo 11）+事件流水 JSON 导出+录屏操作指引文档（实际录屏=门禁评审会人工动作，agent 备材料）。④门禁④热更全流程演示：`pnpm adapter:build && pnpm adapter:sign && node scripts/adapter-activation-e2e.mjs` 三段脚本：v2 包过验签激活→active=v2；篡改→验签拒→active 仍 v1；自检失败→回滚 last-good，transcript 含三段 exit code（todo 4 交付+本卡收口）。⑤门禁⑤熔断演示：fixture 页注入验证码特征→OPEN→暂停→冷却（测试覆盖值 60s）→人工确认→HALF_OPEN→试探→CLOSED 事件流水断言+FR-9.5 抽查（OPEN 态 retry=abort-no-retry+代理配置深比较不变，07:46 M1 门禁抽查）+R1 自检失败率告警验证（todo 9 supertest 造数据）+FR-2.7 界面截图+词库命中留痕样例。+F1-F4 风格收口：根闸门 `pnpm -r lint && pnpm -r test && pnpm -r build` 全绿+`pnpm audit --prod`=0（docs/adr/audit-exemptions.md 更新新依赖豁免如有）+git 基线 diff 校验（02 六授权区之外零改动，scripts/tm101-diff-check.mjs 联跑）。Must NOT do：100 条若剔除平台限制后 <95% 完成率→不降门槛、不注水计数器，走 05 §8 门禁返工/延期机制升级（failure 分支固化）；不代用户门禁签发（人工白名单⑥）。
  Closes: IS-3 全项（M1 退出门禁五项）+IS-5（不达标返工分支）
  Parallelization: 最终验证波 | Blocked by: 4, 5, 6, 7, 8, 9, 10, 11, 12 | Blocks: 无（M1 完成判定→用户确认）
  References (executor has NO interview context - be exhaustive): 05:96-104（门禁五项原文）、05:269-270（R1/R2 缓解行）；01:362/366-369（验收行）；07:46（FR-9.5 抽查）、07:48（架构 v1.2 升级条款：未随门禁产出→升级架构师）；mvp0 计划 F3→f3-gate-evidence.md 先例；todo 4/7/8/9/10/11 各 QA 证据路径
  Acceptance criteria (agent-executable): gate-evidence.md 五门禁逐项映射全 PASS（每项含证据文件路径+命令+退出码）；根闸门四命令全绿退出码 0；audit --prod=0；tm101-diff-check exit 0
  QA scenarios (name the exact tool + invocation): 每门禁一项 happy+failure（如上⑤三段脚本即 failure 案例集），Evidence .omo/evidence/m1-insight-plan/gate-evidence.md + 各 transcript
  Commit: N | docs: m1 gate evidence pack（证据与文档提交，代码变更归前序 todo）
  Recommended task executor category: HEAVY（跨卡证据收口）

## Success criteria
| # | Criterion | Measured by |
| --- | --- | --- |
| 1 | 九视图骨架之上新增功能全部经 IPC 白名单+safeStorage 基线不回退（M0 webPreferences 安全快照测试不回退） | 根闸门 `pnpm -r test` 含既有 299+26 全绿 |
| 2 | 基线漂移=仅 02 六授权区（tm101-diff-check exit 0） | todo 3/13 diff 校验 |
| 3 | 门禁①：100 条采集完成率≥95%（剔除口径计数器化）且 circuit_events 无 OPEN | todo 13 ① |
| 4 | 门禁②：八章节报告（真实 LLM）MD/PDF 产物存档 | todo 13 ② |
| 5 | 门禁③④：闸门幂等 e2e+热更三段脚本 transcript | todo 13 ③④ |
| 6 | 门禁⑤：熔断事件流水+FR-9.5 抽查+R1 告警验证 | todo 13 ⑤ |
| 7 | IS-1~IS-5 复判与 F1-F4 审计（沿 mvp0 先例） | 终验波记录 |
