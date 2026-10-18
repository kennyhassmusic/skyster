// The street network from chicago.json: intersections, one-way and two-way edges with lanes, the
// real traffic signals and stop signs, lane geometry, nearest-edge lookups and shortest routes.
// Used by city traffic and pedestrians, and by the race mode.

export const SPEED = { motorway: 24, trunk: 17, primary: 12.5, secondary: 12, tertiary: 11, residential: 8.5, unclassified: 8.5 };

export class RoadNet {
  constructor(net) {
    this.kinds = net.k;
    this.nodes = net.n;
    const N = net.n.length;
    this.out = Array.from({ length: N }, () => []);   // traversals a car may start from each node
    this.walk = Array.from({ length: N }, () => []);  // every traversal, for pedestrians
    this.inc = Array.from({ length: N }, () => []);
    this.edges = net.e.map(([a, b, k, w, lanes, ow, br, flat, core], i) => {
      const n = flat.length / 2;
      const pts = Float32Array.from(flat);
      const cum = new Float32Array(n);
      for (let j = 1; j < n; j++) cum[j] = cum[j - 1] + Math.hypot(pts[j * 2] - pts[j * 2 - 2], pts[j * 2 + 1] - pts[j * 2 - 1]);
      const kind = net.k[k];
      const nl = ow ? Math.max(1, lanes) : Math.max(1, Math.floor(lanes / 2));
      const lw = Math.min(3.4, (ow ? w : w / 2) / nl);
      const e = { i, a, b, kind, w, lanes, ow: !!ow, br: !!br, pts, cum, len: cum[n - 1], core: !!core, nl, lw, speed: SPEED[kind] || 9 };
      this.inc[a].push(e);
      this.inc[b].push(e);
      if (core) {
        this.out[a].push({ e, d: 1 });
        if (!ow) this.out[b].push({ e, d: -1 });
      }
      this.walk[a].push({ e, d: 1 });
      this.walk[b].push({ e, d: -1 });
      return e;
    });
    this.signals = new Set(net.s);
    this.stops = new Set(net.t);
    // OpenStreetMap often maps one junction of a wide street as several signalled nodes a few metres
    // apart: they share one controller (same timing, same axes), and a car between them is inside the
    // junction and doesn't stop again
    this.sigGroup = new Map();
    const sig = [...this.signals];
    const parent = new Map(sig.map((v) => [v, v]));
    const find = (v) => { while (parent.get(v) !== v) { parent.set(v, parent.get(parent.get(v))); v = parent.get(v); } return v; };
    for (let i = 0; i < sig.length; i++) {
      const [ax, az] = net.n[sig[i]];
      for (let j = i + 1; j < sig.length; j++) {
        const [bx, bz] = net.n[sig[j]];
        if ((ax - bx) ** 2 + (az - bz) ** 2 < 45 * 45) parent.set(find(sig[i]), find(sig[j]));
      }
    }
    for (const v of sig) this.sigGroup.set(v, find(v));
    // how far back from the junction centre a car stops: clear of the widest street crossing it
    this.clear = new Float32Array(N);
    for (let v = 0; v < N; v++) {
      let m = 0;
      for (const e of this.inc[v]) m = Math.max(m, e.w / 2);
      this.clear[v] = Math.min(14, Math.max(4, m + 2.5));
    }
    // each junction's reference direction, to split its approaches into two signal phases
    this.ref = new Float32Array(N);
    const t = {};
    for (let v = 0; v < N; v++) {
      const e = this.inc[v][0];
      if (!e) continue;
      this.tangent(e, e.a === v ? 1 : -1, 0, t);
      this.ref[v] = Math.atan2(t.tx, t.tz);
    }
    // a coarse grid of edge samples for nearest-street lookups and spawning
    this.cell = 60;
    this.grid = new Map();
    const p = {};
    for (const e of this.edges) {
      for (let s = 0; s <= e.len; s += 20) {
        this.pointAt(e, 1, Math.min(s, e.len), 0, p);
        const k = this.key(p.x, p.z);
        let c = this.grid.get(k);
        if (!c) this.grid.set(k, (c = []));
        if (c[c.length - 1] !== e) c.push(e);
      }
    }
  }

  key(x, z) {
    return Math.floor(x / this.cell) * 100000 + Math.floor(z / this.cell);
  }

  start(e, d) { return d > 0 ? e.a : e.b; }
  end(e, d) { return d > 0 ? e.b : e.a; }

  // lateral offset of a lane's centre, to the right of the direction of travel
  laneOff(e, lane) {
    return e.ow ? (lane - (e.nl - 1) / 2) * e.lw : (lane + 0.5) * e.lw + 0.15;
  }

