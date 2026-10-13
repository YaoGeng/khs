import { describe, expect, it } from 'vitest';
import {
  AdapterDslSchema,
  AdapterManifestSchema,
  compareSemver,
  isEngineCompatible,
  planKeywordQueries,
  SearchQuerySchema,
} from './dsl.js';

function baseDsl() {
  return {
    platform: 'xhs',
    version: '1.0.0',
    minEngineVersion: '1.0.0',
    selectors: {
      searchBox: '#search-input',
      loginEntry: '.login-btn',
    },
    flows: {
      search: {
        steps: [
          { id: 's1', action: 'navigate', value: 'https://example.com' },
          { id: 's2', action: 'waitFor', target: 'searchBox' },
        ],
      },
      detail: {
        fields: { title: 'searchBox' },
        steps: [{ id: 'd1', action: 'waitFor', target: 'searchBox' }],
      },
    },
    selfcheck: [
      { name: 'sc1', fixture: 'fixtures/x.html', expect: [{ selector: 'searchBox' }] },
    ],
    verify: [],
    blockedFeatures: [],
  } as const;
}

function baseManifest() {
  return {
    platform: 'xhs',
    version: '1.0.0',
    minEngineVersion: '1.0.0',
    sha256: 'a'.repeat(64),
    sig: 'b'.repeat(64),
  };
}

describe('AdapterDslSchema（DSL v1.1）', () => {
  it('最小合法 DSL 通过', () => {
    const result = AdapterDslSchema.safeParse(baseDsl());
    expect(result.success).toBe(true);
  });

  it('version/minEngineVersion 必须是 semver', () => {
    expect(AdapterDslSchema.safeParse({ ...baseDsl(), version: '1.0' }).success).toBe(false);
    expect(AdapterDslSchema.safeParse({ ...baseDsl(), version: '01.0.0' }).success).toBe(false);
    expect(AdapterDslSchema.safeParse({ ...baseDsl(), minEngineVersion: '1.0.0-beta.1' }).success).toBe(true);
  });

  it('selfcheck 至少一条（空数组拒绝）', () => {
    const dsl = { ...baseDsl(), selfcheck: [] };
    expect(AdapterDslSchema.safeParse(dsl).success).toBe(false);
  });

  it('strict：未知顶层字段拒绝', () => {
    const dsl = { ...baseDsl(), evilJs: 'process.exec()' };
    expect(AdapterDslSchema.safeParse(dsl).success).toBe(false);
  });

  it('query terms ≤5（B-4）且 operator 仅 and|or', () => {
    const five = { terms: ['a', 'b', 'c', 'd', 'e'], operator: 'and' };
    expect(SearchQuerySchema.safeParse(five).success).toBe(true);
    const six = { terms: ['a', 'b', 'c', 'd', 'e', 'f'], operator: 'and' };
    expect(SearchQuerySchema.safeParse(six).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ terms: ['a'], operator: 'xor' }).success).toBe(false);
  });

  it('nonReentrant 步骤缺少 verify 声明 → 拒绝（S2，加载期前置）', () => {
    const dsl = {
      ...baseDsl(),
      flows: {
        ...baseDsl().flows,
        detail: {
          fields: { title: 'searchBox' },
          steps: [{ id: 'd1', action: 'waitFor', target: 'searchBox', nonReentrant: true }],
        },
      },
    };
    expect(AdapterDslSchema.safeParse(dsl).success).toBe(false);
  });

  it('nonReentrant 步骤有对应 verify 声明 → 通过', () => {
    const dsl = {
      ...baseDsl(),
      flows: {
        ...baseDsl().flows,
        detail: {
          fields: { title: 'searchBox' },
          steps: [{ id: 'd1', action: 'waitFor', target: 'searchBox', nonReentrant: true }],
        },
      },
      verify: [
        {
          step: 'd1',
          description: '详情页已打开',
          expect: [{ selector: 'searchBox' }],
        },
      ],
    };
    expect(AdapterDslSchema.safeParse(dsl).success).toBe(true);
  });

  it('verify 指向不存在的步骤 → 拒绝', () => {
    const dsl = {
      ...baseDsl(),
      verify: [{ step: 'ghost', description: 'x', expect: [{ selector: 'searchBox' }] }],
    };
    expect(AdapterDslSchema.safeParse(dsl).success).toBe(false);
  });

  it('selector 引用未在 selectors 表定义 → 拒绝（步骤/自检/字段/blockedFeatures 全覆盖）', () => {
    const missingTarget = JSON.parse(JSON.stringify(baseDsl()));
    missingTarget.flows.search.steps[1].target = 'ghostSelector';
    expect(AdapterDslSchema.safeParse(missingTarget).success).toBe(false);

    const missingSelfcheck = JSON.parse(JSON.stringify(baseDsl()));
    missingSelfcheck.selfcheck[0].expect[0].selector = 'ghostSelector';
    expect(AdapterDslSchema.safeParse(missingSelfcheck).success).toBe(false);

    const missingField = JSON.parse(JSON.stringify(baseDsl()));
    missingField.flows.detail.fields.title = 'ghostSelector';
    expect(AdapterDslSchema.safeParse(missingField).success).toBe(false);

    const missingBlocked = {
      ...baseDsl(),
      blockedFeatures: [{ name: 'captcha', selectors: ['ghostSelector'] }],
    };
    expect(AdapterDslSchema.safeParse(missingBlocked).success).toBe(false);
  });

  it('flow 的 steps 与 routes 互斥', () => {
    const both = JSON.parse(JSON.stringify(baseDsl()));
    both.flows.search.routes = { keyword: [{ id: 'r1', action: 'waitFor', target: 'searchBox' }] };
    expect(AdapterDslSchema.safeParse(both).success).toBe(false);
  });

  it('verify/blockedFeatures 缺省时应用默认空数组', () => {
    const dsl = JSON.parse(JSON.stringify(baseDsl())) as Record<string, unknown>;
    delete dsl.verify;
    delete dsl.blockedFeatures;
    const result = AdapterDslSchema.safeParse(dsl);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verify).toEqual([]);
      expect(result.data.blockedFeatures).toEqual([]);
    }
  });
});

