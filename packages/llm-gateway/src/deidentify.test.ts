/**
 * 去标识化 golden fixtures（todo 8 验收①：昵称→假名 8hex 稳定可重放、粉丝分桶、原文不动）。
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  followerBucket,
  pseudonymizeAuthor,
  deidentifyAuthor,
  deidentifyNoteForPayload,
  deidentifyNotesForPayload,
} from './deidentify.js';

const SALT = 'golden-salt-2026';

function expectPseudonym(raw: string): string {
  return `author_${createHash('sha256').update(`${SALT}\u0000${raw}`, 'utf8').digest('hex').slice(0, 8)}`;
}

describe('粉丝数量级分桶（<100/100-1k/1k-1w/1w+）', () => {
  it('golden 边界逐点命中', () => {
    expect(followerBucket(0)).toBe('<100');
    expect(followerBucket(99)).toBe('<100');
    expect(followerBucket(100)).toBe('100-1k');
    expect(followerBucket(999)).toBe('100-1k');
    expect(followerBucket(1000)).toBe('1k-1w');
    expect(followerBucket(9999)).toBe('1k-1w');
    expect(followerBucket(10000)).toBe('1w+');
    expect(followerBucket(1_234_567)).toBe('1w+');
  });

  it('脏值落 null（不抛错）', () => {
    expect(followerBucket(null)).toBeNull();
    expect(followerBucket(undefined)).toBeNull();
    expect(followerBucket(-5)).toBeNull();
    expect(followerBucket(Number.NaN)).toBeNull();
  });
});

describe('稳定假名（author_ + 盐哈希前 8 hex）', () => {
  it('同盐同值同假名，可重放', () => {
    expect(pseudonymizeAuthor('栗子拿铁不加糖', SALT)).toBe(expectPseudonym('栗子拿铁不加糖'));
    expect(pseudonymizeAuthor('栗子拿铁不加糖', SALT)).toBe(pseudonymizeAuthor('栗子拿铁不加糖', SALT));
  });

  it('不同值假名不同；不同盐假名不同（盐参与构建）', () => {
    expect(pseudonymizeAuthor('小红薯5C3F2A', SALT)).not.toBe(pseudonymizeAuthor('栗子拿铁不加糖', SALT));
    expect(pseudonymizeAuthor('小红薯5C3F2A', SALT)).not.toBe(pseudonymizeAuthor('小红薯5C3F2A', 'other-salt'));
  });

  it('假名格式恒为 author_+8hex（hex 字符集断言）', () => {
    const pseudo = pseudonymizeAuthor('某作者', SALT);
    expect(pseudo).toMatch(/^author_[0-9a-f]{8}$/);
  });
});

describe('deidentifyAuthor（author_json 清洗）', () => {
  it('golden fixture：昵称/ID 双假名 + 粉丝分桶 + 其余键整键丢弃（头像 URL 不出端）', () => {
    const author = {
      nickname: '栗子拿铁不加糖',
      userId: '5ff8a1b2c3d4e5f6',
      followerCount: 8600,
      avatarUrl: 'https://sns-img.example/secret.jpg',
      ipLocation: '浙江',
    };
    const cleaned = deidentifyAuthor(author, { salt: SALT });
    expect(cleaned).toEqual({
      nickname: expectPseudonym('栗子拿铁不加糖'),
      userId: expectPseudonym('5ff8a1b2c3d4e5f6'),
      followerTier: '1k-1w',
    });
    expect(JSON.stringify(cleaned)).not.toContain('secret.jpg');
    expect(JSON.stringify(cleaned)).not.toContain('浙江');
  });

  it('键名别名兼容（uid/fans/nick_name 等）', () => {
    const cleaned = deidentifyAuthor({ nick_name: '甲', uid: 'u-1', fans: 250 }, { salt: SALT });
    expect(cleaned.nickname).toBe(expectPseudonym('甲'));
    expect(cleaned.userId).toBe(expectPseudonym('u-1'));
    expect(cleaned.followerTier).toBe('100-1k');
  });

  it('粉丝数字符串形态可解析分桶', () => {
    expect(deidentifyAuthor({ followers: '2.3万' }, { salt: SALT }).followerTier).toBeNull();
    expect(deidentifyAuthor({ follower_count: '8000' }, { salt: SALT }).followerTier).toBe('1k-1w');
  });

  it('脏数据（null/数组/字符串）返回全 null 不抛错', () => {
    expect(deidentifyAuthor(null, { salt: SALT })).toEqual({ nickname: null, userId: null, followerTier: null });
    expect(deidentifyAuthor([1, 2], { salt: SALT })).toEqual({ nickname: null, userId: null, followerTier: null });
    expect(deidentifyAuthor('裸字符串', { salt: SALT })).toEqual({ nickname: null, userId: null, followerTier: null });
  });

  it('enabled=false 仅设置页显式关闭后使用：原值透传（语义与默认开启相反路径）', () => {
    const cleaned = deidentifyAuthor({ nickname: '真实昵称', followers: 50 }, { salt: SALT, enabled: false });
    expect(cleaned.nickname).toBe('真实昵称');
    expect(cleaned.followerTier).toBe('<100');
  });
});

describe('仅清洗发往 LLM 的 payload，本地原文不动', () => {
  const originalNote = {
    noteId: 'n01',
    title: '换季敏感肌急救分享',
    content: '泛红刺痛两周年，终于找到本命修护面霜',
    author: { nickname: '栗子拿铁不加糖', userId: '5ff8a1', followerCount: 8600, avatarUrl: 'https://x/y.jpg' },
    likes: 1200,
  };

  it('返回新对象，输入深度不变（原文不动断言）', () => {
    const snapshot = JSON.parse(JSON.stringify(originalNote));
    const payload = deidentifyNoteForPayload(originalNote, { salt: SALT });
    expect(payload.noteId).toBe('n01');
    expect(payload.title).toBe('换季敏感肌急救分享');
    expect(payload.author.nickname).toBe(expectPseudonym('栗子拿铁不加糖'));
    expect(payload.author).not.toBe(originalNote.author);
    expect(originalNote).toEqual(snapshot);
  });

  it('批量清洗：逐条假名稳定（同作者同假名）', () => {
    const notes = [
      { ...originalNote },
      { ...originalNote, noteId: 'n02', likes: 5 },
      { ...originalNote, noteId: 'n03', author: { nickname: '另一位', followerCount: 42 } },
    ];
    const payloads = deidentifyNotesForPayload(notes, { salt: SALT });
    const authorOf = (i: number) => payloads[i].author as unknown as { nickname: string; followerTier: string | null };
    expect(authorOf(0).nickname).toBe(authorOf(1).nickname);
    expect(authorOf(2).nickname).not.toBe(authorOf(0).nickname);
    expect(authorOf(2).followerTier).toBe('<100');
    expect(JSON.stringify(payloads)).not.toContain('栗子拿铁不加糖');
  });
});
