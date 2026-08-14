// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// 视觉特效模块 — starfield / nebula dust / holo grid / bloom
// 从 graph.ts StarGraph 类中提取，减少单体文件体量
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';

// ── 星场 ────────────────────────────────────────────────

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
      posArr[idx * 3 + 1] = Math.sin(phi) * r; // 球面坐标
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
  const starfield = new THREE.Points(geo, mat);
  scene.add(starfield);
  return starfield;
}

// ── 无限全息网格（基于着色器）──────────────────

export function buildHoloGrid(scene: THREE.Scene): { mesh: THREE.Mesh; gridY: number } {
  const gridSize = 60; // 主网格线的世界单位间距
  const gridY = -60;

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

      // 主网格线
      float mx = gridLine(vWorldPos.x, majorSize, 0.5);
      float mz = gridLine(vWorldPos.z, majorSize, 0.5);
      float major = max(mx, mz);

      // 次网格线（不与主网格线重叠）
      float nx = gridLine(vWorldPos.x, minorSize, 0.25);
      float nz = gridLine(vWorldPos.z, minorSize, 0.25);
      float minor = max(nx, nz) * (1.0 - major);

      // 随相机世界空间距离淡出
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

  // XZ 平面上的巨大平面（旋转放平）
  const geo = new THREE.PlaneGeometry(20000, 20000);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = gridY;
  mesh.renderOrder = 1;
  scene.add(mesh);
  return { mesh, gridY };
}

/** 将全息网格定位在最低节点下方。 */
export function positionGrid(holoGrid: THREE.Mesh | null, pos: Float32Array): number {
  if (!holoGrid) return -60;
  let minY = Infinity;
  for (let i = 0; i < pos.length / 3; i++) {
    minY = Math.min(minY, pos[i * 3 + 1]);
  }
  const gridY = minY - 40;
  holoGrid.position.y = gridY;
  return gridY;
}
