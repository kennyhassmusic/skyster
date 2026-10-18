import { clamp } from './util.js?v=3.9';

// Rocket League's default bindings on an Xbox pad and on keyboard + mouse, merged into one state.
//   Pad:  RT throttle · LT reverse · left stick steer / air pitch+yaw · A jump · B boost
//         X powerslide + air roll (hold, steer to roll) · LB (hold, in the air) flight mode · RB air roll right
//         Y camera · right stick look · RS click rear view · Menu pause · View respawn
//   Keys: W/S throttle + pitch · A/D steer + yaw · right mouse jump · left mouse boost
//         Left Shift powerslide + air roll · Q/E air roll · Space camera · C or middle mouse rear view
// "Classic" swaps the keyboard to Space jump / Shift boost / Ctrl powerslide for people who want it.
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const GAME_KEYS = new Set(['KeyF', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyQ', 'KeyE', 'KeyC', 'KeyV', 'KeyH', 'KeyG', 'KeyT', 'KeyN', 'KeyR', 'KeyM',
  'Digit1', 'Digit2', 'Digit3', 'Tab', 'F9']);
const DEAD = 0.2; // Rocket League's default controller deadzone

// little-endian bit field out of a HID report payload
const readBits = (dv, bit, size) => {
  let v = 0;
  for (let i = 0; i < size; i++) {
    const b = bit + i, byte = b >> 3;
    if (byte >= dv.byteLength) break;
    v += ((dv.getUint8(byte) >> (b & 7)) & 1) * 2 ** i;
  }
  return v;
};

