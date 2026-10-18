import * as THREE from 'three';
import { clamp, damp } from './util.js?v=3.9';

// Six-axis car physics in the style of Rocket League, tuned to the 2026 Tesla Roadster.
//
// Rocket League's published values are in Unreal units for a car 118 uu long (Octane hitbox).
// The Roadster is ~4.6 m long, so lengths, speeds and accelerations are scaled by K = 3.9 and
// times/angles are kept. Where Tesla published a real figure (top speed, 0-60, thruster tank
// duration, suction) the real figure wins.
const K = 3.9;
export const P = {
  G: 650 * K / 100,              // 25.4 m/s^2 (RL gravity 650 uu/s^2)
  MAX_SPEED: 103,                // 230 mph, Tesla's claimed top speed (RL: 2300 uu/s = 90 m/s)
  SUPERSONIC: 97,                // 217 mph, same 95% fraction as RL's 2200/2300
  MAX_DRIVE: 103 * 1410 / 2300,  // 63 m/s (141 mph): the motors alone, RL's 1410/2300 split; boost or flips for more
  THROTTLE_A: 1600 * K / 100,    // 62.4 m/s^2 from rest (RL 1600 uu/s^2), tapering to a tenth near the drive cap
  REVERSE_A: 1600 * K / 100,     // reverse uses the same curve (RL)
  MAX_REVERSE: 103 * 1410 / 2300,
  BRAKE: 3500 * K / 100,         // 136 m/s^2 (RL 3500 uu/s^2): a reversing trigger stops the car almost at once
  COAST: 525 * K / 100,          // 20 m/s^2 when you lift (RL 525 uu/s^2)
  DRAG: 0,
  BOOST_GROUND: 991.667 * K / 100, // 38.7 m/s^2 (RL 991.667 uu/s^2), the same on the ground and in the air
  BOOST_AIR: 991.667 * K / 100,
  AIR_THROTTLE: 66.667 * K / 100,// 2.6 m/s^2 (RL air throttle)
  BOOST_RATE: 33.3,              // %/s: a full tank is 3.0 s of boost (RL); pads refill it
  SPAWN_BOOST: 33,               // RL: 33 after every spawn
  HOVER_RATE: 22,
  JUMP_V: 291.667 * K / 100,     // 11.4 m/s instant (RL 292 uu/s)
  JUMP_HOLD_A: 1458 * K / 100,   // 56.9 m/s^2 while jump is held, up to 0.2 s
  JUMP_HOLD_T: 0.2,
  DOUBLE_T: 1.25,                // window for the second jump / dodge
  DODGE_V: 500 * K / 100,        // 19.5 m/s impulse (RL 500 uu/s)
  DODGE_T: 0.65,
  DODGE_SPIN: (Math.PI * 2) / 0.65,
  DODGE_LOCK: 0.15,              // no air control for the first 0.15 s of a dodge; then yaw and roll return (RL)
  T_PITCH: 12.146, T_YAW: 8.92, T_ROLL: 36.08,  // rad/s^2 (RL air control: 12.146, 8.9196, 36.0796)
  D_PITCH: 2.798, D_YAW: 1.886, D_ROLL: 4.47,   // RL damping: pitch/yaw only with the stick centred, roll always
  MAX_ANG: 5.5,                  // rad/s
  SUCTION: 2.0,                  // fan suction in multiples of gravity (Tesla: "up to 2 G")
  WHEELBASE: 2.825,              // m (Tesla)
  SIXTY: 26.8224,                // 60 mph in m/s
};

// Style points per move; the chain multiplies by its length when it lands.
const MOVE_POINTS = {
  barrelroll: 150, backflip: 150, frontflip: 120, spin: 100, wallride: 100, inverted: 300, hover: 150,
  walllaunch: 250, walltowall: 300, flipreset: 200, wavedash: 120, parallel: 400, bigair: 100, highflyer: 150, lineup: 500,
};
// Names the McGregor checklist still listens for.
const LEGACY_STUNT = { wallride: 'wallride', inverted: 'inverted', hover: 'hover', parallel: 'parallel', walllaunch: 'walllaunch', lineup: 'lineup' };

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _f = new THREE.Vector3(), _l = new THREE.Vector3(), _u = new THREE.Vector3(), _n = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
const _ft = new THREE.Vector3(), _ut = new THREE.Vector3();

// Rotation that carries direction a onto direction b (both unit), scaled by k in [0, 1].
function rotTo(a, b, k, out) {
  const d = clamp(a.dot(b), -1, 1);
  _w.crossVectors(a, b);
  const len = _w.length();
  if (len < 1e-6) {
    if (d > 0) return out.identity();
    // opposite: pick any perpendicular axis
    _w.set(1, 0, 0).cross(a);
    if (_w.lengthSq() < 1e-6) _w.set(0, 0, 1).cross(a);
    return out.setFromAxisAngle(_w.normalize(), Math.PI * k);
  }
  return out.setFromAxisAngle(_w.multiplyScalar(1 / len), Math.acos(d) * k);
}

export class Vehicle {
  constructor(world) {
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.w = new THREE.Vector3(); // angular velocity, world frame
    this.fwd = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.left = new THREE.Vector3(1, 0, 0);
    this.sup = { on: false, n: new THREE.Vector3(0, 1, 0), p: new THREE.Vector3(), kind: 'ground', c: null, dist: 0 };
    this.grounded = true;
    this.groundY = 0;
    this.jump = { t: 99, canDouble: false, holding: false, holdT: 0, airT: 0, takeoff: new THREE.Vector3(), fromWall: false };
    this.dodge = { active: false, t: 0, spin: new THREE.Vector3(), extra: new THREE.Vector3(), pitchSign: 0, cancelled: false };
    this.boost = 100;
    this.fuelMult = 1; // fuel add-ons (js/addons.js) stretch the tank: every draw on it is divided by this
    this.boosting = false;
    this.hovering = false;
    this.cushion = 0;
    this.landing = false;
    this.rollAssist = true; // let go of air roll and the car banks back to wheels-down (pitch is left alone)
    this.landArmed = false; // a tap (D-pad left / 3) keeps the protocol on until touchdown or a jump press
    this.landDir = new THREE.Vector3();
    this.flying = false; // flight mode (hold LB / F in the air)
    this.flyHeading = 0;
    this.flyTurn = 0;
    this.flyClimb = 0;
    this.flyLift = 0;
    this.health = 100;
    this.alive = true;
    this.deadT = 0;
    this.speed = 0;
    this.vf = 0;
    this.vr = 0;
    this.steerAngle = 0;
    this.steerIn = 0;
    this.drifting = false;
    this.braking = false;
    this.reversing = false;
    this.accelLong = 0;
    this.accelLat = 0;
    this.fans = 0;
    this.jets = { rear: 0, down: new Float32Array(6), burst: new Float32Array(6) }; // FL FR ML MR RL RR
    this.tumbling = false;
    this.stuckT = 0;
    this.time = 0;
    this.events = [];
    // stunt tracking: per-flight totals (st) and the running combo (cb)
    this.st = { roll: 0, pitch: 0, yaw: 0, wallT: 0, invT: 0, hoverT: 0, wallDone: false, invDone: false, hoverDone: false, superDone: false, sixty: { t: 0, on: false, done: false }, lastSurface: 'ground' };
    this.cb = {
      moves: [], score: 0, mult: 1, active: false, groundT: 0, total: 0, best: 0, bestScore: 0,
      r: 0, p: 0, y: 0, maxH: 0, hoverT: 0, hoverDone: false, wallT: 0, wallDone: false, invT: 0, invDone: false,
      lastDodge: -9, dodgeF: 0, airSince: 0,
    };
    this.macro = null;
  }

