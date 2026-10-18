import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  facadeGlass, facadeMasonry, facadeBrick, facadeDeco, roofTexture, roadTexture, groundTexture, grassTexture,
  sidewalkTexture, waterNormal, glowSpot, FACADE_U, FACADE_V,
} from './textures.js?v=3.9';
import { hash01, rng } from './util.js?v=3.9';
import { World, pip, signedArea, boxRing } from './world.js?v=3.9';

// Downtown Chicago, 6 x 6 km: the Loop, River North, Streeterville, Navy Pier, the West and South
// Loops and the Museum Campus. Buildings and tower setbacks from Overture Maps (OpenStreetMap
// footprints with USGS lidar heights), streets, river, lakeshore, parks and the elevated CTA lines
// from OpenStreetMap; tools/build_chicago.py makes chicago.json. Hand-built on top: the Loop "L"
// with trains, sidewalks, the Bean and Buckingham Fountain.

const CHUNK = 480; // render chunk, metres (the map is 6 x 6 km now)

const GLASS_TONES = ['#93a6b8', '#6e8296', '#4b5662', '#aab8c4', '#2c3239', '#7d8e8c', '#5d6f84'];
const STONE_TONES = ['#cfc1a1', '#b9a27f', '#9b6a52', '#dad3c5', '#a9a59d', '#8a5a44', '#c8c0b0', '#7c7a78'];
const BRICK_TONES = ['#9a5a40', '#8a4a36', '#a8705a', '#7a4432', '#b07a60', '#6e3d30'];
const DECO_TONES = ['#d6cbb2', '#c9bea6', '#e0d6c0', '#bfae92', '#cfc3aa'];
const NAMED = new Set(['white', 'black', 'gray', 'grey', 'silver', 'brown', 'red', 'maroon', 'beige', 'tan',
  'yellow', 'orange', 'blue', 'navy', 'green', 'olive', 'teal', 'ivory', 'khaki', 'darkgray', 'darkgrey',
  'lightgray', 'lightgrey', 'darkred', 'darkblue', 'wheat', 'sienna', 'chocolate', 'peru', 'gold',
  'slategray', 'slategrey', 'dimgray', 'dimgrey', 'gainsboro', 'linen', 'cream']);

function namedColour(tag) {
  if (!tag) return null;
  const t = String(tag).toLowerCase().trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(t)) return new THREE.Color(t);
  if (NAMED.has(t)) return new THREE.Color(t === 'cream' ? '#efe6cf' : t);
  return null;
}

function buildingColour(tag, kind, r) {
  const c = new THREE.Color();
  if (tag) {
    const t = String(tag).toLowerCase().trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(t)) return c.set(t);
    if (NAMED.has(t)) return c.set(t === 'cream' ? '#efe6cf' : t);
  }
  const list = { glass: GLASS_TONES, stone: STONE_TONES, brick: BRICK_TONES, deco: DECO_TONES }[kind];
  return c.set(list[Math.floor(r * list.length)]);
}

// The Loop "L" structure: Lake St, Wabash Ave, Van Buren St, Wells St, in map metres.
const L_LOOP = { west: -318, east: 312, north: -312, south: 690, deck: 6.3 };

export class City extends World {
  constructor(scene, data) {
    super(scene);
    this.name = 'chicago';
    this.data = data;
    this.makeMaterials();
    this.buildBuildings(data.buildings);
    this.buildGround();
    this.buildFlat(data.water, this.mat.water, 0.02, 2, 40);
    this.buildFlat(data.parks, this.mat.grass, 0.012, 1, 12);
    this.buildRoads(data.roads, 5.5, 0.03, this.mat.sidewalk, 2, 2.6);
    this.buildRoads(data.roads, 0, 0.04, this.mat.road, 3, 14);
    this.buildLandmarks();
    this.buildElevated();
    this.buildStreetLights(data.roads);
    this.buildTrees(data.parks);
    this.buildLake();
    // everything built so far is scenery the Photoreal layer can stand in for; the PSI tokens and
    // Superchargers below are gameplay and stay
    this.scenery = this.group.children.slice();
    this.buildPickups();
    this.buildingCount = data.buildings.length;
  }

  // Photoreal Chicago: hide the procedural buildings, streets, parks, water, the L and the
  // landmarks. Only meshes change; every collider stays, so the car still hits the open-data
  // footprints.
  setPhotoreal(on) {
    this.photoreal = on;
    for (const o of this.scenery) o.visible = !on;
  }

  spawnPoint() {
    const s = this.nearestRoad(468, 120, ['primary', 'secondary'], true);
    return { x: s.x, z: s.z, heading: s.heading };
  }

