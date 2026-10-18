import * as THREE from 'three';

// Low-poly models of the Tesla lineup, people and Optimus, built for instancing.
//
// Each vehicle is three geometries: `paint` (tinted per car with instance colour), `fixed` (glass,
// tyres, rims, trim: vertex colours) and `lights` (head and tail lamps, drawn unlit so they glow).
// Bodies are lofted from cross-sections along the car (rear to front, +z forward), which gets the
// silhouettes right: the Model 3's fastback, the Y's hatch, the Cybercab's teardrop, the
// Cybertruck's flat-sided wedge. Dimensions are the published ones where Tesla gives them.
//
// Humanoids are four parts (torso, head, legs, arms) with their pivots at the hip and shoulder so
// the traffic module can swing them for a walk cycle.

const C = (hex) => new THREE.Color(hex);
const GLASS = C('#0b0f14');
const TYRE = C('#141414');
const RIM = C('#9da2a8');
const DARK = C('#1b1c1e');
const ARCH = C('#0a0a0b');
const WHITE = C('#ffffff');
const LAMP_W = C('#fff6e8');
const LAMP_R = C('#ff1a14');

class Builder {
  constructor() {
    this.p = [];
    this.c = [];
  }

  tri(a, b, c, col, ref) {
    if (ref) {
      // face outward from the reference point
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const mx = (a[0] + b[0] + c[0]) / 3 - ref[0], my = (a[1] + b[1] + c[1]) / 3 - ref[1], mz = (a[2] + b[2] + c[2]) / 3 - ref[2];
      if (nx * mx + ny * my + nz * mz < 0) [b, c] = [c, b];
    }
    this.p.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.c.push(col.r, col.g, col.b);
  }

  quad(a, b, c, d, col, ref) {
    this.tri(a, b, c, col, ref);
    this.tri(a, c, d, col, ref);
  }

  add(geo, col, matrix) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const pos = g.attributes.position.array;
    for (let i = 0; i < pos.length; i++) this.p.push(pos[i]);
    for (let i = 0; i < pos.length / 3; i++) this.c.push(col.r, col.g, col.b);
  }

  box(x, y, z, sx, sy, sz, col = WHITE, rotY = 0, rotX = 0) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
    this.add(new THREE.BoxGeometry(sx, sy, sz), col, m);
  }

  // a wheel on the x axis: tyre, rim face and a dark arch disc behind it on the body side
  wheel(x, y, z, r, w, side) {
    const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x, y, z);
    this.add(new THREE.CylinderGeometry(r, r, w, 14), TYRE, m);
    const rim = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x + side * (w / 2 + 0.005), y, z);
    this.add(new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.012, 10), RIM, rim);
  }

  arch(x, y, z, r) {
    const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x, y, z);
    this.add(new THREE.CylinderGeometry(r, r, 0.01, 14), ARCH, m);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// Loft a body. Sections run rear to front: {z, hw, yb, belt, roof, rw, s, t}, where s and t say