  // --- combos: every recognised move extends the chain, landing on flat ground banks it -------------

  addMove(name) {
    const cb = this.cb;
    cb.moves.push(name);
    cb.active = true;
    cb.groundT = 0;
    cb.mult = cb.moves.length;
    const pts = MOVE_POINTS[name] || 100;
    cb.score += pts;
    this.events.push({ type: 'move', name, points: pts, mult: cb.mult, running: cb.score * cb.mult, moves: cb.moves.slice() });
    const legacy = LEGACY_STUNT[name];
    if (legacy) this.events.push({ type: 'stunt', name: legacy });
  }

  bankCombo(result) {
    const cb = this.cb;
    if (!cb.active) return;
    const banked = result === 'landed' ? cb.score * cb.mult : 0;
    cb.total += banked;
    if (result === 'landed' && banked > cb.bestScore) { cb.bestScore = banked; cb.best = cb.mult; }
    this.events.push({ type: 'combo', result, moves: cb.moves.slice(), mult: cb.mult, score: banked, total: cb.total });
    cb.moves.length = 0;
    cb.score = 0;
    cb.mult = 1;
    cb.active = false;
    cb.groundT = 0;
  }

  setWorld(world) {
    this.world = world;
  }

  spawn(x, z, heading, y) {
    const gy = y !== undefined ? y : this.world.groundAt(x, z, 2);
    this.pos.set(x, gy, z);
    this.vel.set(0, 0, 0);
    this.w.set(0, 0, 0);
    this.q.setFromAxisAngle(UP, heading);
    this.axes();
    this.grounded = true;
    this.sup.on = true;
    this.sup.n.set(0, 1, 0);
    this.sup.kind = 'ground';
    this.sup.c = null;
    this.jump.t = 99;
    this.jump.canDouble = false;
    this.jump.free = false;
    this.dodge.active = false;
    this.tumbling = false;
    this.stuckT = 0;
    this.health = 100;
    this.alive = true;
    this.boost = P.SPAWN_BOOST;
    this.steerAngle = 0;
    this.macro = null;
    this.st.sixty = { t: 0, on: false, done: false };
    this.bankCombo('dropped');
    this.jets.rear = 0;
    this.jets.down.fill(0);
    this.jets.burst.fill(0);
  }

  axes() {
    this.fwd.set(0, 0, 1).applyQuaternion(this.q);
    this.up.set(0, 1, 0).applyQuaternion(this.q);
    this.left.set(1, 0, 0).applyQuaternion(this.q);
  }

  get heading() {
    return Math.atan2(this.fwd.x, this.fwd.z);
  }

  get inverted() {
    return this.up.y < -0.3;
  }

  // --- per-frame -----------------------------------------------------------------

  update(dt, s) {
    this.events.length = 0;
    this.time += dt;
    this.steerIn = s.steer;
    if (!this.alive) {
      this.deadT += dt;
      this.vel.y -= P.G * dt;
      this.pos.addScaledVector(this.vel, dt);
      const g = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y);
      if (this.pos.y < g) { this.pos.y = g; this.vel.set(0, 0, 0); }
      this.jets.rear = 0;
      this.jets.down.fill(0);
      this.speed = 0;
      return;
    }
    // a jump press takes over from a scripted move so you can chain into your own
    if (this.macro && s.jumpHit && this.macro.t > 0.12) this.macro = null;
    if (this.macro) this.runMacro(dt, s);
    s = this.macro ? this.macro.s : s;

    // landing protocol: held (LT / L) or engaged by the level-out tap, in the air: wheels down,
    // nose along the direction of travel, and the floor thrusters brake the descent (see fly)
    const wasLanding = this.landing;
    if (this.grounded) this.landArmed = false;
    this.landing = !this.grounded && !this.tumbling && !this.dodge.active && !s.flyHold && (!!s.landHold || this.landArmed || (!!this.macro && this.macro.name === 'launch' && this.macro.phase === 2));
    if (this.landing && !this.macro) {
      const d = this.landDir.set(this.vel.x, 0, this.vel.z);
      if (d.lengthSq() < 16) d.set(this.fwd.x, 0, this.fwd.z);
      if (d.lengthSq() < 0.01) d.set(0, 0, 1);
      d.normalize();
      this.aim(s, d, UP, 1);
    }
    if (this.landing && !wasLanding) this.events.push({ type: 'landing' });

    // flight mode: hold LB (or F) in the air and the car flies level like a jump jet while there is
    // pressure in the tank. The stick turns it (banking into the turn) and climbs or descends, RT
    // drives it on the rear thrusters, LT is the air brake, boost still boosts; the floor thrusters
    // hold the height (see fly). Let go and the normal air controls, and LT's landing, are back.
    const wasFlying = this.flying;
    this.flying = !this.grounded && this.alive && !this.tumbling && !this.dodge.active && !this.macro && !!s.flyHold && this.boost > 0.01;
    if (this.flying) {
      if (!wasFlying) {
        const hz = Math.hypot(this.vel.x, this.vel.z);
        this.flyHeading = hz > 4 ? Math.atan2(this.vel.x, this.vel.z) : Math.atan2(this.fwd.x, this.fwd.z);
        this.events.push({ type: 'flight' });
      }
      // read the stick before aim() turns it into attitude inputs
      this.flyTurn = clamp(s.steer, -1, 1);
      this.flyClimb = clamp(-s.pitch, -1, 1); // stick back climbs
      const hz = Math.hypot(this.vel.x, this.vel.z);
      const rate = Math.min(1.6, (P.G * 2.2) / Math.max(hz, 1)); // a coordinated turn, about 2.2 G at speed
      this.flyHeading -= this.flyTurn * rate * dt;
      const H = this.flyHeading, bank = this.flyTurn * 0.5, nose = this.flyClimb * 0.22;
      _ft.set(Math.sin(H) * Math.cos(nose), Math.sin(nose), Math.cos(H) * Math.cos(nose));
      const rx = -Math.cos(H), rz = Math.sin(H); // the car's right, level
      _ut.set(rx * Math.sin(bank), Math.cos(bank), rz * Math.sin(bank));
      this.aim(s, _ft, _ut, 1);
    }

    // jump button edge handling (before substeps so one press = one action)
    if (s.jumpHit) this.onJump(s);
    if (!s.jump) this.jump.holding = false;

    const steps = Math.max(1, Math.ceil(dt * 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, s);

    this.speed = this.vel.length();
    this.axes();
    this.trackStunts(dt, s);
    this.updateJets(dt, s);
    this.pickups();
  }

