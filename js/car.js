import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clamp, damp } from './util.js?v=3.9';
import { plateTexture } from './textures.js?v=3.9';

// Tesla Roadster (2nd gen), production design revealed 15 Oct 2026 at SpaceX McGregor.
// Published facts used here: wheelbase 2,825 mm, width ~2,000 mm, wedge body after the
// SR-71/F-35, butterfly doors that take the roof section with them, removable T-top spine,
// hidden headlights, thin full-width light strip low on the nose, full-width taillight bar,
// active rear wing on two struts, Ano White paint, gold-tinted glass, four rear cold-gas
// thrusters (six more around the floor on the Rocket trim), "RDSTR" plate, floor fans.
// Length, height and surface shape are estimated from the reveal photos.
//
// The body is a smooth loft: a handful of longitudinal curves (half-width, floor, sill,
// flank crease, fender top, hood centre) interpolated with monotone cubics along z, swept
// into cross-sections every few centimetres, and shaded with per-vertex normals that keep
// a hard edge only where the design has one (the flank crease, the arch lips, panel gaps).
// Car space: +Z forward, +Y up, +X is the car's left. Origin = ground, mid-wheelbase.

export const AXLE_F = 1.45;
export const AXLE_R = -1.375;
const NOSE = 2.32;
const TAIL = -2.32;
const SPLIT_F = 0.78; // door opening, front edge
const SPLIT_R = -0.8; // door opening, rear edge
const GAP = 0.006; // panel gap around the doors
const STEP = 0.045; // loft section spacing
const SCREEN_Z = 1.04; // windscreen base on the hood
const CANOPY_END = -1.95; // where the rear glass meets the deck
const XIN = 0.62; // wheel-well inner wall

export const WHEELS = [
  { x: 0.8, z: AXLE_F, r: 0.36, w: 0.265, front: true },
  { x: -0.8, z: AXLE_F, r: 0.36, w: 0.265, front: true },
  { x: 0.835, z: AXLE_R, r: 0.37, w: 0.325, front: false },
  { x: -0.835, z: AXLE_R, r: 0.37, w: 0.325, front: false },
];
const ARCHES = [{ z: AXLE_F, y: 0.36, R: 0.375 }, { z: AXLE_R, y: 0.37, R: 0.41 }];
const FLARE = 0.035; // fender bulge over each axle
const INTAKE = { z0: -0.82, z1: -0.985, depth: 0.1 }; // rear-quarter scoop behind the door
const POP = { z0: 1.96, z1: 1.68, xi: 0.3 }; // hidden-headlight panels
const STRIP_Y = 0.385; // nose light strip height

// Longitudinal curves, nose to tail:
// z, hw half-width at the crease, yf floor, ysl sill top, ycr crease, yfd/xfd fender top,
// yhe/xhe hood (or rear deck) edge, yc centre top
const SPINE = [
  [2.32, 0.30, 0.255, 0.33, 0.395, 0.455, 0.18, 0.45, 0.09, 0.450],
  [2.26, 0.50, 0.235, 0.335, 0.42, 0.49, 0.34, 0.485, 0.17, 0.485],
  [2.12, 0.73, 0.215, 0.345, 0.47, 0.56, 0.52, 0.545, 0.30, 0.545],
  [1.92, 0.87, 0.20, 0.355, 0.54, 0.64, 0.64, 0.60, 0.38, 0.600],
  [1.62, 0.95, 0.20, 0.365, 0.60, 0.74, 0.70, 0.67, 0.42, 0.665],
  [1.30, 0.965, 0.20, 0.375, 0.64, 0.79, 0.72, 0.73, 0.45, 0.720],
  [1.02, 0.95, 0.20, 0.38, 0.655, 0.805, 0.72, 0.785, 0.48, 0.785],
  [0.50, 0.94, 0.20, 0.38, 0.67, 0.815, 0.72, 0.81, 0.50, 0.810],
  [0.00, 0.935, 0.20, 0.38, 0.69, 0.825, 0.72, 0.825, 0.50, 0.825],
  [-0.60, 0.95, 0.20, 0.385, 0.72, 0.855, 0.73, 0.855, 0.50, 0.855],
  [-1.10, 0.99, 0.20, 0.39, 0.75, 0.915, 0.74, 0.885, 0.50, 0.885],
  [-1.50, 1.00, 0.21, 0.40, 0.77, 0.945, 0.74, 0.905, 0.48, 0.905],
  [-1.90, 0.985, 0.26, 0.42, 0.78, 0.95, 0.74, 0.92, 0.45, 0.920],
  [-2.15, 0.955, 0.31, 0.44, 0.785, 0.94, 0.72, 0.925, 0.42, 0.925],
  [-2.32, 0.92, 0.34, 0.46, 0.785, 0.93, 0.70, 0.92, 0.40, 0.920],
];
const COLS = ['hw', 'yf', 'ysl', 'ycr', 'yfd', 'xfd', 'yhe', 'xhe', 'yc'];

// Gold-tinted canopy: teardrop in plan, peak just behind the doors.
// z, base half-width, centre height
const CAN = [
  [1.04, 0.60, 0.815],
  [0.78, 0.68, 0.975],
  [0.40, 0.745, 1.10],
  [0.00, 0.775, 1.16],
  [-0.40, 0.775, 1.175],
  [-0.80, 0.735, 1.15],
  [-1.20, 0.63, 1.085],
  [-1.60, 0.43, 0.995],
  [-1.95, 0.10, 0.925],
];

// Monotone cubic (Fritsch-Carlson) through (zs ascending, vs): smooth, no overshoot.
function pchip(zs, vs) {
  const n = zs.length, h = [], d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(zs[i + 1] - zs[i]);
    d.push((vs[i + 1] - vs[i]) / h[i]);
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (z) => {
    if (z <= zs[0]) return vs[0];
    if (z >= zs[n - 1]) return vs[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (zs[mid] <= z) lo = mid;
      else hi = mid;
    }
    const t = (z - zs[lo]) / h[lo], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * vs[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo] + (-2 * t3 + 3 * t2) * vs[lo + 1] + (t3 - t2) * h[lo] * m[lo + 1];
  };
}
function curves(table, names) {
  const rows = [...table].sort((a, b) => a[0] - b[0]);
  const zs = rows.map((r) => r[0]);
  const out = {};
  names.forEach((name, i) => { out[name] = pchip(zs, rows.map((r) => r[i + 1])); });
  return out;
}
const SP = curves(SPINE, COLS);
const CV = curves(CAN, ['bx', 'cy']);
const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Everything the cross-section at z needs.
function section(z) {
  const s = { z };
  for (const c of COLS) s[c] = SP[c](z);
  s.ya = s.yf;
  for (const a of ARCHES) {
    const dz = z - a.z;
    if (Math.abs(dz) < a.R) s.ya = Math.max(s.ya, a.y + Math.sqrt(a.R * a.R - dz * dz));
  }
  s.arch = s.ya > s.yf + 1e-3;
  s.flare = 0;
  for (const a of ARCHES) {
    const f = Math.max(0, 1 - Math.abs(z - a.z) / 0.62);
    s.flare = Math.max(s.flare, FLARE * f * f * (3 - 2 * f));
  }
  s.recess = z < INTAKE.z0 && z > INTAKE.z1 - 1e-6 ? INTAKE.depth * smooth01((INTAKE.z0 - z) / (INTAKE.z0 - INTAKE.z1)) : 0;
  return s;
}

