export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate independent exponential smoothing toward b.
export const damp = (a, b, k, dt) => b + (a - b) * Math.exp(-k * dt);

export function dampAngle(a, b, k, dt) {
  const d = wrapAngle(b - a);
  return a + d * (1 - Math.exp(-k * dt));
}

export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Small deterministic RNG so the city looks the same every load.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function hash01(n) {
  n = Math.imul(n ^ 61 ^ (n >>> 16), 9);
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}
