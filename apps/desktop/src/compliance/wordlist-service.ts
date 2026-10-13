/**
 * 词库配置包服务（m1-insight-plan todo 10 = T-M1-08②；02:763 配置包路径）。
 *
 * 目录形态：`<root>/<semver>/wordlist.json` + `<root>/<semver>/manifest.json`
 *   （manifest = { version, sha256, effectiveAt }；sha256 是 wordlist.json 精确字节的摘要，
 *   加载期核验，不符=拒载该版本——last-good 保持，与 adapter-loader 回滚语义同型）。
 *
 * 活跃版本：kv_config 指针 `wordlist:active`（todo-6 kv 面消费）优先；指针缺失/指向损坏时
 * 取最高 semver（protocol compareSemver）。
 *
 * 热更：fs.watch（递归）→ 防抖 → reloadConfig()——bump 版本（写新目录 + 改指针）不重启进程
 * 即时生效；单测可直接调 reloadConfig 断言行为变化，另有 watch 触发链路专项用例。
 *
 * scanner 是纯函数（scanWithConfig / scanKeywordsWithConfig，本文件导出）：命中即记录一次
 * （同 kind|category|term 去重）；持久化不在 scanner 内——消费方（key-service.scanTest、
 * M1 报告⑦章过滤 todo-11、M3 三道闸）经注入 sink 落 keyword_hits（含 wordlist_version）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import {
  WORDLIST_CONFIG_FILE,
  WORDLIST_MANIFEST_FILE,
  WORDLIST_PATTERN_FLAGS,
  WordlistConfigSchema,
  WordlistManifestSchema,
  compareWordlistVersions,
  type WordlistConfig,
  type WordlistConfigInput,
  type WordlistScanHit,
} from '@xinglian/protocol';
import { SEMVER_RE } from '@xinglian/protocol';
import { KV_WORDLIST_ACTIVE } from '../main/key-service';
import { WORDLIST_SEED_V1 } from './wordlist-seed-v1';

export interface WordlistServiceDeps {
  /** `<userData>/config/wordlist` 根目录 */
  readonly root: string;
  readonly kvGet: (key: string) => Promise<string | Buffer | null>;
  readonly kvSet: (key: string, value: string | Buffer) => Promise<unknown>;
  /** 打包内置首版种子（缺省 = WORDLIST_SEED_V1；首启 ensureSeeded 落盘） */
  readonly seed?: WordlistConfigInput;
  /** 审计出口（main.ts 注入 logger；测试注入 spy） */
  readonly onAudit?: (msg: string, payload: Record<string, unknown>) => void;
  /** fs watch 开关（默认 true；需要确定性重载的单测可关掉只调 reloadConfig） */
  readonly watchEnabled?: boolean;
}

export interface WordlistService {
  /** 首次装载完成（resolves 为 active 版本或 null=无可用配置） */
  readonly whenReady: Promise<string | null>;
  activeVersion(): string | null;
  config(): WordlistConfig | null;
  /** 纯扫描：当前 active 配置下的命中（去重；不落库） */
  scanText(text: string): WordlistScanHit[];
  scanKeywords(keywords: string[]): WordlistScanHit[];
  /** 重扫版本目录并换装 active（不重启进程）；返回新 active 版本（失败保持 last-good 返回 null） */
  reloadConfig(): Promise<string | null>;
  /** 停掉 fs watcher（进程退出/测试收尾） */
  close(): void;
}

/** 把一个词库配置写为版本目录（wordlist.json + manifest.json；sha256=精确字节摘要） */
export function writeWordlistVersion(root: string, configInput: WordlistConfigInput): { version: string; dir: string } {
  const config = WordlistConfigSchema.parse(configInput);
  const dir = join(root, config.version);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, WORDLIST_CONFIG_FILE), bytes);
  const manifest = {
    version: config.version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    effectiveAt: config.effectiveAt,
  };
  writeFileSync(join(dir, WORDLIST_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { version: config.version, dir };
}

/** 装载单个版本目录：manifest 校验 + sha256 字节级核验 + 交叉一致性 */
export function loadWordlistVersion(dir: string): WordlistConfig {
  const manifest = WordlistManifestSchema.parse(JSON.parse(readFileSync(join(dir, WORDLIST_MANIFEST_FILE), 'utf8')));
  const bytes = readFileSync(join(dir, WORDLIST_CONFIG_FILE));
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== manifest.sha256) {
    throw new Error(`wordlist.json sha256 不符（期望 ${manifest.sha256.slice(0, 12)}…，实际 ${actualSha256.slice(0, 12)}…）`);
  }
  const config = WordlistConfigSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (config.version !== manifest.version || config.effectiveAt !== manifest.effectiveAt) {
    throw new Error('wordlist.json 与 manifest 的 version/effectiveAt 交叉不一致');
  }
  if (config.version !== dir.split(/[\\/]/).pop()) {
    throw new Error('版本目录名与 manifest.version 不一致');
  }
  return config;
}

