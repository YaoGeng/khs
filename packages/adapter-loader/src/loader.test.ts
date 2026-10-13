import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSignablePayload, normalizePem, type AdapterDslInput } from '@xinglian/protocol';
import {
  ACTIVE_FILE,
  createLinkedomSelfcheckRunner,
  loadAdapterPackage,
  readActiveRecord,
  type EmitTelemetry,
} from './index.js';

const FIXTURE_DIR = fileURLToPath(new URL('../test-fixtures/', import.meta.url));

const TEST_PRIVATE_PEM = normalizePem(
  await readFile(join(FIXTURE_DIR, 'test-ed25519-private.pem'), 'utf8'),
);
const TEST_PUBLIC_PEM = normalizePem(
  await readFile(join(FIXTURE_DIR, 'test-ed25519-public.pem'), 'utf8'),
);
const TEST_PRIVATE_KEY = createPrivateKey(TEST_PRIVATE_PEM);

// 测试夹具：登录态可见的搜索页（含搜索框+登录入口特征）
const SEARCH_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  '<input id="search-input" type="search">',
  '<button class="login-btn">登录</button>',
  '<section class="note-item"><a class="cover" href="/x/1">笔记</a></section>',
  '</body></html>',
].join('\n');
// 无登录入口的页面（登录态 / 改版页），用于自检失败场景
const SEARCH_HTML_NO_LOGIN = SEARCH_HTML.replace('<button class="login-btn">登录</button>', '');

interface PackageSpec {
  version: string;
  minEngineVersion?: string;
  dslOverrides?: Partial<AdapterDslInput>;
  /** relPath -> html；缺省=自带 search.html */
  fixtures?: Record<string, string>;
  /** 签名后篡改 dsl.json 一个字节（完整性必炸） */
  tamperDslByte?: boolean;
  /** 篡改 manifest 签名字段（验签必炸） */
  tamperSig?: boolean;
}

function makeDsl(spec: PackageSpec): AdapterDslInput {
  return {
    platform: 'xhs',
    version: spec.version,
    minEngineVersion: spec.minEngineVersion ?? '1.0.0',
    selectors: {
      searchBox: '#search-input',
      loginEntry: '.login-btn',
      noteCard: 'section.note-item',
    },
    flows: {
      search: {
        steps: [
          { id: 'open', action: 'navigate', value: 'https://example.com' },
          { id: 'wait-box', action: 'waitFor', target: 'searchBox' },
        ],
      },
      detail: {
        fields: { title: 'searchBox' },
        steps: [{ id: 'read', action: 'waitFor', target: 'searchBox' }],
      },
    },
    selfcheck: [
      { name: 'search-box', fixture: 'fixtures/search.html', expect: [{ selector: 'searchBox' }] },
      { name: 'login-entry', fixture: 'fixtures/search.html', expect: [{ selector: 'loginEntry' }] },
    ],
    verify: [],
    blockedFeatures: [],
    ...spec.dslOverrides,
  };
}

