import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { glowSpot } from './textures.js?v=3.9';

// Fuel add-ons. Each one stretches the tank (boost, hover, the landing protocol and the floor
// thrusters all draw less) and changes how the boosters burn. They stack by multiplying:
// purified nitrogen x2, combustion tech x3, rocket fuel x4, so all three give x24.
// For now they are pickups around Chicago; race wins will hand them out through grant().
export const ADDONS = {
  nitrogen: { name: 'Purified nitrogen', short: 'N₂', mult: 2, rank: 1, col: [0.45, 1.6, 2.8], css: '#7fd8ff' },
  combustion: { name: 'Combustion tech', short: 'Combustion', mult: 3, rank: 2, col: [2.8, 1.0, 0.25], css: '#ff8a3a' },
  rocket: { name: 'Rocket fuel', short: 'Rocket', mult: 4, rank: 3, col: [3.0, 2.0, 1.1], css: '#ffd68a' },
};
export const ORDER = ['nitrogen', 'combustion', 'rocket'];

// How the boosters look with the best fuel on board: plume cone (rear / floor), the white-hot core,
// the booster glow, plume length, and the particles behind the car (vapour colour, optional flame).
const LOOKS = {
  base: { rear: [0.9, 1.3, 1.9], down: [0.8, 1.2, 1.7], core: [2.2, 2.4, 2.8], glow: null, len: 1, vapor: [0.9, 0.94, 1, 0.22], fire: null },
  nitrogen: { rear: [0.55, 1.5, 2.7], down: [0.5, 1.35, 2.4], core: [1.8, 2.8, 3.8], glow: [0.35, 0.85, 1], len: 1.1, vapor: [0.78, 0.92, 1.08, 0.26], fire: null },
  combustion: { rear: [1.6, 0.6, 0.16], down: [1.4, 0.55, 0.18], core: [2.2, 1.5, 0.7], glow: [1, 0.42, 0.1], len: 1.3, vapor: [0.42, 0.4, 0.4, 0.28], fire: { col: [1.5, 0.55, 0.12], size: 0.32, speed: 16, rate: 0.7 } },
  rocket: { rear: [1.8, 1.0, 0.35], down: [1.5, 0.85, 0.3], core: [2.6, 2.2, 1.6], glow: [1, 0.72, 0.38], len: 1.7, vapor: [0.55, 0.52, 0.5, 0.28], fire: { col: [1.7, 1.05, 0.45], size: 0.4, speed: 26, rate: 0.85 } },
};

// Seven pickups: three nitrogen at street level (the Bean, Michigan Ave, Navy Pier), combustion tech on a roof and by Union Station,
// rocket fuel on top of Willis Tower and Soldier Field (the car drives up the walls). Positions in
// game metres from chicago.json; roofs are re-read from the collision data when the map loads.
const SPOTS = [
  { id: 'nitrogen', where: 'Cloud Gate in Millennium Park', x: 564, z: 42 },
  { id: 'nitrogen', where: 'Michigan Ave by the Art Institute lions', x: 474, z: 402 },
  { id: 'nitrogen', where: 'Navy Pier', x: 1672, z: -980 },
  { id: 'combustion', where: 'the Chicago Cultural Center roof', x: 414.4, z: -77.9, roof: 31.6 },
  { id: 'combustion', where: 'Union Station on Canal St', x: -789, z: 479 },
  { id: 'rocket', where: 'the top of Willis Tower', x: -489.8, z: 458.6, roof: 442 },
  { id: 'rocket', where: 'the top of Soldier Field', x: 1102.3, z: 2304.3, roof: 30 },
];

const STORE = 'roadster.addons';

export class Addons {
  constructor() {
    this.owned = new Set();
    try {
      for (const id of JSON.parse(localStorage.getItem(STORE) || '[]')) if (ADDONS[id]) this.owned.add(id);
    } catch (_) { /* nothing saved, or storage blocked */ }
    this.items = [];
    this.group = null;
    this.t = 0;
  }

