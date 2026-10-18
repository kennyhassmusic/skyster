import * as THREE from 'three';

// Soft round particles (cold-gas vapor, tire smoke, dust, fire) and additive sparks.
export class Particles {
  constructor(scene, max, additive) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('pcolor', this.aCol);
    g.setAttribute('psize', this.aSize);
    this.uniforms = { scale: { value: 600 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec4 pcolor; attribute float psize; uniform float scale; varying vec4 vC;
        void main() {
          vC = pcolor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * scale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vC;
        void main() {
          float r = length(gl_PointCoord - 0.5);
          if (r > 0.5) discard;
          gl_FragColor = vec4(vC.rgb, vC.a * smoothstep(0.5, 0.0, r));
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, size, grow, r, g, b, a, drag = 1, grav = 0) {
    const i = this.n < this.max ? this.n++ : Math.floor(Math.random() * this.max);
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([r, g, b, a], i * 4);
    this.size[i] = size;
    this.grow[i] = grow;
    this.life[i] = 0;
    this.maxLife[i] = life;
    this.alpha[i] = a;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  update(dt, viewportHeight, fov, floor = 0.05) {
    this.uniforms.scale.value = viewportHeight / (2 * Math.tan((fov * Math.PI) / 360));
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        this.copy(--this.n, i);
        i--;
        continue;
      }
      const t = this.life[i] / this.maxLife[i];
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(floor, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.col[i * 4 + 3] = this.alpha[i] * (1 - t) * (1 - t);
    }
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.n);
  }

  copy(from, to) {
    if (from === to) return;
    for (let k = 0; k < 3; k++) {
      this.pos[to * 3 + k] = this.pos[from * 3 + k];
      this.vel[to * 3 + k] = this.vel[from * 3 + k];
    }
    for (let k = 0; k < 4; k++) this.col[to * 4 + k] = this.col[from * 4 + k];
    this.size[to] = this.size[from];
    this.grow[to] = this.grow[from];
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.alpha[to] = this.alpha[from];
    this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from];
  }
}

// Taillight streaks at speed: camera-facing ribbon that fades along its length.
export class Trail {
  constructor(scene, color, width, count = 48) {
    this.n = count;
    this.width = width;
    this.color = color;
    this.points = Array.from({ length: count }, () => new THREE.Vector3());
    this.pos = new Float32Array(count * 2 * 3);
    this.col = new Float32Array(count * 2 * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < count - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
    this.strength = 0;
    this.started = false;
    this.tmp = new THREE.Vector3();
    this.side = new THREE.Vector3();
  }

  update(head, camPos, strength) {
    if (!this.started || this.points[0].distanceToSquared(head) > 400) {
      for (const p of this.points) p.copy(head);
      this.started = true;
    }
    for (let i = this.n - 1; i > 0; i--) this.points[i].copy(this.points[i - 1]);
    this.points[0].copy(head);
    this.strength += (strength - this.strength) * 0.15;
    for (let i = 0; i < this.n; i++) {
      const p = this.points[i], q = this.points[Math.min(this.n - 1, i + 1)];
      this.tmp.subVectors(p, q);
      if (this.tmp.lengthSq() < 1e-6) this.tmp.set(0, 0, 1);
      this.side.subVectors(camPos, p).cross(this.tmp).normalize().multiplyScalar(this.width * 0.5);
      this.pos.set([p.x + this.side.x, p.y + this.side.y, p.z + this.side.z, p.x - this.side.x, p.y - this.side.y, p.z - this.side.z], i * 6);
      const a = this.strength * (1 - i / this.n) ** 1.6;
      const c = this.color;
      this.col.set([c.r, c.g, c.b, a, c.r, c.g, c.b, a], i * 8);
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.mesh.visible = this.strength > 0.01;
  }
}

// Loose parts after the explosion: meshes thrown ballistically that tumble and settle.
export class Debris {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.items = [];
    this.g = 25;
  }

  setWorld(w) {
    this.world = w;
  }

  throw(mesh, pos, vel, spin) {
    this.scene.add(mesh);
    mesh.position.copy(pos);
    this.items.push({ mesh, vel: vel.clone(), spin: spin.clone(), t: 0, rest: false });
  }

  clear() {
    for (const d of this.items) this.scene.remove(d.mesh);
    this.items.length = 0;
  }

  update(dt) {
    for (const d of this.items) {
      d.t += dt;
      if (d.rest) continue;
      d.vel.y -= this.g * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      const g = this.world.groundAt(d.mesh.position.x, d.mesh.position.z, d.mesh.position.y) + 0.25;
      if (d.mesh.position.y < g) {
        d.mesh.position.y = g;
        d.vel.y = -d.vel.y * 0.35;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.5);
        if (Math.abs(d.vel.y) < 1.5) { d.rest = true; d.vel.set(0, 0, 0); }
      }
    }
  }
}

// Radial speed blur, chromatic fringe at boost, a vignette, and a red flash when hurt. Runs in linear HDR.
export const SpeedShader = {
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0 },
    aberration: { value: 0 },
    vignette: { value: 0.35 },
    hurt: { value: 0 },
    white: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float amount; uniform float aberration; uniform float vignette; uniform float hurt; uniform float white;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c);
      vec4 col = vec4(0.0);
      for (int i = 0; i < 8; i++) {
        float t = float(i) / 7.0;
        col += texture2D(tDiffuse, 0.5 + c * (1.0 - amount * t * r));
      }
      col /= 8.0;
      if (aberration > 0.0) {
        col.r = mix(col.r, texture2D(tDiffuse, 0.5 + c * (1.0 + aberration * r)).r, 0.7);
        col.b = mix(col.b, texture2D(tDiffuse, 0.5 + c * (1.0 - aberration * r)).b, 0.7);
      }
      col.rgb *= 1.0 - vignette * smoothstep(0.3, 0.95, r);
      col.rgb += vec3(1.0, 0.05, 0.02) * hurt * smoothstep(0.25, 0.9, r);
      col.rgb = mix(col.rgb, vec3(3.0, 2.6, 2.2), white);
      gl_FragColor = col;
    }`,
};
