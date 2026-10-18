import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clamp, damp } from './util.js?v=3.9';

// The driver's seat. A cabin modelled on Tesla's interior photos: the white suede yoke with its
// hexagonal hub, the floating red Track Mode screen right of the yoke on a silver-framed stalk,
// the dark Alcantara dash over carbon fibre, red ambient light in the doors, white seats. The screen
// shows live telemetry and a heading-up map; a small head-up readout sits low on the windshield.
//
// Everything is built in the Roadster GLB's own frame (+x = the car's left, +y up, +z forward) inside
// the chassis, so the cabin rides the body's pitch and roll. Kenny's modelled interior
// (roadster_interior.glb, docs/interior-spec.md) can replace the stand-in through useInterior(),
// keeping the live screen, the steering and the eye point.

const HOLDER = new THREE.Vector3(0, 0.015, 0.174); // where car.js puts the GLB inside the chassis
const EYE = new THREE.Vector3(0.37, 1.02, -0.35);
const YOKE_AT = new THREE.Vector3(0.37, 0.775, 0.21);
const SCREEN_AT = new THREE.Vector3(0.02, 0.885, 0.4);
const HUD_AT = new THREE.Vector3(0.37, 0.925, 0.82);
const RED = '#ff2b20', RED_MID = 'rgba(255,43,32,0.62)', RED_DIM = 'rgba(255,43,32,0.36)', RED_FAINT = 'rgba(255,43,32,0.14)', HOT = '#ffd9d2';
const FONT = '"Saira Condensed", "Arial Narrow", sans-serif';

