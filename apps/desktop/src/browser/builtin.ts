/**
 * 内置便携 Chromium 安装/校验模块（m2-builtin-browser-plan B1；docs/adr/notes-browser-builtin.md）。
 *
 * **纯增量**：本模块不接线 detect/launcher（接线归 B2），生产入口见文末 prod 适配器
 * （node 依赖只出现在适配器段，核心编排函数全注入、electron-free，vitest 全假注入直测）。
 *
 * 双 pin（revision + 包体 SHA-256/字节数）写死于常量；更新策略 = 应用发版携带新 pin，
 * 不做运行时自动跟版。来源：npmmirror chromium-browser-snapshots（中国镜像，仓内既定模式）。
 * 真实 pin 由一次性下载计算留证（scripts 与证据归 B4；.omo/evidence/m2-builtin-browser/）。
 */

/** npmmirror 快照基座（Win_x64；备源 Google 快照境内通常不可达，仅文档记录不依赖） */
export const BUILTIN_SNAPSHOT_BASE = 'https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Win_x64';

/** 双 pin：revision + 包体 SHA-256 + 包体字节数（2026-10-16 一次性真实下载计算留证，见 B4 证据） */
export const BUILTIN_CHROMIUM_REVISION = '1710741';
export const BUILTIN_CHROMIUM_SHA256 = '5b5f9d389007ad17e8b9246312ed459cf2f2e5b4c353909709fb0705b30cfe78';
export const BUILTIN_CHROMIUM_ZIP_BYTES = 360101018;

/** 安装包体内文件布局（快照 zip 解压后的固定相对路径；Windows 路径语义用反斜杠拼接） */
export const BUILTIN_EXE_RELATIVE = 'chrome-win\\chrome.exe';

/** 下载/校验失败重试上限（含首次；plan §1：不符删除重下上限 3 次 → 仍败由 B2 降级用户浏览器） */
export const BUILTIN_MAX_ATTEMPTS = 3;

/** 磁盘预检倍率（plan §1：≥2× 包体） */
export const BUILTIN_DISK_HEADROOM = 2;

/** 组装快照 zip 下载 URL（B1 导出便于 B2/e2e 断言） */
export function builtinZipUrl(revision: string = BUILTIN_CHROMIUM_REVISION): string {
  return `${BUILTIN_SNAPSHOT_BASE}/${revision}/chrome-win.zip`;
}

/**
 * 存储根（plan §1：与 cdp-profiles 同根；XINGLIAN_BUILTIN_BROWSER_ROOT 为 dev/e2e seam）。
 * 生产：%LOCALAPPDATA%/xinglian-workbench/browsers
 */
export function builtinBrowsersRoot(localAppData: string, override: string | null): string {
  if (override) return override;
  return `${localAppData}\\xinglian-workbench\\browsers`;
}

/** 单 revision 安装目录（<root>/chromium-<rev>） */
export function builtinRevisionDir(browsersRoot: string, revision: string = BUILTIN_CHROMIUM_REVISION): string {
  return `${browsersRoot}\\chromium-${revision}`;
}

/** 目标 exe 绝对路径 */
export function builtinExePath(browsersRoot: string, revision: string = BUILTIN_CHROMIUM_REVISION): string {
  return `${builtinRevisionDir(browsersRoot, revision)}\\${BUILTIN_EXE_RELATIVE}`;
}

/** 安装标记（zip 哈希只在下载期可验；落盘后以标记文件承载记录供幂等判定） */
export interface BuiltinInstallMarker {
  readonly revision: string;
  readonly sha256: string;
  readonly zipBytes: number;
  readonly installedAt: string;
}

/** 哈希不匹配（含重试超限）、磁盘不足等稳定错误码 */
export type BuiltinFailureCode =
  | 'E-BUILTIN-DISK-INSUFFICIENT'
  | 'E-BUILTIN-DISK-UNKNOWN'
  | 'E-BUILTIN-HASH-MISMATCH'
  | 'E-BUILTIN-EXTRACT-INCOMPLETE';

export interface BuiltinDeps {
  /** 文件存在性 */
  fileExists(path: string): boolean;
  /** 读文本文件（安装标记）；不存在/不可读返回 null */
  readFile(path: string): Promise<string | null>;
  /** 原子性不足容忍的写文本文件（标记写入走 tmp→rename 由 writeFile 自保证或调用方接受） */
  writeFile(path: string, content: string): Promise<void>;
  /** 流式下载到目标路径；onProgress 按 chunk 累计字节回调 */
  download(url: string, destPath: string, onProgress?: (receivedBytes: number) => void): Promise<void>;
  /** 文件流式 SHA-256（hex 小写） */
  sha256File(path: string): Promise<string>;
  /** 解压 zip 到目标目录（目录须已存在；生产 = Windows 自带 tar -xf） */
  extractZip(zipPath: string, destDir: string): Promise<void>;
  /** 目标目录空闲字节（拿不到 → 抛错，调用方判 E-BUILTIN-DISK-UNKNOWN） */
  diskFreeBytes(dir: string): Promise<number>;
  /** 删除文件/目录（幂等；不存在不报错） */
  rmPath(path: string): Promise<void>;
  /** rename；目标存在时行为由实现保证（本模块先确保目标不存在） */
  rename(src: string, dest: string): Promise<void>;
  /** 目录创建（recursive） */
  mkdir(path: string): Promise<void>;
  nowIso(): string;
}

export type BuiltinInstallResult =
  | { status: 'already-installed'; exePath: string }
  | { status: 'installed'; exePath: string; sha256: string }
  | { status: 'failed'; code: BuiltinFailureCode; attempts: number; message: string };

/** 下载临时文件（revision 目录内）与解压临时目录（同级目录：重装 rmPath(dir) 不得波及解压产物） */
const zipTmpName = (dir: string): string => `${dir}\\chrome-win.zip.download`;
const extractTmpName = (browsersRoot: string): string => `${browsersRoot}\\chromium-${BUILTIN_CHROMIUM_REVISION}.extract-tmp`;
const markerPathOf = (dir: string): string => `${dir}\\install.json`;

/**
 * 幂等安装检测：exe 存在且标记 revision/sha256 与双 pin 一致 → already-installed。
 * 标记存在但 exe 丢失 → 视为损坏，走重装。
 */
async function detectInstalled(deps: BuiltinDeps, dir: string, exePath: string): Promise<boolean> {
  if (!deps.fileExists(exePath)) return false;
  const raw = await deps.readFile(markerPathOf(dir));
  if (!raw) return false;
  try {
    const marker = JSON.parse(raw) as BuiltinInstallMarker;
    return (
      marker.revision === BUILTIN_CHROMIUM_REVISION &&
      marker.sha256 === BUILTIN_CHROMIUM_SHA256 &&
      marker.zipBytes === BUILTIN_CHROMIUM_ZIP_BYTES
    );
  } catch {
    return false; // 标记损坏：视为未安装（重装修复）
  }
}

/** 预检遗留的临时产物（上次中断的 .download/extract-tmp），不阻塞但保证目录干净 */
async function cleanStaleTmp(deps: BuiltinDeps, browsersRoot: string): Promise<void> {
  await deps.rmPath(zipTmpName(builtinRevisionDir(browsersRoot)));
  await deps.rmPath(extractTmpName(browsersRoot));
}

/**
 * 安装主流程（plan B1 验收面）：
 * 磁盘预检 → 下载(≤3 次,流式哈希) → 解压到临时目录 → 原子 rename → 写标记 → 清理 zip。
 * 下载哈希不符：删临时包重下；超限 → failed(E-BUILTIN-HASH-MISMATCH)，不动既有安装。
 */
