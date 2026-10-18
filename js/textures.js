import * as THREE from 'three';
import { rng } from './util.js?v=3.9';

// Every texture is painted procedurally at load, so the game ships no image files.

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function texture(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function grain(g, w, h, amount, rand) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

// One tile = 8 bays x 8 floors. World mapping: 3.2 m per bay, 3.8 m per floor.
export const FACADE_U = 25.6;
export const FACADE_V = 30.4;

function litWindow(ge, rand, x, y, w, h) {
  const warm = rand() < 0.72;
  const b = 0.35 + rand() * 0.65;
  ge.fillStyle = warm
    ? `rgba(255,${(196 + rand() * 40) | 0},${(120 + rand() * 50) | 0},${b})`
    : `rgba(196,222,255,${b})`;
  ge.fillRect(x, y, w, h);
  if (rand() < 0.35) {
    ge.fillStyle = 'rgba(0,0,0,0.55)';
    for (let k = 0; k < h; k += 7) ge.fillRect(x, y + k, w, 2);
  }
}

export function facadeGlass() {
  const S = 1024, N = 8, C = S / N, rand = rng(7);
  const a = canvas(S, S), ga = a.getContext('2d');
  const e = canvas(S, S), ge = e.getContext('2d');
  const r = canvas(S, S), gr = r.getContext('2d');
  ga.fillStyle = '#b4bcc6';
  ga.fillRect(0, 0, S, S);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  gr.fillStyle = '#8c8c8c';
  gr.fillRect(0, 0, S, S);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = i * C, y = j * C;
      ga.fillStyle = '#7f8894';
      ga.fillRect(x, y + C - 24, C, 24);
      const wx = x + 3, wy = y + 3, ww = C - 6, wh = C - 30;
      const l = 14 + rand() * 12, hue = 198 + rand() * 22;
      const grd = ga.createLinearGradient(0, wy, 0, wy + wh);
      grd.addColorStop(0, `hsl(${hue},24%,${l + 14}%)`);
      grd.addColorStop(1, `hsl(${hue},18%,${l}%)`);
      ga.fillStyle = grd;
      ga.fillRect(wx, wy, ww, wh);
      ga.fillStyle = '#b4bcc6';
      ga.fillRect(x + C / 2 - 2, wy, 4, wh);
      gr.fillStyle = '#121212';
      gr.fillRect(wx, wy, ww, wh);
      if (rand() < 0.36) {
        litWindow(ge, rand, wx, wy, ww, wh);
        ge.fillStyle = '#000';
        ge.fillRect(x + C / 2 - 2, wy, 4, wh);
      }
    }
  }
  grain(ga, S, S, 8, rand);
  return { map: texture(a, true), emissiveMap: texture(e, true), roughnessMap: texture(r, false) };
}

export function facadeMasonry() {
  const S = 1024, N = 8, C = S / N, rand = rng(19);
  const a = canvas(S, S), ga = a.getContext('2d');
  const e = canvas(S, S), ge = e.getContext('2d');
  const r = canvas(S, S), gr = r.getContext('2d');
  ga.fillStyle = '#d9d2c6';
  ga.fillRect(0, 0, S, S);
  grain(ga, S, S, 26, rand);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  gr.fillStyle = '#e0e0e0';
  gr.fillRect(0, 0, S, S);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = i * C, y = j * C;
      const wx = x + 30, wy = y + 20, ww = C - 60, wh = C - 52;
      ga.fillStyle = 'rgba(80,70,60,0.35)';
      ga.fillRect(wx - 6, wy + wh, ww + 12, 7);
      const l = 12 + rand() * 10;
      ga.fillStyle = `hsl(${205 + rand() * 20},14%,${l}%)`;
      ga.fillRect(wx, wy, ww, wh);
      ga.fillStyle = 'rgba(220,214,204,0.9)';
      ga.fillRect(wx + ww / 2 - 2, wy, 4, wh);
      ga.fillRect(wx, wy + wh * 0.42, ww, 3);
      gr.fillStyle = '#1e1e1e';
      gr.fillRect(wx, wy, ww, wh);
      if (rand() < 0.42) litWindow(ge, rand, wx, wy, ww, wh);
    }
  }
  return { map: texture(a, true), emissiveMap: texture(e, true), roughnessMap: texture(r, false) };
}

export function roofTexture() {
  const S = 256, rand = rng(5);
  const c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#6d6f73';
  g.fillRect(0, 0, S, S);
  grain(g, S, S, 40, rand);
  g.strokeStyle = 'rgba(30,30,30,0.35)';
  for (let i = 0; i <= S; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
  }
  return texture(c, true);
}

