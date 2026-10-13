import { describe, it, expect } from 'vitest';
import { chooseK, char3grams, clusterTexts, clusterVectors, l2Normalize, mulberry32, topTermsPerCluster, fitTfIdf } from './clustering.js';

describe('chooseK（ADR-7 K 公式：clamp(round(sqrt(N)),3,8)）', () => {
  it('golden 边界逐点', () => {
    expect(chooseK(0)).toBe(0);
    expect(chooseK(1)).toBe(1);
    expect(chooseK(2)).toBe(2);
    expect(chooseK(3)).toBe(3);
    expect(chooseK(4)).toBe(3);
    expect(chooseK(9)).toBe(3);
    expect(chooseK(10)).toBe(3);
    expect(chooseK(16)).toBe(4);
    expect(chooseK(25)).toBe(5);
    expect(chooseK(36)).toBe(6);
    expect(chooseK(49)).toBe(7);
    expect(chooseK(64)).toBe(8);
    expect(chooseK(100)).toBe(8);
    expect(chooseK(10000)).toBe(8);
  });
});

describe('char-3gram TF-IDF', () => {
  it('中文滑窗切分', () => {
    expect(char3grams('敏感肌修护')).toEqual(['敏感肌', '感肌修', '肌修护']);
    expect(char3grams('ab')).toEqual(['ab']);
    expect(char3grams('')).toEqual([]);
  });

  it('同语料向量化确定性（重复 fit 结果一致）', () => {
    const docs = ['敏感肌修护面霜', '熬夜泛红急救', '医美术后退红'];
    const a = fitTfIdf(docs);
    const b = fitTfIdf(docs);
    expect(a.vocab).toEqual(b.vocab);
    expect(a.vectors.map((v) => [...v.entries.keys()])).toEqual(b.vectors.map((v) => [...v.entries.keys()]));
  });
});

describe('clusterTexts（统计路线，seeded 确定性）', () => {
  const corpora = [
    // 簇 1：换季泛红
    '换季泛红刺痛，修护面霜一周稳定，敏感肌急救',
    '换季两颊泛红，修护水乳温和不刺激，敏感肌必备',
    '换季敏感肌泛红痒，修护精华退红效果好',
    // 簇 2：医美术后
    '光子嫩肤术后修护，医用敷料退红快，医美后别乱叠加',
    '水光针术后护理，生理盐水加修护霜，医美术后修复时间表',
    '医美激光术后屏障脆弱，术后修护精华一周退红',
    // 簇 3：学生党平价
    '学生党平价面霜五十元，神经酰胺温和，性价比修护',
    '百元内敏皮水乳组合，平价大碗学生党闭眼入',
    '学生党预算有限，平价修护面霜也够用，性价比真高',
  ];

  it('同 seed 两次聚类 assignments 一致（可重放）', () => {
    const a = clusterTexts(corpora, { seed: 42 });
    const b = clusterTexts(corpora, { seed: 42 });
    expect(a.assignments).toEqual(b.assignments);
    expect(a.k).toBe(b.k);
  });

  it('良分语料聚成 3 簇且同簇文本相邻文本多数同簇（K 公式=3）', () => {
    const result = clusterTexts(corpora, { seed: 42 });
    expect(result.k).toBe(3);
    expect(result.assignments).toHaveLength(9);
    // 每簇非空
    for (let c = 0; c < 3; c += 1) {
      expect(result.assignments.filter((a) => a === c).length).toBeGreaterThan(0);
    }
    // 同簇内文本两两同簇比例：语料按簇排列，相邻文本应大概率同簇
    const sameClusterPairs = [0, 3, 6].map((start) => {
      const [a, b, c] = result.assignments.slice(start, start + 3);
      return a === b && b === c;
    });
    expect(sameClusterPairs.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it('topTermsPerCluster 输出特征串', () => {
    const model = fitTfIdf(corpora);
    const result = clusterTexts(corpora, { seed: 42 });
    const terms = topTermsPerCluster(model, result.assignments, result.k);
    expect(terms).toHaveLength(result.k);
    for (const cluster of terms) {
      expect(cluster.length).toBeGreaterThan(0);
    }
  });
});

describe('clusterVectors（向量路线，seeded 确定性）', () => {
  it('三组良分向量各聚一簇（K=3）且确定性', () => {
    // 9 条 3 维单位方向向量，三簇方向正交（L2 归一化后方向几何必须可分）
    const directions = [Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0]), Float32Array.from([0, 0, 1])];
    const vectors = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
      const dir = directions[Math.floor(i / 3)];
      return l2Normalize(Float32Array.from([dir[0] + (i % 3) * 0.01, dir[1] + (i % 3) * 0.01, dir[2] + (i % 3) * 0.01]));
    });
    const a = clusterVectors(vectors, { seed: 7 });
    const b = clusterVectors(vectors, { seed: 7 });
    expect(a.route).toBe('vector');
    expect(a.assignments).toEqual(b.assignments);
    expect(a.k).toBe(3);
    for (const start of [0, 3, 6]) {
      expect(a.assignments[start]).toBe(a.assignments[start + 1]);
      expect(a.assignments[start]).toBe(a.assignments[start + 2]);
    }
    expect(new Set(a.assignments).size).toBe(3);
  });
});

describe('mulberry32 确定性', () => {
  it('同种子同序列', () => {
    const a = mulberry32(20261013);
    const b = mulberry32(20261013);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
