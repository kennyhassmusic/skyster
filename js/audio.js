// Synthesised sound: electric-motor whine, wind, cold-gas hiss, impacts, pickups and the explosion.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.warn = 0;
    this.fuelRank = 0; // 2 combustion tech, 3 rocket fuel: the boosters roar as well as hiss
    // a game left open in a background tab or a hidden pane goes silent, and picks up again when shown
    const sync = () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') this.ctx.suspend?.();
      else this.ctx.resume?.();
    };
    document.addEventListener('visibilitychange', sync);
    addEventListener('pagehide', () => this.ctx?.suspend?.());
    addEventListener('pageshow', sync);
  }

  start() {
    if (this.ctx) {
      this.ctx.resume?.();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = noise;
    const loop = (filterType, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      return { f, g };
    };
    const osc = (type, freq) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.start();
      return o;
    };

    this.motorF = ctx.createBiquadFilter();
    this.motorF.type = 'lowpass';
    this.motorF.frequency.value = 900;
    this.motorF.Q.value = 5;
    this.motorG = ctx.createGain();
    this.motorG.gain.value = 0;
    this.motorA = osc('sawtooth', 50);
    this.motorB = osc('sine', 100);
    this.motorA.connect(this.motorF);
    this.motorB.connect(this.motorF);
    this.motorF.connect(this.motorG).connect(this.master);
    this.whine = osc('sine', 700);
    this.whineG = ctx.createGain();
    this.whineG.gain.value = 0;
    this.whine.connect(this.whineG).connect(this.master);
    this.wind = loop('bandpass', 500, 0.7);
    this.hiss = loop('highpass', 2200, 0.5);
    this.fan = loop('bandpass', 180, 2);
    this.fire = loop('lowpass', 240, 0.4);
    this.roar = loop('lowpass', 180, 0.9);
  }

  setFuel(rank) {
    this.fuelRank = rank;
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  update(v, throttle, dt) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, sp = v.speed;
    const load = v.grounded ? throttle : 0.3;
    const alive = v.alive ? 1 : 0;
    this.motorA.frequency.setTargetAtTime(40 + sp * 3.2, t, 0.05);
    this.motorB.frequency.setTargetAtTime(80 + sp * 6.4, t, 0.05);
    this.motorG.gain.setTargetAtTime((0.03 + 0.1 * load) * alive, t, 0.08);
    this.whine.frequency.setTargetAtTime(600 + sp * 22, t, 0.05);
    this.whineG.gain.setTargetAtTime((0.008 + Math.min(sp / 100, 1) * 0.025 * (0.4 + load)) * alive, t, 0.08);
    this.wind.g.gain.setTargetAtTime(Math.min(1, (sp / 80) ** 2) * 0.32 * alive, t, 0.1);
    this.wind.f.frequency.setTargetAtTime(300 + sp * 12, t, 0.1);
    let down = 0;
    for (let i = 0; i < 6; i++) down = Math.max(down, v.jets.down[i]);
    this.hiss.g.gain.setTargetAtTime(Math.min(0.55, v.jets.rear * 0.26 + down * 0.3) * alive, t, 0.03);
    const roar = this.fuelRank >= 3 ? 0.42 : this.fuelRank === 2 ? 0.24 : 0;
    this.roar.g.gain.setTargetAtTime(Math.min(0.5, v.jets.rear * roar + down * roar * 0.4) * alive, t, 0.05);
    this.roar.f.frequency.setTargetAtTime(130 + v.jets.rear * (this.fuelRank >= 3 ? 320 : 200), t, 0.08);
    this.fan.g.gain.setTargetAtTime(v.fans * 0.08 * alive, t, 0.2);
    this.fan.f.frequency.setTargetAtTime(150 + v.fans * 400, t, 0.3);
    const burning = v.health < 18 && v.alive ? 1 : 0;
    this.fire.g.gain.setTargetAtTime(burning * 0.18, t, 0.3);
    // critical hull warning beep
    if (v.health < 25 && v.alive) {
      this.warn += dt;
      if (this.warn > 0.9) { this.warn = 0; this.beep(880, 0.08, 0.06); }
    }
  }

  beep(freq, len, vol) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  // boost pad: a quick rising two-tone
  ding(big) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(big ? 520 : 760, t);
    o.frequency.exponentialRampToValueAtTime(big ? 1040 : 1140, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(big ? 0.25 : 0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (big ? 0.35 : 0.18));
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
  }

  // Supercharger: a soft chord
  charge() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [f, dl] of [[392, 0], [494, 0.08], [587, 0.16]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dl);
      g.gain.exponentialRampToValueAtTime(0.16, t + dl + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dl + 0.5);
      o.connect(g).connect(this.master);
      o.start(t + dl);
      o.stop(t + dl + 0.55);
    }
  }

  // cold-gas pop for a jump or a dodge
  pop(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(2600, t);
    f.frequency.exponentialRampToValueAtTime(600, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.min(0.6, 0.25 + strength * 0.3), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.3);
  }

  thump(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.8, 0.15 + strength * 0.03), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
    if (strength > 12) this.crunch(strength);
  }

  crunch(strength) {
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(200, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.5, strength * 0.015), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
  }

  explode() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3000, t);
    f.frequency.exponentialRampToValueAtTime(80, t + 2.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 2.5);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(60, t);
    o.frequency.exponentialRampToValueAtTime(25, t + 1.2);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.8, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    o.connect(g2).connect(this.master);
    o.start(t);
    o.stop(t + 1.5);
  }
}
