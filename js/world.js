import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { glowSpot } from './textures.js?v=3.9';

// Shared ground truth for every map: footprint colliders on a grid, surface queries for the
// six-axis car (floors, roofs, walls, map-specific surfaces), boost pads and Supercharger stalls.

const CELL = 50;
const key = (ix, iz) => (ix + 5000) * 10000 + (iz + 5000);

export function signedArea(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function pip(c, x, z) {
  if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) return false;
  let inside = false;
  const xs = c.xs, zs = c.zs;
  for (let i = 0, j = c.n - 1; i < c.n; j = i++) {
    if ((zs[i] > z) !== (zs[j] > z) && x < ((xs[j] - xs[i]) * (z - zs[i])) / (zs[j] - zs[i]) + xs[i]) inside = !inside;
  }
  return inside;
}

// Closest point on a footprint outline plus the outward normal of that edge.
export function closest(c, x, z, out) {
  let best = Infinity;
  const xs = c.xs, zs = c.zs;
  for (let i = 0; i < c.n; i++) {
    const j = (i + 1) % c.n;
    const ax = xs[i], az = zs[i], dx = xs[j] - ax, dz = zs[j] - az;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qz = az + dz * t;
    const d2 = (x - qx) ** 2 + (z - qz) ** 2;
    if (d2 < best) {
      best = d2;
      const l = Math.sqrt(l2);
      out.qx = qx;
      out.qz = qz;
      out.nx = (c.ccw ? dz : -dz) / l;
      out.nz = (c.ccw ? -dx : dx) / l;
    }
  }
  out.d2 = best;
  return out;
}

