import * as THREE from 'three';
import { fleetModels, fleetMaterials, HUMAN } from './fleet.js?v=3.9';
import { RoadNet } from './roadnet.js?v=3.9';

// City life around the player: Teslas driving the real street network (lanes, one-way streets, the
// mapped signals and stop signs, following distance), Semis with trailers, people and Optimus robots
// on the sidewalks, and signal heads at the junctions. Everything lives in a ring around the car and
// is recycled as you drive, so the whole 6 km map feels busy for the cost of a few hundred agents.
//
// Your car can bump traffic (Rocket League rules: a supersonic hit sends a car flying). People and
// robots step or hop out of the way; nobody gets hurt.

const MIX = [['modelY', 28], ['model3', 22], ['cybercab', 18], ['cybertruck', 11], ['modelS', 6], ['modelX', 6], ['robovan', 5], ['semi', 4]];
const MAIN = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const WALKABLE = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);
const SHIRTS = ['#1f2a3a', '#14161a', '#3a3d42', '#5a4632', '#2f3b2a', '#5b1d24', '#7a6a55', '#26405e', '#8a2a22', '#c9a227', '#3d5a7a', '#6b6f75'];
const PANTS = ['#1c2a44', '#121316', '#3a3c40', '#6b5b45', '#24324c', '#2a2a2a'];
const SKIN = ['#f1c9a5', '#e0ac85', '#c68a62', '#a8704b', '#8a5a3c', '#5e3b26', '#f6d7c0'];

