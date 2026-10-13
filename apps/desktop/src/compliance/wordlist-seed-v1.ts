import type { WordlistConfigInput } from '@xinglian/protocol';

/**
 * 词库首版 v1 种子内容（m1 todo 10 = T-M1-08②；人工白名单④——用户复核勾选记录见
 * .omo/evidence/m1-insight-plan/wordlist-review-checklist.md，非阻塞）。
 *
 * 起草依据（条款行号引用，至少分类级）：
 * - 极限词三分类依据 01-需求说明书.md:331（§5.5-1：广告法极限词/医疗功效词/金融承诺词）；
 * - 导流变体依据 08-参考-小红书社区规范.md:138-140（3.2.1 个人联系方式 / 3.2.2 其他平台
 *   联系方式），适用范围=文案与评论（09:55-59 XHS-03 修订口径）；
 * - 类目黑名单依据 01:333（§5.5-3 涉政时事）+ 08:132（3.1.3 医美整形/医疗器械）+
 *   08:88（2.3.1 处方药物/投资理财/烟草等违禁物品）。
 *
 * 运行态落 `<userData>/config/wordlist/<semver>/wordlist.json`（wordlist-service ensureSeeded）。
 */
export const WORDLIST_SEED_V1: WordlistConfigInput = {
  kind: 'wordlist',
  version: '1.0.0',
  effectiveAt: '2026-10-14T00:00:00.000Z',
  extremeTerms: [
    // ---- 广告法极限词（extreme-advertising；分类级引用 01:331 §5.5-1） ----
    { term: '最好', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最佳', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最优', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最强', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最高级', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最先进', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最便宜', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最专业', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最大程度', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最全', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '最新科技', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '第一名', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '全国第一', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '全球第一', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '全网第一', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '销量第一', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '行业第一', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '国家级', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '世界级', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '顶级', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '顶尖', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '王牌', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '独家', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '独创', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '唯一', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '首个', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '首选', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '首家', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '绝无仅有', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '史上最低', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '万能', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '百分百有效', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '100%有效', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '零投诉', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    // ---- 医疗功效词（medical-efficacy；分类级引用 01:331 §5.5-1，涉医疗宣称同步对应 08:132 3.1.3 风险） ----
    { term: '根治', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '治愈', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '彻底根治', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '药到病除', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '包治百病', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '立即见效', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '治愈率', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '无效退款', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '消炎杀菌', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '特效药', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '临床验证', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '医生推荐', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '医用级修复', category: 'medical-efficacy', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    // ---- 金融承诺词（financial-promise；分类级引用 01:331 §5.5-1，涉金融产品同步对应 08:88 2.3.1 风险） ----
    { term: '稳赚不赔', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '保本保息', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '零风险', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '稳赚', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '包赚', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '躺赚', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '暴富', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '翻倍收益', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '内部消息', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '零风险高收益', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '收益率保证', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '无风险套利', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
    { term: '投资必赚', category: 'financial-promise', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
  ],
  redirectPatterns: [
    {
      id: 'phone-direct',
      label: '手机号明文（11 位）',
      pattern: '1[3-9]\\d{9}',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1', line: 138 },
    },
    {
      id: 'phone-symbol-spaced',
      label: '手机号符号穿插/分段的变体',
      pattern: '1[3-9][\\d\\s·•*\\-_—]{9,17}',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1', line: 138 },
    },
    {
      id: 'wechat-verb',
      label: '加V/加微信类动词诱导（含符号穿插）',
      pattern: '(加|微|私|戳|联系)[\\s:：*·]*([vV信我]|信我|wx|WX|薇|威)',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1', line: 138 },
    },
    {
      id: 'wechat-homophone',
      label: '微信谐音变体（薇信/威信/V信/vx 等）',
      pattern: '(薇信|威信|微芯|薇芯|V信|vx号|VX号|vx[:：]|VX[:：]|微✉|➕V|➕微)',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1', line: 138 },
    },
    {
      id: 'qq-number',
      label: 'QQ 号联系方式',
      pattern: '[QqＱ]{2}\\s*[:：]?(号)?\\s*\\d{5,12}',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1', line: 138 },
    },
    {
      id: 'email',
      label: '邮箱联系方式',
      pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1', line: 138 },
    },
    {
      id: 'url',
      label: '网址链接导流（3.2.2）',
      pattern: '(https?://|www\\.)[^\\s　，。]+',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.2', line: 140 },
    },
    {
      id: 'qrcode',
      label: '二维码/扫码导流（3.2.2）',
      pattern: '(二维码|扫一扫|扫码关注|扫码加|扫码进群)',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.2', line: 140 },
    },
    {
      id: 'watermark',
      label: '水印导流（3.2.2）',
      pattern: '(水印号|加水印留|水印联系方式)',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.2', line: 140 },
    },
    {
      id: 'emoji-insert',
      label: 'emoji 隔断式穿插变体（加→📩→V）',
      pattern: '(加|微)\\s*[\\p{Extended_Pictographic}]\\s*[vV信]',
      appliesTo: ['copy', 'comment'],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.2.1', line: 138 },
    },
  ],
  categoryBlacklist: [
    {
      id: 'politics-current-affairs',
      label: '涉政时事',
      keywords: [
        '时政', '政治', '领导人', '游行集会', '暴恐', '恐怖袭击', '民族分裂', '宗教极端', '涉军', '国家机密', '造谣',
      ],
      source: { doc: '01-需求说明书.md', clause: '§5.5-3', line: 333 },
    },
    {
      id: 'medical-cosmetic',
      label: '医美整形（08 3.1.3）',
      keywords: [
        '医美', '整形', '隆鼻', '双眼皮手术', '抽脂', '吸脂', '隆胸', '瘦脸针', '玻尿酸注射', '热玛吉', '超声炮', '水光针',
      ],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.1.3', line: 132 },
    },
    {
      id: 'medical-device',
      label: '医疗器械（08 3.1.3）',
      keywords: [
        '医疗器械', '血糖仪', '检测试纸', '家用呼吸机', '雾化器', '助听器', '隐形眼镜', '注射器',
      ],
      source: { doc: '08-参考-小红书社区规范.md', clause: '3.1.3', line: 132 },
    },
    {
      id: 'finance-investment',
      label: '金融投资（08 2.3.1 投资理财产品）',
      keywords: [
        '投资理财', '理财产品', '荐股', '股票推荐', '期货开户', '外汇平台', '虚拟币', '比特币', '炒币', 'P2P', '放贷',
      ],
      source: { doc: '08-参考-小红书社区规范.md', clause: '2.3.1', line: 88 },
    },
    {
      id: 'prohibited-items',
      label: '违禁物品（08 2.3.1）',
      keywords: [
        '处方药', '处方药物', '烟草', '香烟', '电子烟', '大麻', '鸦片', '假币', '枪支', '弹药', '爆炸物', '违禁药物', '翻墙软件', '外挂程序',
      ],
      source: { doc: '08-参考-小红书社区规范.md', clause: '2.3.1', line: 88 },
    },
  ],
};
