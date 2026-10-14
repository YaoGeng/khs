#!/usr/bin/env node
/**
 * probe-providers.mjs — BYOK 服务商能力探测（todo 5 / T-M0-06，Spike S4）
 *
 * 五家预设服务商（docs/01-需求说明书.md 第 126 行 FR-2.1）：deepseek / tongyi / zhipu / openai / siliconflow
 * 每家探三项能力：json_schema 结构化输出 / tool calling / embeddings。
 *
 * Key 契约（只从环境变量读取，脚本绝不打印任何 Key 值）：
 *   PROBE_<PROVIDER>_API_KEY    例：PROBE_DEEPSEEK_API_KEY
 *   PROBE_<PROVIDER>_BASE_URL   可选，缺省用下方 BASE_URLS 官方默认值
 *   PROBE_<PROVIDER>_MODEL      可选，覆盖 chat 探测用模型
 *   PROBE_<PROVIDER>_EMBEDDING_MODEL 可选，覆盖 embeddings 探测用模型
 *
 * 结果分类（每格）：
 *   probed-ok            实测通过（携带 Key 的真实 API 调用断言成功）
 *   probed-fail          实测失败（detail 给出原因：HTTP 状态/断言失败/网络错误类）
 *   documented           文档源（无 Key，采用官方文档核对结论；附带网络可达性实测）
 *   network-unreachable  网络不可达（无 Key 且连通性探测网络层失败：超时/DNS/连接拒绝等）
 *
 * 退出码语义：
 *   0 = 至少一次实测且全部实测通过
 *   1 = 存在实测失败（probed-fail，含鉴权失败与坏 base_url 场景）——报告仍会生成
 *   2 = 无任何实测发生（全无 Key 或全部文档源/网络不可达）——报告仍会生成
 *
 * 用法：
 *   node scripts/probe-providers.mjs                # 默认：报告写 scripts/probe-report.json
 *   node scripts/probe-providers.mjs --label no-key # 给报告附加运行标签（便于区分 QA 场景）
 *   node scripts/probe-providers.mjs --out <path>   # 覆盖报告输出路径
 *
 * 超时：每项探测（每 ID 每 URL）15s。探测失败不中断报告生成。
 * 报告脱敏：仅记录 keyPresent 布尔与 baseUrl 来源，绝不写入 Key 值。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 15_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** 官方默认 base_url 与探测用模型（可被 PROBE_* 环境变量覆盖） */
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    chatModel: 'deepseek-flash',
    embeddingModel: null, // 官方 API 目录未提供 /embeddings 端点
    docs: {
      json_schema: 'https://api-docs.deepseek.com/guides/json_mode',
      tool_calling: 'https://api-docs.deepseek.com/guides/tool_calls',
      embeddings: 'https://api-docs.deepseek.com/',
    },
  },
  tongyi: {
    label: '通义（阿里云百炼 compatible-mode）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'qwen-plus',
    embeddingModel: 'text-embedding-v3',
    docs: {
      json_schema: 'https://help.aliyun.com/zh/model-studio/json-mode',
      tool_calling: 'https://help.aliyun.com/zh/model-studio/tools',
      embeddings: 'https://help.aliyun.com/zh/model-studio/embedding',
    },
  },
  zhipu: {
    label: '智谱（BigModel）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatModel: 'glm-4.7-flash',
    embeddingModel: 'embedding-3',
    docs: {
      json_schema: 'https://docs.bigmodel.cn/cn/guide/capabilities/struct-output.md',
      tool_calling: 'https://docs.bigmodel.cn/cn/guide/capabilities/function-calling.md',
      embeddings: 'https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3.md',
    },
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatModel: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    docs: {
      json_schema: 'https://platform.openai.com/docs/guides/structured-outputs',
      tool_calling: 'https://platform.openai.com/docs/guides/function-calling',
      embeddings: 'https://platform.openai.com/docs/guides/embeddings',
    },
  },
  siliconflow: {
    label: '硅基流动（SiliconFlow）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    chatModel: 'Qwen/Qwen3-8B',
    embeddingModel: 'BAAI/bge-m3',
    docs: {
      json_schema: 'https://docs.siliconflow.cn/cn/userguide/guides/json-mode',
      tool_calling: 'https://docs.siliconflow.cn/cn/userguide/guides/function-calling',
      embeddings: 'https://docs.siliconflow.cn/cn/api-reference/embeddings/embeddings-post',
    },
  },
};

