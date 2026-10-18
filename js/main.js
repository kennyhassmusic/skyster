import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { City } from './city.js?v=3.9';
import { Arena } from './arena.js?v=3.9';
import { Roadster } from './car.js?v=3.9';
import { Vehicle, P } from './vehicle.js?v=3.9';
import { Input } from './input.js?v=3.9';
import { CameraRig } from './camera.js?v=3.9';
import { Atmosphere, TIMES } from './atmosphere.js?v=3.9';
import { Particles, Trail, Debris, SpeedShader } from './fx.js?v=3.9';
import { Sound } from './audio.js?v=3.9';
import { glowSpot } from './textures.js?v=3.9';
import { clamp, damp } from './util.js?v=3.9';
import { Recorder } from './telemetry.js?v=3.9';
import { Traffic } from './traffic.js?v=3.9';
import { Addons, ADDONS, ORDER } from './addons.js?v=3.9';
import { Cockpit } from './cockpit.js?v=3.9';

const BUILD = '3.9';

const $ = (id) => document.getElementById(id);
const ui = {
  title: $('title'), start: $('startBtn'), status: $('loadStatus'), hud: $('hud'), pause: $('pause'),
  speed: $('speed'), surf: $('surfChip'), tod: $('todChip'), sixty: $('sixtyChip'), sonic: $('sonic'),
  boostFill: $('boostFill'), psi: $('psi'), j1: $('j1'), j2: $('j2'),
  hull: $('hull'), hullFill: $('hullFill'), hullPct: $('hullPct'), hullState: $('hullState'),
  alt: $('altBox'), altVal: $('altVal'), toast: $('toast'), hint: $('hint'), demo: $('demo'), dead: $('dead'), deadSub: $('deadSub'),
  combo: $('combo'), comboMult: $('comboMult'), comboScore: $('comboScore'), comboMoves: $('comboMoves'), comboBar: $('comboBar'), scoreVal: $('scoreVal'), bestVal: $('bestVal'),
  padMon: $('padMon'), board: $('board'), boardScore: $('boardScore'), boardBest: $('boardBest'), boardTop: $('boardTop'), boardSixty: $('boardSixty'), boardPad: $('boardPad'), boardMoves: $('boardMoves'),
  mapBtn: $('mapBtn'), timeBtn: $('timeBtn'), layoutBtn: $('layoutBtn'), soundBtn: $('soundBtn'),
  mapChicago: $('mapChicago'), mapArena: $('mapArena'),
  photoBtn: $('photoBtn'), photoKey: $('photoKey'), photoKeySave: $('photoKeySave'), photoKeyForget: $('photoKeyForget'), photoNote: $('photoNote'),
  gattr: $('gattr'), gattrLogo: $('gattrLogo'), gattrText: $('gattrText'),
  cluster: document.querySelector('.cluster'), fuelChips: $('fuelChips'), fuelBtn: $('fuelBtn'), fuelNote: $('fuelNote'),
};

// --- renderer and post-processing -----------------------------------------------

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const maxRatio = Math.min(window.devicePixelRatio || 1, 1.5);
let pixelRatio = maxRatio;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.3, 26000);
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
composer.setPixelRatio(pixelRatio);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.55, 2);
composer.addPass(bloom);
const speedPass = new ShaderPass(SpeedShader);
composer.addPass(speedPass);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

function setPixelRatio(r) {
  pixelRatio = r;
  renderer.setPixelRatio(r);
  composer.setPixelRatio(r);
  composer.setSize(innerWidth, innerHeight);
}

// --- world -----------------------------------------------------------------------

const input = new Input(canvas);
const sound = new Sound();
const rec = new Recorder(10, 90);
const addons = new Addons(); // fuel add-ons: tank multipliers and their pickups (js/addons.js)

// Flight recorder: F9, the pause menu, or an explosion sends the last 90 s to the artifact's
// database, where Claude can read it. Outside claude.ai there is no database: the dump is
// still available as __game.replay() for a local build.
async function sendReplay(reason) {
  if (performance.now() / 1000 - rec.lastSend < 15) { toast('Replay already sent', 'wait a few seconds'); return; }
  rec.mark(reason);
  const meta = { build: BUILD, reason, map: mapName, layout: input.layout, bumpers: input.bumpers, pitchStick: input.pitchStick, axisFaulty: input.cal.faulty.slice(), axisSnaps: input.cal.snaps.slice(), device: input.device, pad: input.padName?.() || '', padInfo: input.padInfo?.() || null, photoreal: photoActive(), at: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) };
  const dump = rec.dump(meta);
  let db = null;
  try { db = window.claude?.use ? await window.claude.use('db') : null; } catch (_) { db = null; }
  if (!db) {
    console.log('replay', dump);
    toast('Replay kept locally', 'open the game at claude.ai to send it to Claude');
    return;
  }
  try {
    const id = `r${Date.now()}`;
    await db.collection('replays').doc(id).set(dump);
    rec.lastSend = performance.now() / 1000;
    toast('Replay sent to Claude', `${reason} · last ${Math.round(dump.until - dump.since)} s of inputs and physics`);
  } catch (err) {
    console.error(err);
    toast('Replay could not be sent', err?.code || err?.message || 'unknown error');
  }
}
const atmo = new Atmosphere(scene, renderer);
let world, car, vehicle, rig, vapor, sparks, fire, trails, blob, debris, flash;
let mapName = 'chicago';
let cityData = null;
let traffic = null; // city traffic, people and Optimus (js/traffic.js); Chicago only
let cockpit = null; // the driver's seat for the cockpit camera (js/cockpit.js)
let state = 'loading';
let timeIndex = 0;
let menuIndex = 0;
let toastTimer = 0;
let lastDevice = '';
let deathTimer = 0;
let timeScale = 1;
let hurtFlash = 0;
let whiteFlash = 0;
let lastSixty = null;
let buzzT = 0;
let flightTip = -99;
const demoDone = { wall: false, launch: false, kickflip: false, parallel: false, lineup: false, sixty: false };
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3();

const STUNT_NAMES = {
  lineup: ['Over the lineup', 'Model 3 · Model Y · Semi · Cybertruck · Cybercab'],
  supersonic: ['Supersonic', '217+ mph'],
  demo: ['Demolition', 'a supersonic hit'],
};
const MOVE_NAMES = {
  barrelroll: 'Barrel roll', backflip: 'Backflip', frontflip: 'Front flip', spin: '360', wallride: 'Wall ride', inverted: 'Inverted hold',
  hover: 'Hover', walllaunch: 'Wall launch', walltowall: 'Wall to wall', flipreset: 'Flip reset', wavedash: 'Wave dash', parallel: 'Parallel park',
  bigair: 'Big air', highflyer: 'High flyer', lineup: 'Over the lineup',
};
const DEMO_MAP = { wallride: 'wall', inverted: 'wall', walllaunch: 'launch', kickflip: 'kickflip', parallel: 'parallel', lineup: 'lineup' };

// "Barrel roll ×2 · Backflip · Wall ride"
function moveList(moves) {
  const out = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    if (last && last.name === m) last.n++;
    else out.push({ name: m, n: 1 });
  }
  return out.map((o) => (MOVE_NAMES[o.name] || o.name) + (o.n > 1 ? ` ×${o.n}` : '')).join(' · ');
}

let comboHide = 0;
function showCombo(moves, running, mult) {
  ui.combo.hidden = false;
  ui.comboMult.textContent = `×${mult}`;
  ui.comboScore.textContent = running.toLocaleString();
  ui.comboMoves.textContent = moveList(moves);
  ui.combo.classList.remove('pop');
  void ui.combo.offsetWidth;
  ui.combo.classList.add('pop');
  comboHide = 0;
}

