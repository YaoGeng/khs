# BYOK 服务商能力探测矩阵（M0 Spike S4）

> 任务：T-M0-06（计划 todo 5）· 依据：04-架构评审报告.md:59-68（S4）、05-AI开发计划与里程碑.md §7 R9（BYOK 降级链）、01-需求说明书.md:126（FR-2.1 五家预设）
> 日期：2026-10-11 · 探测脚本：packages/llm-gateway/scripts/probe-providers.mjs · 预设常量：packages/llm-gateway/src/presets.ts（与本文互链）
> 探测证据：.omo/evidence/mvp0-dev-plan/probe-report.no-key.json（M0 无 Key 脱敏存档）；**M1 更新（2026-10-13）：zhipu 携真实 Key 实测，证据 packages/llm-gateway/scripts/probe-report.json（已脱敏入库）与 .omo/evidence/m1-insight-plan/probe-report.probed.json**

## 1. 探测方法与现状

- 每服务商探三项能力：**json_schema 结构化输出**（`response_format: json_schema`）、**tool calling**、**embeddings**。
- Key 契约：`PROBE_<PROVIDER>_API_KEY` / `PROBE_<PROVIDER>_BASE_URL`（可选覆盖），只从环境变量读取；脚本任何输出（控制台/JSON）**不含 Key 值**。
- 每项探测 15s 超时；错误分类输出（dns/conn-refused/conn-reset/timeout/tls 等）；探测失败不中断报告生成。
- 结果分类：**[实测]**（携 Key 真实调用断言通过）、**[实测失败]**（携 Key 调用被拒/断言失败，报告给出原因）、**[文档]**（无 Key，按官方文档核对落格）、**[网络不可达]**（连通性探测网络层失败）。
- **当前状态（M1 更新 2026-10-13）：zhipu 已携真实 Key 实测（tool calling [实测通过]；json_schema [实测失败]：HTTP 200 但空内容；embeddings [实测失败]：HTTP 429 code 1113 测试 Key 无余额，非能力结论）→ 其余四家仍全部无 Key，维持 [文档] 或 [网络不可达]**。有 Key 复跑命令见 §5。
- M1 实测注记（2026-10-13）：用户指定 `glm5.3flash` 为 chat 探测模型——`glm5.3flash` 报 1211 模型不存在、连字符变体 `glm-5.3-flash` 报 1113 余额不足（付费模型），均不可携本 Key 实测；chat 格锚定脚本默认免费模型 `glm-4.7-flash`（免费档间歇性 1305「访问量过大」限流，负载窗口放行后取得结论）。模型 override 全程记录于 .omo/evidence/m1-insight-plan/task-1-m1-insight-plan.log。
- 网络可达性实测（无鉴权请求，HTTP 401 响应即证明网络可达，2026-10-11）：

| 服务商 | 官方默认 base_url | 可达性实测 | 时延 |
|---|---|---|---|
| deepseek | https://api.deepseek.com/v1 | ✅ HTTP 401（未鉴权响应） | 249ms |
| tongyi | https://dashscope.aliyuncs.com/compatible-mode/v1 | ✅ HTTP 401 | 189ms |
| zhipu | https://open.bigmodel.cn/api/paas/v4 | ✅ HTTP 401 | 162ms |
| openai | https://api.openai.com/v1 | ❌ UND_ERR_CONNECT_TIMEOUT（15s 无响应） | — |
| siliconflow | https://api.siliconflow.cn/v1 | ✅ HTTP 401 | 214ms |

> M1 复核（2026-10-13）：openai 无 Key 连通性复测仍 UND_ERR_CONNECT_TIMEOUT，维持 [网络不可达]。

## 2. 5×3 能力矩阵

图例：[实测]=携 Key 调用断言通过；[实测失败]=携 Key 调用被拒/断言失败；[文档]=无 Key 官方文档核对；[网络不可达]=网络层失败。M1 后 zhipu 三格为 [实测] 结论（一过两败），其余四家仍全部为 [文档]/[网络不可达]。

