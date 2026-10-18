# T-M2-06 执行计划：工作流转场——已对接判定 + 「进入发布」携带上下文 + 看板 v1

日期：2026-10-18 ｜ 前置：T-M2-01~05b 全 done（98b054c → 3f0b2e0，本地未推送）

## 任务卡定义（docs/05）

> T-M2-06 工作流转场：已对接判定 + 「进入发布」携带上下文 + 看板 v1 ｜ 产出物：FR-7 链路 ｜ 依赖 T-M2-04 ✅

M2 门禁对应项：**「标记已对接 → 进入发布」转场演示**。

需求原文（docs/01 FR-7）：
- FR-7.1（P0）：货源对接完成判定——用户手动标记「已对接」→ 商品卡片出现「进入发布」按钮。
- FR-7.2（P0）：一键转场——携带商品素材、供应商信息、需求报告结论进入发布工作流，无需重复录入。
- FR-7.3（P1）：工作流总览页——选品中/待发布/推广中/已完成 四列看板，商品卡片可拖拽流转。

## 设计决策（Rulings）

1. **状态模型**：products.status 从三态扩为工作流六态 `候选/对接中/已对接/待发布/推广中/已完成`
   （应用层校验常量 PRODUCT_STATUSES，DB 列为 TEXT，**无 DDL 变更**）。看板四列与状态的
   映射：选品中 = {候选,对接中,已对接}，待发布/推广中/已完成 一一同名。
   推广中/已完成在 M2 无自动生产者（M3 发布/M4 推广后续卡），但看板拖拽允许用户手动推进
   ——这是用户显式意图标记，不是臆造状态。
2. **转场矩阵（products:setStatus 手动簿记面）**：
   - 选品中三态（候选/对接中/已对接）之间自由互转（人工判定/纠正）；
   - 待发布 → 已对接（撤回）、待发布 → 推广中/已完成（手动推进）；
   - 推广中 ↔ 已完成互转、推广中 → 待发布（回退纠正）；
   - **任何 →待发布 都不走 setStatus**（唯一入口是 products:enterPublish，防绕过上下文携带）。
3. **FR-7.2 上下文「携带」= 可推导 join + 审计快照，不建新表**（反过度工程）：
   素材已按 product_id 挂 materials、供应商在 products.supplier_json、报告结论经
   products.task_id → selection payload.reportId → reports 行可达。enterPublish 落审计事件
   PRODUCT_ENTER_PUBLISH（taskId/offerId/from/to/reportId/素材计数/供应商/at）并在返回值里
   给上下文摘要（reportId+topic+素材数+供应商）供 UI 演示；M3 发布链按 product_id join
   三表即得全量上下文，无需重复录入。02 §14.1 不加新表。
4. **EULA/license 门**：setStatus/enterPublish 均为本地簿记写（无对外副作用；对外发送
   仍归 M3 且必经其自身闸门），与 selection:setChecked/setPinned 同口径**不设 EULA 门**；
   视图可达性已由 app:navigate 的 EULA 路由锁保证（dashboard/sourcing 均在锁定面）。
   按钮不挂 data-write-entry（同勾选/置顶按钮，非执行入口）。
5. **docs/02 白名单扩区**：§14.1 products 行状态枚举需同步六态 → tm101-diff-check.mjs
   ZONE_SPECS 追加 §14.1 授权区并注记授权链（01 FR-7.3 四列看板 + 05 卡表 T-M2-06，
   先例：M2-B3 §5.1 / T-M2-05a §7.5）。
6. **看板数据面**：不新增看板通道——products:list（无 status 过滤）返回全量卡片，
   渲染层按状态映射分列（数据量 v1 ≤500，上限与 worker 一致）。

## 实施段

### A. store 六态 + productId 精确筛选（RED→GREEN）
- protocol.ts：PRODUCT_STATUSES 六态；ProductFilter += productId?；worker listProducts 增等值条件。
- 单测：六态全被 setProductStatus 接受、非法态仍拒、productId 筛选命中单行。

### B. shared 契约 + IPC 注册 + main 绑定
- schemas.ts：ProductsListParams.status 枚举六态；ProductsSetStatusParams/Result、
  ProductsEnterPublishParams/Result（handoff 摘要：taskId/reportId/topic/materials{images,desc}/supplier）；channelParamsSchemas 三处登记。
- channels.ts：IPC_CHANNELS += products:setStatus / products:enterPublish + 注记。
- ipc-core.ts：ProductsIpcDeps += setStatus/enterPublish；注册 handler（本地簿记不设 EULA 门，
  注记口径）；main.ts products 绑定补两方法。

### C. outreach-service 转场服务（RED→GREEN）
- setProductStatus(productId, status)：转场矩阵校验（非法迁移稳定错误 E-PRODUCT-TRANSITION-INVALID）；
- enterPublish(productId)：仅 已对接 → 待发布；上下文摘要（getTask→selection payload reportId/topic、
  listMaterials 计数、supplier）；审计 PRODUCT_ENTER_PUBLISH；幂等拒绝重复转场（已待发布报稳定错误）。
- 单测：矩阵合法/非法各代表项、enterPublish happy（fixture payload reportId=0 → reportId null 的
  诚实降级）、未对接拒绝、重复转场拒绝、审计事件断言。

### D. 渲染面
- sourcing.ts 商品卡片：候选/对接中 →「标记已对接」；已对接 →「进入发布」（主按钮）；
  待发布 → 状态徽标 + 转场摘要行（素材 N 张 · 报告「topic」· 供应商）；data-* e2e 标记。
- dashboard 看板 v1（新 renderer/board.ts + index.html 看板 section + shell.css）：
  四列（选品中/待发布/推广中/已完成）+ 列计数 + 紧凑卡片（图/标题/状态/供应商）；
  HTML5 拖拽流转：跨列 drop → 选品中内部 = setStatus、→待发布 = enterPublish、其余 = setStatus；
  非法迁移由主进程稳定错误回退并刷新（诚实报错）。

### E. e2e（fixture 全链路，兼 M2 门禁转场演示）
- e2e/workflow-board.spec.ts：selection:insertFixture → outreach:start（XINGLIAN_OUTREACH_FIXTURE=1）
  → 2 卡对接中 → 标记已对接 → 「进入发布」出现并点击 → 待发布 + 摘要行 → 工作台看板
  待发布列出现卡片 → 拖拽至推广中/已完成 → 状态回写断言。

### F. 文档同步 + 收口
- tm101-diff-check.mjs ZONE_SPECS += §14.1（授权链注记）；02 §14.1 products 行六态化。
- docs/05 卡表 T-M2-06 标注交付；完成报告四段式落 .omo/evidence/m2-workflow/完成报告.md。
- 全量自测：pnpm -r build → desktop run-tests → e2e → pnpm ci:all + tm101-diff-check exit 0。

## 红线（不可违反）

- 不触碰对外发送链路（M3 才有）；本卡全部为本地簿记与展示，无任何对外写操作。
- 上下文「携带」不复制报告正文/素材文件——只落可推导引用 + 审计（单一事实源不重复）。
- 看板拖拽不隐式触发任何外部动作；非法迁移主进程拒绝并如实回显。
- docs/02 仅动 §14.1 授权区（白名单门禁 exit 0 为证）。