function toast(text, sub) {
  rec.event('toast', sub ? `${text} — ${sub}` : text);
  ui.toast.innerHTML = '';
  ui.toast.append(text);
  if (sub) {
    const s = document.createElement('small');
    s.textContent = sub;
    ui.toast.append(s);
  }
  ui.toast.classList.add('show');
  toastTimer = 2.2;
}

async function init() {
  ui.status.textContent = 'Loading Chicago map data…';
  cityData = await fetch('chicago.json?v=3.4').then((r) => {
    if (!r.ok) throw new Error(`chicago.json: HTTP ${r.status}`);
    return r.json();
  });
  ui.status.textContent = `Raising ${cityData.buildings.length.toLocaleString()} buildings…`;
  await new Promise((r) => setTimeout(r, 30));
  car = new Roadster();
  scene.add(car.root);
  // Kenny's Roadster model; until it loads (or if it can't), the procedural car drives
  car.loadModel(`./roadster-model.js?v=${BUILD}`).catch((err) => console.warn('roadster model', err));
  cockpit = new Cockpit(car, cityData.roads);
  car.cockpit = cockpit;
  vehicle = new Vehicle(null);
  rig = new CameraRig(camera, null);
  vapor = new Particles(scene, 2600, false);
  sparks = new Particles(scene, 900, true);
  fire = new Particles(scene, 600, true);
  debris = new Debris(scene, null);
  trails = [new Trail(scene, new THREE.Color(3.2, 0.12, 0.08), 0.05), new Trail(scene, new THREE.Color(3.2, 0.12, 0.08), 0.05)];
  // soft contact shadow that stays on the surface under the car
  blob = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 5.4).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glowSpot(), color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }));
  blob.renderOrder = 4;
  scene.add(blob);
  flash = new THREE.PointLight(0xffb070, 0, 60, 1.5);
  scene.add(flash);
  loadWorld('chicago');
  applyFuel();
  ui.status.textContent = `${cityData.buildings.length.toLocaleString()} buildings from Overture Maps and OpenStreetMap · ready`;
  ui.start.disabled = false;
  ui.start.textContent = 'Start';
  state = 'title';
}

function loadWorld(name) {
  if (world) world.dispose();
  if (traffic) { traffic.dispose(); traffic = null; }
  mapName = name;
  world = name === 'arena' ? new Arena(scene) : new City(scene, cityData);
  if (name !== 'arena' && cityData.net) {
    // traffic is extra: if it ever fails to start, the city still loads without it
    try { traffic = new Traffic(scene, world, cityData); } catch (err) { console.error('traffic', err); traffic = null; }
  }
  addons.attach(scene, world, name !== 'arena');
  vehicle.setWorld(world);
  rig.setWorld(world);
  debris.setWorld(world);
  debris.clear();
  const sp = world.spawnPoint();
  vehicle.spawn(sp.x, sp.z, sp.heading);
  vehicle.boost = 100;
  car.revive();
  syncCar();
  rig.snap(vehicle);
  if (name === 'arena') {
    atmo.set('night', world, car);
    bloom.threshold = atmo.preset.bloom / atmo.preset.exposure;
    ui.tod.textContent = 'McGregor, TX · night';
    for (const k in demoDone) demoDone[k] = false;
    for (const d of ui.demo.querySelectorAll('div')) d.classList.remove('done');
  } else setTime(timeIndex);
  ui.demo.hidden = name !== 'arena';
  ui.sixty.hidden = name !== 'arena';
  ui.timeBtn.disabled = name === 'arena';
  ui.mapBtn.textContent = `Map: ${name === 'arena' ? 'McGregor demo' : 'Downtown Chicago'}`;
  ui.mapChicago.setAttribute('aria-pressed', String(name !== 'arena'));
  ui.mapArena.setAttribute('aria-pressed', String(name === 'arena'));
  lastSixty = null;
  ui.sixty.querySelector('b').textContent = '—';
  applyPhotoreal();
}

function setTime(i) {
  timeIndex = (i + TIMES.length) % TIMES.length;
  const label = atmo.set(TIMES[timeIndex], world, car);
  bloom.threshold = atmo.preset.bloom / atmo.preset.exposure;
  ui.tod.textContent = label;
  traffic?.setNight(atmo.preset.night || 0);
  cockpit?.setNight(atmo.preset.night || 0);
  photo.layer?.setTime(TIMES[timeIndex]);
  ui.timeBtn.textContent = `Time of day: ${label}`;
  return label;
}

// Fuel add-ons: the tank multiplier, the plume look and sound, the HUD chips and the menu line.
function applyFuel() {
  vehicle.fuelMult = addons.mult;
  car.setFuel(addons.look);
  sound.setFuel(addons.best ? ADDONS[addons.best].rank : 0);
  ui.cluster.dataset.fuel = addons.best || '';
  ui.fuelChips.replaceChildren();
  for (const id of ORDER) {
    if (!addons.has(id)) continue;
    const c = document.createElement('i');
    c.dataset.id = id;
    c.textContent = ADDONS[id].short;
    ui.fuelChips.append(c);
  }
  const m = document.createElement('b');
  m.textContent = `×${addons.mult} flight`;
  ui.fuelChips.append(m);
  ui.fuelChips.hidden = addons.mult === 1;
  const owned = ORDER.filter((id) => addons.has(id)).map((id) => ADDONS[id].short);
  ui.fuelBtn.textContent = owned.length
    ? `Fuel add-ons: ${owned.join(' + ')} · flight time ×${addons.mult} · press to remove (testing)`
    : 'Fuel add-ons: none yet (plain cold nitrogen, ×1)';
  const miss = addons.missing();
  ui.fuelNote.textContent = miss.length
    ? `To find (follow the coloured light beams): ${miss.map((a) => `${a.name} ×${a.mult} at ${a.where.join(' or ')}`).join(' · ')}. They stack: all three is ×24.`
    : 'All three on board: ×24 flight time. Later, race wins will hand these out.';
}

// what the cockpit's Track Mode screen and head-up readout show
function cockpitData() {
  const v = vehicle;
  return {
    mph: Math.round(v.speed * 2.23694), sonic: v.speed > P.SUPERSONIC, reverse: v.grounded && v.vel.dot(v.fwd) < -0.5,
    throttle: input.s.throttle || 0, brake: input.s.brake || 0, fans: v.fans || 0, hull: Math.round(v.health),
    alt: Math.max(0, Math.round((v.pos.y - v.groundY) * 3.28084)), tank: v.boost / 100, psi: Math.round(v.boost * 100), boosting: v.boosting,
    tod: ui.tod.textContent, score: v.cb.total.toLocaleString(), best: v.cb.best, top: Math.round(topMph),
    sixty: bestSixty === null ? '—' : `${bestSixty.toFixed(2)} s`, surf: ui.surf.textContent,
    fuel: ORDER.filter((id) => addons.has(id)).map((id) => ADDONS[id]), mult: addons.mult,
    x: v.pos.x, z: v.pos.z, heading: v.heading,
    beacons: addons.items.filter((i) => i.g.visible).map((i) => ({ x: i.x, z: i.z, css: ADDONS[i.id].css })),
    wings: `Rear wing ${(car.S.ext || 0) > 0.5 ? 'up' : 'down'}  ·  front wing ${(car.S.fw || 0) > 0.5 ? 'air brake' : 'low drag'}${v.flying ? '  ·  flight mode' : ''}`,
    race: null,
  };
}