// Shoulder: quadratic Bezier from the crease, leaning in at once (that is what makes the
// crease read), flattening into the fender top.
const ctrl = (s) => [s.hw + s.flare - 0.25 * (s.hw + s.flare - s.xfd), s.ycr + 0.85 * (s.yfd - s.ycr)];
function bez(a, c, b, t) {
  const u = 1 - t;
  return [u * u * a[0] + 2 * t * u * c[0] + t * t * b[0], u * u * a[1] + 2 * t * u * c[1] + t * t * b[1]];
}
// Outer skin of a half section, floor edge to centre top. A third element marks a hard crease.
function skin(s) {
  const { yf, ysl, ycr, yfd, xfd, yhe, xhe, yc, recess: r } = s;
  const hw = s.hw + s.flare;
  const P3 = [hw, ycr, 1], C = ctrl(s), P6 = [xfd, yfd];
  return [
    [hw - 0.075, yf], [hw - 0.06 - r, ysl], [hw - 0.028 - r, ycr - 0.07], P3,
    bez(P3, C, P6, 0.25), bez(P3, C, P6, 0.5), bez(P3, C, P6, 0.75), P6, [xhe, yhe], [0, yc],
  ];
}
// x of the skin at height y (floor edge up to the fender top).
function skinX(sk, y) {
  if (y <= sk[0][1]) return sk[0][0];
  for (let i = 0; i < 7; i++) {
    const a = sk[i], b = sk[i + 1];
    if (y <= b[1]) return a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1] || 1);
  }
  return sk[7][0];
}
// y of the upper surface at |x|, centre out over the fender and down the shoulder.
function topAt(s, x) {
  x = Math.abs(x);
  if (x <= s.xhe) return s.yc + ((s.yhe - s.yc) * x) / s.xhe;
  if (x <= s.xfd) return s.yhe + ((s.yfd - s.yhe) * (x - s.xhe)) / (s.xfd - s.xhe);
  if (x >= s.hw + s.flare) return s.ycr;
  const a = [s.hw + s.flare, s.ycr], c = ctrl(s), b = [s.xfd, s.yfd];
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (bez(a, c, b, mid)[0] > x) lo = mid;
    else hi = mid;
  }
  return bez(a, c, b, (lo + hi) / 2)[1];
}

// Full half ring: floor, wheel well (collapsed outside the arches), skin.
function ring(s) {
  const sk = skin(s), ya = s.ya, xa = skinX(sk, ya);
  const pts = [[0, s.yf], [XIN, s.yf], [XIN, ya], [xa, ya]];
  for (const p of sk) pts.push(p[1] < ya ? [xa, ya, p[2]] : p);
  return pts;
}
// Between the doors the body is only the tub: floor pan, sill and the cabin floor lip.
function tubRing(s) {
  const sk = skin(s), fy = s.ysl + 0.05;
  return [[0, s.yf], [XIN, s.yf], [sk[0][0], s.yf], sk[0], sk[1], [sk[1][0] - 0.12, fy], [0, fy]];
}
// Door skin: sill top, over the crease and fender, up to the glass.
function doorBody(z) {
  const s = section(z), sk = skin(s), c = canopy(z);
  return [sk[1], sk[2], sk[3], sk[4], sk[5], sk[6], sk[7], [c.bx, c.by]];
}

function canopy(z) {
  const s = section(z);
  const bx = Math.min(CV.bx(z), s.xfd - 0.02);
  const by = topAt(s, bx) + 0.004;
  const ccy = Math.max(CV.cy(z), by + 0.006);
  const crx = Math.max(0.02, bx - 0.3), cry = Math.max(ccy - 0.02, by + 0.004);
  return { bx, by, crx, cry, ccy };
}
// Half canopy: side glass with tumblehome rounding over into the roof, base to centre.
function canopyHalf(z) {
  const c = canopy(z);
  const a = [c.bx, c.by], k = [c.bx - 0.07, c.cry], b = [c.crx, c.cry];
  const pts = [];
  for (let i = 0; i <= 5; i++) pts.push(bez(a, k, b, i / 5));
  pts.push([c.crx * 0.5, c.cry + (c.ccy - c.cry) * 0.8], [0, c.ccy]);
  return pts;
}
const canopyFull = (z) => {
  const h = canopyHalf(z);
  return [...h, ...h.slice(0, -1).reverse().map(([x, y]) => [-x, y])];
};
const canopyCentre = (z) => {
  const h = canopyHalf(z);
  return [h[5], h[6], h[7], [-h[6][0], h[6][1]], [-h[5][0], h[5][1]]];
};
const doorGlass = (z) => canopyHalf(z).slice(0, 6);
// windscreen base curves forward in the middle
const screenBase = (x) => SCREEN_Z - 0.12 * (x / 0.6) ** 2;

// A half profile (bottom centre -> top centre on +x) mirrored into a full CCW ring.
const full = (half) => [...half, ...half.slice(1, -1).reverse().map(([x, y, h]) => [-x, y, h])];
const mirror = (pts) => pts.map(([x, y, h]) => [-x, y, h]).reverse();

function zList(z0, z1, extra = []) {
  const zs = [z0, z1, ...extra.filter((z) => z < z0 - 1e-4 && z > z1 + 1e-4)];
  for (let k = Math.ceil(z1 / STEP); k <= Math.floor(z0 / STEP); k++) zs.push(k * STEP);
  zs.sort((a, b) => b - a);
  const out = [];
  for (const z of zs) if (!out.length || out[out.length - 1] - z > 0.003) out.push(z);
  out[out.length - 1] = z1;
  return out;
}
const archEdges = (a) => {
  const d = Math.sqrt(a.R * a.R - (0.2 - a.y) ** 2);
  return [a.z + d, a.z + d * 0.92, a.z - d * 0.92, a.z - d];
};

const PAINT = [1, 1, 1];
const BLACK = [0.03, 0.032, 0.036];
const DARK = [0.07, 0.07, 0.075];

// Which body facets are white paint and which are black trim.
function bodyColour(x, y, z, nx, ny, nz) {
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const s = section(z), ax = Math.abs(x);
  if (ny < -0.6) return BLACK; // floor, wheel-well ceilings, diffuser (the undercut flank leans out less than this)
  if (ax < XIN + 0.004 && Math.abs(nx) > 0.7 && y < s.ya + 0.01) return BLACK; // wheel-well walls
  if (y < s.ysl + 0.004) return BLACK; // sill strip, lower nose, lower tail
  if (z < INTAKE.z0 + 0.004 && z > INTAKE.z1 - 0.012 && y < s.ycr - 0.04 && y > s.ysl + 0.01 && Math.abs(nx) + Math.abs(nz) > 0.5) return BLACK; // rear-quarter intake
  if (ny > 0.5) {
    if (z < screenBase(ax) && z > CANOPY_END - 0.01 && ax < canopy(z).bx - 0.005) return DARK; // under the glass
    if (z < POP.z0 + 0.004 && z > POP.z1 - 0.004 && ax > POP.xi - 0.004 && ax < popOuter(z) + 0.004) return BLACK; // headlight wells
  }
  return PAINT;
}
function tubColour(x, y, z, nx, ny) {
  const s = section(z);
  if (ny < -0.6) return BLACK;
  if (y < s.ysl + 0.004 && Math.abs(nx) > 0.3) return BLACK;
  return DARK;
}
const popOuter = (z) => section(z).xfd + 0.05;

