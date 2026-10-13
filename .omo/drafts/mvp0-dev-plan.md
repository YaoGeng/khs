---
slug: mvp0-dev-plan
status: drafting
intent: clear
review_required: true
plan_path: .omo/plans/mvp0-dev-plan.md
plan_sha256: dc93545a2d9ffa3724f974445f868a0132205c1e624a457522c494e6eb20b7e0
review_round_id: r1-mvp0-20261010
review_round_limit: 5
pending-action: write and review .omo/plans/mvp0-dev-plan.md
review:
  plan_reviewer:
    status: approved
    workspace_root: C:/Users/yg/Desktop/khs
    runtime_home: null
    target: .omo/plans/mvp0-dev-plan.md
    round_id: r1-mvp0-20261010
    plan_sha256: dc93545a2d9ffa3724f974445f868a0132205c1e624a457522c494e6eb20b7e0
    launch_id: st_01a12717
    session: st_01a12717
    result: "[OKAY] 无阻塞发现、无备注；引用实证核对通过（05:56-66/05:68-77/02:145/02:610-617/03:230/01:262 等）；IS-1~5 映射完整；round r1/5 一轮收敛"
    model: zai/glm-5.3-flash（kimi-k3 429 绕行，与顾问轮同通道）
    validated: 交付前 live plan SHA 重算与绑定摘要一致（2026-10-10）
approach: 按 05 v1.1 基线将 M0（T-M0-01~11 + 6 项退出门禁）细化为决策完备执行计划，写入 .omo/plans/mvp0-dev-plan.md；随后 plan-consultant 缺口分析 + plan-reviewer 高精度终审（用户要求的"双审"）
---

# Draft: mvp0-dev-plan

## Affected user and ideal state

### 受影响用户
| 用户 | 今天如何用 | 计划交付后如何用 |
|---|---|---|
| 开发执行者（客户端/服务端/Agent 工程师或 AI 执行代理） | 只有 05 §4 一行式任务卡，开工前需口头对齐 | 拿到计划 todo 即零面试开工：引用/验收/QA/证据/路由俱全 |
| 用户本人（发起人，M0 启动会主持） | T-PRE-04 无执行级计划可会签派发 | 有一份决策完备、经双审的 MVP0 计划，启动会直接确认派发 |
| 03~09 评审链与 05 基线（文档消费者） | 05 v1.1 是唯一基线 | 新计划仅做执行细化并回指 05，不产生第二基线 |

IS-1 | 执行者对 M0 全部 11 张任务卡获得零面试可执行的开发计划行：精确文件/模块引用、agent 可执行验收标准、happy+failure QA 场景与证据路径、推荐执行路由 | 05 卡片仅一行内容+负责+产出+依赖，无验收与 QA
IS-2 | 计划与 05 v1.1、PRD v1.3、架构 v1.1 零漂移，Must-NOT-Have 护栏禁止 M1+ 与基线修改 | 范围变更须走 05 §8 三方会签，执行计划不得私改基线
IS-3 | M0 退出门禁 6 项逐项映射到计划内 QA 场景与证据路径（演示录屏/测试记录/spike 报告/实测报告） | 门禁表仅有证据类型，无逐项 QA 场景
IS-4 | 计划经双审并留回执：plan-consultant 缺口分析修订 + plan-reviewer 高精度终审通过 | 双审尚未发生
IS-5 | spike 卡（T-M0-04/05/06）不利结论的处理分支固化在计划内（当周升级架构师、最差 M0 延 1 周从 M6 缓冲扣） | 05 §7 有风险应对文字但未固化为任务分支

GAP-1 | 不存在任何 M0 执行级开发计划 | 产物 .omo/plans/mvp0-dev-plan.md 待建 | 计划写入 todos
GAP-2 | 05 各 M0 卡缺验收标准/QA/证据路径/执行路由 | 执行者无法零面试开工 | 每卡对应 todo
GAP-3 | spike 不利结论分支未固化 | 不利结论时执行者无决策路径 | spike todo 的 failure QA 分支
GAP-4 | 双审未发生 | 用户明确要求双审 | plan-consultant + plan-reviewer 两道审

## Components (topology ledger)

C1 | 授权与账号链：NestJS auth/register/login + PG/Redis + license 签发/验签/设备绑定/72h 宽限（T-M0-03/07） | active | 05 §4 M0 表；02 §9.5/§12/§14.2
C2 | Electron 壳与工程设施：Monorepo+CI+打包管线；main/preload/renderer+contextBridge 白名单+zod（T-M0-01/02） | active | 05 §4 M0 表；02 §3.3/§4
C3 | 受控浏览器接管：拉起+CDP 接管+会话检测+让位（T-M0-08） | active | 02 §5；PRD FR-3.1~3.5
C4 | 日志与合规基础：pino NDJSON+SQLite 索引+trace_id+store 迁移链；EULA/遥测同意（T-M0-09/11） | active | 02 §10；PRD FR-1.9/FR-10.1/FR-12.6
C5 | 技术 spike：S3 SQLite 写阻塞、S6 调试口、S4+S11 BYOK 矩阵+sqlite-vec（T-M0-04/05/06） | active | 05 §4 M0 表；04 架构评审 S 项
C6 | 工程规范固化：XState/DAG 边界（S9）+任务卡与完成报告制度（T-M0-10） | active | 05 §4 M0 表

