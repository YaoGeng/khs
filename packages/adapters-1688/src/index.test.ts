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

  it('search flow 只声明 keyword 路由（选品输入 = 报告关键词）', () => {
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

describe('契约扩展卡（v1.1.0，2026-10-18）', () => {
  it('版本升档：DSL 1.1.1（T-M2-04 前置登录态校准，patch）+ minEngineVersion 1.1.0（契约不变）', () => {
    expect(ADAPTER_1688_VERSION).toBe('1.1.1');
    expect(adapter1688Dsl.version).toBe('1.1.1');
    expect(adapter1688Dsl.minEngineVersion).toBe('1.1.0');
  });

  it('favorite/inquiry 均含 confirm 声明（FR-6.4/FR-12.7：对外写操作发送前人工确认，不受档位影响）', () => {
    for (const key of ['favorite', 'inquiry'] as const) {
      const flow = adapter1688Dsl.flows[key];
      expect(flow.confirm, `${key} 缺 confirm 声明`).toBeDefined();
      expect(flow.confirm?.description).toContain('人工确认');
      expect(flow.confirm?.expect.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('不可逆动作锚点：fav-click / inq-send 为 nonReentrant 且 verify 声明配对（S2）', () => {
    const nonReentrant = new Set<string>();
    for (const key of ['favorite', 'inquiry'] as const) {
      for (const step of adapter1688Dsl.flows[key].steps ?? []) {
        if (step.nonReentrant === true) nonReentrant.add(step.id);
      }
    }
    expect([...nonReentrant].sort()).toEqual(['fav-click', 'inq-send']);
    const verifiedSteps = new Set(adapter1688Dsl.verify.map((decl) => decl.step));
    for (const id of nonReentrant) {
      expect(verifiedSteps.has(id), `${id} 缺 verify 声明`).toBe(true);
    }
  });

  it('询盘 confirm.expect 与发送前页面核验同源：覆盖会话窗 + 输入框', () => {
    const expectSelectors = adapter1688Dsl.flows.inquiry.confirm?.expect.map((exp) => exp.selector) ?? [];
    expect(expectSelectors).toContain('wwChatWindow');
    expect(expectSelectors).toContain('inquiryTextarea');
  });

  it('写操作与详情位点为登录态取证形态（2026-10-18 probe-1688-loggedin，T-M2-04 前置校准）', () => {
    expect(adapter1688Dsl.selectors.favoriteButton).toBe('[data-click="FAV"]');
    expect(adapter1688Dsl.selectors.followShopButton).toBe('[data-click="follow-shop"]');
    expect(adapter1688Dsl.selectors.inquiryEntry).toBe('[data-click="咨询客服"]');
    // 防回退旧噪声锚：详情页 7 个 h1 首个是公司名；.company-name 命中页尾推荐模块
    expect(adapter1688Dsl.selectors.offerTitle).toContain('module-od-title');
    expect(adapter1688Dsl.selectors.supplierName).toContain('shop-company-name');
    expect(adapter1688Dsl.selectors.offerCard).toContain('offerCard');
  });

  it('输入面：offerUrl/message 走 {{input.xxx}} 模板占位', () => {
    const templates = [
      adapter1688Dsl.flows.favorite.steps?.[0]?.value,
      adapter1688Dsl.flows.inquiry.steps?.[0]?.value,
      adapter1688Dsl.flows.inquiry.steps?.find((step) => step.id === 'inq-type')?.value,
    ];
    for (const tpl of templates) {
      expect(tpl).toMatch(/\{\{input\.[a-zA-Z]+\}\}/);
    }
  });
});