export const boxRing = (x, z, w, d, ang = 0) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([a, b]) => [x + a * c - b * s, z + a * s + b * c]);
};

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = [];
    this.grid = new Map();
    this.stamp = 0;
    this.tmp = { qx: 0, qz: 0, nx: 0, nz: 0, d2: 0 };
    this.hit = { dx: 0, dz: 0, nx: 0, nz: 0, roof: 0, top: 0, c: null, qx: 0, qz: 0 };
    this.pads = [];
    this.chargers = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.time = 0;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }

  addCollider(ring, m, h, tag) {
    const n = ring.length;
    const xs = new Float32Array(n), zs = new Float32Array(n);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      xs[i] = ring[i][0];
      zs[i] = ring[i][1];
      minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
      minZ = Math.min(minZ, zs[i]); maxZ = Math.max(maxZ, zs[i]);
    }
    const c = { xs, zs, n, minX, maxX, minZ, maxZ, m, h, ccw: signedArea(ring) > 0, stamp: 0, tag };
    this.colliders.push(c);
    for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
      for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
        const k = key(ix, iz);
        let cell = this.grid.get(k);
        if (!cell) this.grid.set(k, (cell = []));
        cell.push(c);
      }
    }
    return c;
  }

  forEachNear(x, z, r, fn) {
    this.stamp++;
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const cell = this.grid.get(key(ix, iz));
        if (!cell) continue;
        for (const c of cell) {
          if (c.stamp === this.stamp) continue;
          c.stamp = this.stamp;
          if (fn(c) === false) return;
        }
      }
    }
  }

  // Highest roof under (x, z) that can be stood on from height y (plus the base floor).
  groundAt(x, z, y) {
    let g = this.floorAt ? this.floorAt(x, z) : 0;
    const cell = this.grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!cell) return g;
    for (const c of cell) if (c.h > g && c.h <= y + 0.8 && pip(c, x, z)) g = c.h;
    return g;
  }

  insideAny(x, y, z) {
    const cell = this.grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!cell) return false;
    for (const c of cell) if (y > c.m && y < c.h && pip(c, x, z)) return true;
    return false;
  }

  // Push a circle (one car body section) out of walls between heights y and y+1.1.
  pushOut(cx, cz, r, y, prevY, skip) {
    const hit = this.hit, tmp = this.tmp;
    let best = 0, roof = 0;
    hit.dx = hit.dz = 0;
    hit.c = null;
    hit.top = 0;
    this.forEachNear(cx, cz, r, (c) => {
      if (c === skip) return;
      if (y + 1.1 < c.m || y > c.h - 0.02) return;
      const inside = pip(c, cx, cz);
      closest(c, cx, cz, tmp);
      let push, nx, nz;
      if (inside) {
        if (prevY >= c.h - 0.6) { roof = Math.max(roof, c.h); return; }
        const d = Math.sqrt(tmp.d2);
        push = d + r;
        nx = tmp.nx; nz = tmp.nz;
      } else if (tmp.d2 < r * r) {
        const d = Math.sqrt(tmp.d2) || 1e-4;
        push = r - d;
        nx = (cx - tmp.qx) / d; nz = (cz - tmp.qz) / d;
        // at a corner the push direction is diagonal; use the edge normal for riding up
        if (Math.abs(nx * tmp.nx + nz * tmp.nz) < 0.85) { nx = tmp.nx; nz = tmp.nz; }
      } else return;
      if (push > best) {
        best = push;
        hit.dx = nx * push; hit.dz = nz * push; hit.nx = nx; hit.nz = nz;
        hit.c = c; hit.top = c.h; hit.qx = tmp.qx; hit.qz = tmp.qz;
      }
    });
    hit.roof = roof;
    return best > 0 || roof > 0 ? hit : null;
  }

  // The surface the car could be standing on: floor/roof under the wheels, a wall beside it,
  // or a map-specific surface (the ramp). `up` is the car's up; the surface must roughly face it.
  support(pos, up, out, curKind) {
    const curC = out.c;
    let best = -Infinity, found = false;
    const gy = this.groundAt(pos.x, pos.z, pos.y);
    const dg = pos.y - gy;
    if (up.y > 0.35 && dg > -1.5 && dg < 1.0) {
      best = up.y * 2 - Math.max(0, dg) * 1.5 + (curKind === 'ground' ? 0.3 : 0);
      out.n.set(0, 1, 0);
      out.p.set(pos.x, gy, pos.z);
      out.dist = dg;
      out.kind = 'ground';
      out.c = null;
      found = true;
    }
    const tmp = this.tmp;
    this.forEachNear(pos.x, pos.z, 1.6, (c) => {
      if (c.noWall) return;
      if (pos.y < c.m - 0.3 || pos.y > c.h - 0.25) return;
      closest(c, pos.x, pos.z, tmp);
      const inside = pip(c, pos.x, pos.z);
      const d = Math.sqrt(tmp.d2) * (inside ? -1 : 1);
      if (d < -1.2 || d > 1.0) return;
      const a = up.x * tmp.nx + up.z * tmp.nz;
      if (a < 0.35) return;
      const score = a * 2 - Math.max(0, d) * 1.5 + (curKind === 'wall' && c === curC ? 0.3 : 0);
      if (score <= best) return;
      best = score;
      out.n.set(tmp.nx, 0, tmp.nz);
      out.p.set(tmp.qx + tmp.nx * 0.03, pos.y, tmp.qz + tmp.nz * 0.03);
      out.dist = d;
      out.kind = 'wall';
      out.c = c;
      found = true;
    });
    if (this.extraSupport) {
      const r = this.extraSupport(pos, up, out, best, curKind);
      if (r !== undefined && r > best) { best = r; found = true; }
    }
    return found;
  }

  // --- pickups --------------------------------------------------------------------------

  buildPads(list) {
    // "PSI tokens": a spinning hex coin for the small ones, a pressure sphere in a ring for the big
    const gold = new THREE.MeshStandardMaterial({ color: 0xc9a466, metalness: 1, roughness: 0.25, emissive: 0x3a2a10, emissiveIntensity: 0.6 });
    const core = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.1, 1.8, 2.6), toneMapped: false });
    const pool = new THREE.MeshBasicMaterial({ map: glowSpot(), color: new THREE.Color(0.6, 1.1, 1.6), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const small = [], big = [];
    for (const p of list) (p.big ? big : small).push(p);
    const mk = (geoGold, geoCore, items, poolSize) => {
      const n = items.length;
      if (!n) return null;
      const a = new THREE.InstancedMesh(geoGold, gold, n);
      const b = new THREE.InstancedMesh(geoCore, core, n);
      const c = new THREE.InstancedMesh(new THREE.PlaneGeometry(poolSize, poolSize).rotateX(-Math.PI / 2), pool, n);
      a.castShadow = true;
      c.renderOrder = 4;
      this.group.add(a, b, c);
      return { a, b, c, items };
    };
    const hexGold = mergeGeometries([
      new THREE.TorusGeometry(0.42, 0.07, 8, 6),
      new THREE.CylinderGeometry(0.12, 0.12, 0.08, 6).rotateX(Math.PI / 2),
    ]);
    const hexCore = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 6).rotateX(Math.PI / 2);
    const bigGold = mergeGeometries([
      new THREE.TorusGeometry(1.05, 0.08, 10, 36),
      new THREE.TorusGeometry(1.05, 0.08, 10, 36).rotateX(Math.PI / 2),
    ]);
    const bigCore = new THREE.SphereGeometry(0.55, 24, 16);
    this.padSets = [mk(hexGold, hexCore, small, 4), mk(bigGold, bigCore, big, 7)].filter(Boolean);
    this.pads = list;
    for (const p of list) { p.t = 0; p.on = true; }
    this.padGrid = new Map();
    list.forEach((p, i) => {
      const k = key(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
      if (!this.padGrid.has(k)) this.padGrid.set(k, []);
      this.padGrid.get(k).push(p);
    });
    this.placePads(0);
  }

  placePads(t) {
    if (!this.padSets) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
    for (const set of this.padSets) {
      set.items.forEach((p, i) => {
        const on = p.on;
        const k = on ? 1 : 0.0001;
        const bob = on ? Math.sin(t * 2 + p.x * 0.3) * 0.08 : 0;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * (p.big ? 0.9 : 2.2) + p.x);
        set.a.setMatrixAt(i, m.compose(v.set(p.x, p.y + 0.75 + bob, p.z), q, s.set(k, k, k)));
        set.b.setMatrixAt(i, m.compose(v.set(p.x, p.y + 0.75 + bob, p.z), q, s.set(k * (0.8 + 0.2 * Math.sin(t * 6 + p.z)), k, k)));
        set.c.setMatrixAt(i, m.compose(v.set(p.x, p.y + 0.05, p.z), q.identity(), s.set(k, k, k)));
      });
      set.a.instanceMatrix.needsUpdate = set.b.instanceMatrix.needsUpdate = set.c.instanceMatrix.needsUpdate = true;
    }
  }

  collectPad(pos) {
    if (!this.padGrid) return null;
    const cell = this.padGrid.get(key(Math.floor(pos.x / CELL), Math.floor(pos.z / CELL)));
    if (!cell) return null;
    for (const p of cell) {
      if (!p.on) continue;
      const r = p.big ? 5.0 : 3.2; // RL pickup radii (208 / 144 uu) scaled to the car, trimmed for city streets
      if ((p.x - pos.x) ** 2 + (p.z - pos.z) ** 2 < r * r && Math.abs(p.y - pos.y) < 2.5) {
        p.on = false;
        p.t = p.big ? 10 : 4;
        return p;
      }
    }
    return null;
  }

  buildChargers(list) {
    // Tesla Supercharger V4 stall: white post, dark cable face, red band, a floating green cross when it has charge
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.5, metalness: 0.3 });
    const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.25, 0.2), toneMapped: false });
    const green = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.6, 0.9), toneMapped: false });
    const post = mergeGeometries([
      new THREE.BoxGeometry(0.42, 2.2, 0.34).translate(0, 1.1, 0),
      new THREE.BoxGeometry(0.5, 0.15, 0.42).translate(0, 0.075, 0),
    ]);
    const face = new THREE.BoxGeometry(0.3, 1.3, 0.02).translate(0, 1.3, 0.175);
    const band = new THREE.BoxGeometry(0.44, 0.12, 0.36).translate(0, 2.05, 0);
    const cross = mergeGeometries([
      new THREE.BoxGeometry(0.5, 0.14, 0.14),
      new THREE.BoxGeometry(0.14, 0.5, 0.14),
    ]);
    this.chargers = list.map((c) => {
      const g = new THREE.Group();
      g.position.set(c.x, c.y || 0, c.z);
      g.rotation.y = c.rot || 0;
      const stalls = [];
      for (let i = 0; i < (c.n || 2); i++) {
        const s = new THREE.Group();
        s.position.x = (i - ((c.n || 2) - 1) / 2) * 2.8;
        const p = new THREE.Mesh(post, white);
        p.castShadow = true;
        const f = new THREE.Mesh(face, dark);
        const b = new THREE.Mesh(band, red);
        s.add(p, f, b);
        g.add(s);
        stalls.push(s);
      }
      const icon = new THREE.Mesh(cross, green);
      icon.position.set(0, 3.1, 0);
      g.add(icon);
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: glowSpot(), color: new THREE.Color(0.8, 0.12, 0.1), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      halo.position.y = 0.06;
      halo.renderOrder = 4;
      g.add(halo);
      this.group.add(g);
      // the stall row is solid
      const n = c.n || 2;
      this.addCollider(boxRing(c.x, c.z, n * 2.8, 0.5, c.rot || 0), 0, 2.2, 'charger').noWall = true;
      return { ...c, g, icon, halo, t: 0, on: true };
    });
  }

  collectCharger(pos, need) {
    if (!need) return null;
    for (const c of this.chargers) {
      if (!c.on) continue;
      if ((c.x - pos.x) ** 2 + (c.z - pos.z) ** 2 < 4.2 * 4.2 && Math.abs((c.y || 0) - pos.y) < 2) {
        c.on = false;
        c.t = 25;
        return c;
      }
    }
    return null;
  }

  update(dt, t) {
    this.time = t;
    let dirty = false;
    for (const p of this.pads) {
      if (!p.on && (p.t -= dt) <= 0) { p.on = true; dirty = true; }
    }
    this.placePads(t);
    for (const c of this.chargers) {
      if (!c.on && (c.t -= dt) <= 0) c.on = true;
      c.icon.visible = c.on;
      c.icon.rotation.y = t * 1.5;
      c.icon.position.y = 3.1 + Math.sin(t * 2.5) * 0.12;
      c.halo.material.opacity = c.on ? 0.3 + Math.sin(t * 3) * 0.08 : 0.08;
    }
    return dirty;
  }

  // Default spawn; maps override.
  spawnPoint() {
    return { x: 0, z: 0, heading: 0 };
  }

  setNight() {}
}