## Open assumptions (announced defaults)

计划形态 | 中文 markdown，.omo/plans/mvp0-dev-plan.md，作为 05 M0 的执行细化（非新基线） | 用户拍板"M0地基执行计划" | 可逆
执笔 | 主会话按 ulw-plan 执笔；05 的 PM 基线与角色代理分工不受影响 | 用户本次显式调用 ulw-plan；分叉提问时已公告未获异议 | 可逆（审批环节可改）
双审构成 | plan-consultant 缺口分析 + plan-reviewer 高精度终审 | ulw-plan 内建双审与用户"计划双审"对应；reviewer 回执入草稿 | 不可跳过（用户明确要求）
日历 | 沿用 05 建议日历 M0=2026-10-12~10-25，以 T-PRE-04 启动会确认为准 | 05 头注"日期为建议排期" | 可逆
外部约束 | 人力/预算沿用 05 §1 假设（峰值 6.5 人、无新增付费服务）；无目标受众/合规新增 | 05 已基线，本计划仅细化 M0 | 可逆
T-PRE-04 | 启动会是用户主持的人工会，不列为计划 todo，仅作前置条件说明 | 05 §3；ulw-plan 零人工验证原则 | 可逆
激活码兑换 | 待用户拍板：推荐"M0 计入最小兑换（单码生成+兑换+防重放，T-M0-03/07 扩展，启动会追认）"，备选"演示库种子数据代替" | 05:72 门禁要求开卡全流程通，但 05:190 兑换卡在 M5——基线内矛盾，须业主定 | 折中均可逆（M5 全量卡服务不变）

## Findings (cited - path:lines)

- 05-AI开发计划与里程碑.md §4 M0：T-M0-01~11 任务卡与 6 项退出门禁（授权全流程/CDP 接管/spike 结论/崩溃恢复/冷启动实测/EULA+遥测）
- 05 §3：入口门禁 T-PRE-01~03、T-PRE-05 全部完成方可进入 M0；T-PRE-05 已交付（PRD v1.3）；T-PRE-04 待用户主持
- 05 §5/§7：关键路径=授权链路；spike 排 M0 第一周、不利结论当周升级架构师、最差 M0 延 1 周从 M6 缓冲扣
- 02-系统架构设计.md §3.3（全仓 TS Monorepo/pnpm workspace）、§4（Electron 进程模型/主进程模块清单）、§5（CDP 接管）、§9.5（许可证签发验签）、§12（服务划分）、§14（SQLite WAL/PG 数据模型）
- 01-需求说明书.md：FR-1.9（EULA 首启确认，P0（M0））、FR-12.6（遥测 opt-in，P0（M0））、FR-1.1/1.2（注册登录）、FR-1.3/1.4（激活码与设备 1/3 台）、FR-3.1~3.5（受控浏览器五条）、FR-10.1（五类日志）
- 04-架构评审报告.md：S3/S4/S6/S11 放行条件挂 M0 spike（grep 实证见会话记录）
- 记忆（khs-xinglian-project.md / notes/facts/2026-10.md）：D-01~D-03 修正落地（PRD/架构 v1.1）、T-PRE-05 完成（PRD v1.2→v1.3）、角色 agent 已具备只读工具
- architect memo（st_01a126f4，已独立核实）：3 项 NEEDS OWNER DECISION 中 ①激活码兑换缺口属实（05:72 门禁要求开卡 vs 05:190 T-M5-02 兑换在 M5）；②任务运行器缺口属实（门禁4崩溃恢复演示需 02:204 workflow-engine 最小骨架，M0 无归属卡，02:453/709-710 有持久化规则与表设计）；③C-3 不缺定义——03:230 已规定 M0 设启动性能预算+NFR-1 ≤3s（01:262），架构师此条不成立

## Decisions (with rationale)