export function roadTexture() {
  const W = 256, H = 512, rand = rng(3);
  const c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#2b2c30';
  g.fillRect(0, 0, W, H);
  grain(g, W, H, 22, rand);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(0,0,0,${0.05 + rand() * 0.1})`;
    g.fillRect(rand() * W, rand() * H, 10 + rand() * 50, 6 + rand() * 30);
  }
  g.fillStyle = 'rgba(232,232,226,0.85)';
  g.fillRect(8, 0, 5, H);
  g.fillRect(W - 13, 0, 5, H);
  g.fillStyle = 'rgba(236,236,230,0.8)';
  for (const lane of [W / 3, (2 * W) / 3]) {
    g.fillRect(lane - 2, 0, 4, H * 0.42);
  }
  return texture(c, true);
}

export function groundTexture() {
  const S = 512, rand = rng(9);
  const c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#8f8d88';
  g.fillRect(0, 0, S, S);
  grain(g, S, S, 30, rand);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '0,0,0' : '255,255,255'},${0.02 + rand() * 0.04})`;
    g.beginPath();
    g.arc(rand() * S, rand() * S, 8 + rand() * 40, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(40,40,40,0.4)';
  g.lineWidth = 2;
  for (let i = 0; i <= S; i += 128) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
  }
  return texture(c, true);
}

export function grassTexture() {
  const S = 256, rand = rng(13);
  const c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#48653a';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `hsla(${85 + rand() * 30},${30 + rand() * 25}%,${22 + rand() * 18}%,0.6)`;
    g.fillRect(rand() * S, rand() * S, 2, 2 + rand() * 3);
  }
  return texture(c, true);
}

// Tileable normal map built from integer-frequency waves.
export function waterNormal() {
  const S = 256, rand = rng(11);
  const waves = [];
  for (let i = 0; i < 12; i++) {
    waves.push({
      kx: Math.round((rand() * 2 - 1) * 9),
      ky: Math.round((rand() * 2 - 1) * 9),
      a: 0.4 + rand(),
      p: rand() * Math.PI * 2,
    });
  }
  const h = (x, y) => {
    let s = 0;
    for (const w of waves) s += w.a * Math.sin((2 * Math.PI * (w.kx * x + w.ky * y)) / S + w.p);
    return s;
  };
  const c = canvas(S, S), g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 0.6;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 0.6;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      img.data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texture(c, false);
}

export function glowSpot() {
  const S = 128;
  const c = canvas(S, S), g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// --- added for the 2.0 build: arena surfaces, Chicago brick and deco facades, plates ---------

export function asphaltTexture() {
  const S = 512, rand = rng(31);
  const c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#26272a';
  g.fillRect(0, 0, S, S);
  grain(g, S, S, 26, rand);
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(0,0,0,${0.05 + rand() * 0.12})`;
    g.beginPath();
    g.ellipse(rand() * S, rand() * S, 10 + rand() * 60, 4 + rand() * 20, rand() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(10,10,12,0.5)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    let x = rand() * S, y = rand() * S;
    g.moveTo(x, y);
    for (let k = 0; k < 8; k++) { x += (rand() - 0.5) * 60; y += (rand() - 0.5) * 60; g.lineTo(x, y); }
    g.stroke();
  }
  return texture(c, true);
}

export function concreteTexture(centreLine) {
  const S = 512, rand = rng(37);
  const c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#a9a7a1';
  g.fillRect(0, 0, S, S);
  grain(g, S, S, 22, rand);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '0,0,0' : '255,255,255'},${0.02 + rand() * 0.05})`;
    g.beginPath();
    g.arc(rand() * S, rand() * S, 10 + rand() * 50, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(40,40,40,0.5)';
  g.lineWidth = 3;
  for (let i = 0; i <= S; i += S / 2) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
  }
  for (let i = 0; i <= S; i += S / 4) {
    g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
  }
  if (centreLine) {
    g.fillStyle = 'rgba(245,245,240,0.92)';
    g.fillRect(S / 2 - 9, 0, 18, S);
  }
  return texture(c, true);
}

export function sidewalkTexture() {
  const S = 256, rand = rng(41);
  const c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#b3b0a8';
  g.fillRect(0, 0, S, S);
  grain(g, S, S, 18, rand);
  g.strokeStyle = 'rgba(60,60,60,0.35)';
  g.lineWidth = 2;
  for (let i = 0; i <= S; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
  }
  return texture(c, true);
}

// Chicago common brick / red brick walk-ups and warehouses: punched windows, stone sills.
export function facadeBrick() {
  const S = 1024, N = 8, C = S / N, rand = rng(23);
  const a = canvas(S, S), ga = a.getContext('2d');
  const e = canvas(S, S), ge = e.getContext('2d');
  const r = canvas(S, S), gr = r.getContext('2d');
  ga.fillStyle = '#8a4a36';
  ga.fillRect(0, 0, S, S);
  // brick courses
  for (let y = 0; y < S; y += 6) {
    for (let x = (y / 6) % 2 ? -8 : 0; x < S; x += 16) {
      ga.fillStyle = `hsl(${12 + rand() * 10},${38 + rand() * 18}%,${28 + rand() * 12}%)`;
      ga.fillRect(x, y, 15, 5);
    }
  }
  grain(ga, S, S, 14, rand);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  gr.fillStyle = '#f0f0f0';
  gr.fillRect(0, 0, S, S);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = i * C, y = j * C;
      const wx = x + 34, wy = y + 22, ww = C - 68, wh = C - 56;
      ga.fillStyle = '#d9d2c3';
      ga.fillRect(wx - 6, wy + wh, ww + 12, 8);
      ga.fillRect(wx - 6, wy - 8, ww + 12, 8);
      const l = 10 + rand() * 10;
      ga.fillStyle = `hsl(${200 + rand() * 20},12%,${l}%)`;
      ga.fillRect(wx, wy, ww, wh);
      ga.fillStyle = 'rgba(230,226,218,0.9)';
      ga.fillRect(wx + ww / 2 - 2, wy, 4, wh);
      ga.fillRect(wx, wy + wh * 0.5, ww, 3);
      gr.fillStyle = '#262626';
      gr.fillRect(wx, wy, ww, wh);
      if (rand() < 0.4) litWindow(ge, rand, wx, wy, ww, wh);
    }
  }
  return { map: texture(a, true), emissiveMap: texture(e, true), roughnessMap: texture(r, false) };
}

