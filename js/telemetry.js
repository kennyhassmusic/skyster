// Flight recorder: the last 90 seconds of inputs, raw pad state and car physics at 10 Hz, plus
// every notable event, so a session can be sent to Claude and replayed on paper.

const KIND = { ground: 0, wall: 1, ramp: 2 };
export const FIELDS = ['t', 'thr', 'brk', 'steer', 'pitch', 'yaw', 'roll', 'airRoll', 'jump', 'boost',
  'lx', 'ly', 'rx', 'ry', 'btn',
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'upx', 'upy', 'upz', 'fwdx', 'fwdz',
  'grounded', 'kind', 'hp', 'tank', 'canDouble', 'dodge', 'tumbling', 'hovering', 'cushion', 'mph', 'macro'];

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

export class Recorder {
  constructor(hz = 10, seconds = 90) {
    this.period = 1 / hz;
    this.max = Math.round(hz * seconds);
    this.hz = hz;
    this.samples = [];
    this.events = [];
    this.marks = [];
    this.acc = 0;
    this.t = 0;
    this.lastSend = -99;
  }

  tick(dt, s, v, raw) {
    this.t += dt;
    this.acc += dt;
    if (this.acc < this.period) return;
    this.acc = 0;
    const btn = raw ? raw.btn : 0;
    this.samples.push([
      r2(this.t), r2(s.throttle || 0), r2(s.brake || 0), r2(s.steer || 0), r2(s.pitch || 0), r2(s.yaw || 0), r2(s.roll || 0),
      s.airRoll ? 1 : 0, s.jump ? 1 : 0, s.boost ? 1 : 0,
      raw ? r2(raw.lx) : 0, raw ? r2(raw.ly) : 0, raw ? r2(raw.rx) : 0, raw ? r2(raw.ry) : 0, btn,
      r1(v.pos.x), r1(v.pos.y), r1(v.pos.z), r1(v.vel.x), r1(v.vel.y), r1(v.vel.z),
      r2(v.up.x), r2(v.up.y), r2(v.up.z), r2(v.fwd.x), r2(v.fwd.z),
      v.grounded ? 1 : 0, KIND[v.sup.kind] ?? 0, Math.round(v.health), Math.round(v.boost),
      v.jump.canDouble ? 1 : 0, v.dodge.active ? 1 : 0, v.tumbling ? 1 : 0, v.hovering ? 1 : 0, v.cushion ? 1 : 0,
      Math.round(v.speed * 2.23694), v.macro ? 1 : 0,
    ]);
    if (this.samples.length > this.max) this.samples.shift();
  }

  event(type, detail) {
    this.events.push([r2(this.t), type, detail === undefined ? '' : detail]);
    if (this.events.length > 600) this.events.shift();
  }

  mark(note) {
    this.marks.push([r2(this.t), note]);
    if (this.marks.length > 40) this.marks.shift();
  }

  dump(meta) {
    const t0 = this.samples.length ? this.samples[0][0] : this.t;
    return {
      ...meta,
      hz: this.hz,
      fields: FIELDS,
      since: t0,
      until: r2(this.t),
      samples: this.samples,
      events: this.events.filter((e) => e[0] >= t0 - 1),
      marks: this.marks.filter((m) => m[0] >= t0 - 1),
    };
  }
}
