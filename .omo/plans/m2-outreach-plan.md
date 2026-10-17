# T-M2-04 执行计划：收藏询盘执行端 + 素材留存 + 商品卡片入库

日期：2026-10-18 ｜ 前置：T-M2-01/02/03/03b 全 done + 真实登录验收 ✅（pilot-5 候选 30 条落库）

## 任务卡定义（docs/05）

> T-M2-04 收藏 + 询盘执行（发送前确认弹窗）+ 素材留存 + 商品卡片入库 ｜ 产出物：selection DAG 后半 ｜ 依赖 T-M2-01

M2 门禁对应项：**勾选→收藏→询盘（确认弹窗留痕）→素材→商品卡片链路通，卡片含原始链接**。

## 输入与前置缺陷（真实登录验收遗留）

1. **offerTitle 噪声**：sourcing-port 取 `card.textContent`（含「找相似+公司名+服务分」噪声），30 条真实样本已入库（pilot DB sourcing_candidates，title 首词全是「找相似」）。
2. **sales_text/supplier_name/supplier_address 全 NULL（30/30）**：`[class*="sales"]`/`.company-name` 登录态结果卡未命中；price_text 混入销量文本（如「¥6.5新人价1.0万+件」）。
3. **favorite/inquiry 写 selectors 全部「合理编写」**（契约扩展卡声明待 T-M2-04 登录态联调校准）。

## 红线（不可违反）

- FR-6.4/FR-12.7：收藏、询盘**发送前确认弹窗永远人工**，不受自动化档位影响；审计留痕（taskId/offerId/用户决定/时间戳）。
- 本轮自动化工作**只做只读 DOM 探测**，绝不代用户点击收藏/发送询盘（真实写操作联调须用户在场）。
- FR-3.1：客户端不接触账号密码；登录态来自受控浏览器 profile。
- 02:328 NFR-3：不可重入步骤恢复先 verify 核对，已成功跳过重放。

## 阶段 A：登录态 DOM 校准探测（只读取证）

**约束**：主应用（electron 15112）与受控浏览器（pipe 传输，无 TCP CDP 口）正在运行，profile 被锁 → 探测走**复制 profile** 路线：

1. robocopy `cdp-profiles/1688` → `%TEMP%/khs-probe1688-copy/`（排除 Cache/Code Cache/GPUCache/component_crx_cache/SODA*/WasmTtsEngine 等 ~950M 缓存；Cookies 在 `Default/Network/` 必须带上）。
2. 内置 Chromium `--remote-debugging-port=0` 起副本 → DevToolsActivePort → playwright connectOverCDP。
3. 登录态校验：搜索页无登录墙 + 页面含会员名特征；若副本登录态损坏（Cookies 拷贝竞态）→ 停手，改约用户在场窗口探测（不硬跑）。
4. 取证面（全只读，不点击任何写操作）：
   - 搜索结果页：前 6 张卡片 outerHTML（截断）+ title/price/sales/supplier/address/moq 候选选择器命中计数 + 卡片容器结构链。
   - 1 个商品详情页（用搜索卡 offerId 拼规范 URL）：offerTitle(h1)/图集/文案描述区/收藏按钮/询盘入口/旺旺会话窗候选结构。
5. 报告落 `scripts/out/probe-1688-loggedin.json`；杀进程只杀自己 spawn 的 PID（进程归属核对，见记忆 khs-process-kill-path-check）。

## 阶段 B：前置修复（offerTitle 校准 + 提取锚点重写）

- sourcing-port `extractOfferCardsSource` 重写：title 改卡片内商品标题锚点（探测定锚）；price/sales/supplier/address 分锚提取；保留 bigram 相关性口径不变（agent 层不动）。
- adapters-1688 selectors 校准：offerTitle/priceTag/salesTag/supplierName/supplierAddress + favorite/inquiry 写位点按探测结果改写；自检 fixtures 同步；包版本按 semver 判断（选择器文本变更 = patch/minor 升档，契约不变则 patch）。
- 用 pilot DB 30 条样本做回归断言（新锚点提取函数对样本 raw 输入的纯函数单测）。

## 阶段 C：store v5 —— products + materials（§14.1 口径）

- `products`：id, product_id(唯一), title, price_min/max, moq, sales, repurchase, supplier_json, scores_json, link, status(候选/对接中/已对接), task_id, created_at/updated_at。
- `materials`：id, product_id, kind(image/desc), path, source_url, hash, created_at。
- migrations.ts upV5 + schema.ts 投影 + store worker 写路径 + protocol.ts 通道消息类型。
- sourcing_candidates 保持快照语义不动（历史保真）；products 是「勾选后」的商品实体。

## 阶段 D：勾选 + 收藏/询盘执行端（T-M2-04 主体）

1. **勾选（FR-6.3）**：renderer 候选表勾选列 + `selection:setChecked` 通道（kv `selection:checked:<taskId>` 存 offerId 集，setPinned 同款模式）。
2. **outreach-service（main 侧新服务）**：
   - 输入：taskId + 勾选 offerId 集 → 逐候选串行执行（ADR-6 单浏览器串行）。
   - flow 执行器：消费 adapters-1688 DSL favorite/inquiry flow（经 adapter-loader 激活包）——navigate→waitFor(expect 特征核验)→**confirm 闸**→confirm.expect 核验→nonReentrant 步骤→verify 成功核对。
   - **confirm 闸**：挂起等待用户在 app 弹窗决定（不碰平台页）；`outreach:pending` 通道推 renderer；决定（确认/跳过/取消整批）落 task_events 审计（type=OUTREACH_CONFIRM，payload=taskId/offerId/flow/决定/时间戳）。
   - 话术模板组装（compose_inquiry）：需求数量 + 一件代发询问 + 素材授权句（FR-6.4 原文三要素）；弹窗内可编辑后确认。
   - 素材留存 + 商品卡片入库在收藏/询盘成功（或用户跳过写操作仅勾选）后执行。
   - fixture seam：`XINGLIAN_OUTREACH_FIXTURE`（file:// fixture 页回放，e2e 全链路不碰真站）。
3. **素材留存（FR-6.5）**：详情页图集 URL 提取 → 受控浏览器页内 fetch → base64 回传 → main 写盘 userData/materials/<offerId>/（hash 记录）+ 文案描述文本落 materials kind=desc。
4. **商品卡片列表（FR-6.5 展示面）**：sourcing 页新 section「商品卡片」——图/标题/价格/供应商/原始链接 +「打开货源页」按钮（shell.openExternal）。

## 阶段 E：自测与验收

- 单测：提取锚点纯函数（30 样本回归）/ 话术模板 / outreach 状态与审计 / store v5 迁移。
- e2e：fixture 全链路（勾选→确认弹窗→收藏→询盘→素材→卡片入库，含拒绝路径审计）。
- `pnpm ci:all` 全绿 + tm101 门禁（docs/02 若有白名单区内改动）。
- 真实写操作（真点收藏/发询盘）**不做**——留用户在场验收轮（与 M2 门禁演示合并）。

## 产出物清单

- 代码：sourcing-port / adapters-1688 / store v5 / outreach-service / channels+schemas / renderer sourcing 页。
- 证据：probe-1688-loggedin.json + `.omo/evidence/m2-outreach/完成报告.md`（四段式）。
- 不推送（提交本地，推送由用户决定——沿用 T-M2-03b 后惯例）。