function fuelPickup(it) {
  const a = ADDONS[it.id];
  vehicle.boost = 100;
  applyFuel();
  toast(`${a.name} installed`, `flight time ×${a.mult}${addons.mult > a.mult ? ` · ×${addons.mult} with everything on board` : ''} · tank full`);
  sound.charge();
  sound.ding(true);
  input.rumble(0.6, 0.9, 420);
  burstSparks(it.x, it.y + 1.8, it.z, 140, a.col[0], a.col[1], a.col[2], 16);
  flash.position.set(it.x, it.y + 2, it.z);
  flash.intensity = 1500;
  rec.event('addon', it.id);
}

function syncCar() {
  car.root.position.copy(vehicle.pos);
  car.root.quaternion.copy(vehicle.q);
  car.root.updateMatrixWorld(true);
}

function startGame() {
  if (state !== 'title') return;
  sound.start();
  state = 'play';
  ui.title.hidden = true;
  ui.hud.hidden = false;
  car.startup();
  rig.snap(vehicle);
  if (mapName === 'chicago' && addons.missing().length) setTimeout(() => toast('Fuel add-ons to find', 'follow the coloured light beams and the markers on screen'), 1800);
  canvas.focus();
  input.capture();
  if (input.device !== 'pad') canvas.requestPointerLock?.();
}

// Live view of the pad while paused: raw stick values, what the calibration makes of them, and
// the pitch / yaw / roll the car would get. The place to look when a stick seems ignored.
function padMonitor() {
  const pi = input.padInfo();
  if (!pi) { ui.padMon.textContent = 'Controller: none seen yet · press a button on it'; return; }
  const r = input.raw || {};
  const f = (n) => ((n || 0) >= 0 ? '+' : '') + (+n || 0).toFixed(2);
  const yNote = pi.dead[1] ? 'retired, reads full travel at rest' : pi.faulty[1] ? (input.cal.masked[1] ? 'glitch reading, dropped' : 'glitchy axis, this reading used') : 'ok';
  const src = { auto: 'left stick' + (pi.dead[1] || pi.faulty[1] ? ' (not reporting), so D-pad up/down and the right stick' : ''), left: 'left stick only', right: 'right stick', dpad: 'D-pad' }[input.pitchStick];
  ui.padMon.textContent = `${input.padName()}: left stick x ${f(r.lx)} y ${f(r.ly)} (${yNote}) · right stick x ${f(r.rx)} y ${f(r.ry)} · car gets pitch ${f(input.s.pitch)} yaw ${f(input.s.yaw)} roll ${f(input.s.roll)} · pitch from ${src} · glitch snaps seen on left y: ${pi.snaps[1]} · direct read: ${pi.hid ? `raw ${pi.hid.raw} → ${f(pi.hid.y)} (${pi.hid.reports} reports)` : 'off'}`;
}

function pause(on) {
  state = on ? 'pause' : 'play';
  ui.pause.hidden = !on;
  menuIndex = 0;
  if (on) {
    // the flight recorder only reaches Claude inside claude.ai; elsewhere (the public site) it's hidden
    $('replayBtn').hidden = !window.claude?.use;
    input.release();
    focusMenu();
  }
  else { input.capture(); canvas.focus(); if (input.device !== 'pad') canvas.requestPointerLock?.(); }
}

const menuButtons = () => [...ui.pause.querySelectorAll('button')].filter((b) => !b.disabled);
function focusMenu() {
  const b = menuButtons();
  b[menuIndex]?.focus();
}

ui.start.addEventListener('click', startGame);
ui.mapChicago.addEventListener('click', () => { if (mapName !== 'chicago') loadWorld('chicago'); });
ui.mapArena.addEventListener('click', () => { if (mapName !== 'arena') loadWorld('arena'); });
$('resumeBtn').addEventListener('click', () => pause(false));
ui.mapBtn.addEventListener('click', () => { loadWorld(mapName === 'arena' ? 'chicago' : 'arena'); toast(mapName === 'arena' ? 'McGregor, Texas' : 'Downtown Chicago'); });
ui.timeBtn.addEventListener('click', () => setTime(timeIndex + 1));
ui.layoutBtn.addEventListener('click', () => {
  input.layout = input.layout === 'rl' ? 'classic' : 'rl';
  ui.layoutBtn.textContent = `Keyboard: ${input.layout === 'rl' ? 'Rocket League (mouse jump/boost)' : 'Classic (Space jump, Shift boost, Ctrl slide)'}`;
  lastDevice = '';
});
ui.soundBtn.addEventListener('click', toggleSound);
ui.fuelBtn.addEventListener('click', () => {
  if (addons.mult === 1) { toast('No add-ons yet', 'follow the coloured light beams around Chicago'); return; }
  addons.reset();
  applyFuel();
  toast('Fuel add-ons removed', 'the pickups are back around the city');
});
$('replayBtn').addEventListener('click', () => { pause(false); sendReplay('menu'); });
const PITCH_LABEL = { auto: 'Air pitch: left stick (right stick fills in if the left glitches)', left: 'Air pitch: left stick only (RL default)', right: 'Air pitch: right stick up / down', dpad: 'Air pitch: D-pad up / down (kickflip · park on keys 1 · 2)' };
$('pitchBtn').addEventListener('click', () => {
  input.pitchStick = { auto: 'left', left: 'right', right: 'dpad', dpad: 'auto' }[input.pitchStick] || 'auto';
  $('pitchBtn').textContent = PITCH_LABEL[input.pitchStick];
});
$('bumpersBtn').addEventListener('click', () => {
  input.bumpers = input.bumpers === 'rl' ? 'roll' : 'rl';
  $('bumpersBtn').textContent = input.bumpers === 'rl' ? 'Bumpers: RB rear view · LB scoreboard (RL default); LB in the air is flight mode' : 'Bumpers: LB flight mode (hold, in the air) · RB air roll right';
  lastDevice = '';
});
$('rollAssistBtn').addEventListener('click', () => {
  vehicle.rollAssist = !vehicle.rollAssist;
  $('rollAssistBtn').textContent = vehicle.rollAssist ? 'Roll assist: on (let go of air roll and the wheels come down)' : 'Roll assist: off (pure Rocket League air roll)';
});
$('hidBtn').addEventListener('click', async () => {
  const r = await input.connectHid();
  if (r.ok) toast('Direct controller read on', `${r.name} · stick Y from report ${r.field.reportId}, ${r.field.size} bits · watch the monitor line`);
  else toast('Direct read not possible here', r.why);
  lastDevice = '';
});
$('calBtn').addEventListener('click', () => {
  if (input.recalibrate()) toast('Controller recalibrated', `rest ${input.padInfo().rest.join(' / ')}`);
  else toast('No controller seen yet', 'press a button on it first');
});

let topMph = 0, bestSixty = null;
function updateBoard(show) {
  ui.board.hidden = !show;
  if (!show) return;
  ui.boardScore.textContent = vehicle.cb.total.toLocaleString();
  ui.boardBest.textContent = `×${vehicle.cb.best}`;
  ui.boardTop.textContent = `${Math.round(topMph)} mph`;
  ui.boardSixty.textContent = bestSixty === null ? '—' : `${bestSixty.toFixed(2)} s`;
  const pi = input.padInfo();
  ui.boardPad.textContent = pi ? `${input.padName()} · ${pi.mapping || 'raw'} · rest ${pi.rest.join('/')}${pi.dead.some(Boolean) ? ' · axis ignored' : ''}` : 'keyboard · mouse';
  ui.boardMoves.textContent = vehicle.cb.active ? `Chain: ${moveList(vehicle.cb.moves)}` : 'No chain running';
}
$('fullBtn').addEventListener('click', () => {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else el.requestFullscreen?.().catch(() => toast('Full screen is not available here'));
});
addEventListener('pointerdown', () => sound.ctx && sound.ctx.resume?.(), { passive: true });
addEventListener('keydown', () => sound.ctx && sound.ctx.resume?.());