- D1 | MVP0 = M0 地基执行计划 | 用户 2026-10-10 拍板（选项"M0地基执行计划"）
- D2 | 执笔=主会话（ulw-plan），05 PM 基线不动 | 见 Open assumptions 第 2 行
- D3 | 双审=plan-consultant + plan-reviewer | 用户明确要求双审；skill 权威政策
- D4 | todos 以执行粒度映射 05 卡号（可拆可并，每 todo 标注对应 T-M0-xx） | 保证与基线可对账
- D5 | QA 策略=tests-after + agent-executed QA（每 todo happy+failure 场景、证据路径）；M0 门禁 6 项映射进 Success criteria | ulw-plan 契约
- D6 | spike 采用 fallback-branch：S6 不利→port=0+loopback+PID 校验（02§5.3/§11.2）；S11 不利→本地嵌入缓存表（02§3.1）；S4 不利→能力分档预设（05§7 R9）；T-M0-08/09 按分支配置合流，不让 spike 阻塞 Wave 5 | architect 建议采纳，全部有文档锚点
- D7 | 门禁4所需最小任务运行器并入 T-M0-09 todo（tasks/task_steps/task_events + XState 生命周期 + running→suspended 恢复），归属客户端 B 与 T-M0-09 一致 | 执行级分解的内部默认，可逆
- D8 | C-3 按 03:230 处理：启动性能预算分解（主进程延迟加载、V8 snapshot、首屏骨架）入 T-M0-01/02 验收，实测值对照 NFR-1 ≤3s 入门禁映射 | 文档已有定义，非缺口
- D9 | 激活码兑换=计入 M0 最小兑换（单码生成+兑换+防重放+留痕，T-M0-03/07 扩展），T-PRE-04 启动会三方追认 | 用户 2026-10-10 审批时拍板（选项"计入M0最小兑换"）

## Scope IN

- M0 全部 11 张任务卡（T-M0-01~11）的执行级计划：每 todo 带引用/验收/QA/证据/路由
- 入口前置说明（T-PRE 状态与 T-PRE-04 前置条件）
- M0 门禁 6 项 → Success criteria 映射
- 最终验证波（F 系列）

## Scope OUT (Must NOT have)

- M1+ 任何功能实现（采集/报告/选品/发布/推广/支付/B 端页面）
- 对 01/02/05 等基线文档的任何修改
- P1 提前（FR-2.4~2.6、FR-12.2/12.3 等）
- 任何超出 05 §8 变更机制的范围调整
- 计划本身不写代码——执行归 /ulw-execute

## Open questions

（无——唯一分叉 MVP0 指向已由用户拍板为 M0 地基执行计划）

## Approval gate
status: drafting
plan_state: 已交付：计划写入并通过双审（consultant 18 条折叠 + plan-reviewer r1 [OKAY]），SHA dc93545a2d9ffa3724f974445f868a0132205c1e624a457522c494e6eb20b7e0（33739 bytes）；执行由 /ulw-execute mvp0-dev-plan 启动
pending-action: done: plan written and reviewed (r1 approved)
next: plan-consultant 缺口分析返回后折叠合格发现并修订计划，再 spawn plan-reviewer 终审
consultant_round1: st_01a12703（kimi-k3）429 失败；st_01a12704（zai/glm-5.3-flash）完成——18 条发现（3 blocker：验证码投递矛盾/签名 notarize 预算与平台前提/门禁③评审纪要无机制；15 note）已全部独立核验后折叠（30 处精确替换，结构复检通过），SHA 重算为 dc93545a2d9ffa3724f974445f868a0132205c1e624a457522c494e6eb20b7e0（33739 bytes）；另采纳默认：签名降级（M0 未签名包+状态列，发起人可改判采购）、验证码 dev 传输（T-PRE-04 与 D9 同批追认）、本地质量门（无远端不设假 CI）、行政线 checklist（owner=发起人）
env_note: opencode-go/kimi-k3 于 ~18:05 429（provider 级用量上限，retry-after ≈ 29.8h）；后续 plan-reviewer 派发同样需 model=zai/glm-5.3-flash 覆盖（首次尝试 st_01a12703 因此失败，重发 st_01a12704 已用覆盖）
approach: 5 个执行波次覆盖 T-M0-01~11（11 个实现 todo，每 todo 带引用/验收/QA/证据/路由）+ F1~F4 最终验证波；spike 采 fallback-branch；门禁 6 项映射 Success criteria；写入 .omo/plans/mvp0-dev-plan.md 后跑 plan-consultant + plan-reviewer 双审
next: 用户批准后重跑 scaffold（无 --draft-only）创建计划骨架并 APPEND todos


## ��׼׷�ϣ�T-PRE-04 �����ᣬ2026-10-13��

- **D7 ׷��ͨ��**���û�ȷ�ϣ�2026-10-13������С�������������� T-M0-09 ִ�С���tasks/task_steps/task_events ���� + XState v5 �������� + kind=demo �ϳ������Ž���Ψһ��ʾ���壩���� F4 ��� G-3 ȱ�D9 ͬ��ȷ�ϣ�ԭ��׼ 2026-10-10 ���䣩��
- **M0 �Ž����ȷ��**���û�ȷ�ϣ�2026-10-13����F1=PASS / F2=PASS��audit prod ���㣩/ F3=6/6 PASS / F4=PASS �� tag m0-gate��

