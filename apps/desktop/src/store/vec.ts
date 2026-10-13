/**
 * sqlite-vec（vec0）加载封装（M1 todo 6 / ADR-7 铁律）。
 * 打包态 `getLoadablePath()` 返回 asar 虚拟路径，而 `db.loadExtension` 走
 * Win32 LoadLibrary、不经 Node dlopen 的 asar 重映射 → 必须显式改写
 * `app.asar` → `app.asar.unpacked`（sqlite-vec-packaging-validation.md §3-②/§7，
 * pnpm 布局复验确认规则原样可用）；开发态路径在磁盘，改写为 no-op。
 * electron-free：迁移直写（db.ts）、store worker（KNN）、vitest 共用。
 */
import type { SqliteDatabase } from 'better-sqlite3';
// 必须保持 esbuild external（scripts/build.mjs）：getLoadablePath 内部是运行时
// require.resolve('sqlite-vec-<platform>-<arch>/vec0.dll')，打进 bundle 会丢失
// node_modules 解析链（asar 提升布局 §7.3）。
import { getLoadablePath } from 'sqlite-vec';

/**
 * asar → app.asar.unpacked 路径改写（纯函数）。仅当 `app.asar` 是完整路径段时
 * 改写（段边界正则，防误伤 `*app.asar` 目录名）；unpacked/开发态路径原样（幂等）。
 */
export function asarUnpackPath(p: string): string {
  const pattern = /(^|[\\/])app\.asar(?=[\\/]|$)/;
  if (!pattern.test(p)) return p;
  return p.replace(pattern, '$1app.asar.unpacked');
}

/** vec0 可加载路径：打包态自动落 app.asar.unpacked；开发态原样。 */
export function vecLoadablePath(): string {
  return asarUnpackPath(getLoadablePath());
}

/** 在连接上加载 vec0 扩展；失败如实抛出（软化策略归 db.ts，不在此静默）。 */
export function loadSqliteVec(db: SqliteDatabase): void {
  db.loadExtension(vecLoadablePath());
}
