import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World, boxRing } from './world.js?v=3.9';
import { asphaltTexture, concreteTexture, glowSpot } from './textures.js?v=3.9';
import { clamp } from './util.js?v=3.9';

// The reveal site: SpaceX's McGregor, Texas test range on the night of 15 October 2026.
// A lit runway for the 0-60 run, the curved wall the car climbed and hung from upside down,
// and the line of Teslas it jumped over (Model 3, Model Y, Semi, Cybertruck, Cybercab).

export const RAMP = { x: 0, z0: 200, R: 14, W: 14, thetaMax: (150 * Math.PI) / 180 };
export const LINEUP = { x: 46, z0: -16, z1: 26, h: 4.2 };

export class Arena extends World {
  constructor(scene) {
    super(scene);
    this.name = 'mcgregor';
    this.buildGround();
    this.buildRamp();
    this.buildLineup();
    this.buildLights();
    this.buildPadsHere();
    this.buildChargers([{ x: -22, z: -70, rot: 0, n: 3 }]);
    this.stunts = { lineup: false };
  }

  floorAt() {
    return 0;
  }

  spawnPoint() {
    return { x: 0, z: -60, heading: 0 };
  }

  buildGround() {
    const tex = asphaltTexture();
    tex.repeat.set(400, 400);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: tex, color: 0x6a6a6c, roughness: 0.95 }));
    ground.receiveShadow = true;
    this.group.add(ground);

    // concrete runway with the start line, from the chargers up to the wall
    const con = concreteTexture(false);
    con.repeat.set(3, 50);
    const runway = new THREE.Mesh(new THREE.PlaneGeometry(26, 320).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: con, color: 0xb8b6b0, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    runway.position.set(0, 0.02, 60);
    runway.receiveShadow = true;
    this.group.add(runway);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const z of [-60, -60 + 11.2]) { // start line and the ~60 mph line for a 0.81 s run
      const l = new THREE.Mesh(new THREE.PlaneGeometry(24, 0.5).rotateX(-Math.PI / 2), lineMat);
      l.position.set(0, 0.05, z);
      this.group.add(l);
    }

    // the red LED strips that framed the show
    const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.12, 0.08), toneMapped: false });
    const strip = new THREE.BoxGeometry(0.25, 0.12, 1);
    const pool = new THREE.MeshBasicMaterial({ map: glowSpot(), color: new THREE.Color(1.2, 0.12, 0.08), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const runs = [];
    // runway edges
    for (const x of [-13.5, 13.5]) runs.push({ x0: x, z0: -100, x1: x, z1: 186 });
    // the lineup platform
    runs.push({ x0: LINEUP.x - 7, z0: LINEUP.z0 - 6, x1: LINEUP.x - 7, z1: LINEUP.z1 + 6 });
    runs.push({ x0: LINEUP.x + 7, z0: LINEUP.z0 - 6, x1: LINEUP.x + 7, z1: LINEUP.z1 + 6 });
    // a long perimeter line in the distance, as in the photos
    runs.push({ x0: -600, z0: -220, x1: 600, z1: -220 });
    runs.push({ x0: -600, z0: 360, x1: 600, z1: 360 });
    const geos = [], pools = [];
    for (const r of runs) {
      const len = Math.hypot(r.x1 - r.x0, r.z1 - r.z0);
      const ang = Math.atan2(r.x1 - r.x0, r.z1 - r.z0);
      const g = strip.clone().scale(1, 1, len).rotateY(ang).translate((r.x0 + r.x1) / 2, 0.08, (r.z0 + r.z1) / 2);
      geos.push(g);
      const n = Math.floor(len / 8);
      for (let i = 0; i <= n; i++) {
        const t = n ? i / n : 0.5;
        pools.push(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2).translate(r.x0 + (r.x1 - r.x0) * t, 0.03, r.z0 + (r.z1 - r.z0) * t));
      }
    }
    this.group.add(new THREE.Mesh(mergeGeometries(geos), red));
    const pm = new THREE.Mesh(mergeGeometries(pools), pool);
    pm.renderOrder = 4;
    this.group.add(pm);

    // distant test stands and tank farms, dark against the sky with aircraft-warning beacons
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.8, metalness: 0.4 });
    const stands = [[-420, 520, 60, 90, 70], [-250, 640, 40, 50, 40], [540, 560, 80, 120, 60], [700, 300, 30, 36, 30], [-700, -100, 24, 70, 24], [600, -500, 50, 60, 50]];
    this.beacons = [];
    const beaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.2, 0.1), toneMapped: false });
    for (const [x, z, w, h, d] of stands) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), steel);
      m.position.set(x, 0, z);
      this.group.add(m);
      const b = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 6), beaconMat);
      b.position.set(x, h + 1.5, z);
      this.group.add(b);
      this.beacons.push(b);
      this.addCollider(boxRing(x, z, w, d), 0, h, 'stand');
    }
    // spherical propellant tanks
    for (const [x, z] of [[-520, 600], [-560, 620], [560, 480]]) {
      const t = new THREE.Mesh(new THREE.SphereGeometry(16, 24, 16), new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.5, metalness: 0.3 }));
      t.position.set(x, 18, z);
      this.group.add(t);
    }
  }

  buildRamp() {
    const { x: rx, z0, R, W, thetaMax } = RAMP;
    const steps = 44;
    const con = concreteTexture(true);
    con.repeat.set(1, 6);
    const surf = new THREE.MeshStandardMaterial({ map: con, color: 0xc4c2bb, roughness: 0.85 });
    // lofted concrete surface
    const pos = [], uv = [], idx = [], nrm = [];
    const cols = 4;
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * thetaMax;
      const y = R * (1 - Math.cos(th)) + 0.01 * Math.cos(th), z = z0 + R * Math.sin(th) - 0.01 * Math.sin(th);
      const nx = 0, ny = Math.cos(th), nz = -Math.sin(th);
      for (let j = 0; j <= cols; j++) {
        const x = rx - W / 2 + (j / cols) * W;
        pos.push(x, y, z);
        nrm.push(nx, ny, nz);
        uv.push(j / cols, (i / steps) * (thetaMax * R) / (W));
      }
    }
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < cols; j++) {
        const a = i * (cols + 1) + j, b = a + cols + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, surf);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.group.add(mesh);

    // the solid body behind the curve: profile in (z, y), extruded across the width
    const shape = new THREE.Shape();
    shape.moveTo(z0, -0.5);
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * thetaMax;
      shape.lineTo(z0 + R * Math.sin(th), R * (1 - Math.cos(th)));
    }
    const topY = R * (1 - Math.cos(thetaMax)), topZ = z0 + R * Math.sin(thetaMax);
    shape.lineTo(topZ, topY + 1.4);
    shape.lineTo(topZ + 4, topY + 1.4);
    shape.lineTo(z0 + R + 3.5, R * 0.9);
    shape.lineTo(z0 + R + 3.5, -0.5);
    shape.closePath();
    const body = new THREE.ExtrudeGeometry(shape, { depth: W + 1.6, bevelEnabled: false });
    // extrude builds in the XY plane along +Z; map (shape x -> world z, shape y -> world y, depth -> world x)
    body.rotateY(-Math.PI / 2);
    body.translate(rx + (W + 1.6) / 2, 0, 0);
    const bodyMesh = new THREE.Mesh(body, new THREE.MeshStandardMaterial({ color: 0x3c3d40, roughness: 0.9 }));
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    this.group.add(bodyMesh);
    // solid back of the wall, kept clear of the car's body samples on the curve
    this.addCollider(boxRing(rx, z0 + R + 3.6, W + 1.6, 2.0), 0, topY + 1.4, 'rampback').noWall = true;

    // red crash padding along both edges and a white centre line
    const red = new THREE.MeshStandardMaterial({ color: 0xd8141c, roughness: 0.8, emissive: 0x4a0407, emissiveIntensity: 0.5 });
    class Arc extends THREE.Curve {
      constructor(x) { super(); this.x = x; }
      getPoint(t, o = new THREE.Vector3()) {
        const th = -0.04 + t * (thetaMax + 0.04);
        return o.set(this.x, R * (1 - Math.cos(th)) + 0.35, z0 + R * Math.sin(th));
      }
    }
    for (const x of [rx - W / 2 - 0.25, rx + W / 2 + 0.25]) {
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new Arc(x), 60, 0.55, 10, false), red);
      tube.castShadow = true;
      this.group.add(tube);
    }
    // scaffold columns under the overhang
    const steel = new THREE.MeshStandardMaterial({ color: 0x55575c, roughness: 0.6, metalness: 0.6 });
    const cols2 = [];
    for (let i = 0; i < 7; i++) {
      const th = ((i + 1) / 8) * thetaMax;
      if (th < Math.PI / 2) continue;
      const y = R * (1 - Math.cos(th)), z = z0 + R * Math.sin(th);
      for (const x of [rx - W / 2 - 1.3, rx + W / 2 + 1.3]) {
        cols2.push(new THREE.BoxGeometry(0.35, y + 2, 0.35).translate(x, (y + 2) / 2, z + 2.5));
      }
    }
    for (const x of [rx - W / 2 - 1.3, rx + W / 2 + 1.3]) {
      cols2.push(new THREE.BoxGeometry(0.35, topY + 3, 0.35).translate(x, (topY + 3) / 2, topZ - 1));
      cols2.push(new THREE.BoxGeometry(0.3, 0.3, 10).translate(x, topY + 2.6, topZ + 3));
    }
    const scaff = new THREE.Mesh(mergeGeometries(cols2), steel);
    scaff.castShadow = true;
    this.group.add(scaff);
    this.rampTop = topY;
  }

  // Curved-wall support and solidity for the vehicle.
  extraSupport(pos, up, out, best, curKind) {
    const { x: rx, z0, R, W, thetaMax } = RAMP;
    if (Math.abs(pos.x - rx) > W / 2 + 0.2) return undefined;
    const dz = pos.z - z0, dy = pos.y - R;
    const th = Math.atan2(dz, -dy);
    if (th < -0.01 || th > thetaMax) return undefined;
    const r = Math.hypot(dz, dy);
    const d = R - r;
    const ny = Math.cos(th), nz = -Math.sin(th);
    const a = up.y * ny + up.z * nz;
    if (a < 0.35 || d < -1.2 || d > 1.0) return undefined;
    // the curve must beat the flat ground where they meet, or the car drives under the concrete
    const score = a * 2 - Math.max(0, d) * 1.5 + 0.6 + (curKind === 'ramp' ? 0.35 : 0);
    if (score <= best) return undefined;
    out.n.set(0, ny, nz);
    out.p.set(pos.x, R * (1 - Math.cos(th)), z0 + R * Math.sin(th));
    out.dist = d;
    out.kind = 'ramp';
    out.c = null;
    return score;
  }

  extraCollide(v) {
    const { x: rx, z0, R, W, thetaMax } = RAMP;
    const pos = v.pos;
    if (Math.abs(pos.x - rx) > W / 2 + 0.8) return;
    const dz = pos.z - z0, dy = pos.y - R;
    const th = Math.atan2(dz, -dy);
    if (th < 0 || th > thetaMax) return;
    const r = Math.hypot(dz, dy);
    if (r <= R + 0.02) return;
    // behind the surface: push back inside the curve
    const ny = Math.cos(th), nz = -Math.sin(th);
    pos.y += ny * (r - R);
    pos.z += nz * (r - R);
    const vn = v.vel.y * ny + v.vel.z * nz;
    if (vn < 0) {
      v.vel.y -= ny * vn * 1.2;
      v.vel.z -= nz * vn * 1.2;
      if (-vn > 5) {
        v.hurt(-vn, 1);
        v.events.push({ type: 'impact', strength: -vn, x: pos.x, y: pos.y, z: pos.z });
      }
    }
  }

  buildLineup() {
    const { x, z0, z1 } = LINEUP;
    const mk = (color, metal = 0.6, rough = 0.35) => new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0c1016, metalness: 0.9, roughness: 0.1 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x0e0e10, roughness: 0.9 });
    const white = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 6.4), toneMapped: false });
    const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.1, 0.08), toneMapped: false });
    const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.24, 18).rotateZ(Math.PI / 2);
    const spots = [];
    const zs = [z0 + 3, z0 + 11, z0 + 21, z0 + 31, z1 + 3];
    const place = (group, zc, w, d, h) => {
      group.position.set(x, 0, zc);
      group.rotation.y = Math.PI / 2; // nose toward -x, facing the runway
      this.group.add(group);
      this.addCollider(boxRing(x, zc, d, w), 0, h, 'tesla');
      spots.push(zc);
    };
    const wheels = (g, L, Wd, r = 0.36) => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const m = new THREE.Mesh(wheel, tyre);
        m.scale.setScalar(r / 0.36);
        m.position.set(sx * (Wd / 2 - 0.05), r, sz * L * 0.32);
        g.add(m);
      }
    };
    const bars = (g, Wd, L, yF, yR) => {
      const f = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.9, 0.05, 0.04), white);
      f.position.set(0, yF, L / 2 + 0.01);
      const r = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.9, 0.06, 0.04), red);
      r.position.set(0, yR, -L / 2 - 0.01);
      g.add(f, r);
    };
    // Model 3 (blue)
    {
      const g = new THREE.Group(), L = 4.72, Wd = 1.85;
      const lower = new THREE.Mesh(new THREE.BoxGeometry(Wd, 0.62, L).translate(0, 0.62, 0), mk(0x1f3f86));
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.86, 0.5, L * 0.5).translate(0, 1.18, -0.25), glass);
      cabin.geometry.scale(1, 1, 1);
      g.add(lower, cabin);
      wheels(g, L, Wd);
      bars(g, Wd, L, 0.78, 0.9);
      place(g, zs[0], Wd, L, 1.44);
    }
    // Model Y (red)
    {
      const g = new THREE.Group(), L = 4.75, Wd = 1.92;
      const lower = new THREE.Mesh(new THREE.BoxGeometry(Wd, 0.75, L).translate(0, 0.72, 0), mk(0xa31418));
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.88, 0.58, L * 0.56).translate(0, 1.35, -0.2), glass);
      g.add(lower, cabin);
      wheels(g, L, Wd);
      bars(g, Wd, L, 0.86, 1.0);
      place(g, zs[1], Wd, L, 1.62);
    }
    // Semi (white)
    {
      const g = new THREE.Group(), L = 7.6, Wd = 2.55;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(Wd, 3.2, 3.4).translate(0, 2.0, 1.9), mk(0xe8e8e6, 0.2, 0.5));
      const win = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.9, 1.1, 0.1).translate(0, 2.7, 3.62), glass);
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.9, 0.9, L).translate(0, 0.85, 0), mk(0x2a2b2e, 0.4, 0.6));
      g.add(cab, win, chassis);
      wheels(g, L * 0.8, Wd, 0.52);
      for (const sx of [-1, 1]) {
        const m = new THREE.Mesh(wheel, tyre);
        m.scale.setScalar(0.52 / 0.36);
        m.position.set(sx * (Wd / 2 - 0.05), 0.52, -3.2);
        g.add(m);
      }
      bars(g, Wd, L, 1.0, 1.2);
      const f = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.8, 0.08, 0.05), white);
      f.position.set(0, 3.55, 3.62);
      g.add(f);
      place(g, zs[2], Wd, L, 4.0);
    }
    // Cybertruck (stainless)
    {
      const g = new THREE.Group(), L = 5.68, Wd = 2.03;
      const geo = new THREE.BufferGeometry();
      const hw = Wd / 2;
      const v = [
        [-hw, 0.5, L / 2], [hw, 0.5, L / 2], [hw, 0.5, -L / 2], [-hw, 0.5, -L / 2],
        [-hw, 1.1, L / 2], [hw, 1.1, L / 2], [hw, 1.35, -L / 2], [-hw, 1.35, -L / 2],
        [-hw * 0.9, 1.9, -0.3], [hw * 0.9, 1.9, -0.3],
      ];
      const tri = [
        0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
        4, 5, 9, 4, 9, 8, 5, 6, 9, 6, 7, 8, 6, 8, 9, 7, 4, 8, 0, 3, 2, 0, 2, 1,
      ];
      const p = [];
      for (const i of tri) p.push(...v[i]);
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      geo.computeVertexNormals();
      const body = new THREE.Mesh(geo, mk(0xb9bcc0, 0.9, 0.3));
      body.material.flatShading = true;
      g.add(body);
      wheels(g, L, Wd, 0.44);
      const f = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.95, 0.05, 0.04), white);
      f.position.set(0, 1.1, L / 2 + 0.01);
      const r = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.95, 0.06, 0.04), red);
      r.position.set(0, 1.33, -L / 2 - 0.01);
      g.add(f, r);
      place(g, zs[3], Wd, L, 1.9);
    }
    // Cybercab (gold)
    {
      const g = new THREE.Group(), L = 4.5, Wd = 1.9;
      const lower = new THREE.Mesh(new THREE.BoxGeometry(Wd, 0.6, L).translate(0, 0.6, 0), mk(0xcaa45a, 0.7, 0.3));
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.9, 0.55, L * 0.55).translate(0, 1.15, -0.2), glass);
      g.add(lower, cabin);
      wheels(g, L, Wd);
      bars(g, Wd, L, 0.75, 0.88);
      place(g, zs[4], Wd, L, 1.5);
    }
    this.lineupZ = spots;
  }

  buildLights() {
    // light towers around the runway, lamps modelled as emissive discs plus two spotlights for the car
    const pole = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.7, metalness: 0.5 });
    const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.6, 4), toneMapped: false });
    const spots = [[-60, -120], [60, -120], [-60, 120], [60, 120], [-60, 250], [60, 250]];
    for (const [x, z] of spots) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 22, 8).translate(0, 11, 0), pole);
      p.position.set(x, 0, z);
      this.group.add(p);
      const head = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 0.6).translate(0, 22, 0), pole);
      head.position.set(x, 0, z);
      head.lookAt(0, 22, z);
      this.group.add(head);
      for (let i = -1; i <= 1; i++) {
        const l = new THREE.Mesh(new THREE.CircleGeometry(0.28, 12), lamp);
        l.position.set(x + (x < 0 ? 0.31 : -0.31), 22, z + i * 0.9);
        l.lookAt(0, 0, z + i * 0.9);
        this.group.add(l);
      }
      this.addCollider(boxRing(x, z, 0.8, 0.8), 0, 22, 'pole').noWall = true;
    }
    this.spot = [];
    for (const [x, z, tx, ty, tz, power] of [[-60, -120, 0, 0, -60, 2600], [60, 120, 0, 0, 60, 2600], [-60, 250, 0, 14, 210, 5200], [60, 250, 0, 14, 210, 5200]]) {
      const s = new THREE.SpotLight(0xfff1dc, power, 520, 0.6, 0.5, 1.3);
      s.position.set(x, 22, z);
      s.target.position.set(tx, ty, tz);
      this.group.add(s, s.target);
      this.spot.push(s);
    }
    // a soft fill so the wall and the lineup read at night
    const fill = new THREE.HemisphereLight(0x5a6a90, 0x1a1410, 0.5);
    this.group.add(fill);
  }

  buildPadsHere() {
    const list = [];
    for (const [x, z] of [[-30, 60], [30, 60], [-30, -40], [30, -40], [0, 140], [-20, -120]]) list.push({ x, y: 0, z, big: true });
    for (let z = -90; z <= 170; z += 26) for (const x of [-11, 11]) list.push({ x, y: 0, z, big: false });
    for (const [x, z] of [[-45, 0], [45, -40], [45, 50], [-45, 100], [0, -150], [80, 0], [-80, 60], [0, 250], [-30, 200], [30, 200]]) list.push({ x, y: 0, z, big: false });
    this.buildPads(list);
  }

  // Demo-specific stunt checks, called from the main loop.
  check(v) {
    const ev = [];
    const { x, z0, z1, h } = LINEUP;
    if (!v.grounded && Math.abs(v.pos.x - x) < 7 && v.pos.z > z0 - 4 && v.pos.z < z1 + 8 && v.pos.y > h && !this.stunts.lineup) {
      this.stunts.lineup = true;
      ev.push({ type: 'stunt', name: 'lineup' });
    }
    if (v.grounded && v.sup.kind === 'ground' && this.stunts.lineup && v.pos.z < z0 - 30) this.stunts.lineup = false;
    return ev;
  }

  update(dt, t) {
    super.update(dt, t);
    const blink = Math.sin(t * 2.2) > 0.6;
    for (const b of this.beacons) b.visible = blink;
  }

  nearestRoad(x, z) {
    return { x: clamp(x, -60, 60), z: clamp(z, -140, 180), heading: 0 };
  }
}
