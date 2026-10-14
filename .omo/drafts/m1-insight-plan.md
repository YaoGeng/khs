# m1-insight-plan — 草稿/决策台账

> 状态：planning 阶段（plan-reviewer 终审进行中）
> live 计划：`.omo/plans/m1-insight-plan.md`（SHA-256 在审后回填）
> 证据目录约定：`.omo/evidence/m1-insight-plan/`

## 决策记录

| # | 决策 | 来源 | 状态 |
| --- | --- | --- | --- |
| D1 | 真实 LLM Key 由用户在 Wave 1 注入（env：PROBE_*_API_KEY）；探测复跑升 [实测] 档；报告 Agent 端到端真实验证；门禁②真实样例报告 | 用户 2026-10-13 拍板（选项「我会提供真实 Key」） | ✅ 已批准 |
| D2 | 开发期真实联调：Wave 3 起真实登录态 Chrome 小批量 10–20 条（保底条款：熔断器/配额先就位、先 mock 调试、保守低配 ≤50/日、风控异常即停窗不绕过）；F 波 100 条门禁轮 | 用户 2026-10-13 拍板（选项「开发期就真实联调」，接受风控暴露） | ✅ 已批准 |
| D3 | FR-2.4/2.5/2.6 纳入 M1 为 todo 12（05:253「M1（llm-gateway 成熟时）」）；FR-2.4 预授权顺延条款（Wave 4 中点未合→M2 前闭合+台账记录+用户追认）；FR-2.5/2.6 不可顺延 | metis 差距分析⑤-5 + 05:253 | 计划内置 |
| D4 | 基线文档修改仅限 05:87 授权的 02 六授权区（§6.2/§7.5/§12.1/§13/§4.2/版本头），并以 scripts/tm101-diff-check.mjs 做 diff 白名单校验 | 05:87（T-M1-01 产出物定义） | 计划内置 |
| D5 | 嵌入缓存单表单 dim（不做多 dim 分表矩阵）；dim=todo 1 实测默认档；变更=缓存重建 | metis ②-12 + provider-matrix.md:91 决策点 | 计划内置（ADR-7 收口） |
| D6 | 热更 M1 用本地包路径+dev 签名 CLI；服务端配置下发模块不做（02:687 属 M2+ 评估） | 05:88 未列服务端 + mvp0 护栏惯性 | 计划内置 |
| D7 | 去标识化规则：昵称/ID→本地盐 hash 前 8 hex 假名；粉丝数→量级分桶；仅 LLM payload 清洗，本地 notes 原文不动；默认开启、设置页显式确认后可关并留痕 | metis ②-3 + 06:54②/06:179 | 计划内置 |
| D8 | 让位信号：CDP addScriptToEvaluateOnNewDocument passive 监听+automation-window 回环抑制（恢复阈值 3s）；红线解释写入 notes-browser-m0.md | metis ②-4 + 02:240 + 01:386 边界解释 | 计划内置 |
| D9 | 词库 M1 落「配置包 JSON+版本 manifest+scanner+keyword_hits 留痕」，消费口=报告⑦章黑名单过滤；首版内容 agent 起草+人工复核（人工白名单④） | metis ①-3 + 02:763 + 09 XHS-03 | 计划内置 |
| D10 | XState 扩态 queued/awaiting_user/yielded/paused 启用；boot 恢复：yielded/paused→suspended、awaiting_user 原样保留；确认闸门复用 tasks 表+idempotency_key，不建新状态机 | metis ②-5/11 + machine.ts:8 注记 | 计划内置 |
| D11 | 探测锚定回退：glm5.3flash=1211 模型不存在、glm-5.3-flash=1113 付费无额度 → zhipu 实测锚定脚本默认免费模型 glm-4.7-flash（tool calling ok / json_schema 实测确认不可用 / embeddings 账号阻塞维持文档档）；**M1 真实跑 LLM = OpenCode Go 免费模型 `longcat-2.5-preview-free`**，base_url=`https://opencode.ai/inference/go/v1`（2026-10-13 编排器实测：/models 200 且含该模型、/chat/completions 200、/embeddings 404 无嵌入端点→统计聚类为 ADR-7 主路线坐实）；BYOK 自定义 base_url 运行时配置（key 在 secrets：M1_REALRUN_*；非矩阵第六预设，key-config UI 不加新预设）；0 天留存不训模型 | 用户 2026-10-13 拍板 + 编排器连通性实测 | ✅ 已批准 |
| D12 | eslint 边界规则 M1 分层细化：业务引擎包的组装只允许发生在主进程组合根（main/tasks/store/compliance/license/browser/logs），渲染层与 preload 对全部业务包（含新增 adapter-loader/stealth-middleware）保持全禁；工程规范「目录边界」节同步。由编排者统一修订（避免 Wave 2 三卡并行改同一文件冲突） | 编排决策 2026-10-13（M0 规则二写于业务包尚不存在时，按安全架构本意细化） | ✅ 已应用（lint 复跑绿） |

## 人工动作白名单（阻塞点显式等待，台账记录）

| # | 动作 | 阻塞的 todo | 时点 |
| --- | --- | --- | --- |
| W1 | 用户注入真实 LLM Key（env） | todo 1 启动前置 | Wave 1 |
| W2 | 用户提供已登录小红书的本机 Chrome（小批量+100 条两窗口） | todo 7 真实联调段 / todo 13 门禁① | Wave 3 / F 波 |
| W3 | dev 签名私钥保管确认（仅本地，不入库） | todo 4 | Wave 2 |
| W4 | 词库首版内容人工复核勾选 | todo 10 | Wave 3 |
| W5 | T-M1-01 架构 diff 书面复审确认（04:118；agent 只产 tm101-review-pack.md） | todo 3 | Wave 1→2 |
| W6 | M1 门禁评审会（agent 备材料+录屏指引） | todo 13 之后 | M1 退出 |

## review block（plan-reviewer 回执）

- r1-m1-20261013：**approved**——reviewer 逐项抽查核实 13 个 todo 的文件与行号引用（9 份基线文档锚点逐条命中；代码锚点 runner.ts/machine.ts/migrations.ts/browser-service.ts/telemetry-guard.ts/compliance-service.ts/边界与 IPC 注册模式全部实测一致；QA 场景与代码语义吻合）；依赖矩阵与波次无矛盾；护栏范围（02 六授权区）与 05:87 授权一致；结论「无阻断性问题，开发者可零面试开工」，未提任何修订。
- live 计划定稿 SHA-256 = `999b4045f7cdaedc4b3a90548cd83ba2db4c548a21b83ec24c88b8f748d2fe82`（59487 B）
