import { describe, it, expect } from 'vitest';
import {
  PROVIDER_CAPABILITY_PRESETS,
  PROVIDER_IDS,
  CAPABILITY_KEYS,
  PROVIDER_MATRIX_DOC_PATH,
  SCHEMA_INJECTION_DEGRADATION_CHAIN,
  schemaInjectionForTier,
  type PresetSource,
  type CapabilityTier,
  type CapabilityKey,
} from './presets.js';

const ALL_SOURCES: PresetSource[] = ['documented', 'probed', 'network-unreachable'];
const ALL_TIERS: CapabilityTier[] = ['A', 'B', 'C'];

describe('PROVIDER_CAPABILITY_PRESETS（todo 5 / T-M0-06）', () => {
  it('五家预设服务商都在（01:126 FR-2.1）', () => {
    expect(Object.keys(PROVIDER_CAPABILITY_PRESETS).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(PROVIDER_IDS).toEqual(['deepseek', 'tongyi', 'zhipu', 'openai', 'siliconflow']);
  });

  it('每家的分档合法且带来源标注字段（tierSource ∈ documented|probed|network-unreachable）', () => {
    for (const id of PROVIDER_IDS) {
      const preset = PROVIDER_CAPABILITY_PRESETS[id];
      expect(ALL_TIERS).toContain(preset.tier);
      expect(ALL_SOURCES).toContain(preset.tierSource);
      expect(typeof preset.degradeNote).toBe('string');
      expect(preset.degradeNote.length).toBeGreaterThan(0);
    }
  });

  it('每家三项能力格齐全且每格有来源标注与依据链接', () => {
    for (const id of PROVIDER_IDS) {
      const preset = PROVIDER_CAPABILITY_PRESETS[id];
      expect(Object.keys(preset.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
      for (const cap of CAPABILITY_KEYS as readonly CapabilityKey[]) {
        const cell = preset.capabilities[cap];
        expect(ALL_SOURCES).toContain(cell.source);
        expect(cell.docUrl.startsWith('https://')).toBe(true);
        expect(cell.note.length).toBeGreaterThan(0);
        expect(typeof cell.supported === 'boolean' || cell.supported === null).toBe(true);
      }
    }
  });

  it('与 docs/adr/provider-matrix.md 互链（矩阵路径常量指向该文档）', () => {
    expect(PROVIDER_MATRIX_DOC_PATH).toBe('docs/adr/provider-matrix.md');
  });

  it('R9 降级链常量与分档映射符合 S4 降级顺序', () => {
    expect(SCHEMA_INJECTION_DEGRADATION_CHAIN).toEqual([
      'native-json_schema',
      'prompt-embedded-schema',
      'regex-extraction-fallback',
    ]);
    expect(schemaInjectionForTier('A')).toEqual([...SCHEMA_INJECTION_DEGRADATION_CHAIN]);
    expect(schemaInjectionForTier('B')).toEqual(['prompt-embedded-schema', 'regex-extraction-fallback']);
    expect(schemaInjectionForTier('C')).toEqual(['regex-extraction-fallback']);
  });

  it('A 档（tongyi/openai）三项 supported；B 档 json_schema 弱；deepseek 嵌入缺失被显式标注', () => {
    const { tongyi, openai, deepseek, zhipu, siliconflow } = PROVIDER_CAPABILITY_PRESETS;
    expect(tongyi.tier).toBe('A');
    expect(openai.tier).toBe('A');
    for (const cap of CAPABILITY_KEYS) {
      expect(tongyi.capabilities[cap].supported).toBe(true);
      expect(openai.capabilities[cap].supported).toBe(true);
    }
    for (const b of [deepseek, zhipu, siliconflow]) {
      expect(b.tier).toBe('B');
      expect(b.capabilities.json_schema.supported).toBe(false);
      expect(b.capabilities.tool_calling.supported).toBe(true);
    }
    expect(deepseek.capabilities.embeddings.supported).toBe(false);
    expect(deepseek.capabilities.embeddings.note).toContain('/embeddings 端点');
  });

  it('境外可达性风险标注：openai=overseas-risk，siliconflow 主站境内可达（mixed）', () => {
    expect(PROVIDER_CAPABILITY_PRESETS.openai.reachability).toBe('overseas-risk');
    expect(PROVIDER_CAPABILITY_PRESETS.siliconflow.reachability).toBe('mixed');
    for (const domestic of ['deepseek', 'tongyi', 'zhipu'] as const) {
      expect(PROVIDER_CAPABILITY_PRESETS[domestic].reachability).toBe('domestic-ok');
    }
  });

  it('分档来源现状（2026-10-13 M1 携 Key 实测后）：zhipu=probed，其余四家维持 documented', () => {
    expect(PROVIDER_CAPABILITY_PRESETS.zhipu.tierSource).toBe('probed');
    for (const id of ['deepseek', 'tongyi', 'openai', 'siliconflow'] as const) {
      expect(PROVIDER_CAPABILITY_PRESETS[id].tierSource).toBe('documented');
    }
  });

  it('zhipu 实测结论与 probe-report.probed.json 逐格一致（硬编码防回归漂移，2026-10-13）', () => {
    const zhipu = PROVIDER_CAPABILITY_PRESETS.zhipu;
    expect(zhipu.capabilities.json_schema.supported).toBe(false);
    expect(zhipu.capabilities.json_schema.source).toBe('probed');
    expect(zhipu.capabilities.json_schema.note).toContain('[实测 2026-10-13]');
    expect(zhipu.capabilities.json_schema.note).toContain('空内容');
    expect(zhipu.capabilities.tool_calling.supported).toBe(true);
    expect(zhipu.capabilities.tool_calling.source).toBe('probed');
    expect(zhipu.capabilities.tool_calling.note).toContain('[实测 2026-10-13]');
    expect(zhipu.capabilities.tool_calling.note).toContain('tool_calls');
    // embeddings 的 probed-fail 系测试 Key 无余额（1113）所致，非能力否证——勿据此把该格改为 probed
    expect(zhipu.capabilities.embeddings.supported).toBe(true);
    expect(zhipu.capabilities.embeddings.source).toBe('documented');
    expect(zhipu.capabilities.embeddings.note).toContain('1113');
    expect(zhipu.capabilities.embeddings.note).toContain('文档源待实测');
  });
});
