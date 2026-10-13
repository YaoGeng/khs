/**
 * 专用 Profile 目录解析（todo 10 = T-M0-08；FR-3.3 每平台独立 Profile 持久化登录态）。
 *
 * 目录形态：%LOCALAPPDATA%/<app>/cdp-profiles/<platform-subdir>/
 * （e2e/dev seam：XINGLIAN_CDP_PROFILE_ROOT 覆盖；生产由 main.ts 计算 localAppData 后传入。）
 *
 * 红线：专用目录绝不指向用户日常浏览器的默认 Profile（02 §5.1）——
 * resolvePlatformProfileDir 只在 profileRoot 之下拼接，路径穿越（../、盘符）一律拒绝。
 */
import path from 'node:path';

/** 平台 → Profile 子目录名（02 §5.2：二期多账号为 <platform>/<accountAlias>，M0 单层） */
const PLATFORM_SUBDIRS = { xhs: 'xiaohongshu', '1688': '1688' } as const;

export type PlatformSubdir = (typeof PLATFORM_SUBDIRS)[keyof typeof PLATFORM_SUBDIRS];

export function platformSubdir(platform: 'xhs' | '1688'): PlatformSubdir {
  return PLATFORM_SUBDIRS[platform];
}

export function resolveProfileRoot(options: { localAppData: string; override?: string | null }): string {
  if (options.override && options.override.trim().length > 0) return path.resolve(options.override);
  return path.join(options.localAppData, 'xinglian-workbench', 'cdp-profiles');
}

/**
 * 平台 Profile 目录（受控拼接：拒绝对默认 Profile 的任何引用与路径穿越）。
 * 登录态（Cookie/Storage）由浏览器自身落盘在该目录——客户端代码不读不写（FR-3.3/02 §5.2）。
 */
export function resolvePlatformProfileDir(profileRoot: string, platform: 'xhs' | '1688'): string {
  const subdir = platformSubdir(platform);
  const resolved = path.resolve(profileRoot, subdir);
  const resolvedRoot = path.resolve(profileRoot);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`E-BROWSER-PROFILE-BUSY: profile 目录越界（${resolved} 不在 ${resolvedRoot} 之下）`);
  }
  return resolved;
}