const pick = (arr, w) => {
  let t = 0;
  for (const x of w) t += x;
  let r = Math.random() * t;
  for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Traffic {
  constructor(scene, world, data, opts = {}) {
    this.scene = scene;
    this.world = world;
    this.net = new RoadNet(data.net);
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mats = fleetMaterials();
    this.models = fleetModels();
    this.time = 0;
    this.R = { spawnMin: 230, spawnMax: 430, keep: 520, pedMin: 70, pedMax: 260, pedKeep: 320 };
    this.cars = [];
    this.peds = [];
    this.tmp = {};
    this.tmp2 = {};
    this.buildMeshes(opts.vehicles ?? 120, opts.people ?? 200, opts.optimus ?? 30);
    this.buildSignals();
    this.walkOk = new Map();
    this.started = false;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }

  // --- meshes ------------------------------------------------------------------------------

  buildMeshes(nCars, nPeople, nBots) {
    const M = this.mats;
    this.vmesh = {};
    const cap = { semi: Math.ceil(nCars * 0.1), trailer: Math.ceil(nCars * 0.1), robovan: Math.ceil(nCars * 0.12), modelS: Math.ceil(nCars * 0.15), modelX: Math.ceil(nCars * 0.15) };
    for (const [key, m] of Object.entries(this.models.vehicles)) {
      const n = cap[key] || nCars;
      const mk = (geo, mat, shadow) => {
        const im = new THREE.InstancedMesh(geo, mat, n);
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = shadow;
        im.receiveShadow = true;
        this.group.add(im);
        return im;
      };
      this.vmesh[key] = { paint: mk(m.paint, M.paint, true), fixed: mk(m.fixed, M.fixed, true), lights: mk(m.lights, M.lights, false), cap: n, info: m };
      this.vmesh[key].paint.setColorAt(0, new THREE.Color(1, 1, 1));
    }
    for (let i = 0; i < nCars; i++) this.cars.push({ id: i, live: false });
    const human = (parts, mat, n, tint) => {
      const mk = (geo, k) => {
        const im = new THREE.InstancedMesh(geo, mat, n * k);
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = true;
        if (tint) im.setColorAt(0, new THREE.Color(1, 1, 1));
        this.group.add(im);
        return im;
      };
      return { torso: mk(parts.torso, 1), head: mk(parts.head, 1), leg: mk(parts.leg, 2), arm: mk(parts.arm, 2) };
    };
    this.pmesh = human(this.models.person, M.cloth, nPeople, true);
    this.omesh = human(this.models.optimus, M.robot, nBots, false);
    for (let i = 0; i < nPeople; i++) this.peds.push({ id: i, bot: false, live: false });
    for (let i = 0; i < nBots; i++) this.peds.push({ id: nPeople + i, bot: true, live: false });
  }

  // Signal heads on poles at each signalled junction, one per approach, at the right-hand kerb by
  // the stop line, facing the traffic. Lamps are recoloured as the phases change.
  buildSignals() {
    const net = this.net;
    const heads = [];
    const p = {};
    for (const v of net.signals) {
      for (const t of net.walk[v]) {
        // the approach arriving at v along this edge
        const e = t.e, d = -t.d;
        if (e.ow && d < 0) continue;
        if (e.len < net.clear[v] + 2) continue;
        net.pointAt(e, d, e.len - net.clear[v] + 1.2, (e.ow ? e.w / 2 : e.w / 2) + 0.9, p);
        if (this.world.insideAny(p.x, 1, p.z)) continue;
        heads.push({ x: p.x, z: p.z, h: Math.atan2(p.tx, p.tz), v });
      }
    }
    const n = heads.length;
    this.heads = heads;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.6, metalness: 0.5 });
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.1, 4.6, 6).translate(0, 2.3, 0), poleMat, n);
    const box = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 1.05, 0.28).translate(0, 4.55, 0), poleMat, n);
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.2, 0.04), new THREE.MeshBasicMaterial({ toneMapped: false }), n * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    heads.forEach((hd, i) => {
      // facing the oncoming cars: they travel along h, so the head looks back along -h
      q.setFromAxisAngle(up, hd.h + Math.PI);
      pole.setMatrixAt(i, m.compose(pos.set(hd.x, 0, hd.z), q, s));
      box.setMatrixAt(i, m.compose(pos.set(hd.x, 0, hd.z), q, s));
      for (let k = 0; k < 3; k++) {
        const fx = Math.sin(hd.h + Math.PI) * 0.15, fz = Math.cos(hd.h + Math.PI) * 0.15;
        this.lamps.setMatrixAt(i * 3 + k, m.compose(pos.set(hd.x + fx, 4.9 - k * 0.33, hd.z + fz), q, s));
        this.lamps.setColorAt(i * 3 + k, new THREE.Color(0.05, 0.05, 0.05));
      }
    });
    pole.castShadow = box.castShadow = true;
    this.group.add(pole, box, this.lamps);
    this.lampT = 0;
    this.colLamp = { r: new THREE.Color(2.4, 0.12, 0.08), y: new THREE.Color(2.2, 1.4, 0.1), g: new THREE.Color(0.15, 2.2, 0.6), off: new THREE.Color(0.05, 0.05, 0.05) };
  }

  updateLamps() {
    const net = this.net, L = this.lamps, c = this.colLamp;
    this.heads.forEach((hd, i) => {
      const st = net.signal(hd.v, hd.h, this.time);
      L.setColorAt(i * 3, st === 'r' ? c.r : c.off);
      L.setColorAt(i * 3 + 1, st === 'y' ? c.y : c.off);
      L.setColorAt(i * 3 + 2, st === 'g' ? c.g : c.off);
    });
    L.instanceColor.needsUpdate = true;
  }

  setNight(level) {
    this.mats.lights.color.setScalar(1 + level * 3);
  }

  // --- spawning ------------------------------------------------------------------------------

  randomEdge(px, pz, rMin, rMax, filter) {
    const net = this.net;
    for (let k = 0; k < 30; k++) {
      const a = Math.random() * Math.PI * 2, r = rMin + Math.random() * (rMax - rMin);
      const c = net.grid.get(net.key(px + Math.sin(a) * r, pz + Math.cos(a) * r));
      if (!c || !c.length) continue;
      const e = c[Math.floor(Math.random() * c.length)];
      if (filter(e)) return e;
    }
    return null;
  }

  spawnCar(car, px, pz, rMin, rMax) {
    const net = this.net;
    const type = pick(MIX.map((m) => m[0]), MIX.map((m) => m[1]));
    const big = type === 'semi' || type === 'robovan';
    const vm = this.vmesh[type];
    if (this.countOf(type) >= vm.cap) return false;
    const e = this.randomEdge(px, pz, rMin, rMax, (e) => e.core && e.len > 24 && (!big || MAIN.has(e.kind)) && e.kind !== 'motorway');
    if (!e) return false;
    const d = e.ow ? 1 : Math.random() < 0.5 ? 1 : -1;
    const lane = Math.floor(Math.random() * e.nl);
    const s = 8 + Math.random() * (e.len - 16);
    for (const o of this.cars) {
      if (o.live && o.e === e && o.d === d && o.lane === lane && Math.abs(o.s - s) < 16) return false;
    }
    const info = vm.info;
    Object.assign(car, {
      live: true, type, info, e, d, lane, s, v: e.speed * 0.7, drive: 0.85 + Math.random() * 0.25,
      col: new THREE.Color(pick(info.paints, info.weights)), next: null, turn: null, wait: 0, stopped: 0,
      bump: null, x: 0, z: 0, y: 0, yaw: 0, pitch: 0, roll: 0, trail: null,
    });
    this.placeCar(car);
    if (type === 'semi') {
      // the trailer follows the fifth wheel's track: seed the breadcrumbs straight behind
      car.trail = [];
      const hx = Math.sin(car.yaw), hz = Math.cos(car.yaw);
      for (let k = 14; k >= 0; k--) car.trail.push([car.x - hx * (1.9 + k), car.z - hz * (1.9 + k)]);
    }
    return true;
  }

  countOf(type) {
    let n = 0;
    for (const c of this.cars) if (c.live && c.type === type) n++;
    return n;
  }

  spawnPed(p, px, pz, rMin, rMax) {
    const net = this.net;
    const e = this.randomEdge(px, pz, rMin, rMax, (e) => WALKABLE.has(e.kind) && !e.br && e.len > 20);
    if (!e) return false;
    const d = Math.random() < 0.5 ? 1 : -1;
    const side = Math.random() < 0.5 ? 1 : -1;
    if (!this.walkable(e, d, side)) return false;
    Object.assign(p, {
      live: true, e, d, side, s: Math.random() * e.len, v: p.bot ? 0.85 + Math.random() * 0.25 : 1.1 + Math.random() * 0.45,
      phase: Math.random() * 6.28, idle: p.bot && Math.random() < 0.25 ? 1e9 : 0, corner: null,
      dx: 0, dz: 0, vx: 0, vz: 0, hop: 0, vy: 0, fall: 0, x: 0, z: 0, yaw: 0, pause: 0,
      shirt: new THREE.Color(SHIRTS[Math.floor(Math.random() * SHIRTS.length)]),
      pants: new THREE.Color(PANTS[Math.floor(Math.random() * PANTS.length)]),
      skin: new THREE.Color(SKIN[Math.floor(Math.random() * SKIN.length)]),
    });
    this.walkPos(p);
    return true;
  }

  // a sidewalk is walkable if its centre line stays clear of buildings
  walkable(e, d, side) {
    const k = e.i * 2 + ((d * side) > 0 ? 1 : 0);
    let ok = this.walkOk.get(k);
    if (ok === undefined) {
      const off = side * (e.w / 2 + 2.6);
      let bad = 0, n = 0;
      const p = this.tmp2;
      for (let s = 2; s < e.len - 2; s += 7) {
        this.net.pointAt(e, d, s, off, p);
        n++;
        if (this.world.insideAny(p.x, 1, p.z)) bad++;
      }
      ok = n > 0 && bad / n <= 0.12;
      this.walkOk.set(k, ok);
    }
    return ok;
  }

  walkPos(p) {
    const q = this.tmp2;
    this.net.pointAt(p.e, p.d, p.s, p.side * (p.e.w / 2 + 2.6), q);
    p.bx = q.x;
    p.bz = q.z;
    p.byaw = Math.atan2(q.tx, q.tz);
  }

  // --- driving -------------------------------------------------------------------------------

  placeCar(c) {
    const net = this.net, q = this.tmp;
    if (c.turn) {
      const T = c.turn, u = Math.min(1, T.done / T.len), w = 1 - u;
      const P = T.p;
      c.x = w * w * w * P[0] + 3 * w * w * u * P[2] + 3 * w * u * u * P[4] + u * u * u * P[6];
      c.z = w * w * w * P[1] + 3 * w * w * u * P[3] + 3 * w * u * u * P[5] + u * u * u * P[7];
      const dx = 3 * w * w * (P[2] - P[0]) + 6 * w * u * (P[4] - P[2]) + 3 * u * u * (P[6] - P[4]);
      const dz = 3 * w * w * (P[3] - P[1]) + 6 * w * u * (P[5] - P[3]) + 3 * u * u * (P[7] - P[5]);
      c.yaw = Math.atan2(dx, dz);
    } else {
      net.pointAt(c.e, c.d, c.s, net.laneOff(c.e, c.lane), q);
      c.x = q.x;
      c.z = q.z;
      c.yaw = Math.atan2(q.tx, q.tz);
    }
  }

  chooseNext(c) {
    const net = this.net;
    const v = net.end(c.e, c.d);
    const big = c.type === 'semi' || c.type === 'robovan';
    const hIn = net.tangent(c.e, c.d, c.e.len, this.tmp2);
    const hin = Math.atan2(hIn.tx, hIn.tz);
    const opts = [], w = [];
    for (const t of net.out[v]) {
      if (t.e === c.e) continue;
      if (big && !MAIN.has(t.e.kind) && net.out[v].some((o) => o.e !== c.e && MAIN.has(o.e.kind))) continue;
      const h0 = net.tangent(t.e, t.d, 0, this.tmp2);
      const turn = wrap(Math.atan2(h0.tx, h0.tz) - hin);
      if (Math.abs(turn) > 2.6) continue;
      opts.push({ t, turn });
      w.push(Math.abs(turn) < 0.5 ? 4 : turn > 0 ? 1.4 : 1.1);
    }
    if (!opts.length) {
      if (!c.e.ow) return { e: c.e, d: -c.d, turn: Math.PI };
      return null;
    }
    const o = pick(opts, w);
    return { e: o.t.e, d: o.t.d, turn: o.turn };
  }

  startTurn(c) {
    const net = this.net;
    const n = c.next;
    const lane2 = Math.min(c.lane, n.e.nl - 1);
    const jB = Math.min(net.clear[net.start(n.e, n.d)], n.e.len * 0.4);
    const a = net.pointAt(c.e, c.d, c.s, net.laneOff(c.e, c.lane), {});
    const b = net.pointAt(n.e, n.d, jB, net.laneOff(n.e, lane2), {});
    const dist = Math.hypot(b.x - a.x, b.z - a.z), k = Math.max(1, dist * 0.4);
    const P = [a.x, a.z, a.x + a.tx * k, a.z + a.tz * k, b.x - b.tx * k, b.z - b.tz * k, b.x, b.z];
    let len = 0, px = P[0], pz = P[1];
    for (let i = 1; i <= 8; i++) {
      const u = i / 8, w = 1 - u;
      const x = w * w * w * P[0] + 3 * w * w * u * P[2] + 3 * w * u * u * P[4] + u * u * u * P[6];
      const z = w * w * w * P[1] + 3 * w * w * u * P[3] + 3 * w * u * u * P[5] + u * u * u * P[7];
      len += Math.hypot(x - px, z - pz);
      px = x; pz = z;
    }
    c.turn = { p: P, len: Math.max(0.5, len), done: 0, jB, lane2, node: net.end(c.e, c.d) };
  }

  // Intelligent-driver acceleration toward v0, given the gap to whatever is ahead and its speed.
  idm(v, v0, gap, dv) {
    const s0 = 2.4, T = 1.2, a = 2.2, b = 3.2;
    const ss = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
    const free = 1 - Math.pow(v / Math.max(0.1, v0), 4);
    const g = Math.max(0.1, gap);
    return Math.max(-9, a * (free - (ss / g) * (ss / g)));
  }

  updateCars(dt, player) {
    const net = this.net;
    // who is where: per lane of each traversal, sorted by distance along it
    const lanes = new Map();
    const put = (key, s, c) => {
      let l = lanes.get(key);
      if (!l) lanes.set(key, (l = []));
      l.push(s, c);
    };
    const keyOf = (e, d, lane) => (e.i * 2 + (d > 0 ? 1 : 0)) * 8 + lane;
    const busy = new Map();
    for (const c of this.cars) {
      if (!c.live) continue;
      if (c.bump) {
        const b = c.bump;
        const along = b.s0 + (c.x - b.x0) * b.tx + (c.z - b.z0) * b.tz;
        const lat = Math.abs((c.x - b.x0) * b.tz - (c.z - b.z0) * b.tx);
        if (lat < 3 && c.y < 1) put(keyOf(c.e, c.d, c.lane), along, c);
        continue;
      }
      if (c.turn) {
        const T = c.turn;
        put(keyOf(c.next.e, c.next.d, T.lane2), T.jB - (T.len - T.done), c);
        put(keyOf(c.e, c.d, c.lane), c.s + T.done, c);
        if (!busy.has(T.node)) busy.set(T.node, []);
        busy.get(T.node).push(c);
      } else put(keyOf(c.e, c.d, c.lane), c.s, c);
    }
    const leader = (key, s, self) => {
      const l = lanes.get(key);
      if (!l) return null;
      let best = null, bs = Infinity;
      for (let i = 0; i < l.length; i += 2) {
        if (l[i + 1] !== self && l[i] > s && l[i] < bs) { bs = l[i]; best = l[i + 1]; }
      }
      return best ? { s: bs, c: best } : null;
    };
    for (const c of this.cars) {
      if (!c.live) continue;
      if (c.bump) { this.updateBump(c, dt); continue; }
      const half = c.info.L / 2;
      const v0 = c.e.speed * c.drive * (c.type === 'semi' ? 0.85 : 1);
      let gap = 200, dv = 0;
      const consider = (g, lv) => { if (g < gap) { gap = g; dv = c.v - lv; } };
      if (c.turn) {
        const T = c.turn;
        const l = leader(keyOf(c.next.e, c.next.d, T.lane2), T.jB - (T.len - T.done), c);
        if (l) consider(l.s - (T.jB - (T.len - T.done)) - half - l.c.info.L / 2, l.c.v);
      } else {
        const l = leader(keyOf(c.e, c.d, c.lane), c.s, c);
        if (l) consider(l.s - c.s - half - l.c.info.L / 2, l.c.v);
        const remain = c.e.len - c.s;
        if (!c.next) c.next = this.chooseNext(c);
        if (!c.next) { c.live = false; continue; }
        const v = net.end(c.e, c.d);
        const jA = Math.min(net.clear[v], c.e.len * 0.4);
        if (!l && remain < 60) {
          const lane2 = Math.min(c.lane, c.next.e.nl - 1);
          const l2 = leader(keyOf(c.next.e, c.next.d, lane2), -50, c);
          if (l2) consider(remain + l2.s - half - l2.c.info.L / 2, l2.c.v);
        }
        // signals, stop signs and a busy junction hold the car at the stop line
        let hold = false;
        const toLine = remain - jA;
        // a short stub ahead that ends at a red: wait here rather than stop inside the junction
        const n = c.next, nv = net.end(n.e, n.d);
        let aheadRed = false;
        if (n.e.len < 35 && net.signals.has(nv) && !net.inside(n.e)) {
          const t2 = net.tangent(n.e, n.d, n.e.len, this.tmp2);
          const st2 = net.signal(nv, Math.atan2(t2.tx, t2.tz), this.time);
          aheadRed = st2 === 'r' || st2 === 'y';
        }
        if (aheadRed && toLine > (c.v * c.v) / 18) hold = true;
        else if (net.signals.has(v) && !net.inside(c.e)) {
          const t = net.tangent(c.e, c.d, c.e.len, this.tmp2);
          const st = net.signal(v, Math.atan2(t.tx, t.tz), this.time);
          if (st === 'r' || (st === 'y' && toLine > (c.v * c.v) / 6 + 2)) hold = toLine > -0.5;
        } else if (net.stops.has(v) && c.stopped < 0.8) {
          // a full stop at the line, then on (the busy-junction check below still applies)
          hold = true;
          if (c.v < 0.4 && remain - jA < half + 3) c.stopped += dt;
        } else if (remain - jA < 4) {
          const others = busy.get(v);
          if (others && others.some((o) => o.e !== c.e)) {
            c.wait += dt;
            hold = c.wait < 3;
          }
        }
        if (hold) consider(remain - jA - half + 0.5, 0);
      }
      // the player's car in the lane ahead
      const ox = player.pos.x - c.x, oz = player.pos.z - c.z;
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      const ahead = ox * fx + oz * fz, lat = Math.abs(ox * fz - oz * fx);
      if (ahead > 0 && ahead < 45 && lat < 2.3 && player.pos.y < 3) {
        const pv = player.vel.x * fx + player.vel.z * fz;
        consider(ahead - half - 2.4, pv);
      }
      const acc = this.idm(c.v, v0, gap, dv);
      c.v = Math.max(0, c.v + acc * dt);
      const step = c.v * dt;
      if (c.turn) {
        c.turn.done += step;
        if (c.turn.done >= c.turn.len) {
          const T = c.turn;
          c.e = c.next.e; c.d = c.next.d; c.lane = T.lane2; c.s = T.jB;
          c.turn = null; c.next = null; c.wait = 0; c.stopped = 0;
        }
      } else {
        c.s += step;
        const v = net.end(c.e, c.d);
        const jA = Math.min(net.clear[v], c.e.len * 0.4);
        if (c.s >= c.e.len - jA) {
          c.s = c.e.len - jA;
          this.startTurn(c);
        }
      }
      this.placeCar(c);
      if (c.trail) this.trailStep(c);
    }
  }

  // the trailer's axle runs along the fifth wheel's breadcrumbs, 12.4 m behind it
  trailStep(c) {
    const hx = Math.sin(c.yaw), hz = Math.cos(c.yaw);
    const kx = c.x - hx * 1.9, kz = c.z - hz * 1.9;
    const tr = c.trail, last = tr[tr.length - 1];
    if (Math.hypot(kx - last[0], kz - last[1]) > 0.5) {
      tr.push([kx, kz]);
      if (tr.length > 60) tr.shift();
    }
    let need = 12.4, ax = kx, az = kz;
    for (let i = tr.length - 1; i > 0 && need > 0; i--) {
      const [x0, z0] = tr[i], [x1, z1] = tr[i - 1];
      const l = Math.hypot(x1 - x0, z1 - z0);
      if (l >= need) { ax = x0 + (x1 - x0) * (need / l); az = z0 + (z1 - z0) * (need / l); need = 0; }
      else { need -= l; ax = x1; az = z1; }
    }
    c.tx = kx; c.tz = kz;
    c.tyaw = Math.atan2(kx - ax, kz - az);
  }

  updateBump(c, dt) {
    const b = c.bump;
    b.t += dt;
    c.x += b.vx * dt;
    c.z += b.vz * dt;
    c.y = Math.max(0, c.y + b.vy * dt);
    b.vy -= 25.4 * dt;
    if (c.y <= 0) {
      c.y = 0;
      if (b.vy < 0) b.vy = 0;
      const f = Math.exp(-3.2 * dt);
      b.vx *= f; b.vz *= f; b.w *= f;
      c.pitch *= Math.exp(-6 * dt);
      c.roll *= Math.exp(-6 * dt);
    } else {
      c.pitch += b.wp * dt;
      c.roll += b.wr * dt;
    }
    c.yaw += b.w * dt;
    if (this.world.insideAny(c.x, 0.8, c.z)) { c.x -= b.vx * dt * 1.5; c.z -= b.vz * dt * 1.5; b.vx *= -0.3; b.vz *= -0.3; }
    c.v = 0;
    if (c.trail) { c.tx = c.x - Math.sin(c.yaw) * 1.9; c.tz = c.z - Math.cos(c.yaw) * 1.9; c.tyaw = c.yaw; }
  }

  // --- walking -------------------------------------------------------------------------------

  updatePeds(dt, player) {
    const net = this.net;
    const pv = player.vel, speed = Math.hypot(pv.x, pv.z);
    for (const p of this.peds) {
      if (!p.live) continue;
      // dodge: if the car will pass within a couple of metres in the next second, jump clear
      const rx = p.x - player.pos.x, rz = p.z - player.pos.z;
      const d2 = rx * rx + rz * rz;
      if (d2 < 30 * 30 && speed > 3 && player.pos.y < 4 && p.fall <= 0) {
        const tca = Math.max(0, Math.min(1.1, (rx * pv.x + rz * pv.z) / (speed * speed)));
        const cx = rx - pv.x * tca, cz = rz - pv.z * tca;
        const close = Math.hypot(cx, cz);
        if (close < 2.6 && p.hop <= 0 && p.vy === 0) {
          // away from the car's line, at right angles to it
          let sx = -pv.z / speed, sz = pv.x / speed;
          if (sx * rx + sz * rz < 0) { sx = -sx; sz = -sz; }
          const k = p.bot ? 5.5 : 6.5;
          p.vx = sx * k; p.vz = sz * k; p.vy = 3.2; p.hop = 0.001;
        }
        if (d2 < 1.6 * 1.6) {
          const l = Math.sqrt(d2) || 1;
          p.vx = (rx / l) * (4 + speed * 0.3); p.vz = (rz / l) * (4 + speed * 0.3); p.vy = 2.5; p.hop = 0.001;
          p.fall = 1.4;
        }
      }
      if (p.hop > 0 || p.vy !== 0) {
        p.dx += p.vx * dt; p.dz += p.vz * dt;
        p.hop += p.vy * dt;
        p.vy -= 18 * dt;
        if (p.hop <= 0) { p.hop = 0; p.vy = 0; p.vx *= 0.2; p.vz *= 0.2; }
      } else {
        // drift back to the sidewalk line
        const f = Math.exp(-1.2 * dt);
        p.dx *= f; p.dz *= f;
      }
      if (p.fall > 0) p.fall -= dt;
      const busy = p.hop > 0 || p.fall > 0;
      // walking
      if (!busy && p.idle <= 0) {
        if (p.pause > 0) p.pause -= dt;
        else if (p.corner) {
          const C = p.corner;
          C.t += (p.v * dt) / C.len;
          if (C.t >= 1) { p.corner = null; this.walkPos(p); }
          else { p.bx = C.ax + (C.bx - C.ax) * C.t; p.bz = C.az + (C.bz - C.az) * C.t; p.byaw = Math.atan2(C.bx - C.ax, C.bz - C.az); }
        } else {
          p.s += p.v * dt;
          if (p.s >= p.e.len) this.pedCorner(p);
          else this.walkPos(p);
        }
        if (!p.corner && p.pause <= 0 && Math.random() < dt * 0.01) p.pause = 2 + Math.random() * 6;
        p.phase += dt * p.v * (p.bot ? 5.2 : 5.8) * (p.pause > 0 ? 0 : 1);
      }
      p.x = p.bx + p.dx;
      p.z = p.bz + p.dz;
      p.yaw += wrap(p.byaw - p.yaw) * Math.min(1, dt * 8);
    }
  }

  // at the end of a block: round the corner onto a sidewalk that starts nearby, or turn back
  pedCorner(p) {
    const net = this.net;
    const end = {};
    net.pointAt(p.e, p.d, p.e.len, p.side * (p.e.w / 2 + 2.6), end);
    const v = net.end(p.e, p.d);
    const opts = [];
    const q = {};
    for (const t of net.walk[v]) {
      if (t.e === p.e || !WALKABLE.has(t.e.kind) || t.e.br) continue;
      for (const side of [1, -1]) {
        net.pointAt(t.e, t.d, 0, side * (t.e.w / 2 + 2.6), q);
        const dd = Math.hypot(q.x - end.x, q.z - end.z);
        if (dd < 15 && this.walkable(t.e, t.d, side)) opts.push({ e: t.e, d: t.d, side, x: q.x, z: q.z, dd });
      }
    }
    if (!opts.length) {
      p.d = -p.d;
      p.side = -p.side;
      p.s = 0;
      this.walkPos(p);
      return;
    }
    const o = opts[Math.floor(Math.random() * opts.length)];
    p.corner = { ax: end.x, az: end.z, bx: o.x, bz: o.z, len: Math.max(0.5, o.dd), t: 0 };
    p.e = o.e; p.d = o.d; p.side = o.side; p.s = 0;
  }

  // --- the player's car against traffic ----------------------------------------------------------

  collide(player) {
    const px = player.pos.x, pz = player.pos.z;
    const pf = player.fwd, pfx = pf.x, pfz = pf.z, pl = Math.hypot(pfx, pfz) || 1;
    const ax = pfx / pl, az = pfz / pl;   // player axes in the ground plane
    const PH = 2.3, PW = 1.0;
    for (const c of this.cars) {
      if (!c.live) continue;
      const dx = c.x - px, dz = c.z - pz;
      if (dx * dx + dz * dz > 20 * 20) continue;
      if (player.pos.y > c.y + c.info.H + 0.2 || player.pos.y + 1.2 < c.y) continue;
      const bx = Math.sin(c.yaw), bz = Math.cos(c.yaw);
      const CH = c.info.L / 2, CW = c.info.W / 2;
      // separating axes: the two cars' forward and side directions
      let best = Infinity, nx = 0, nz = 0;
      for (const [ux, uz] of [[ax, az], [-az, ax], [bx, bz], [-bz, bx]]) {
        const rp = PH * Math.abs(ax * ux + az * uz) + PW * Math.abs(-az * ux + ax * uz);
        const rc = CH * Math.abs(bx * ux + bz * uz) + CW * Math.abs(-bz * ux + bx * uz);
        const dist = dx * ux + dz * uz;
        const pen = rp + rc - Math.abs(dist);
        if (pen <= 0) { best = -1; break; }
        if (pen < best) { best = pen; nx = dist > 0 ? -ux : ux; nz = dist > 0 ? -uz : uz; }
      }
      if (best <= 0) continue;
      // n points from the traffic car toward the player
      const mp = 1.9, mc = c.info.mass * (c.type === 'semi' ? 2 : 1);
      const cvx = c.bump ? c.bump.vx : Math.sin(c.yaw) * c.v, cvz = c.bump ? c.bump.vz : Math.cos(c.yaw) * c.v;
      const rvx = player.vel.x - cvx, rvz = player.vel.z - cvz;
      const vn = rvx * nx + rvz * nz;
      player.pos.x += nx * best * (mc / (mp + mc));
      player.pos.z += nz * best * (mc / (mp + mc));
      if (vn < 0) {
        const j = (-(1.25) * vn) / (1 / mp + 1 / mc);
        player.vel.x += (nx * j) / mp;
        player.vel.z += (nz * j) / mp;
        const sup = player.speed > 97;
        const kick = (j / mc) * (sup ? 1.8 : 1);
        if (!c.bump) {
          const t = this.net.tangent(c.e, c.d, c.s, {});
          c.bump = { t: 0, vx: cvx, vz: cvz, vy: 0, w: 0, wp: 0, wr: 0, s0: c.turn ? c.e.len : c.s, x0: c.x, z0: c.z, tx: t.tx, tz: t.tz };
          c.turn = null;
        }
        c.bump.vx -= nx * kick;
        c.bump.vz -= nz * kick;
        c.bump.t = 0;
        // an off-centre hit spins it
        const hx = px - c.x, hz = pz - c.z;
        c.bump.w += (hx * nz - hz * nx) * kick * 0.06;
        if (sup || -vn > 30) {
          c.bump.vy = 6 + Math.min(10, -vn * 0.12);
          c.bump.wp = (Math.random() - 0.5) * 6;
          c.bump.wr = (Math.random() - 0.5) * 8;
          c.y = 0.05;
        }
        const hit = -vn;
        if (hit > 4) {
          // a supersonic demolition barely scratches you (Rocket League rules); a Semi always hurts
          player.hurt(hit * (c.type === 'semi' ? 1.2 : 0.8) * (sup && c.type !== 'semi' ? 0.12 : 1), 0.7);
          player.events.push({ type: 'impact', strength: hit, x: (px + c.x) / 2, y: player.pos.y + 0.7, z: (pz + c.z) / 2 });
        }
        if (sup) player.events.push({ type: 'stunt', name: 'demo' });
      }
    }
  }

  // --- the frame -------------------------------------------------------------------------------

  update(dt, player) {
    this.time += dt;
    const px = player.pos.x, pz = player.pos.z;
    const R = this.R;
    if (!this.started) {
      this.started = true;
      for (const c of this.cars) for (let k = 0; k < 6 && !c.live; k++) this.spawnCar(c, px, pz, 25, R.spawnMax);
      for (const p of this.peds) for (let k = 0; k < 6 && !p.live; k++) this.spawnPed(p, px, pz, 8, R.pedMax);
    }
    // recycle what fell behind; refill a few per frame
    let budget = 6;
    for (const c of this.cars) {
      const far = (c.x - px) ** 2 + (c.z - pz) ** 2 > R.keep * R.keep;
      const stale = c.bump && c.bump.t > 14 && (c.x - px) ** 2 + (c.z - pz) ** 2 > 60 * 60;
      if (c.live && (far || stale)) c.live = false;
      if (!c.live && budget > 0) { budget--; this.spawnCar(c, px, pz, R.spawnMin, R.spawnMax); }
    }
    budget = 6;
    for (const p of this.peds) {
      if (p.live && (p.x - px) ** 2 + (p.z - pz) ** 2 > R.pedKeep * R.pedKeep) p.live = false;
      if (!p.live && budget > 0) { budget--; this.spawnPed(p, px, pz, R.pedMin + 60, R.pedMax); }
    }
    this.updateCars(Math.min(dt, 0.05), player);
    this.updatePeds(Math.min(dt, 0.05), player);
    this.lampT -= dt;
    if (this.lampT <= 0) { this.lampT = 0.25; this.updateLamps(); }
    this.draw();
  }

  draw() {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), s = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    const n = {};
    for (const k of Object.keys(this.vmesh)) n[k] = 0;
    const put = (key, col) => {
      const vm = this.vmesh[key], i = n[key]++;
      vm.paint.setMatrixAt(i, m);
      vm.fixed.setMatrixAt(i, m);
      vm.lights.setMatrixAt(i, m);
      vm.paint.setColorAt(i, col);
    };
    for (const c of this.cars) {
      if (!c.live) continue;
      e.set(c.pitch || 0, c.yaw, c.roll || 0);
      m.compose(pos.set(c.x, c.y, c.z), q.setFromEuler(e), s);
      put(c.type, c.col);
      if (c.type === 'semi' && c.trail) {
        e.set(0, c.tyaw ?? c.yaw, 0);
        m.compose(pos.set(c.tx ?? c.x, c.y, c.tz ?? c.z), q.setFromEuler(e), s);
        put('trailer', c.trailerCol || (c.trailerCol = new THREE.Color(pick(this.models.vehicles.trailer.paints, this.models.vehicles.trailer.weights))));
      }
    }
    for (const [k, vm] of Object.entries(this.vmesh)) {
      for (const im of [vm.paint, vm.fixed, vm.lights]) {
        im.count = n[k];
        im.instanceMatrix.needsUpdate = true;
      }
      if (vm.paint.instanceColor) vm.paint.instanceColor.needsUpdate = true;
    }
    // people and robots: torso and head ride the walk bob, legs swing from the hip, arms from the shoulder
    const H = HUMAN;
    const counts = { p: 0, o: 0 };
    const tq = new THREE.Quaternion(), lq = new THREE.Quaternion(), off = new THREE.Vector3();
    for (const p of this.peds) {
      if (!p.live) continue;
      const M = p.bot ? this.omesh : this.pmesh;
      const i = p.bot ? counts.o++ : counts.p++;
      const walking = p.pause <= 0 && p.hop <= 0 && p.fall <= 0 && p.idle <= 0;
      const sw = walking ? Math.sin(p.phase) * (p.bot ? 0.42 : 0.5) : 0;
      const bob = walking ? Math.abs(Math.cos(p.phase)) * 0.035 : 0;
      const lean = p.fall > 0 ? Math.min(1, p.fall) * 0.9 : 0;
      e.set(lean, p.yaw, 0);
      tq.setFromEuler(e);
      const y = p.hop + bob;
      m.compose(pos.set(p.x, y, p.z), tq, s);
      M.torso.setMatrixAt(i, m);
      M.head.setMatrixAt(i, m);
      if (!p.bot) {
        M.torso.setColorAt(i, p.shirt);
        M.head.setColorAt(i, p.skin);
      }
      for (let k = 0; k < 2; k++) {
        const sgn = k ? 1 : -1;
        // leg
        off.set(sgn * H.hipX, H.hip, 0).applyQuaternion(tq);
        lq.setFromEuler(e.set(lean + sw * sgn, p.yaw, 0));
        m.compose(pos.set(p.x + off.x, y + off.y, p.z + off.z), lq, s);
        M.leg.setMatrixAt(i * 2 + k, m);
        if (!p.bot) M.leg.setColorAt(i * 2 + k, p.pants);
        // arm: opposite to the leg; a waving robot raises its right arm
        let arm = -sw * sgn * 0.8;
        if (p.idle > 0 && k === 1) arm = Math.PI * 0.85 + Math.sin(this.time * 6 + p.id) * 0.25;
        off.set(sgn * H.shoulderX, H.shoulder, 0).applyQuaternion(tq);
        lq.setFromEuler(e.set(lean + arm, p.yaw, 0));
        m.compose(pos.set(p.x + off.x, y + off.y, p.z + off.z), lq, s);
        M.arm.setMatrixAt(i * 2 + k, m);
        if (!p.bot) M.arm.setColorAt(i * 2 + k, p.shirt);
      }
    }
    for (const [M, cnt] of [[this.pmesh, counts.p], [this.omesh, counts.o]]) {
      M.torso.count = M.head.count = cnt;
      M.leg.count = M.arm.count = cnt * 2;
      for (const im of [M.torso, M.head, M.leg, M.arm]) {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
  }
}
