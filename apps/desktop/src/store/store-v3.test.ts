/**
 * store v3 内核单测（M1 todo 6）：sqlite-vec 加载与路径解析（asar/开发两态）、
 * vec0 BigInt rowid 插入 5 行 + KNN top3、embeddings 缓存/prune、notes 快照语义。
 * 真实 better-sqlite3 + vec0.dll（electron-as-node ABI 130，加载与 dim 无关）。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleStoreRequest } from './worker';
import { openAndMigrate } from './db';
import { asarUnpackPath, loadSqliteVec, vecLoadablePath } from './vec';
import type { StoreRequest, EmbeddingUpsertInput, KnnHit } from './protocol';
import type { SqliteDatabase } from 'better-sqlite3';

let dir: string;
let db: SqliteDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-store-v3-'));
  db = openAndMigrate(path.join(dir, 'v3.db')).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function float32(values: number[]): Float32Array {
  const a = new Float32Array(2048);
  a.set(values);
  return a;
}

function embedding(sha256: string, values: number[]): EmbeddingUpsertInput {
  return { provider: 'zhipu', model: 'embedding-3', inputSha256: sha256, dim: 2048, vector: float32(values) };
}

function run<T>(request: StoreRequest): T {
  return handleStoreRequest(db, request).data as T;
}

describe('sqlite-vec 加载与路径解析（happy QA：asar 态/开发态两态路径单测）', () => {
  it('asarUnpackPath：asar 虚拟路径改写 unpacked、已 unpacked 幂等、开发态磁盘路径原样', () => {
    // 打包态（Windows 风格，pnpm 提升布局：平台包在 node_modules 顶层）
    expect(asarUnpackPath('C:\\app\\resources\\app.asar\\node_modules\\sqlite-vec-windows-x64\\vec0.dll')).toBe(
      'C:\\app\\resources\\app.asar.unpacked\\node_modules\\sqlite-vec-windows-x64\\vec0.dll',
    );
    // 打包态（POSIX 风格）
    expect(asarUnpackPath('/opt/app/resources/app.asar/node_modules/sqlite-vec-windows-x64/vec0.dll')).toBe(
      '/opt/app/resources/app.asar.unpacked/node_modules/sqlite-vec-windows-x64/vec0.dll',
    );
    // 已是 unpacked：幂等（不得产出 app.asar.unpacked.unpacked）
    const unpacked = 'C:\\app\\resources\\app.asar.unpacked\\node_modules\\sqlite-vec-windows-x64\\vec0.dll';
    expect(asarUnpackPath(unpacked)).toBe(unpacked);
    // 开发态：pnpm virtual store 磁盘真实路径，无 app.asar 段 → 原样
    const dev = 'C:\\repo\\node_modules\\.pnpm\\sqlite-vec-windows-x64@0.1.9\\node_modules\\sqlite-vec-windows-x64\\vec0.dll';
    expect(asarUnpackPath(dev)).toBe(dev);
    // 段边界：恰好以 *app.asar 结尾的普通目录名不被误伤
    expect(asarUnpackPath('C:\\work\\myapp.asar\\data')).toBe('C:\\work\\myapp.asar\\data');
  });

  it('开发态集成：vecLoadablePath 解析到磁盘真实 dll（existsSync）且 vec_version 可用', () => {
    const p = vecLoadablePath();
    expect(p).toBeTruthy();
    expect(p).not.toContain('app.asar'); // 开发态无 asar 段
    expect(existsSync(p)).toBe(true);
    const probe = openAndMigrate(path.join(dir, 'vec-probe.db')).db;
    try {
      loadSqliteVec(probe);
      const version = probe.prepare('SELECT vec_version() AS v').get() as { v: string };
      expect(version.v).toMatch(/^v0\./);
    } finally {
      probe.close();
    }
  });
});

describe('embeddings_vec：BigInt rowid 插入 5 行 + KNN top3（QA 场景，对齐 bench §7.3 实测）', () => {
  it('upsertEmbedding×5 → knnTopK k=3：rowid 序 [1,2,3]、距离有限、元数据 JOIN 正确', () => {
    const rows: Array<[bigint, number[]]> = [
      [1n, [1, 0]],
      [2n, [0.8, 0.6]],
      [3n, [0.6, 0.8]],
      [4n, [0, 0]],
      [5n, [0, 1]],
    ];
    rows[3]![1][2047] = 1; // 第 4 行拉远
    for (const [, values] of rows) {
      const result = run<{ upserted: boolean; rowid: bigint }>({
        id: 1,
        type: 'upsertEmbedding',
        embedding: embedding(`sha-${values.join('-')}`, values),
      });
      expect(typeof result.rowid).toBe('bigint');
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM embeddings_vec').get() as { c: number }).c).toBe(5);
    expect((db.prepare('SELECT COUNT(*) AS c FROM embeddings_cache').get() as { c: number }).c).toBe(5);

    const knn = run<{ hits: KnnHit[] }>({ id: 2, type: 'knnTopK', query: { vector: float32([1, 0]), k: 3 } }).hits;
    expect(knn.map((h) => h.rowid)).toEqual([1n, 2n, 3n]);
    expect(knn.every((h) => Number.isFinite(h.distance) && h.distance >= 0)).toBe(true);
    expect(knn[0]?.distance).toBe(0);
    expect(knn[0]).toMatchObject({ provider: 'zhipu', model: 'embedding-3', dim: 2048 });
  });

  it('vec0 拒收 REAL rowid（BigInt 契约的文档化测试，§3-④ 实测签名）', () => {
    const insert = db.prepare('INSERT INTO embeddings_vec (rowid, embedding) VALUES (?, ?)');
    expect(() => insert.run(1, Buffer.from(float32([1, 0]).buffer))).toThrowError(/integer/i);
  });

  it('pruneEmbeddingsCache：超 180 天的 cache 行与 vec 行同删，未到期保留', () => {
    run<{ upserted: boolean }>({ id: 1, type: 'upsertEmbedding', embedding: embedding('a'.repeat(64), [1, 0]) });
    run<{ upserted: boolean }>({ id: 2, type: 'upsertEmbedding', embedding: embedding('b'.repeat(64), [0, 1]) });
    // 未到期（179 天前）不动
    db.prepare('UPDATE embeddings_cache SET last_used_at = ? WHERE input_sha256 = ?').run(
      new Date(new Date().getTime() - 179 * 86400000).toISOString(),
      'b'.repeat(64),
    );
    // 超期（181 天前）清理
    db.prepare('UPDATE embeddings_cache SET last_used_at = ? WHERE input_sha256 = ?').run(
      new Date(new Date().getTime() - 181 * 86400000).toISOString(),
      'a'.repeat(64),
    );
    const result = run<{ cacheDeleted: number; vecDeleted: number }>({ id: 3, type: 'pruneEmbeddingsCache' });
    expect(result).toEqual({ cacheDeleted: 1, vecDeleted: 1 });
    expect((db.prepare('SELECT COUNT(*) AS c FROM embeddings_cache').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM embeddings_vec').get() as { c: number }).c).toBe(1);
    const knn = run<{ hits: KnnHit[] }>({ id: 4, type: 'knnTopK', query: { vector: float32([0, 1]), k: 5 } }).hits;
    expect(knn.map((h) => h.inputSha256)).toEqual(['b'.repeat(64)]);
  });
});

describe('notes 内核（upsert 快照/首采时间/主题登记语义）', () => {
  it('重复采集：notes 行数不增 + 快照逐次追加 + collected_at 首采不覆盖 + 双主题登记', () => {
    run<{ upserted: boolean }>({
      id: 1,
      type: 'upsertNote',
      note: { noteId: 'n-1', title: 'v1', likes: 1, collects: 1, comments: 1, collectedAt: '2026-10-01T00:00:00.000Z', topicId: 't-a' },
    });
    run<{ upserted: boolean }>({
      id: 2,
      type: 'upsertNote',
      note: { noteId: 'n-1', title: 'v2', likes: 5, collects: 3, comments: 2, topicId: 't-a' },
    });
    run<{ upserted: boolean }>({
      id: 3,
      type: 'upsertNote',
      note: { noteId: 'n-1', likes: 8, collects: 6, comments: 4, topicId: 't-b' },
    });
    expect((db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM note_snapshots').get() as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS c FROM topic_notes').get() as { c: number }).c).toBe(2);
    const note = db.prepare('SELECT * FROM notes WHERE note_id = ?').get('n-1') as Record<string, unknown>;
    expect(note.title).toBe('v2');
    expect(note.likes).toBe(8);
    expect(note.collected_at).toBe('2026-10-01T00:00:00.000Z'); // 首采时间保留
    // 快照序列可回放（FR-4.4）
    const snaps = db.prepare('SELECT likes FROM note_snapshots WHERE note_id = ? ORDER BY id').all('n-1') as Array<{ likes: number }>;
    expect(snaps.map((s) => s.likes)).toEqual([1, 5, 8]);
    // 首见 seen_at 不被覆盖
    const seen = db.prepare('SELECT seen_at FROM topic_notes WHERE topic_id = ? AND note_id = ?').get('t-a', 'n-1') as { seen_at: string };
    expect(seen.seen_at).toBeTruthy();
  });

  it('listNotes：topic 过滤 + limit 上限 500 + order', () => {
    for (let i = 1; i <= 3; i += 1) {
      run<{ upserted: boolean }>({
        id: i,
        type: 'upsertNote',
        note: { noteId: `n-${i}`, collectedAt: `2026-10-0${i}T00:00:00.000Z`, ...(i <= 2 ? { topicId: 't-a' } : {}) },
      });
    }
    const asc = run<{ notes: Array<{ noteId: string }> }>({ id: 10, type: 'listNotes', filter: { order: 'asc' } }).notes;
    expect(asc.map((n) => n.noteId)).toEqual(['n-1', 'n-2', 'n-3']);
    const topicA = run<{ notes: Array<{ noteId: string }> }>({ id: 11, type: 'listNotes', filter: { topicId: 't-a' } }).notes;
    expect(topicA).toHaveLength(2);
    const capped = run<{ notes: unknown[] }>({ id: 12, type: 'listNotes', filter: { limit: 9999 } }).notes;
    expect(capped).toHaveLength(3); // 全表仅 3 行——上限钳制不放大结果
  });
});

describe('store v5：products + materials（T-M2-04；FR-6.5 商品卡片/素材留存内核）', () => {
  function req<T>(request: Parameters<typeof handleStoreRequest>[1]): T {
    return handleStoreRequest(db, request).data as T;
  }

  it('upsertProduct：新建 status=候选；冲突更新可变字段但 status 不覆盖（防重复勾选打回）', () => {
    const base = {
      productId: '880000000001',
      title: '冰丝防晒帽UPF50+',
      priceMin: 3.5,
      priceMax: 3.5,
      sales: 34_000,
      supplier: { name: '台州市椒江顺新鞋帽厂', address: null },
      scores: [{ name: 'relevance', score: 100 }],
      link: 'https://detail.1688.com/offer/880000000001.html',
      taskId: 'task-1',
      keyword: '防晒帽',
    };
    req({ id: 1, type: 'upsertProduct', product: base });
    req({ id: 2, type: 'setProductStatus', productId: '880000000001', status: '已对接' });
    // 重复勾选（同 offer 再入）：可变字段更新、status 保持「已对接」
    req({ id: 3, type: 'upsertProduct', product: { ...base, title: '冰丝防晒帽UPF50+（更新）', sales: 40_000 } });
    const rows = req<{ rows: Array<{ title: string; sales: number | null; status: string; supplier: { name: string | null } | null }> }>({
      id: 4, type: 'listProducts', filter: { taskId: 'task-1' },
    }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('冰丝防晒帽UPF50+（更新）');
    expect(rows[0]?.sales).toBe(40_000);
    expect(rows[0]?.status).toBe('已对接');
    expect(rows[0]?.supplier).toEqual({ name: '台州市椒江顺新鞋帽厂', address: null });
  });

  it('setProductStatus：非法状态被 BAD_REQUEST 拒绝；不存在商品报错', () => {
    req({ id: 1, type: 'upsertProduct', product: { productId: 'x1', title: 't', link: 'https://detail.1688.com/offer/x1.html', taskId: 'k' } });
    expect(() => handleStoreRequest(db, { id: 2, type: 'setProductStatus', productId: 'x1', status: '未知' as never })).toThrowError(/E-STORE-BAD-REQUEST/);
    expect(() => handleStoreRequest(db, { id: 3, type: 'setProductStatus', productId: 'ghost', status: '对接中' })).toThrowError(/E-STORE-BAD-REQUEST.*商品不存在/);
  });

  it('insertMaterials：image 按 (product, source_url) 去重追加；desc 每商品单行替换', () => {
    const img = (n: number): { productId: string; kind: 'image'; path: string; sourceUrl: string; hash: string } => ({
      productId: 'x1',
      kind: 'image',
      path: `C:/tmp/materials/x1/${n}.jpg`,
      sourceUrl: `https://cbu01.alicdn.com/img/ibank/fix-${n}.jpg`,
      hash: `hash-${n}`,
    });
    const first = req<{ inserted: number }>({ id: 1, type: 'insertMaterials', rows: [img(1), img(2)] });
    expect(first.inserted).toBe(2);
    // 同源重跑：去重不重建
    const dedup = req<{ inserted: number }>({ id: 2, type: 'insertMaterials', rows: [img(1), img(3)] });
    expect(dedup.inserted).toBe(1);
    // desc 重跑 = 替换单行
    req({ id: 3, type: 'insertMaterials', rows: [{ productId: 'x1', kind: 'desc', path: 'C:/tmp/materials/x1/desc.txt', hash: 'h0' }] });
    const again = req<{ inserted: number }>({ id: 4, type: 'insertMaterials', rows: [{ productId: 'x1', kind: 'desc', path: 'C:/tmp/materials/x1/desc.txt', hash: 'h1' }] });
    expect(again.inserted).toBe(1);
    const mats = req<{ rows: Array<{ kind: string; sourceUrl: string | null }> }>({ id: 5, type: 'listMaterials', productId: 'x1' }).rows;
    expect(mats.filter((m) => m.kind === 'image')).toHaveLength(3);
    expect(mats.filter((m) => m.kind === 'desc')).toHaveLength(1);
  });

  it('listProducts：status/task 过滤 + limit 收口', () => {
    for (const [id, status] of [['a', '候选'], ['b', '对接中'], ['c', '已对接']] as const) {
      req({ id: 1, type: 'upsertProduct', product: { productId: id, title: id, link: `https://detail.1688.com/offer/${id}.html`, taskId: 't9' } });
      if (status !== '候选') req({ id: 2, type: 'setProductStatus', productId: id, status });
    }
    expect(req<{ rows: unknown[] }>({ id: 3, type: 'listProducts', filter: { taskId: 't9' } }).rows).toHaveLength(3);
    expect(req<{ rows: unknown[] }>({ id: 4, type: 'listProducts', filter: { status: '已对接' } }).rows).toHaveLength(1);
  });

  it('setProductStatus：工作流六态全接受（T-M2-06 待发布/推广中/已完成——看板流转载体）', () => {
    req({ id: 1, type: 'upsertProduct', product: { productId: 'wf1', title: 't', link: 'https://detail.1688.com/offer/wf1.html', taskId: 'k' } });
    for (const [i, status] of (['已对接', '待发布', '推广中', '已完成'] as const).entries()) {
      req({ id: i + 2, type: 'setProductStatus', productId: 'wf1', status });
      const rows = req<{ rows: Array<{ status: string }> }>({ id: 10, type: 'listProducts', filter: { productId: 'wf1' } }).rows;
      expect(rows[0]?.status).toBe(status);
    }
  });

  it('listProducts：productId 精确筛选命中单行（转场前状态校验数据源）', () => {
    for (const id of ['p1', 'p2']) {
      req({ id: 1, type: 'upsertProduct', product: { productId: id, title: id, link: `https://detail.1688.com/offer/${id}.html`, taskId: 't9' } });
    }
    const rows = req<{ rows: Array<{ productId: string }> }>({ id: 3, type: 'listProducts', filter: { productId: 'p2' } }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productId).toBe('p2');
  });
});