// whether the span to the next section has glass on the sides (s) and over the top (t).
function loft(paint, fixed, secs, o = {}) {
  const ring = (q) => {
    const r = Math.min(0.12, q.hw * 0.14);
    const right = [
      [0, q.yb], [q.hw - r, q.yb], [q.hw, q.yb + r], [q.hw, q.belt - 0.05], [q.hw * 0.985, q.belt],
      [q.rw, q.roof - (o.flat ? 0 : 0.07)], [o.flat ? q.rw * 0.99 : q.rw * 0.66, q.roof], [0, q.roof + (o.crown || 0)],
    ];
    const left = right.slice(1, -1).reverse().map(([x, y]) => [-x, y]);
    return right.concat(left).map(([x, y]) => [x, y, q.z]);
  };
  // segment classes around the ring (14 segments): underside, body, glass side, top
  const CLS = ['under', 'body', 'body', 'body', 'side', 'top', 'top', 'top', 'top', 'side', 'body', 'body', 'body', 'under'];
  const rings = secs.map(ring);
  for (let i = 0; i < secs.length - 1; i++) {
    const A = rings[i], B = rings[i + 1], sa = secs[i], sb = secs[i + 1];
    const ref = [0, (sa.yb + sa.roof + sb.yb + sb.roof) / 4, (sa.z + sb.z) / 2];
    for (let k = 0; k < A.length; k++) {
      const k2 = (k + 1) % A.length, cls = CLS[k];
      let target = paint, col = WHITE;
      if (cls === 'under') { target = fixed; col = DARK; }
      else if (cls === 'side' && sa.s) { target = fixed; col = GLASS; }
      else if (cls === 'top' && sa.t) { target = fixed; col = GLASS; }
      target.quad(A[k], B[k], B[k2], A[k2], col, ref);
    }
  }
  // end caps
  for (const [q, R, dz] of [[secs[0], rings[0], -1], [secs[secs.length - 1], rings[rings.length - 1], 1]]) {
    const c = [0, (q.yb + q.roof) / 2, q.z];
    const ref = [0, c[1], q.z - dz];
    for (let k = 0; k < R.length; k++) paint.tri(c, R[k], R[(k + 1) % R.length], WHITE, ref);
  }
}

function lamps(b, hw, y, z, dir, col, mode, h = 0.06) {
  if (mode === 'bar') b.box(0, y, z + dir * 0.012, hw * 1.9, h, 0.03, col);
  else for (const s of [-1, 1]) b.box(s * hw * 0.72, y, z + dir * 0.012, hw * 0.42, h, 0.03, col, s * dir * 0.25);
}

function finish(name, paint, fixed, lights, info) {
  return { name, paint: paint.geometry(), fixed: fixed.geometry(), lights: lights.geometry(), ...info };
}

// --- vehicles -----------------------------------------------------------------------------

function model3() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  const len = 4.72, hw = 0.925, r = 0.34, fa = 1.5, ra = 1.5 - 2.875;
  loft(P, F, [
    { z: -2.36, hw: 0.80, yb: 0.30, belt: 0.85, roof: 0.92, rw: 0.70, s: 0, t: 0 },
    { z: -2.20, hw: 0.90, yb: 0.20, belt: 0.95, roof: 1.00, rw: 0.80, s: 0, t: 0 },
    { z: -1.75, hw: 0.92, yb: 0.16, belt: 0.98, roof: 1.02, rw: 0.82, s: 1, t: 1 },
    { z: -1.00, hw: 0.925, yb: 0.16, belt: 0.98, roof: 1.40, rw: 0.66, s: 1, t: 1 },
    { z: 0.10, hw: 0.925, yb: 0.16, belt: 0.97, roof: 1.44, rw: 0.68, s: 1, t: 1 },
    { z: 0.55, hw: 0.925, yb: 0.16, belt: 0.95, roof: 1.36, rw: 0.66, s: 1, t: 1 },
    { z: 1.30, hw: 0.92, yb: 0.16, belt: 0.92, roof: 0.98, rw: 0.80, s: 0, t: 0 },
    { z: 2.05, hw: 0.88, yb: 0.20, belt: 0.80, roof: 0.84, rw: 0.72, s: 0, t: 0 },
    { z: 2.36, hw: 0.70, yb: 0.30, belt: 0.55, roof: 0.62, rw: 0.55, s: 0, t: 0 },
  ]);
  for (const z of [fa, ra]) for (const s of [-1, 1]) { F.arch(s * (hw + 0.004), r, z, r + 0.07); F.wheel(s * (hw - 0.07), r, z, r, 0.24, s); }
  for (const s of [-1, 1]) P.box(s * (hw + 0.06), 1.0, 0.95, 0.12, 0.08, 0.2);
  lamps(L, hw, 0.68, 2.3, 1, LAMP_W, 'pair', 0.07);
  lamps(L, hw, 0.86, -2.3, -1, LAMP_R, 'pair', 0.08);
  return finish('Model 3', P, F, L, { L: len, W: 1.85, H: 1.44, mass: 1.8, paints: ['#e8e8e6', '#121316', '#4a4d52', '#a8adb3', '#8f0f16', '#1f3a6e'], weights: [35, 20, 15, 12, 10, 8] });
}