// a basis whose +z points along dir with +y kept as close to up as possible
function facing(dir) {
  const z = dir.clone().normalize();
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

export class Cockpit {
  constructor(car, roads) {
    this.car = car;
    this.group = new THREE.Group();
    this.group.position.copy(HOLDER);
    this.group.visible = false;
    this.group.userData.noHide = true; // car.js hides the procedural car when the GLB loads; not this
    car.chassis.add(this.group);
    this.eye = EYE.clone();
    this.mats = materials();
    this.yokeAngle = 0;
    this.g = { x: 0, z: 0, prev: null, trail: [] };
    this.t = 0;
    this.drawT = 0;
    this.hudT = 0;
    this.roads = prepRoads(roads || []);
    this.makeDisplays();
    this.cabin = this.buildCabin();
    this.yoke = this.buildYoke();
    this.screenParts = this.buildScreen();
    this.group.add(this.cabin, this.yoke.pivot, this.screenParts, this.hudMesh);
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  }

  setVisible(on) {
    if (on === this.group.visible) return;
    this.group.visible = on;
    if (on && !this.tint && this.car.model) this.buildTint();
    if (this.tint) this.tint.visible = on;
  }

  get visible() { return this.group.visible; }

  eyeWorld(out) {
    this.group.updateWorldMatrix(true, false);
    return this.group.localToWorld(out.copy(this.eye));
  }

  setNight(level) {
    this.mats.ambient.color.setRGB(0.32 + level * 1.2, 0.012 + level * 0.04, 0.01 + level * 0.03);
  }

  // --- the live displays -----------------------------------------------------------------------

  makeDisplays() {
    const mk = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      return { c, ctx: c.getContext('2d'), tex };
    };
    this.scr = mk(1024, 640);
    this.hud = mk(512, 196);
    this.screenMat = new THREE.MeshBasicMaterial({ map: this.scr.tex, toneMapped: false });
    this.hudMat = new THREE.MeshBasicMaterial({ map: this.hud.tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.1), this.hudMat);
    this.hudMesh.position.copy(HUD_AT);
    this.hudMesh.quaternion.copy(facing(EYE.clone().sub(HUD_AT)));
    this.hudMesh.renderOrder = 6;
    this.bg = this.screenBackground();
  }

  screenBackground() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 640;
    const x = c.getContext('2d');
    x.fillStyle = '#060101';
    x.fillRect(0, 0, 1024, 640);
    x.fillStyle = 'rgba(255,40,30,0.06)';
    for (let i = 8; i < 1024; i += 16) for (let j = 8; j < 640; j += 16) x.fillRect(i, j, 1.6, 1.6);
    x.strokeStyle = RED_FAINT;
    x.lineWidth = 2;
    const box = (l, t, w, h) => { x.beginPath(); x.roundRect(l, t, w, h, 6); x.stroke(); };
    for (let k = 0; k < 5; k++) box(16, 58 + k * 70, 284, 62);   // left column
    box(312, 58, 288, 342);                                      // speed + g-meter
    box(612, 58, 396, 342);                                      // map
    box(16, 412, 584, 108);                                      // thruster
    box(16, 530, 584, 94);                                       // fuel
    box(612, 412, 396, 212);                                     // session
    x.strokeStyle = RED_DIM;
    x.beginPath(); x.moveTo(16, 48); x.lineTo(1008, 48); x.stroke();
    return c;
  }

  drawScreen(d) {
    const x = this.scr.ctx;
    x.drawImage(this.bg, 0, 0);
    x.textBaseline = 'alphabetic';
    const text = (s, px, py, size, col = RED, weight = 700, align = 'left') => {
      x.font = `${weight} ${size}px ${FONT}`;
      x.fillStyle = col;
      x.textAlign = align;
      x.fillText(s, px, py);
    };
    const bar = (l, t, w, f, col = RED) => {
      x.fillStyle = RED_FAINT; x.fillRect(l, t, w, 8);
      x.fillStyle = col; x.fillRect(l, t, w * clamp(f, 0, 1), 8);
    };
    // top bar: gear, session, time of day
    const gear = d.mph < 0.5 ? 'P' : d.reverse ? 'R' : 'D';
    ['P', 'R', 'N', 'D'].forEach((g, i) => text(g, 24 + i * 26, 36, 26, g === gear ? HOT : RED_DIM, 800));
    text(d.race ? `LAP ${d.race.lap}/${d.race.laps}  ·  ${d.race.time}  ·  POS ${d.race.pos}/${d.race.of}` : `FREE ROAM  ·  SCORE ${d.score}`, 512, 36, 26, RED, 700, 'center');
    text(`${d.tod}  ·  TRACK MODE`, 1000, 36, 22, RED_MID, 600, 'right');
    // left column: what the car is doing
    const rows = [
      ['Accel', `${Math.round(d.throttle * 100)}%`, d.throttle],
      ['Brake', `${Math.round(d.brake * 100)}%`, d.brake],
      ['Fans', d.fans > 0.5 ? 'Max grip' : d.fans > 0.05 ? 'Suction' : 'Standby', d.fans],
      ['Hull', `${d.hull}%`, d.hull / 100],
      ['Altitude', `${d.alt} ft`, Math.min(1, d.alt / 400)],
    ];
    rows.forEach(([k, v, f], i) => {
      const t = 58 + i * 70;
      text(k, 30, t + 30, 22, RED_MID, 600);
      text(v, 286, t + 30, 26, k === 'Hull' && d.hull < 30 ? HOT : RED, 700, 'right');
      bar(30, t + 42, 256, f, k === 'Hull' && d.hull < 30 ? HOT : RED);
    });
    // speed and the g-meter
    text(String(d.mph), 456, 196, 150, d.sonic ? HOT : RED, 800, 'center');
    text(d.sonic ? 'MPH  ·  SUPERSONIC' : 'MPH', 456, 226, 22, RED_MID, 600, 'center');
    const cx = 456, cy = 318, R = 66;
    x.strokeStyle = RED_DIM; x.lineWidth = 2;
    x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.arc(cx, cy, R / 2, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.moveTo(cx - R, cy); x.lineTo(cx + R, cy); x.moveTo(cx, cy - R); x.lineTo(cx, cy + R); x.stroke();
    const gs = R / 2.5; // 2.5 G at the rim
    x.fillStyle = RED_DIM;
    for (const [gx, gz] of this.g.trail) x.fillRect(cx + clamp(gx, -2.5, 2.5) * gs - 1.5, cy - clamp(gz, -2.5, 2.5) * gs - 1.5, 3, 3);
    x.fillStyle = HOT;
    x.beginPath(); x.arc(cx + clamp(this.g.x, -2.5, 2.5) * gs, cy - clamp(this.g.z, -2.5, 2.5) * gs, 6, 0, Math.PI * 2); x.fill();
    text(`${Math.hypot(this.g.x, this.g.z).toFixed(1)} G`, 590, 392, 20, RED_MID, 600, 'right');
    // heading-up map of the streets around the car
    this.drawMap(x, d);
    // thruster tank
    text(`Thruster  ·  ${d.psi.toLocaleString()} PSI`, 30, 446, 26, RED, 700);
    text(d.boosting ? 'Boosting' : d.tank > 0.99 ? '100%  ·  Boost ready' : d.tank < 0.01 ? 'Empty' : `${Math.round(d.tank * 100)}%`, 586, 446, 22, d.boosting ? HOT : RED_MID, 600, 'right');
    x.fillStyle = RED_FAINT; x.fillRect(30, 466, 556, 30);
    const grad = x.createLinearGradient(30, 0, 586, 0);
    grad.addColorStop(0, '#b3140c'); grad.addColorStop(1, d.boosting ? HOT : RED);
    x.fillStyle = grad; x.fillRect(30, 466, 556 * clamp(d.tank, 0, 1), 30);
    // fuel add-ons
    text('Fuel', 30, 566, 22, RED_MID, 600);
    text(d.fuel.length ? d.fuel.map((f) => `${f.name} ×${f.mult}`).join('  ·  ') : 'Cold nitrogen', 96, 566, 24, RED, 700);
    text(d.mult > 1 ? `×${d.mult} flight time` : 'Find add-ons under the light beams', 30, 604, 22, d.mult > 1 ? HOT : RED_DIM, 600);
    // session or race
    const S = d.race ? [['Last lap', d.race.last || '—'], ['Best lap', d.race.best || '—'], ['Gap', d.race.gap || '—'], ['Checkpoint', d.race.cp || '—']]
      : [['Best combo', `×${d.best}`], ['Top speed', `${d.top} mph`], ['Best 0–60', d.sixty], ['Surface', d.surf]];
    text(d.race ? 'Race' : 'Session', 628, 446, 22, RED_MID, 600);
    S.forEach(([k, v], i) => {
      text(k, 628, 488 + i * 36, 24, RED_MID, 600);
      text(String(v), 992, 488 + i * 36, 28, RED, 700, 'right');
    });
    this.scr.tex.needsUpdate = true;
  }

  drawMap(x, d) {
    const L = 612, T = 58, W = 396, H = 342;
    const cx = L + W / 2, cy = T + H * 0.62, k = 0.42; // px per metre (about 940 m across)
    x.save();
    x.beginPath(); x.roundRect(L + 2, T + 2, W - 4, H - 4, 5); x.clip();
    x.translate(cx, cy);
    x.rotate(d.heading + Math.PI); // heading up: the car's forward points to the top
    x.scale(k, k);
    const px = d.x, pz = d.z, rr = 900;
    for (const r of this.roads) {
      if (r.x1 < px - rr || r.x0 > px + rr || r.z1 < pz - rr || r.z0 > pz + rr) continue;
      x.strokeStyle = r.major ? RED_MID : RED_FAINT;
      x.lineWidth = (r.major ? 7 : 4) / (k * 2);
      x.beginPath();
      const p = r.p;
      x.moveTo(p[0][0] - px, p[0][1] - pz);
      for (let i = 1; i < p.length; i++) x.lineTo(p[i][0] - px, p[i][1] - pz);
      x.stroke();
    }
    // fuel add-on beacons still out there
    for (const b of d.beacons) {
      x.fillStyle = b.css;
      x.beginPath(); x.arc(b.x - px, b.z - pz, 9 / k, 0, Math.PI * 2); x.fill();
    }
    x.restore();
    // the car
    x.fillStyle = HOT;
    x.beginPath(); x.moveTo(cx, cy - 13); x.lineTo(cx + 9, cy + 10); x.lineTo(cx, cy + 5); x.lineTo(cx - 9, cy + 10); x.closePath(); x.fill();
    // north marker on the rim
    const a = d.heading + Math.PI; // where world north (-z) ends up on screen
    const nx = cx + Math.sin(-a + Math.PI) * 150, ny = cy + Math.cos(-a + Math.PI) * 150;
    x.font = `700 20px ${FONT}`; x.fillStyle = RED_MID; x.textAlign = 'center';
    x.fillText('N', clamp(nx, L + 16, L + W - 16), clamp(ny + 7, T + 22, T + H - 8));
    x.textAlign = 'left';
    x.fillStyle = RED_MID;
    x.fillText(d.wings, L + 14, T + H - 14);
  }

  drawHud(d) {
    const x = this.hud.ctx;
    x.clearRect(0, 0, 512, 196);
    x.textAlign = 'center';
    x.shadowColor = 'rgba(255,60,40,0.9)';
    x.shadowBlur = 10;
    x.font = `800 112px ${FONT}`;
    x.fillStyle = d.sonic ? '#ffe2da' : '#ff5a44';
    x.fillText(String(d.mph), 200, 112);
    x.shadowBlur = 0;
    x.font = `700 26px ${FONT}`;
    x.fillStyle = '#ff6a55';
    x.textAlign = 'left';
    x.fillText('MPH', 300, 64);
    x.fillText(d.boosting ? 'BOOST' : `${Math.round(d.tank * 100)}%`, 300, 104);
    x.fillStyle = 'rgba(255,60,40,0.25)';
    x.fillRect(96, 140, 320, 10);
    x.fillStyle = d.boosting ? '#ffd2c8' : '#ff4a36';
    x.fillRect(96, 140, 320 * clamp(d.tank, 0, 1), 10);
    if (d.mult > 1) {
      x.font = `700 22px ${FONT}`; x.textAlign = 'center'; x.fillStyle = '#ff6a55';
      x.fillText(`×${d.mult} FLIGHT`, 256, 184);
    }
    this.hud.tex.needsUpdate = true;
  }

  // --- per frame ------------------------------------------------------------------------------

  update(dt, v, d) {
    this.t += dt;
    // the yoke follows the front wheels (steer-by-wire ratio, about 150 degrees each way)
    this.yokeAngle = damp(this.yokeAngle, -v.steerAngle * 5, 16, dt);
    const Y = this.yoke;
    Y.pivot.quaternion.copy(Y.rest).multiply(Y.q.setFromAxisAngle(Y.axis, this.yokeAngle));
    // g-forces in the car's frame: sideways (+ = pushed right) and fore-aft (+ = accelerating)
    const g = this.g;
    if (g.prev && dt > 0) {
      const ax = (v.vel.x - g.prev.x) / dt, ay = (v.vel.y - g.prev.y) / dt, az = (v.vel.z - g.prev.z) / dt;
      const lat = -(ax * v.left.x + ay * v.left.y + az * v.left.z) / 9.81;
      const lon = (ax * v.fwd.x + ay * v.fwd.y + az * v.fwd.z) / 9.81;
      g.x = damp(g.x, clamp(lat, -4, 4), 6, dt);
      g.z = damp(g.z, clamp(lon, -4, 4), 6, dt);
    }
    g.prev = (g.prev || new THREE.Vector3()).copy(v.vel);
    if (this.tint) this.tint.material.uniforms.toCar.value.copy(this.group.matrixWorld).invert();
    if ((this.drawT -= dt) <= 0) {
      this.drawT = 1 / 12;
      g.trail.push([g.x, g.z]);
      if (g.trail.length > 24) g.trail.shift();
      this.drawScreen(d);
    }
    if ((this.hudT -= dt) <= 0) {
      this.hudT = 1 / 20;
      this.drawHud(d);
    }
  }

  // --- geometry -------------------------------------------------------------------------------

  buildCabin() {
    const M = this.mats;
    const g = new THREE.Group();
    g.name = 'standin';
    const add = (geo, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    // dash: a side profile run across the car, Alcantara on top, carbon fibre below
    const prof = new THREE.Shape();
    prof.moveTo(0.42, 0.46);
    prof.lineTo(0.42, 0.785);
    prof.quadraticCurveTo(0.425, 0.838, 0.5, 0.842);
    prof.lineTo(1.1, 0.866);
    prof.lineTo(1.17, 0.845);
    prof.lineTo(1.17, 0.46);
    prof.closePath();
    const dash = new THREE.ExtrudeGeometry(prof, { depth: 1.66, bevelEnabled: false, curveSegments: 8 });
    dash.rotateY(-Math.PI / 2).translate(0.83, 0, 0);
    add(dash, M.alcantara);
    add(new THREE.BoxGeometry(1.62, 0.2, 0.012), M.carbon, 0, 0.57, 0.414);
    // the silver-rimmed opening behind the yoke
    const trap = (inset) => {
      const s = new THREE.Shape();
      const x0 = YOKE_AT.x;
      s.moveTo(x0 - 0.18 + inset, 0.81 - inset);
      s.lineTo(x0 + 0.18 - inset, 0.81 - inset);
      s.lineTo(x0 + 0.12 - inset * 0.7, 0.62 + inset);
      s.lineTo(x0 - 0.12 + inset * 0.7, 0.62 + inset);
      s.closePath();
      return s;
    };
    const ring = trap(0);
    ring.holes.push(trap(0.013));
    add(new THREE.ExtrudeGeometry(ring, { depth: 0.01, bevelEnabled: false }), M.chrome, 0, 0, 0.403);
    add(new THREE.ShapeGeometry(trap(0.013)), M.bezel, 0, 0, 0.41);
    // steering column
    const colGeo = new THREE.CylinderGeometry(0.03, 0.04, 0.28, 16);
    const col = add(colGeo, M.hub);
    col.position.copy(YOKE_AT).lerp(new THREE.Vector3(YOKE_AT.x, 0.72, 0.42), 0.5);
    col.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0.08, -0.26).normalize());
    // centre console and the screen's stalk: a silver frame with Alcantara inside
    add(new RoundedBoxGeometry(0.27, 0.3, 1.3, 3, 0.04), M.carbon, 0, 0.27, -0.3);
    add(new RoundedBoxGeometry(0.22, 0.03, 1.0, 2, 0.012), M.alcantara, 0, 0.43, -0.42);
    add(new RoundedBoxGeometry(0.16, 0.34, 0.03, 3, 0.012), M.chrome, 0.0, 0.6, 0.41);
    add(new RoundedBoxGeometry(0.13, 0.31, 0.03, 3, 0.01), M.alcantara, 0.0, 0.6, 0.402);
    // door cards with the red ambient sweep, and the sills
    for (const s of [1, -1]) {
      add(new RoundedBoxGeometry(0.07, 0.56, 1.9, 3, 0.025), M.alcantara, s * 0.825, 0.58, -0.05);
      add(new RoundedBoxGeometry(0.11, 0.05, 1.7, 3, 0.02), M.alcantara, s * 0.8, 0.865, -0.1);
      add(new RoundedBoxGeometry(0.02, 0.2, 1.5, 2, 0.008), M.carbon, s * 0.788, 0.42, -0.15);
      const sweep = new THREE.CatmullRomCurve3([[0.62, 0.73], [0.1, 0.68], [-0.4, 0.62], [-0.88, 0.53]].map(([z, y]) => new THREE.Vector3(s * 0.786, y, z)));
      add(new THREE.TubeGeometry(sweep, 40, 0.0035, 6), M.ambient);
      // slim A-pillars and roof rails following the inside of the canopy
      const rail = new THREE.CatmullRomCurve3([[0.8, 0.87, 1.1], [0.7, 1.0, 0.82], [0.56, 1.12, 0.35], [0.52, 1.16, -0.2], [0.52, 1.12, -0.8], [0.45, 1.0, -1.4]].map(([x, y, z]) => new THREE.Vector3(s * x, y, z)));
      add(new THREE.TubeGeometry(rail, 48, 0.026, 8), M.alcantara);
    }
    // rear-view mirror pod under the canopy
    add(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 6), M.hub, 0, 1.15, 0.43);
    const pod = add(new RoundedBoxGeometry(0.2, 0.055, 0.035, 2, 0.012), M.hub, 0, 1.11, 0.45);
    pod.rotation.x = 0.25;
    const glass = add(new THREE.PlaneGeometry(0.18, 0.04), M.mirror, 0, 1.11, 0.43);
    glass.rotation.set(0.25, Math.PI, 0);
    // seats
    for (const sx of [EYE.x, -EYE.x]) {
      add(new RoundedBoxGeometry(0.5, 0.12, 0.52, 3, 0.05), M.seat, sx, 0.22, -0.55);
      const back = add(new RoundedBoxGeometry(0.5, 0.72, 0.13, 3, 0.05), M.seat, sx, 0.58, -0.88);
      back.rotation.x = -0.3;
    }
    // floor
    add(new THREE.PlaneGeometry(1.72, 2.4).rotateX(-Math.PI / 2), M.floor, 0, 0.12, 0);
    return g;
  }

  buildYoke() {
    const M = this.mats;
    const pivot = new THREE.Group();
    pivot.name = 'Yoke_Pivot';
    pivot.position.copy(YOKE_AT);
    const rest = facing(EYE.clone().add(new THREE.Vector3(0, -0.12, 0)).sub(YOKE_AT));
    pivot.quaternion.copy(rest);
    pivot.scale.setScalar(0.92);
    const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); pivot.add(m); return m; };
    // the grips: white suede outer bolster, black suede where the hands go, a chrome line between
    const path = (s, dx, sy) => new THREE.CatmullRomCurve3([[0.085, 0.112], [0.14, 0.108], [0.168, 0.07], [0.172, 0], [0.168, -0.07], [0.14, -0.108], [0.085, -0.112]]
      .map(([x, y]) => new THREE.Vector3(s * (x + dx), y * sy, 0)));
    for (const s of [1, -1]) {
      add(new THREE.TubeGeometry(path(s, 0, 1), 32, 0.022, 10), M.suede);
      add(new THREE.TubeGeometry(path(s, -0.03, 0.82), 32, 0.017, 8), M.blackSuede);
      add(new THREE.TubeGeometry(path(s, -0.016, 0.9), 32, 0.004, 6), M.chrome);
      // spokes from the hub to the top and bottom of each grip, and the button bar between
      for (const sy of [1, -1]) {
        const a = new THREE.Vector3(s * 0.05, sy * 0.03, 0.004), b = new THREE.Vector3(s * 0.125, sy * 0.088, 0);
        const spoke = add(new THREE.CylinderGeometry(0.0055, 0.0055, a.distanceTo(b), 8), M.chrome);
        spoke.position.copy(a).lerp(b, 0.5);
        spoke.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      }
      const bar = add(new RoundedBoxGeometry(0.085, 0.032, 0.02, 2, 0.008), M.hub);
      bar.position.set(s * 0.105, 0, 0);
      const wheel = add(new THREE.CylinderGeometry(0.009, 0.009, 0.008, 12), M.chrome);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(s * 0.115, 0, 0.013);
      // gold-tone paddles behind the grips
      const paddle = add(new RoundedBoxGeometry(0.03, 0.075, 0.006, 2, 0.003), M.gold);
      paddle.position.set(s * 0.122, 0.042, -0.035);
      paddle.rotation.z = s * -0.25;
    }
    // hexagonal hub and its badge
    const hub = add(new THREE.CylinderGeometry(0.074, 0.07, 0.045, 6).rotateY(Math.PI / 6), M.hub); // flat top and bottom
    hub.rotation.set(Math.PI / 2, 0, 0);
    const badge = add(new THREE.CylinderGeometry(0.02, 0.02, 0.004, 5), M.chrome);
    badge.rotation.set(Math.PI / 2, 0, 0);
    badge.position.z = 0.024;
    return { pivot, rest, axis: new THREE.Vector3(0, 0, 1), q: new THREE.Quaternion() };
  }

  buildScreen() {
    const g = new THREE.Group();
    g.position.copy(SCREEN_AT);
    g.quaternion.copy(facing(new THREE.Vector3(0.25, 1.0, -0.35).sub(SCREEN_AT)));
    const bezel = new THREE.Mesh(new RoundedBoxGeometry(0.382, 0.246, 0.018, 3, 0.008), this.mats.bezel);
    bezel.position.z = -0.01;
    this.screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.225), this.screenMat);
    this.screenMesh.name = 'Screen_Display';
    g.add(bezel, this.screenMesh);
    return g;
  }

  // From inside, the body's faces point away and vanish: draw them once more from the inside as
  // tinted glass, clear at the windshield and darker toward the roof.
  buildTint() {
    const body = this.car.model?.N?.Body;
    if (!body) return;
    const mesh = body.isMesh ? body : body.getObjectByProperty('isMesh', true);
    if (!mesh) return;
    const mat = new THREE.ShaderMaterial({
      uniforms: { toCar: { value: new THREE.Matrix4() } },
      vertexShader: 'uniform mat4 toCar; varying float vy; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vy = (toCar * w).y; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'varying float vy; void main() { float a = 0.08 + 0.6 * smoothstep(1.0, 1.18, vy); gl_FragColor = vec4(0.012, 0.011, 0.01, a); }',
      transparent: true, depthWrite: false, side: THREE.BackSide,
    });
    this.tint = new THREE.Mesh(mesh.geometry, mat);
    this.tint.renderOrder = 7;
    this.tint.frustumCulled = false;
    mesh.add(this.tint);
  }

  // Kenny's modelled interior: hide the stand-in, take its yoke, screen and eye point.
  useInterior(scene) {
    const N = {};
    scene.traverse((o) => {
      if (o.name) N[o.name] = o;
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        if (o.material?.name === 'AmbientRed') o.material = this.mats.ambient;
      }
    });
    this.group.add(scene);
    this.cabin.visible = false;
    this.group.updateWorldMatrix(true, true);
    if (N.DriverEye) this.eye.copy(this.group.worldToLocal(N.DriverEye.getWorldPosition(new THREE.Vector3())));
    if (N.Yoke_Pivot) {
      this.yoke.pivot.visible = false;
      this.yoke = { pivot: N.Yoke_Pivot, rest: N.Yoke_Pivot.quaternion.clone(), axis: new THREE.Vector3(0, 0, 1), q: new THREE.Quaternion() };
    }
    if (N.Screen_Display) {
      N.Screen_Display.material = this.screenMat;
      this.screenParts.visible = false;
    }
  }
}