// Art-deco limestone and terra cotta: tall vertical piers with recessed spandrels (Board of Trade, Carbide).
export function facadeDeco() {
  const S = 1024, N = 8, C = S / N, rand = rng(29);
  const a = canvas(S, S), ga = a.getContext('2d');
  const e = canvas(S, S), ge = e.getContext('2d');
  const r = canvas(S, S), gr = r.getContext('2d');
  ga.fillStyle = '#c9bea6';
  ga.fillRect(0, 0, S, S);
  grain(ga, S, S, 20, rand);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  gr.fillStyle = '#d8d8d8';
  gr.fillRect(0, 0, S, S);
  for (let i = 0; i < N; i++) {
    const x = i * C;
    // pier shading
    const grd = ga.createLinearGradient(x, 0, x + C, 0);
    grd.addColorStop(0, 'rgba(0,0,0,0.18)');
    grd.addColorStop(0.2, 'rgba(255,255,255,0.08)');
    grd.addColorStop(0.8, 'rgba(255,255,255,0.08)');
    grd.addColorStop(1, 'rgba(0,0,0,0.18)');
    ga.fillStyle = grd;
    ga.fillRect(x, 0, C, S);
    for (let j = 0; j < N; j++) {
      const y = j * C;
      const wx = x + 26, wy = y + 14, ww = C - 52, wh = C - 40;
      ga.fillStyle = '#5a4f3f';
      ga.fillRect(wx - 4, wy + wh, ww + 8, 14); // dark spandrel
      const l = 10 + rand() * 12;
      ga.fillStyle = `hsl(${205 + rand() * 15},14%,${l}%)`;
      ga.fillRect(wx, wy, ww, wh);
      ga.fillStyle = 'rgba(225,218,200,0.9)';
      ga.fillRect(wx + ww / 3 - 1, wy, 3, wh);
      ga.fillRect(wx + (2 * ww) / 3 - 1, wy, 3, wh);
      gr.fillStyle = '#1e1e1e';
      gr.fillRect(wx, wy, ww, wh);
      if (rand() < 0.38) litWindow(ge, rand, wx, wy, ww, wh);
    }
  }
  return { map: texture(a, true), emissiveMap: texture(e, true), roughnessMap: texture(r, false) };
}

// A licence plate with text (the reveal car wore "RDSTR").
export function plateTexture(text) {
  const c = canvas(256, 128), g = c.getContext('2d');
  g.fillStyle = '#f4f4ef';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#1a1b1e';
  g.font = 'bold 86px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 70);
  g.fillStyle = '#9a1b1f';
  g.font = 'bold 18px Arial, sans-serif';
  g.fillText('TEXAS', 128, 16);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
