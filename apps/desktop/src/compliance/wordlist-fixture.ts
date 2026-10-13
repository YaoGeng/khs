import type { WordlistScanHit } from '@xinglian/protocol';

/**
 * scanner 单测共享 fixture（m1 todo 10 = T-M1-08 验收②：极限词×3 + 导流变体×2 + 医疗类目×1）。
 * 文本同时对 v1 词库其余条目零误报（clean 断言共用 clean fixture）。
 */
export const SCAN_FIXTURE_TEXT =
  '这款面霜全网第一，效果最好，100%有效；好评如潮，加V：abc123 领优惠，或者薇信 xhs01；再推荐医美整形机构。';

export const SCAN_FIXTURE_EXPECTED: WordlistScanHit[] = [
  { term: '最好', category: 'extreme-advertising', kind: 'extreme' },
  { term: '全网第一', category: 'extreme-advertising', kind: 'extreme' },
  { term: '100%有效', category: 'extreme-advertising', kind: 'extreme' },
  { term: '加V', category: null, kind: 'redirect' },
  { term: '薇信', category: null, kind: 'redirect' },
  { term: '医美', category: 'medical-cosmetic', kind: 'blacklist' },
];

/** 未命中样本（零误报断言面）：不含任何 v1 极限词/导流变体/类目关键词 */
export const SCAN_CLEAN_TEXT = '这款面霜质地轻盈，适合日常保湿，包装也很好看，推荐给干皮姐妹。';