function toggleSound() {
  sound.setMuted(!sound.muted);
  ui.soundBtn.textContent = `Sound: ${sound.muted ? 'off' : 'on'}`;
  return sound.muted;
}

// --- Photoreal Chicago -------------------------------------------------------------------------
// Google's Photorealistic 3D Tiles as an opt-in look for the Chicago map (js/photoreal.js, loaded on
// first use). The player brings their own Maps Platform key; it lives only in this browser's storage
// and is sent only to Google's tile server. The layer only draws: the car keeps colliding with the
// open-data footprints. Off on every page load, so each billable 3D Tiles session is a deliberate click.

const KEY_STORE = 'roadster.mapsKey';
const TILES_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const photo = { layer: null, wanted: false, state: 'off', key: '', logo: '', attrT: 0, cspBlocked: false };
try { photo.key = localStorage.getItem(KEY_STORE) || ''; } catch (_) { photo.key = ''; }
document.addEventListener('securitypolicyviolation', (e) => { if (/googleapis\.com/.test(e.blockedURI || '')) photo.cspBlocked = true; });

const photoActive = () => !!(photo.wanted && photo.layer && mapName === 'chicago');

// Can this page reach Google at all? A request without a key is free (Google answers 403); the
// claude.ai artifact sandbox refuses the connection outright.
async function googleReachable() {
  try { await fetch(TILES_ROOT, { cache: 'no-store', credentials: 'omit' }); return true; } catch (_) { return false; }
}

function photoNote(state, text = '') {
  photo.state = state;
  const saved = photo.key ? ` Your key (…${photo.key.slice(-4)}) is saved in this browser only.` : '';
  ui.photoNote.dataset.s = state;
  ui.photoNote.textContent = {
    off: photo.key
      ? `Turn it on to stream Google's photorealistic 3D city. Collisions keep using the open-data footprints.${saved}`
      : "Needs your own Google Maps Platform API key with the Map Tiles API turned on; Google bills each 3D Tiles session past its monthly free allowance. The key stays in this browser and goes only to Google.",
    needkey: 'Paste your API key above and press Save first. It needs the Map Tiles API turned on in Google Cloud.',
    connecting: 'Connecting to Google…',
    blocked: "This page can't reach Google's tile server: claude.ai artifacts block connections to other sites. Photoreal works when the game runs from its own web address, such as a local server.",
    error: text,
    on: "On. City imagery and 3D: Google Maps. The car, PSI tokens and Superchargers are the game's own; collisions use the open-data footprints.",
    arena: 'Photoreal is on for the Downtown Chicago map; switch maps to see it.',
  }[state] ?? text;
  ui.photoKey.placeholder = photo.key ? `Key saved (…${photo.key.slice(-4)}) · paste to replace` : 'Paste key (AIza…)';
  ui.photoBtn.textContent = `Photoreal Chicago (Google): ${state === 'connecting' ? 'connecting…' : photo.wanted ? 'on' : 'off'}`;
  ui.photoBtn.setAttribute('aria-pressed', String(photo.wanted));
}

function applyPhotoreal() {
  const on = photoActive();
  photo.layer?.setVisible(on);
  world.setPhotoreal?.(on);
  document.body.classList.toggle('photoreal', on);
  ui.gattr.hidden = !on;
  // the contact shadow lies on the photographed road, which can sit a few cm above the flat game ground
  blob.material.polygonOffset = on;
  blob.material.polygonOffsetFactor = -2;
  blob.material.polygonOffsetUnits = -8;
  if (photo.wanted && (photo.state === 'on' || photo.state === 'arena')) photoNote(mapName === 'chicago' ? 'on' : 'arena');
}

function dropPhotoreal() {
  photo.wanted = false;
  applyPhotoreal();
  const layer = photo.layer;
  photo.layer = null;
  if (layer) setTimeout(() => layer.dispose(), 0);
}

function photoStatus(s) {
  if (s.state === 'error') {
    dropPhotoreal();
    if (photo.cspBlocked) { photoNote('blocked'); return; }
    const hint = s.status === 400 ? ' Check that the whole key was pasted.'
      : s.status === 403 ? " In Google Cloud: turn on the Map Tiles API for the key's project, check that billing is on, and allow this site's address in the key's restrictions."
      : s.status === 429 ? ' The key has hit its quota for now.' : '';
    photoNote('error', s.google ? `Google refused the key: ${s.text}${hint}` : `Couldn't load Google's 3D tiles: ${s.text}`);
  } else if (s.state === 'on') photoNote(!photo.wanted ? 'off' : mapName === 'chicago' ? 'on' : 'arena');
  else photoNote(s.state, s.text);
}

async function togglePhotoreal() {
  if (photo.busy) return;
  if (photo.wanted) { photo.wanted = false; applyPhotoreal(); photoNote('off'); return; }
  if (!photo.key) { photoNote('needkey'); ui.photoKey.focus(); return; }
  photo.wanted = true;
  if (!photo.layer) {
    photoNote('connecting');
    photo.busy = true;
    try {
      if (!(await googleReachable())) { photo.wanted = false; photoNote('blocked'); return; }
      const mod = await import(`./photoreal.js?v=${BUILD}`);
      ui.gattrLogo.src = mod.LOGO;
      photo.layer = new mod.Photoreal({ scene, renderer, camera, key: photo.key, onStatus: photoStatus });
      photo.layer.setTime(atmo.name);
    } catch (err) {
      console.error(err);
      photo.wanted = false;
      photoNote('error', `The 3D Tiles library didn't load: ${err.message}`);
      return;
    } finally {
      photo.busy = false;
    }
  } else photoNote(mapName === 'chicago' ? 'on' : 'arena');
  applyPhotoreal();
}

// A public 3D Tiles set instead of Google (no key, no geo-alignment): checks loading, priority and
// frame time while no key is at hand.
async function testPhotoreal(url) {
  const mod = await import(`./photoreal.js?v=${BUILD}`);
  if (photo.layer) photo.layer.dispose();
  ui.gattrLogo.src = mod.LOGO;
  photo.layer = new mod.Photoreal({ scene, renderer, camera, test: url, onStatus: photoStatus });
  photo.layer.setTime(atmo.name);
  photo.wanted = true;
  applyPhotoreal();
  return photo.layer;
}

function saveKey() {
  const k = ui.photoKey.value.trim();
  if (!k) { photoNote('needkey'); return; }
  if (k !== photo.key && photo.layer) dropPhotoreal();
  photo.key = k;
  let kept = true;
  try { localStorage.setItem(KEY_STORE, k); } catch (_) { kept = false; }
  ui.photoKey.value = '';
  photoNote('off');
  if (!kept) ui.photoNote.textContent += " This browser won't keep it after a reload.";
  if (!/^AIza[0-9A-Za-z_-]{35}$/.test(k)) ui.photoNote.textContent += " That doesn't look like a Google API key (they start with AIza and are 39 characters long).";
}

function forgetKey() {
  photo.key = '';
  try { localStorage.removeItem(KEY_STORE); } catch (_) { /* nothing stored */ }
  dropPhotoreal();
  ui.photoKey.value = '';
  photoNote('off');
}