  makeMaterials() {
    const g = facadeGlass(), s = facadeMasonry(), b = facadeBrick(), d = facadeDeco();
    const water = waterNormal();
    water.repeat.set(1, 1);
    const ground = groundTexture();
    const facade = (t, metal, env) => new THREE.MeshStandardMaterial({
      map: t.map, emissiveMap: t.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.1,
      roughnessMap: t.roughnessMap, roughness: 1, metalness: metal, vertexColors: true, envMapIntensity: env,
    });
    this.mat = {
      glass: facade(g, 0.7, 1.3),
      stone: facade(s, 0.05, 1),
      brick: facade(b, 0.0, 0.8),
      deco: facade(d, 0.05, 1),
      roof: new THREE.MeshStandardMaterial({ map: roofTexture(), roughness: 0.92, vertexColors: true }),
      road: new THREE.MeshStandardMaterial({
        map: roadTexture(), roughness: 0.78, metalness: 0.0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
      }),
      sidewalk: new THREE.MeshStandardMaterial({
        map: sidewalkTexture(), roughness: 0.95, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      }),
      ground: new THREE.MeshStandardMaterial({ map: ground, roughness: 0.96, color: 0xa3a19c }),
      grass: new THREE.MeshStandardMaterial({
        map: grassTexture(), roughness: 1, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      }),
      water: new THREE.MeshStandardMaterial({
        color: 0x1d4b47, roughness: 0.07, metalness: 0.15, normalMap: water,
        normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.4, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      }),
      lake: new THREE.MeshStandardMaterial({
        color: 0x163a52, roughness: 0.08, metalness: 0.2, normalMap: water,
        normalScale: new THREE.Vector2(0.5, 0.5), envMapIntensity: 1.4,
        // the lake lies on the ground plane: a depth offset keeps it on top kilometres away
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      }),
      lampHead: new THREE.MeshBasicMaterial({ color: 0x333333, toneMapped: false }),
      pool: new THREE.MeshBasicMaterial({
        map: glowSpot(), color: 0xffb46a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false,
      }),
      steel: new THREE.MeshStandardMaterial({ color: 0x4a4c50, roughness: 0.6, metalness: 0.7 }),
      rust: new THREE.MeshStandardMaterial({ color: 0x5c4a3c, roughness: 0.85, metalness: 0.3 }),
      train: new THREE.MeshStandardMaterial({ color: 0xd8d9d6, roughness: 0.4, metalness: 0.6 }),
      trainWin: new THREE.MeshBasicMaterial({ color: 0x222222, toneMapped: false }),
    };
    this.waterTex = water;
  }

