# packages/llm-gateway — BYOK LLM 网关

## OVERVIEW

用户自购 Key（BYOK）直连 LLM 供应商的网关：OpenAI 兼容调用链 + 供应商能力分档（A/B/C）+ 出站脱敏（作者假名化）。平台不转售、不经手、不上传用户 Key。

## STRUCTURE

```
src/
├── gateway.ts     # LlmGateway：OpenAI 兼容调用链
├── presets.ts     # PROVIDER_IDS(deepseek/tongyi/zhipu/openai/siliconflow)、
│                  #   PROVIDER_CAPABILITY_PRESETS、SCHEMA_INJECTION_DEGRADATION_CHAIN、schemaInjectionForTier
├── deidentify.ts  # pseudonymizeAuthor/deidentifyAuthor/deidentifyNoteForPayload（粉丝分桶+假名盐）
├── embeddings.ts  # 向量出口（选型见 docs/adr/ADR-7-embedding-source.md）
├── json.ts / structured.ts   # json_schema 解析与注入降级
└── types.ts
scripts/probe-providers.mjs   # 5 家能力探测(json_schema/tool_calling/embeddings) → probe-report.json
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| 新增供应商 | presets.ts（PROVIDER_IDS + 预设）+ docs/adr/provider-matrix.md 同步 | probe 脚本实测验证 |
| 调 schema 注入降级链 | presets.ts SCHEMA_INJECTION_DEGRADATION_CHAIN | 档位→策略映射 schemaInjectionForTier |
| 脱敏口径 | deidentify.ts | 出站 payload 必经 |
| 真机预算验证 | packages/agents/scripts/realrun-report.mjs | ≤15 请求硬上限；密钥 .omo/secrets/probe-keys.env |

## CONVENTIONS

- 能力结论必须带出处三态之一：`'documented' | 'probed' | 'network-unreachable'`（PresetSource），不凭印象定档。
- 只在主进程组合根装配（apps/desktop 主进程侧），渲染层经 IPC 间接使用。

## ANTI-PATTERNS

- 把 Key 写进日志/遥测/错误消息。
- 无 probe 或文档证据就改能力档位。
- 出站 payload 绕过 deidentify。