function photoFrame(dt) {
  if (!photoActive()) return;
  photo.layer.update(dt, vehicle);
  if ((photo.attrT -= dt) <= 0) {
    photo.attrT = 0.5;
    const t = photo.layer.attributions();
    if (ui.gattrText.textContent !== t) ui.gattrText.textContent = t;
  }
}

ui.photoBtn.addEventListener('click', togglePhotoreal);
ui.photoKeySave.addEventListener('click', saveKey);
ui.photoKeyForget.addEventListener('click', forgetKey);
// typed characters belong to the field, not the game (input.js swallows WASD, Space and the arrows)
ui.photoKey.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); saveKey(); }
  if (e.key === 'Escape') ui.photoKey.blur();
});
ui.photoKey.addEventListener('keyup', (e) => e.stopPropagation());
photoNote('off');

function respawn(quiet) {
  const r = world.nearestRoad(vehicle.pos.x, vehicle.pos.z, ['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);
  vehicle.spawn(r.x, r.z, r.heading);
  car.revive();
  syncCar();
  rig.snap(vehicle);
  debris.clear();
  ui.dead.classList.remove('show');
  if (!quiet) toast(mapName === 'arena' ? 'Back on the strip' : 'Back on the street');
}

// --- effects -----------------------------------------------------------------------

function nozzleWorld(n, out) {
  return n.group.getWorldPosition(out);
}

function dustRing(strength, n) {
  const count = Math.min(60, 10 + strength * 2);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const s = 4 + strength * 0.4;
    tmp.copy(vehicle.left).multiplyScalar(Math.cos(a) * 1.4).addScaledVector(vehicle.fwd, Math.sin(a) * 2.2);
    tmp2.copy(tmp).normalize().multiplyScalar(s).addScaledVector(n, 0.6);
    vapor.emit(vehicle.pos.x + tmp.x + n.x * 0.2, vehicle.pos.y + tmp.y + n.y * 0.2, vehicle.pos.z + tmp.z + n.z * 0.2,
      tmp2.x, tmp2.y, tmp2.z, 1.1, 0.8, 2.6, 0.75, 0.72, 0.68, 0.3, 2.5);
  }
}

function burstSparks(x, y, z, n, r, g, b, speed) {
  for (let i = 0; i < n; i++) {
    sparks.emit(x, y, z, (Math.random() - 0.5) * speed, Math.random() * speed * 0.6, (Math.random() - 0.5) * speed,
      0.35 + Math.random() * 0.35, 0.09, 0, r, g, b, 1, 1.5, 18);
  }
}

function explode() {
  const p = vehicle.pos;
  sound.explode();
  input.rumble(1, 1, 900);
  rig.bump(1.2);
  whiteFlash = 1;
  timeScale = 0.3;
  flash.position.set(p.x, p.y + 1, p.z);
  flash.intensity = 4000;
  // fireball, then smoke
  for (let i = 0; i < 260; i++) {
    const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI, s = 4 + Math.random() * 16;
    fire.emit(p.x, p.y + 0.8, p.z, Math.cos(a) * Math.sin(e) * s, Math.abs(Math.cos(e)) * s + 4, Math.sin(a) * Math.sin(e) * s,
      0.5 + Math.random() * 0.9, 1.2 + Math.random(), 7, 3.5, 1.4 + Math.random(), 0.3, 1, 2.2, 2);
  }
  for (let i = 0; i < 180; i++) {
    const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 9;
    vapor.emit(p.x, p.y + 1, p.z, Math.cos(a) * s, 3 + Math.random() * 8, Math.sin(a) * s,
      2.5 + Math.random() * 2.5, 1.5, 3.5, 0.12, 0.11, 0.1, 0.8, 1.2, -0.5);
  }
  burstSparks(p.x, p.y + 1, p.z, 160, 4, 2.4, 0.9, 26);
  // parts fly
  for (const part of car.shed()) {
    tmp.copy(part.local).applyQuaternion(vehicle.q).add(p);
    tmp2.copy(part.local).setY(0).normalize().multiplyScalar(6 + Math.random() * 10).applyQuaternion(vehicle.q);
    tmp2.y += 9 + Math.random() * 10;
    tmp2.add(vehicle.vel);
    part.mesh.quaternion.copy(vehicle.q);
    debris.throw(part.mesh, tmp, tmp2, tmp3.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12));
  }
  deathTimer = 3.4;
  ui.deadSub.textContent = 'Thrusters offline · respawning';
  ui.dead.classList.add('show');
}

function handleEvents() {
  const events = vehicle.events.concat(world.check ? world.check(vehicle) : []);
  for (const e of events) {
    if (e.type !== 'touchdown' || e.vn > 3) {
      rec.event(e.type, e.name || e.result || e.kind || (e.strength !== undefined ? Math.round(e.strength) : e.amount !== undefined ? Math.round(e.amount) : e.t !== undefined ? +e.t.toFixed(2) : ''));
    }
    switch (e.type) {
      case 'jump':
        sound.pop(0.6);
        input.rumble(0.3, 0.5, 120);
        break;
      case 'doublejump':
        sound.pop(0.5);
        input.rumble(0.2, 0.4, 90);
        break;
      case 'dodge':
        sound.pop(1);
        input.rumble(0.35, 0.6, 140);
        break;
      case 'righted':
        sound.pop(0.8);
        break;
      case 'land':
        rig.bump(clamp(e.strength / 28, 0.08, 1));
        car.land(e.strength);
        dustRing(e.strength, vehicle.sup.n);
        sound.thump(e.strength);
        input.rumble(clamp(e.strength / 30, 0.2, 1), 0.4, 220);
        break;
      case 'impact':
        rig.bump(clamp(e.strength / 30, 0.1, 1));
        burstSparks(e.x, e.y, e.z, Math.min(50, 8 + e.strength), 4, 2.2, 0.6, 9);
        sound.thump(e.strength);
        input.rumble(clamp(e.strength / 25, 0.2, 1), 0.6, 180);
        break;
      case 'damage':
        hurtFlash = Math.min(1, hurtFlash + e.amount / 40);
        break;
      case 'flight':
        if (performance.now() / 1000 - flightTip > 25) {
          flightTip = performance.now() / 1000;
          toast('Flight mode', 'stick turns and climbs · RT thrust · LT air brake · B boost · let go of LB to drop');
        }
        break;
      case 'landing':
        toast('Landing protocol', 'wheels down, nose along the travel, thrusters braking the fall');
        break;
      case 'explode':
        explode();
        setTimeout(() => sendReplay('explosion'), 400);
        break;
      case 'wallride':
        sound.pop(0.3);
        break;
      case 'pad':
        sound.ding(e.big);
        burstSparks(vehicle.pos.x, vehicle.pos.y + 0.8, vehicle.pos.z, e.big ? 60 : 18, 1.5, 2.6, 3.4, e.big ? 10 : 6);
        if (e.big) toast('Tank full', '10,000 psi');
        break;
      case 'charge':
        sound.charge();
        burstSparks(vehicle.pos.x, vehicle.pos.y + 1, vehicle.pos.z, 50, 0.8, 3, 1.2, 7);
        toast('Supercharged', 'hull +35%');
        break;
      case 'move':
        showCombo(e.moves, e.running, e.mult);
        sound.beep(520 + Math.min(e.mult, 8) * 60, 0.07, 0.05);
        input.rumble(0.2, 0.5, 90);
        break;
      case 'combo':
        if (e.result === 'landed') {
          toast(`+${e.score.toLocaleString()}`, `combo ×${e.mult} · ${moveList(e.moves)}`);
          sound.ding(e.mult >= 3);
          input.rumble(0.5, 0.8, 260);
        } else if (e.moves.length > 1) {
          toast('Combo dropped', moveList(e.moves));
        }
        ui.scoreVal.textContent = e.total.toLocaleString();
        ui.bestVal.textContent = `×${vehicle.cb.best}`;
        comboHide = 1.6;
        break;
      case 'stunt': {
        const n = STUNT_NAMES[e.name];
        if (n) toast(n[0], n[1]);
        if (e.name === 'lineup') { vehicle.addMove('lineup'); showCombo(vehicle.cb.moves, vehicle.cb.score * vehicle.cb.mult, vehicle.cb.mult); }
        const key = DEMO_MAP[e.name];
        if (key && mapName === 'arena' && !demoDone[key]) {
          if (e.name === 'wallride') break; // the wall box needs the inverted hold too
          demoDone[key] = true;
          ui.demo.querySelector(`[data-k="${key}"]`)?.classList.add('done');
          if (Object.values(demoDone).every(Boolean)) setTimeout(() => toast('Show complete', 'every demo move landed'), 2400);
        }
        break;
      }
      case 'sixty':
        lastSixty = e.t;
        if (bestSixty === null || e.t < bestSixty) bestSixty = e.t;
        ui.sixty.querySelector('b').textContent = `${e.t.toFixed(2)} s`;
        if (mapName === 'arena') {
          toast(`0–60 in ${e.t.toFixed(2)} s`, e.t < 1 ? 'Thrust trim pace (Tesla: 0.81 s)' : 'use boost with the throttle for under a second');
          if (e.t < 1 && !demoDone.sixty) {
            demoDone.sixty = true;
            ui.demo.querySelector('[data-k="sixty"]')?.classList.add('done');
          }
        }
        break;
    }
  }
}

