/**
 * 词库配置包服务单测（m1 todo 10 = T-M1-08②验收）：seed→sha256 manifest→扫描命中/零误报、
 * 热更（reloadConfig 行为变化 + fs watch 触发）、损坏版本拒载保 last-good。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWordlistService,
  loadWordlistVersion,
  scanKeywordsWithConfig,
  scanWithConfig,
  writeWordlistVersion,
  type WordlistService,
} from './wordlist-service';
import { SCAN_CLEAN_TEXT, SCAN_FIXTURE_EXPECTED, SCAN_FIXTURE_TEXT } from './wordlist-fixture';
import type { WordlistConfigInput } from '@xinglian/protocol';

let root: string;
let services: WordlistService[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'xinglian-wordlist-'));
  services = [];
});

afterEach(() => {
  for (const service of services) service.close();
  rmSync(root, { recursive: true, force: true });
});

function makeKv(): {
  kvGet: (key: string) => Promise<string | Buffer | null>;
  kvSet: (key: string, value: string | Buffer) => Promise<unknown>;
  map: Map<string, string | Buffer>;
} {
  const map = new Map<string, string | Buffer>();
  return {
    map,
    kvGet: async (key) => map.get(key) ?? null,
    kvSet: async (key, value) => {
      map.set(key, value);
    },
  };
}

function makeService(options: { watchEnabled?: boolean; seed?: WordlistConfigInput } = {}): WordlistService & {
  audits: Array<{ msg: string; payload: Record<string, unknown> }>;
  kv: ReturnType<typeof makeKv>;
} {
  const kv = makeKv();
  const audits: Array<{ msg: string; payload: Record<string, unknown> }> = [];
  const service = createWordlistService({
    root,
    kvGet: kv.kvGet,
    kvSet: kv.kvSet,
    watchEnabled: options.watchEnabled ?? true,
    ...(options.seed ? { seed: options.seed } : {}),
    onAudit: (msg, payload) => audits.push({ msg, payload }),
  });
  const wrapped = Object.assign(service, { audits, kv });
  services.push(wrapped);
  return wrapped;
}

describe('seed 与装载（配置包路径 <root>/<semver>/wordlist.json + manifest）', () => {
  it('首启 seed 落盘：manifest.sha256 = wordlist.json 精确字节摘要，loadWordlistVersion 往返一致', async () => {
    const service = makeService();
    const version = await service.whenReady;
    expect(version).toBe('1.0.0');
    expect(service.activeVersion()).toBe('1.0.0');
    const config = service.config();
    expect(config).not.toBeNull();
    expect(config?.extremeTerms).toHaveLength(60);
    expect(config?.extremeTerms.every((t) => t.source.doc && t.source.clause)).toBe(true);
    const reloaded = loadWordlistVersion(path.join(root, '1.0.0'));
    expect(reloaded.version).toBe('1.0.0');
  });
});

describe('scanner 纯函数（验收②：极限词×3+导流变体×2+医疗类目×1 全命中；未命中零误报）', () => {
  it('fixture 全命中且顺序/kind/category 符合预期', async () => {
    const service = makeService();
    await service.whenReady;
    const hits = service.scanText(SCAN_FIXTURE_TEXT);
    expect(hits).toEqual(SCAN_FIXTURE_EXPECTED);
    expect(hits.filter((h) => h.kind === 'extreme')).toHaveLength(3);
    expect(hits.filter((h) => h.kind === 'redirect')).toHaveLength(2);
    expect(hits.filter((h) => h.kind === 'blacklist')).toHaveLength(1);
  });

  it('未命中样本零误报', async () => {
    const service = makeService();
    await service.whenReady;
    expect(service.scanText(SCAN_CLEAN_TEXT)).toEqual([]);
    expect(scanWithConfig(service.config()!, '')).toEqual([]);
  });

  it('keywords[] 形态：逐词独立扫描并去重（报告⑦章过滤入口形态）', async () => {
    const service = makeService();
    await service.whenReady;
    const hits = scanKeywordsWithConfig(service.config()!, ['最好', '最好', '热玛吉', '最好的热玛吉']);
    expect(hits).toEqual([
      { term: '最好', category: 'extreme-advertising', kind: 'extreme' },
      { term: '热玛吉', category: 'medical-cosmetic', kind: 'blacklist' },
    ]);
  });
});

describe('热更（验收③：bump manifest→reloadConfig→同输入命中行为改变且不重启进程）', () => {
  it('写 v1.1.0（移除「最好」+ 新增词）+ 指针 → reloadConfig 后行为即时改变', async () => {
    const service = makeService({ watchEnabled: false });
    await service.whenReady;
    const beforeBest = service.scanText('这款最好用');
    expect(beforeBest.map((h) => h.term)).toEqual(['最好']);
    expect(service.scanText('终极优惠来袭')).toEqual([]);

    const seed = service.config()!;
    const bumped: WordlistConfigInput = {
      ...seed,
      version: '1.1.0',
      effectiveAt: '2026-10-15T00:00:00.000Z',
      extremeTerms: [
        ...seed.extremeTerms.filter((t) => t.term !== '最好'),
        { term: '终极优惠', category: 'extreme-advertising', source: { doc: '01-需求说明书.md', clause: '§5.5-1', line: 331 } },
      ],
    };
    writeWordlistVersion(root, bumped);
    await service.kv.kvSet('wordlist:active', '1.1.0');
    const activated = await service.reloadConfig();
    expect(activated).toBe('1.1.0');
    expect(service.activeVersion()).toBe('1.1.0');
    // 同输入行为改变；进程/实例未重启（同一 service 引用继续可用）
    expect(service.scanText('这款最好用')).toEqual([]);
    expect(service.scanText('终极优惠来袭').map((h) => h.term)).toEqual(['终极优惠']);
  });

  it('fs watch 触发：只写盘+改指针（不手动 reloadConfig）→ active 版本自动跟随', async () => {
    const service = makeService();
    await service.whenReady;
    expect(service.activeVersion()).toBe('1.0.0');
    const seed = service.config()!;
    writeWordlistVersion(root, {
      ...seed,
      version: '1.1.0',
      effectiveAt: '2026-10-15T00:00:00.000Z',
      extremeTerms: seed.extremeTerms.filter((t) => t.term !== '最好'),
    });
    await service.kv.kvSet('wordlist:active', '1.1.0');
    // watch（150ms 防抖）应触发 reloadConfig——轮询等待，不手动调用
    const deadline = Date.now() + 10_000;
    while (service.activeVersion() !== '1.1.0' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(service.activeVersion()).toBe('1.1.0');
    expect(service.scanText('这款最好用')).toEqual([]);
  }, 20_000);

  it('版本损坏（wordlist.json 被篡改）→ sha256 拒载该版本，回退可用版本（last-good 语义）', async () => {
    const service = makeService({ watchEnabled: false });
    await service.whenReady;
    const seed = service.config()!;
    writeWordlistVersion(root, { ...seed, version: '1.1.0', effectiveAt: '2026-10-15T00:00:00.000Z' });
    // 篡改 v1.1.0 的 wordlist.json 一个字节（不更新 manifest）
    const target = path.join(root, '1.1.0', 'wordlist.json');
    const bytes = readFileSync(target);
    const copy = Buffer.from(bytes);
    copy[0] = copy[0] === 0x7b ? 0x7a : 0x7b; // 翻转首字节（{ <-> z）
    writeFileSync(target, copy);
    await service.kv.kvSet('wordlist:active', '1.1.0');
    const activated = await service.reloadConfig();
    expect(activated).toBe('1.0.0');
    expect(service.activeVersion()).toBe('1.0.0');
    expect(loadWordlistVersion(path.join(root, '1.0.0')).version).toBe('1.0.0');
  });
});