// Triangle soup with vertex colours and a smoothing-group id per face. Normals are
// averaged across faces that share a position, a colour and a group and meet at less
// than the crease angle, so the loft shades like sheet metal with crisp edges.
class Geo {
  constructor() {
    this.p = [];
    this.c = [];
    this.g = [];
  }
  tri(a, b, c, col, group = 0) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) return;
    const k = typeof col === 'function'
      ? col((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3, nx, ny, nz)
      : col;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.c.push(k[0], k[1], k[2]);
    this.g.push(group);
  }
  quad(a, b, c, d, col, group) {
    this.tri(a, b, c, col, group);
    this.tri(a, c, d, col, group);
  }
  geometry(creaseDeg = 50) {
    const g = new THREE.BufferGeometry();
    const p = this.p, c = this.c, nTri = p.length / 9;
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    const fn = new Float32Array(nTri * 3);
    for (let i = 0; i < nTri; i++) {
      const o = i * 9;
      const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
      const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
      fn[i * 3] = uy * vz - uz * vy;
      fn[i * 3 + 1] = uz * vx - ux * vz;
      fn[i * 3 + 2] = ux * vy - uy * vx;
    }
    const key = (o) => `${Math.round(p[o] * 2500)},${Math.round(p[o + 1] * 2500)},${Math.round(p[o + 2] * 2500)}`;
    const shared = new Map();
    for (let i = 0; i < nTri; i++) {
      for (let k = 0; k < 3; k++) {
        const kk = key(i * 9 + k * 3);
        let arr = shared.get(kk);
        if (!arr) shared.set(kk, (arr = []));
        arr.push(i);
      }
    }
    const cosT = Math.cos((creaseDeg * Math.PI) / 180);
    const normals = new Float32Array(p.length);
    for (let i = 0; i < nTri; i++) {
      const fx = fn[i * 3], fy = fn[i * 3 + 1], fz = fn[i * 3 + 2];
      const fl = Math.hypot(fx, fy, fz) || 1;
      const gi = this.g[i], r = c[i * 9], gg = c[i * 9 + 1], b = c[i * 9 + 2];
      for (let k = 0; k < 3; k++) {
        const o = i * 9 + k * 3;
        let nx = 0, ny = 0, nz = 0;
        for (const j of shared.get(key(o))) {
          if (this.g[j] !== gi || c[j * 9] !== r || c[j * 9 + 1] !== gg || c[j * 9 + 2] !== b) continue;
          const jx = fn[j * 3], jy = fn[j * 3 + 1], jz = fn[j * 3 + 2];
          const jl = Math.hypot(jx, jy, jz) || 1;
          if ((fx * jx + fy * jy + fz * jz) / (fl * jl) < cosT) continue;
          nx += jx; ny += jy; nz += jz;
        }
        const nl = Math.hypot(nx, ny, nz) || 1;
        normals[o] = nx / nl;
        normals[o + 1] = ny / nl;
        normals[o + 2] = nz / nl;
      }
    }
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    return g;
  }
}

// Rings are CCW seen from the front and z runs nose -> tail, so (A[k], B[k], B[k+1], A[k+1]) faces out.
// A hard-flagged station starts a new smoothing group so the crease stays crisp.
function loft(geo, zs, profile, col, closed) {
  const rings = zs.map((z) => profile(z).map((p) => [p[0], p[1], z, p[2]]));
  const n = rings[0].length;
  const grp = [];
  let gc = 0;
  for (let k = 0; k < n; k++) {
    if (rings[0][k][3]) gc++;
    grp.push(gc);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const k2 = (k + 1) % n;
      geo.quad(A[k], B[k], B[k2], A[k2], col, grp[k]);
    }
  }
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > 1e-5) out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) + Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-5) out.pop();
  return out;
}

function clipY(pts, yc, keepAbove) {
  const inside = (p) => (keepAbove ? p[1] >= yc : p[1] <= yc);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
    const ia = inside(a), ib = inside(b);
    if (ib) {
      if (!ia) out.push(crossY(a, b, yc));
      out.push(b);
    } else if (ia) out.push(crossY(a, b, yc));
  }
  return out;
}
const crossY = (a, b, yc) => [a[0] + ((b[0] - a[0]) * (yc - a[1])) / (b[1] - a[1]), yc];

function cap(geo, ring, z, facing, col) {
  const pts = dedupe(ring);
  if (pts.length < 3) return;
  const tris = THREE.ShapeUtils.triangulateShape(pts.map(([x, y]) => new THREE.Vector2(x, y)), []);
  for (const [i, j, k] of tris) {
    const a = [pts[i][0], pts[i][1], z];
    let b = [pts[j][0], pts[j][1], z], c = [pts[k][0], pts[k][1], z];
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (nz * facing < 0) [b, c] = [c, b];
    geo.tri(a, b, c, col, 99);
  }
}

// Even resampling of a polyline into n segments.
function resample(pts, n) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const L = cum[cum.length - 1], out = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const d = (L * i) / n;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const t = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push([0, 1, 2].map((k) => pts[j][k] + (pts[j + 1][k] - pts[j][k]) * t));
  }
  return out;
}

// Bake a list of meshes (with transforms) into one geometry per material.
function bake(parts) {
  const byMat = new Map();
  for (const m of parts) {
    m.updateMatrix();
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrix);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(g);
  }
  return [...byMat].map(([mat, gs]) => new THREE.Mesh(mergeGeometries(gs), mat));
}

// Split five-spoke aero wheel from the reveal: dark barrel and blades, bronze fins in the
// splits, a bright machined lip. +x is the outer face; the left wheels are mirrored.
function makeWheel(r, width, m) {
  const parts = [];
  const hw = width / 2, rim = r * 0.7;
  const prof = [
    [rim * 0.98, -hw * 0.95], [r - 0.035, -hw], [r - 0.006, -hw * 0.72], [r, -hw * 0.35],
    [r, hw * 0.35], [r - 0.006, hw * 0.72], [r - 0.035, hw], [rim * 0.98, hw * 0.95],
  ].map(([a, b]) => new THREE.Vector2(a, b));
  const tire = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), m.tire);
  tire.rotation.z = Math.PI / 2;
  parts.push(tire);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rim, rim, width * 0.92, 36, 1, true), m.rimDark);
  barrel.rotation.z = Math.PI / 2;
  parts.push(barrel);
  const lipProf = [[rim - 0.014, hw * 0.7], [rim + 0.003, hw * 0.74], [rim + 0.003, hw * 0.94], [rim - 0.03, hw * 0.94], [rim - 0.03, hw * 0.86]]
    .map(([a, b]) => new THREE.Vector2(a, b));
  const lip = new THREE.Mesh(new THREE.LatheGeometry(lipProf, 48), m.rimSilver);
  lip.rotation.z = Math.PI / 2;
  parts.push(lip);
  const faceRing = new THREE.Mesh(new THREE.RingGeometry(rim * 0.8, rim - 0.028, 48).rotateY(Math.PI / 2), m.rimDark);
  faceRing.position.x = hw * 0.62;
  parts.push(faceRing);
  const blade = new THREE.BoxGeometry(0.03, rim * 0.74, 0.03).translate(0, rim * 0.5, 0);
  const fin = new THREE.BoxGeometry(0.02, rim * 0.5, 0.045).translate(0, rim * 0.52, 0);
  const web = new THREE.BoxGeometry(0.03, rim * 0.22, 0.09).translate(0, rim * 0.22, 0);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    for (const off of [-0.11, 0.11]) {
      const s = new THREE.Mesh(blade, m.rimDark);
      s.rotation.x = a + off;
      s.position.x = hw * 0.58;
      parts.push(s);
    }
    const w = new THREE.Mesh(web, m.rimDark);
    w.rotation.x = a;
    w.position.x = hw * 0.58;
    parts.push(w);
    const f = new THREE.Mesh(fin, m.gold);
    f.rotation.x = a + Math.PI / 5;
    f.position.x = hw * 0.5;
    parts.push(f);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.085, 0.035, 24), m.rimDark);
  hub.rotation.z = Math.PI / 2;
  hub.position.x = hw * 0.6;
  const capn = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.012, 20), m.rimSilver);
  capn.rotation.z = Math.PI / 2;
  capn.position.x = hw * 0.6 + 0.02;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rim * 0.82, rim * 0.82, 0.03, 36), m.metal);
  disc.rotation.z = Math.PI / 2;
  disc.position.x = -hw * 0.02;
  parts.push(hub, capn, disc);
  const g = new THREE.Group();
  for (const mesh of bake(parts)) g.add(mesh);
  return g;
}

