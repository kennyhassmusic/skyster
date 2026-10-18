import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export const TIMES = ['golden', 'dusk', 'night'];
export const TIME_LABEL = { golden: 'Golden hour', dusk: 'Blue hour', night: 'Midnight' };

// Late-October Chicago: the sun sets in the WSW (azimuth ~250 deg).
const PRESETS = {
  golden: {
    sky: true, elev: 13, azim: -66, turbidity: 5.5, rayleigh: 1.3, mie: 0.005, mieG: 0.85,
    light: '#ffd2a1', intensity: 4.2, hemiSky: '#b9c8e6', hemiGround: '#6b5b4a', hemi: 0.55,
    fog: '#d4b291', fogDensity: 0.00024, exposure: 0.72, night: 0.06, env: 1.0, bloom: 1.7,
  },
  dusk: {
    sky: true, elev: 0.6, azim: -72, turbidity: 9, rayleigh: 3.2, mie: 0.008, mieG: 0.9,
    light: '#ff9a62', intensity: 1.0, hemiSky: '#7186c0', hemiGround: '#2c2a33', hemi: 0.85,
    fog: '#5f6788', fogDensity: 0.00036, exposure: 0.95, night: 0.65, env: 1.0, bloom: 1.4,
  },
  night: {
    sky: false, elev: 38, azim: 40, light: '#a9bcff', intensity: 0.4, hemiSky: '#34415f',
    hemiGround: '#0b0b10', hemi: 0.7, fog: '#0e1323', fogDensity: 0.00042, exposure: 1.05,
    night: 1, env: 0.7, bloom: 1.2,
  },
};

function nightDome(radius) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 top = vec3(0.004, 0.006, 0.018);
        vec3 hor = vec3(0.05, 0.048, 0.07);
        vec3 c = mix(hor, top, smoothstep(0.0, 0.55, h));
        c += vec3(0.2, 0.1, 0.045) * exp(-max(h, 0.0) * 12.0); // sodium glow over the city
        if (h < 0.0) c = hor * 0.6;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat));
  const n = 2400, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
    const y = 0.08 + Math.abs(u) * 0.92, r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * r * radius * 0.95, y * radius * 0.95, Math.sin(a) * r * radius * 0.95], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, color: 0xdfe6ff, fog: false, transparent: true, opacity: 0.85, depthWrite: false })));
  const moon = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.016, 24, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.6, 1.75), fog: false }));
  g.add(moon);
  g.userData.moon = moon;
  g.renderOrder = -1;
  return g;
}

export class Atmosphere {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    scene.add(this.sky);
    this.dome = nightDome(17000);
    scene.add(this.dome);

    this.light = new THREE.DirectionalLight(0xffffff, 3);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    const sc = this.light.shadow.camera;
    sc.left = sc.bottom = -85;
    sc.right = sc.top = 85;
    sc.near = 1;
    sc.far = 1400;
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.05;
    scene.add(this.light, this.light.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    scene.add(this.hemi);
    this.dir = new THREE.Vector3(0, 1, 0);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(90);
    this.envScene.add(this.envSky);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(80, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1c1d20 }));
    ground.position.y = -3;
    this.envScene.add(ground);
    this.envNight = new THREE.Group();
    this.envNight.add(nightDome(85));
    // bright panels standing in for city lights, so the paint picks up streaks at night
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.2;
      const warm = i % 3 !== 0;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(6 + (i % 4) * 3, 2 + (i % 3) * 2),
        new THREE.MeshBasicMaterial({ color: warm ? new THREE.Color(3, 2, 1.1) : new THREE.Color(1.4, 2, 3.2), side: THREE.DoubleSide }));
      panel.position.set(Math.cos(a) * 60, 3 + (i % 5) * 4, Math.sin(a) * 60);
      panel.lookAt(0, panel.position.y, 0);
      this.envNight.add(panel);
    }
    this.envScene.add(this.envNight);
    this.envRT = null;
    this.name = 'golden';
    this.preset = PRESETS.golden;
  }

  set(name, city, car) {
    const P = PRESETS[name];
    this.name = name;
    this.preset = P;
    const el = THREE.MathUtils.degToRad(P.elev), az = THREE.MathUtils.degToRad(P.azim);
    this.dir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    if (P.sky) {
      for (const s of [this.sky, this.envSky]) {
        const u = s.material.uniforms;
        u.turbidity.value = P.turbidity;
        u.rayleigh.value = P.rayleigh;
        u.mieCoefficient.value = P.mie;
        u.mieDirectionalG.value = P.mieG;
        u.sunPosition.value.copy(this.dir);
      }
    }
    this.sky.visible = this.envSky.visible = P.sky;
    this.dome.visible = this.envNight.visible = !P.sky;
    this.dome.userData.moon.position.copy(this.dir).multiplyScalar(16000);
    // keep the key light above the horizon so shadows stay sensible at dusk
    this.lightDir = this.dir.clone();
    if (this.lightDir.y < 0.12) this.lightDir.setY(0.12).normalize();
    this.light.color.set(P.light);
    this.light.intensity = P.intensity;
    this.hemi.color.set(P.hemiSky);
    this.hemi.groundColor.set(P.hemiGround);
    this.hemi.intensity = P.hemi;
    this.scene.fog = new THREE.FogExp2(P.fog, P.fogDensity);
    this.renderer.toneMappingExposure = P.exposure;
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = P.env;
    city.setNight(P.night);
    car.night = P.night;
    return TIME_LABEL[name];
  }

  follow(target, camera) {
    this.light.position.copy(target).addScaledVector(this.lightDir, 600);
    this.light.target.position.copy(target);
    this.dome.position.copy(camera.position);
  }
}