/** 无 Key 时落格的文档源结论（由官方文档人工核对，2026-10；详见 docs/adr/provider-matrix.md） */
const DOCUMENTED_NOTES = {
  deepseek: {
    json_schema:
      'response_format 仅承诺 json_object（提示词引导，文档自述偶发空内容）；原生 json_schema 仅存在于 tool calling 的 strict 模式（Beta，需 base_url=/beta），非 response_format',
    tool_calling: '官方文档支持 tool calls（思考模式自 V3.2 起支持）；strict 模式 Beta 可约束函数参数 schema',
    embeddings: '官方 API 目录无 /embeddings 端点——不支持嵌入',
  },
  tongyi: {
    json_schema:
      '百炼 compatible-mode 原生支持 json_schema strict（限 Qwen3.7-Plus/3.7-Flash/3.7-Max/3.8-Max/3.8-Flash 系列）；json_object 广泛支持',
    tool_calling: '官方文档支持 tools/function calling',
    embeddings: 'text-embedding-v3/v4 官方支持',
  },
  zhipu: {
    json_schema:
      'API 规范 response_format 枚举仅 text/json_object；结构化输出指南要求 schema 内嵌提示词+客户端校验（无原生 json_schema）',
    tool_calling: '官方文档支持 tools/function calling（最多 128 函数，tool_choice 仅 auto）',
    embeddings: 'embedding-3（GLM Embedding 系列）官方支持',
  },
  openai: {
    json_schema: 'Structured Outputs 原生支持 response_format json_schema（strict）；gpt-4o-mini 及以后模型',
    tool_calling: '原生支持 tools/function calling',
    embeddings: 'text-embedding-3 系列原生支持',
  },
  siliconflow: {
    json_schema: '用户指南仅承诺 response_format json_object（其平台 R1/V3 系列除外）；无原生 json_schema 档',
    tool_calling: '官方文档支持 function calling（支持模型见平台模型广场 Tools 标签）',
    embeddings: 'BAAI/bge-m3 等嵌入模型官方支持（Create Embedding API）',
  },
};

const STATUS_LABELS = {
  'probed-ok': '实测通过',
  'probed-fail': '实测失败',
  documented: '文档源',
  'network-unreachable': '网络不可达',
};

const envKey = (id, suffix) => process.env[`PROBE_${id.toUpperCase()}_${suffix}`];

/** 把 fetch/网络错误归类为可读短标签（不含任何敏感信息） */
function classifyError(err) {
  if (!err) return 'unknown';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout(15s)';
  // undici 对多地址解析会包 AggregateError（cause.errors[]），取第一个底层错误码
  const cause = err.cause?.errors?.[0] ?? err.cause ?? err;
  const code = cause.code ?? err.code;
  if (code) {
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `dns:${code}`;
    if (code === 'ECONNREFUSED') return 'conn-refused';
    if (code === 'ECONNRESET') return 'conn-reset';
    if (code === 'ETIMEDOUT') return 'conn-timeout';
    if (code.startsWith('CERT')) return `tls:${code}`;
    return code;
  }
  return cause.message?.split('\n')[0]?.slice(0, 80) || err.message?.split('\n')[0]?.slice(0, 80) || 'unknown';
}

/** 单次 fetch（15s 超时）；返回 {kind:'http',...} 或 {kind:'network', error} */
async function timedFetch(url, options = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { kind: 'http', status: res.status, ok: res.ok, ms: Date.now() - started, res };
  } catch (err) {
    return { kind: 'network', error: classifyError(err), ms: Date.now() - started };
  }
}

