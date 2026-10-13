/**
 * 统计聚类（ADR-7 §2-2 降级路线一级常驻）：char-3gram TF-IDF 向量化 + KMeans。
 * K = clamp(round(sqrt(N)), 3, 8)（N < 3 时收窄到 N，保证可聚类）；无网络、无外部依赖。
 */

/** 确定性伪随机数（mulberry32）：同种子同序列 → KMeans 结果可重放 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 文本规范化：小写、压空白；char-3gram 滑窗（过短文本退化为整串单 token） */
export function char3grams(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length < 3) return normalized.length > 0 ? [normalized] : [];
  const grams: string[] = [];
  for (let i = 0; i <= normalized.length - 3; i += 1) grams.push(normalized.slice(i, i + 3));
  return grams;
}

export interface TfIdfVector {
  /** 稀疏表示：词表索引 → 权重（L2 归一化后的 tf*idf） */
  entries: Map<number, number>;
  norm: number;
}

export interface TfIdfModel {
  vocab: string[];
  vectors: TfIdfVector[];
}

/** char-3gram TF-IDF 模型：idf = log((1+N)/(1+df)) + 1；每文档 L2 归一化 */
export function fitTfIdf(docs: string[]): TfIdfModel {
  const gramLists = docs.map(char3grams);
  const vocab = new Map<string, number>();
  const df = new Map<number, number>();
  for (const grams of gramLists) {
    const seen = new Set<number>();
    for (const gram of grams) {
      let idx = vocab.get(gram);
      if (idx === undefined) {
        idx = vocab.size;
        vocab.set(gram, idx);
      }
      if (!seen.has(idx)) {
        seen.add(idx);
        df.set(idx, (df.get(idx) ?? 0) + 1);
      }
    }
  }
  const n = docs.length;
  const idf = new Map<number, number>();
  for (const [idx, count] of df) idf.set(idx, Math.log((1 + n) / (1 + count)) + 1);

  const vectors = gramLists.map((grams) => {
    const tf = new Map<number, number>();
    for (const gram of grams) tf.set(vocab.get(gram) as number, (tf.get(vocab.get(gram) as number) ?? 0) + 1);
    const entries = new Map<number, number>();
    let sumSq = 0;
    for (const [idx, count] of tf) {
      const w = (count / grams.length) * (idf.get(idx) ?? Math.log(1 + n) + 1);
      entries.set(idx, w);
      sumSq += w * w;
    }
    const norm = Math.sqrt(sumSq);
    if (norm > 0) for (const [idx, w] of entries) entries.set(idx, w / norm);
    return { entries, norm };
  });
  return { vocab: [...vocab.keys()], vectors };
}

export function dotSparse(a: TfIdfVector, b: TfIdfVector): number {
  const [small, large] = a.entries.size <= b.entries.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [idx, w] of small.entries) {
    const other = large.entries.get(idx);
    if (other !== undefined) sum += w * other;
  }
  return sum;
}

/** ADR-7 K 公式：clamp(round(sqrt(N)), 3, 8)；N<3 时 K=N（可聚类性守卫，0 条不聚类） */
export function chooseK(n: number): number {
  if (n <= 0) return 0;
  return Math.min(Math.max(Math.round(Math.sqrt(n)), 3), Math.max(3, Math.min(8, n)), n);
}

function centroidAdd(centroid: Map<number, number>, vector: TfIdfVector): void {
  for (const [idx, w] of vector.entries) centroid.set(idx, (centroid.get(idx) ?? 0) + w);
}

function centroidMean(centroid: Map<number, number>, count: number): Map<number, number> {
  const mean = new Map<number, number>();
  for (const [idx, sum] of centroid) mean.set(idx, sum / count);
  return mean;
}

export interface StatisticalClusterResult {
  route: 'statistical';
  k: number;
  assignments: number[];
  /** 每簇按簇内平均权重取的 top 特征串（写入报告⑧章与①章提示） */
  topTerms: string[][];
  iterations: number;
}

export interface VectorClusterResult {
  route: 'vector';
  k: number;
  assignments: number[];
  iterations: number;
}

/**
 * 统计路线主入口：char-3gram TF-IDF + KMeans（余弦距离，L2 归一化后等价欧氏序）。
 * seeded 确定性：同输入同 seed → 同 assignments（可测试可重放）。
 */