// A strip of lit segments along a polyline, one instance per segment.
function lightBar(points, mat) {
  const n = points.length - 1;
  const geo = new THREE.BoxGeometry(1, 0.022, 0.012);
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const u = [];
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, b[1] - a[1], dz);
    p.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    q.setFromEuler(new THREE.Euler(0, -Math.atan2(dz, dx), Math.atan2(b[1] - a[1], Math.hypot(dx, dz))));
    s.set(len * 0.9, 1, 1);
    mesh.setMatrixAt(i, m.compose(p, q, s));
    mesh.setColorAt(i, new THREE.Color(0, 0, 0));
    u.push(p.x);
  }
  mesh.userData.x = u;
  mesh.castShadow = false;
  return mesh;
}

// The nose strip follows the body outline at STRIP_Y from one front arch round the tip to the other.
function noseStrip(xMax) {
  const xAt = (z) => skinX(skin(section(z)), STRIP_Y);
  let lo = 1.3, hi = NOSE;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (xAt(mid) > xMax) lo = mid;
    else hi = mid;
  }
  const side = [];
  for (let i = 0; i <= 40; i++) {
    const z = lo + (NOSE - lo) * (i / 40);
    side.push([xAt(z), STRIP_Y, z]);
  }
  const pts = [...side, [0, STRIP_Y, NOSE + 0.004], ...side.slice().reverse().map(([x, y, z]) => [-x, y, z])];
  const out = resample(pts, 48);
  // stand the strip just proud of the skin
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)];
    let nx = b[2] - a[2], nz = -(b[0] - a[0]);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    if (nx * out[i][0] + nz * (out[i][2] - 1.0) < 0) { nx = -nx; nz = -nz; }
    out[i][0] += nx * 0.005;
    out[i][2] += nz * 0.005;
  }
  return out;
}