function cleanBaseUrl(url) {
  // 去掉 query/hash，避免把带凭证的 URL 写进报告
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '<invalid-url>';
  }
}

/** 无 Key 时的网络可达性探测：不带鉴权发一次最小请求，任何 HTTP 响应（含 401）都算可达 */
async function probeReachability(baseUrl) {
  const res = await timedFetch(`${baseUrl}/models`, { method: 'GET' });
  if (res.kind === 'http') {
    return { reachable: true, httpStatus: res.status, note: `HTTP ${res.status}（未鉴权即收到响应=网络可达）`, ms: res.ms };
  }
  return { reachable: false, note: `网络不可达：${res.error}`, ms: res.ms };
}

/** 携 Key 实测：json_schema 结构化输出 */
async function probeJsonSchema(baseUrl, apiKey, model) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'Return a JSON object with key "ok" set to true.' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'probe_schema',
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
    },
    max_tokens: 64,
    temperature: 0,
  };
  const res = await timedFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (res.kind === 'network') return { status: 'probed-fail', detail: `网络错误：${res.error}`, ms: res.ms };
  if (!res.ok) return { status: 'probed-fail', detail: `HTTP ${res.status}（json_schema 请求被拒绝）`, ms: res.ms };
  try {
    const json = await res.res.json();
    const content = json?.choices?.[0]?.message?.content ?? '';
    JSON.parse(content);
    return { status: 'probed-ok', detail: 'json_schema 请求成功且返回可解析 JSON', ms: res.ms };
  } catch (e) {
    return { status: 'probed-fail', detail: `HTTP 200 但断言失败：${e.message?.slice(0, 60)}`, ms: res.ms };
  }
}

/** 携 Key 实测：tool calling */
async function probeToolCalling(baseUrl, apiKey, model) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'What is the weather in Hangzhou right now? Use the provided tool.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_current_weather',
          description: 'Get the current weather in a given location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      },
    ],
    tool_choice: 'auto',
    max_tokens: 128,
    temperature: 0,
  };
  const res = await timedFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (res.kind === 'network') return { status: 'probed-fail', detail: `网络错误：${res.error}`, ms: res.ms };
  if (!res.ok) return { status: 'probed-fail', detail: `HTTP ${res.status}（tools 请求被拒绝）`, ms: res.ms };
  try {
    const json = await res.res.json();
    const msg = json?.choices?.[0]?.message;
    if (msg?.tool_calls?.length && msg.tool_calls[0]?.function?.name) {
      return { status: 'probed-ok', detail: `模型返回 tool_calls（${msg.tool_calls[0].function.name}）`, ms: res.ms };
    }
    return { status: 'probed-fail', detail: 'HTTP 200 但模型未发出 tool_calls', ms: res.ms };
  } catch (e) {
    return { status: 'probed-fail', detail: `HTTP 200 但断言失败：${e.message?.slice(0, 60)}`, ms: res.ms };
  }
}

/** 携 Key 实测：embeddings */
async function probeEmbeddings(baseUrl, apiKey, model) {
  const res = await timedFetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: 'capability probe' }),
  });
  if (res.kind === 'network') return { status: 'probed-fail', detail: `网络错误：${res.error}`, ms: res.ms };
  if (!res.ok) return { status: 'probed-fail', detail: `HTTP ${res.status}（embeddings 请求被拒绝）`, ms: res.ms };
  try {
    const json = await res.res.json();
    const dim = json?.data?.[0]?.embedding?.length;
    if (Number.isInteger(dim) && dim > 0) {
      return { status: 'probed-ok', detail: `embeddings 成功，维度 ${dim}`, ms: res.ms };
    }
    return { status: 'probed-fail', detail: 'HTTP 200 但响应缺 embedding 向量', ms: res.ms };
  } catch (e) {
    return { status: 'probed-fail', detail: `HTTP 200 但断言失败：${e.message?.slice(0, 60)}`, ms: res.ms };
  }
}