  save() {
    try { localStorage.setItem(STORE, JSON.stringify([...this.owned])); } catch (_) { /* kept for this visit only */ }
  }

  has(id) { return this.owned.has(id); }

  // flight-time multiplier: the product of everything on board
  get mult() {
    let m = 1;
    for (const id of this.owned) m *= ADDONS[id].mult;
    return m;
  }

  // the best fuel on board decides how the boosters look and sound
  get best() {
    let b = null;
    for (const id of ORDER) if (this.owned.has(id)) b = id;
    return b;
  }

  get look() { return LOOKS[this.best || 'base']; }

  grant(id) {
    if (!ADDONS[id] || this.owned.has(id)) return false;
    this.owned.add(id);
    this.save();
    this.refresh();
    return true;
  }

  reset() {
    this.owned.clear();
    this.save();
    this.refresh();
  }

  // where the pickups for the add-ons still missing are, for the pause menu
  missing() {
    return ORDER.filter((id) => !this.owned.has(id)).map((id) => ({ id, ...ADDONS[id], where: SPOTS.filter((s) => s.id === id).map((s) => s.where) }));
  }

  // --- pickups in the world -------------------------------------------------------------------

  attach(scene, world, chicago) {
    if (this.group) {
      this.group.parent?.remove(this.group);
      this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      this.group = null;
    }
    this.items = [];
    if (!chicago) return;
    this.group = new THREE.Group();
    scene.add(this.group);
    const models = buildModels();
    for (const s of SPOTS) {
      // stand on whatever surface is there (a roof, or the street)
      const y = s.roof ? world.groundAt(s.x, s.z, s.roof + 6) : 0;
      const g = new THREE.Group();
      g.position.set(s.x, y, s.z);
      const obj = models[s.id].clone();
      obj.position.y = 1.7;
      const halo = new THREE.Mesh(models.halo, models.haloMat[s.id]);
      halo.position.y = 0.07;
      halo.renderOrder = 4;
      const beam = new THREE.Mesh(models.beam, models.beamMat[s.id]);
      beam.renderOrder = 5;
      g.add(obj, halo, beam);
      this.group.add(g);
      this.items.push({ ...s, y, g, obj, spin: obj.getObjectByName('spin') });
    }
    this.refresh();
  }

  refresh() {
    for (const it of this.items) it.g.visible = !this.owned.has(it.id);
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    for (const it of this.items) {
      if (!it.g.visible) continue;
      it.obj.rotation.y = t * 1.3 + it.x;
      it.obj.position.y = 1.7 + Math.sin(t * 2 + it.z) * 0.15;
      if (it.spin) it.spin.rotation.y = t * 14; // the blades turn about the turbine's axis
    }
  }