export function clusterTexts(
  texts: string[],
  opts: { seed?: number; maxIter?: number } = {},
): StatisticalClusterResult {
  const n = texts.length;
  if (n === 0) return { route: 'statistical', k: 0, assignments: [], topTerms: [], iterations: 0 };
  const model = fitTfIdf(texts);
  const k = chooseK(n);
  const cosine = (a: TfIdfVector, b: TfIdfVector) => 1 - dotSparse(a, b);

  // k-means++ + Lloyd（稀疏质心=簇内平均向量；已选点排除防重复质心）
  const rng = mulberry32(opts.seed ?? 20261013);
  const maxIter = opts.maxIter ?? 100;
  const centroids: TfIdfVector[] = [model.vectors[Math.floor(rng() * n)]];
  const used = new Set<number>([model.vectors.indexOf(centroids[0])]);
  while (centroids.length < Math.min(k, n)) {
    const candidates = model.vectors.map((v, i) => ({ v, i })).filter(({ i }) => !used.has(i));
    if (candidates.length === 0) break;
    const dists = candidates.map(({ v }) => Math.min(...centroids.map((c) => cosine(v, c))));
    const total = dists.reduce((s, d) => s + d, 0);
    let chosenIdx = candidates.length - 1;
    if (total > 0) {
      let threshold = rng() * total;
      for (let i = 0; i < candidates.length; i += 1) {
        threshold -= dists[i];
        if (threshold <= 0) {
          chosenIdx = i;
          break;
        }
      }
    }
    used.add(candidates[chosenIdx].i);
    centroids.push(candidates[chosenIdx].v);
  }

  let assignments = new Array<number>(n).fill(0);
  let iterations = 0;
  for (; iterations < maxIter; iterations += 1) {
    let changed = false;
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = cosine(model.vectors[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      next[i] = best;
      if (next[i] !== assignments[i]) changed = true;
    }
    assignments = next;
    for (let c = 0; c < centroids.length; c += 1) {
      const members = model.vectors.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;
      const sum = new Map<number, number>();
      for (const m of members) centroidAdd(sum, m);
      centroids[c] = { entries: centroidMean(sum, members.length), norm: 1 };
    }
    if (!changed && iterations > 0) break;
  }

  const topTerms = topTermsPerCluster(model, assignments, centroids.length);
  return { route: 'statistical', k: centroids.length, assignments, topTerms, iterations };
}

/** 簇内平均权重最高的前 N 个特征（len<3 的退化 token 也照常参与） */
export function topTermsPerCluster(model: TfIdfModel, assignments: number[], k: number, topN = 8): string[][] {
  const sums = Array.from({ length: k }, () => new Map<number, number>());
  const counts = new Array<number>(k).fill(0);
  assignments.forEach((cluster, docIdx) => {
    counts[cluster] += 1;
    for (const [idx, w] of model.vectors[docIdx].entries) {
      sums[cluster].set(idx, (sums[cluster].get(idx) ?? 0) + w);
    }
  });
  return sums.map((sum, cluster) => {
    if (counts[cluster] === 0) return [];
    return [...sum.entries()]
      .map(([idx, total]) => ({ term: model.vocab[idx] ?? '', avg: total / counts[cluster] }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, topN)
      .map((x) => x.term);
  });
}

/** 嵌入路线（向量）KMeans：L2 归一化后的欧氏距离；同 seed 确定性 */
export function clusterVectors(
  vectors: Float32Array[],
  opts: { seed?: number; maxIter?: number } = {},
): VectorClusterResult {
  const n = vectors.length;
  if (n === 0) return { route: 'vector', k: 0, assignments: [], iterations: 0 };
  const normalized = vectors.map(l2Normalize);
  const k = chooseK(n);
  const dim = normalized[0].length;
  const rng = mulberry32(opts.seed ?? 20261013);
  const maxIter = opts.maxIter ?? 100;
  const dist = (a: Float32Array, b: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return sum;
  };
  // k-means++ 初始化（已选中的点距质心为 0，直接排除防重复质心）
  const centroids: Float32Array[] = [normalized[Math.floor(rng() * n)]];
  const used = new Set<number>([normalized.indexOf(centroids[0])]);
  while (centroids.length < Math.min(k, n)) {
    const candidates = normalized.map((v, i) => ({ v, i })).filter(({ i }) => !used.has(i));
    if (candidates.length === 0) break;
    const dists = candidates.map(({ v }) => Math.min(...centroids.map((c) => dist(v, c))));
    const total = dists.reduce((s, d) => s + d, 0);
    let chosenIdx = candidates.length - 1;
    if (total > 0) {
      let threshold = rng() * total;
      for (let i = 0; i < candidates.length; i += 1) {
        threshold -= dists[i];
        if (threshold <= 0) {
          chosenIdx = i;
          break;
        }
      }
    }
    used.add(candidates[chosenIdx].i);
    centroids.push(candidates[chosenIdx].v);
  }
  let assignments = new Array<number>(n).fill(0);
  let iterations = 0;
  for (; iterations < maxIter; iterations += 1) {
    let changed = false;
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = dist(normalized[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      next[i] = best;
      if (next[i] !== assignments[i]) changed = true;
    }
    assignments = next;
    for (let c = 0; c < centroids.length; c += 1) {
      const members = normalized.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;
      const mean = new Float32Array(dim);
      for (const m of members) for (let i = 0; i < dim; i += 1) mean[i] += m[i];
      for (let i = 0; i < dim; i += 1) mean[i] /= members.length;
      centroids[c] = mean;
    }
    if (!changed && iterations > 0) break;
  }
  return { route: 'vector', k: centroids.length, assignments, iterations };
}

export function l2Normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return Float32Array.from(v);
  return Float32Array.from(v, (x) => x / norm);
}