/** 纯函数 scanner：文本 → 命中（同 kind|category|term 去重、保留首见序） */
export function scanWithConfig(config: WordlistConfig, text: string): WordlistScanHit[] {
  const seen = new Set<string>();
  const hits: WordlistScanHit[] = [];
  const push = (term: string, category: string | null, kind: WordlistScanHit['kind']): void => {
    const key = `${kind}|${category ?? ''}|${term}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ term, category, kind });
  };
  const lowerText = text.toLowerCase();
  for (const entry of config.extremeTerms) {
    if (lowerText.includes(entry.term.toLowerCase())) push(entry.term, entry.category, 'extreme');
  }
  for (const pattern of config.redirectPatterns) {
    // 逐扫描新建实例：'g' 标志 lastIndex 状态不复用，避免跨调用漏配
    const re = new RegExp(pattern.pattern, WORDLIST_PATTERN_FLAGS);
    const match = re.exec(text);
    if (match) push(match[0], null, 'redirect');
  }
  for (const blacklist of config.categoryBlacklist) {
    for (const keyword of blacklist.keywords) {
      if (text.includes(keyword)) {
        push(keyword, blacklist.id, 'blacklist');
        break;
      }
    }
  }
  return hits;
}

/** 纯函数 scanner（keywords[] 形态）：逐词独立扫描（报告⑦章关键词过滤的入口形态） */
export function scanKeywordsWithConfig(config: WordlistConfig, keywords: string[]): WordlistScanHit[] {
  const seen = new Set<string>();
  const hits: WordlistScanHit[] = [];
  for (const keyword of keywords) {
    for (const hit of scanWithConfig(config, keyword)) {
      const key = `${hit.kind}|${hit.category ?? ''}|${hit.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }
  return hits;
}

function listVersionDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SEMVER_RE.test(entry.name))
    .filter((entry) => existsSync(join(root, entry.name, WORDLIST_CONFIG_FILE)) && existsSync(join(root, entry.name, WORDLIST_MANIFEST_FILE)))
    .map((entry) => entry.name);
}

export function createWordlistService(deps: WordlistServiceDeps): WordlistService {
  const seed = deps.seed ?? WORDLIST_SEED_V1;
  const audit = (msg: string, payload: Record<string, unknown>): void => deps.onAudit?.(msg, payload);
  let active: { version: string; config: WordlistConfig } | null = null;
  let watcher: FSWatcher | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureSeeded(): void {
    const seedVersion = WordlistConfigSchema.parse(seed).version;
    const dir = join(deps.root, seedVersion);
    if (existsSync(join(dir, WORDLIST_MANIFEST_FILE))) return;
    writeWordlistVersion(deps.root, seed);
    audit('wordlist:seeded', { version: seedVersion });
  }

  async function reloadConfig(): Promise<string | null> {
    const versions = listVersionDirs(deps.root);
    if (versions.length === 0) {
      audit('wordlist:no-versions', { root: deps.root });
      return null;
    }
    // 指针读取/写回都按「尽力而为」处理：store 不可用（关闭/崩溃窗口）不产生未处理拒绝
    //（fs watch 与后台 whenReady 都是 void 调用面），降级为无指针 → 最高 semver 候选
    let pointer: string | null = null;
    try {
      const pointerRaw = await deps.kvGet(KV_WORDLIST_ACTIVE);
      if (typeof pointerRaw === 'string' && versions.includes(pointerRaw)) pointer = pointerRaw;
    } catch (error) {
      audit('wordlist:pointer-read-failed', { err: String((error as Error).message).slice(0, 200) });
    }
    const ordered = [...versions].sort((a, b) => compareWordlistVersions(b, a));
    const candidates = pointer ? [pointer, ...ordered.filter((v) => v !== pointer)] : ordered;
    for (const version of candidates) {
      try {
        const config = loadWordlistVersion(join(deps.root, version));
        active = { version, config };
        if (pointer === null) {
          // 无指针时把现值固化进 kv（首次启动/指针丢失自愈；显式 bump 仍以写指针为准）
          try {
            await deps.kvSet(KV_WORDLIST_ACTIVE, version);
          } catch (error) {
            audit('wordlist:pointer-write-failed', { version, err: String((error as Error).message).slice(0, 200) });
          }
        }
        audit('wordlist:activated', { version });
        return version;
      } catch (error) {
        audit('wordlist:version-rejected', { version, err: String((error as Error).message).slice(0, 200) });
      }
    }
    audit('wordlist:reload-kept-last-good', { previous: active?.version ?? null });
    return null;
  }

  function scheduleReload(): void {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void reloadConfig();
    }, 150);
    reloadTimer.unref?.();
  }

  const whenReady: Promise<string | null> = (async () => {
    try {
      ensureSeeded();
    } catch (error) {
      audit('wordlist:seed-failed', { err: String((error as Error).message).slice(0, 200) });
    }
    const version = await reloadConfig();
    if ((deps.watchEnabled ?? true) && watcher === null) {
      try {
        watcher = watch(deps.root, { recursive: true }, () => scheduleReload());
      } catch (error) {
        audit('wordlist:watch-failed', { err: String((error as Error).message).slice(0, 200) });
      }
    }
    return version;
  })();

  return {
    whenReady,
    activeVersion: () => active?.version ?? null,
    config: () => active?.config ?? null,
    scanText: (text) => (active ? scanWithConfig(active.config, text) : []),
    scanKeywords: (keywords) => (active ? scanKeywordsWithConfig(active.config, keywords) : []),
    reloadConfig,
    close: () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      watcher?.close();
      watcher = null;
    },
  };
}