describe('AdapterManifestSchema（包验封）', () => {
  it('合法 manifest 通过', () => {
    expect(AdapterManifestSchema.safeParse(baseManifest()).success).toBe(true);
  });

  it('sha256 非 64 位 hex 拒绝', () => {
    expect(AdapterManifestSchema.safeParse({ ...baseManifest(), sha256: 'zz' }).success).toBe(false);
  });

  it('strict：多余字段拒绝', () => {
    expect(AdapterManifestSchema.safeParse({ ...baseManifest(), extra: 1 }).success).toBe(false);
  });
});

describe('compareSemver / isEngineCompatible（S10 兼容检查）', () => {
  it('核心版本号数值比较', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.10', '1.2.9')).toBe(1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
  });

  it('先决版本低于正式版', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-alpha')).toBe(1);
  });

  it('先决标识符规则（数值/字典序/长度）', () => {
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBe(1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.1')).toBe(0);
  });

  it('构建元数据不参与比较', () => {
    expect(compareSemver('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
  });

  it('isEngineCompatible：引擎版本 ≥ minEngineVersion 才兼容', () => {
    expect(isEngineCompatible('1.0.0', '1.0.0')).toBe(true);
    expect(isEngineCompatible('1.0.0', '1.1.0')).toBe(true);
    expect(isEngineCompatible('1.1.0', '1.0.0')).toBe(false);
    expect(isEngineCompatible('1.0.0-beta.2', '1.0.0-beta.1')).toBe(false);
  });

  it('非法 semver 抛错', () => {
    expect(() => compareSemver('nope', '1.0.0')).toThrow();
  });
});

describe('planKeywordQueries（B-4 组合语义）', () => {
  it('OR：逐词分次查询，无客户端过滤', () => {
    const plan = planKeywordQueries({ terms: ['保温杯', '咖啡杯', '马克杯'], operator: 'or' });
    expect(plan.queries).toEqual(['保温杯', '咖啡杯', '马克杯']);
    expect(plan.clientFilter).toBeNull();
  });

  it('AND：单查询 + 客户端全词过滤', () => {
    const plan = planKeywordQueries({ terms: ['露营', '装备'], operator: 'and' });
    expect(plan.queries).toEqual(['露营 装备']);
    expect(plan.clientFilter).toBe('all_terms_in_title_or_content');
  });

  it('terms 空数组/超 5 个由 schema 层拒绝（plan 只收合法输入）', () => {
    expect(SearchQuerySchema.safeParse({ terms: [], operator: 'or' }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ terms: ['1', '2', '3', '4', '5', '6'], operator: 'or' }).success).toBe(false);
  });
});
