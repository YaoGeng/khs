/**
 * 去标识化前置层（PC-03，06:54②/06:179；02 §4.2「调用前预处理去标识化（默认开启）」）。
 *
 * 规则（FR-5.1 第三方身份字段【作者昵称/ID/粉丝数】默认去标识化）：
 * - 昵称/ID → 「author_」+ sha256(本地盐 + 原值) 前 8 hex（本地可重放；盐不随 payload 出端，
 *   映射表不构建不存储不上传——单向不可逆）；
 * - 粉丝数 → 量级分桶（<100 / 100-1k / 1k-1w / 1w+）；
 * - 仅对发往 LLM 的 payload 清洗，本地 notes 原文不动（输入对象零改动，返回新对象）；
 * - author_json 中除白名单键外的其余键（头像 URL 等可再识别字段）整键丢弃（最小化 payload）。
 * 默认开启；enabled=false 仅供设置页「显式确认后关闭并留痕」的组合根使用（06:54②语义）。
 */
import { createHash } from 'node:crypto';

export type FollowerBucket = '<100' | '100-1k' | '1k-1w' | '1w+';

export interface DeidentifyOptions {
  /** 本地盐（组合根生成并持久化于本地；构建不可逆、不上传） */
  salt: string;
  /** 默认 true（默认开启语义）；false 时 author_json 原样透传 */
  enabled?: boolean;
}

export interface DeidentifiedAuthor {
  nickname: string | null;
  userId: string | null;
  followerTier: FollowerBucket | null;
}

/** author_json 的白名单键（多别名兼容常见采集形态；其余键一律丢弃） */
const NICKNAME_KEYS = ['nickname', 'nickName', 'nick_name'] as const;
const USER_ID_KEYS = ['userId', 'uid', 'authorId', 'user_id', 'author_id'] as const;
const FOLLOWER_KEYS = ['followerCount', 'followers', 'fans', 'follower_count'] as const;

/** 粉丝数量级分桶（边界：99→<100，100→100-1k，999→100-1k，1000→1k-1w，9999→1k-1w，10000→1w+） */
export function followerBucket(count: number | null | undefined): FollowerBucket | null {
  if (count == null || !Number.isFinite(count) || count < 0) return null;
  const n = Math.floor(count);
  if (n < 100) return '<100';
  if (n < 1000) return '100-1k';
  if (n < 10000) return '1k-1w';
  return '1w+';
}

/** 稳定假名：author_ + sha256(salt + '\u0000' + 原值) 前 8 hex（同盐同值同假名，可本地重放） */
export function pseudonymizeAuthor(rawValue: string, salt: string): string {
  const digest = createHash('sha256').update(`${salt}\u0000${rawValue}`, 'utf8').digest('hex');
  return `author_${digest.slice(0, 8)}`;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * author_json → 去标识化身份三元组。
 * 非 JSON 对象（脏数据）返回全 null，不抛错（采集字段不可信，清洗层宽容）。
 */
export function deidentifyAuthor(authorJson: unknown, options: DeidentifyOptions): DeidentifiedAuthor {
  if (options.enabled === false) {
    const source = (authorJson ?? null) as Record<string, unknown> | null;
    return {
      nickname: firstString(source ?? {}, NICKNAME_KEYS),
      userId: firstString(source ?? {}, USER_ID_KEYS),
      followerTier: followerBucket(source ? firstNumber(source, FOLLOWER_KEYS) : null),
    };
  }
  if (!authorJson || typeof authorJson !== 'object' || Array.isArray(authorJson)) {
    return { nickname: null, userId: null, followerTier: null };
  }
  const source = authorJson as Record<string, unknown>;
  const nickname = firstString(source, NICKNAME_KEYS);
  const userId = firstString(source, USER_ID_KEYS);
  return {
    nickname: nickname ? pseudonymizeAuthor(nickname, options.salt) : null,
    userId: userId ? pseudonymizeAuthor(userId, options.salt) : null,
    followerTier: followerBucket(firstNumber(source, FOLLOWER_KEYS)),
  };
}

/** 笔记发往 LLM 的 payload 形态：与 NoteRowView 同构，author 字段替换为去标识化三元组 */
export function deidentifyNoteForPayload<N extends { author?: unknown }>(note: N, options: DeidentifyOptions): N {
  return { ...note, author: deidentifyAuthor(note.author, options) };
}

export function deidentifyNotesForPayload<N extends { author?: unknown }>(notes: readonly N[], options: DeidentifyOptions): N[] {
  return notes.map((note) => deidentifyNoteForPayload(note, options));
}