export class Roadster {
  constructor() {
    this.root = new THREE.Group();
    this.chassis = new THREE.Group();
    this.root.add(this.chassis);
    this.t = 0;
    this.night = 0;
    this.lightsUser = null; // null = automatic
    this.doorsOpen = false;
    this.wingMode = 'auto';
    this.seqT = 99;
    this.S = { panel: 0, lamp: 0, door: 0, ext: 0, ang: 0, spin: 0, ride: 0, compress: 0, fan: 0, pitch: 0, roll: 0, rear: 0, down: 0, droop: 0 };
    this.m = makeMaterials();
    this.buildBody();
    this.buildDoors();
    this.buildLights();
    this.buildWing();
    this.buildWheels();
    this.buildThrusters();
    this.buildFans();
    this.buildInterior();
    this.root.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh) {
        o.castShadow = !o.material.transparent && o.material.toneMapped !== false;
        o.receiveShadow = true;
      }
    });
  }

  buildBody() {
    const g = new Geo();
    const bodyRing = (z) => full(ring(section(z)));
    loft(g, zList(NOSE, SPLIT_F, [POP.z0, POP.z1, SCREEN_Z, ...archEdges(ARCHES[0])]), bodyRing, bodyColour, true);
    loft(g, zList(SPLIT_R, TAIL, [INTAKE.z0, INTAKE.z1, INTAKE.z1 - 0.006, CANOPY_END, ...archEdges(ARCHES[1])]), bodyRing, bodyColour, true);
    loft(g, zList(SPLIT_F, SPLIT_R), (z) => full(tubRing(section(z))), tubColour, true);
    const nose = bodyRing(NOSE), tail = bodyRing(TAIL);
    cap(g, clipY(nose, 0.41, true), NOSE, 1, PAINT);
    cap(g, clipY(nose, 0.41, false), NOSE, 1, BLACK);
    cap(g, clipY(tail, 0.885, true), TAIL, -1, PAINT);
    cap(g, clipY(tail, 0.885, false), TAIL, -1, BLACK);
    cap(g, bodyRing(SPLIT_F), SPLIT_F, -1, DARK);
    cap(g, bodyRing(SPLIT_R), SPLIT_R, 1, DARK);
    // T-top centre spine over the glass
    loft(g, zList(0.5, -1.62), (z) => {
      const y = canopy(z).ccy + 0.006;
      return [[0.06, y], [-0.06, y]];
    }, PAINT, false);
    // rear deck vents either side of the glass
    for (const side of [1, -1]) {
      loft(g, zList(-1.15, -1.85), (z) => {
        const s = section(z);
        const pts = [[0.8, topAt(s, 0.8) + 0.004], [0.58, topAt(s, 0.58) + 0.004]];
        return side > 0 ? pts : mirror(pts);
      }, BLACK, false);
    }
    const shell = new THREE.Mesh(g.geometry(50), this.m.paint);
    this.chassis.add(shell);

    const gl = new Geo();
    loft(gl, zList(SCREEN_Z, SPLIT_F), canopyFull, PAINT, false);
    loft(gl, zList(SPLIT_F, SPLIT_R), canopyCentre, PAINT, false);
    loft(gl, zList(SPLIT_R, CANOPY_END), canopyFull, PAINT, false);
    this.chassis.add(new THREE.Mesh(gl.geometry(70), this.m.glass));

    // front splitter and the rear diffuser fins
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.018, 0.34), this.m.black);
    splitter.position.set(0, 0.228, 2.17);
    this.chassis.add(splitter);
    for (const x of [-0.45, -0.15, 0.15, 0.45]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.12, 0.6), this.m.black);
      fin.position.set(x, 0.27, -2.03);
      this.chassis.add(fin);
    }
    // plate, centred under the taillight bar
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.012), this.m.plate);
    plate.position.set(0, 0.705, TAIL - 0.012);
    plate.rotation.y = Math.PI;
    this.chassis.add(plate);
  }

  buildDoors() {
    this.doors = [];
    const zs = zList(SPLIT_F - GAP, SPLIT_R + GAP);
    for (const side of [1, -1]) {
      const hx = 0.6 * side, hy = 0.95, hz = SPLIT_F - GAP;
      const pivot = new THREE.Group();
      pivot.position.set(hx, hy, hz);
      const gb = new Geo(), gg = new Geo();
      loft(gb, zs, (z) => (side > 0 ? doorBody(z) : mirror(doorBody(z))), bodyColour, false);
      loft(gg, zs, (z) => (side > 0 ? doorGlass(z) : mirror(doorGlass(z))), PAINT, false);
      pivot.add(new THREE.Mesh(gb.geometry(50).translate(-hx, -hy, -hz), this.m.paintDouble));
      pivot.add(new THREE.Mesh(gg.geometry(70).translate(-hx, -hy, -hz), this.m.glassDouble));
      this.chassis.add(pivot);
      this.doors.push({ pivot, side });
    }
  }

  buildLights() {
    // thin full-width strip low on the nose, wrapping the tip
    this.frontBar = lightBar(noseStrip(0.86), this.m.lightBar);
    this.chassis.add(this.frontBar);
    // full-width taillight across the top of the tail, dipping round the corners
    const sT = section(TAIL + 0.001);
    const tailPts = [];
    for (let i = 0; i <= 36; i++) {
      const x = -0.88 + (1.76 * i) / 36;
      tailPts.push([x, Math.min(0.905, topAt(sT, x) - 0.025), TAIL - 0.007]);
    }
    this.tailBar = lightBar(tailPts, this.m.lightBar);
    this.chassis.add(this.tailBar);

    // Hidden headlights: hood panels hinge up at their rear edge, projector pods rise into the gap.
    this.popups = [];
    for (const side of [1, -1]) {
      const hx = 0.5 * side, hz = POP.z1, hy = topAt(section(hz), 0.5);
      const g = new Geo();
      loft(g, zList(POP.z0, POP.z1), (z) => {
        const s = section(z), xo = popOuter(z);
        const pts = [xo, (xo + POP.xi) / 2, POP.xi].map((x) => [x, topAt(s, x) + 0.005]);
        return side > 0 ? pts : mirror(pts);
      }, PAINT, false);
      const pivot = new THREE.Group();
      pivot.position.set(hx, hy, hz);
      pivot.add(new THREE.Mesh(g.geometry(50).translate(-hx, -hy, -hz), this.m.paintDouble));
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.03, 0.012), this.m.black);
      lip.position.set(0, topAt(section(POP.z0), 0.5) - hy - 0.012, POP.z0 - hz - 0.004);
      pivot.add(lip);
      this.chassis.add(pivot);

      const lz = (POP.z0 + POP.z1) / 2;
      const lamp = new THREE.Group();
      const base = new THREE.Vector3(hx, topAt(section(lz), 0.5) - 0.09, lz);
      lamp.position.copy(base);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.2), this.m.black);
      lamp.add(housing);
      for (const x of [-0.11, 0, 0.11]) {
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.012, 20).rotateX(Math.PI / 2), this.m.lens);
        lens.position.set(x, 0.002, 0.102);
        lamp.add(lens);
      }
      const drl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.008, 0.006), this.m.lens);
      drl.position.set(0, 0.026, 0.102);
      lamp.add(drl);
      const spot = new THREE.SpotLight(0xfff3e2, 0, 170, 0.36, 0.6, 1.4);
      spot.position.set(0, 0, 0.1);
      spot.target.position.set(side * 0.6, -1.4, 28);
      lamp.add(spot, spot.target);
      this.chassis.add(lamp);
      this.popups.push({ pivot, lamp, base, spot });
    }

    this.tailGlow = new THREE.PointLight(0xff2a1a, 0, 7, 2);
    this.tailGlow.position.set(0, 0.8, -2.7);
    this.chassis.add(this.tailGlow);
  }

  buildWing() {
    const deck = -2.02;
    const root = new THREE.Group();
    root.position.set(0, topAt(section(deck), 0), deck);
    const struts = [-0.42, 0.42].map((x) => {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.035, 1, 0.12).translate(0, 0.5, 0), this.m.carbon);
      s.position.x = x;
      root.add(s);
      return s;
    });
    const plane = new THREE.Group();
    // aerofoil blade, extruded across the span
    const foil = new THREE.Shape();
    const pf = [[0.17, 0], [0.12, 0.013], [0.02, 0.021], [-0.1, 0.014], [-0.17, 0.004], [-0.17, -0.004], [-0.1, -0.012], [0.02, -0.02], [0.12, -0.013]];
    foil.moveTo(pf[0][0], pf[0][1]);
    for (let i = 1; i < pf.length; i++) foil.lineTo(pf[i][0], pf[i][1]);
    foil.closePath();
    const bladeGeo = new THREE.ExtrudeGeometry(foil, { depth: 1.86, bevelEnabled: false });
    bladeGeo.rotateY(-Math.PI / 2).translate(0.93, 0, 0);
    const blade = new THREE.Mesh(bladeGeo, this.m.carbon);
    const gurney = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.03, 0.012), this.m.carbon);
    gurney.position.set(0, 0.018, -0.168);
    plane.add(blade, gurney);
    // angled end plates
    const ep = new THREE.Shape();
    for (const [i, [z, y]] of [[0, [0.19, -0.07]], [1, [0.16, 0.06]], [2, [-0.21, 0.06]], [3, [-0.15, -0.1]]]) {
      if (i === 0) ep.moveTo(z, y);
      else ep.lineTo(z, y);
    }
    ep.closePath();
    const epGeo = new THREE.ExtrudeGeometry(ep, { depth: 0.016, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(0.008, 0, 0);
    for (const x of [-0.93, 0.93]) {
      const e = new THREE.Mesh(epGeo, this.m.carbon);
      e.position.set(x, 0, 0);
      e.rotation.z = -Math.sign(x) * 0.2;
      plane.add(e);
    }
    root.add(plane);
    this.chassis.add(root);
    this.wing = { root, plane, struts };
  }

  buildWheels() {
    this.wheels = WHEELS.map((w) => {
      const pivot = new THREE.Group();
      pivot.position.set(w.x, w.r, w.z);
      const spin = new THREE.Group();
      spin.add(makeWheel(w.r, w.w, this.m));
      pivot.add(spin);
      const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.2), this.m.gold);
      caliper.position.set(w.w * 0.1, 0.13, w.front ? -0.13 : 0.13);
      pivot.add(caliper);
      if (w.x < 0) pivot.scale.x = -1;
      this.root.add(pivot);
      return { pivot, spin, w };
    });
  }

  buildThrusters() {
    // Ten cold-gas nozzles: four in a row under the plate (Thrust trim) and six around the floor (Rocket trim).
    // Each plume is a translucent outer cone plus a bright core, scaled by the physics' jet level.
    this.rearNozzles = [];
    this.downNozzles = [];
    const ringGeo = new THREE.CylinderGeometry(0.075, 0.092, 0.12, 24, 1, true).rotateX(Math.PI / 2);
    const lipGeo = new THREE.TorusGeometry(0.088, 0.014, 10, 28);
    const coreGeo = new THREE.CircleGeometry(0.068, 24);
    const jetGeo = new THREE.ConeGeometry(0.09, 1, 16, 1, true).rotateX(Math.PI).translate(0, -0.5, 0);
    const coreJet = new THREE.ConeGeometry(0.042, 1, 10, 1, true).rotateX(Math.PI).translate(0, -0.5, 0);
    for (const x of [-0.57, -0.19, 0.19, 0.57]) {
      const n = new THREE.Group();
      n.position.set(x, 0.465, TAIL + 0.012);
      const ring = new THREE.Mesh(ringGeo, this.m.metal);
      const lip = new THREE.Mesh(lipGeo, this.m.gold);
      lip.position.z = -0.055;
      const core = new THREE.Mesh(coreGeo, this.m.core);
      core.rotation.y = Math.PI;
      core.position.z = 0.02;
      const jet = new THREE.Mesh(jetGeo, this.m.jetRear);
      jet.rotation.x = Math.PI / 2;
      jet.position.z = -0.05;
      jet.castShadow = false;
      const jc = new THREE.Mesh(coreJet, this.m.jetCore);
      jc.rotation.x = Math.PI / 2;
      jc.position.z = -0.05;
      jc.castShadow = false;
      n.add(ring, lip, core, jet, jc);
      this.chassis.add(n);
      this.rearNozzles.push({ group: n, jet, jc });
    }
    // Rocket-trim perimeter thrusters under the floor, pointing down: FL FR ML MR RL RR (+x is left)
    const spots = [[0.62, 0.22, 1.75], [-0.62, 0.22, 1.75], [0.9, 0.21, 0.2], [-0.9, 0.21, 0.2], [0.88, 0.23, -1.62], [-0.88, 0.23, -1.62]];
    for (const [x, y, z] of spots) {
      const n = new THREE.Group();
      n.position.set(x, y, z);
      const ring = new THREE.Mesh(ringGeo, this.m.metal);
      ring.rotation.x = Math.PI / 2;
      ring.scale.setScalar(0.8);
      const core = new THREE.Mesh(coreGeo, this.m.core);
      core.rotation.x = Math.PI / 2;
      const jet = new THREE.Mesh(jetGeo, this.m.jetDown);
      jet.scale.set(0.8, 0.5, 0.8);
      jet.castShadow = false;
      const jc = new THREE.Mesh(coreJet, this.m.jetCore);
      jc.scale.set(0.8, 0.5, 0.8);
      jc.castShadow = false;
      n.add(ring, core, jet, jc);
      this.chassis.add(n);
      this.downNozzles.push({ group: n, jet, jc });
    }
  }

  buildFans() {
    this.fans = [];
    for (const z of [0.85, -0.45]) {
      const f = new THREE.Group();
      f.position.set(0, 0.18, z);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.014, 8, 36).rotateX(Math.PI / 2), this.m.fanGlow);
      const blades = new THREE.Group();
      for (let i = 0; i < 7; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.006, 0.05).translate(0.11, 0, 0), this.m.metal);
        b.rotation.set(0.35, (i / 7) * Math.PI * 2, 0);
        blades.add(b);
      }
      f.add(ring, blades);
      this.chassis.add(f);
      this.fans.push(blades);
    }
    this.underglow = new THREE.PointLight(0x7fdcff, 0, 7, 2);
    this.underglow.position.set(0, 0.1, 0.2);
    this.chassis.add(this.underglow);
  }

  buildInterior() {
    const m = this.m;
    for (const x of [0.38, -0.38]) {
      const seat = new THREE.Group();
      seat.position.set(x, 0, -0.42);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.09, 0.52), m.seat);
      base.position.set(0, 0.49, 0.06);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.09), m.seat);
      back.position.set(0, 0.74, -0.24);
      back.rotation.x = -0.22;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.08), m.seat);
      head.position.set(0, 1.02, -0.31);
      head.rotation.x = -0.22;
      const bolsterL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.14), m.suede);
      bolsterL.position.set(0.23, 0.72, -0.22);
      bolsterL.rotation.x = -0.22;
      const bolsterR = bolsterL.clone();
      bolsterR.position.x = -0.23;
      seat.add(base, back, head, bolsterL, bolsterR);
      this.chassis.add(seat);
    }
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.1, 0.32), m.suede);
    dash.position.set(0, 0.75, 0.6);
    const console = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.95), m.suede);
    console.position.set(0, 0.5, -0.05);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.15), m.screen);
    screen.position.set(0.0, 0.86, 0.5);
    screen.rotation.set(-0.3, Math.PI, 0);
    this.chassis.add(dash, console, screen);
    // Yoke on the driver's (left) side
    const yoke = new THREE.Group();
    yoke.position.set(0.38, 0.78, 0.28);
    yoke.rotation.x = 0.25;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.03), m.suede);
    bar.position.y = -0.08;
    const hub = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.035), m.carbon);
    yoke.add(bar, hub);
    for (const x of [-0.15, 0.15]) {
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.17, 0.035), m.suede);
      grip.position.set(x, -0.005, 0);
      yoke.add(grip);
    }
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.28, 10).rotateX(Math.PI / 2), m.carbon);
    column.position.set(0.38, 0.77, 0.42);
    this.chassis.add(yoke, column);
    this.yoke = yoke;
  }

  // --- articulation controls -------------------------------------------------

  startup() {
    this.seqT = 0;
  }
  toggleLights() {
    const current = this.lightsUser !== null ? this.lightsUser : this.night > 0.4;
    this.lightsUser = !current;
    return this.lightsUser;
  }
  toggleDoors() {
    this.doorsOpen = !this.doorsOpen;
    return this.doorsOpen;
  }
  cycleWing() {
    const order = ['auto', 'up', 'down'];
    this.wingMode = order[(order.indexOf(this.wingMode) + 1) % order.length];
    return this.wingMode;
  }
  land(strength) {
    this.S.compress = Math.min(0.09, strength * 0.004);
  }
  get headlightsOn() {
    return this.lightsUser !== null ? this.lightsUser : this.night > 0.4;
  }

  // Loose copies of the wheels, doors and wing for the explosion; the car itself goes dark.
  shed() {
    const parts = [];
    if (this.model) {
      const N = this.model.N, w = new THREE.Vector3();
      for (const k of ['Wheel_FL_Steer', 'Wheel_FR_Steer', 'Wheel_RL', 'Wheel_RR', 'Spoiler_Lift', 'FrontWing_Hinge']) {
        const o = N[k];
        if (!o) continue;
        o.getWorldPosition(w);
        parts.push({ mesh: o.clone(), local: this.root.worldToLocal(w.clone()) });
      }
      this.root.visible = false;
      return parts;
    }
    for (const wh of this.wheels) {
      const c = wh.pivot.clone();
      parts.push({ mesh: c, local: wh.pivot.position.clone() });
    }
    for (const d of this.doors) {
      const c = d.pivot.clone();
      parts.push({ mesh: c, local: d.pivot.position.clone().setY(0.95) });
    }
    const wing = this.wing.plane.clone();
    parts.push({ mesh: wing, local: new THREE.Vector3(0, 1.0, -2.0) });
    this.root.visible = false;
    return parts;
  }

  revive() {
    this.root.visible = true;
    this.seqT = 0;
  }

  // --- Kenny's Roadster model (assets/roadster.glb) ----------------------------------------
  // The procedural car stays underneath as the rig: its lights, thruster plumes and the groups
  // the effects read positions from keep working, only its meshes are hidden. The model's own
  // moving parts are driven from the same state each frame (see animateModel).

  // `src` is a .glb URL, or a module whose default export is the .glb as base64 (how the
  // published game ships it, since the page host serves scripts but not .glb files)
  // Fuel add-ons recolour the plumes and the booster glow and stretch the flames (js/addons.js).
  setFuel(look) {
    this.fuel = look;
    this.m.jetRear.color.setRGB(...look.rear);
    this.m.jetDown.color.setRGB(...look.down);
    this.m.jetCore.color.setRGB(...look.core);
    this.applyGlow();
  }

  applyGlow() {
    const g = this.model?.mats.BoosterGlow;
    if (!g) return;
    if (!this.glowBase) this.glowBase = g.emissive.clone();
    if (this.fuel?.glow) g.emissive.setRGB(...this.fuel.glow);
    else g.emissive.copy(this.glowBase);
  }

  async loadModel(src) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    let gltf;
    if (/\.m?js(\?|$)/.test(src)) {
      const b64 = (await import(src)).default;
      const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      gltf = await loader.parseAsync(bin.buffer, '');
    } else gltf = await loader.loadAsync(src);
    this.useModel(gltf.scene);
    return this;
  }

  useModel(scene) {
    // its axles sit 17 cm behind the physics wheelbase: line them up, wheels on the ground
    const holder = new THREE.Group();
    holder.position.set(0, 0.015, 0.174);
    const N = {};
    const mats = {};
    scene.traverse((o) => {
      if (o.name) N[o.name] = o;
      if (o.isMesh) {
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        o.castShadow = true;
        o.receiveShadow = true;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats[m.name] = m;
      }
    });
    // hide the procedural body, wheels and lamps (not its lights or plumes)
    const keep = new Set();
    for (const n of [...this.rearNozzles, ...this.downNozzles]) { keep.add(n.jet); keep.add(n.jc); }
    // (anything marked noHide, like the cockpit cabin, is left alone)
    const hide = (o) => {
      if (o.userData.noHide) return;
      if ((o.isMesh || o.isInstancedMesh) && !keep.has(o)) o.visible = false;
      for (const c of o.children) hide(c);
    };
    hide(this.chassis);
    for (const w of this.wheels) hide(w.pivot);
    holder.add(scene);
    this.chassis.add(holder);
    // the rear plumes come out of the model's four boosters
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.chassis.matrixWorld).invert();
    const boosters = ['Booster_0R', 'Booster_1R', 'Booster_1L', 'Booster_0L'].map((k) => N[`${k}_Mesh`] || N[k]).filter(Boolean);
    boosters.sort((a, b) => a.getWorldPosition(new THREE.Vector3()).x - b.getWorldPosition(new THREE.Vector3()).x);
    const xs = this.rearNozzles.map((n, i) => i).sort((a, b) => this.rearNozzles[a].group.position.x - this.rearNozzles[b].group.position.x);
    boosters.forEach((b, i) => {
      const box = new THREE.Box3().setFromObject(b).applyMatrix4(inv);
      const c = box.getCenter(new THREE.Vector3());
      const n = this.rearNozzles[xs[i]];
      if (n) n.group.position.set(c.x, c.y, box.min.z + 0.02);
    });
    const rest = (o) => o && { o, q: o.quaternion.clone(), p: o.position.clone() };
    this.model = {
      holder, N, mats,
      steer: [rest(N.Wheel_FL_Steer), rest(N.Wheel_FR_Steer)].filter(Boolean),
      spin: ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'].map((k) => rest(N[k])).filter(Boolean),
      rearWheels: [rest(N.Wheel_RL), rest(N.Wheel_RR)].filter(Boolean),
      panels: [rest(N.HeadlightPanel_L_Hinge), rest(N.HeadlightPanel_R_Hinge)].filter(Boolean),
      wing: rest(N.FrontWing_Hinge),
      lift: rest(N.Spoiler_Lift),
      hinge: rest(N.Spoiler_Hinge),
      fans: ['Fan_0L', 'Fan_0R', 'Fan_1L', 'Fan_1R'].map((k) => N[k]).filter(Boolean),
      body: mats.Body,
    };
    for (const k of ['Headlight', 'Taillight', 'BoosterGlow']) if (mats[k]) mats[k].toneMapped = false;
    this.applyGlow();
    this.root.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.visible) { o.castShadow = !o.material.transparent; o.receiveShadow = true; } });
  }

  animateModel(dt, v) {
    const M = this.model, S = this.S;
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    for (const w of M.steer) {
      w.o.quaternion.copy(w.q).multiply(q.setFromAxisAngle(Y, -v.steerAngle));
      w.o.position.y = w.p.y - S.droop;
    }
    for (const w of M.spin) w.o.quaternion.copy(w.q).multiply(q.setFromAxisAngle(X, S.spin));
    for (const w of M.rearWheels) w.o.position.y = w.p.y - S.droop;
    // the headlight panels drop down into their pockets about their front-edge hinges to reveal
    // the lamps; a bad hit leaves the right one only partly open
    M.panels.forEach((h, i) => {
      const stuck = i === 1 && v.health < 45 ? 0.6 : 1;
      h.o.quaternion.copy(h.q).multiply(q.setFromAxisAngle(X, 0.55 * S.panel * stuck));
    });
    // the rear spoiler rises and tilts like the procedural wing; the front wing is the air brake
    if (M.lift) M.lift.o.position.y = M.lift.p.y + S.ext * 0.9;
    if (M.hinge) M.hinge.o.quaternion.copy(M.hinge.q).multiply(q.setFromAxisAngle(X, -S.ang * 0.8));
    if (M.wing) {
      this.S.fw = damp(this.S.fw || 0, v.braking && v.speed > 18 ? 1 : 0, 6, dt);
      M.wing.o.quaternion.copy(M.wing.q).multiply(q.setFromAxisAngle(X, -0.7 * this.S.fw));
    }
    for (const f of M.fans) f.rotateY(dt * S.fan * 60);
    const mats = M.mats;
    if (mats.Headlight) mats.Headlight.emissiveIntensity = 0.3 + 8 * S.lamp;
    if (mats.Taillight) mats.Taillight.emissiveIntensity = (1 + this.night * 3) * (v.braking ? 2.6 : 1);
    if (mats.BoosterGlow) mats.BoosterGlow.emissiveIntensity = 0.4 + Math.max(S.rear, S.down) * 8;
    if (M.body) {
      const dmg = 1 - v.health / 100;
      M.body.color.setScalar(1 - dmg * 0.3);
    }
  }

  update(dt, v) {
    const S = this.S;
    this.t += dt;
    this.seqT += dt;
    const seq = this.seqT;
    const speed = v.speed;
    const dmg = 1 - v.health / 100;
    const critical = v.health < 25;

    // suspension: squat, dive and roll from the physics accelerations
    S.pitch = damp(S.pitch, clamp(-v.accelLong * 0.0016, -0.035, 0.035), 6, dt);
    S.roll = damp(S.roll, clamp(v.accelLat * 0.0035, -0.045, 0.045), 6, dt);
    S.compress = damp(S.compress, 0, 7, dt);
    S.droop = damp(S.droop, v.grounded ? 0 : 0.07, 6, dt);
    this.chassis.rotation.set(S.pitch, 0, S.roll + dmg * 0.012);
    this.chassis.position.y = -S.compress - dmg * 0.02;

    // wheels
    S.spin += (v.vf * dt) / 0.365;
    for (const wh of this.wheels) {
      wh.spin.rotation.x = S.spin;
      wh.pivot.rotation.y = wh.w.front ? -v.steerAngle : 0;
      wh.pivot.position.y = wh.w.r - S.droop;
    }
    this.yoke.rotation.z = v.steerAngle * 6;

    // paint loses its clearcoat and picks up grime as the car takes hits
    this.m.paint.roughness = 0.3 + dmg * 0.4;
    this.m.paint.clearcoat = 0.7 * (1 - dmg);
    const tint = 1 - dmg * 0.3;
    this.m.paint.color.setRGB(0.933 * tint, 0.937 * tint, 0.945 * tint);
    this.m.paintDouble.roughness = this.m.paint.roughness;
    this.m.paintDouble.clearcoat = this.m.paint.clearcoat;
    this.m.paintDouble.color.copy(this.m.paint.color);

    // headlights (a bad hit leaves one pod drooping and flickering)
    const flash = seq > 0.25 && seq < 1.7;
    const want = this.headlightsOn || flash;
    S.panel = damp(S.panel, want ? 1 : 0, 8, dt);
    S.lamp = damp(S.lamp, want && S.panel > 0.55 ? 1 : 0, 9, dt);
    const flicker = critical && Math.random() < 0.08 ? 0.2 : 1;
    this.popups.forEach((p, i) => {
      const stuck = i === 1 && v.health < 45 ? 0.6 : 1;
      p.pivot.rotation.x = -0.62 * S.panel * stuck;
      p.lamp.position.y = p.base.y + 0.1 * S.lamp * stuck;
      p.spot.intensity = this.headlightsOn ? 2600 * S.lamp * (i === 1 ? stuck * flicker : 1) : 0;
    });
    const lensK = 0.4 + 9 * S.lamp * flicker;
    this.m.lens.color.setRGB(lensK, lensK, lensK * 1.05);

    // light bars: start-up sweep from the centre, DRL, brake, reverse, indicators
    const sweep = clamp(seq * 1.25, 0, 1.2);
    const blink = Math.sin(this.t * 9.4) > 0;
    const indicate = speed < 16 && v.grounded && Math.abs(v.steerIn) > 0.55 ? Math.sign(v.steerIn) : 0;
    const hazard = critical && blink;
    const col = new THREE.Color();
    const fx = this.frontBar.userData.x;
    for (let i = 0; i < fx.length; i++) {
      const u = Math.abs(fx[i]) / 0.89;
      const on = clamp((sweep - u) * 8, 0, 1);
      const k = on * (this.headlightsOn ? 9 : 6) * flicker;
      // car's right is -x, so a right turn blinks the -x end
      if ((indicate && blink && u > 0.82 && Math.sign(-fx[i]) === indicate) || (hazard && u > 0.82)) col.setRGB(7, 3, 0.2);
      else col.setRGB(k, k, k * 1.06);
      this.frontBar.setColorAt(i, col);
    }
    this.frontBar.instanceColor.needsUpdate = true;
    const tx = this.tailBar.userData.x;
    const brake = v.braking ? 2.6 : 1;
    for (let i = 0; i < tx.length; i++) {
      const u = Math.abs(tx[i]) / 0.88;
      const on = clamp((sweep - u) * 8, 0, 1);
      if (v.reversing && u < 0.14) col.setRGB(7, 7, 7);
      else if ((indicate && blink && u > 0.82 && Math.sign(-tx[i]) === indicate) || (hazard && u > 0.82)) col.setRGB(7, 3, 0.2);
      else col.setRGB(2.4 * on * brake, 0.012 * on * brake, 0.02 * on * brake);
      this.tailBar.setColorAt(i, col);
    }
    this.tailBar.instanceColor.needsUpdate = true;
    this.tailGlow.intensity = (0.6 + this.night * 3) * brake;

    // rear wing: stowed, raised for downforce, air brake, flight trim; sags when damaged
    let ext = 0, ang = 0;
    const fast = speed > 22;
    if (!v.grounded) { ext = 0.2; ang = -0.06; }
    else if (v.braking && speed > 18 && this.wingMode !== 'down') { ext = 0.26; ang = -0.95; }
    else if (this.wingMode === 'up' || (this.wingMode === 'auto' && fast)) { ext = 0.22; ang = 0.08; }
    if (seq > 0.5 && seq < 1.9) { ext = 0.22; ang = 0.08; }
    if (v.health < 35) { ang += 0.25 + Math.sin(this.t * 7) * 0.04; }
    S.ext = damp(S.ext, ext, 5, dt);
    S.ang = damp(S.ang, ang, 7, dt);
    for (const s of this.wing.struts) s.scale.y = S.ext + 0.04;
    this.wing.plane.position.y = S.ext + 0.045;
    this.wing.plane.rotation.x = S.ang;
    this.wing.plane.rotation.z = v.health < 35 ? 0.06 : 0;

    // butterfly doors: lift about the A-pillar hinge and tilt outward
    if (this.doorsOpen && (speed > 2 || !v.grounded)) this.doorsOpen = false;
    S.door = damp(S.door, this.doorsOpen ? 1 : 0, 2.6, dt);
    for (const d of this.doors) {
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.15 * S.door);
      const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -d.side * 0.38 * S.door);
      d.pivot.quaternion.copy(qz.multiply(qx));
    }

    // cold-gas thrusters: four rear plumes for boost, six floor nozzles for jump / flips / hover
    const J = v.jets;
    S.rear = J.rear;
    const flick = 0.85 + 0.15 * Math.sin(this.t * 61) * Math.sin(this.t * 37);
    for (const n of this.rearNozzles) {
      const len = this.fuel?.len || 1; // combustion and rocket fuel burn longer flames
      n.jet.scale.set(1 + S.rear * 0.5, 0.15 + S.rear * 2.4 * flick * len, 1 + S.rear * 0.5);
      n.jc.scale.set(1, 0.1 + S.rear * 1.5 * flick * len, 1);
      n.jet.visible = n.jc.visible = S.rear > 0.02;
    }
    this.m.jetRear.opacity = clamp(S.rear * 0.85, 0, 0.9);
    this.m.jetCore.opacity = clamp(Math.max(S.rear, ...J.down) * 0.9, 0, 0.95);
    let down = 0;
    this.downNozzles.forEach((n, i) => {
      const k = J.down[i];
      down = Math.max(down, k);
      n.jet.scale.set(0.8 + k * 0.4, 0.1 + k * 1.6 * flick, 0.8 + k * 0.4);
      n.jc.scale.set(0.8, 0.08 + k * 1.1 * flick, 0.8);
      n.jet.visible = n.jc.visible = k > 0.02;
    });
    S.down = down;
    this.m.jetDown.opacity = 0.8;
    const core = 0.15 + Math.max(S.rear, down) * 6;
    this.m.core.color.setRGB(core * 0.7, core * 0.9, core * 1.2);

    // floor fans: spin up for suction on walls and at speed
    S.fan = damp(S.fan, v.fans, 3, dt);
    for (const f of this.fans) f.rotation.y += dt * S.fan * 60;
    const glow = S.fan * 5;
    this.m.fanGlow.color.setRGB(glow * 0.45, glow * 0.85, glow);
    this.underglow.intensity = S.fan * 10;
    if (this.model) this.animateModel(dt, v);
  }
}

