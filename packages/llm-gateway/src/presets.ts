/**
 * BYOK 能力分档预设（todo 5 / T-M0-06，Spike S4 + 05 §7 R9 降级链）。
 *
 * 与 docs/adr/provider-matrix.md 互链：本文件的每个分档/每格来源都由该矩阵文档
 * 背书；矩阵的每格标注 [实测/文档/网络不可达] 与本文件 PresetSource 一一对应。
 * 探测证据：packages/llm-gateway/scripts/probe-report.json（已脱敏入库）、
 * 脱敏存档 .omo/evidence/mvp0-dev-plan/probe-report.no-key.json（M0 无 Key）与
 * .omo/evidence/m1-insight-plan/probe-report.probed.json（M1 携 Key 实测）。
 *
 * R9（05-AI开发计划与里程碑.md §7）："M0 探测矩阵 + 降级链；预设模板只承诺探测通过的能力档"
 * ——2026-10-13 zhipu 已携测试 Key 实测（tool calling 通过；json_schema 实测确认不可用；
 * embeddings 因测试 Key 无余额未获能力结论，维持文档源），其余四家仍为「文档源」结论，
 * 有 Key 复跑探测脚本后应将对应档位升级为 'probed'（或降级为 'network-unreachable'）。
 *
 * 分档判定标准（与矩阵文档一致）：
 *   A = 三项全通过（原生 json_schema / tool calling / embeddings）
 *   B = tool calling 可用但 json_schema 弱（仅 json_object 或需提示词内嵌 schema）；
 *       embeddings 缺失者也落 B，但必须依赖其 degradeNote 做嵌入侧降级
 *   C = 仅 chat（无 tool calling，结构化输出仅靠提示词+正则兜底）
 *
 * 不实现真实 LLM 调用链（M1 的 T-M1-05/T-M1-01 消费本预设，05:87,91）。
 */

export type CapabilityTier = 'A' | 'B' | 'C';

/** 逐档来源：documented=官方文档核对；probed=携 Key 实测；network-unreachable=网络不可达 */
export type PresetSource = 'documented' | 'probed' | 'network-unreachable';

