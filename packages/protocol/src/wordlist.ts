import { z } from 'zod';
import { SEMVER_RE, SHA256_RE, compareSemver } from './dsl.js';

/**
 * 词库配置包契约 v1（m1-insight-plan todo 10 = T-M1-08②；01:331-334 §5.5 三件套）。
 *
 * 配置包路径（02:763）：`<userData>/config/wordlist/<semver>/wordlist.json`
 *   + manifest.json { version, sha256, effectiveAt }（计划文字 effective_at 的代码形态，
 *   与仓库 zod 风格一致取 camelCase）。
 *
 * 三件套（01 §5.5）：
 * - extremeTerms：广告法极限词/医疗功效词/金融承诺词（01:331 §5.5-1）；
 * - redirectPatterns：导流变体正则集（谐音/符号穿插/emoji 替换；01:332 §5.5-2），
 *   适用范围=文案与评论（09:55-59 XHS-03 修订口径）；
 * - categoryBlacklist：涉政时事 / 医疗（含医美整形、医疗器械，08:132 3.1.3）/
 *   金融投资与违禁物品（08:88 2.3.1）（01:333 §5.5-3）。
 *
 * 安全边界与 DSL 同款：pattern 是纯数据正则源码字符串（加载期必须可编译），不含可执行 JS。
 * 每条内容必须带 source（doc + clause [+ line]）——至少分类级条款引用，可追溯（人工白名单④复核）。
 */

/** 条款出处引用（可追溯性：分类级引用起步，能到行号更好） */
export const WordlistSourceSchema = z.strictObject({
  /** 基线文档文件名（如 '08-参考-小红书社区规范.md'） */
  doc: z.string().min(1),
  /** 条款号（如 '2.3.1'、'3.1.3'、'§5.5-1'） */
  clause: z.string().min(1),
  /** 基线文档行号（可选，起草时尽量给） */
  line: z.number().int().positive().optional(),
});
export type WordlistSource = z.infer<typeof WordlistSourceSchema>;

/** §5.5-1 极限词三类：广告法极限 / 医疗功效 / 金融承诺 */
export const EXTREME_TERM_CATEGORIES = ['extreme-advertising', 'medical-efficacy', 'financial-promise'] as const;
export type ExtremeTermCategory = (typeof EXTREME_TERM_CATEGORIES)[number];

export const WordlistExtremeTermSchema = z.strictObject({
  term: z.string().min(1).max(64),
  category: z.enum(EXTREME_TERM_CATEGORIES),
  source: WordlistSourceSchema,
  note: z.string().max(200).optional(),
});
export type WordlistExtremeTerm = z.infer<typeof WordlistExtremeTermSchema>;

/** 导流变体适用范围（09:55-59 XHS-03 修订口径：文案与评论） */
export const REDIRECT_APPLIES_TO = ['copy', 'comment'] as const;
export type RedirectAppliesTo = (typeof REDIRECT_APPLIES_TO)[number];

export const WordlistRedirectPatternSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  /** JS 正则源码（不含定界符与 flags；加载期以 'gui' 编译校验，编译失败=包拒绝） */
  pattern: z.string().min(1).max(500),
  appliesTo: z.array(z.enum(REDIRECT_APPLIES_TO)).min(1),
  source: WordlistSourceSchema,
});
export type WordlistRedirectPattern = z.infer<typeof WordlistRedirectPatternSchema>;

/** 类目黑名单（01:333 §5.5-3；条款出处见各 id 注释） */
export const CATEGORY_BLACKLIST_IDS = [
  'politics-current-affairs',
  'medical-cosmetic',
  'medical-device',
  'finance-investment',
  'prohibited-items',
] as const;
export type CategoryBlacklistId = (typeof CATEGORY_BLACKLIST_IDS)[number];

export const WordlistCategoryBlacklistSchema = z.strictObject({
  id: z.enum(CATEGORY_BLACKLIST_IDS),
  label: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1).max(64)).min(1),
  source: WordlistSourceSchema,
});
export type WordlistCategoryBlacklist = z.infer<typeof WordlistCategoryBlacklistSchema>;

/** 导流正则统一编译 flags（u 支撑 \p{...} 码点类；i 只影响 ASCII） */
export const WORDLIST_PATTERN_FLAGS = 'gui';

/** 词库配置包顶层 schema（wordlist.json）。加载期校验前置：pattern 必须可编译。 */
export const WordlistConfigSchema = z
  .strictObject({
    kind: z.literal('wordlist'),
    version: z.string().regex(SEMVER_RE, 'version 必须是合法 semver'),
    effectiveAt: z.string().min(1),
    extremeTerms: z.array(WordlistExtremeTermSchema).min(1),
    redirectPatterns: z.array(WordlistRedirectPatternSchema),
    categoryBlacklist: z.array(WordlistCategoryBlacklistSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const [i, pattern] of config.redirectPatterns.entries()) {
      if (ids.has(pattern.id)) {
        ctx.addIssue({ code: 'custom', message: `redirectPatterns.id 重复: ${pattern.id}`, path: ['redirectPatterns', i, 'id'] });
      }
      ids.add(pattern.id);
      try {
        // eslint-disable-next-line no-new
        new RegExp(pattern.pattern, WORDLIST_PATTERN_FLAGS);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: `redirectPatterns[${i}] (${pattern.id}) 正则不可编译: ${String((error as Error).message)}`,
          path: ['redirectPatterns', i, 'pattern'],
        });
      }
    }
    const blacklistIds = new Set<string>();
    for (const [i, entry] of config.categoryBlacklist.entries()) {
      if (blacklistIds.has(entry.id)) {
        ctx.addIssue({ code: 'custom', message: `categoryBlacklist.id 重复: ${entry.id}`, path: ['categoryBlacklist', i, 'id'] });
      }
      blacklistIds.add(entry.id);
    }
  });
export type WordlistConfig = z.infer<typeof WordlistConfigSchema>;
export type WordlistConfigInput = z.input<typeof WordlistConfigSchema>;

/** manifest.json（与 wordlist.json 的 version / effectiveAt 交叉一致由加载器核对） */
export const WordlistManifestSchema = z.strictObject({
  version: z.string().regex(SEMVER_RE, 'version 必须是合法 semver'),
  /** wordlist.json 精确字节的 sha256（64 hex）——完整性核验，不符=拒载（保 last-good） */
  sha256: z.string().regex(SHA256_RE, 'sha256 必须是 64 位 hex'),
  effectiveAt: z.string().min(1),
});
export type WordlistManifest = z.infer<typeof WordlistManifestSchema>;

export const WORDLIST_CONFIG_FILE = 'wordlist.json';
export const WORDLIST_MANIFEST_FILE = 'manifest.json';

/** 词库版本目录间比较：protocol dsl 的 semver 比较器复用（词库 bump 选择/降级排序共用） */
export function compareWordlistVersions(a: string, b: string): number {
  return compareSemver(a, b);
}

/** scan 命中（纯数据出口；kind 标明命中来源，term 为命中词/正则 label 的命中文本） */
export interface WordlistScanHit {
  /** 命中词（极限词/类目关键词）或导流变体命中的文本片段 */
  term: string;
  /** 极限词分类或类目黑名单 id；导流变体为 null */
  category: string | null;
  kind: 'extreme' | 'redirect' | 'blacklist';
}