function prepRoads(roads) {
  const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);
  const out = [];
  for (const r of roads) {
    if (r.k === 'service' || r.k === 'pedestrian' || !r.p || r.p.length < 2) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of r.p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    out.push({ p: r.p, major: MAJOR.has(r.k), x0, z0, x1, z1 });
  }
  return out;
}

function carbonTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  // a 2x2 twill: diagonal steps of light and dark tows
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const lit = ((i + j) >> 1) % 2 === 0;
    x.fillStyle = lit ? '#2b2c2f' : '#141517';
    x.fillRect(i * 8, j * 8, 8, 8);
    x.fillStyle = lit ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.25)';
    x.fillRect(i * 8, j * 8 + (lit ? 0 : 4), 8, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function materials() {
  return {
    alcantara: new THREE.MeshStandardMaterial({ color: 0x2c2d30, roughness: 0.95 }),
    carbon: new THREE.MeshStandardMaterial({ map: carbonTexture(), roughness: 0.42, metalness: 0.35 }),
    suede: new THREE.MeshStandardMaterial({ color: 0xdedbd6, roughness: 0.95 }),
    blackSuede: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.95 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd9dbde, roughness: 0.16, metalness: 1 }),
    hub: new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: 0.3, metalness: 0.25 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xb59c74, roughness: 0.3, metalness: 0.9 }),
    seat: new THREE.MeshStandardMaterial({ color: 0xe6e3de, roughness: 0.7 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 1 }),
    bezel: new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: 0.3, metalness: 0.4 }),
    mirror: new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.05, metalness: 1 }),
    ambient: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.32, 0.012, 0.01), toneMapped: false }),
  };
}