function emitContinuous(dt) {
  const J = vehicle.jets;
  const alive = vehicle.alive;
  // rear plumes: cold nitrogen, straight back along the car
  // (fuel add-ons tint the vapour; combustion tech and rocket fuel add a flame)
  if (alive && J.rear > 0.05) {
    tmp2.copy(vehicle.fwd).negate();
    const look = addons.look, [vr, vg, vb, va] = look.vapor, fl = look.fire;
    for (const n of car.rearNozzles) {
      if (fl && Math.random() < J.rear * fl.rate) {
        nozzleWorld(n, tmp);
        const s = fl.speed * (0.7 + Math.random() * 0.6);
        fire.emit(tmp.x, tmp.y, tmp.z, tmp2.x * s + vehicle.vel.x * 0.92 + (Math.random() - 0.5), tmp2.y * s + vehicle.vel.y * 0.92 + (Math.random() - 0.5),
          tmp2.z * s + vehicle.vel.z * 0.92 + (Math.random() - 0.5), 0.14 + Math.random() * 0.12, fl.size, 2.2, fl.col[0], fl.col[1], fl.col[2], 1, 1.2, 0);
      }
      if (Math.random() > J.rear * 1.3) continue;
      nozzleWorld(n, tmp);
      const s = 12 + Math.random() * 9;
      vapor.emit(tmp.x, tmp.y, tmp.z, tmp2.x * s + vehicle.vel.x * 0.75 + (Math.random() - 0.5) * 2, tmp2.y * s + vehicle.vel.y * 0.75 + (Math.random() - 0.3) * 1.5,
        tmp2.z * s + vehicle.vel.z * 0.75 + (Math.random() - 0.5) * 2, 0.7 + Math.random() * 0.5, 0.35, 3.5, vr, vg, vb, va, 2.5);
    }
  }
  // floor nozzles: down along the car's own up axis
  if (alive) {
    tmp2.copy(vehicle.up).negate();
    car.downNozzles.forEach((n, i) => {
      const k = J.down[i];
      if (k < 0.08 || Math.random() > k * 0.9) return;
      nozzleWorld(n, tmp);
      const s = 8 + k * 8 + Math.random() * 4;
      vapor.emit(tmp.x, tmp.y, tmp.z, tmp2.x * s + vehicle.vel.x * 0.5 + (Math.random() - 0.5) * 2.5, tmp2.y * s + vehicle.vel.y * 0.5 + (Math.random() - 0.5) * 2,
        tmp2.z * s + vehicle.vel.z * 0.5 + (Math.random() - 0.5) * 2.5, 0.7 + Math.random() * 0.6, 0.4, 3.2, 0.9, 0.94, 1, 0.26, 2.2);
    });
  }
  // tyre smoke under powerslide and heavy braking
  const smoking = alive && vehicle.grounded && ((vehicle.drifting && vehicle.speed > 9) || (vehicle.braking && vehicle.speed > 26));
  if (smoking) {
    for (const w of [car.wheels[2], car.wheels[3]]) {
      w.pivot.getWorldPosition(tmp);
      vapor.emit(tmp.x, tmp.y - 0.2, tmp.z, vehicle.vel.x * 0.2 + (Math.random() - 0.5) * 2, 0.8 + Math.random(), vehicle.vel.z * 0.2 + (Math.random() - 0.5) * 2,
        1.6, 0.7, 2.8, 0.62, 0.62, 0.64, 0.28, 1.4);
    }
  }
  // damage: grey smoke, then black smoke and sparks, then fire from the rear deck
  if (alive && vehicle.health < 65) {
    car.root.localToWorld(tmp.set(0, 0.95, -1.5));
    const h = vehicle.health;
    const rate = h < 18 ? 0.9 : h < 35 ? 0.6 : 0.25;
    if (Math.random() < rate) {
      const dark = h < 35 ? 0.12 : 0.45;
      vapor.emit(tmp.x, tmp.y, tmp.z, vehicle.vel.x * 0.5 + (Math.random() - 0.5), 1.5 + Math.random() * 2, vehicle.vel.z * 0.5 + (Math.random() - 0.5),
        1.6 + Math.random(), 0.5, 2.4, dark, dark, dark, h < 35 ? 0.6 : 0.35, 1.2, -0.6);
    }
    if (h < 35 && Math.random() < 0.06) burstSparks(tmp.x, tmp.y, tmp.z, 6, 4, 2.2, 0.6, 6);
    if (h < 18 && Math.random() < 0.8) {
      fire.emit(tmp.x + (Math.random() - 0.5) * 0.6, tmp.y, tmp.z + (Math.random() - 0.5) * 0.6, vehicle.vel.x * 0.4, 1.5 + Math.random() * 2.5, vehicle.vel.z * 0.4,
        0.3 + Math.random() * 0.4, 0.5, 1.2, 3.2, 1.2, 0.25, 0.9, 2, -2);
    }
  }
  const h = innerHeight * pixelRatio;
  vapor.update(dt, h, camera.fov, -50);
  sparks.update(dt, h, camera.fov, -50);
  fire.update(dt, h, camera.fov, -50);

  const fast = alive && (vehicle.speed > 30 || vehicle.boosting);
  const strength = fast ? clamp((vehicle.speed - 18) / 40, 0, 1) : 0;
  trails[0].update(car.root.localToWorld(tmp.set(0.86, 0.885, -2.33)), camera.position, strength);
  trails[1].update(car.root.localToWorld(tmp.set(-0.86, 0.885, -2.33)), camera.position, strength);
}

// --- HUD -----------------------------------------------------------------------------