function modelY() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  const hw = 0.96, r = 0.36, fa = 1.47, ra = 1.47 - 2.89;
  loft(P, F, [
    { z: -2.38, hw: 0.85, yb: 0.32, belt: 0.95, roof: 1.05, rw: 0.72, s: 0, t: 0 },
    { z: -2.20, hw: 0.94, yb: 0.22, belt: 1.02, roof: 1.30, rw: 0.74, s: 1, t: 1 },
    { z: -1.70, hw: 0.96, yb: 0.18, belt: 1.02, roof: 1.56, rw: 0.70, s: 1, t: 1 },
    { z: 0.00, hw: 0.96, yb: 0.18, belt: 1.00, roof: 1.62, rw: 0.72, s: 1, t: 1 },
    { z: 0.50, hw: 0.96, yb: 0.18, belt: 0.98, roof: 1.55, rw: 0.70, s: 1, t: 1 },
    { z: 1.30, hw: 0.95, yb: 0.18, belt: 0.98, roof: 1.04, rw: 0.82, s: 0, t: 0 },
    { z: 2.05, hw: 0.90, yb: 0.22, belt: 0.88, roof: 0.92, rw: 0.76, s: 0, t: 0 },
    { z: 2.38, hw: 0.72, yb: 0.32, belt: 0.60, roof: 0.68, rw: 0.58, s: 0, t: 0 },
  ]);
  for (const z of [fa, ra]) for (const s of [-1, 1]) { F.arch(s * (hw + 0.004), r, z, r + 0.08); F.wheel(s * (hw - 0.07), r, z, r, 0.26, s); }
  for (const s of [-1, 1]) P.box(s * (hw + 0.06), 1.06, 0.95, 0.12, 0.09, 0.2);
  lamps(L, hw, 0.76, 2.32, 1, LAMP_W, 'pair', 0.07);
  lamps(L, hw, 0.98, -2.36, -1, LAMP_R, 'bar', 0.05);
  return finish('Model Y', P, F, L, { L: 4.75, W: 1.92, H: 1.62, mass: 2.0, paints: ['#e8e8e6', '#121316', '#4a4d52', '#a8adb3', '#8f0f16', '#1f3a6e'], weights: [38, 20, 16, 10, 9, 7] });
}

function modelS() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  const hw = 0.98, r = 0.36, fa = 1.62, ra = 1.62 - 2.96;
  loft(P, F, [
    { z: -2.51, hw: 0.84, yb: 0.30, belt: 0.86, roof: 0.94, rw: 0.72, s: 0, t: 0 },
    { z: -2.30, hw: 0.95, yb: 0.20, belt: 0.95, roof: 1.04, rw: 0.80, s: 1, t: 1 },
    { z: -1.10, hw: 0.98, yb: 0.15, belt: 0.97, roof: 1.38, rw: 0.68, s: 1, t: 1 },
    { z: 0.10, hw: 0.98, yb: 0.15, belt: 0.96, roof: 1.43, rw: 0.70, s: 1, t: 1 },
    { z: 0.62, hw: 0.98, yb: 0.15, belt: 0.95, roof: 1.36, rw: 0.68, s: 1, t: 1 },
    { z: 1.42, hw: 0.97, yb: 0.15, belt: 0.91, roof: 0.97, rw: 0.82, s: 0, t: 0 },
    { z: 2.20, hw: 0.92, yb: 0.20, belt: 0.79, roof: 0.83, rw: 0.74, s: 0, t: 0 },
    { z: 2.51, hw: 0.72, yb: 0.30, belt: 0.55, roof: 0.62, rw: 0.56, s: 0, t: 0 },
  ]);
  for (const z of [fa, ra]) for (const s of [-1, 1]) { F.arch(s * (hw + 0.004), r, z, r + 0.07); F.wheel(s * (hw - 0.07), r, z, r, 0.26, s); }
  for (const s of [-1, 1]) P.box(s * (hw + 0.06), 1.0, 1.0, 0.12, 0.08, 0.2);
  lamps(L, hw, 0.68, 2.45, 1, LAMP_W, 'pair', 0.07);
  lamps(L, hw, 0.88, -2.48, -1, LAMP_R, 'bar', 0.05);
  return finish('Model S', P, F, L, { L: 5.02, W: 1.96, H: 1.43, mass: 2.1, paints: ['#e8e8e6', '#121316', '#4a4d52', '#8f0f16', '#1f3a6e'], weights: [30, 30, 15, 15, 10] });
}