  // On-screen markers: the nearest pickup of each add-on still missing, with its distance; pinned
  // to the screen edge, pointing the way, when it's off screen or behind you.
  markers(root, camera, car, show) {
    if (!this.mk) {
      this.mk = {};
      for (const id of ORDER) {
        const el = document.createElement('div');
        el.className = 'fuelMark';
        el.dataset.id = id;
        el.innerHTML = '<i></i><span></span>';
        root.append(el);
        this.mk[id] = { el, label: el.querySelector('span'), arrow: el.querySelector('i'), text: '' };
      }
      this.v3 = new THREE.Vector3();
    }
    const W = innerWidth, H = innerHeight, m = 46;
    for (const id of ORDER) {
      const M = this.mk[id];
      let best = null, bd = Infinity;
      if (show && !this.owned.has(id)) {
        for (const it of this.items) {
          if (it.id !== id) continue;
          const d = Math.hypot(it.x - car.x, it.z - car.z, it.y - car.y);
          if (d < bd) { bd = d; best = it; }
        }
      }
      M.el.hidden = !best || bd < 12;
      if (M.el.hidden) continue;
      const p = this.v3.set(best.x, best.y + 3.5, best.z).project(camera);
      const behind = p.z > 1;
      let sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H;
      if (behind) { sx = W - sx; sy = H - sy; }
      const off = behind || sx < m || sx > W - m || sy < m || sy > H - m;
      let ang = 0;
      if (off) {
        // push the point out along its direction from the screen centre until it meets the edge
        let dx = sx - W / 2, dy = sy - H / 2;
        if (behind && Math.abs(dy) < 1) dy = 1;
        const k = Math.min((W / 2 - m) / Math.max(1e-3, Math.abs(dx)), (H / 2 - m) / Math.max(1e-3, Math.abs(dy)));
        sx = W / 2 + dx * k; sy = H / 2 + dy * k;
        ang = Math.atan2(dy, dx) * 180 / Math.PI + 90;
      }
      // keep the whole label on screen
      const hw = (M.w || 120) / 2 + 8;
      sx = Math.min(W - hw, Math.max(hw, sx));
      M.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      M.el.classList.toggle('off', off);
      M.arrow.style.transform = off ? `rotate(${ang.toFixed(0)}deg)` : '';
      const t = `${ADDONS[id].name} · ${bd < 1000 ? `${Math.round(bd / 10) * 10} m` : `${(bd / 1000).toFixed(1)} km`}${best.y > 20 ? ` · ${Math.round(best.y)} m up` : ''}`;
      if (t !== M.text) { M.text = t; M.label.textContent = t; M.w = M.el.offsetWidth; }
    }
  }

  // the car drove through one: install it (returns the add-on's id)
  collect(pos) {
    for (const it of this.items) {
      if (!it.g.visible) continue;
      if ((it.x - pos.x) ** 2 + (it.z - pos.z) ** 2 < 4.5 * 4.5 && Math.abs(it.y + 1 - pos.y) < 3.5) {
        this.grant(it.id);
        return it;
      }
    }
    return null;
  }
}

// --- models ----------------------------------------------------------------------------------