  onJump(s) {
    const j = this.jump;
    this.landArmed = false; // a jump press takes control back from the landing protocol
    if (this.grounded && !this.tumbling) {
      // first jump: push off the surface along the car's up
      this.vel.addScaledVector(this.up, P.JUMP_V);
      j.t = 0;
      j.airT = 0;
      j.canDouble = true;
      j.holding = true;
      j.holdT = 0;
      j.hoverArmed = false;
      j.free = false;
      j.fromWall = this.sup.kind !== 'ground';
      j.takeoff.copy(this.pos);
      this.leaveSurface();
      this.burstAll(1);
      this.events.push({ type: 'jump' });
      this.st.roll = this.st.pitch = this.st.yaw = 0;
    } else if (this.tumbling || (this.up.y < 0.45 && this.pos.y - this.groundY < 2.6)) {
      // on the roof or side: a thruster shove rights the car (RL lets you jump off your roof)
      this.rightSelf();
    } else if (j.canDouble && (j.free || j.t < P.DOUBLE_T) && !this.dodge.active) {
      const dx = s.steer, dy = s.pitch; // stick forward (pitch down) = front flip
      if (Math.hypot(dx, dy) > 0.5) this.startDodge(dy, dx);
      else {
        this.vel.addScaledVector(this.up, P.JUMP_V);
        this.burstAll(0.8);
        this.events.push({ type: 'doublejump' });
      }
      j.canDouble = false;
      j.free = false;
      j.holding = false;
    }
  }

  startDodge(f, r, impulse = 1) {
    const d = this.dodge;
    const m = Math.hypot(f, r) || 1;
    f /= m; r /= m;
    d.active = true;
    d.t = 0;
    d.cancelled = false;
    d.extra.set(0, 0, 0);
    // spin in the car's frame: +x pitch = nose down (front flip), +z roll = roll right
    d.spin.set(f * P.DODGE_SPIN, 0, r * P.DODGE_SPIN);
    d.pitchSign = Math.sign(f);
    // impulse in the car's yaw frame (RL ignores pitch/roll for the dodge impulse)
    if (this.up.y > 0.5) {
      _f.set(this.fwd.x, 0, this.fwd.z).normalize();
      _l.crossVectors(UP, _f);
    } else {
      _f.copy(this.fwd);
      _l.copy(this.left);
    }
    // RL: a back flip while moving forward gets 2.5x the impulse (that is why it brakes), a side
    // flip scales up with forward speed, up to about 1.9x at the drive cap
    let fk = f, rk = r;
    const vf0 = this.vel.dot(_f);
    if (f < 0 && vf0 > 2) fk *= 2.5;
    if (Math.abs(r) > 0.01) rk *= 1 + 0.9 * clamp(vf0 / P.MAX_DRIVE, 0, 1);
    _a.copy(_f).multiplyScalar(fk).addScaledVector(_l, -rk).multiplyScalar(P.DODGE_V * impulse);
    this.vel.add(_a);
    if (this.vel.length() > P.MAX_SPEED) this.vel.setLength(P.MAX_SPEED);
    this.cb.lastDodge = this.time;
    this.cb.dodgeF = f;
    this.events.push({ type: 'dodge', f, r });
    // which nozzles: a front flip lifts the tail (rear pair), a roll fires the opposite side
    const b = this.jets.burst;
    if (f > 0.4) { b[4] = b[5] = 1; }
    if (f < -0.4) { b[0] = b[1] = 1; }
    if (r > 0.4) { b[0] = b[2] = b[4] = 1; }
    if (r < -0.4) { b[1] = b[3] = b[5] = 1; }
  }

  burstAll(k) {
    const b = this.jets.burst;
    for (let i = 0; i < 6; i++) b[i] = Math.max(b[i], k);
  }

  leaveSurface() {
    this.grounded = false;
    this.sup.on = false;
    this.w.set(0, 0, 0);
  }