function modelX() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  const hw = 1.0, r = 0.38, fa = 1.6, ra = 1.6 - 2.97;
  loft(P, F, [
    { z: -2.53, hw: 0.88, yb: 0.32, belt: 0.98, roof: 1.10, rw: 0.74, s: 0, t: 0 },
    { z: -2.30, hw: 0.98, yb: 0.22, belt: 1.05, roof: 1.42, rw: 0.76, s: 1, t: 1 },
    { z: -1.60, hw: 1.0, yb: 0.18, belt: 1.05, roof: 1.64, rw: 0.72, s: 1, t: 1 },
    { z: 0.10, hw: 1.0, yb: 0.18, belt: 1.03, roof: 1.68, rw: 0.74, s: 1, t: 1 },
    { z: 0.60, hw: 1.0, yb: 0.18, belt: 1.0, roof: 1.58, rw: 0.72, s: 1, t: 1 },
    { z: 1.45, hw: 0.99, yb: 0.18, belt: 1.0, roof: 1.06, rw: 0.84, s: 0, t: 0 },
    { z: 2.22, hw: 0.94, yb: 0.22, belt: 0.9, roof: 0.94, rw: 0.78, s: 0, t: 0 },
    { z: 2.53, hw: 0.74, yb: 0.32, belt: 0.62, roof: 0.70, rw: 0.58, s: 0, t: 0 },
  ]);
  for (const z of [fa, ra]) for (const s of [-1, 1]) { F.arch(s * (hw + 0.004), r, z, r + 0.08); F.wheel(s * (hw - 0.07), r, z, r, 0.27, s); }
  for (const s of [-1, 1]) P.box(s * (hw + 0.06), 1.08, 1.0, 0.12, 0.09, 0.2);
  lamps(L, hw, 0.78, 2.47, 1, LAMP_W, 'pair', 0.07);
  lamps(L, hw, 1.0, -2.5, -1, LAMP_R, 'pair', 0.08);
  return finish('Model X', P, F, L, { L: 5.06, W: 2.0, H: 1.68, mass: 2.4, paints: ['#e8e8e6', '#121316', '#4a4d52', '#1f3a6e'], weights: [40, 30, 20, 10] });
}

