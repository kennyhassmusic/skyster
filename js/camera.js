import * as THREE from 'three';
import { clamp, damp } from './util.js?v=3.9';

const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();
const _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _d = new THREE.Vector3(), _a = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Smooth shake: three incommensurate sines per channel, so the camera rumbles instead of jittering
// from frame to frame. Roughly -1..1.
const wob = (t, f, ph) => Math.sin(t * f + ph) * 0.5 + Math.sin(t * f * 1.73 + ph * 2.1) * 0.3 + Math.sin(t * f * 2.91 + ph * 3.7) * 0.2;

// Rocket League style car camera: sits behind the car in the car's own frame, so when the car
// drives up a wall the wall becomes "down". In the air it stays behind the nose (yaw and a share
// of the pitch, like RL with ball cam off) so you can see where the car is pointing, holds its
// line through flips and tumbles, widens the lens with speed, and keeps itself out of buildings.
export class CameraRig {
  constructor(camera, world) {
    this.cam = camera;
    this.world = world;
    this.up = new THREE.Vector3(0, 1, 0);
    this.back = new THREE.Vector3(0, 0, -1);
    this.orbitYaw = 0;
    this.orbitElev = 0;
    this.idle = 0;
    this.mode = 0; // 0 chase, 1 far chase, 2 cockpit (driver's eye), 3 bumper
    this.inCockpit = false;
    this.shake = 0;      // knocks: landings, hits, explosions
    this.speedShake = 0; // the rumble that builds with speed
    this.t = 0;
    this.fov = 70;
    this.pos = new THREE.Vector3();
    this.rear = 0;
  }

  setWorld(w) {
    this.world = w;
  }

  cycle() {
    this.mode = (this.mode + 1) % 4;
    return ['Chase', 'Far chase', 'Cockpit', 'Bumper'][this.mode];
  }

  bump(a) {
    this.shake = Math.min(1.2, this.shake + a);
  }

  snap(v) {
    this.up.copy(v.up);
    this.back.copy(v.fwd).negate();
    this.orbitYaw = this.orbitElev = 0;
    this.place(v, 1, 0);
    this.pos.copy(_p);
    this.cam.position.copy(_p);
  }

  place(v, dist, elev) {
    // frame: up = smoothed car up, back = smoothed reverse heading in that plane
    _f.copy(this.back).addScaledVector(this.up, -this.back.dot(this.up));
    if (_f.lengthSq() < 1e-4) _f.set(0, 0, -1);
    _f.normalize();
    _s.crossVectors(this.up, _f).normalize(); // side
    const yaw = this.orbitYaw + (this.rear > 0.5 ? Math.PI : 0);
    _q.setFromAxisAngle(this.up, yaw);
    _f.applyQuaternion(_q);
    _s.applyQuaternion(_q);
    // nose up (back pointing down) swings the camera under the car, looking up along it
    const e = clamp(0.3 + elev + Math.asin(clamp(this.back.dot(this.up), -0.6, 0.6)), -0.75, 1.2);
    _t.copy(v.pos).addScaledVector(v.up, 1.0);
    _p.copy(_t).addScaledVector(_f, Math.cos(e) * dist).addScaledVector(this.up, Math.sin(e) * dist + 0.5);
    return _p;
  }

