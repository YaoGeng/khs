import type { AdapterDslInput } from '@xinglian/protocol';

export const ADAPTER_1688_PLATFORM = '1688';
export const ADAPTER_1688_VERSION = '1.0.0';
export const ADAPTER_1688_MIN_ENGINE_VERSION = '1.0.0';

/**
 * 1688 适配包 DSL v1.0（纯数据；T-M2-01）。
 * 选择器来源：2026-10-16 内置 Chromium 匿名真页取证（apps/desktop/scripts/probe-1688.mjs，
 * 报告 scripts/out/probe-1688.json，三轮）——searchInput / offerLink / price / sales /
 * company-name / address / gallery 为实测命中；offerTitle(h1) 与部分字段为「合理编写」，
 * 真实校验与精确化在 T-M2-02 检索联调窗口（登录态）进行——与 adapters-xhs v1 同口径。
 *
 * 取证关键结论（诚实口径）：1688 匿名访问搜索结果页返回**推荐流**（页面 body 含关键词
 * 0 次、15 张卡片与查询词无关），真实关键词结果需登录态（FR-3.1：用户本人在可见浏览器
 * 登录；与 xhs 共用内置浏览器 profile 即可，Cookies 分域共存）。offerCard 匿名下也渲染
 * （推荐流同款卡片），故「结果有效性」护栏在引擎/选品 Agent 侧做登录态前置探测，不放
 * DSL expect（DSL 特征只验结构、不验业务真实性）。
 */
export const adapter1688Dsl = {
  platform: ADAPTER_1688_PLATFORM,
  version: ADAPTER_1688_VERSION,
  minEngineVersion: ADAPTER_1688_MIN_ENGINE_VERSION,

  selectors: {
    searchInput: 'input[name="keywords"]',
    offerCard: '[class*="offer-item"]',
    offerLink: 'a[href*="detail.1688.com/offer"]',
    offerTitle: 'h1',
    priceTag: '[class*="price"]',
    salesTag: '[class*="sales"]',
    supplierName: '.company-name',
    supplierAddress: '[class*="address"]',
    galleryImage: '[class*="gallery"] img',
    loginPanel: '.login-panel',
    loginDialog: '[class*="login-dialog"]',
    loginIframe: 'iframe[src*="login"]',
    ncCaptchaWrapper: '#nc_1_wrapper',
    ncCaptchaContainer: '.nc-container',
    punishPanel: '[class*="punish"]',
    captchaRoot: '#captcha',
  },

  flows: {
    // 选品检索（T-M2-02 输入面）：v1 只声明 keyword 路由（选品输入 = 报告产出的关键词/词组）；
    // 收藏/询盘 flow 属 AdapterDsl 契约扩展（schema 当前仅 search/detail），随 T-M2-04 前的
    // 契约卡进入，不在本包越权。
    search: {
      description:
        '关键词检索：canonical selloffer URL 直达（首页输入框为备选路线）。'
        + '注意：匿名访问返回推荐流，真实结果需登录态——引擎检索前置须做登录态探测',
      routes: {
        keyword: [
          {
            id: 'kw-open-selloffer',
            action: 'navigate',
            value: 'https://s.1688.com/selloffer/offer_search.htm?keywords={{input.keyword}}',
            description: '直达搜索结果页（取证：URL 直达最稳；匿名=推荐流）',
          },
          {
            id: 'kw-await-cards',
            action: 'waitFor',
            target: 'offerCard',
            expect: [{ selector: 'offerCard', minCount: 1 }],
            description: '结果卡片渲染（结构特征；业务真实性由登录态前置保证）',
          },
          { id: 'kw-extract-links', action: 'extract', target: 'offerLink', value: 'offerLinks' },
        ],
      },
    },
    detail: {
      description: '商品详情字段位点（价格/销量/供应商/地址/图集；起批量未取证到稳定类名，v1 不声明）',
      fields: {
        title: 'offerTitle',
        price: 'priceTag',
        sales: 'salesTag',
        supplier: 'supplierName',
        address: 'supplierAddress',
        gallery: 'galleryImage',
      },
      steps: [
        {
          id: 'detail-await',
          action: 'waitFor',
          target: 'supplierName',
          expect: [{ selector: 'supplierName' }, { selector: 'galleryImage' }],
        },
      ],
    },
  },

  // 激活前在 fixture 无害页回放（02:390）
  selfcheck: [
    {
      name: 'search-features',
      fixture: 'fixtures/search.html',
      expect: [{ selector: 'searchInput' }, { selector: 'offerCard' }, { selector: 'offerLink' }],
      description: '搜索框 + 结果卡片 + offer 锚点特征',
    },
    {
      name: 'detail-fields',
      fixture: 'fixtures/detail.html',
      expect: [
        { selector: 'offerTitle' },
        { selector: 'priceTag' },
        { selector: 'salesTag' },
        { selector: 'supplierName' },
        { selector: 'supplierAddress' },
        { selector: 'galleryImage' },
      ],
      description: '详情字段位点特征',
    },
  ],

  // v1 无不可重入步骤，verify 为空（收藏/询盘随契约扩展卡补 nonReentrant + verify）
  verify: [],

  blockedFeatures: [
    {
      name: 'login-wall',
      selectors: ['loginPanel', 'loginDialog', 'loginIframe'],
      description: '登录墙（匿名检索被推荐流替代的显式形态；命中 → 引导用户登录，不自动重试）',
    },
    {
      name: 'captcha',
      selectors: ['ncCaptchaWrapper', 'ncCaptchaContainer', 'punishPanel', 'captchaRoot'],
      description: '阿里系滑块/风控容器（02:388：命中 → 风控信号 → 熔断器介入）',
    },
  ],
} satisfies AdapterDslInput;