function cybercab() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  const hw = 0.95, r = 0.36, fa = 1.3, ra = -1.5;
  loft(P, F, [
    { z: -2.20, hw: 0.80, yb: 0.32, belt: 0.80, roof: 0.86, rw: 0.65, s: 0, t: 0 },
    { z: -1.80, hw: 0.92, yb: 0.20, belt: 0.88, roof: 1.00, rw: 0.75, s: 1, t: 1 },
    { z: -0.60, hw: 0.95, yb: 0.15, belt: 0.90, roof: 1.32, rw: 0.62, s: 1, t: 1 },
    { z: 0.30, hw: 0.95, yb: 0.15, belt: 0.90, roof: 1.38, rw: 0.62, s: 1, t: 1 },
    { z: 0.90, hw: 0.95, yb: 0.15, belt: 0.88, roof: 1.25, rw: 0.62, s: 1, t: 1 },
    { z: 1.55, hw: 0.93, yb: 0.17, belt: 0.86, roof: 0.92, rw: 0.78, s: 0, t: 0 },
    { z: 2.00, hw: 0.86, yb: 0.22, belt: 0.74, roof: 0.78, rw: 0.70, s: 0, t: 0 },
    { z: 2.20, hw: 0.70, yb: 0.32, belt: 0.55, roof: 0.60, rw: 0.55, s: 0, t: 0 },
  ], { crown: 0.02 });
  // the Cybercab's covered wheels: flat discs flush with the body
  for (const z of [fa, ra]) for (const s of [-1, 1]) { F.arch(s * (hw + 0.004), r, z, r + 0.06); F.wheel(s * (hw - 0.09), r, z, r, 0.24, s); }
  lamps(L, hw, 0.64, 2.16, 1, LAMP_W, 'bar', 0.035);
  lamps(L, hw, 0.84, -2.18, -1, LAMP_R, 'bar', 0.04);
  return finish('Cybercab', P, F, L, { L: 4.4, W: 1.9, H: 1.38, mass: 1.6, paints: ['#c9a45c', '#b8bcc2'], weights: [70, 30] });
}

function cybertruck() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  const hw = 1.0, r = 0.44, fa = 1.84, ra = 1.84 - 3.81;
  loft(P, F, [
    { z: -2.84, hw, yb: 0.45, belt: 1.30, roof: 1.36, rw: 0.98, s: 0, t: 0 },
    { z: -0.90, hw, yb: 0.36, belt: 1.22, roof: 1.62, rw: 0.92, s: 0, t: 0 },
    { z: -0.86, hw, yb: 0.36, belt: 1.22, roof: 1.63, rw: 0.92, s: 1, t: 1 },
    { z: 0.25, hw, yb: 0.36, belt: 1.18, roof: 1.79, rw: 0.90, s: 1, t: 1 },
    { z: 1.90, hw, yb: 0.40, belt: 1.08, roof: 1.12, rw: 0.96, s: 0, t: 0 },
    { z: 2.84, hw, yb: 0.50, belt: 1.00, roof: 1.04, rw: 0.96, s: 0, t: 0 },
  ], { flat: true });
  for (const z of [fa, ra]) for (const s of [-1, 1]) { F.arch(s * (hw + 0.004), r + 0.02, z, r + 0.14); F.wheel(s * (hw - 0.06), r, z, r, 0.3, s); }
  for (const s of [-1, 1]) P.box(s * (hw + 0.06), 1.28, 0.95, 0.12, 0.07, 0.16);
  lamps(L, hw, 1.06, 2.83, 1, LAMP_W, 'bar', 0.035);
  lamps(L, hw, 1.33, -2.83, -1, LAMP_R, 'bar', 0.045);
  return finish('Cybertruck', P, F, L, { L: 5.68, W: 2.03, H: 1.79, mass: 3.0, paints: ['#b6b9bd', '#1c1d1f'], weights: [85, 15] });
}

