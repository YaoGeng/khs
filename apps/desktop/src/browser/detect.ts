/**
 * 浏览器探测纯函数（todo 10 = T-M0-08；FR-3.1；M2 B2 内置优先接入）。
 *
 * 探测顺序（02 §5.1 第 1 步 + m2-builtin-browser-plan B2）：用户设置 → 内置便携 Chromium
 * （deps.probeBuiltin，未装配/未安装返回 null）→ Chrome（注册表 → 常见路径）→ Edge（同法）
 * → 全空返回 null（调用方记录降级并引导内置下载，见 browser-service）。
 *
 * 本模块 electron-free 且 node-free（注册表/文件系统经 deps 注入），vitest 以 mock 直测。
 */

export type BrowserKind = 'chrome' | 'edge';
export type DetectSource = 'user-setting' | 'builtin' | 'registry' | 'path-probe';

export interface DetectedBrowser {
  readonly kind: BrowserKind | 'builtin';
  readonly path: string;
  readonly source: DetectSource;
}

export interface DetectDeps {
  /** 用户设置中的浏览器路径（M0：settings 存储暂无该字段时为 null；dev/test seam = XINGLIAN_BROWSER_PATH） */
  readonly userSettingPath: string | null;
  /** 读取注册表默认值（App Paths\<exe> /ve）；读不到返回 null */
  readonly registryQuery: (keyPath: string) => Promise<string | null>;
  /** 文件存在性判定 */
  readonly fileExists: (path: string) => boolean;
  /** 常见安装根目录（注入便于测试；生产 = process.env 展开） */
  readonly roots: DetectRoots;
  /** M2 B2：内置便携 Chromium 探测（marker+exe 校验；未装配/未安装 → null）。优先级在用户设置之后、Chrome 之前 */
  readonly probeBuiltin?: () => Promise<DetectedBrowser | null>;
}

export interface DetectRoots {
  readonly programFiles: string;
  readonly programFilesX86: string;
  readonly localAppData: string;
}

/** App Paths 注册表键（HKLM 优先、HKCU 兜底；02 §5.1 + 任务卡要求） */
export const APP_PATHS_KEYS: Record<BrowserKind, readonly string[]> = {
  chrome: [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ],
  edge: [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  ],
};

/** 常见安装路径（注册表未命中时逐个探测；Edge x86 安装形态由 S6 实测存在） */
export function buildCommonPaths(kind: BrowserKind, roots: DetectRoots): string[] {
  if (kind === 'chrome') {
    return [
      `${roots.programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${roots.programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${roots.localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
  }
  return [
    `${roots.programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${roots.programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${roots.localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
}

function isFileCandidate(path: string): boolean {
  return /\.exe$/i.test(path);
}

/** 单一浏览器种类的探测：用户设置由调用方先行处理，这里只做注册表 → 常见路径 */
async function detectKind(kind: BrowserKind, deps: DetectDeps): Promise<DetectedBrowser | null> {
  for (const key of APP_PATHS_KEYS[kind]) {
    const value = await deps.registryQuery(key);
    if (value && isFileCandidate(value) && deps.fileExists(value)) {
      return { kind, path: value, source: 'registry' };
    }
  }
  for (const candidate of buildCommonPaths(kind, deps.roots)) {
    if (deps.fileExists(candidate)) {
      return { kind, path: candidate, source: 'path-probe' };
    }
  }
  return null;
}

/**
 * 完整探测链（FR-3.1 + M2 B2）：
 * 1. 用户设置（显式路径必须存在且是 .exe，否则继续往下探测——坏设置不阻断自动探测）；
 * 2. 内置便携 Chromium（deps.probeBuiltin 未装配则跳过）；
 * 3. Chrome → 4. Edge；全空返回 null。
 */
export async function detectBrowser(deps: DetectDeps): Promise<DetectedBrowser | null> {
  if (deps.userSettingPath && isFileCandidate(deps.userSettingPath) && deps.fileExists(deps.userSettingPath)) {
    const lower = deps.userSettingPath.toLowerCase();
    const kind: BrowserKind = lower.includes('msedge') ? 'edge' : 'chrome';
    return { kind, path: deps.userSettingPath, source: 'user-setting' };
  }
  if (deps.probeBuiltin) {
    const builtin = await deps.probeBuiltin();
    if (builtin) return builtin;
  }
  for (const kind of ['chrome', 'edge'] as const) {
    const found = await detectKind(kind, deps);
    if (found) return found;
  }
  return null;
}
