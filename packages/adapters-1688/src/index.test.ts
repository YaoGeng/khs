import { createHash, createPublicKey, generateKeyPairSync, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AdapterDslSchema,
  AdapterManifestSchema,
  manifestSignablePayload,
  normalizePem,
} from '@xinglian/protocol';
import { parseHTML } from 'linkedom';
import { PACKAGE_NAME, adapter1688Dsl, ADAPTER_1688_VERSION } from './index.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

function resolveSelector(name: string): string {
  const selectors: Record<string, string> = adapter1688Dsl.selectors;
  const css = selectors[name];
  if (css === undefined) throw new Error(`selector 未定义: ${name}`);
  return css;
}

/** 与 adapter-loader 的 linkedom 自检 runner 同口径：逐个 CSS selector 计数命中 */
function unmatchedSelectors(html: string, cssSelectors: string[]): string[] {
  const { document } = parseHTML(html);
  return cssSelectors.filter((selector) => document.querySelectorAll(selector).length < 1);
}

describe('adapters-1688 v1', () => {
  it('保留 stub 期 PACKAGE_NAME 导出', () => {
    expect(PACKAGE_NAME).toBe('adapters-1688');
  });

  it('DSL 通过 protocol 的 AdapterDslSchema v1.1 校验', () => {
    const result = AdapterDslSchema.safeParse(adapter1688Dsl);
    expect(result.success).toBe(true);
    expect(adapter1688Dsl.platform).toBe('1688');
    expect(ADAPTER_1688_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('search flow v1 只声明 keyword 路由（选品输入 = 报告关键词；收藏/询盘走契约扩展卡）', () => {
    const routes = adapter1688Dsl.flows.search.routes;
    expect(Object.keys(routes ?? {})).toEqual(['keyword']);
  });

  it('detail flow 声明六字段位点（title/price/sales/supplier/address/gallery；起批量 v1 不声明）', () => {
    expect(Object.keys(adapter1688Dsl.flows.detail.fields ?? {}).sort()).toEqual(
      ['address', 'gallery', 'price', 'sales', 'supplier', 'title'].sort(),
    );
  });

  it('selfcheck 引用的 fixture 文件真实存在', async () => {
    for (const check of adapter1688Dsl.selfcheck) {
      await expect(readFile(`${PACKAGE_ROOT}${check.fixture}`, 'utf8')).resolves.toBeTypeOf('string');
    }
  });

  it('selfcheck 用例在 fixture 无害页上回放全过（搜索特征 + 详情字段）', async () => {
    for (const check of adapter1688Dsl.selfcheck) {
      const html = await readFile(`${PACKAGE_ROOT}${check.fixture}`, 'utf8');
      const missed = unmatchedSelectors(html, check.expect.map((exp) => resolveSelector(exp.selector)));
      expect(missed, `${check.name} 未命中: ${missed.join(', ')}`).toEqual([]);
    }
  });

  it('blockedFeatures：blocked.html 全命中（登录墙 + 滑块），search.html 全不命中', async () => {
    const blockedSelectors = adapter1688Dsl.blockedFeatures.flatMap((f) => f.selectors.map(resolveSelector));
    const blockedHtml = await readFile(`${PACKAGE_ROOT}fixtures/blocked.html`, 'utf8');
    const searchHtml = await readFile(`${PACKAGE_ROOT}fixtures/search.html`, 'utf8');
    expect(unmatchedSelectors(blockedHtml, blockedSelectors)).toEqual([]);
    expect(unmatchedSelectors(searchHtml, blockedSelectors)).toEqual(blockedSelectors);
  });

  it('offerLink 提取目标在 search.html 上命中 ≥2（卡片结构取证形态）', async () => {
    const html = await readFile(`${PACKAGE_ROOT}fixtures/search.html`, 'utf8');
    const { document } = parseHTML(html);
    expect(document.querySelectorAll(resolveSelector('offerLink')).length).toBeGreaterThanOrEqual(2);
  });

  it('包验封链路：manifest 过 schema、Ed25519 签名可验、篡改一字节即失效', async () => {
    const dslJson = JSON.stringify(adapter1688Dsl);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const manifest = {
      platform: adapter1688Dsl.platform,
      version: adapter1688Dsl.version,
      minEngineVersion: adapter1688Dsl.minEngineVersion,
      sha256: createHash('sha256').update(dslJson, 'utf8').digest('hex'),
    };
    const sig = ed25519Sign(
      null,
      Buffer.from(manifestSignablePayload(manifest), 'utf8'),
      privateKey,
    ).toString('base64');
    const parsed = AdapterManifestSchema.parse({ ...manifest, sig });
    expect(
      ed25519Verify(
        null,
        Buffer.from(manifestSignablePayload(parsed), 'utf8'),
        createPublicKey(normalizePem(publicKey.export({ type: 'spki', format: 'pem' }).toString())),
        Buffer.from(parsed.sig, 'base64'),
      ),
    ).toBe(true);

    const tamperedJson = `${dslJson.slice(0, -2)}x${dslJson.slice(-1)}`;
    const tamperedSha = createHash('sha256').update(tamperedJson, 'utf8').digest('hex');
    expect(tamperedSha).not.toBe(manifest.sha256);
  });
});
