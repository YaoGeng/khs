/**
 * builtin 单测（B1）：全假注入，无网络无磁盘依赖（plan §2 B1 边界：单测全假注入）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_CHROMIUM_REVISION,
  BUILTIN_CHROMIUM_SHA256,
  BUILTIN_CHROMIUM_ZIP_BYTES,
  BUILTIN_EXE_RELATIVE,
  builtinExePath,
  builtinRevisionDir,
  builtinZipUrl,
  installBuiltinBrowser,
  probeBuiltinBrowser,
  type BuiltinDeps,
} from './builtin';

const PIN = BUILTIN_CHROMIUM_SHA256;

interface FakeState {
  files: Map<string, string>;
  extractedDirs: Set<string>;
  downloads: string[];
  extracts: Array<{ zip: string; dest: string }>;
  hashByPath: Map<string, string>;
  freeBytes: number;
  diskThrows: boolean;
  renames: Array<{ src: string; dest: string }>;
}

function makeDeps(state: FakeState, hashForZip: () => string): BuiltinDeps {
  return {
    fileExists: (p) => state.files.has(p) || state.extractedDirs.has(p),
    readFile: async (p) => state.files.get(p) ?? null,
    writeFile: async (p, c) => {
      state.files.set(p, c);
    },
    download: async (url, dest) => {
      state.downloads.push(url);
      state.files.set(dest, 'zip-bytes');
      state.hashByPath.set(dest, hashForZip());
    },
    sha256File: async (p) => state.hashByPath.get(p) ?? PIN,
    extractZip: async (zip, dest) => {
      state.extracts.push({ zip, dest });
      state.extractedDirs.add(dest);
      state.files.set(`${dest}\\${BUILTIN_EXE_RELATIVE}`, 'exe');
    },
    diskFreeBytes: async () => {
      if (state.diskThrows) throw new Error('statfs unavailable');
      return state.freeBytes;
    },
    rmPath: async (p) => {
      // 模拟真实 fs.rm 递归语义：按前缀清除该路径下所有文件与目录记录
      for (const k of [...state.files.keys()]) {
        if (k === p || k.startsWith(`${p}\\`)) {
          state.files.delete(k);
          state.hashByPath.delete(k);
        }
      }
      for (const d of [...state.extractedDirs]) {
        if (d === p || d.startsWith(`${p}\\`)) state.extractedDirs.delete(d);
      }
    },
    rename: async (src, dest) => {
      state.renames.push({ src, dest });
      state.extractedDirs.delete(src);
      state.extractedDirs.add(dest);
    },
    mkdir: async () => {},
    nowIso: () => '2026-10-16T00:00:00.000Z',
  };
}

const ROOT = 'C:\\browsers';
const DIR = builtinRevisionDir(ROOT);
const EXE = builtinExePath(ROOT);
const MARKER = `${DIR}\\install.json`;

function freshState(): FakeState {
  return {
    files: new Map(),
    extractedDirs: new Set(),
    downloads: [],
    extracts: [],
    hashByPath: new Map(),
    freeBytes: BUILTIN_CHROMIUM_ZIP_BYTES * 4,
    diskThrows: false,
    renames: [],
  };
}

describe('builtin：URL 与路径组装', () => {
  it('快照 URL 指向 npmmirror Win_x64/<rev>/chrome-win.zip', () => {
    expect(builtinZipUrl()).toBe(
      `https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Win_x64/${BUILTIN_CHROMIUM_REVISION}/chrome-win.zip`,
    );
  });

  it('双 pin 常量齐备（revision/SHA-256 64hex/字节数）', () => {
    expect(BUILTIN_CHROMIUM_REVISION).toMatch(/^\d+$/);
    expect(BUILTIN_CHROMIUM_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(BUILTIN_CHROMIUM_ZIP_BYTES).toBeGreaterThan(100_000_000);
  });

  it('browsersRoot：override 优先，默认与 cdp-profiles 同根', () => {
    expect(builtinExePath('X')).toBe(`X\\chromium-${BUILTIN_CHROMIUM_REVISION}\\chrome-win\\chrome.exe`);
  });
});

describe('builtin：幂等安装检测', () => {
  it('exe + 标记均匹配 → already-installed，零下载', async () => {
    const state = freshState();
    state.files.set(EXE, 'exe');
    state.files.set(
      MARKER,
      JSON.stringify({ revision: BUILTIN_CHROMIUM_REVISION, sha256: PIN, zipBytes: BUILTIN_CHROMIUM_ZIP_BYTES, installedAt: 'x' }),
    );
    const deps = makeDeps(state, () => PIN);
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result).toEqual({ status: 'already-installed', exePath: EXE });
    expect(state.downloads).toHaveLength(0);
  });

  it('标记存在但 exe 丢失 → 重装', async () => {
    const state = freshState();
    state.files.set(
      MARKER,
      JSON.stringify({ revision: BUILTIN_CHROMIUM_REVISION, sha256: PIN, zipBytes: BUILTIN_CHROMIUM_ZIP_BYTES, installedAt: 'x' }),
    );
    const deps = makeDeps(state, () => PIN);
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result.status).toBe('installed');
    expect(state.downloads).toHaveLength(1);
  });

  it('标记损坏/revision 陈旧 → 重装', async () => {
    const state = freshState();
    state.files.set(EXE, 'exe');
    state.files.set(MARKER, '{broken json');
    const deps = makeDeps(state, () => PIN);
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result.status).toBe('installed');
    expect(state.downloads).toHaveLength(1);
  });
});

describe('builtin：安装主流程', () => {
  it('全新安装：下载→哈希→解压→rename→标记→返回 installed', async () => {
    const state = freshState();
    const deps = makeDeps(state, () => PIN);
    const progress: number[] = [];
    const result = await installBuiltinBrowser(ROOT, deps, (n) => progress.push(n));
    expect(result).toEqual({ status: 'installed', exePath: EXE, sha256: PIN });
    expect(state.downloads).toEqual([builtinZipUrl()]);
    expect(state.extracts).toHaveLength(1);
    expect(state.renames).toEqual([{ src: `${ROOT}\\chromium-${BUILTIN_CHROMIUM_REVISION}.extract-tmp`, dest: DIR }]);
    expect(JSON.parse(state.files.get(MARKER)!)).toMatchObject({ revision: BUILTIN_CHROMIUM_REVISION, sha256: PIN });
    // 临时产物清理：zipTmp 随 rmPath(dir) 递归删除
    expect(state.files.has(`${DIR}\\chrome-win.zip.download`)).toBe(false);
  });

  it('哈希不符：重试至上限 3 次全失败 → E-BUILTIN-HASH-MISMATCH，不落盘不 rename', async () => {
    const state = freshState();
    const deps = makeDeps(state, () => 'deadbeef'.repeat(8));
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result).toMatchObject({ status: 'failed', code: 'E-BUILTIN-HASH-MISMATCH', attempts: 3 });
    expect(state.downloads).toHaveLength(3);
    expect(state.renames).toHaveLength(0);
    expect(state.files.has(MARKER)).toBe(false);
    expect(state.extractedDirs.has(DIR)).toBe(false);
  });

  it('第 2 次哈希命中 → 成功且共下载 2 次', async () => {
    const state = freshState();
    let call = 0;
    const deps = makeDeps(state, () => (++call === 1 ? 'aa'.repeat(32) : PIN));
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result.status).toBe('installed');
    expect(state.downloads).toHaveLength(2);
  });

  it('解压后缺 chrome.exe → E-BUILTIN-EXTRACT-INCOMPLETE 且清理临时目录', async () => {
    const state = freshState();
    const deps = makeDeps(state, () => PIN);
    // 覆盖 extractZip：不产出 exe
    deps.extractZip = async () => {};
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result).toMatchObject({ status: 'failed', code: 'E-BUILTIN-EXTRACT-INCOMPLETE', attempts: 1 });
    expect(state.renames).toHaveLength(0);
  });

  it('磁盘空闲 < 2× 包体 → E-BUILTIN-DISK-INSUFFICIENT，零下载', async () => {
    const state = freshState();
    state.freeBytes = BUILTIN_CHROMIUM_ZIP_BYTES * 2 - 1;
    const deps = makeDeps(state, () => PIN);
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result).toMatchObject({ status: 'failed', code: 'E-BUILTIN-DISK-INSUFFICIENT', attempts: 0 });
    expect(state.downloads).toHaveLength(0);
  });

  it('磁盘空闲不可测 → E-BUILTIN-DISK-UNKNOWN', async () => {
    const state = freshState();
    state.diskThrows = true;
    const deps = makeDeps(state, () => PIN);
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result).toMatchObject({ status: 'failed', code: 'E-BUILTIN-DISK-UNKNOWN' });
    expect(state.downloads).toHaveLength(0);
  });

  it('重装路径（升级/损坏修复）：先清 revision 目录再 rename，不留旧 marker 冲突', async () => {
    const state = freshState();
    state.files.set(EXE, 'old-exe');
    state.files.set(MARKER, '{stale');
    const deps = makeDeps(state, () => PIN);
    const result = await installBuiltinBrowser(ROOT, deps);
    expect(result.status).toBe('installed');
    // rmPath(dir) 递归清旧目录（含旧 exe/marker），extract-tmp 同级落位后 rename
    expect(state.renames).toEqual([{ src: `${ROOT}\\chromium-${BUILTIN_CHROMIUM_REVISION}.extract-tmp`, dest: DIR }]);
    expect(JSON.parse(state.files.get(MARKER)!).installedAt).toBe('2026-10-16T00:00:00.000Z');
  });
});

describe('builtin：probe（B2 探测面）', () => {
  it('已安装 → 返回 probe；未安装 → null', async () => {
    const state = freshState();
    const deps = makeDeps(state, () => PIN);
    expect(await probeBuiltinBrowser(ROOT, deps)).toBeNull();
    state.files.set(EXE, 'exe');
    state.files.set(
      MARKER,
      JSON.stringify({ revision: BUILTIN_CHROMIUM_REVISION, sha256: PIN, zipBytes: BUILTIN_CHROMIUM_ZIP_BYTES, installedAt: 'x' }),
    );
    expect(await probeBuiltinBrowser(ROOT, deps)).toEqual({ kind: 'builtin', revision: BUILTIN_CHROMIUM_REVISION, exePath: EXE });
  });
});
