/**
 * 随机数注入设施（纯函数，零依赖）。
 *
 * 节奏/Humanizer 的所有随机性都经 `Rng` 注入（`() => number`，返回 [0,1)），
 * 测试用 `mulberry32` 种子化复现；宿主接线时注入 `Math.random` 即可。
 */

export type Rng = () => number;

/** 标准正态抽样（Box–Muller）；要求 rng 严格返回 [0,1)，u1=0 时重抽避免 log(0)。 */
export function gaussStandard(rng: Rng): number {
  for (;;) {
    const u1 = rng();
    if (u1 <= 0) continue;
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

/** mulberry32 种子化 RNG（确定性测试用）；种子相同 → 序列完全可复现。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  const l = Math.min(lo, hi);
  const h = Math.max(lo, hi);
  return Math.min(h, Math.max(l, v));
}