function buildModels() {
  const metal = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, metalness: 0.75, roughness: 0.28 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24262a, metalness: 0.6, roughness: 0.35 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc8161c, metalness: 0.3, roughness: 0.4 });
  const glow = (c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(...c), toneMapped: false });
  const g = {};

  // purified nitrogen: a cryo canister with frosted blue bands and a valve on top
  {
    const m = new THREE.Group();
    const body = new THREE.Mesh(mergeGeometries([
      new THREE.CylinderGeometry(0.42, 0.42, 1.2, 28),
      new THREE.SphereGeometry(0.42, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.5, 1).translate(0, 0.6, 0),
      new THREE.SphereGeometry(0.42, 28, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(1, 0.5, 1).translate(0, -0.6, 0),
    ]), metal);
    const bands = new THREE.Mesh(mergeGeometries([
      new THREE.CylinderGeometry(0.432, 0.432, 0.09, 28, 1, true).translate(0, 0.34, 0),
      new THREE.CylinderGeometry(0.432, 0.432, 0.09, 28, 1, true).translate(0, -0.34, 0),
      new THREE.CylinderGeometry(0.432, 0.432, 0.32, 28, 1, true),
    ]), glow([0.5, 1.7, 3.0]));
    const valve = new THREE.Mesh(mergeGeometries([
      new THREE.CylinderGeometry(0.07, 0.09, 0.22, 12).translate(0, 0.9, 0),
      new THREE.BoxGeometry(0.34, 0.05, 0.05).translate(0, 1.0, 0),
    ]), dark);
    m.add(body, bands, valve);
    m.scale.setScalar(1.25);
    g.nitrogen = m;
  }

  // combustion tech: a compact turbine on its side, glowing blades spinning inside the intake
  {
    const m = new THREE.Group();
    const casing = new THREE.Mesh(mergeGeometries([
      new THREE.CylinderGeometry(0.56, 0.46, 1.0, 32, 1, true),
      new THREE.TorusGeometry(0.56, 0.08, 10, 32).rotateX(Math.PI / 2).translate(0, 0.5, 0),
      new THREE.TorusGeometry(0.46, 0.06, 10, 32).rotateX(Math.PI / 2).translate(0, -0.5, 0),
    ]), dark);
    casing.material = dark.clone();
    casing.material.side = THREE.DoubleSide;
    const spin = new THREE.Group();
    spin.name = 'spin';
    const blades = [];
    for (let i = 0; i < 11; i++) blades.push(new THREE.BoxGeometry(0.06, 0.48, 0.02).translate(0, 0.27, 0).rotateY(0.5).rotateZ((i / 11) * Math.PI * 2));
    const fan = new THREE.Mesh(mergeGeometries(blades), glow([2.6, 0.95, 0.25]));
    fan.rotation.x = -Math.PI / 2;
    fan.position.y = 0.3;
    const hub = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.36, 16).translate(0, 0.45, 0), metal);
    spin.add(fan);
    const exhaust = new THREE.Mesh(new THREE.CircleGeometry(0.4, 24).rotateX(Math.PI / 2).translate(0, -0.49, 0), glow([3.2, 1.4, 0.35]));
    const axis = new THREE.Group();
    axis.add(casing, spin, hub, exhaust);
    axis.rotation.x = Math.PI / 2; // intake facing forward, exhaust back
    m.add(axis);
    m.scale.setScalar(1.3);
    g.combustion = m;
  }

  // rocket fuel: a white tank with red bands, nose cone, fins and a hot nozzle
  {
    const m = new THREE.Group();
    const body = new THREE.Mesh(mergeGeometries([
      new THREE.CylinderGeometry(0.34, 0.34, 1.3, 24),
      new THREE.ConeGeometry(0.34, 0.55, 24).translate(0, 0.925, 0),
    ]), metal);
    const bands = new THREE.Mesh(mergeGeometries([
      new THREE.CylinderGeometry(0.345, 0.345, 0.12, 24, 1, true).translate(0, 0.42, 0),
      new THREE.CylinderGeometry(0.345, 0.345, 0.12, 24, 1, true).translate(0, -0.3, 0),
    ]), red);
    const fins = [];
    for (let i = 0; i < 4; i++) fins.push(new THREE.BoxGeometry(0.04, 0.45, 0.3).translate(0, -0.48, 0.42).rotateY((i * Math.PI) / 2));
    const finMesh = new THREE.Mesh(mergeGeometries(fins), red);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.26, 0.28, 20, 1, true).translate(0, -0.79, 0), dark.clone());
    bell.material.side = THREE.DoubleSide;
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.7, 16).rotateX(Math.PI).translate(0, -1.2, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.6, 2.4, 1.0), toneMapped: false, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.add(body, bands, finMesh, bell, flame);
    m.scale.setScalar(1.3);
    m.position.y = 0.3;
    g.rocket = m;
  }

  // a glowing pool on the ground and a light beam you can see over the rooftops
  g.halo = new THREE.PlaneGeometry(11, 11).rotateX(-Math.PI / 2);
  const beam = new THREE.CylinderGeometry(1.5, 0.7, 420, 16, 12, true).translate(0, 212, 0);
  // fade the beam out toward the top (additive, so black is invisible)
  const pos = beam.attributes.position;
  const cols = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const f = Math.max(0, 1 - (pos.getY(i) - 2) / 420) ** 1.2;
    cols[i * 3] = cols[i * 3 + 1] = cols[i * 3 + 2] = f;
  }
  beam.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.beam = beam;
  g.haloMat = {};
  g.beamMat = {};
  for (const id of ORDER) {
    const c = new THREE.Color(...ADDONS[id].col);
    g.haloMat[id] = new THREE.MeshBasicMaterial({ map: glowSpot(), color: c.clone().multiplyScalar(0.45), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    // bright enough to read against a daytime sky (additive, past white, so it blooms)
    g.beamMat[id] = new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(0.9), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  }
  return g;
}