async function writePackage(root: string, spec: PackageSpec): Promise<string> {
  const dsl = makeDsl(spec);
  const dslJson = JSON.stringify(dsl, null, 2);
  const sha256 = createHash('sha256').update(dslJson, 'utf8').digest('hex');
  const manifestBase = {
    platform: dsl.platform,
    version: dsl.version,
    minEngineVersion: dsl.minEngineVersion,
    sha256,
  };
  const payload = Buffer.from(manifestSignablePayload(manifestBase), 'utf8');
  let sig = ed25519Sign(null, payload, TEST_PRIVATE_KEY).toString('base64');
  if (spec.tamperSig) {
    sig = `${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
  }
  const pkgDir = join(root, 'xhs', spec.version);
  await mkdir(join(pkgDir, 'fixtures'), { recursive: true });
  const finalDslJson = spec.tamperDslByte === true
    ? dslJson.replace('#search-input', '.search-input')
    : dslJson;
  await writeFile(join(pkgDir, 'dsl.json'), finalDslJson, 'utf8');
  await writeFile(join(pkgDir, 'manifest.json'), `${JSON.stringify({ ...manifestBase, sig }, null, 2)}\n`, 'utf8');
  const fixtures = spec.fixtures ?? { 'fixtures/search.html': SEARCH_HTML };
  for (const [rel, html] of Object.entries(fixtures)) {
    await writeFile(join(pkgDir, rel), html, 'utf8');
  }
  return pkgDir;
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'khs-adapter-loader-'));
}

function loadOptions(root: string, version: string, extra: Partial<Parameters<typeof loadAdapterPackage>[0]> = {}) {
  return {
    adaptersRoot: root,
    platform: 'xhs',
    version,
    engineVersion: '1.0.0',
    publicKey: TEST_PUBLIC_PEM,
    ...extra,
  };
}

describe('adapter-loader 加载链', () => {
  it('夹具密钥为 TEST ONLY Ed25519 对', () => {
    expect(createPrivateKey(TEST_PRIVATE_PEM).asymmetricKeyType).toBe('ed25519');
    expect(createPublicKey(TEST_PUBLIC_PEM).asymmetricKeyType).toBe('ed25519');
  });

  it('① 合法包激活成功：activeVersion=v1 且 active.json 持久化', async () => {
    const root = await makeRoot();
    try {
      await writePackage(root, { version: '1.0.0' });
      const result = await loadAdapterPackage(loadOptions(root, '1.0.0'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe('1.0.0');
      expect(result.dsl.flows.search.steps?.length).toBeGreaterThan(0);
      const active = await readActiveRecord(root, 'xhs');
      expect(active?.version).toBe('1.0.0');
      expect(active?.platform).toBe('xhs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('②a 篡改 payload 一字节 → sha256 完整性拒绝，active 保持上一版', async () => {
    const root = await makeRoot();
    try {
      await writePackage(root, { version: '1.0.0' });
      await loadAdapterPackage(loadOptions(root, '1.0.0'));
      await writePackage(root, { version: '1.0.1', tamperDslByte: true });
      const result = await loadAdapterPackage(loadOptions(root, '1.0.1'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('integrity_mismatch');
      expect(result.keptVersion).toBe('1.0.0');
      expect((await readActiveRecord(root, 'xhs'))?.version).toBe('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('②b 篡改 manifest 签名字段 → Ed25519 验签拒绝，active 保持上一版', async () => {
    const root = await makeRoot();
    try {
      await writePackage(root, { version: '1.0.0' });
      await loadAdapterPackage(loadOptions(root, '1.0.0'));
      await writePackage(root, { version: '1.0.1', tamperSig: true });
      const result = await loadAdapterPackage(loadOptions(root, '1.0.1'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('signature_invalid');
      expect(result.keptVersion).toBe('1.0.0');
      expect((await readActiveRecord(root, 'xhs'))?.version).toBe('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('②c 引擎公钥不匹配 → 验签拒绝（防替换公钥攻击面之外的错发场景）', async () => {
    const root = await makeRoot();
    try {
      const foreign = generateKeyPairSync('ed25519');
      const foreignPub = foreign.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      await writePackage(root, { version: '1.0.0' });
      const result = await loadAdapterPackage(loadOptions(root, '1.0.0', { publicKey: foreignPub }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('signature_invalid');
      expect((await readActiveRecord(root, 'xhs'))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('③ 不兼容 minEngineVersion → 拒绝激活，active 保持上一版', async () => {
    const root = await makeRoot();
    try {
      await writePackage(root, { version: '1.0.0' });
      await loadAdapterPackage(loadOptions(root, '1.0.0'));
      await writePackage(root, { version: '1.0.1', minEngineVersion: '99.0.0' });
      const result = await loadAdapterPackage(loadOptions(root, '1.0.1'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('incompatible_engine');
      expect(result.detail).toContain('99.0.0');
      expect((await readActiveRecord(root, 'xhs'))?.version).toBe('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('④ selfcheck 失败 → 上报 selfcheck_fail 遥测并回滚 last-good', async () => {
    const root = await makeRoot();
    try {
      await writePackage(root, { version: '1.0.0' });
      await loadAdapterPackage(loadOptions(root, '1.0.0'));
      // v2 的 fixture 缺登录入口特征 → login-entry 用例失败
      await writePackage(root, {
        version: '1.0.1',
        fixtures: { 'fixtures/search.html': SEARCH_HTML_NO_LOGIN },
      });
      const events: Array<{ event: string; payload?: unknown }> = [];
      const emitTelemetry: EmitTelemetry = (event, payload) => events.push({ event, payload });
      const result = await loadAdapterPackage(loadOptions(root, '1.0.1', { emitTelemetry }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('selfcheck_failed');
      expect(result.detail).toContain('login-entry');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('selfcheck_fail');
      expect(events[0].payload).toMatchObject({ platform: 'xhs', version: '1.0.1' });
      expect((await readActiveRecord(root, 'xhs'))?.version).toBe('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fixture 缺失 → selfcheck_failed（保守拒绝激活）', async () => {
    const root = await makeRoot();
    try {
      await writePackage(root, { version: '1.0.0', fixtures: {} });
      const result = await loadAdapterPackage(loadOptions(root, '1.0.0'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('selfcheck_failed');
      expect(result.detail).toContain('fixture 读取失败');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('失败后新合法版本可重新激活（last-good → new-good）', async () => {
    const root = await makeRoot();
    try {
      await writePackage(root, { version: '1.0.0' });
      await loadAdapterPackage(loadOptions(root, '1.0.0'));
      await writePackage(root, { version: '1.0.1', tamperDslByte: true });
      await loadAdapterPackage(loadOptions(root, '1.0.1'));
      await writePackage(root, { version: '1.0.2' });
      const result = await loadAdapterPackage(loadOptions(root, '1.0.2'));
      expect(result.ok).toBe(true);
      expect((await readActiveRecord(root, 'xhs'))?.version).toBe('1.0.2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('manifest 缺失/非法 → package_not_found / manifest_invalid', async () => {
    const root = await makeRoot();
    try {
      const result1 = await loadAdapterPackage(loadOptions(root, '9.9.9'));
      expect(result1.ok).toBe(false);
      if (!result1.ok) expect(result1.reason).toBe('package_not_found');

      const pkgDir = await writePackage(root, { version: '1.0.0' });
      await writeFile(join(pkgDir, 'manifest.json'), '{ not json', 'utf8');
      const result2 = await loadAdapterPackage(loadOptions(root, '1.0.0'));
      expect(result2.ok).toBe(false);
      if (!result2.ok) expect(result2.reason).toBe('manifest_invalid');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('readActiveRecord：无 active.json → null；损坏 → null', async () => {
    const root = await makeRoot();
    try {
      expect(await readActiveRecord(root, 'xhs')).toBeNull();
      const dir = join(root, 'xhs');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ACTIVE_FILE), 'not-json{', 'utf8');
      expect(await readActiveRecord(root, 'xhs')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loadActivePackage：按 active.json 重验激活包', async () => {
    const root = await makeRoot();
    try {
      expect((await import('./index.js')).loadActivePackage).toBeTypeOf('function');
      const { loadActivePackage } = await import('./index.js');
      await writePackage(root, { version: '1.0.0' });
      await loadAdapterPackage(loadOptions(root, '1.0.0'));
      const result = await loadActivePackage({
        adaptersRoot: root,
        platform: 'xhs',
        engineVersion: '1.0.0',
        publicKey: TEST_PUBLIC_PEM,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('linkedom 默认自检 runner：minCount 语义', () => {
    const runner = createLinkedomSelfcheckRunner();
    const html = '<div class="tag"></div><div class="tag"></div>';
    expect(runner(html, [{ selector: '.tag', minCount: 2 }]).passed).toBe(true);
    expect(runner(html, [{ selector: '.tag', minCount: 3 }]).passed).toBe(false);
    expect(runner(html, [{ selector: '.missing', minCount: 1 }]).passed).toBe(false);
  });
});
