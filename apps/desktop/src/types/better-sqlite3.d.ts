/**
 * better-sqlite3 最小结构化类型（M0 不安装 @types/better-sqlite3：无网络安装约束；
 * 仅声明本仓实际用到的 API 面，全量类型归 M1 引入官方 types 时替换）。
 */
declare module 'better-sqlite3' {
  export interface SqliteRunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export interface SqliteStatement {
    run(...params: unknown[]): SqliteRunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  export interface SqliteTransaction<Args extends unknown[]> {
    (...args: Args): unknown;
    deferred?: SqliteTransaction<Args>;
  }

  export interface SqliteOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  export interface SqliteDatabase {
    open: boolean;
    inTransaction: boolean;
    exec(sql: string): this;
    prepare(sql: string): SqliteStatement;
    transaction<Args extends unknown[]>(fn: (...args: Args) => unknown): SqliteTransaction<Args>;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    /** 加载 SQLite 扩展（M1 store v3：sqlite-vec vec0.dll，见 store/vec.ts） */
    loadExtension(path: string, entryPoint?: string): this;
    close(): void;
  }

  const Database: {
    new (path: string, options?: SqliteOptions): SqliteDatabase;
    prototype: SqliteDatabase;
  };

  export default Database;
}
