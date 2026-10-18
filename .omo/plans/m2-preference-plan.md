# T-M2-07 执行计划：偏好画像 v1——勾选/淘汰行为落 preferences 表 + 评分偏好回流

日期：2026-10-19 ｜ 前置：T-M2-01~06 全 done（98b054c → 6c41de6，本地未推送）

## 任务卡定义（docs/05）

> T-M2-07 偏好画像 v1：勾选/淘汰行为落 preferences 表 ｜ 负责 Agent 工程师 ｜ 产出物：偏好回流 ｜ 依赖 T-M2-03 ✅

需求口径：FR-6.7「Agent 可学习：用户对候选的勾选/淘汰行为形成偏好画像，后续评分自动加权（本地学习，不上传）」（P1）；
FR-9.8 同信号面。架构口径：02 §14.1 `preferences(id, scope, key, value_json, updated_at)`；
§8.1/§8.3 学习信号「勾选/淘汰 → 调整维度权重先验与偏好特征」。

## 设计决策（Rulings）

1. **淘汰信号源 = 新增显式 UI 动作**（候选行「淘汰」切换，交互模式复用置顶列）。
   现有 UI 只有勾选/置顶/权重，无淘汰动作；取消勾选语义污染（执行完清理 ≠ 不要），
   不臆造隐式淘汰。`selection:setDismissed` 新通道，kv 不落淘汰集——淘汰当前态
   从 preferences 流水派生（append-only 单一事实源）。
2. **互斥语义**：同一候选不能既是采纳又是淘汰——`setDismissed(true)` 自动移出勾选集；
   `setChecked(true)` 自动移出淘汰集（流水各记各的行为，互斥在写面保证）。
   置顶不与淘汰互斥检测冲突（置顶属采纳组，派生时被淘汰末态覆盖）。
3. **preferences 表（migration v6）** 严格按架构 §14.1 五字段（id TEXT PK / scope /
   key / value_json / updated_at），**append-only 流水**（不建 scope+key 唯一约束，
   画像快照也走 append，读面取最新）；索引 (scope, key)。worker 只加两方法：
   `insertPreference` / `listPreferences`（写路径必须走 worker——红线）。
4. **埋点形状**：scope=`selection`，key=`behavior`，value_json =
   `{kind: 'checked'|'pinned'|'dismissed', taskId, offerId, flag, dims?, total?, title?, at}`。
   dims = 六维分快照（埋点处主进程 listSourcingCandidates({taskId}) 内存映射取，TopN
   规模无谓加 store byOffer 查询面）；取不到（候选行已被重采覆盖等）→ dims=null，
   派生时跳过该行（诚实不臆造）。
5. **画像派生（确定性、无 LLM）**：读时聚合流水 → 每 offerId 最末态分组：
   adopted（checked 末态 true）/ dismissed（dismissed 末态 true）/ neutral（其余已见）。
   `dimBias[dim] = clamp((mean(adopted) − mean(others)) / 100, −0.5, +0.5)`，others =
   dismissed ∪ neutral。**生效门槛**：adopted ≥ 3 且 others ≥ 5（常量可审计），
   不足 → bias 全 0 + `sampleInsufficient: true`。派生结果 append 画像快照行
   （key=`profile`，学习轨迹），`selection:config` 每次现算返回（不读缓存行）。
6. **回流 = 权重乘性微调，用户显式权重不被静默覆盖**：
   `effectiveWeights[dim] = userWeights[dim] × (1 + dimBias[dim])`（负值钳 0，重归一），
   enabled 关闭或样本不足 → effective = user。开关落 kv `selection:preference:enabled`
   （默认 true，FR-6.7 本意），config 返回 preference 块
   `{enabled, adopted, dismissed, sampleInsufficient, dimBias, effectiveWeights}`。
   渲染层 displayTotal 改用 effectiveWeights，权重面板注记「含偏好加成（N 勾选/M 淘汰）」
   ——可解释可见，不留静默改分。