export async function installBuiltinBrowser(
  browsersRoot: string,
  deps: BuiltinDeps,
  onProgress?: (receivedBytes: number) => void,
): Promise<BuiltinInstallResult> {
  const dir = builtinRevisionDir(browsersRoot);
  const exePath = `${dir}\\${BUILTIN_EXE_RELATIVE}`;

  if (await detectInstalled(deps, dir, exePath)) {
    return { status: 'already-installed', exePath };
  }

  try {
    const freeBytes = await deps.diskFreeBytes(browsersRoot);
    if (freeBytes < BUILTIN_CHROMIUM_ZIP_BYTES * BUILTIN_DISK_HEADROOM) {
      return {
        status: 'failed',
        code: 'E-BUILTIN-DISK-INSUFFICIENT',
        attempts: 0,
        message: `磁盘空闲 ${freeBytes}B < 2×包体 ${BUILTIN_CHROMIUM_ZIP_BYTES * BUILTIN_DISK_HEADROOM}B`,
      };
    }
  } catch (error) {
    return {
      status: 'failed',
      code: 'E-BUILTIN-DISK-UNKNOWN',
      attempts: 0,
      message: `磁盘空闲量不可测：${String(error).slice(0, 160)}`,
    };
  }

  await deps.mkdir(dir);
  await cleanStaleTmp(deps, browsersRoot);
  const zipTmp = zipTmpName(dir);
  const extractTmp = extractTmpName(browsersRoot);

  for (let attempt = 1; attempt <= BUILTIN_MAX_ATTEMPTS; attempt += 1) {
    await deps.rmPath(zipTmp);
    await deps.download(builtinZipUrl(), zipTmp, onProgress);
    const hash = await deps.sha256File(zipTmp);
    if (hash === BUILTIN_CHROMIUM_SHA256) {
      // 解压 → 布局完整性 → 原子落位
      await deps.mkdir(extractTmp);
      await deps.extractZip(zipTmp, extractTmp);
      if (!deps.fileExists(`${extractTmp}\\${BUILTIN_EXE_RELATIVE}`)) {
        await deps.rmPath(extractTmp);
        await deps.rmPath(zipTmp);
        return { status: 'failed', code: 'E-BUILTIN-EXTRACT-INCOMPLETE', attempts: attempt, message: '解压后未找到 chrome.exe' };
      }
      await deps.rmPath(dir);
      // rename 前 dir 已被清除（zipTmp 随目录递归删除；解压产物在同盘同级目录，rename 原子落位）
      await deps.rename(extractTmp, dir);
      await deps.writeFile(
        markerPathOf(dir),
        JSON.stringify(
          {
            revision: BUILTIN_CHROMIUM_REVISION,
            sha256: BUILTIN_CHROMIUM_SHA256,
            zipBytes: BUILTIN_CHROMIUM_ZIP_BYTES,
            installedAt: deps.nowIso(),
          } satisfies BuiltinInstallMarker,
          null,
          2,
        ),
      );
      return { status: 'installed', exePath, sha256: hash };
    }
    await deps.rmPath(zipTmp);
  }

  return {
    status: 'failed',
    code: 'E-BUILTIN-HASH-MISMATCH',
    attempts: BUILTIN_MAX_ATTEMPTS,
    message: `连续 ${BUILTIN_MAX_ATTEMPTS} 次哈希不符（pin ${BUILTIN_CHROMIUM_SHA256.slice(0, 12)}…），放弃且不动既有安装`,
  };
}

/* ------------------------------ 生产适配器（B2 接线取用；node 依赖仅在本段） ------------------------------ */

/** 生产 sha256：createHash 流式读文件 */
export async function nodeSha256File(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 生产下载：global fetch（Node 20 内置）→ web ReadableStream 转 node 流落盘 + 字节进度 */
export async function nodeDownload(url: string, destPath: string, onProgress?: (received: number) => void): Promise<void> {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`E-BUILTIN-DOWNLOAD-HTTP-${response.status}: 快照下载失败（${url.slice(0, 100)}）`);
  }
  let received = 0;
  const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received);
  });
  await pipeline(nodeStream, createWriteStream(destPath));
}

/** 生产解压：Windows 自带 tar（Win10 1803+ 支持 zip；不新增 zip 运行时依赖——plan §1） */
export async function tarZipExtractor(zipPath: string, destDir: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true, timeout: 10 * 60_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`E-BUILTIN-EXTRACT-FAILED: tar 解压失败（${String(stderr).slice(0, 160)}）`));
      else resolve();
    });
  });
}

/** 生产磁盘空闲：fs.statfs（Node ≥18.15）；不可测抛错由编排判 E-BUILTIN-DISK-UNKNOWN */
export async function nodeDiskFreeBytes(dir: string): Promise<number> {
  const { statfs } = await import('node:fs/promises');
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
}

/** 生产 launch 前置探测结果（B2 detect 链使用；此处仅导出类型与路径助手避免提前接线） */
export interface BuiltinProbe {
  readonly kind: 'builtin';
  readonly revision: string;
  readonly exePath: string;
}

/** 供 B2 探测内置安装是否可用（marker 匹配 + exe 存在） */
export async function probeBuiltinBrowser(
  browsersRoot: string,
  deps: Pick<BuiltinDeps, 'fileExists' | 'readFile'>,
): Promise<BuiltinProbe | null> {
  const dir = builtinRevisionDir(browsersRoot);
  const exePath = `${dir}\\${BUILTIN_EXE_RELATIVE}`;
  const installed = await detectInstalled(deps as BuiltinDeps, dir, exePath);
  return installed ? { kind: 'builtin', revision: BUILTIN_CHROMIUM_REVISION, exePath } : null;
}