  // the polyline segment holding distance u (measured along the stored direction)
  seg(e, u) {
    const c = e.cum;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= u) lo = mid; else hi = mid;
    }
    return lo;
  }

  tangent(e, d, s, out) {
    const u = d > 0 ? s : e.len - s;
    const j = this.seg(e, Math.max(0, Math.min(e.len, u)));
    const p = e.pts;
    let tx = p[j * 2 + 2] - p[j * 2], tz = p[j * 2 + 3] - p[j * 2 + 1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    if (d < 0) { tx = -tx; tz = -tz; }
    out.tx = tx; out.tz = tz;
    return out;
  }

  // position s metres along a traversal, offset to the right of travel by off
  pointAt(e, d, s, off, out) {
    s = Math.max(0, Math.min(e.len, s));
    const u = d > 0 ? s : e.len - s;
    const j = this.seg(e, u);
    const p = e.pts;
    const sl = e.cum[j + 1] - e.cum[j] || 1;
    const f = (u - e.cum[j]) / sl;
    let tx = p[j * 2 + 2] - p[j * 2], tz = p[j * 2 + 3] - p[j * 2 + 1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    if (d < 0) { tx = -tx; tz = -tz; }
    out.x = p[j * 2] + (p[j * 2 + 2] - p[j * 2]) * f - tz * off;
    out.z = p[j * 2 + 1] + (p[j * 2 + 3] - p[j * 2 + 1]) * f + tx * off;
    out.tx = tx; out.tz = tz;
    return out;
  }

  // signal state for a car arriving along heading h at junction v: 'g', 'y' or 'r'
  signal(v, h, time) {
    const g = this.sigGroup.get(v) ?? v;
    let a = Math.abs(((h - this.ref[g]) % Math.PI + Math.PI) % Math.PI);
    const axis = a > Math.PI / 4 && a < (3 * Math.PI) / 4 ? 1 : 0;
    const cyc = 32, t = (time + ((g * 2654435761) % 1000) / 1000 * cyc) % cyc;
    if (axis === 0) return t < 13 ? 'g' : t < 16 ? 'y' : 'r';
    return t < 16 ? 'r' : t < 29 ? 'g' : t < 32 ? 'y' : 'r';
  }

  // an edge inside one signalled junction (both ends on the same controller): no stopping on it
  inside(e) {
    const ga = this.sigGroup.get(e.a), gb = this.sigGroup.get(e.b);
    return ga !== undefined && ga === gb && e.len < 60;
  }

  // nearest edge to a point (optionally filtered), with the distance along it
  nearest(x, z, filter, out = {}) {
    let best = Infinity;
    const p = {};
    out.e = null;
    for (let r = 0; r <= 3 && !out.e; r++) {
      const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
      for (let ix = cx - r; ix <= cx + r; ix++) for (let iz = cz - r; iz <= cz + r; iz++) {
        const c = this.grid.get(ix * 100000 + iz);
        if (!c) continue;
        for (const e of c) {
          if (filter && !filter(e)) continue;
          const pts = e.pts;
          for (let j = 0; j < pts.length / 2 - 1; j++) {
            const ax = pts[j * 2], az = pts[j * 2 + 1], dx = pts[j * 2 + 2] - ax, dz = pts[j * 2 + 3] - az;
            const l2 = dx * dx + dz * dz || 1;
            const f = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
            const d2 = (ax + dx * f - x) ** 2 + (az + dz * f - z) ** 2;
            if (d2 < best) { best = d2; out.e = e; out.s = e.cum[j] + f * Math.sqrt(l2); out.dist = Math.sqrt(d2); }
          }
        }
      }
    }
    return out;
  }

  // shortest drive from node a to node b over the connected core, as traversals [{e, d}]
  route(a, b) {
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), via = new Array(N);
    const [bx, bz] = this.nodes[b];
    const h = (v) => Math.hypot(this.nodes[v][0] - bx, this.nodes[v][1] - bz);
    const open = [[h(a), a]];
    g[a] = 0;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, v] = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (v === b) break;
      for (const t of this.out[v]) {
        const w = this.end(t.e, t.d), c = g[v] + t.e.len;
        if (c < g[w]) { g[w] = c; from[w] = v; via[w] = t; open.push([c + h(w), w]); }
      }
    }
    if (!isFinite(g[b])) return null;
    const path = [];
    for (let v = b; v !== a; v = from[v]) path.push(via[v]);
    return path.reverse();
  }
}