function robovan() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  const hw = 1.2, r = 0.34;
  loft(P, F, [
    { z: -3.90, hw: 0.90, yb: 0.35, belt: 1.00, roof: 1.60, rw: 0.70, s: 0, t: 0 },
    { z: -3.60, hw: 1.15, yb: 0.15, belt: 0.95, roof: 2.15, rw: 0.95, s: 1, t: 0 },
    { z: -3.00, hw: 1.20, yb: 0.12, belt: 0.92, roof: 2.30, rw: 1.00, s: 1, t: 0 },
    { z: 3.00, hw: 1.20, yb: 0.12, belt: 0.92, roof: 2.30, rw: 1.00, s: 1, t: 0 },
    { z: 3.60, hw: 1.15, yb: 0.15, belt: 0.95, roof: 2.15, rw: 0.95, s: 0, t: 0 },
    { z: 3.90, hw: 0.90, yb: 0.35, belt: 1.00, roof: 1.60, rw: 0.70, s: 0, t: 0 },
  ], { crown: 0.03 });
  // the front and rear glass, set into the rounded ends
  F.box(0, 1.55, 3.86, 1.5, 0.75, 0.04, GLASS);
  F.box(0, 1.55, -3.86, 1.5, 0.75, 0.04, GLASS);
  for (const z of [2.6, -2.6]) for (const s of [-1, 1]) F.wheel(s * (hw - 0.14), r, z, r, 0.22, s);
  lamps(L, hw * 0.75, 0.9, 3.9, 1, LAMP_W, 'bar', 0.04);
  lamps(L, hw * 0.75, 0.9, -3.9, -1, LAMP_R, 'bar', 0.05);
  return finish('Robovan', P, F, L, { L: 7.8, W: 2.4, H: 2.33, mass: 4.0, paints: ['#cfc7b4', '#b8bcc2'], weights: [70, 30] });
}

function semi() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  const hw = 1.27, r = 0.52;
  loft(P, F, [
    { z: 0.60, hw: 1.25, yb: 0.95, belt: 2.30, roof: 3.85, rw: 1.15, s: 0, t: 0 },
    { z: 1.60, hw: 1.27, yb: 0.85, belt: 2.35, roof: 3.90, rw: 1.15, s: 1, t: 0 },
    { z: 2.30, hw: 1.27, yb: 0.80, belt: 2.20, roof: 3.80, rw: 1.10, s: 1, t: 1 },
    { z: 2.90, hw: 1.25, yb: 0.75, belt: 1.90, roof: 3.20, rw: 1.05, s: 0, t: 0 },
    { z: 3.30, hw: 1.15, yb: 0.75, belt: 1.50, roof: 1.70, rw: 1.00, s: 0, t: 0 },
  ], { crown: 0.03 });
  // chassis, battery skirts and the fifth wheel
  F.box(0, 0.95, -1.2, 1.9, 0.5, 4.2, DARK);
  P.box(0, 0.72, -0.2, 2.4, 0.55, 1.6);
  F.box(0, 1.24, -1.9, 1.1, 0.08, 1.1, C('#2b2b2c'));
  for (const z of [2.35, -1.25, -2.65]) for (const s of [-1, 1]) F.wheel(s * (hw - 0.16), r, z, r, 0.32, s);
  lamps(L, hw, 1.0, 3.31, 1, LAMP_W, 'bar', 0.06);
  L.box(0, 3.93, 1.5, 1.6, 0.04, 0.05, C('#ffb347'));
  lamps(L, 0.9, 1.0, -3.3, -1, LAMP_R, 'pair', 0.1);
  return finish('Semi', P, F, L, { L: 6.6, W: 2.55, H: 3.9, mass: 15, hitch: -1.9, paints: ['#eeeeec', '#151618'], weights: [80, 20] });
}

function trailer() {
  const P = new Builder(), F = new Builder(), L = new Builder();
  // 53 ft dry van; z = 0 at the kingpin, the box runs back from 0.9 m ahead of it
  P.box(0, 2.65, -7.15, 2.59, 2.9, 16.15);
  F.box(0, 1.1, -12.0, 1.9, 0.3, 6.0, DARK);
  F.box(0, 1.1, -3.0, 0.4, 0.3, 6.0, DARK);
  for (const z of [-12.3, -13.55]) for (const s of [-1, 1]) F.wheel(s * 0.98, 0.5, z, 0.5, 0.3, s);
  F.box(0, 0.65, -15.15, 2.4, 0.15, 0.1, DARK);
  lamps(L, 1.29, 1.35, -15.23, -1, LAMP_R, 'pair', 0.14);
  return finish('Trailer', P, F, L, { L: 16.15, W: 2.6, H: 4.1, mass: 15, paints: ['#e9e9e7', '#d9dadc'], weights: [70, 30] });
}

