import type { AdapterDslInput } from '@xinglian/protocol';

export const XHS_ADAPTER_PLATFORM = 'xhs';
export const XHS_ADAPTER_VERSION = '1.0.0';
export const XHS_ADAPTER_MIN_ENGINE_VERSION = '1.0.0';

/**
 * 小红书适配包 DSL v1.1（纯数据；选择器为当前站点合理编写，真实校验在 T-M1-04 联调窗口进行）。
 * selfcheck 的「登录入口特征」兼作 todo-7 preflight 登录态探测特征（05:88）。
 */
export const xhsAdapterDsl = {
  platform: XHS_ADAPTER_PLATFORM,
  version: XHS_ADAPTER_VERSION,
  minEngineVersion: XHS_ADAPTER_MIN_ENGINE_VERSION,

  selectors: {
    searchInput: '#search-input',
    searchButton: '.search-icon',
    loginEntry: '.login-btn',
    noteCard: 'section.note-item',
    noteLink: 'a.cover',
    userNotesTab: '.user-tabs .tab-notes',
    noteTitle: '#detail-title',
    noteContent: '#detail-desc',
    likeCount: '.engage-bar .like .count',
    collectCount: '.engage-bar .collect .count',
    commentCount: '.engage-bar .chat .count',
    tagItem: '#detail-desc a.tag',
    authorName: '.author-container .username',
    captchaContainer: '.captcha-container',
    captchaIframe: 'iframe#captcha-iframe',
  },

  flows: {
    // FR-4.1 三种输入路由：关键词搜索 / 竞品账号→用户笔记列表 / 笔记链接直达
    search: {
      description: '三种输入路由；关键词组合语义按 DSL v1.1 B-4（引擎经 planKeywordQueries 折叠）',
      routes: {
        keyword: [
          { id: 'kw-open-home', action: 'navigate', value: 'https://www.xiaohongshu.com' },
          {
            id: 'kw-await-box',
            action: 'waitFor',
            target: 'searchInput',
            expect: [{ selector: 'searchInput' }],
          },
          { id: 'kw-type', action: 'type', target: 'searchInput', value: '{{input.keyword}}' },
          { id: 'kw-submit', action: 'click', target: 'searchButton' },
          {
            id: 'kw-await-results',
            action: 'waitFor',
            target: 'noteCard',
            expect: [{ selector: 'noteCard', minCount: 1 }],
          },
          { id: 'kw-collect', action: 'extract', target: 'noteLink', value: 'noteLinks' },
        ],
        user: [
          { id: 'user-open-profile', action: 'navigate', value: '{{input.userUrl}}' },
          {
            id: 'user-await-tab',
            action: 'waitFor',
            target: 'userNotesTab',
            expect: [{ selector: 'userNotesTab' }],
          },
          { id: 'user-click-tab', action: 'click', target: 'userNotesTab' },
          {
            id: 'user-await-notes',
            action: 'waitFor',
            target: 'noteCard',
            expect: [{ selector: 'noteCard', minCount: 1 }],
          },
          { id: 'user-collect', action: 'extract', target: 'noteLink', value: 'noteLinks' },
        ],
        note_url: [
          { id: 'note-open', action: 'navigate', value: '{{input.noteUrl}}' },
          {
            id: 'note-await-detail',
            action: 'waitFor',
            target: 'noteTitle',
            expect: [{ selector: 'noteTitle' }],
            description: '直达详情页；随后引擎衔接 detail flow',
          },
        ],
      },
    },
    detail: {
      description: '笔记详情字段位点（标题/正文/互动数/标签/作者）',
      fields: {
        title: 'noteTitle',
        content: 'noteContent',
        likes: 'likeCount',
        collects: 'collectCount',
        comments: 'commentCount',
        tags: 'tagItem',
        author: 'authorName',
      },
      steps: [
        {
          id: 'detail-await',
          action: 'waitFor',
          target: 'noteTitle',
          expect: [{ selector: 'noteTitle' }],
        },
      ],
    },
  },

  // 登录入口特征 + 搜索框特征：激活前在 fixture 无害页回放（02:390）
  selfcheck: [
    {
      name: 'search-box-features',
      fixture: 'fixtures/search.html',
      expect: [{ selector: 'searchInput' }, { selector: 'searchButton' }],
      description: '搜索框特征',
    },
    {
      name: 'login-entry-feature',
      fixture: 'fixtures/search.html',
      expect: [{ selector: 'loginEntry' }],
      description: '登录入口特征（未登录态可见；兼作 todo-7 preflight 登录态探测特征）',
    },
  ],

  // M1 xhs 无发布/评论 flow，故无 nonReentrant 步骤、verify 为空
  verify: [],

  // 验证码容器特征（02:388：命中 → 风控信号 → 熔断器介入）
  blockedFeatures: [
    {
      name: 'captcha',
      selectors: ['captchaContainer', 'captchaIframe'],
      description: '验证码容器特征',
    },
  ],
} satisfies AdapterDslInput;
