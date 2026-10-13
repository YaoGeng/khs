/**
 * 词库配置包契约单测（m1 todo 10 = T-M1-08②）：合法包通过、坏 semver/坏正则/重复 id 拒绝、
 * manifest sha256 形态、semver 排序。
 */
import { describe, expect, it } from 'vitest';
import {
  WORDLIST_PATTERN_FLAGS,
  WordlistConfigSchema,
  WordlistManifestSchema,
  compareWordlistVersions,
  type WordlistConfigInput,
} from './wordlist.js';

function baseConfig(overrides: Partial<WordlistConfigInput> = {}): WordlistConfigInput {
  return {
    kind: 'wordlist',
    version: '1.0.0',
    effectiveAt: '2026-10-14T00:00:00.000Z',
    extremeTerms: [
      { term: '最好', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    ],
    redirectPatterns: [
      {
        id: 'phone-direct',
        label: '手机号明文',
        pattern: '1[3-9]\\d{9}',
        appliesTo: ['copy', 'comment'],
        source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1', line: 138 },
      },
    ],
    categoryBlacklist: [
      {
        id: 'medical-cosmetic',
        label: '医美整形',
        keywords: ['医美'],
        source: { doc: '08-参考-小红书社区规范.md', clause: '3.1.3', line: 132 },
      },
    ],
    ...overrides,
  };
}

describe('WordlistConfigSchema（词库配置包契约）', () => {
  it('合法包通过解析且类型收窄', () => {
    const parsed = WordlistConfigSchema.parse(baseConfig());
    expect(parsed.kind).toBe('wordlist');
    expect(parsed.extremeTerms[0]?.source.clause).toBe('§5.5-1');
  });

  it('version 非 semver 拒绝', () => {
    const result = WordlistConfigSchema.safeParse(baseConfig({ version: 'v1' }));
    expect(result.success).toBe(false);
  });

  it('pattern 不可编译拒绝（加载期校验前置，纯数据安全边界）', () => {
    const result = WordlistConfigSchema.safeParse(
      baseConfig({
        redirectPatterns: [
          {
            id: 'broken',
            label: '坏正则',
            pattern: '([unclosed',
            appliesTo: ['copy'],
            source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1' },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('正则不可编译');
    }
  });

  it('pattern 编译 flags 含 u（\\p 码点类可用）且 redirectPatterns.id 重复拒绝', () => {
    expect(WORDLIST_PATTERN_FLAGS).toContain('u');
    const dup = baseConfig({
      redirectPatterns: [
        {
          id: 'same',
          label: 'a',
          pattern: 'x',
          appliesTo: ['copy'],
          source: { doc: 'd', clause: 'c' },
        },
        {
          id: 'same',
          label: 'b',
          pattern: 'y',
          appliesTo: ['comment'],
          source: { doc: 'd', clause: 'c' },
        },
      ],
    });
    expect(WordlistConfigSchema.safeParse(dup).success).toBe(false);
  });

  it('未知字段拒绝（strict）且类目黑名单 id 重复拒绝', () => {
    const withUnknown = baseConfig() as Record<string, unknown>;
    withUnknown['evil'] = 'js?';
    expect(WordlistConfigSchema.safeParse(withUnknown).success).toBe(false);

    const dupBlacklist = baseConfig({
      categoryBlacklist: [
        { id: 'prohibited-items', label: 'a', keywords: ['x'], source: { doc: 'd', clause: 'c' } },
        { id: 'prohibited-items', label: 'b', keywords: ['y'], source: { doc: 'd', clause: 'c' } },
      ],
    });
    expect(WordlistConfigSchema.safeParse(dupBlacklist).success).toBe(false);
  });

  it('manifest：sha256 必须 64 hex；semver 比较器单调', () => {
    expect(WordlistManifestSchema.safeParse({ version: '1.0.0', sha256: 'zz', effectiveAt: 'x' }).success).toBe(false);
    expect(
      WordlistManifestSchema.safeParse({ version: '1.0.0', sha256: 'a'.repeat(64), effectiveAt: 'x' }).success,
    ).toBe(true);
    expect(compareWordlistVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareWordlistVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareWordlistVersions('1.0.0', '2.0.0')).toBe(-1);
  });
});
