// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import * as THREE from 'three';
import { communityColor } from './graph-colors';

// ── Scene decoration functions ─────────────────────────────────
// Starfield, nebula dust, holographic grid, galaxy clouds, cross-edge flow.
// All functions are pure: they take THREE objects as params, modify nothing else.

export function buildNebulaDust(
  scene: THREE.Scene,
  glowTex: THREE.Texture,
): { points: THREE.Points; phases: number[] } {
  const count = 300;
  const posArr = new Float32Array(count * 3);
  const colArr = new Float32Array(count * 3);
  const rMin = 80,
    rMax = 900;
  for (let i = 0; i < count; i++) {
    const r = rMin + Math.random() * (rMax - rMin);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    posArr[i * 3] = Math.cos(theta) * Math.sin(phi) * r;
    posArr[i * 3 + 1] = Math.sin(phi) * r * 0.4;
    posArr[i * 3 + 2] = Math.sin(theta) * Math.sin(phi) * r;
    const hues = [0.6, 0.65, 0.7, 0.55, 0.12, 0.08];
    const hue = hues[Math.floor(Math.random() * hues.length)];
    const c = new THREE.Color();
    c.setHSL(hue, 0.6, 0.5 + Math.random() * 0.3);
    colArr[i * 3] = c.r;
    colArr[i * 3 + 1] = c.g;
    colArr[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  const mat = new THREE.PointsMaterial({
    size: 18,
    map: glowTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.12,
  });
  const points = new THREE.Points(geo, mat);
  const phases = new Array(count).fill(0).map(() => Math.random() * Math.PI * 2);
  scene.add(points);
  return { points, phases };
}

export function animateNebulaDust(points: THREE.Points, pulseTime: number): void {
  if (!points) return;
  points.rotation.y += 0.0001;
  points.rotation.x += 0.00005;
  const op = 0.08 + Math.sin(pulseTime * 0.2) * 0.04;
  (points.material as THREE.PointsMaterial).opacity = op;
}

export function buildStarfield(scene: THREE.Scene, glowTex: THREE.Texture): THREE.Points {
  const isFull = true;
  const count = isFull ? 4000 : 2200;
  const posArr = new Float32Array(count * 3),
    colArr = new Float32Array(count * 3);
  const layers = isFull
    ? [
        { r: [600, 1400], n: 600, hue: [200, 240], sat: 0.5, l: [0.4, 0.7] },
        { r: [300, 800], n: 1200, hue: [190, 220], sat: 0.35, l: [0.5, 0.85] },
        { r: [80, 450], n: 1200, hue: [180, 210], sat: 0.25, l: [0.65, 1.0] },
        { r: [15, 250], n: 1000, hue: [25, 55], sat: 0.55, l: [0.7, 1.0] },
      ]
    : [
        { r: [500, 1000], n: 300, hue: [210, 230], sat: 0.4, l: [0.5, 0.8] },
        { r: [250, 600], n: 700, hue: [200, 220], sat: 0.3, l: [0.6, 0.9] },
        { r: [60, 350], n: 700, hue: [190, 210], sat: 0.2, l: [0.7, 1.0] },
        { r: [10, 180], n: 500, hue: [30, 50], sat: 0.5, l: [0.7, 0.95] },
      ];
  let idx = 0;
  for (const L of layers) {
    for (let i = 0; i < L.n && idx < count; i++) {
      const theta = Math.random() * Math.PI * 2,
        phi = Math.acos(2 * Math.random() - 1);
      const r = L.r[0] + Math.random() * (L.r[1] - L.r[0]);
      posArr[idx * 3] = Math.cos(theta) * Math.sin(phi) * r;
      posArr[idx * 3 + 1] = Math.sin(phi) * r;
      posArr[idx * 3 + 2] = Math.sin(theta) * Math.sin(phi) * r;
      const hsl = new THREE.Color();
      hsl.setHSL(
        (L.hue[0] + Math.random() * (L.hue[1] - L.hue[0])) / 360,
        L.sat,
        L.l[0] + Math.random() * (L.l[1] - L.l[0]),
      );
      colArr[idx * 3] = hsl.r;
      colArr[idx * 3 + 1] = hsl.g;
      colArr[idx * 3 + 2] = hsl.b;
      idx++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  const mat = new THREE.PointsMaterial({
    size: 2.2,
    map: glowTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true,
    transparent: true,
    opacity: 1.0,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  return points;
}

// ── Infinite holographic grid ──────────────────────────────────

export function buildHoloGrid(scene: THREE.Scene): { mesh: THREE.Mesh; gridY: number } {
  const gridSize = 60;
  const vert = /* glsl */ `
    varying vec3 vWorldPos;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const frag = /* glsl */ `
    varying vec3 vWorldPos;
    uniform vec3 uCameraWorldPos;
    uniform float uGridSize;
    uniform float uFadeDist;
    float gridLine(float coord, float size, float w) {
      float d = abs(mod(coord + size * 0.5, size) - size * 0.5);
      return 1.0 - smoothstep(0.0, w, d);
    }
    void main() {
      float majorSize = uGridSize;
      float minorSize = majorSize / 5.0;
      float mx = gridLine(vWorldPos.x, majorSize, 0.5);
      float mz = gridLine(vWorldPos.z, majorSize, 0.5);
      float major = max(mx, mz);
      float nx = gridLine(vWorldPos.x, minorSize, 0.25);
      float nz = gridLine(vWorldPos.z, minorSize, 0.25);
      float minor = max(nx, nz) * (1.0 - major);
      float dist = length(vWorldPos.xz - uCameraWorldPos.xz);
      float fade = 1.0 - smoothstep(uFadeDist * 0.4, uFadeDist, dist);
      float alpha = (major * 0.15 + minor * 0.05) * fade;
      gl_FragColor = vec4(0.15, 0.3, 0.5, alpha);
    }
  `;
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uCameraWorldPos: { value: new THREE.Vector3() },
      uGridSize: { value: gridSize },
      uFadeDist: { value: 1800 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const geo = new THREE.PlaneGeometry(20000, 20000);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -60;
  mesh.renderOrder = 1;
  scene.add(mesh);
  return { mesh, gridY: -60 };
}

export function positionGrid(mesh: THREE.Mesh, pos: Float32Array, gridY: number): number {
  if (!mesh) return gridY;
  let minY = Infinity;
  for (let i = 0; i < pos.length / 3; i++) {
    minY = Math.min(minY, pos[i * 3 + 1]);
  }
  const newY = minY - 40;
  mesh.position.y = newY;
  return newY;
}

// ── Galaxy clouds (fold mode) ─────────────────────────────────

export function buildGalaxyClouds(
  commFoldGroup: THREE.Group,
  galaxyMeta: Array<{ id: string; memberIndices: number[]; centroid: THREE.Vector3; radius: number }>,
  glowTex: THREE.Texture,
): { clouds: THREE.Object3D[]; glows: THREE.Object3D[] } {
  const clouds: THREE.Object3D[] = [];
  const glows: THREE.Object3D[] = [];
  for (let gi = 0; gi < galaxyMeta.length; gi++) {
    const gm = galaxyMeta[gi];
    const sizeByCount = Math.cbrt(gm.memberIndices.length) * 8;
    const r = Math.min(sizeByCount, Math.max(20, gm.radius || 30) * 0.5);
    const colorHex = communityColor(gm.id);
    const color = new THREE.Color(colorHex);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.1,
      }),
    );
    halo.position.copy(gm.centroid);
    halo.scale.setScalar(r * 1.15);
    halo.userData = { galaxyIndex: gi, galaxyId: gm.id };
    commFoldGroup.add(halo);
    glows.push(halo);

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(r, 32, 24),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(colorHex) }, uOpacity: { value: 1.0 } },
        vertexShader: `varying vec3 vNormal; varying vec3 vViewDir; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vNormal = normalize(normalMatrix * normal); vViewDir = normalize(-mv.xyz); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec3 vNormal; varying vec3 vViewDir; void main() { float f = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))); float edge = pow(f, 2.5); vec3 col = mix(uColor * 0.15, uColor * 1.6, edge); float alpha = (0.35 + edge * 0.55) * uOpacity; gl_FragColor = vec4(col, alpha); }`,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        blending: THREE.NormalBlending,
      }),
    );
    core.position.copy(gm.centroid);
    core.userData = { galaxyIndex: gi, galaxyId: gm.id };
    commFoldGroup.add(core);
    glows.push(core);
  }
  return { clouds, glows };
}

// ── Galaxy labels ─────────────────────────────────────────────

export function buildGalaxyLabels(
  container: HTMLElement,
  galaxyMeta: Array<{ id: string; memberIndices: number[]; centroid: THREE.Vector3; label: string; radius: number }>,
  camera: THREE.Camera,
): HTMLDivElement[] {
  const maxLabels = Math.min(15, galaxyMeta.length);
  const divs: HTMLDivElement[] = [];
  for (let gi = 0; gi < maxLabels; gi++) {
    const gm = galaxyMeta[gi];
    const div = document.createElement('div');
    div.className = 'galaxy-label';
    const shortName = gm.label
      .split('/')[0]
      .replace(/^test_/, '')
      .replace(/_/g, ' ');
    div.textContent = shortName.length > 24 ? shortName.slice(0, 22) + '…' : shortName;
    div.style.position = 'absolute';
    div.style.pointerEvents = 'none';
    container.appendChild(div);
    divs.push(div);
  }
  return divs;
}

export function updateGalaxyLabels(
  divs: HTMLDivElement[],
  galaxyMeta: Array<{ centroid: THREE.Vector3 }>,
  camera: THREE.Camera,
  container: HTMLElement,
): void {
  for (let gi = 0; gi < divs.length; gi++) {
    const gm = galaxyMeta[gi];
    const v = gm.centroid.clone().project(camera);
    if (v.z > 1) {
      divs[gi].style.display = 'none';
      continue;
    }
    divs[gi].style.display = '';
    divs[gi].style.left = `${(v.x * 0.5 + 0.5) * container.clientWidth + 12}px`;
    divs[gi].style.top = `${(-v.y * 0.5 + 0.5) * container.clientHeight}px`;
  }
}