  buildBuildings(list) {
    const chunks = new Map();
    const kinds = ['glass', 'stone', 'brick', 'deco', 'roof'];
    const arr = () => ({ p: [], n: [], u: [], c: [] });
    const chunkAt = (x, z) => {
      const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
      let c = chunks.get(k);
      if (!c) {
        c = {};
        for (const kk of kinds) c[kk] = arr();
        chunks.set(k, c);
      }
      return c;
    };
    const vert = (t, x, y, z, nx, ny, nz, u, v, col) => {
      t.p.push(x, y, z);
      t.n.push(nx, ny, nz);
      t.u.push(u, v);
      t.c.push(col.r, col.g, col.b);
    };
    const roofCol = new THREE.Color();
    const mech = [];

    const clean = (r) => r.filter((p, i, a) => {
      const q = a[(i + 1) % a.length];
      return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > 0.05;
    });
    list.forEach((b, idx) => {
      const ring = clean(b.p);
      if (ring.length < 3) return;
      const holes = (b.q || []).map(clean).filter((r) => r.length >= 3);
      const area = signedArea(ring);
      if (Math.abs(area) < 2) return;
      const h = b.h;
      const m = Math.min(b.m || 0, h - 0.5);
      this.addCollider(ring, m, h);
      let cx = 0, cz = 0;
      for (const [x, z] of ring) { cx += x; cz += z; }
      cx /= ring.length; cz /= ring.length;
      const chunk = chunkAt(cx, cz);
      const r = hash01(idx + 1);
      // the mapped facade material when there is one, otherwise a guess from the height
      let kind = { g: 'glass', b: 'brick', s: h > 45 ? 'deco' : 'stone' }[b.f];
      if (kind) { /* mapped */ }
      else if (h > 120) kind = r < 0.8 ? 'glass' : 'deco';
      else if (h > 45) kind = r < 0.55 ? 'glass' : r < 0.85 ? 'deco' : 'stone';
      else kind = r < 0.45 ? 'brick' : r < 0.72 ? 'stone' : r < 0.9 ? 'deco' : 'glass';
      const col = buildingColour(b.c, kind, hash01(idx * 7 + 3));
      const t = chunk[kind];
      const uOff = Math.floor(hash01(idx * 13 + 5) * 8) * 3.2;
      const vOff = Math.floor(hash01(idx * 17 + 9) * 8) * 3.8;
      // walls: the outline faces out, a courtyard's walls face into the courtyard
      const walls = (wr, inward) => {
        const cw = (signedArea(wr) > 0) !== inward;
        let s = 0;
        for (let i = 0; i < wr.length; i++) {
          const [ax, az] = wr[i], [bx, bz] = wr[(i + 1) % wr.length];
          const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
          let nx = dz / len, nz = -dx / len;
          if (!cw) { nx = -nx; nz = -nz; }
          const u0 = (s + uOff) / FACADE_U, u1 = (s + len + uOff) / FACADE_U;
          s += len;
          const v0 = (m + vOff) / FACADE_V, v1 = (h + vOff) / FACADE_V;
          const A0 = [ax, m, az, u0, v0], B0 = [bx, m, bz, u1, v0], A1 = [ax, h, az, u0, v1], B1 = [bx, h, bz, u1, v1];
          const tris = cw ? [A0, A1, B0, B0, A1, B1] : [A0, B0, A1, B0, B1, A1];
          for (const q of tris) vert(t, q[0], q[1], q[2], nx, 0, nz, q[3], q[4], col);
        }
      };
      walls(ring, false);
      for (const hr of holes) walls(hr, true);
      const rc = namedColour(b.r);
      if (rc) roofCol.copy(rc).multiplyScalar(0.9);
      else roofCol.setScalar(0.62 + hash01(idx * 23 + 1) * 0.3);
      const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
      const holeC = holes.map((hr) => hr.map(([x, z]) => new THREE.Vector2(x, z)));
      const all = ring.concat(...holes);
      let roofTris;
      try { roofTris = THREE.ShapeUtils.triangulateShape(contour, holeC); } catch { roofTris = THREE.ShapeUtils.triangulateShape(contour, []); }
      for (const [i, j, k] of roofTris) {
        let a = all[i], bb = all[j], c = all[k];
        const cy = (bb[1] - a[1]) * (c[0] - a[0]) - (bb[0] - a[0]) * (c[1] - a[1]);
        if (cy < 0) [bb, c] = [c, bb];
        for (const q of [a, bb, c]) vert(chunk.roof, q[0], h, q[1], 0, 1, 0, q[0] / 16, q[1] / 16, roofCol);
        if (m > 0.5) for (const q of [a, c, bb]) vert(chunk.roof, q[0], m, q[1], 0, -1, 0, q[0] / 16, q[1] / 16, roofCol);
      }
      // rooftop mechanical penthouses on the bigger blocks
      if (h > 28 && Math.abs(area) > 400 && hash01(idx * 31 + 7) < 0.6) {
        const sz = Math.min(14, Math.sqrt(Math.abs(area)) * 0.3);
        if (pip(this.colliders[this.colliders.length - 1], cx, cz)) mech.push([cx, h, cz, sz, 2.5 + hash01(idx * 3) * 3]);
      }
    });

    for (const c of chunks.values()) {
      for (const k of kinds) {
        const t = c[k];
        if (!t.p.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(t.p, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(t.n, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(t.u, 2));
        g.setAttribute('color', new THREE.Float32BufferAttribute(t.c, 3));
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.mat[k]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
    if (mech.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
        new THREE.MeshStandardMaterial({ color: 0x7c7e82, roughness: 0.85 }), mech.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      mech.forEach(([x, y, z, sz, hh], i) => im.setMatrixAt(i, m.compose(p.set(x, y, z), q, s.set(sz, hh, sz * 0.7))));
      im.castShadow = true;
      this.group.add(im);
    }
  }

  buildGround() {
    const size = 16000;
    this.mat.ground.map.repeat.set(size / 16, size / 16);
    const g = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(g, this.mat.ground);
    mesh.position.set(-1500, 0, 0);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  buildLake() {
    // Lake Michigan from its mapped shoreline: the piers, harbours and Northerly Island stay land
    const rings = this.data.lake;
    if (!rings || !rings.length) {
      const g = new THREE.PlaneGeometry(9000, 12000).rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(g, this.mat.lake);
      mesh.position.set(1480 + 4500, 0.05, 0);
      this.group.add(mesh);
      this.lake = mesh;
      return;
    }
    const p = [], u = [];
    for (const item of rings) {
      const ring = item.p, holes = item.q || [];
      const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)),
        holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z))));
      const all = ring.concat(...holes);
      for (const [i, j, k] of tris) {
        let a = all[i], b = all[j], c = all[k];
        const cy = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
        if (cy < 0) [b, c] = [c, b];
        for (const q of [a, b, c]) { p.push(q[0], 0.06, q[1]); u.push(q[0] / 320, q[1] / 320); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this.mat.lake);
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.lake = mesh;
  }

  buildFlat(list, mat, y, order, uvScale) {
    const p = [], u = [];
    for (const item of list) {
      const ring = item.p;
      if (!ring || ring.length < 3) continue;
      const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { continue; }
      for (const [i, j, k] of tris) {
        let a = ring[i], b = ring[j], c = ring[k];
        const cy = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
        if (cy < 0) [b, c] = [c, b];
        for (const q of [a, b, c]) {
          p.push(q[0], y, q[1]);
          u.push(q[0] / uvScale, q[1] / uvScale);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = order;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  buildRoads(roads, widen, y0, mat, order, vScale) {
    const p = [], u = [];
    for (const r of roads) {
      const pts = r.p;
      if (pts.length < 2) continue;
      if (widen && (r.b || r.k === 'motorway' || r.k === 'trunk')) continue;
      const hw = r.w / 2 + widen, y = r.b ? y0 + 0.03 : y0;
      const L = [], R = [], V = [];
      let along = 0;
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
        let tx = next[0] - prev[0], tz = next[1] - prev[1];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        let scale = 1;
        if (i > 0 && i < pts.length - 1) {
          const sx = pts[i][0] - pts[i - 1][0], sz = pts[i][1] - pts[i - 1][1];
          const cos = (sx * tx + sz * tz) / (Math.hypot(sx, sz) || 1);
          scale = Math.min(2, 1 / Math.max(0.5, cos));
        }
        if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const nx = -tz * hw * scale, nz = tx * hw * scale;
        L.push([pts[i][0] + nx, pts[i][1] + nz]);
        R.push([pts[i][0] - nx, pts[i][1] - nz]);
        V.push(along / vScale);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const quads = [[L[i], 0, V[i]], [R[i], 1, V[i]], [L[i + 1], 0, V[i + 1]], [R[i + 1], 1, V[i + 1]]];
        for (const [a, b, c] of [[quads[0], quads[1], quads[2]], [quads[1], quads[3], quads[2]]]) {
          const cy = (b[0][1] - a[0][1]) * (c[0][0] - a[0][0]) - (b[0][0] - a[0][0]) * (c[0][1] - a[0][1]);
          const tri = cy < 0 ? [a, c, b] : [a, b, c];
          for (const q of tri) {
            p.push(q[0][0], y, q[0][1]);
            u.push(q[1] * (widen ? 3 : 1), q[2]);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = order;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  buildLandmarks() {
    // Cloud Gate ("the Bean"), Millennium Park
    const chrome = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.04, envMapIntensity: 1.3 });
    const bean = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 36), chrome);
    bean.scale.set(10, 4.9, 6.4);
    bean.position.set(555, 4.4, 33);
    bean.castShadow = true;
    this.group.add(bean);
    this.addCollider(Array.from({ length: 20 }, (_, i) => {
      const a = (i / 20) * Math.PI * 2;
      return [555 + Math.cos(a) * 9.6, 33 + Math.sin(a) * 6.1];
    }), 0, 9.2);
    this.bean = bean;

    // Buckingham Fountain, Grant Park
    const granite = new THREE.MeshStandardMaterial({ color: 0xc8a597, roughness: 0.7 });
    const fx = 920, fz = 801;
    const tiers = [[15.7, 0, 1.2], [3.2, 1.2, 2.2], [9.2, 3.0, 0.8], [2.1, 3.8, 2.2], [5.6, 5.6, 0.7], [1.2, 6.3, 2.0], [2.6, 8.0, 0.5]];
    for (const [r, y, h] of tiers) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.04, h, 48), granite);
      t.position.set(fx, y + h / 2, fz);
      t.castShadow = t.receiveShadow = true;
      this.group.add(t);
    }
    const ring = (r, n) => Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [fx + Math.cos(a) * r, fz + Math.sin(a) * r];
    });
    this.addCollider(ring(15.7, 24), 0, 1.2);
    this.addCollider(ring(9.2, 20), 0, 3.8);
    this.addCollider(ring(5.6, 16), 0, 6.3);
    const jet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 1.1, 26, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 1.3, 1.4), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    jet.position.set(fx, 8.5 + 13, fz);
    this.group.add(jet);
    this.fountainJet = jet;
  }

  // The Loop "L": steel columns, girders, a deck with rails, and trains running the loop.
  buildElevated() {
    const { west, east, north, south, deck } = L_LOOP;
    const corners = [[west, north], [east, north], [east, south], [west, south]];
    const cols = [], girders = [], decks = [], rails = [];
    const colGeo = new THREE.BoxGeometry(0.5, deck, 0.5).translate(0, deck / 2, 0);
    for (let s = 0; s < 4; s++) {
      const [ax, az] = corners[s], [bx, bz] = corners[(s + 1) % 4];
      const len = Math.hypot(bx - ax, bz - az);
      const tx = (bx - ax) / len, tz = (bz - az) / len;
      const ang = Math.atan2(tx, tz);
      // deck slab and two rails
      decks.push(new THREE.BoxGeometry(8.4, 0.5, len + 8.4).rotateY(ang).translate((ax + bx) / 2, deck - 0.25, (az + bz) / 2));
      for (const off of [-2.1, -1.1, 1.1, 2.1]) {
        rails.push(new THREE.BoxGeometry(0.12, 0.16, len + 8.4).translate(off, 0, 0).rotateY(ang).translate((ax + bx) / 2, deck + 0.08, (az + bz) / 2));
      }
      // columns every 12 m on both sides, with a cross girder
      for (let d = 0; d <= len; d += 12) {
        const x = ax + tx * d, z = az + tz * d;
        for (const side of [-1, 1]) {
          const cx = x - tz * 3.9 * side, cz = z + tx * 3.9 * side;
          if (this.insideAny(cx, 2, cz)) continue;
          cols.push(colGeo.clone().translate(cx, 0, cz));
          this.addCollider(boxRing(cx, cz, 0.6, 0.6), 0, deck, 'lcol').noWall = true;
        }
        girders.push(new THREE.BoxGeometry(8.6, 0.6, 0.5).rotateY(ang).translate(x, deck - 0.75, z));
      }
      // the deck is a roof the car can land on
      this.addCollider(boxRing((ax + bx) / 2, (az + bz) / 2, 8.4, len + 8.4, ang), deck - 0.5, deck + 0.02, 'ldeck').noWall = true;
    }
    const add = (geos, mat) => {
      const m = new THREE.Mesh(mergeGeometries(geos), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    };
    this.buildElevatedLines(cols, girders, decks, rails);
    add(cols, this.mat.rust);
    add(girders, this.mat.rust);
    add(decks, this.mat.steel);
    add(rails, this.mat.steel);
    // trains: two 4-car consists, one each way
    this.trains = [];
    const carGeo = new THREE.BoxGeometry(2.7, 3.2, 14.6).translate(0, 1.6, 0);
    const winGeo = mergeGeometries([
      new THREE.BoxGeometry(2.76, 0.9, 12.5).translate(0, 2.1, 0),
    ]);
    const perim = 2 * ((east - west) + (south - north));
    for (let t = 0; t < 2; t++) {
      const cars = [];
      for (let c = 0; c < 4; c++) {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(carGeo, this.mat.train));
        g.add(new THREE.Mesh(winGeo, this.mat.trainWin));
        this.group.add(g);
        cars.push(g);
      }
      this.trains.push({ cars, s: t * perim * 0.5, dir: t ? -1 : 1, speed: 13 });
    }
    this.lPerim = perim;
  }

  // The other elevated CTA lines from OpenStreetMap, one structure per mapped track: the North
  // Side Main Line up Wells and Franklin, the Lake Street branch, the South Side Elevated and the
  // Orange Line. Movable river bridges get no columns (they stand in the river).
  buildElevatedLines(cols, girders, decks, rails) {
    const { west, east, north, south, deck } = L_LOOP;
    const nearLoop = (x, z) => (Math.abs(z - north) < 9 || Math.abs(z - south) < 9) && x > west - 9 && x < east + 9 ||
      (Math.abs(x - west) < 9 || Math.abs(x - east) < 9) && z > north - 9 && z < south + 9;
    const colGeo = new THREE.BoxGeometry(0.55, deck, 0.55).translate(0, deck / 2, 0);
    // every track point, so a column can find the neighbouring track and step out to the kerb
    const lines = this.data.rail || [];
    const pgrid = new Map();
    const pkey = (x, z) => `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    lines.forEach((line, li) => {
      const pts = line.p;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
        for (let k = 0; k <= n; k++) {
          const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n, kk = pkey(x, z);
          if (!pgrid.has(kk)) pgrid.set(kk, []);
          pgrid.get(kk).push(x, z, li);
        }
      }
    });
    const partner = (x, z, li) => {
      let best = 49, bx = 0, bz = 0, found = false;
      const gx = Math.floor(x / 8), gz = Math.floor(z / 8);
      for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iz = gz - 1; iz <= gz + 1; iz++) {
        const c = pgrid.get(`${ix},${iz}`);
        if (!c) continue;
        for (let k = 0; k < c.length; k += 3) {
          if (c[k + 2] === li) continue;
          const d = (c[k] - x) ** 2 + (c[k + 1] - z) ** 2;
          if (d < best && d > 1) { best = d; bx = c[k]; bz = c[k + 1]; found = true; }
        }
      }
      return found ? [bx, bz] : null;
    };
    for (const [li, line] of lines.entries()) {
      const pts = line.p;
      let carry = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (nearLoop(mx, mz)) { carry = 0; continue; }
        const tx = (bx - ax) / len, tz = (bz - az) / len, ang = Math.atan2(tx, tz);
        decks.push(new THREE.BoxGeometry(3.6, 0.45, len + 0.6).rotateY(ang).translate(mx, deck - 0.22, mz));
        for (const off of [-0.72, 0.72]) {
          rails.push(new THREE.BoxGeometry(0.1, 0.15, len + 0.6).translate(off, 0, 0).rotateY(ang).translate(mx, deck + 0.075, mz));
        }
        this.addCollider(boxRing(mx, mz, 3.6, len + 0.6, ang), deck - 0.5, deck + 0.02, 'ldeck').noWall = true;
        if (line.m) { carry = 0; continue; }
        for (let d = (14 - carry) % 14; d < len; d += 14) {
          let x = ax + tx * d, z = az + tz * d;
          // a double-track line: put this track's column on its outer side, at the kerb
          const pt = partner(x, z, li);
          if (pt) {
            const ox = x - pt[0], oz = z - pt[1], ol = Math.hypot(ox, oz) || 1;
            x += (ox / ol) * 2.1; z += (oz / ol) * 2.1;
          }
          if (this.insideAny(x, 2, z)) continue;
          cols.push(colGeo.clone().translate(x, 0, z));
          girders.push(new THREE.BoxGeometry(3.8, 0.55, 0.45).rotateY(ang).translate(x, deck - 0.7, z));
          this.addCollider(boxRing(x, z, 0.65, 0.65), 0, deck, 'lcol').noWall = true;
        }
        carry = (carry + len) % 14;
      }
    }
  }

  lPoint(s, side, out) {
    const { west, east, north, south } = L_LOOP;
    const w = east - west, h = south - north;
    s = ((s % this.lPerim) + this.lPerim) % this.lPerim;
    let x, z, hx, hz;
    if (s < w) { x = west + s; z = north; hx = 1; hz = 0; }
    else if (s < w + h) { x = east; z = north + (s - w); hx = 0; hz = 1; }
    else if (s < 2 * w + h) { x = east - (s - w - h); z = south; hx = -1; hz = 0; }
    else { x = west; z = south - (s - 2 * w - h); hx = 0; hz = -1; }
    out.x = x - hz * 1.6 * side;
    out.z = z + hx * 1.6 * side;
    out.heading = Math.atan2(hx, hz);
    return out;
  }

  buildStreetLights(roads) {
    const spots = [];
    for (const r of roads) {
      if (!['primary', 'secondary', 'tertiary', 'trunk'].includes(r.k) || r.b) continue;
      const pts = r.p;
      let carry = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1) continue;
        const tx = (bx - ax) / len, tz = (bz - az) / len;
        for (let d = 34 - carry; d < len; d += 34) {
          for (const side of [1, -1]) {
            const off = r.w / 2 + 1.4;
            const x = ax + tx * d - tz * off * side, z = az + tz * d + tx * off * side;
            if (this.groundAt(x, z, 1) > 0 || this.insideAny(x, 2, z)) continue;
            spots.push([x, z]);
          }
        }
        carry = (carry + len) % 34;
      }
      if (spots.length > 7000) break;
    }
    const n = spots.length;
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, 7.6, 6).translate(0, 3.8, 0),
      new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.5 }), n);
    const head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.14, 0.34), this.mat.lampHead, n);
    const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2), this.mat.pool, n);
    const m = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      pole.setMatrixAt(i, m.makeTranslation(x, 0, z));
      head.setMatrixAt(i, m.makeTranslation(x, 7.65, z));
      pool.setMatrixAt(i, m.makeTranslation(x, 0.09, z));
    });
    pole.castShadow = true;
    pool.renderOrder = 4;
    this.group.add(pole, head, pool);
  }

  buildTrees(parks) {
    const rand = rng(21);
    const spots = [];
    // every road segment in a coarse grid, so a tree can check it stands clear of the carriageway and
    // the sidewalk band drawn beside it (parks in the map often run right over the streets)
    const RC = 40, rgrid = new Map();
    for (const r of this.data.roads) {
      const pts = r.p, half = r.w / 2 + (r.b || r.k === 'motorway' || r.k === 'trunk' ? 1.5 : 5.5);
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const seg = [ax, az, bx, bz, half];
        for (let ix = Math.floor((Math.min(ax, bx) - half) / RC); ix <= Math.floor((Math.max(ax, bx) + half) / RC); ix++) {
          for (let iz = Math.floor((Math.min(az, bz) - half) / RC); iz <= Math.floor((Math.max(az, bz) + half) / RC); iz++) {
            const k = ix * 100000 + iz;
            if (!rgrid.has(k)) rgrid.set(k, []);
            rgrid.get(k).push(seg);
          }
        }
      }
    }
    const onRoad = (x, z, pad) => {
      const cell = rgrid.get(Math.floor(x / RC) * 100000 + Math.floor(z / RC));
      if (!cell) return false;
      for (const [ax, az, bx, bz, half] of cell) {
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const ex = ax + dx * t - x, ez = az + dz * t - z, lim = half + pad;
        if (ex * ex + ez * ez < lim * lim) return true;
      }
      return false;
    };
    // the crown must clear walls too: test its rim, at trunk and crown height
    const clear = (x, z, rad) => {
      for (let a = 0; a < 6; a++) {
        const px = x + Math.cos(a * 1.047) * rad, pz = z + Math.sin(a * 1.047) * rad;
        if (this.insideAny(px, 2, pz) || this.insideAny(px, 5, pz)) return false;
      }
      return true;
    };
    for (const park of parks) {
      const ring = park.p;
      if (!ring || ring.length < 3 || park.k === 'field') continue;
      const tmp = { xs: Float32Array.from(ring.map((q) => q[0])), zs: Float32Array.from(ring.map((q) => q[1])), n: ring.length };
      tmp.minX = Math.min(...tmp.xs); tmp.maxX = Math.max(...tmp.xs);
      tmp.minZ = Math.min(...tmp.zs); tmp.maxZ = Math.max(...tmp.zs);
      const area = Math.abs(signedArea(ring));
      const want = Math.min(420, Math.floor(area / 170));
      for (let k = 0, tries = 0; k < want && tries < want * 4; tries++) {
        const x = tmp.minX + rand() * (tmp.maxX - tmp.minX), z = tmp.minZ + rand() * (tmp.maxZ - tmp.minZ);
        const sz = 0.75 + rand() * 0.6, rad = 2.6 * sz;
        if (!pip(tmp, x, z) || this.groundAt(x, z, 1) > 0 || this.insideAny(x, 2, z)) continue;
        // not on a street or sidewalk, not under the 'L' deck, not growing through a wall
        if (onRoad(x, z, rad) || this.insideAny(x, 6.1, z) || !clear(x, z, rad)) continue;
        spots.push([x, z, sz, rand()]);
        k++;
      }
    }
    const n = spots.length;
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.6, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), n);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.26, 4, 6).translate(0, 2, 0),
      new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 1 }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    spots.forEach(([x, z, k, r], i) => {
      trunk.setMatrixAt(i, m.compose(p.set(x, 0, z), q.identity(), s.set(k, k, k)));
      crown.setMatrixAt(i, m.compose(p.set(x, 4.6 * k + 1.2, z), q.identity(), s.set(k, k * 1.15, k)));
      // late-October Chicago: mostly green with some turning gold and rust
      crown.setColorAt(i, col.setHSL(r < 0.55 ? 0.24 + r * 0.08 : r < 0.8 ? 0.1 : 0.05, 0.45, r < 0.55 ? 0.24 : 0.32));
    });
    crown.castShadow = trunk.castShadow = true;
    crown.receiveShadow = true;
    this.group.add(crown, trunk);
  }

  // PSI tokens along the streets, big ones at plazas, Superchargers tucked beside major roads.
  buildPickups() {
    const pads = [];
    const bigs = [];
    const roads = this.data.roads;
    const far = (x, z, list, d) => list.every((p) => (p.x - x) ** 2 + (p.z - z) ** 2 > d * d);
    for (const r of roads) {
      if (!['secondary', 'primary', 'tertiary'].includes(r.k) || r.b) continue;
      const pts = r.p;
      let carry = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1) continue;
        const tx = (bx - ax) / len, tz = (bz - az) / len;
        for (let d = 90 - carry; d < len; d += 90) {
          const x = ax + tx * d, z = az + tz * d;
          if (this.insideAny(x, 1, z) || !far(x, z, pads, 40)) continue;
          pads.push({ x, y: 0, z, big: false });
        }
        carry = (carry + len) % 90;
      }
      if (pads.length > 2400) break;
    }
    const bigSpots = [[-115, -118], [520, 90], [905, 760], [-30, 560], [300, -520], [-520, 300], [700, -250], [120, 1100], [-900, -300], [1000, -720], [-350, 1000], [450, 500]];
    for (const [x, z] of bigSpots) {
      const r = this.nearestRoad(x, z, ['secondary', 'primary', 'tertiary', 'residential']);
      if (far(r.x, r.z, bigs, 100)) bigs.push({ x: r.x, y: 0, z: r.z, big: true });
    }
    const all = pads.filter((p) => far(p.x, p.z, bigs, 25)).concat(bigs);
    this.buildPads(all);

    const chargers = [];
    const spots = [[520, 60], [150, 760], [-620, 140], [880, -640], [-120, -420], [340, 1250], [-330, 760], [1050, -300], [-850, 600]];
    for (const [x, z] of spots) {
      const r = this.nearestRoad(x, z, ['secondary', 'tertiary', 'residential', 'service', 'unclassified']);
      // put the stalls just off the kerb on whichever side is open
      const road = this.roadAt(r.x, r.z);
      const w = road ? road.w / 2 : 7;
      const hx = Math.sin(r.heading), hz = Math.cos(r.heading);
      let placed = false;
      for (const side of [1, -1]) {
        const px = r.x - hz * (w + 4.2) * side, pz = r.z + hx * (w + 4.2) * side;
        if (this.insideAny(px, 1.2, pz) || this.insideAny(px - hx * 4, 1.2, pz - hz * 4) || this.insideAny(px + hx * 4, 1.2, pz + hz * 4)) continue;
        chargers.push({ x: px, z: pz, rot: r.heading, n: 3 });
        placed = true;
        break;
      }
      if (!placed) chargers.push({ x: r.x - hz * (w + 2.5), z: r.z + hx * (w + 2.5), rot: r.heading, n: 2 });
    }
    this.buildChargers(chargers);
  }

  roadAt(x, z) {
    let best = Infinity, res = null;
    for (const r of this.data.roads) {
      const p = r.p;
      for (let i = 0; i < p.length - 1; i++) {
        const d = (p[i][0] - x) ** 2 + (p[i][1] - z) ** 2;
        if (d < best) { best = d; res = r; }
      }
    }
    return res;
  }

  // --- night lighting ---------------------------------------------------------

  setNight(level) {
    for (const k of ['glass', 'stone', 'brick', 'deco']) this.mat[k].emissiveIntensity = 0.05 + level * (k === 'glass' ? 1.6 : 1.3);
    const k = 0.25 + level * 7;
    this.mat.lampHead.color.setRGB(k, k * 0.78, k * 0.5);
    this.mat.pool.opacity = level * 0.2;
    const tw = 0.1 + level * 4;
    this.mat.trainWin.color.setRGB(tw, tw * 0.95, tw * 0.8);
  }

  update(dt, t) {
    super.update(dt, t);
    this.waterTex.offset.set(t * 0.012, t * 0.007);
    this.fountainJet.scale.set(1 + Math.sin(t * 3.1) * 0.05, 1, 1 + Math.cos(t * 2.3) * 0.05);
    const o = { x: 0, z: 0, heading: 0 };
    for (const tr of this.trains) {
      tr.s += tr.dir * tr.speed * dt;
      tr.cars.forEach((c, i) => {
        this.lPoint(tr.s - tr.dir * i * 15.2, tr.dir, o);
        c.position.set(o.x, L_LOOP.deck + 0.1, o.z);
        c.rotation.y = o.heading;
      });
    }
  }

  // Nearest drivable road point and its direction (for spawning and respawning).
  nearestRoad(x, z, kinds, preferNorth = false) {
    let best = Infinity, res = null;
    for (const r of this.data.roads) {
      if (kinds && !kinds.includes(r.k)) continue;
      if (r.b) continue;
      const p = r.p;
      for (let i = 0; i < p.length - 1; i++) {
        const [ax, az] = p[i], [bx, bz] = p[i + 1];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        if (l2 < 4) continue;
        const t = Math.max(0.1, Math.min(0.9, ((x - ax) * dx + (z - az) * dz) / l2));
        const qx = ax + dx * t, qz = az + dz * t;
        const d = (qx - x) ** 2 + (qz - z) ** 2;
        if (d < best && !this.insideAny(qx, 1, qz) && this.groundAt(qx, qz, 1) === 0) {
          best = d;
          let h = Math.atan2(dx, dz);
          if (preferNorth && Math.cos(h) > 0) h += Math.PI;
          res = { x: qx, z: qz, heading: h };
        }
      }
    }
    return res || { x, z, heading: Math.PI };
  }
}