export class Input {
  constructor(target) {
    this.target = target;
    this.down = new Set();
    this.hit = new Set();
    this.prev = [];
    this.now = [];
    this.mdx = 0;
    this.mdy = 0;
    this.mb = [false, false, false];
    this.mbHit = [false, false, false];
    this.locked = false;
    this.lockLost = false;
    this.layout = 'rl'; // 'rl' | 'classic'
    this.bumpers = 'roll'; // 'roll' (LB/RB air roll, what most RL players bind) | 'rl' (RL's shipped RB rear view, LB scoreboard)
    this.pitchStick = 'auto'; // 'auto' (left stick; the right stick fills in when the left's up/down is dead or glitching) | 'left' | 'right' | 'dpad'
    this.cal = { seen: false, rest: [0, 0, 0, 0], first: [0, 0, 0, 0], last: [0, 0, 0, 0], still: [0, 0, 0, 0], decided: [false, false, false, false], age: 0, t: 0, noticed: false, faulty: [false, false, false, false], masked: [false, false, false, false], snaps: [0, 0, 0, 0], faultNew: false };
    this.notice = null;
    this.hid = null; // direct WebHID read of the left stick's Y axis, when the browser's mapping of it is wrong
    this.device = 'keyboard';
    this.s = {};
    addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.hit.add(e.code);
      this.down.add(e.code);
      this.device = 'keyboard';
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => {
      this.down.clear();
      this.mb = [false, false, false];
    });
    target.addEventListener('pointerdown', (e) => {
      if (e.button >= 0 && e.button < 3) {
        this.mb[e.button] = true;
        this.mbHit[e.button] = true;
      }
      this.device = 'keyboard';
      if (!this.locked && this.wantLock) target.requestPointerLock?.();
    });
    addEventListener('pointerup', (e) => {
      if (e.button >= 0 && e.button < 3) this.mb[e.button] = false;
    });
    addEventListener('pointermove', (e) => {
      if (this.locked || this.mb[0] && this.layout === 'classic') {
        this.mdx += e.movementX;
        this.mdy += e.movementY;
      }
    });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === target;
      if (was && !this.locked) this.lockLost = true; // Esc in the browser releases the mouse: treat as pause
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    this.wantLock = false;
    // browsers only reveal a pad after a button press on it; remember what we saw
    this.padId = '';
    this.padEvent = 0; // +1 connected, -1 disconnected, consumed by the game loop
    addEventListener('gamepadconnected', (e) => {
      this.padId = e.gamepad.id || 'Controller';
      this.padEvent = 1;
      this.device = 'pad';
      this.cal.seen = false; // capture the rest position fresh
      this.cal.noticed = false;
    });
    addEventListener('gamepaddisconnected', (e) => {
      if (!this.pad()) {
        this.padId = '';
        this.padEvent = -1;
        this.device = 'keyboard';
      }
    });
    // Edge on Xbox treats the controller as a mouse unless the page opts out.
    try { navigator.gamepadInputEmulation = 'gamepad'; } catch (_) { /* not Edge on Xbox */ }
  }

  pad() {
    let list = [];
    try { list = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : []; } catch (_) { /* blocked by the frame */ }
    return list.find((p) => p.mapping === 'standard' && p.connected) || list[0] || null;
  }

  // Short human name for the connected pad, or '' when none has been seen.
  padName() {
    const p = this.pad();
    if (!p && !this.padId) return '';
    const id = (p && p.id) || this.padId;
    if (/xbox|045e|xinput/i.test(id)) return 'Xbox controller';
    if (/playstation|dualsense|dualshock|054c/i.test(id)) return 'PlayStation controller';
    if (/switch|057e/i.test(id)) return 'Switch controller';
    return 'Controller';
  }

  release() {
    this.wantLock = false;
    if (this.locked) document.exitPointerLock?.();
  }

  capture() {
    this.wantLock = true;
  }

  // Stick calibration. The game, not the controller, deals with drift: the resting position of
  // each axis is captured when the pad first shows up (and on Recalibrate), slowly tracked while
  // the stick sits still near its rest, and an axis that rests more than half-way to its stop is
  // treated as unusable rather than as a permanent input. Pitch falls back to the right stick
  // when the left stick's up/down is out.
  calibrate(raw) {
    const now = performance.now() / 1000;
    const c = this.cal;
    if (!c.seen) {
      c.seen = true;
      c.rest = [0, 0, 0, 0];
      c.first = raw.slice(0, 4);
      c.last = raw.slice(0, 4);
      c.still = [0, 0, 0, 0];
      c.decided = [false, false, false, false];
      c.faulty = [false, false, false, false];
      c.masked = [false, false, false, false];
      c.snaps = [0, 0, 0, 0];
      c.age = 0;
      c.t = now;
      return;
    }
    const dt = Math.min(0.1, now - c.t);
    c.t = now;
    c.age += dt;
    for (let i = 0; i < 4; i++) {
      const v = raw[i] ?? 0;
      const prev = c.last[i];
      const jump = Math.abs(v - prev);
      if (jump < 0.02) c.still[i] += dt; else c.still[i] = 0;
      c.last[i] = v;
      // a failing potentiometer snaps to full travel and back between two polls with nothing in
      // between; a thumb never moves a stick that far in one frame. two snaps mark the axis as
      // glitchy, and from then on a reading at the stop is dropped unless the stick was seen
      // travelling there
      const atRail = Math.abs(v) >= 0.98, wasAtRail = Math.abs(prev) >= 0.98;
      if (dt <= 0.035 && jump >= 0.9 && (atRail || wasAtRail)) {
        c.snaps[i]++;
        if (c.snaps[i] >= 2 && !c.faulty[i]) { c.faulty[i] = true; c.faultNew = true; }
      }
      if (c.faulty[i]) {
        // trusted only if the stick was already well on its way to that same stop last frame
        const travelled = Math.sign(prev) === Math.sign(v) && Math.abs(prev) >= 0.6;
        if (atRail) { if (!wasAtRail && !travelled) c.masked[i] = true; }
        else c.masked[i] = false;
      }
      if (!c.decided[i]) {
        // an axis is judged once: near centre at any point means it is alive (its rest is wherever it
        // sits, or 0 if it is being pushed); pinned past half travel and motionless for 1.5 s means
        // it is out of service; pushed hard but moving means a hand is on it, so it is alive too
        if (Math.abs(v) <= 0.5) { c.decided[i] = true; c.rest[i] = Math.abs(v) < 0.35 ? v : 0; }
        else if (c.age > 1.5) { c.decided[i] = true; c.rest[i] = Math.abs(v - c.first[i]) < 0.05 ? v : 0; }
        continue;
      }
      // an axis retired at first sight that later reads near centre is alive after all, just glitchy
      if (Math.abs(c.rest[i]) > 0.5 && Math.abs(v - c.rest[i]) > 0.6) {
        c.rest[i] = 0;
        if (!c.faulty[i]) { c.faulty[i] = true; c.faultNew = true; }
        c.masked[i] = atRail;
        continue;
      }
      // a stick parked for a while near where we think it rests: that is its rest (drift tracking)
      if (c.still[i] > 2 && Math.abs(v - c.rest[i]) < 0.35) c.rest[i] += (v - c.rest[i]) * 0.02;
    }
  }

  recalibrate() {
    const p = this.pad();
    if (!p) return false;
    this.cal.rest = [0, 1, 2, 3].map((i) => p.axes[i] ?? 0);
    this.cal.still = [0, 0, 0, 0];
    this.cal.decided = [true, true, true, true];
    this.cal.faulty = [false, false, false, false];
    this.cal.masked = [false, false, false, false];
    this.cal.snaps = [0, 0, 0, 0];
    this.cal.noticed = false;
    return true;
  }

  // Direct read of the left stick's up/down over WebHID, bypassing the browser's gamepad mapping:
  // the last resort when the mapped axis is wrong but the controller itself may be fine. The
  // field's place in the report comes from the controller's own descriptor (the Generic Desktop
  // Y usage), so nothing here is specific to one controller.
  async connectHid() {
    if (!navigator.hid) return { ok: false, why: 'this browser has no direct controller access (Chrome has)' };
    let devs = [];
    try { devs = await navigator.hid.requestDevice({ filters: [{ usagePage: 0x01, usage: 0x05 }, { vendorId: 0x045e }] }); }
    catch (e) { return { ok: false, why: /SecurityError|NotAllowedError/.test(e.name) ? 'direct access is blocked on this page' : (e.message || e.name) }; }
    const d = devs[0];
    if (!d) return { ok: false, why: 'no controller offered: this app has no device chooser, try the game in Chrome' };
    try { if (!d.opened) await d.open(); } catch (e) { return { ok: false, why: `could not open ${d.productName || 'it'}: ${e.message || e.name}` }; }
    const field = this.findHidField(d, 0x01, 0x31);
    if (!field) { try { await d.close(); } catch (_) { /* nothing to do */ } return { ok: false, why: `${d.productName || 'the controller'} reports no stick Y axis` }; }
    const h = { dev: d, field, y: null, raw: null, reports: 0 };
    d.addEventListener('inputreport', (e) => {
      if (e.reportId !== field.reportId) return;
      let raw = readBits(e.data, field.bit, field.size);
      if (field.min < 0 && raw >= 2 ** (field.size - 1)) raw -= 2 ** field.size; // signed field
      h.raw = raw;
      h.reports++;
      h.y = clamp(((raw - field.min) / (field.max - field.min)) * 2 - 1, -1, 1);
    });
    this.hid = h;
    const c = this.cal; // the mapped axis's verdict no longer applies
    c.rest[1] = 0; c.decided[1] = true; c.faulty[1] = false; c.masked[1] = false; c.snaps[1] = 0; c.noticed = false;
    return { ok: true, name: d.productName || 'controller', field };
  }

  findHidField(dev, page, usage) {
    const want = (page << 16) | usage;
    const walk = (cols) => {
      for (const col of cols || []) {
        for (const rep of col.inputReports || []) {
          let bit = 0;
          for (const it of rep.items || []) {
            const n = it.reportCount || 1, sz = it.reportSize || 0;
            if (!it.isConstant) {
              const usages = it.isRange ? Array.from({ length: n }, (_, k) => it.usageMinimum + k) : (it.usages || []);
              const idx = usages.indexOf(want);
              if (idx >= 0) return { reportId: rep.reportId, bit: bit + idx * sz, size: sz, min: it.logicalMinimum, max: it.logicalMaximum };
            }
            bit += n * sz;
          }
        }
        const r = walk(col.children);
        if (r) return r;
      }
      return null;
    };
    return walk(dev.collections);
  }

  // Axis value with the rest offset removed; an axis resting beyond 0.5 is out of service.
  axis(i, raw) {
    const r = this.cal.rest[i] || 0;
    if (Math.abs(r) > 0.5 || this.cal.masked[i]) return 0;
    const v = (raw[i] ?? 0) - r;
    const span = v > 0 ? 1 - r : 1 + r; // what is left of the travel on that side
    return clamp(span > 0.2 ? v / span : v, -1, 1);
  }

  axisDead(i) {
    return Math.abs(this.cal.rest[i] || 0) > 0.5;
  }

  axisFaulty(i) {
    return !!this.cal.faulty[i];
  }

  padInfo() {
    const p = this.pad();
    return p ? { id: p.id, mapping: p.mapping, axes: p.axes.length, buttons: p.buttons.length, rest: this.cal.rest.map((v) => +v.toFixed(2)), dead: [0, 1, 2, 3].map((i) => this.axisDead(i)), faulty: this.cal.faulty.slice(), snaps: this.cal.snaps.slice(), hid: this.hid ? { reports: this.hid.reports, raw: this.hid.raw, y: this.hid.y } : null } : null;
  }

  update(airborne) {
    const p = this.pad();
    this.prev = this.now;
    this.now = p ? p.buttons.map((b) => b.pressed) : [];
    const val = (i) => (p && p.buttons[i] ? p.buttons[i].value : 0);
    const on = (i) => !!this.now[i];
    const hitPad = (i) => !!this.now[i] && !this.prev[i];
    const rawAx = p ? [0, 1, 2, 3].map((i) => (p.axes[i] !== undefined ? p.axes[i] : 0)) : [0, 0, 0, 0];
    if (p && this.hid && this.hid.y !== null) rawAx[1] = this.hid.y; // the direct read replaces the mapped axis
    if (p) this.calibrate(rawAx);
    const ax = (i) => (p ? this.axis(i, rawAx) : 0);
    const stick = (x, y) => {
      const m = Math.hypot(x, y);
      if (m < DEAD) return [0, 0];
      const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
      return [x * k, y * k];
    };
    const [lx, ly0] = stick(ax(0), ax(1));
    const [rx, ry] = stick(ax(2), ax(3));
    // pitch comes from the left stick; if that axis is out, the right stick's up/down takes over
    // which sticks pitch: the left by default; the right fills in when the left's up/down is retired
    // or glitching (or is chosen outright); the D-pad's up/down is a digital alternative
    const leftBad = !!p && (this.axisDead(1) || this.axisFaulty(1));
    const rightPitch = this.pitchStick === 'right' || (this.pitchStick === 'auto' && leftBad && !this.axisDead(3));
    const leftPitch = this.pitchStick === 'auto' || this.pitchStick === 'left';
    // the D-pad's up/down pitches when chosen, and on its own whenever the stick's up/down is not reporting
    const dpadPitch = this.pitchStick === 'dpad' || (this.pitchStick === 'auto' && leftBad);
    const dpLy = dpadPitch ? (on(B.DOWN) ? 1 : 0) - (on(B.UP) ? 1 : 0) : 0; // D-pad down = stick back = nose up
    const ly = clamp((leftPitch ? ly0 : 0) + (rightPitch ? ry : 0) + dpLy, -1, 1);
    if (p && this.cal.faultNew) {
      this.cal.faultNew = false;
      const names = ['left stick left/right', 'left stick up/down', 'right stick left/right', 'right stick up/down'];
      const bad = [0, 1, 2, 3].filter((i) => this.axisFaulty(i)).map((i) => names[i]).join(', ');
      this.notice = { text: 'Controller glitch ignored', sub: `${bad} snaps to full travel on its own · those readings are dropped${this.axisFaulty(1) && this.pitchStick === 'auto' ? ' · D-pad down = nose up, up = nose down (the right stick works too)' : ''}` };
    }
    if (p && !this.cal.noticed && [0, 1, 2, 3].some((i) => this.axisDead(i))) {
      this.cal.noticed = true;
      const names = ['left stick left/right', 'left stick up/down', 'right stick left/right', 'right stick up/down'];
      const bad = [0, 1, 2, 3].filter((i) => this.axisDead(i)).map((i) => `${names[i]} (reads ${(this.cal.rest[i] > 0 ? '+' : '') + this.cal.rest[i].toFixed(1)} at rest)`).join(', ');
      this.notice = { text: 'Controller axis ignored', sub: `${bad}${this.axisDead(1) && !this.axisDead(3) ? ' · D-pad down = nose up, up = nose down (the right stick works too)' : ''} · pause → Recalibrate if that is wrong` };
    }
    if (p && (lx || ly || rx || ry || this.now.some(Boolean))) this.device = 'pad';
    // raw pad state for the flight recorder: raw axes as the browser reports them, buttons as a bitmask
    let btn = 0;
    for (let i = 0; i < Math.min(16, this.now.length); i++) if (this.now[i]) btn |= 1 << i;
    this.raw = { lx: rawAx[0], ly: rawAx[1], rx: rawAx[2], ry: rawAx[3], btn, rt: val(B.RT), lt: val(B.LT) };
    const k = (c) => (this.down.has(c) ? 1 : 0);
    const kh = (c) => this.hit.has(c);
    const rl = this.layout === 'rl';
    const s = this.s;

    const kJump = rl ? this.mb[2] : k('Space') > 0;
    const kJumpHit = rl ? this.mbHit[2] : kh('Space');
    const kBoost = rl ? this.mb[0] : k('ShiftLeft') + k('ShiftRight') > 0;
    const kSlide = rl ? k('ShiftLeft') + k('ShiftRight') > 0 : k('ControlLeft') + k('ControlRight') > 0;
    const kCamHit = rl ? kh('Space') : kh('KeyV');

    s.throttle = Math.max(val(B.RT), k('KeyW'), k('ArrowUp'));
    s.brake = Math.max(val(B.LT), k('KeyS'), k('ArrowDown'));
    const steerK = k('KeyD') - k('KeyA') + k('ArrowRight') - k('ArrowLeft');
    s.steer = clamp(lx + steerK, -1, 1);
    // stick forward (negative y) = nose down, like Rocket League
    s.pitch = clamp(-ly + k('KeyW') - k('KeyS') + k('ArrowUp') - k('ArrowDown'), -1, 1);
    s.airRoll = on(B.X) || kSlide;
    // Rocket League's shipped Xbox layout leaves directional air roll unbound: RB is rear view
    // and LB the scoreboard. "roll" puts air roll right on RB instead. In the air LB is flight mode
    // in both layouts (air roll left stays on X + stick, or Q).
    const bumperRoll = this.bumpers === 'roll';
    const rollBtn = (bumperRoll && on(B.RB) ? 1 : 0) + k('KeyE') - k('KeyQ');
    if (airborne && s.airRoll && Math.abs(s.steer) > 0.05) {
      // holding air roll turns the steer axis into roll
      s.roll = clamp(s.steer + rollBtn, -1, 1);
      s.yaw = 0;
    } else {
      s.roll = clamp(rollBtn, -1, 1);
      s.yaw = s.steer;
    }
    s.jump = on(B.A) || kJump;
    s.jumpHit = hitPad(B.A) || kJumpHit;
    s.boost = on(B.B) || kBoost;
    s.camHit = hitPad(B.Y) || kCamHit;
    s.rear = on(B.RS) || (!bumperRoll && on(B.RB)) || k('KeyC') > 0 || this.mb[1];
    s.board = (!bumperRoll && !airborne && on(B.LB)) || k('Tab') > 0;
    s.flyHold = (airborne && on(B.LB)) || k('KeyF') > 0; // held in the air: flight mode
    s.resetHit = hitPad(B.VIEW) || kh('KeyR');
    s.pauseHit = hitPad(B.MENU) || kh('Escape') || kh('KeyP') || this.lockLost;
    this.lockLost = false;
    s.kickHit = (!dpadPitch && hitPad(B.UP)) || kh('Digit1');
    s.parkHit = (!dpadPitch && hitPad(B.DOWN)) || kh('Digit2');
    s.launchHit = kh('Digit3') || (airborne && hitPad(B.LEFT)); // D-pad left in the air: landing protocol until touchdown
    s.landHold = (airborne && val(B.LT) > 0.5) || k('KeyL') > 0; // held: landing protocol while held
    s.lightsHit = (!airborne && hitPad(B.LEFT)) || kh('KeyH');
    s.doorsHit = hitPad(B.RIGHT) || kh('KeyG');
    s.wingHit = kh('KeyT');
    s.timeHit = kh('KeyN');
    s.muteHit = kh('KeyM');
    s.replayHit = kh('F9');
    s.confirmHit = hitPad(B.A) || kh('Enter') || kh('Space');
    s.backHit = hitPad(B.B);
    s.navUp = hitPad(B.UP) || kh('ArrowUp') || kh('KeyW');
    s.navDown = hitPad(B.DOWN) || kh('ArrowDown') || kh('KeyS');
    s.lookRateX = rx;
    s.lookRateY = rightPitch ? 0 : ry; // the right stick's up/down is pitch, not camera, in that case
    s.lookDX = this.mdx * 0.0038;
    s.lookDY = this.mdy * 0.003;
    s.looking = Math.abs(rx) + Math.abs(ry) > 0.05 || Math.abs(this.mdx) + Math.abs(this.mdy) > 0;
    this.mdx = this.mdy = 0;
    this.hit.clear();
    this.mbHit = [false, false, false];
  }

  rumble(strong, weak, ms) {
    const p = this.pad();
    this.rumbleUntil = performance.now() + ms;
    try { p?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }); } catch (_) { /* no rumble */ }
  }

  // a background buzz (the speed shake) that never cuts short a landing or a hit
  buzz(weak, ms) {
    if (performance.now() < (this.rumbleUntil || 0)) return;
    const p = this.pad();
    try { p?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: 0, weakMagnitude: weak }); } catch (_) { /* no rumble */ }
  }
}