| 服务商 | json_schema 结构化输出 | tool calling | embeddings | 境外可达性风险 |
|---|---|---|---|---|
| **deepseek** | [文档] ❌ 仅 `json_object`（提示词引导，文档自述偶发空内容）；原生 json_schema 仅存在于 tool strict 模式（Beta，需 base_url=`/beta`），非 response_format。依据：[JSON Output](https://api-docs.deepseek.com/guides/json_mode) | [文档] ✅ tool calls 支持（思考模式自 V3.2）；strict 模式 Beta 可约束函数参数。依据：[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) | [文档] ❌ 官方 API 目录无 /embeddings 端点，不支持。依据：[API 目录](https://api-docs.deepseek.com/) | 境内（可达性实测 ✅ 401/249ms） |
| **tongyi** | [文档] ✅ compatible-mode 原生支持 `json_schema strict`——限 Qwen3.7-Plus/3.7-Flash/3.7-Max/3.8-Max/3.8-Flash 系列；json_object 广泛支持。依据：[结构化输出](https://help.aliyun.com/zh/model-studio/json-mode) | [文档] ✅ tools/function calling。依据：[工具调用](https://help.aliyun.com/zh/model-studio/tools) | [文档] ✅ text-embedding-v3/v4。依据：[向量模型](https://help.aliyun.com/zh/model-studio/embedding) | 境内（✅ 401/189ms）。注：百炼新文档主推 Workspace 域名 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，遗留 dashscope 域名仍存活（实测）；Key 按地域/工作空间隔离，跨境（新加坡地域）配置会出境 |
| **zhipu** | [实测失败]（2026-10-13，glm-4.7-flash）❌ `response_format json_schema` 请求被接受（HTTP 200/1318ms）但模型返回空内容、断言失败——无可用原生 json_schema，与文档结论一致；两个独立负载窗口结果一致。原 [文档] 结论（2026-10）：API 规范 `response_format` 枚举仅 `text|json_object`；结构化输出指南要求 schema 内嵌提示词+客户端校验。依据：[结构化输出](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output.md)、[对话补全 API](https://docs.bigmodel.cn/api-reference/模型-api/对话补全.md) | [实测通过]（2026-10-13，glm-4.7-flash）✅ 模型返回 tool_calls（get_current_weather，1562ms；当日 3 次复现）。原 [文档] 结论（2026-10）：最多 128 函数，tool_choice 仅 auto。依据：[工具调用](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling.md) | [实测失败→账号阻塞，维持文档]（2026-10-13）⚠️ HTTP 429 code 1113「余额不足或无可用资源包」（87ms）——测试 Key 无付费额度所致，**非能力否证**，维持 [文档] 待实测。原 [文档] 结论（2026-10）：embedding-3（GLM Embedding 系列）官方支持。依据：[embedding-3](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3.md) | 境内（✅ 401/162ms） |
| **openai** | [文档] ✅ Structured Outputs 原生支持 `json_schema strict`（gpt-4o-mini 及以后）；文档站自大陆直连不可达，结论经公开镜像核对。依据：[Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) | [文档] ✅ 原生支持。依据：[Function Calling](https://platform.openai.com/docs/guides/function-calling) | [文档] ✅ text-embedding-3 系列。依据：[Embeddings](https://platform.openai.com/docs/guides/embeddings) | **境外（不可达实测 ❌ UND_ERR_CONNECT_TIMEOUT）**：境内用户无可用网络路径，需自备可达网络；BYOK 界面须按 FR-2.7 标注境外 |
| **siliconflow** | [文档] ❌ 用户指南仅承诺 `json_object`（其平台 R1/V3 系列除外），无原生 json_schema 档。依据：[JSON schema 指南](https://docs.siliconflow.cn/cn/userguide/guides/json-mode) | [文档] ✅ function calling（支持模型以平台模型广场 Tools 标签为准，模型依存）。依据：[Function calling](https://docs.siliconflow.cn/cn/userguide/guides/function-calling) | [文档] ✅ BAAI/bge-m3 等（Create Embedding API）。依据：[Embedding API](https://docs.siliconflow.cn/cn/api-reference/embeddings/embeddings-post) | **境外风险（按任务卡要求标注）**：主站 api.siliconflow.cn 境内可达（✅ 401/214ms）；但平台存在面向海外的企业/私有化/网关服务入口，用户若配置国际版端点或境外托管模型则调用出境——按 FR-2.7 须在 Key 界面做境内外标注 |

诚实性说明（M1 更新 2026-10-13）：zhipu 三格已有携 Key 实测结论（tool calling [实测通过]；json_schema [实测失败] 确认不可用；embeddings 实测被测试 Key 余额阻塞，**非能力结论**，维持 [文档]）；其余四家仍为 **[文档]/[网络不可达]**。M0 的 happy QA 场景"≥1 家 [实测]"已部分满足（zhipu）。

## 3. 能力分档（R9 降级链）

### 分档判定标准

| 档位 | 判定标准 | schema 注入策略（S4 建议降级序） |
|---|---|---|
| **A** | 三项全通过：原生 json_schema strict + tool calling + embeddings | 原生 json_schema → 提示词内嵌 schema → 正则抽取兜底 |
| **B** | tool calling 可用但 json_schema 弱（仅 json_object 或需提示词内嵌 schema）；**embeddings 缺失者也落 B，但必须执行其嵌入侧降级注记** | 提示词内嵌 schema + 客户端校验 → 正则抽取兜底 |
| **C** | 仅 chat（无 tool calling；结构化输出仅靠提示词+正则兜底） | 正则抽取兜底 |

### 分档结论（zhipu 已 [实测] 背书，其余维持 [文档] 源，有 Key 后升级 [实测]）

| 服务商 | 档位 | 一句话结论 |
|---|---|---|
| tongyi | **A**（[文档]） | json_schema strict（Qwen3.7+ 系列）+ tools + 嵌入全齐，境内可达——预设模板首选档 |
| openai | **A**（[文档]） | 三项原生全支持，但境内网络不可达——能力上限最高、可达性最差 |
| deepseek | **B**（[文档]） | tool calling 强（含 strict Beta）但 response_format 无原生 json_schema，且**无 embeddings** |
| zhipu | **B**（[实测]，2026-10-13） | tools 实测通过 + json_schema 实测确认不可用（B 档判定两格均为实测结论）；embeddings 文档源（实测被测试 Key 余额阻塞，不改变 B 档判定） |
| siliconflow | **B**（[文档]） | tools（模型依存）+ bge-m3，json_schema 仅 json_object；境外配置组合有出境风险 |

降级顺序（R9，S4 原文"原生 json_schema → prompt 内嵌 schema → 正则抽取兜底"）已固化为常量 `SCHEMA_INJECTION_DEGRADATION_CHAIN`（presets.ts），M1 的 T-M1-05 按探测结果路由。**R9 约束："预设模板只承诺探测通过的能力档"——在完成 [实测] 升级前，UI 预设模板的能力承诺文案必须带"文档源，待实测"角标。**

### R9 角标解除条件（M1，2026-10-13）

供 todo 8（BYOK 预设模板）/ todo 10（能力承诺文案）消费：

1. **可解除角标的格**：该格已有携 Key 实测结论——
   - [实测通过]（probed-ok）：能力承诺可直接陈述（当前仅 zhipu tool calling）；
   - [实测失败确认]（probed-fail 且原因为**能力本身**，如 HTTP 400 参数被拒 / 断言失败）：不可用结论可直接陈述（当前为 zhipu json_schema：HTTP 200 但空内容）。
2. **不可解除角标的格**：
   - 实测被**账号/环境原因**阻塞（余额不足 1113、网络不可达等）——不构成能力否证，维持"文档源，待实测"角标（当前为 zhipu embeddings：1113 无余额）；
   - 尚无 Key 的 [文档] 格（deepseek / tongyi / siliconflow 全部格）与 [网络不可达] 格（openai 全部格）。
3. **解除动作**：UI 文案删除"文档源，待实测"角标，按格标注"实测（日期）"；对应 `presets.ts` 该格 `source` 已为 'probed'（zhipu 已于 2026-10-13 完成）。embeddings 格在获得有余额的 Key 复测通过前，**不得**解除角标或升 source。
4. **默认档候选依据（ADR-7）**：zhipu 本次实测由用户指定 zhipu Key 完成（用户意向=首选实测对象），其实测结论（tool calling 可用、结构化输出需降级链、嵌入待实测）作为 ADR-7 默认档候选的输入之一。

## 4. 不利结论 fallback 分支（IS-5）

### 4.1 全部无 Key 时的处理（M0 触发的分支；**2026-10-13 起部分解除：zhipu 已实测**）

1. **文档源兜底（已生效）**：本矩阵 15 格全部落 [文档] 结论并附官方文档链接，能力分档与降级链照常输出——M1 的 T-M1-05/T-M1-01 有可用输入（05:87,91），不被探测阻塞。
2. **升级发起人申请测试 Key（部分完成）**：用户于 2026-10-13 提供 **zhipu** 真实 Key（用户指定 zhipu 为首选实测对象，该意向作为 ADR-7 默认档候选依据），已携 Key 复跑并把 zhipu 档位从 [文档] 升级为 [实测]（tool calling/json_schema 两格为实测结论；embeddings 因 Key 无余额阻塞，维持 [文档]，见 §3 角标解除条件）。其余四家仍待 Key。
3. **网络不可达者（openai）不阻塞**：境内网络路径实测不可达（2026-10-13 无 Key 复测仍 UND_ERR_CONNECT_TIMEOUT），属环境事实而非配置问题；若发起人可提供境外网络环境再补 [实测]，否则维持 [文档]+境外风险标注。

### 4.2 本地嵌入缓存表设计注记（sqlite-vec 场景，02:143 §3.1；M1 实现本注记，M0 不实现）

嵌入能力缺失或成本敏感时（ADR-7 降级链的"样本不足或接口不可用"分支），本地嵌入缓存避免对同一文本重复调用：

```sql
-- 元数据表（普通表，drizzle 迁移链管理）
CREATE TABLE embeddings_cache (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,        -- 服务商标识（presets.ts ProviderId）
  model TEXT NOT NULL,           -- 嵌入模型名（如 BAAI/bge-m3）
  input_sha256 TEXT NOT NULL,    -- 输入文本哈希（去重键；不含原文，隐私友好）
  dim INTEGER NOT NULL,          -- 向量维度（决定写入哪张 vec0 分表）
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_emb ON embeddings_cache(provider, model, input_sha256);

-- 向量表（sqlite-vec；按 dim 分表，见下注）
CREATE VIRTUAL TABLE embeddings_vec_1024 USING vec0(embedding float[1024]);
```

- **命中路径**：`(provider, model, input_sha256)` 查 metadata → 得 rowid → 直接用 rowid 参与 KNN（`WHERE embedding MATCH ? AND rowid IN (...)`）或取回向量。
- **KNN 路径**：`SELECT rowid, distance FROM embeddings_vec_N WHERE embedding MATCH ? LIMIT k` → 反查 metadata 展示原文引用。
- **维度处理**：vec0 每表维度固定且建表后不可改。预设模型维度不同（bge-m3=1024、zhipu embedding-3=2048、openai v3-small=1536）→ 按 `dim` 分表（表名后缀），或 ADR-7 若锁定单一默认嵌入模型则单表即可——**M1 的 T-M1-05/T-M1-01 决策点**。
- **rowid 陷阱（实测发现，见 sqlite-vec-packaging-validation.md）**：better-sqlite3 将 JS number 绑定为 REAL，vec0 拒绝 REAL rowid——显式 rowid 必须传 `BigInt` 或用 SQL 字面量。
- 保留策略：`last_used_at` 超过 N 天清理（对齐 FR-10.3 本地保留期口径，N 由 M1 定）。

## 5. 复跑与升级流程

```bash
# 无 Key（当前态）：退出码 0=全实测通过 / 1=存在实测失败 / 2=无实测（全文档源或不可达）
pnpm --filter @xinglian/llm-gateway exec node scripts/probe-providers.mjs --label no-key

# 有 Key（升级 [实测]，示例）：
PROBE_TONGYI_API_KEY=sk-xxx pnpm --filter @xinglian/llm-gateway exec node scripts/probe-providers.mjs --label live-tongyi
# 可选：PROBE_<ID>_BASE_URL 覆盖官方默认；PROBE_<ID>_MODEL / PROBE_<ID>_EMBEDDING_MODEL 覆盖探测模型

# failure QA（已演练）：错误 base_url / 错误 Key → 退出码 1，报告逐格给原因（conn-refused / HTTP 401）
```

### M1 复跑记录（2026-10-13，zhipu）

```bash
# 密钥从 .omo/secrets/probe-keys.env 以 PROBE_ZHIPU_API_KEY 注入本进程环境（不入库不入日志）
node scripts/probe-providers.mjs --label probed-zhipu   # 退出码 1（存在 probed-fail，见下）
```

- 用户指定 chat 模型 `glm5.3flash`：HTTP 400 code **1211「模型不存在」**；连字符变体 `glm-5.3-flash`：HTTP 429 code **1113「余额不足或无可用资源包」**（付费模型，本 Key 无额度）——两个拼写均不可携本 Key 实测，chat 格锚定脚本默认 `glm-4.7-flash`（免费档间歇性 1305「访问量过大」限流，负载窗口放行后取得结论）。
- 实测结论：tool calling [实测通过]（1562ms，当日 3 次复现）；json_schema [实测失败]（HTTP 200 但空内容，1318ms，两个独立窗口一致）；embeddings [实测失败]（HTTP 429/1113 无余额，87ms，**非能力否证**）。
- 免费档 glm-4.7-flash 的 429 均为 1305 服务端容量限流（读错误响应体核实），等待负载窗口即可放行；embeddings 的 429 为 1113 账号无余额，等待无法解除，需充值后复测。
- 全部尝试（含失败轮）与模型 override 注记：.omo/evidence/m1-insight-plan/task-1-m1-insight-plan.log。

升级规则：某格出现 [实测] 结论后，同步更新 `packages/llm-gateway/src/presets.ts` 中该格 `source:'probed'` 与档位（如实测推翻文档结论），并在本矩阵该格补实测证据行（HTTP 状态/时延/日期），保留原 [文档] 结论作历史。探测失败分支持有的错误分类清单见脚本头注释。

## 6. 下游引用

- `packages/llm-gateway/src/presets.ts`：`PROVIDER_CAPABILITY_PRESETS`（五家×档位×来源标注）、`SCHEMA_INJECTION_DEGRADATION_CHAIN`（R9 降级序）、`schemaInjectionForTier()`（档位→策略静态映射）——**M0 内下游引用凭证（IS-5）**，单测 `src/presets.test.ts` 守护。
- M1：T-M1-05（报告 Agent 按探测结果路由）、T-M1-01（ADR-7 嵌入来源）、T-M1-08（BYOK 界面境内外标注，本矩阵风险列是数据源）。
- 探测报告 `scripts/probe-report.json`（已脱敏：仅 keyPresent 布尔，无 Key 值）自 M1（2026-10-13）起脱敏入库；历史脱敏存档：`.omo/evidence/mvp0-dev-plan/probe-report.no-key.json`（M0 无 Key）与 `.omo/evidence/m1-insight-plan/probe-report.probed.json`（M1 携 Key）。