function makeMaterials() {
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xeeeff1, metalness: 0.08, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.18,
    vertexColors: true,
  });
  // gold-tinted glass: reads bronze from above in daylight, near-black from the side
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x6a4420, metalness: 0.9, roughness: 0.06, transparent: true, opacity: 0.94, envMapIntensity: 1.8,
  });
  const additive = (r, g, b) => new THREE.MeshBasicMaterial({
    color: new THREE.Color(r, g, b), transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  return {
    paint,
    paintDouble: Object.assign(paint.clone(), { side: THREE.DoubleSide }),
    glass,
    glassDouble: Object.assign(glass.clone(), { side: THREE.DoubleSide }),
    black: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.55, metalness: 0.2 }),
    carbon: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.3, metalness: 0.45 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.9, side: THREE.DoubleSide }),
    rimDark: new THREE.MeshStandardMaterial({ color: 0x111216, roughness: 0.35, metalness: 0.75, side: THREE.DoubleSide }),
    rimSilver: new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.18, metalness: 1 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xb48b4f, roughness: 0.28, metalness: 1 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8e939a, roughness: 0.35, metalness: 1 }),
    seat: new THREE.MeshStandardMaterial({ color: 0xe4e1db, roughness: 0.75 }),
    suede: new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.95 }),
    plate: new THREE.MeshStandardMaterial({ map: plateTexture('RDSTR'), roughness: 0.5 }),
    jetCore: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.4, 2.8), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    screen: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.4, 0.6) }),
    lightBar: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    lens: new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false }),
    core: new THREE.MeshBasicMaterial({ color: 0x223344, toneMapped: false, side: THREE.DoubleSide }),
    fanGlow: new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }),
    jetRear: additive(0.9, 1.3, 1.9),
    jetDown: additive(0.8, 1.2, 1.7),
  };
}
