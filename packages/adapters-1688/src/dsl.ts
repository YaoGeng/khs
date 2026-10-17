import type { AdapterDslInput } from '@xinglian/protocol';

export const ADAPTER_1688_PLATFORM = '1688';
export const ADAPTER_1688_VERSION = '1.1.0';
export const ADAPTER_1688_MIN_ENGINE_VERSION = '1.1.0';

/**
 * 1688 适配包 DSL v1.1（纯数据；T-M2-01 + 2026-10-18 契约扩展卡）。
 * 选择器来源：2026-10-16 内置 Chromium 匿名真页取证（apps/desktop/scripts/probe-1688.mjs，
 * 报告 scripts/out/probe-1688.json，三轮）——searchInput / offerLink / price / sales /
 * company-name / address / gallery 为实测命中；offerTitle(h1) 与 favorite/inquiry 写操作
 * 全部 selectors 为「合理编写」，真实校验与精确化在 T-M2-04 联调窗口（登录态）进行——
 * 与 adapters-xhs v1 同口径。
 *
 * 版本升档说明：flows 扩展 favorite/inquiry（strict schema 下老引擎会 schema_invalid 拒绝
 * 新包），按 dsl.ts 既定策略「前向兼容走 minEngineVersion 升档」双升至 1.1.0，老引擎获得
 * 优雅的 engine_too_old 拒绝理由（引擎侧 ENGINE_DSL_VERSION 同卡升至 1.1.0）。
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
    // favorite/inquiry 写操作位点（契约扩展卡 2026-10-18；全部「合理编写」，T-M2-04 登录态联调校准）
    favoriteButton: '[class*="favor-btn"]',
    favoriteDoneState: '[class*="favor-done"]',
    inquiryEntry: '[class*="inquiry"]',
    wwChatWindow: '[class*="chat-window"]',
    inquiryTextarea: '[class*="chat-input"] textarea',
    inquirySendButton: '[class*="chat-send"]',
    inquirySentMark: '[class*="msg-sent"]',
  },

  flows: {
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
    // 契约扩展卡（2026-10-18）：favorite/inquiry 对外写操作 flow（FR-6.4）。
    // confirm 声明 = 引擎执行首个 nonReentrant 步骤前必须人工确认（不受 FR-12.7 档位影响）
    // + 审计留痕；执行端（确认弹窗 UI/审计落库/素材留存/商品卡片入库）归 T-M2-04。
    favorite: {
      description: '收藏商品（FR-6.4 对外写操作）：{{input.offerUrl}} 直达详情 → 人工确认 → 收藏',
      confirm: {
        description: '收藏前人工确认（FR-6.4/FR-12.7 红线：对外写操作永远人工确认，不受自动化档位影响）',
        expect: [{ selector: 'favoriteButton' }],
      },
      steps: [
        { id: 'fav-open', action: 'navigate', value: '{{input.offerUrl}}', description: '直达商品详情页' },
        {
          id: 'fav-await-detail',
          action: 'waitFor',
          target: 'offerTitle',
          expect: [{ selector: 'offerTitle' }],
          description: '详情页渲染（结构特征）',
        },
        {
          id: 'fav-click',
          action: 'click',
          target: 'favoriteButton',
          nonReentrant: true,
          description: '点击收藏（不可逆动作锚点；恢复时先按 verify 核对成功态，已成功则跳过重放）',
        },
      ],
    },
    inquiry: {
      description:
        '供应商询盘（FR-6.4）：{{input.offerUrl}} 直达详情 → 打开旺旺会话 → 键入 {{input.message}} '
        + '（话术模板含需求数量/一件代发询问/素材授权句，由引擎组装）→ 人工确认 → 发送',
      confirm: {
        description: '询盘发送前人工确认（FR-6.4：发送前弹确认；FR-12.7：不受自动化档位影响，永远人工）',
        expect: [{ selector: 'wwChatWindow' }, { selector: 'inquiryTextarea' }],
      },
      steps: [
        { id: 'inq-open', action: 'navigate', value: '{{input.offerUrl}}', description: '直达商品详情页' },
        {
          id: 'inq-await-detail',
          action: 'waitFor',
          target: 'offerTitle',
          expect: [{ selector: 'offerTitle' }],
          description: '详情页渲染（结构特征）',
        },
        { id: 'inq-click-entry', action: 'click', target: 'inquiryEntry', description: '打开询盘/旺旺会话入口' },
        {
          id: 'inq-await-chat',
          action: 'waitFor',
          target: 'wwChatWindow',
          expect: [{ selector: 'wwChatWindow' }, { selector: 'inquiryTextarea' }],
          description: '会话窗与输入框在场（= confirm.expect 同源特征；发送前引擎二次核验）',
        },
        { id: 'inq-type', action: 'type', target: 'inquiryTextarea', value: '{{input.message}}', description: '键入询盘话术（引擎侧模板组装）' },
        {
          id: 'inq-send',
          action: 'click',
          target: 'inquirySendButton',
          nonReentrant: true,
          description: '点击发送（不可逆动作锚点；恢复时先按 verify 核对已发送特征，已发出则跳过重放）',
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
    {
      name: 'favorite-features',
      fixture: 'fixtures/favorite.html',
      expect: [{ selector: 'favoriteButton' }, { selector: 'favoriteDoneState' }],
      description: '收藏按钮 + 成功态特征（写操作位点，契约扩展卡）',
    },
    {
      name: 'inquiry-features',
      fixture: 'fixtures/inquiry.html',
      expect: [
        { selector: 'inquiryEntry' },
        { selector: 'wwChatWindow' },
        { selector: 'inquiryTextarea' },
        { selector: 'inquirySendButton' },
        { selector: 'inquirySentMark' },
      ],
      description: '询盘入口 + 会话窗/输入框/发送/已发送特征（写操作位点，契约扩展卡）',
    },
  ],

  // 契约扩展卡：favorite/inquiry 不可逆动作（fav-click / inq-send）的恢复核对声明（S2）
  verify: [
    {
      step: 'fav-click',
      description: '收藏已成功（详情页含已收藏成功态特征）——恢复时命中即跳过重放',
      expect: [{ selector: 'favoriteDoneState' }],
    },
    {
      step: 'inq-send',
      description: '询盘已发出（会话窗含已发送消息特征）——恢复时命中即跳过重放（防重复打扰供应商）',
      expect: [{ selector: 'inquirySentMark' }],
    },
  ],

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