7. **边界（同 T-M2-03 溯源口径）**：本卡不动 `packages/agents`（selection-agent 原始
   评分与权重常量不改——库内 rank/total 溯源不动，回流只发生在视图层重算）；
   不新增跨包契约（dims 快照是普通 JSON，渲染 bundle 不带 agents 的镜像断言面不变）。
8. **agents 包不承载画像逻辑**：偏好派生与融合是 main 侧新服务
   `preference-service.ts`（组合根注入 selection-view-service / outreach-service /
   ipc-core），负责工程师口径的「偏好回流」归口。

## 实施段

### A. store 六字段落表（RED→GREEN）
- `schema.ts`：preferences drizzle 定义（02:770 注记）。
- `migrations.ts`：v6 `0006-m2-preferences`（CREATE TABLE + 索引 + down）。
- `protocol.ts`：`insertPreference` / `listPreferences` 请求响应；`client.ts` StoreClient
  类型与实现；`worker.ts` 写路径（值域校验：scope/key 非空字符串）。
- 测试：`migrations.test.ts` v6 落表 + `worker.test.ts`/`client.test.ts` 插入/读序。

### B. shared 契约 + IPC 注册
- `channels.ts`：白名单加 `selection:setDismissed` / `selection:setPreferenceEnabled`
  （设置性质，与 setPinned 同口径不设 EULA 门）；SELECTION_DIMENSIONS_SCHEMA 不动。
- `schemas.ts`：zod strictObject——`SelectionSetDismissedParams/Result`、
  `SelectionSetPreferenceEnabledParams/Result`、`SelectionPreferenceInfo`、
  `SelectionConfigResult` 扩展 `preference` 块（先 schema 后 infer）。

### C. main：preference-service（RED→GREEN）
- `main/preference-service.ts`：`recordBehavior`（读候选 dims → 流水落表）、
  `deriveProfile`（末态分组 → dimBias → 快照行）、`computeEffectiveWeights`
  （乘性微调 + 重归一）、enabled kv 读写。全部确定性纯逻辑 + store 注入，单测覆盖：
  埋点互斥、末态覆盖、门槛不足 bias=0、钳位与归一、损坏流水跳过。
- `selection-view-service.ts`：`setDismissed` / `setPreferenceEnabled`；
  `getConfig` 扩展 preference 块；`setPinned` 埋点。
- `outreach-service.ts`：`setChecked` 埋点（含自动移出淘汰集）。
- `ipc-core.ts`：注册两通道（组合根绑定 preference-service）。

### D. 渲染面
- `sourcing.ts`：候选行「淘汰」切换按钮（复用置顶交互；淘汰行视觉标记）；
  权重面板画像摘要行（样本不足诚实提示 / 生效注记 + 开关）；
  `displayTotal` 数据源改 `effectiveWeights`。

### E. e2e（fixture 门控，兼 M2 门禁「偏好回流」演示）
- `e2e/sourcing-preference.spec.ts`：insertFixture → setChecked×3 → setDismissed×2 →
  config 断言 preference 块（adopted/dismissed/dimBias/effectiveWeights）→ 候选行
  淘汰按钮 + 摘要注记可见；开关关闭 → effective 回落 user weights。

### F. 文档同步 + 收口
- docs/05 卡表 T-M2-07 标注已交付（照 T-M2-06 样式）；02 §14.1 preferences 行架构
  已预定无需改（tm101 门禁不触碰）。
- 完成报告四段式（产物/证据/自测/风险）落 `.omo/evidence/m2-preference/完成报告.md`。

## 红线（不可违反）

- 写路径必须走 store worker（禁主进程直连 SQLite）。
- 契约一律 zod strictObject，先 schema 后 type infer；契约双端镜像同步。
- 不动 packages/agents 评分常量与 selection-agent；库内原始评分溯源不动。
- 本地学习不上传：preferences 不出任何出站面（无遥测/无服务端同步）。
- 渲染层不 import 业务引擎包（只 @xinglian/protocol + @xinglian/logger 豁免）。
- 证据门禁：完成报告必须含 产物/证据/自测/风险 四段，证据落 .omo/evidence/。