function truncate(s, n) {
  const line = String(s).split('\n')[0];
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

async function main() {
  const args = process.argv.slice(2);
  const labelIdx = args.indexOf('--label');
  const label = labelIdx >= 0 ? args[labelIdx + 1] : null;
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve(SCRIPT_DIR, 'probe-report.json');

  const report = {
    schema: 'probe-report/v1',
    generatedAt: new Date().toISOString(),
    label: label ?? 'default',
    timeoutMs: TIMEOUT_MS,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    envContract: 'PROBE_<PROVIDER>_API_KEY / PROBE_<PROVIDER>_BASE_URL（Key 一律不落报告）',
    providers: {},
    summary: {},
  };

  const counts = { 'probed-ok': 0, 'probed-fail': 0, documented: 0, 'network-unreachable': 0 };
  const rows = [];

  for (const [id, meta] of Object.entries(PROVIDERS)) {
    const apiKey = envKey(id, 'API_KEY');
    const envBase = envKey(id, 'BASE_URL');
    const baseUrl = envBase || meta.baseUrl;
    const provider = {
      label: meta.label,
      envKey: `PROBE_${id.toUpperCase()}_API_KEY`,
      keyPresent: Boolean(apiKey),
      baseUrl,
      baseUrlSource: envBase ? 'env' : 'default',
      capabilities: {},
    };
    report.providers[id] = provider;

    // 无 Key 时先做一次（每服务商一次的）网络可达性实测，供三格复用
    let reachability = null;
    if (!apiKey) {
      reachability = await probeReachability(baseUrl);
      provider.network = reachability;
    }

    for (const cap of ['json_schema', 'tool_calling', 'embeddings']) {
      let cell;
      if (cap === 'embeddings' && meta.embeddingModel === null) {
        // 官方无该端点：无论有无 Key 都按文档源落格（有 Key 也不打无效请求）
        cell = {
          status: 'documented',
          detail: `${DOCUMENTED_NOTES[id][cap]}（官方文档核对）`,
          docs: meta.docs[cap],
        };
      } else if (apiKey) {
        const model =
          cap === 'embeddings'
            ? envKey(id, 'EMBEDDING_MODEL') || meta.embeddingModel
            : envKey(id, 'MODEL') || meta.chatModel;
        if (cap === 'json_schema') cell = await probeJsonSchema(baseUrl, apiKey, model);
        else if (cap === 'tool_calling') cell = await probeToolCalling(baseUrl, apiKey, model);
        else cell = await probeEmbeddings(baseUrl, apiKey, model);
        cell.model = model;
        cell.docs = meta.docs[cap];
      } else if (!reachability.reachable) {
        cell = {
          status: 'network-unreachable',
          detail: `无 Key 且网络不可达（${reachability.note}）`,
          docs: meta.docs[cap],
        };
      } else {
        cell = {
          status: 'documented',
          detail: DOCUMENTED_NOTES[id][cap],
          docs: meta.docs[cap],
        };
      }
      cell.statusLabel = STATUS_LABELS[cell.status];
      provider.capabilities[cap] = cell;
      counts[cell.status] += 1;
      rows.push({
        provider: id,
        capability: cap,
        result: cell.statusLabel,
        detail: truncate(cell.detail, 64),
      });
    }
  }

  report.summary = { counts, liveProbes: counts['probed-ok'] + counts['probed-fail'] };

  // 控制台表格（无任何 Key 内容）
  console.log(`\n=== BYOK 服务商能力探测报告（label=${report.label}，超时 ${TIMEOUT_MS / 1000}s）===`);
  console.table(rows);
  console.log('汇总:', JSON.stringify(counts));
  console.log('报告已写入:', outPath);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  // 退出码语义（见文件头注释）
  if (counts['probed-fail'] > 0) process.exit(1);
  if (counts['probed-ok'] === 0) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error('probe-providers 运行异常（报告可能未生成）:', err?.message ?? err);
  process.exit(1);
});