  update(dt, v, s, car) {
    this.t += dt;
    this.orbitYaw -= s.lookRateX * 2.4 * dt + s.lookDX;
    this.orbitElev = clamp(this.orbitElev + s.lookRateY * 1.6 * dt + s.lookDY, -0.45, 1.1);
    if (s.looking) this.idle = 0;
    else if ((this.idle += dt) > 1.2) {
      this.orbitYaw = damp(this.orbitYaw, 0, 2.5, dt);
      this.orbitElev = damp(this.orbitElev, 0, 2.5, dt);
    }
    this.rear = damp(this.rear, s.rear ? 1 : 0, 30, dt);
    const cam = this.cam;
    const hs = v.vel.length();

    // which way is up and back for the camera frame
    if (v.grounded && !v.tumbling) {
      _u.copy(v.sup.n);
      _f.copy(v.fwd).negate();
    } else {
      _u.copy(UP);
      const hold = v.dodge.active || v.tumbling; // a flip is too fast to chase: keep the line
      if (hold) _f.copy(this.back);
      else {
        _f.copy(v.fwd).negate();
        const hz = Math.hypot(_f.x, _f.z);
        _f.y = clamp(_f.y * 0.55, -0.55, 0.55); // follow part of the pitch, never straight up or down
        if (hz < 0.15) {
          // pointing nearly vertical: keep the last horizontal heading
          const bz = Math.hypot(this.back.x, this.back.z) || 1;
          _f.x = (this.back.x / bz) * 0.6;
          _f.z = (this.back.z / bz) * 0.6;
        }
      }
      if (_f.lengthSq() < 1e-4) _f.set(0, 0, -1);
      _f.normalize();
    }
    const kUp = v.grounded ? 6 : 3;
    const kBack = v.grounded ? 5 : v.dodge.active || v.tumbling ? 1.5 : 6;
    this.up.lerp(_u, 1 - Math.exp(-kUp * dt)).normalize();
    this.back.lerp(_f, 1 - Math.exp(-kBack * dt)).normalize();

    // cockpit: the driver's eye, riding the body's pitch and roll; rear view uses the bumper camera
    this.inCockpit = this.mode === 2 && !!car.cockpit && this.rear < 0.5;
    if (this.inCockpit) {
      car.root.updateMatrixWorld();
      car.cockpit.eyeWorld(_p);
      // the head gives a little to the g-forces: pushed sideways in turns, back under acceleration
      const g = car.cockpit.g;
      _p.addScaledVector(v.left, -clamp(g.x * 0.012, -0.05, 0.05)).addScaledVector(v.fwd, -clamp(g.z * 0.01, -0.05, 0.05));
      // right stick looks around
      _a.copy(v.left).applyAxisAngle(v.up, this.orbitYaw);
      _d.copy(v.fwd).applyAxisAngle(v.up, this.orbitYaw).applyAxisAngle(_a, -(this.orbitElev * 0.8 - 0.05));
      cam.position.copy(_p);
      _t.copy(_p).add(_d);
      _m.lookAt(cam.position, _t, v.up);
      cam.quaternion.setFromRotationMatrix(_m);
      cam.rotateZ(clamp(g.x * 0.008, -0.04, 0.04));
      this.pos.copy(_p);
    } else if (this.mode >= 2) {
      car.root.updateMatrixWorld();
      _p.set(0, 1.02, 0.9).applyMatrix4(car.root.matrixWorld);
      _t.set(0, 0.95, 12).applyMatrix4(car.root.matrixWorld);
      if (this.rear > 0.5) _t.set(0, 0.95, -12).applyMatrix4(car.root.matrixWorld);
      cam.position.copy(_p);
      _m.lookAt(_p, _t, v.up);
      cam.quaternion.setFromRotationMatrix(_m);
      this.pos.copy(_p);
    } else {
      // RL's default camera sits 240 uu back and 90 uu up (9.4 m / 3.5 m at this scale); "far" is the competitive 280
      const dist = (this.mode === 0 ? 9.4 : 11.5) + Math.min(hs * 0.03, 3.5);
      this.place(v, dist, this.orbitElev);
      // slide in toward the car if the camera ended up inside a building
      const tx = v.pos.x, ty = v.pos.y + 1, tz = v.pos.z;
      if (this.world.insideAny(_p.x, _p.y, _p.z)) {
        let lo = 0, hi = 1;
        for (let i = 0; i < 6; i++) {
          const m = (lo + hi) / 2;
          if (this.world.insideAny(tx + (_p.x - tx) * m, ty + (_p.y - ty) * m, tz + (_p.z - tz) * m)) hi = m;
          else lo = m;
        }
        _p.set(tx + (_p.x - tx) * lo, ty + (_p.y - ty) * lo, tz + (_p.z - tz) * lo);
      }
      const g = this.world.groundAt(_p.x, _p.z, _p.y);
      if (_p.y < g + 0.5) _p.y = g + 0.5;
      this.pos.lerp(_p, 1 - Math.exp(-14 * dt));
      cam.position.copy(this.pos);
      _t.copy(v.pos).addScaledVector(this.up, 0.9).addScaledVector(this.back, -2.5);
      _m.lookAt(cam.position, _t, this.up);
      cam.quaternion.setFromRotationMatrix(_m);
    }

    // Speed shake: nothing below ~80 mph, building to a hard rumble past supersonic (217 mph) and
    // under boost. The road shakes hardest; in the air it eases to a light buffet. Two bands: a slow
    // buffet that sways the view and a fast buzz on top.
    const fast = clamp((hs - 35) / 62, 0, 1) ** 1.6;
    const want = v.alive ? fast * (v.grounded ? 1 : 0.45) + (v.boosting ? 0.3 + fast * 0.2 : 0) + (hs > 97 ? 0.25 : 0) : 0;
    this.speedShake = damp(this.speedShake, want, 3, dt);
    const k = this.speedShake, b = this.shake;
    if (k > 0.002 || b > 0.001) {
      const t = this.t;
      const inside = this.mode >= 2; // cockpit and bumper: the camera is bolted to the car
      const posLow = k * (inside ? 0.01 : 0.07) + b * 0.05;
      const posHigh = k * (inside ? 0.005 : 0.022) + b * 0.12;
      const rotLow = k * (inside ? 0.0045 : 0.006) + b * 0.008;
      const rotHigh = k * (inside ? 0.0028 : 0.0025) + b * 0.02;
      cam.translateX(wob(t, 15, 0) * posLow + wob(t, 71, 1) * posHigh);
      cam.translateY(wob(t, 19, 2) * posLow + wob(t, 83, 3) * posHigh);
      cam.rotateX(wob(t, 17, 6) * rotLow * 0.6 + wob(t, 79, 7) * rotHigh);
      cam.rotateZ(wob(t, 13, 4) * rotLow + wob(t, 67, 5) * rotHigh);
      this.shake = damp(this.shake, 0, 5, dt);
    }
    // RL's default FOV is 90 horizontal, competitive 110: about 70 vertical here, widening with speed
    const fov = this.inCockpit ? 72 + clamp(hs * 0.08, 0, 10) + (v.boosting ? 3 : 0) : 70 + clamp(hs * 0.14, 0, 16) + (v.boosting ? 4 : 0);
    // the cabin is within arm's reach: pull the near plane in only while sitting in it
    const near = this.inCockpit ? 0.06 : 0.3;
    if (cam.near !== near) { cam.near = near; cam.updateProjectionMatrix(); }
    this.fov = damp(this.fov, fov, 3, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