export const PROVIDER_IDS = ['deepseek', 'tongyi', 'zhipu', 'openai', 'siliconflow'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const CAPABILITY_KEYS = ['json_schema', 'tool_calling', 'embeddings'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** 境外可达性风险（FR-2.7 界面境内外标注的数据来源） */
export type ReachabilityClass = 'domestic-ok' | 'overseas-risk' | 'mixed';

export interface CapabilityCell {
  /** 该能力是否可用；null=不确定（需携 Key 实测后回填） */
  supported: boolean | null;
  source: PresetSource;
  /** 文档核对/实测结论一句话 */
  note: string;
  /** 官方文档依据链接 */
  docUrl: string;
}

export interface ProviderCapabilityPreset {
  id: ProviderId;
  label: string;
  /** OpenAI 兼容 base_url 官方默认（可被用户配置覆盖，FR-2.1） */
  baseUrl: string;
  tier: CapabilityTier;
  tierSource: PresetSource;
  capabilities: Record<CapabilityKey, CapabilityCell>;
  reachability: ReachabilityClass;
  /** 该档位的 schema 注入降级策略提示（S4 降级链落位） */
  degradeNote: string;
}

const MATRIX_DOC = 'docs/adr/provider-matrix.md';

export const PROVIDER_CAPABILITY_PRESETS: Record<ProviderId, ProviderCapabilityPreset> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    tier: 'B',
    tierSource: 'documented',
    capabilities: {
      json_schema: {
        supported: false,
        source: 'documented',
        note: 'response_format 仅 json_object（提示词引导）；原生 json_schema 仅在 tool strict 模式（Beta，base_url=/beta）',
        docUrl: 'https://api-docs.deepseek.com/guides/json_mode',
      },
      tool_calling: {
        supported: true,
        source: 'documented',
        note: 'tool calls 官方支持（思考模式自 V3.2）；strict 模式 Beta 可约束函数参数 schema',
        docUrl: 'https://api-docs.deepseek.com/guides/tool_calls',
      },
      embeddings: {
        supported: false,
        source: 'documented',
        note: '官方 API 目录无 /embeddings 端点——嵌入需换服务商或走统计聚类降级',
        docUrl: 'https://api-docs.deepseek.com/',
      },
    },
    reachability: 'domestic-ok',
    degradeNote: '结构化输出：json_object + 提示词内嵌 schema + 正则/校验兜底；嵌入：改用其他 A 档服务商或统计聚类（对齐 ADR-7 降级链）',
  },
  tongyi: {
    id: 'tongyi',
    label: '通义（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    tier: 'A',
    tierSource: 'documented',
    capabilities: {
      json_schema: {
        supported: true,
        source: 'documented',
        note: 'compatible-mode 原生支持 json_schema strict（限 Qwen3.7-Plus/3.7-Flash/3.7-Max/3.8-Max/3.8-Flash 系列）',
        docUrl: 'https://help.aliyun.com/zh/model-studio/json-mode',
      },
      tool_calling: {
        supported: true,
        source: 'documented',
        note: 'tools/function calling 官方支持',
        docUrl: 'https://help.aliyun.com/zh/model-studio/tools',
      },
      embeddings: {
        supported: true,
        source: 'documented',
        note: 'text-embedding-v3/v4 官方支持',
        docUrl: 'https://help.aliyun.com/zh/model-studio/embedding',
      },
    },
    reachability: 'domestic-ok',
    degradeNote: 'A 档直用；注意 json_schema 模式需选用 Qwen3.7+ 系列模型，旧系列自动落 json_object 档',
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱（BigModel）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    tier: 'B',
    tierSource: 'probed',
    capabilities: {
      json_schema: {
        supported: false,
        source: 'probed',
        note: '[实测 2026-10-13] response_format json_schema 请求被接受（HTTP 200）但模型返回空内容、断言失败——无可用原生 json_schema，维持 json_object+提示词内嵌 schema 结论（glm-4.7-flash，两个独立窗口结果一致）',
        docUrl: 'https://docs.bigmodel.cn/cn/guide/capabilities/struct-output.md',
      },
      tool_calling: {
        supported: true,
        source: 'probed',
        note: '[实测 2026-10-13] glm-4.7-flash 实测返回 tool_calls（get_current_weather），通过；官方文档：最多 128 函数，tool_choice 仅 auto',
        docUrl: 'https://docs.bigmodel.cn/cn/guide/capabilities/function-calling.md',
      },
      embeddings: {
        supported: true,
        source: 'documented',
        note: 'embedding-3（GLM Embedding 系列）官方支持；2026-10-13 携 Key 实测因测试 Key 无余额（HTTP 429 code 1113）未获能力结论，维持文档源待实测',
        docUrl: 'https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3.md',
      },
    },
    reachability: 'domestic-ok',
    degradeNote: '结构化输出：json_object + 提示词内嵌 schema + 客户端校验兜底；嵌入与工具调用可直用',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    tier: 'A',
    tierSource: 'documented',
    capabilities: {
      json_schema: {
        supported: true,
        source: 'documented',
        note: 'Structured Outputs 原生支持 response_format json_schema（strict），gpt-4o-mini 及以后模型',
        docUrl: 'https://platform.openai.com/docs/guides/structured-outputs',
      },
      tool_calling: {
        supported: true,
        source: 'documented',
        note: 'tools/function calling 原生支持',
        docUrl: 'https://platform.openai.com/docs/guides/function-calling',
      },
      embeddings: {
        supported: true,
        source: 'documented',
        note: 'text-embedding-3 系列原生支持',
        docUrl: 'https://platform.openai.com/docs/guides/embeddings',
      },
    },
    reachability: 'overseas-risk',
    degradeNote: 'A 档能力但 api.openai.com 自中国大陆网络实测不可达（探测报告 network-unreachable）；境内用户需自备可达网络或代理，BYOK 界面须按 FR-2.7 标注境外',
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动（SiliconFlow）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    tier: 'B',
    tierSource: 'documented',
    capabilities: {
      json_schema: {
        supported: false,
        source: 'documented',
        note: '用户指南仅承诺 response_format json_object（其平台 R1/V3 系列除外），无原生 json_schema 档',
        docUrl: 'https://docs.siliconflow.cn/cn/userguide/guides/json-mode',
      },
      tool_calling: {
        supported: true,
        source: 'documented',
        note: 'function calling 官方支持（支持模型以平台模型广场 Tools 标签为准）',
        docUrl: 'https://docs.siliconflow.cn/cn/userguide/guides/function-calling',
      },
      embeddings: {
        supported: true,
        source: 'documented',
        note: 'BAAI/bge-m3 等嵌入模型官方支持（Create Embedding API）',
        docUrl: 'https://docs.siliconflow.cn/cn/api-reference/embeddings/embeddings-post',
      },
    },
    reachability: 'mixed',
    degradeNote: '结构化输出：json_object + 提示词内嵌 schema + 校验兜底；工具调用模型依存（选型时核对模型广场）；嵌入可直用',
  },
};

/** 矩阵文档路径（供下游与 UI 文案引用，保持互链单一事实源） */
export const PROVIDER_MATRIX_DOC_PATH = MATRIX_DOC;

/** R9 降级链（S4 建议的 schema 注入降级顺序），供 M1 llm-gateway 实现对齐 */
export const SCHEMA_INJECTION_DEGRADATION_CHAIN = [
  'native-json_schema',
  'prompt-embedded-schema',
  'regex-extraction-fallback',
] as const;

export type SchemaInjectionStrategy = (typeof SCHEMA_INJECTION_DEGRADATION_CHAIN)[number];

/** 按档位给出 M1 应采用的 schema 注入策略（R9 降级链的静态映射） */
export function schemaInjectionForTier(tier: CapabilityTier): SchemaInjectionStrategy[] {
  switch (tier) {
    case 'A':
      return ['native-json_schema', 'prompt-embedded-schema', 'regex-extraction-fallback'];
    case 'B':
      return ['prompt-embedded-schema', 'regex-extraction-fallback'];
    case 'C':
      return ['regex-extraction-fallback'];
  }
}
