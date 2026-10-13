#!/usr/bin/env node
/**
 * realrun-report.mjs — todo 8 ③：M1 真实 LLM 端到端验证轮（用户决策 D11）。
 *
 * 密钥契约：.omo/secrets/probe-keys.env 的 M1_REALRUN_BASE_URL / M1_REALRUN_MODEL / M1_REALRUN_API_KEY
 * （解析后注入 process.env；绝不打印 Key、绝不写入任何文件；日志提及一律掩码为 m1_realrun_****）。
 *
 * 网关形态（ADR-7 §4 附注）：用户 BYOK 自定义 base_url 网关（openai SDK 指向自定义 base_url），
 * 不属矩阵五预设、不新增预设；能力档未知 → 结构化输出走 prompt-embedded 档（zhipu B 档同款语义）。
 * 服务端要求 coding-agent 流量形态：自定义 User-Agent + 稳定 x-opencode-session 头（官方文档要求）。
 *
 * 礼貌预算：免费模型，目标 8 次请求（八章各 1 次）；纠偏重试上限 1 次；传输层不重试；
 * 结束后断言总请求 ≤15，超出以退出码 2 报告。
 *
 * 用法：pnpm --filter @xinglian/agents build && node scripts/realrun-report.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmGateway } from '@xinglian/llm-gateway';
import { generateReport, M1_FIXTURE_NOTES, M1_FIXTURE_TOPIC } from '../dist/index.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');
const ENV_FILE = resolve(REPO_ROOT, '.omo', 'secrets', 'probe-keys.env');
const EVIDENCE_DIR = resolve(REPO_ROOT, '.omo', 'evidence', 'm1-insight-plan');
const REPORT_SAMPLE = resolve(EVIDENCE_DIR, 'report-sample.md');
const MAX_TOTAL_REQUESTS = 15;
/**
 * max_tokens=8192：M1_REALRUN 模型（longcat-2.5-preview-free）为推理型——思考 token 计入
 * completion 配额（实测 578-2048+ reasoning tokens）；max_tokens=2048 时 reasoning 耗尽配额、
 * content 为空（finish_reason=length）。桌面组合根配置 BYOK 预设时同理（todo-10 消费口径）。
 */
const REALRUN_MAX_TOKENS = 8192;

/** 解析 env 文件（KEY=VALUE，跳过注释/空行）；缺失键报错；值永不回显 */
function loadEnvFile(path) {
  const raw = readFileSync(path, 'utf8');
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

function requiredEnv(values, key) {
  const value = values[key];
  if (!value) {
    console.error(`[realrun] 缺少必需环境变量 ${key}（文件：.omo/secrets/probe-keys.env）`);
    process.exit(1);
  }
  return value;
}

/** 退出码经 exitCode + 兜底定时器返回（Windows + undici 在活动句柄上直接 process.exit 会触发 libuv 断言崩溃） */
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 10_000).unref();
}

async function run() {
  const env = loadEnvFile(ENV_FILE);
  const baseUrl = requiredEnv(env, 'M1_REALRUN_BASE_URL');
  const model = requiredEnv(env, 'M1_REALRUN_MODEL');
  const apiKey = requiredEnv(env, 'M1_REALRUN_API_KEY');
  process.env.M1_REALRUN_BASE_URL = baseUrl;
  process.env.M1_REALRUN_MODEL = model;
  process.env.M1_REALRUN_API_KEY = apiKey; // 仅内存传递；组合根同款语义，绝不落日志

  const providerId = 'opencode-go-custom';
  let httpRequests = 0;
  const gateway = new LlmGateway({
    provider: providerId,
    baseUrl,
    apiKey,
    model,
    strategies: ['prompt-embedded-schema'],
    maxRetries: 0,
    timeoutMs: 180_000,
    maxTokens: REALRUN_MAX_TOKENS,
    temperature: 0.2,
    headers: {
      'User-Agent': 'khs-m1-report-agent/0.1',
      'x-opencode-session': 'khs-m1-report-agent-todo8-e2e',
    },
    sink: async () => {
      httpRequests += 1;
    },
  });

  const kv = new Map();
  const emitted = [];
  const startedAt = new Date().toISOString();
  console.log(`[realrun] 开始：provider=${providerId} model=${model} base_url=${baseUrl}`);
  console.log('[realrun] key 掩码：m1_realrun_****（不打印、不入库）');

  const outcome = await generateReport(
    {
      structured: gateway.structured.bind(gateway),
      store: {
        insertReport: async (input) => {
          console.log(`[realrun] reports 落库模拟：topic=${input.topic} token_cost=${input.tokenCost}`);
          return { id: 1 };
        },
      },
      kv: {
        get: async (key) => kv.get(key) ?? null,
        set: async (key, value) => {
          kv.set(key, value);
        },
      },
      telemetry: {
        emit: (kind, payload) => {
          emitted.push({ kind, payload });
          console.log(`[realrun] 遥测：${kind}`);
        },
      },
    },
    {
      topic: M1_FIXTURE_TOPIC,
      notes: M1_FIXTURE_NOTES,
      model,
      salt: 'm1-realrun-local-salt',
      seed: 20261013,
      maxCorrectionRetries: 1,
    },
  );

  const finishedAt = new Date().toISOString();
  if (outcome.status === 'failed') {
    console.log(`[realrun] 结果=failed chapter=${outcome.chapter} requests=${httpRequests}`);
    console.log(`[realrun] 原因=${outcome.reason}`);
    return 1;
  }

  console.log(`[realrun] 结果=completed report_id=${outcome.reportId} cluster=${outcome.clusterRoute}（K=${outcome.clusterK}）`);
  console.log(`[realrun] LLM 请求次数=${httpRequests} tokens_in=${outcome.tokensIn} tokens_out=${outcome.tokensOut}`);

  const sampleMd = [
    '<!-- M1 真实样例报告（todo 8 ③）：本文件为 LLM 真实输出，密钥绝不出现于此 -->',
    `> 生成窗口：${startedAt} ~ ${finishedAt}`,
    `> 网关：${providerId}（自定义 base_url，ADR-7 §4 附注，非五预设） · base_url：${baseUrl}`,
    `> 模型：${model} · 结构化输出档：prompt-embedded-schema（B 档语义）`,
    `> 聚类路线：${outcome.clusterRoute}（K=${outcome.clusterK}，ADR-7 降级链；M1 主路线=统计聚类）`,
    `> LLM 请求次数：${httpRequests}（礼貌预算 ≤${MAX_TOTAL_REQUESTS}） · tokens：输入 ${outcome.tokensIn} / 输出 ${outcome.tokensOut}`,
    `> 遥测：${emitted.map((e) => e.kind).join('、') || '（无）'}`,
    '',
    outcome.contentMd,
    '',
  ].join('\n');
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(REPORT_SAMPLE, sampleMd, 'utf8');
  console.log(`[realrun] 样例报告已写入：.omo/evidence/m1-insight-plan/report-sample.md`);

  if (httpRequests > MAX_TOTAL_REQUESTS) {
    console.log(`[realrun] 超出礼貌预算（${httpRequests} > ${MAX_TOTAL_REQUESTS}），退出码 2`);
    return 2;
  }
  return 0;
}

run()
  .then((code) => finish(code))
  .catch((err) => {
    console.error(`[realrun] 异常退出：${err instanceof Error ? err.message : err}`);
    finish(1);
  });