  rightSelf() {
    // thrusters roll the car back onto its wheels
    _u.set(0, 1, 0);
    _f.set(this.fwd.x, 0, this.fwd.z);
    if (_f.lengthSq() < 0.01) _f.set(0, 0, 1);
    _f.normalize();
    _l.crossVectors(_u, _f);
    this.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(_l, _u, _f));
    this.axes();
    const g = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y + 1);
    this.pos.y = Math.max(this.pos.y, g) + 0.3;
    this.vel.set(this.vel.x * 0.3, 4.5, this.vel.z * 0.3);
    this.w.set(0, 0, 0);
    this.tumbling = false;
    this.stuckT = 0;
    this.grounded = false;
    this.jump.canDouble = false;
    this.burstAll(1);
    this.events.push({ type: 'righted' });
  }

  // --- fixed step ----------------------------------------------------------------

  step(h, s) {
    this.axes();
    this.boosting = s.boost && this.boost > 0.01 && !this.tumbling;
    if (this.dodge.active) {
      this.dodge.t += h;
      if (this.dodge.t >= P.DODGE_T) {
        // the flip stops; any yaw or roll the driver added through it carries on
        this.dodge.active = false;
        this.w.copy(this.dodge.extra).applyQuaternion(this.q);
      }
    }
    if (this.grounded) this.driveOnSurface(h, s);
    else this.fly(h, s);
    this.pos.addScaledVector(this.vel, h);
    this.collide(h);
    this.resolveSupport(h);
    if (this.boosting) {
      this.boost = Math.max(0, this.boost - (P.BOOST_RATE * (this.health < 30 ? 1.5 : 1) * h) / this.fuelMult);
    }
  }

  driveOnSurface(h, s) {
    const n = this.sup.n;
    // car frame on the surface
    _f.copy(this.fwd).addScaledVector(n, -this.fwd.dot(n));
    if (_f.lengthSq() < 1e-4) _f.crossVectors(this.left, n);
    _f.normalize();
    _l.crossVectors(n, _f).normalize();
    let vf = this.vel.dot(_f), vr = this.vel.dot(_l);
    const dmg = this.health < 30 ? 0.75 : this.health < 60 ? 0.9 : 1;
    const top = (this.boosting ? P.MAX_SPEED : P.MAX_DRIVE) * dmg;
    let a = 0;
    // RL throttle curve: full acceleration at rest, a tenth of it near the drive cap, nothing past it
    const curve = (v) => (v >= P.MAX_DRIVE * dmg ? 0 : P.THROTTLE_A * (1 - 0.9 * clamp(v / (P.MAX_DRIVE * dmg), 0, 1)));
    if (s.throttle > 0.02) {
      if (vf >= 0) a += s.throttle * curve(vf);
      else a += s.throttle * P.BRAKE; // throttle against reverse motion is a brake (RL)
    }
    if (this.boosting) a += vf < P.MAX_SPEED * dmg ? P.BOOST_GROUND : 0;
    this.braking = s.brake > 0.05 && vf > 0.5;
    this.reversing = vf < -0.5;
    const onWall = this.sup.kind !== 'ground';
    if (s.brake > 0.05) {
      if (vf > 0.5) a -= P.BRAKE * s.brake;
      else if (!onWall) a -= s.brake * curve(-vf);
    }
    // on a wall or the ceiling the brake holds the car still instead of reversing
    const idle = (s.throttle < 0.02 && s.brake < 0.05 && !this.boosting) || (onWall && s.brake > 0.05 && Math.abs(vf) < 1.5 && s.throttle < 0.02);
    if (idle) a -= Math.sign(vf) * Math.min(Math.abs(vf) / h, P.COAST);
    a -= P.DRAG * vf * Math.abs(vf);
    // gravity along the surface (slides you down walls unless you drive)
    _a.set(0, -P.G, 0);
    const gn = _a.dot(n); // negative when gravity pushes into the surface
    _a.addScaledVector(n, -gn);
    const gf = _a.dot(_f), gl = _a.dot(_l);
    const holdable = idle && Math.abs(vf) < (onWall && s.brake > 0.05 ? 1.5 : 0.8) && Math.abs(vr) < 0.8 && Math.abs(gf) + Math.abs(gl) < P.G * 1.01;
    if (!holdable) {
      vf += (a + gf) * h;
      vr += gl * h;
    } else {
      // static friction with the fans holding: the car can park on a wall or upside down
      vf = damp(vf, 0, 30, h);
      vr = damp(vr, 0, 30, h);
    }
    // steering: bicycle model, speed-sensitive lock
    const maxSteer = 0.62 / (1 + Math.abs(vf) / 16);
    this.steerAngle = damp(this.steerAngle, s.steer * maxSteer, 12, h);
    let yaw = (vf / P.WHEELBASE) * Math.tan(this.steerAngle);
    this.drifting = s.airRoll && Math.abs(vf) > 6;
    if (this.drifting) {
      yaw *= 1.55;
      vf *= Math.exp(-0.28 * h);
    }
    vr *= Math.exp(-(this.drifting ? 1.5 : Math.abs(vr) > 6 ? 5 : 12) * h);
    this.accelLong = a;
    this.accelLat = vf * yaw;
    this.vf = vf;
    this.vr = vr;
    this.vel.copy(_f).multiplyScalar(vf).addScaledVector(_l, vr);
    // yaw about the surface normal (right turn = negative, since +x is the car's left)
    _q.setFromAxisAngle(n, -yaw * h);
    this.q.premultiply(_q);
    // suspension pulls the car's up onto the surface normal
    this.axes();
    rotTo(this.up, n, 1 - Math.exp(-22 * h), _q2);
    this.q.premultiply(_q2).normalize();
    this.w.set(0, 0, 0);
    // fans: suction keeps the car on walls and ceilings; detach when gravity wins
    this.fans = this.sup.kind !== 'ground' ? 1 : Math.abs(vf) > 30 ? 0.6 : 0.15;
    const pullAway = gn > 0 ? gn : 0; // gravity component away from the surface
    if (pullAway > P.G * P.SUCTION * 0.98) {
      this.leaveSurface();
      this.vel.addScaledVector(n, 0.5);
    }
    this.hovering = false;
    this.cushion = 0;
  }

  fly(h, s) {
    const j = this.jump;
    j.t += h;
    j.airT += h;
    this.vel.y -= P.G * h;
    if (this.boosting) this.vel.addScaledVector(this.fwd, P.BOOST_AIR * h);
    if (s.throttle > 0.02 && !this.flying) this.vel.addScaledVector(this.fwd, P.AIR_THROTTLE * s.throttle * h);
    if (this.flying) {
      // floor thrusters hold the climb rate the stick asks for, up to 14 m/s up or down
      const lift = clamp((this.flyClimb * 14 - this.vel.y) * 3 + P.G, 0, P.G * 2.2);
      this.vel.y += lift * h;
      this.flyLift = lift / (P.G * 2.2);
      // the travel swings round to the nose without losing speed (fans and fins keep it from skidding)
      const H = this.flyHeading, dx = Math.sin(H), dz = Math.cos(H);
      let vx = this.vel.x, vz = this.vel.z;
      const sp = Math.hypot(vx, vz);
      if (sp > 0.5) {
        let a = Math.atan2(vx, vz);
        a += Math.atan2(Math.sin(H - a), Math.cos(H - a)) * Math.min(1, 3 * h);
        vx = Math.sin(a) * sp;
        vz = Math.cos(a) * sp;
      }
      // LT air brake and a little drag, RT thrust on the rear thrusters
      const sp2 = Math.hypot(vx, vz);
      if (sp2 > 0.01) {
        const f = Math.max(0, sp2 - s.brake * 18 * h - sp2 * 0.04 * h) / sp2;
        vx *= f; vz *= f;
      }
      vx += dx * s.throttle * 20 * h;
      vz += dz * s.throttle * 20 * h;
      this.vel.x = vx;
      this.vel.z = vz;
      this.boost = Math.max(0, this.boost - ((14 + s.throttle * 8) * h) / this.fuelMult);
    }
    // held jump: the first 0.2 s keep pushing (RL hold-jump)
    if (j.holding && j.holdT < P.JUMP_HOLD_T && s.jump) {
      this.vel.addScaledVector(this.up, P.JUMP_HOLD_A * h);
      j.holdT += h;
    }
    // hover: after both jumps, let go of jump and then hold it again to fire all six floor
    // thrusters (Rocket trim). A button that was simply never released does not hover, so a
    // held A through a double jump stays a double jump.
    this.hovering = false;
    if (!j.canDouble && !j.holding && !this.tumbling) {
      if (!s.jump) { j.hoverArmed = true; j.hoverHold = 0; }
      else j.hoverHold = (j.hoverHold || 0) + h;
      // a quarter-second of deliberate hold, so a mashed button never floats the car away
      if (s.jump && j.hoverArmed && j.hoverHold > 0.25 && this.boost > 0.01 && this.up.y > 0.2) {
        // the thrusters trim to a gentle climb, like the demo car drifting up over the lineup
        const k = this.vel.y > 4 ? 0.55 : this.vel.y < -1 ? 1.35 : 1.06;
        this.vel.addScaledVector(this.up, P.G * k * h);
        this.boost = Math.max(0, this.boost - (P.HOVER_RATE * h) / this.fuelMult);
        this.hovering = true;
      }
    }
    // landing cushion: the floor thrusters fire when the car would otherwise hit hard, as at the
    // demo landing. It runs off the pump's own reserve, so it works with an empty tank too.
    this.cushion = 0;
    const g = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y);
    const vy = this.vel.y;
    if (!this.tumbling && vy < -12 && this.up.y > 0.3 && !this.hovering) {
      const net = P.G * 1.5; // 2.5 G of thrust minus gravity
      const stop = (vy * vy - 12 * 12) / (2 * net); // metres needed to slow to 12 m/s
      if (this.pos.y - g < stop + 1.2) {
        this.vel.y += P.G * 2.5 * h;
        this.boost = Math.max(0, this.boost - (6 * h) / this.fuelMult);
        this.cushion = 1;
      }
    }
    // landing protocol: with the wheels down, the floor thrusters hold the descent to a gentle
    // 6 m/s, off the tank (the free cushion still catches the last metres)
    if (this.landing && this.up.y > 0.5 && this.vel.y < -6 && this.boost > 0.01) {
      const a = clamp((-6 - this.vel.y) * 2.5, 0, P.G * 1.6);
      this.vel.addScaledVector(this.up, a * h);
      this.boost = Math.max(0, this.boost - (10 * h) / this.fuelMult); // a 60 m drop costs about a quarter of a tank
      this.cushion = Math.max(this.cushion, 0.9);
    }
    // speed cap
    const sp = this.vel.length();
    if (sp > P.MAX_SPEED) this.vel.multiplyScalar(P.MAX_SPEED / sp);

    // angular motion
    if (this.dodge.active) {
      const d = this.dodge;
      // flip cancel: pulling the stick against the flip stops the pitch rotation
      if (d.pitchSign !== 0 && Math.sign(s.pitch) === -d.pitchSign && Math.abs(s.pitch) > 0.5) d.cancelled = true;
      // after the lock-out the driver can yaw and air roll through the flip (half-flips, stalls)
      _w.copy(d.extra);
      if (d.t > P.DODGE_LOCK) {
        const y = s.yaw, r = s.roll;
        _w.y += (-P.T_YAW * y - P.D_YAW * _w.y * (1 - Math.abs(y))) * h;
        _w.z += (P.T_ROLL * r - P.D_ROLL * _w.z) * h;
        const m = _w.length();
        if (m > P.MAX_ANG) _w.multiplyScalar(P.MAX_ANG / m);
      }
      d.extra.copy(_w);
      _w.add(d.spin);
      if (d.cancelled) _w.x = d.extra.x;
      this.w.copy(_w).applyQuaternion(this.q);
    } else if (!this.tumbling) {
      _w.copy(this.w).applyQuaternion(_q.copy(this.q).invert());
      const p = s.pitch, y = s.yaw, r = s.roll;
      _w.x += (P.T_PITCH * p - P.D_PITCH * _w.x * (1 - Math.abs(p))) * h;
      _w.y += (-P.T_YAW * y - P.D_YAW * _w.y * (1 - Math.abs(y))) * h;
      _w.z += (P.T_ROLL * r - P.D_ROLL * _w.z) * h;
      // roll assist: with no roll input (and no pitch held, so a loop stays a loop) bank back
      // toward wheels-down; from flat inverted it keeps turning the way it was going
      if (this.rollAssist && Math.abs(r) < 0.05 && Math.abs(p) < 0.3 && !this.hovering) {
        const cu = this.up.y, cl = this.left.y;
        const mag = Math.hypot(cu, cl);
        if (mag > 0.15) {
          let e = Math.atan2(-cl, cu); // roll still needed to put the roof toward the sky
          if (Math.PI - Math.abs(e) < 0.15) e = Math.PI * (_w.z >= 0 ? 1 : -1);
          _w.z += clamp(e * 16, -P.T_ROLL, P.T_ROLL) * mag * h;
        }
      }
      const m = _w.length();
      if (m > P.MAX_ANG) _w.multiplyScalar(P.MAX_ANG / m);
      this.w.copy(_w).applyQuaternion(this.q);
    } else {
      this.w.multiplyScalar(Math.exp(-0.8 * h));
    }
    const ang = this.w.length() * h;
    if (ang > 1e-7) {
      _q.setFromAxisAngle(_a.copy(this.w).normalize(), ang);
      this.q.premultiply(_q).normalize();
    }
    this.steerAngle = damp(this.steerAngle, s.steer * 0.3, 6, h);
    this.braking = false;
    this.reversing = false;
    this.drifting = false;
    this.accelLong = 0;
    this.accelLat = 0;
    this.vf = this.vel.dot(this.fwd);
    this.vr = this.vel.dot(this.left);
    this.fans = damp(this.fans, 0.1, 3, h);
  }

  // --- contacts -------------------------------------------------------------------

  collide(h) {
    const world = this.world;
    if (world.extraCollide) world.extraCollide(this);
    // driving down a wall onto the street: re-seat on the ground instead of crashing
    if (this.grounded && this.sup.kind === 'wall' && this.pos.y <= this.groundY + 0.3 && this.vel.y < 0) {
      this.pos.y = this.groundY;
      const sp = this.vel.length();
      this.transitionTo(UP, null, 'ground');
      // a building has no curved corner: coming down fast means a hard hit on the sills
      if (sp > 28) {
        this.hurt((sp - 28) * 0.5 + 6, 0.8);
        this.events.push({ type: 'impact', strength: (sp - 28) * 0.5 + 6, x: this.pos.x, y: this.pos.y + 0.3, z: this.pos.z });
      }
      return;
    }
    const skip = this.grounded && this.sup.kind === 'wall' ? this.sup.c : null;
    // sample the body along its length, in the car's own plane
    for (const off of [1.5, 0, -1.45]) {
      _b.copy(this.pos).addScaledVector(this.fwd, off);
      if (this.grounded && this.sup.kind !== 'ground') _b.y = this.pos.y; // keep wall samples at the car's height
      const hit = world.pushOut(_b.x, _b.z, 1.0, _b.y, _b.y, skip);
      if (!hit) continue;
      if (hit.roof && hit.dx === 0 && hit.dz === 0) continue;
      if (hit.roof && this.pos.y < hit.roof && this.vel.y <= 0 && this.pos.y > hit.roof - 1.2) {
        this.pos.y = hit.roof;
        if (this.vel.y < 0) this.vel.y = 0;
        continue;
      }
      const vn = this.vel.x * hit.nx + this.vel.z * hit.nz;
      _n.set(hit.nx, 0, hit.nz);
      const headOn = -(this.fwd.x * hit.nx + this.fwd.z * hit.nz);
      const tall = hit.top > this.pos.y + 2.5;
      const speed = Math.hypot(this.vel.x, this.vel.z);
      // in the air, any contact with a tall wall short of roof-first: the fans grab it and the car
      // seats on the face, nose turned up the wall when it came in nose-first (a Rocket League wall
      // landing, with the Roadster's suction doing the rest). Wheels first is a clean landing;
      // nose or side into the wall at speed scrapes.
      const wheelsFirst = this.up.x * hit.nx + this.up.z * hit.nz;
      // (moving into or along the face, and not in the first instant of a jump away from it)
      const rideable = tall && !(hit.c && hit.c.noWall); // poles, columns and posts are never a wall to ride
      if (!this.grounded && !this.tumbling && rideable && wheelsFirst > -0.3 && vn <= 0.5 && this.jump.t > 0.2 && Math.hypot(hit.dx, hit.dz) < 1.2 && this.pos.y < hit.top - 0.3) {
        const into = Math.max(0, -vn);
        this.transitionTo(_n, hit.c, 'wall', hit.qx, hit.qz);
        this.dodge.active = false;
        this.jump.canDouble = false;
        this.jump.free = false;
        this.jump.holding = false;
        this.stuckT = 0;
        if (into > 25 && wheelsFirst < 0.35) {
          this.hurt((into - 25) * 0.4 + 5, 0.6);
          this.events.push({ type: 'impact', strength: into * 0.5, x: _b.x, y: this.pos.y + 0.5, z: _b.z });
        }
        this.events.push({ type: 'touchdown', kind: 'wall', vn: into });
        return;
      }
      // drive up the wall: head-on into a tall wall with speed, fans sucking the car on
      if (this.grounded && !this.tumbling && headOn > 0.5 && speed > 7 && rideable && this.sup.kind === 'ground') {
        this.transitionTo(_n, hit.c, 'wall', hit.qx, hit.qz);
        return;
      }
      if (this.grounded && this.sup.kind === 'wall' && hit.c !== this.sup.c && headOn > 0.5 && rideable) {
        this.transitionTo(_n, hit.c, 'wall', hit.qx, hit.qz);
        return;
      }
      this.pos.x += hit.dx;
      this.pos.z += hit.dz;
      if (vn < 0) {
        this.vel.x -= hit.nx * vn * 1.35;
        this.vel.z -= hit.nz * vn * 1.35;
        this.vel.x *= 0.96;
        this.vel.z *= 0.96;
        if (-vn > 4) {
          this.hurt(-vn, 1.0);
          this.events.push({ type: 'impact', strength: -vn, x: _b.x, y: this.pos.y + 0.5, z: _b.z });
          if (!this.grounded && -vn > 9) {
            this.tumble(-vn * 0.12);
          }
        }
      }
    }
  }

  // Re-seat the car on a new surface: rotate its up onto the new normal, carry the speed along.
  transitionTo(n, c, kind, qx, qz) {
    const speed = this.vel.length();
    rotTo(this.up, n, 1, _q2);
    this.q.premultiply(_q2).normalize();
    this.axes();
    if (kind === 'wall') {
      this.pos.x = qx + n.x * 0.05;
      this.pos.z = qz + n.z * 0.05;
    }
    _f.copy(this.fwd).addScaledVector(n, -this.fwd.dot(n)).normalize();
    this.vel.copy(_f).multiplyScalar(speed * 0.92);
    this.grounded = true;
    this.sup.on = true;
    this.sup.n.copy(n);
    this.sup.c = c;
    this.sup.kind = kind;
    this.w.set(0, 0, 0);
    this.events.push({ type: 'wallride', kind });
  }

  resolveSupport(h) {
    const world = this.world;
    const out = this.sup;
    this.axes();
    const g = world.groundAt(this.pos.x, this.pos.z, this.pos.y);
    this.groundY = g;
    const found = world.support(this.pos, this.up, out, this.grounded ? out.kind : null);
    if (this.grounded) {
      if (!found || out.dist > 0.7) {
        // drove off an edge, over the top of a wall or past the end of the ramp
        this.leaveSurface();
        this.jump.t = 99;
        this.jump.canDouble = true; // RL: you keep one jump after driving off an edge
        this.jump.free = true; // and it has no timer (RL: a ceiling shot's flip waits as long as you fall)
        this.jump.airT = 0;
        this.jump.takeoff.copy(this.pos);
        this.jump.fromWall = out.kind !== 'ground';
        this.st.roll = this.st.pitch = this.st.yaw = 0;
      } else {
        // seat on the surface
        this.pos.copy(out.p);
        const vn = this.vel.dot(out.n);
        if (vn < 0) this.vel.addScaledVector(out.n, -vn);
        else if (vn > 2.5 && out.kind === 'ramp') {
          // launched off a lip
          this.leaveSurface();
          this.jump.t = 99;
          this.jump.canDouble = true;
          this.jump.free = true;
          this.jump.fromWall = true;
          this.jump.takeoff.copy(this.pos);
        }
      }
    } else {
      // a crash only takes control away for a moment; after that you can steer and jump out of it
      if (this.tumbling && (this.tumbleT += h) > 0.6) this.tumbling = false;
      // airborne: land when a surface is under the wheels and the car is facing it
      if (found && out.dist < 0.35 && this.vel.dot(out.n) <= 0.6) {
        const align = this.up.dot(out.n);
        const vn = -this.vel.dot(out.n);
        if (align > 0.35) {
          this.landOn(out, vn, align);
        } else {
          this.crashLand(out, vn, align);
        }
      }
      // never fall through the floor, even on the roof or nose: rest there, don't bounce
      const lift = this.restLift();
      if (this.pos.y < g + lift) {
        this.pos.y = g + lift;
        if (this.vel.y < 0) {
          const vn = -this.vel.y;
          this.vel.y = vn > 6 ? vn * 0.2 : 0;
          this.vel.x *= 0.6;
          this.vel.z *= 0.6;
          if (vn > 6) {
            this.hurt(vn, 1.3);
            this.events.push({ type: 'impact', strength: vn, x: this.pos.x, y: this.pos.y, z: this.pos.z });
            if (this.up.y < 0.45) this.tumble(vn * 0.1);
          }
        }
      }
      // on the roof or side near the ground: after a moment the thrusters flip the car back over
      if (this.up.y < 0.45 && Math.abs(this.vel.y) < 3 && this.pos.y - g < lift + 0.4) {
        this.stuckT += h;
        if (this.stuckT > 0.8) this.rightSelf();
      } else this.stuckT = 0;
    }
  }

  // How far above the floor the car's origin sits when it is not on its wheels.
  restLift() {
    return this.up.y < -0.5 ? 1.1 : Math.abs(this.up.y) < 0.5 ? 0.85 : 0;
  }

  landOn(out, vn, align = 1) {
    this.grounded = true;
    this.sup.on = true;
    this.pos.copy(out.p);
    // snap the up vector to the surface, keep the heading
    rotTo(this.up, out.n, 1, _q2);
    this.q.premultiply(_q2).normalize();
    this.axes();
    const n = out.n;
    const vnow = this.vel.dot(n);
    if (vnow < 0) this.vel.addScaledVector(n, -vnow);
    this.w.set(0, 0, 0);
    this.dodge.active = false;
    this.jump.canDouble = false;
    this.jump.holding = false;
    this.tumbling = false;
    this.stuckT = 0;
    // only a really hard landing hurts (the cushion keeps normal drops under this); coming down crooked on the sills does too
    if (vn > 22) this.hurt((vn - 22) * 0.5 + 5, 0.8); // wheels down from any height: the floor thrusters take most of it
    else if (align < 0.6 && vn > 8) this.hurt(vn - 4, 0.6);
    if (vn > 6) this.events.push({ type: 'land', strength: vn, kind: out.kind });
    this.events.push({ type: 'touchdown', kind: out.kind, vn });
  }

  // Came down on the roof, nose or side: rest against the surface and take a hit for a real impact.
  crashLand(out, vn, align) {
    const n = out.n;
    const vnow = this.vel.dot(n);
    if (vnow < 0) this.vel.addScaledVector(n, vn > 6 ? -vnow * 1.2 : -vnow);
    this.vel.multiplyScalar(vn > 6 ? 0.7 : 0.9);
    this.pos.copy(out.p).addScaledVector(n, out.kind === 'ground' ? this.restLift() : 0.7);
    if (vn > 6) {
      // a roof landing from a normal jump is a scrape; a long drop onto the roof is a wreck
      this.hurt(vn - 6, align < 0 ? 1.1 : 0.9);
      this.events.push({ type: 'impact', strength: vn, x: this.pos.x, y: this.pos.y, z: this.pos.z, crash: true });
      this.tumble(vn * 0.15);
    } else {
      this.w.multiplyScalar(0.5);
    }
    this.dodge.active = false;
    this.jump.canDouble = false;
  }

  tumble(k) {
    this.tumbling = true;
    this.w.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k * 0.5, (Math.random() - 0.5) * k);
    this.tumbleT = 0;
  }

  hurt(vn, mult) {
    let dmg = Math.max(0, vn - 5) * 0.75 * mult; // halved in 2.6: the hull lasts twice as long
    // repeated scrapes in quick succession count once, not every frame
    if (this.time - (this.lastHurt || -9) < 0.6) dmg *= 0.2;
    dmg = Math.min(dmg, 50); // one wreck never totals a full hull; two do
    if (dmg < 0.5) return;
    this.lastHurt = this.time;
    this.health = Math.max(0, this.health - dmg);
    this.events.push({ type: 'damage', amount: dmg });
    if (this.health <= 0 && this.alive) {
      this.alive = false;
      this.deadT = 0;
      this.events.push({ type: 'explode' });
    }
  }

  // --- pickups --------------------------------------------------------------------

  pickups() {
    const w = this.world;
    const pad = w.collectPad?.(this.pos);
    if (pad) {
      this.boost = Math.min(100, this.boost + (pad.big ? 100 : 12));
      this.events.push({ type: 'pad', big: pad.big });
    }
    const ch = w.collectCharger?.(this.pos, this.health < 100);
    if (ch) {
      this.health = Math.min(100, this.health + 35);
      this.events.push({ type: 'charge' });
    }
  }

  // --- thruster animation state -------------------------------------------------------

  updateJets(dt, s) {
    const J = this.jets;
    let rear = this.boosting ? 1 : 0;
    const down = J.down;
    const want = new Array(6).fill(0);
    if (this.hovering) want.fill(0.9);
    if (this.flying) { want.fill(0.4 + this.flyLift * 0.55); rear = Math.max(rear, s.throttle * 0.7); }
    if (this.cushion) want.fill(0.8);
    if (this.jump.holding && this.jump.holdT < P.JUMP_HOLD_T && !this.grounded) want.fill(0.7);
    if (!this.grounded && !this.dodge.active && !this.tumbling) {
      // air control: nozzles push the car the way the stick asks
      const p = s.pitch, r = s.roll;
      if (p > 0.1) { want[4] = Math.max(want[4], p * 0.6); want[5] = Math.max(want[5], p * 0.6); }
      if (p < -0.1) { want[0] = Math.max(want[0], -p * 0.6); want[1] = Math.max(want[1], -p * 0.6); }
      if (r > 0.1) for (const i of [0, 2, 4]) want[i] = Math.max(want[i], r * 0.55);
      if (r < -0.1) for (const i of [1, 3, 5]) want[i] = Math.max(want[i], -r * 0.55);
      if (s.yaw > 0.1) { want[5] = Math.max(want[5], s.yaw * 0.3); want[0] = Math.max(want[0], s.yaw * 0.3); }
      if (s.yaw < -0.1) { want[4] = Math.max(want[4], -s.yaw * 0.3); want[1] = Math.max(want[1], -s.yaw * 0.3); }
    }
    if (this.dodge.active && this.dodge.t < 0.25) {
      const d = this.dodge;
      if (d.spin.x > 1) { want[4] = want[5] = 1; }
      if (d.spin.x < -1) { want[0] = want[1] = 1; }
      if (d.spin.z > 1) { want[0] = want[2] = want[4] = 1; }
      if (d.spin.z < -1) { want[1] = want[3] = want[5] = 1; }
      rear = Math.max(rear, d.spin.x > 1 ? 0.5 : 0);
    }
    for (let i = 0; i < 6; i++) {
      J.burst[i] = damp(J.burst[i], 0, 5, dt);
      const target = Math.max(want[i], J.burst[i]);
      down[i] = damp(down[i], target, target > down[i] ? 24 : 9, dt);
    }
    J.rear = damp(J.rear, rear, rear > J.rear ? 20 : 8, dt);
  }

  // --- stunt recognition ----------------------------------------------------------------

  trackStunts(dt, s) {
    const st = this.st, cb = this.cb;
    const FULL = Math.PI * 2 * 0.92;
    if (!this.grounded) {
      // integrate body rotation in the car frame; each full turn is a move the moment it completes
      _w.copy(this.w).applyQuaternion(_q.copy(this.q).invert());
      st.roll += _w.z * dt;
      st.pitch += _w.x * dt;
      st.yaw += _w.y * dt;
      cb.r += _w.z * dt;
      cb.p += _w.x * dt;
      cb.y += _w.y * dt;
      if (Math.abs(cb.r) >= FULL) { this.addMove('barrelroll'); cb.r -= Math.sign(cb.r) * Math.PI * 2; }
      if (cb.p <= -FULL) { this.addMove('backflip'); cb.p += Math.PI * 2; if (!this.jump.fromWall) this.events.push({ type: 'stunt', name: 'kickflip' }); }
      if (cb.p >= FULL) { this.addMove('frontflip'); cb.p -= Math.PI * 2; }
      if (Math.abs(cb.y) >= FULL) { this.addMove('spin'); cb.y -= Math.sign(cb.y) * Math.PI * 2; }
      if (this.hovering) cb.hoverT += dt; else cb.hoverT = Math.max(0, cb.hoverT - dt * 0.5);
      if (cb.hoverT > 1.2 && !cb.hoverDone) { cb.hoverDone = true; this.addMove('hover'); }
      cb.maxH = Math.max(cb.maxH, this.pos.y - this.groundY);
      cb.wallT = 0;
      cb.invT = 0;
      cb.groundT = 0;
    } else if (this.sup.kind !== 'ground') {
      // riding a wall or hanging from the ceiling keeps the chain alive
      cb.wallT += dt;
      if (cb.wallT > 0.5 && !cb.wallDone) { cb.wallDone = true; this.addMove('wallride'); }
      if (this.sup.n.y < -0.45 && Math.abs(this.vf) < 1.2) {
        cb.invT += dt;
        if (cb.invT > 0.8 && !cb.invDone) { cb.invDone = true; this.addMove('inverted'); }
      } else cb.invT = 0;
      cb.groundT = 0;
      cb.hoverDone = false;
    } else {
      // flat ground: a short grace to jump straight back into the chain, then it banks
      cb.wallT = 0;
      cb.wallDone = false;
      cb.invT = 0;
      cb.invDone = false;
      cb.hoverDone = false;
      if (cb.active && !this.macro) {
        cb.groundT += dt;
        if (cb.groundT > 0.6) this.bankCombo('landed');
      }
    }
    for (const e of this.events.slice()) {
      if (e.type === 'damage' && e.amount > 2 && cb.active) this.bankCombo('dropped');
      if (e.type !== 'touchdown') continue;
      const roll = Math.abs(st.roll), pitch = Math.abs(st.pitch);
      const dx = this.pos.x - this.jump.takeoff.x, dz = this.pos.z - this.jump.takeoff.z;
      const dist = Math.hypot(dx, dz);
      const airT = this.jump.airT;
      if (e.kind !== 'ground') {
        // wheels onto a wall mid-flight: a flip reset (from the ground) or wall-to-wall (from a wall)
        if (airT > 0.3) this.addMove(this.jump.fromWall ? 'walltowall' : 'flipreset');
      } else {
        if (this.jump.fromWall && roll + pitch > 1.3 && airT > 0.6) this.addMove('walllaunch');
        else if (roll > Math.PI * 1.7 && dist < 4.5 && dist > 0.6 && airT < 2.2) this.addMove('parallel');
        if (this.time - cb.lastDodge < 0.35 && cb.dodgeF > 0.5 && e.vn < 10) this.addMove('wavedash');
        if (airT > 2.5) this.addMove('bigair');
        if (cb.maxH > 25) this.addMove('highflyer');
      }
      st.roll = st.pitch = st.yaw = 0;
      cb.r = cb.p = cb.y = 0;
      cb.maxH = 0;
      cb.hoverT = 0;
    }
    // supersonic
    if (this.speed > P.SUPERSONIC && !st.superDone) { st.superDone = true; this.events.push({ type: 'stunt', name: 'supersonic' }); }
    if (this.speed < 40) st.superDone = false;
    // 0-60 timer: starts from rest with throttle, stops at 60 mph
    const sx = st.sixty;
    if (!sx.on && this.grounded && this.speed < 0.3 && (s.throttle > 0.5 || this.boosting)) { sx.on = true; sx.t = 0; sx.done = false; }
    if (sx.on) {
      sx.t += dt;
      if (this.speed >= P.SIXTY) { sx.on = false; sx.done = true; this.events.push({ type: 'sixty', t: sx.t }); }
      else if (s.throttle < 0.3 && !this.boosting || sx.t > 6) sx.on = false;
    }
  }

  // --- scripted manoeuvres (the demo moves, driven through the same physics) ---------------

  // Scripted stunts from the McGregor show. They feed the same pitch, yaw and roll inputs a
  // driver would, through a small orientation controller, so they obey the air-control physics.
  // From the ground they run the show's version; in the air they spend the second jump as the
  // matching Rocket League dodge (kickflip = backflip, parallel = side flip) so moves chain.
  startMacro(name, side) {
    if (this.tumbling || this.macro) return false;
    if (!this.grounded) {
      if (name === 'launch') {
        const base = { throttle: 0, brake: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, airRoll: false, jump: false, jumpHit: false, boost: false };
        _d.set(this.fwd.x, 0, this.fwd.z);
        if (_d.lengthSq() < 0.01) _d.set(0, 0, 1);
        this.macro = { name, t: 0, side: side || 1, s: { ...base }, phase: 2, dir: _d.clone().normalize() };
        return true;
      }
      if (!this.jump.canDouble || (!this.jump.free && this.jump.t >= P.DOUBLE_T) || this.dodge.active) return false;
      if (name === 'kickflip') this.startDodge(-1, 0, 1);
      else this.startDodge(0, side || 1, 1);
      this.jump.canDouble = false;
      this.jump.holding = false;
      return true;
    }
    const base = { throttle: 0, brake: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, airRoll: false, jump: false, jumpHit: false, boost: false };
    this.macro = { name, t: 0, side: side || 1, s: { ...base }, phase: 0, dir: new THREE.Vector3(0, 0, 1) };
    return true;
  }

  // A first jump at a chosen speed: the show's hops are smaller than a Rocket League jump.
  hop(v) {
    const j = this.jump;
    this.vel.addScaledVector(this.up, v);
    j.t = 0;
    j.airT = 0;
    j.canDouble = true;
    j.holding = false;
    j.holdT = 0;
    j.fromWall = this.sup.kind !== 'ground';
    j.takeoff.copy(this.pos);
    this.leaveSurface();
    this.burstAll(1);
    this.events.push({ type: 'jump' });
    this.st.roll = this.st.pitch = this.st.yaw = 0;
  }

  runMacro(dt, live) {
    const m = this.macro;
    const s = m.s;
    m.t += dt;
    s.jumpHit = false;
    s.throttle = live.throttle;
    s.brake = live.brake;
    s.steer = live.steer;
    s.boost = live.boost;
    if (m.name === 'kickflip') {
      // the demo kickflip: launch straight up on the floor thrusters, one backflip, land on the wheels
      if (m.phase === 0) { s.jumpHit = true; s.jump = true; m.phase = 1; }
      else if (m.phase === 1 && m.t > 0.36) {
        m.phase = 2;
        s.jump = false;
        if (this.jump.canDouble) { this.startDodge(-1, 0, 0.15); this.jump.canDouble = false; }
      } else if (m.phase === 2) { s.jump = false; if (this.grounded && m.t > 1) this.macro = null; }
      if (m.t > 4) this.macro = null;
    } else if (m.name === 'parallel') {
      // the demo's parallel park: a low hop, one sideways barrel roll, down one car-width over
      if (m.phase === 0) { this.hop(9.5); m.phase = 1; }
      else if (m.phase === 1 && m.t > 0.06) {
        m.phase = 2;
        if (this.jump.canDouble) { this.startDodge(0, m.side, 0.16); this.jump.canDouble = false; }
      } else if (m.phase === 2 && this.grounded && m.t > 0.6) this.macro = null;
      if (m.t > 4) this.macro = null;
    } else if (m.name === 'launch') {
      // the wall launch: push off the wall, pitch over until the wheels face the sky with the nose
      // pointing away from the wall, then half a barrel roll onto the wheels, landing facing away
      if (m.phase === 0) {
        _d.set(this.up.x, 0, this.up.z).addScaledVector(_f.set(this.fwd.x, 0, this.fwd.z), 0.5);
        if (_d.lengthSq() < 0.01) _d.set(this.fwd.x, 0, this.fwd.z);
        if (_d.lengthSq() < 0.01) _d.set(0, 0, -1);
        m.dir.copy(_d).normalize();
        this.hop(P.JUMP_V);
        this.vel.y += 4; // the floor thrusters lob it a little for air time
        m.phase = 1;
      } else if (m.phase === 1) {
        this.aim(s, m.dir, DOWN, m.side);
        if (m.t > 0.25 && ((this.up.y < -0.8 && this.fwd.dot(m.dir) > 0.8) || m.t > 1.1)) m.phase = 2;
      } else if (m.phase === 2) {
        this.aim(s, m.dir, UP, m.side);
      }
      if (this.grounded && m.t > 0.8) this.macro = null;
      if (m.t > 5 || this.tumbling) this.macro = null;
    } else this.macro = null;
  }

  // Air-control inputs that turn the car toward a target heading and roof direction, with
  // Rocket League's torques and damping doing the work. A half roll is ambiguous, so `side`
  // picks which way round.
  aim(s, fwdT, upT, side) {
    _l.crossVectors(upT, fwdT);
    if (_l.lengthSq() < 1e-6) _l.crossVectors(upT, _f.set(fwdT.z, 0, -fwdT.x));
    _l.normalize();
    _u.crossVectors(fwdT, _l).normalize();
    _q2.setFromRotationMatrix(_m4.makeBasis(_l, _u, _d.crossVectors(_l, _u)));
    _q.copy(this.q).invert();
    _w.copy(this.w).applyQuaternion(_q); // angular velocity in the car frame
    _q.multiply(_q2); // rotation still needed, in the car frame
    if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
    const ang = 2 * Math.acos(clamp(_q.w, -1, 1));
    const sn = Math.sqrt(Math.max(0, 1 - _q.w * _q.w));
    let ex = 0, ey = 0, ez = 0;
    if (sn > 1e-5) { ex = (_q.x / sn) * ang; ey = (_q.y / sn) * ang; ez = (_q.z / sn) * ang; }
    if (ang > 2.8 && Math.abs(ez) > Math.abs(ex) + Math.abs(ey)) ez = Math.abs(ez) * (side || 1);
    s.pitch = clamp(3 * ex - 0.6 * _w.x, -1, 1);
    s.yaw = clamp(-(3 * ey - 0.6 * _w.y), -1, 1);
    s.roll = clamp(3 * ez - 0.6 * _w.z, -1, 1);
    s.airRoll = false;
  }

}
