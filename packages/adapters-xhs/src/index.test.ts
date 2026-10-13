import { createHash, createPublicKey, generateKeyPairSync, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AdapterDslSchema,
  AdapterManifestSchema,
  manifestSignablePayload,
  normalizePem,
  planKeywordQueries,
  SearchQuerySchema,
} from '@xinglian/protocol';
import { parseHTML } from 'linkedom';
import { PACKAGE_NAME, xhsAdapterDsl, XHS_ADAPTER_VERSION } from './index.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

function resolveSelector(name: string): string {
  const selectors: Record<string, string> = xhsAdapterDsl.selectors;
  const css = selectors[name];
  if (css === undefined) throw new Error(`selector 未定义: ${name}`);
  return css;
}

/** 与 adapter-loader 的 linkedom 自检 runner 同口径：逐个 CSS selector 计数命中 */
function unmatchedSelectors(html: string, cssSelectors: string[]): string[] {
  const { document } = parseHTML(html);
  return cssSelectors.filter((selector) => document.querySelectorAll(selector).length < 1);
}

describe('adapters-xhs v1', () => {
  it('保留 stub 期 PACKAGE_NAME 导出', () => {
    expect(PACKAGE_NAME).toBe('adapters-xhs');
  });

  it('DSL 通过 protocol 的 AdapterDslSchema v1.1 校验', () => {
    const result = AdapterDslSchema.safeParse(xhsAdapterDsl);
    expect(result.success).toBe(true);
    expect(xhsAdapterDsl.platform).toBe('xhs');
    expect(XHS_ADAPTER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('search flow 声明三种输入路由（keyword/user/note_url）', () => {
    const routes = xhsAdapterDsl.flows.search.routes;
    expect(Object.keys(routes ?? {}).sort()).toEqual(['keyword', 'note_url', 'user']);
  });

  it('detail flow 声明标题/正文/互动数/标签/作者字段位点', () => {
    expect(Object.keys(xhsAdapterDsl.flows.detail.fields ?? {}).sort()).toEqual(
      ['author', 'collects', 'comments', 'likes', 'tags', 'title', 'content'].sort(),
    );
  });

  it('selfcheck 引用的 fixture 文件真实存在', async () => {
    for (const check of xhsAdapterDsl.selfcheck) {
      await expect(readFile(`${PACKAGE_ROOT}${check.fixture}`, 'utf8')).resolves.toBeTypeOf('string');
    }
  });

  it('selfcheck 用例在 fixture 无害页上回放全过（登录入口+搜索框特征）', async () => {
    for (const check of xhsAdapterDsl.selfcheck) {
      const html = await readFile(`${PACKAGE_ROOT}${check.fixture}`, 'utf8');
      const missed = unmatchedSelectors(html, check.expect.map((exp) => resolveSelector(exp.selector)));
      expect(missed, `${check.name} 未命中: ${missed.join(', ')}`).toEqual([]);
    }
  });

  it('detail 字段位点在 detail.html fixture 上全部命中', async () => {
    const html = await readFile(`${PACKAGE_ROOT}fixtures/detail.html`, 'utf8');
    const missed = unmatchedSelectors(
      html,
      Object.values(xhsAdapterDsl.flows.detail.fields ?? {}).map(resolveSelector),
    );
    expect(missed).toEqual([]);
  });

  it('blockedFeatures 验证码容器特征：captcha.html 命中、正常页不命中', async () => {
    const captchaSelectors = (xhsAdapterDsl.blockedFeatures[0]?.selectors ?? []).map(resolveSelector);
    const captchaHtml = await readFile(`${PACKAGE_ROOT}fixtures/captcha.html`, 'utf8');
    const searchHtml = await readFile(`${PACKAGE_ROOT}fixtures/search.html`, 'utf8');
    expect(unmatchedSelectors(captchaHtml, captchaSelectors)).toEqual([]);
    expect(unmatchedSelectors(searchHtml, captchaSelectors)).toEqual(captchaSelectors);
  });

  it('terms 组合语义（B-4）：OR 分次查询 / AND 单查询+全词过滤', () => {
    const or = planKeywordQueries({ terms: ['保温杯', '咖啡杯'], operator: 'or' });
    expect(or).toEqual({ queries: ['保温杯', '咖啡杯'], clientFilter: null });
    const and = planKeywordQueries({ terms: ['露营', '装备'], operator: 'and' });
    expect(and).toEqual({ queries: ['露营 装备'], clientFilter: 'all_terms_in_title_or_content' });
    expect(SearchQuerySchema.safeParse({ terms: ['a', 'b', 'c', 'd', 'e', 'f'], operator: 'or' }).success).toBe(false);
  });

  it('包验封链路：manifest 过 schema、Ed25519 签名可验、篡改一字节即失效', async () => {
    const dslJson = JSON.stringify(xhsAdapterDsl);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const manifest = {
      platform: xhsAdapterDsl.platform,
      version: xhsAdapterDsl.version,
      minEngineVersion: xhsAdapterDsl.minEngineVersion,
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