const HINTS = {
  pad: 'A jump (again + stick = flip) · B boost · X + stick = air roll · hold LT in the air = safe landing · hold LB in the air = flight mode · RB rear view · LB scoreboard · Y camera · D-pad ↑ kickflip ↓ park ← lights → doors',
  padroll: 'A jump (again + stick = flip) · B boost · hold LB in the air = flight mode · RB air roll (or X + stick) · hold LT in the air = safe landing · Y camera · D-pad ↑ kickflip ↓ park ← lights → doors',
  padglitch: 'Left stick up/down is not reporting, so: D-pad ↓ nose up · ↑ nose down · A jump · B boost · hold LB in the air = flight mode · ← level out (air) · Y camera',
  rl: 'Right mouse jump (+WASD = flip) · left mouse boost · Shift slide / air roll · Q E roll · hold F flight mode · hold L land · Space camera · C rear · 1 kickflip · 2 park · H lights · G doors',
  classic: 'Space jump (+WASD = flip) · Shift boost · Ctrl slide / air roll · Q E roll · hold F flight mode · hold L land · V camera · C rear · 1 kickflip · 2 park · H lights · G doors',
};

function updateHud(dt) {
  const mph = Math.round(vehicle.speed * 2.23694);
  ui.speed.textContent = mph;
  const sonic = vehicle.speed > P.SUPERSONIC;
  ui.speed.classList.toggle('sonic', sonic);
  ui.sonic.classList.toggle('on', sonic);
  let surf, k;
  if (!vehicle.alive) { surf = 'Totaled'; k = 'air'; }
  else if (!vehicle.grounded) { surf = vehicle.flying ? 'Flight' : vehicle.hovering ? 'Hover' : vehicle.tumbling ? 'Tumbling' : 'Air'; k = 'air'; }
  else if (vehicle.sup.kind === 'ground') { surf = vehicle.pos.y > 3 ? 'Roof' : mapName === 'arena' ? 'Strip' : 'Road'; k = 'ground'; }
  else if (vehicle.sup.n.y < -0.4) { surf = 'Inverted'; k = 'inverted'; }
  else { surf = vehicle.sup.kind === 'ramp' ? 'Wall' : 'Wall ride'; k = vehicle.sup.kind; }
  if (ui.surf.textContent !== surf) { ui.surf.textContent = surf; ui.surf.dataset.k = k; }
  ui.boostFill.style.transform = `scaleX(${(vehicle.boost / 100).toFixed(3)})`;
  ui.psi.textContent = Math.round(vehicle.boost * 100).toLocaleString();
  ui.j1.classList.toggle('on', vehicle.grounded && vehicle.alive);
  ui.j2.classList.toggle('on', !vehicle.grounded && vehicle.jump.canDouble && vehicle.jump.t < P.DOUBLE_T);
  const hp = Math.round(vehicle.health);
  ui.hullFill.style.transform = `scaleX(${(vehicle.health / 100).toFixed(3)})`;
  ui.hullPct.textContent = hp;
  const st = hp > 80 ? ['ok', 'Nominal'] : hp > 55 ? ['scraped', 'Scraped'] : hp > 30 ? ['damaged', 'Damaged'] : hp > 15 ? ['critical', 'Critical'] : hp > 0 ? ['fire', 'Fire'] : ['fire', 'Totaled'];
  if (ui.hull.dataset.s !== st[0]) { ui.hull.dataset.s = st[0]; ui.hullState.textContent = st[1]; }
  const showAlt = !vehicle.grounded || vehicle.pos.y - vehicle.groundY > 1;
  ui.alt.classList.toggle('on', showAlt);
  if (showAlt) ui.altVal.textContent = ((vehicle.pos.y - vehicle.groundY) * 3.28084).toFixed(1);
  const leftYBad = input.pitchStick === 'auto' && (input.axisDead(1) || input.axisFaulty(1));
  const dev = input.device === 'pad' ? (leftYBad ? 'padglitch' : input.bumpers === 'roll' ? 'padroll' : 'pad') : input.layout;
  if (dev !== lastDevice) {
    lastDevice = dev;
    ui.hint.textContent = HINTS[dev];
  }
  if (toastTimer > 0 && (toastTimer -= dt) <= 0) ui.toast.classList.remove('show');
  // combo panel: grace bar counts down while the car sits on flat ground, then the panel goes
  const cb = vehicle.cb;
  if (cb.active) {
    const grace = vehicle.grounded && vehicle.sup.kind === 'ground' ? 1 - cb.groundT / 0.6 : 1;
    ui.comboBar.style.transform = `scaleX(${clamp(grace, 0, 1).toFixed(3)})`;
  } else if (!ui.combo.hidden && (comboHide -= dt) <= 0) ui.combo.hidden = true;
}

// --- main loop -------------------------------------------------------------------------