// --- humanoids -----------------------------------------------------------------------------

// pivot heights: legs hang from the hip, arms from the shoulder
export const HUMAN = { hip: 0.9, shoulder: 1.44, hipX: 0.1, shoulderX: 0.23 };

function person() {
  const torso = new Builder(), head = new Builder(), leg = new Builder(), arm = new Builder();
  torso.box(0, 1.19, 0, 0.4, 0.58, 0.23, WHITE);
  torso.box(0, 0.93, 0, 0.36, 0.1, 0.22, WHITE);
  const skull = new THREE.IcosahedronGeometry(0.115, 1);
  head.add(skull, WHITE, new THREE.Matrix4().makeTranslation(0, 1.6, 0));
  head.add(new THREE.SphereGeometry(0.122, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.45), C('#2a2018'), new THREE.Matrix4().makeTranslation(0, 1.615, -0.01));
  head.box(0, 1.47, 0, 0.08, 0.08, 0.08, WHITE);
  leg.box(0, -0.42, 0, 0.15, 0.84, 0.16, WHITE);
  leg.box(0, -0.86, 0.04, 0.12, 0.07, 0.26, C('#202020'));
  arm.box(0, -0.29, 0, 0.1, 0.6, 0.11, WHITE);
  return { torso: torso.geometry(), head: head.geometry(), leg: leg.geometry(), arm: arm.geometry() };
}

function optimus() {
  const W = C('#e9eaec'), B = C('#141518'), S = C('#9a9da2');
  const torso = new Builder(), head = new Builder(), leg = new Builder(), arm = new Builder();
  torso.box(0, 1.2, 0, 0.42, 0.5, 0.25, W);
  torso.box(0, 0.98, 0, 0.3, 0.16, 0.2, B);
  torso.box(0, 1.2, -0.13, 0.3, 0.36, 0.02, B);
  torso.box(0, 0.88, 0, 0.36, 0.1, 0.22, S);
  head.box(0, 1.6, 0, 0.19, 0.23, 0.21, W);
  head.box(0, 1.6, 0.106, 0.16, 0.13, 0.01, B);
  head.box(0, 1.46, 0, 0.09, 0.07, 0.09, B);
  leg.box(0, -0.2, 0, 0.15, 0.38, 0.16, W);
  leg.box(0, -0.42, 0, 0.12, 0.08, 0.13, B);
  leg.box(0, -0.64, 0, 0.13, 0.38, 0.14, W);
  leg.box(0, -0.86, 0.04, 0.12, 0.06, 0.24, B);
  arm.box(0, -0.15, 0, 0.11, 0.3, 0.11, W);
  arm.box(0, -0.32, 0, 0.09, 0.06, 0.09, B);
  arm.box(0, -0.47, 0, 0.1, 0.28, 0.1, W);
  arm.box(0, -0.65, 0, 0.08, 0.1, 0.06, B);
  return { torso: torso.geometry(), head: head.geometry(), leg: leg.geometry(), arm: arm.geometry() };
}

let cache = null;
export function fleetModels() {
  if (!cache) {
    cache = {
      vehicles: { model3: model3(), modelY: modelY(), modelS: modelS(), modelX: modelX(), cybercab: cybercab(), cybertruck: cybertruck(), robovan: robovan(), semi: semi(), trailer: trailer() },
      person: person(),
      optimus: optimus(),
    };
  }
  return cache;
}

// Materials shared by every instanced model: paint takes the instance colour, the fixed parts
// use their vertex colours, lamps are unlit so they glow (brighter at night, see setLampLevel).
export function fleetMaterials() {
  return {
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.32, envMapIntensity: 1.2 }),
    fixed: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.4 }),
    lights: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    cloth: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    robot: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.25, roughness: 0.45 }),
  };
}
