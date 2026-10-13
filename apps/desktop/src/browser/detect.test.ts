/**
 * 浏览器探测纯函数单测（todo 10 = T-M0-08；FR-3.1 探测顺序：用户设置 → Chrome → Edge）。
 */
import { describe, expect, it } from 'vitest';
import { APP_PATHS_KEYS, buildCommonPaths, detectBrowser, type DetectDeps } from './detect';

const ROOTS = {
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  localAppData: 'C:\\Users\\me\\AppData\\Local',
};

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function makeDeps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  return {
    userSettingPath: null,
    registryQuery: async () => null,
    fileExists: () => false,
    roots: ROOTS,
    ...overrides,
  };
}

describe('探测顺序（FR-3.1：设置 > 注册表 > 常见路径；Chrome > Edge）', () => {
  it('1. 用户设置优先（存在且是 .exe）', async () => {
    const found = await detectBrowser(makeDeps({ userSettingPath: 'D:\\browsers\\chrome.exe', fileExists: () => true }));
    expect(found).toEqual({ kind: 'chrome', path: 'D:\\browsers\\chrome.exe', source: 'user-setting' });
  });

  it('1b. 用户设置为坏值（不存在/非 exe）不阻断自动探测', async () => {
    const found = await detectBrowser(
      makeDeps({
        userSettingPath: 'D:\\gone\\chrome.exe',
        registryQuery: async (key) => (key === APP_PATHS_KEYS.chrome[0] ? EDGE_EXE : null),
        fileExists: (p) => p === EDGE_EXE,
      }),
    );
    expect(found).toMatchObject({ kind: 'chrome', path: EDGE_EXE, source: 'registry' });
  });

  it('2. Chrome 注册表命中（HKLM App Paths）', async () => {
    const seen: string[] = [];
    const found = await detectBrowser(
      makeDeps({
        registryQuery: async (key) => {
          seen.push(key);
          return key === APP_PATHS_KEYS.chrome[0] ? CHROME_EXE : null;
        },
        fileExists: (p) => p === CHROME_EXE,
      }),
    );
    expect(found).toEqual({ kind: 'chrome', path: CHROME_EXE, source: 'registry' });
    expect(seen[0]).toBe(APP_PATHS_KEYS.chrome[0]);
  });

  it('2b. Chrome 注册表未命中 → 常见路径探测', async () => {
    const found = await detectBrowser(
      makeDeps({
        fileExists: (p) => p === `${ROOTS.programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      }),
    );
    expect(found).toEqual({
      kind: 'chrome',
      path: `${ROOTS.programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      source: 'path-probe',
    });
  });

  it('3. Chrome 全缺 → Edge（注册表 → 常见路径；S6 实测 Edge 为 x86 安装形态）', async () => {
    const found = await detectBrowser(
      makeDeps({
        registryQuery: async (key) => (key === APP_PATHS_KEYS.edge[0] ? EDGE_EXE : null),
        fileExists: (p) => p === EDGE_EXE,
      }),
    );
    expect(found).toEqual({ kind: 'edge', path: EDGE_EXE, source: 'registry' });
  });

  it('4. 全部未命中 → null（降级分支：M0 只记录不做便携 Chromium）', async () => {
    expect(await detectBrowser(makeDeps())).toBeNull();
  });
});

describe('buildCommonPaths（路径表）', () => {
  it('chrome 覆盖 ProgramFiles / x86 / LocalAppData 三处', () => {
    const paths = buildCommonPaths('chrome', ROOTS);
    expect(paths).toHaveLength(3);
    expect(paths.every((p) => p.endsWith('chrome.exe'))).toBe(true);
    expect(paths[0]).toContain('Program Files\\Google\\Chrome');
    expect(paths[2]).toContain('AppData\\Local\\Google\\Chrome');
  });

  it('edge x86 优先（S6 实测形态）', () => {
    const paths = buildCommonPaths('edge', ROOTS);
    expect(paths[0]).toBe('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  });
});