let last = performance.now();
let perf = { t: 0, sum: 0, n: 0, cooldown: 0 };
let titleAngle = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const real = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;
  if (state === 'loading') return;
  timeScale = damp(timeScale, 1, 1.6, real);
  const dt = real * (state === 'play' ? timeScale : 1);
  input.update(!vehicle.grounded);
  const s = input.s;

  if (state === 'title') {
    if (s.confirmHit) startGame();
    if (s.navUp || s.navDown || s.lightsHit || s.doorsHit) loadWorld(mapName === 'arena' ? 'chicago' : 'arena');
  } else if (state === 'pause') {
    padMonitor();
    const b = menuButtons();
    if (s.navDown) { menuIndex = (menuIndex + 1) % b.length; focusMenu(); }
    if (s.navUp) { menuIndex = (menuIndex + b.length - 1) % b.length; focusMenu(); }
    if (s.confirmHit && input.device === 'pad') b[menuIndex]?.click();
    if (s.pauseHit || s.backHit) pause(false);
  } else if (state === 'play') {
    if (input.notice) { toast(input.notice.text, input.notice.sub); rec.event('axis', input.notice.sub); input.notice = null; lastDevice = ''; }
    updateBoard(!!s.board);
    topMph = Math.max(topMph, vehicle.speed * 2.23694);
    if (s.pauseHit) pause(true);
    if (s.camHit) toast(`Camera: ${rig.cycle()}`);
    if (s.resetHit) respawn();
    if (s.lightsHit) toast(`Headlights ${car.toggleLights() ? 'up' : 'down'}`);
    if (s.doorsHit) {
      if (vehicle.speed < 1.5 && vehicle.grounded) toast(car.toggleDoors() ? 'Doors open' : 'Doors closed');
      else toast('Stop on the ground to open the doors');
    }
    if (s.wingHit) toast(`Rear wing: ${{ auto: 'automatic', up: 'locked up', down: 'locked down' }[car.cycleWing()]}`);
    if (s.timeHit && mapName !== 'arena') toast(setTime(timeIndex + 1));
    if (s.muteHit) toast(toggleSound() ? 'Sound off' : 'Sound on');
    if (s.replayHit) sendReplay('F9');
    if (s.kickHit && vehicle.alive) { if (!vehicle.startMacro('kickflip')) toast('No flip left', 'land or touch a wall first'); }
    if (s.parkHit && vehicle.alive) { if (!vehicle.startMacro('parallel', s.steer < -0.2 ? -1 : 1)) toast('No flip left', 'land or touch a wall first'); }
    if (s.launchHit && vehicle.alive) {
      if (!vehicle.grounded) vehicle.landArmed = true; // landing protocol until touchdown (or a jump press)
      else if (vehicle.sup.kind === 'ground') toast('Wall launch: do it from a wall', 'in the air this engages the landing protocol');
      else if (!vehicle.startMacro('launch', s.steer < -0.2 ? -1 : 1)) toast('Recovering…');
    }
    vehicle.update(dt, s);
    traffic?.collide(vehicle);
    // the pad hums along with the speed shake
    if ((buzzT -= real) <= 0) { buzzT = 0.25; if (rig.speedShake > 0.3 && vehicle.grounded) input.buzz(Math.min(0.35, rig.speedShake * 0.22), 280); }
    handleEvents();
    if (vehicle.alive) { const got = addons.collect(vehicle.pos); if (got) fuelPickup(got); }
    rec.tick(real, s, vehicle, input.raw);
    if (!vehicle.alive) {
      deathTimer -= real;
      if (deathTimer < 0) respawn(true);
    }
  }

  syncCar();
  car.update(state === 'pause' ? 0 : dt, vehicle);
  const lift = vehicle.grounded ? 0 : vehicle.pos.y - vehicle.groundY;
  blob.visible = vehicle.alive;
  if (vehicle.grounded) {
    blob.position.copy(vehicle.pos).addScaledVector(vehicle.sup.n, 0.06);
    blob.quaternion.copy(vehicle.q);
    blob.scale.setScalar(1);
    blob.material.opacity = 0.6;
  } else {
    blob.position.set(vehicle.pos.x, vehicle.groundY + 0.06, vehicle.pos.z);
    blob.quaternion.setFromAxisAngle(tmp.set(0, 1, 0), vehicle.heading);
    blob.scale.setScalar(1 + clamp(lift / 12, 0, 1));
    blob.material.opacity = 0.6 * clamp(1 - lift / 18, 0, 1);
  }

  if (state === 'title') {
    titleAngle += dt * 0.12;
    const a = vehicle.heading + 2.4 + titleAngle;
    camera.position.set(vehicle.pos.x + Math.sin(a) * 7.2, vehicle.pos.y + 1.5, vehicle.pos.z + Math.cos(a) * 7.2);
    camera.lookAt(vehicle.pos.x, vehicle.pos.y + 0.7, vehicle.pos.z);
    if (camera.fov !== 50) { camera.fov = 50; camera.updateProjectionMatrix(); }
  } else if (state === 'play') {
    rig.update(dt, vehicle, s, car);
  }
  // the cabin only exists while you sit in it; its screen and head-up readout replace the HUD cluster
  const inCab = state === 'play' && rig.inCockpit && !debugCam;
  cockpit.setVisible(inCab);
  if (document.body.classList.contains('cockpit') !== inCab) document.body.classList.toggle('cockpit', inCab);
  if (inCab) cockpit.update(real, vehicle, cockpitData());
  if (debugCam) {
    camera.position.set(vehicle.pos.x + debugCam[0], vehicle.pos.y + debugCam[1], vehicle.pos.z + debugCam[2]);
    camera.lookAt(vehicle.pos.x, vehicle.pos.y + (debugCam[3] ?? 0.6), vehicle.pos.z);
    camera.fov = debugCam[4] ?? 40;
    camera.updateProjectionMatrix();
  }
  if (state !== 'pause') {
    emitContinuous(dt);
    debris.update(dt);
  }
  flash.intensity = damp(flash.intensity, 0, 6, real);

  atmo.follow(vehicle.pos, camera);
  world.update(dt, now / 1000);
  addons.update(dt);
  if (traffic && state !== 'pause') traffic.update(dt, vehicle);
  if (state === 'play') updateHud(real);
  addons.markers(ui.hud, camera, vehicle.pos, state === 'play' && mapName === 'chicago' && !debugCam);
  sound.update(vehicle, s.throttle || 0, real);

  const blur = clamp((vehicle.speed - 35) / 90, 0, 1) * 0.07 + (vehicle.boosting ? 0.02 : 0);
  speedPass.uniforms.amount.value = damp(speedPass.uniforms.amount.value, state === 'play' ? blur : 0, 4, real);
  speedPass.uniforms.aberration.value = damp(speedPass.uniforms.aberration.value, vehicle.boosting ? 0.007 : 0, 4, real);
  hurtFlash = damp(hurtFlash, 0, 4, real);
  whiteFlash = damp(whiteFlash, 0, 5, real);
  speedPass.uniforms.hurt.value = hurtFlash * 0.6;
  speedPass.uniforms.white.value = whiteFlash;
  photoFrame(real);
  composer.render(real);

  // keep the frame rate up by trading resolution
  perf.t += real; perf.sum += real; perf.n++;
  perf.cooldown = Math.max(0, perf.cooldown - real);
  if (perf.t > 2.5) {
    const avg = perf.sum / perf.n;
    if (avg > 1 / 42 && pixelRatio > 0.75) { setPixelRatio(pixelRatio - 0.25); perf.cooldown = 20; }
    else if (avg < 1 / 57 && pixelRatio < maxRatio && perf.cooldown === 0) setPixelRatio(Math.min(maxRatio, pixelRatio + 0.25));
    perf = { t: 0, sum: 0, n: 0, cooldown: perf.cooldown };
  }
}

setTimeout(() => { if (!window.claude?.use) $('claudeRow')?.remove(); }, 2500);

init().then(() => requestAnimationFrame(frame)).catch((err) => {
  console.error(err);
  ui.status.textContent = `Couldn't load the city: ${err.message}. Reload the page to try again.`;
});

// Debug hooks for development: __game.view([dx, dy, dz, lookY, fov]) pins the camera near the car.
let debugCam = null;
window.__game = {
  get vehicle() { return vehicle; }, get car() { return car; }, get world() { return world; },
  // photoreal.test(url) streams a public 3D Tiles set (no Google, no key) to check the pipeline
  photoreal: { get layer() { return photo.layer; }, get state() { return photo.state; }, toggle: togglePhotoreal, test: testPhotoreal },
  scene, camera, renderer, setTime, input, loadWorld, P, rec, pause, padMonitor,
  get traffic() { return traffic; }, get rig() { return rig; }, addons, applyFuel,
  replay() { return rec.dump({ build: BUILD, reason: 'manual', map: mapName }); },
  send: sendReplay,
  view(v) { debugCam = v; ui.title.hidden = !!v || state !== 'title'; },
  start: startGame,
  // Fixed-step simulation for testing: sim(seconds, {throttle: 1, steer: 0.3, ...} | fn(t), everyFrame?)
  sim(secs, held = {}, each) {
    const base = { throttle: 0, brake: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, airRoll: false, jump: false, jumpHit: false, boost: false,
      lookRateX: 0, lookRateY: 0, lookDX: 0, lookDY: 0, looking: false, rear: false };
    const log = [];
    for (let i = 0; i < Math.round(secs * 60); i++) {
      const s = typeof held === 'function'
        ? { ...base, ...held(i / 60) }
        : { ...base, ...held, ...(i > 0 ? { jumpHit: false } : {}) };
      vehicle.update(1 / 60, s);
      handleEvents();
      syncCar();
      car.update(1 / 60, vehicle);
      rig.update(1 / 60, vehicle, s, car);
      if (each && i % each === 0) log.push({ t: +(i / 60).toFixed(2), mph: Math.round(vehicle.speed * 2.237), y: +vehicle.pos.y.toFixed(1), g: vehicle.grounded, k: vehicle.sup.kind, upy: +vehicle.up.y.toFixed(2), x: +vehicle.pos.x.toFixed(0), z: +vehicle.pos.z.toFixed(0), hp: Math.round(vehicle.health), b: Math.round(vehicle.boost) });
    }
    return log;
  },
};
