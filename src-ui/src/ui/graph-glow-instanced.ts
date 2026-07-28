// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphGlowInstanced — WebKitGTK 专用辉光渲染器（InstancedMesh 广告牌）
// 根因（HANDOFF_LINUX_GLOW.md）：WebKitGTK 不尊重 gl_PointSize，
// THREE.Points 辉光在 Linux WebView 上会炸满屏。
// 这里用 InstancedMesh + 始终面向相机的 quad 复刻 Points 辉光：
// 尺寸走「像素 → view-space」换算（见 vertex shader 注释），
// 完全不依赖 gl_PointSize。对外接口与 THREE.Points 保持一致 ——
// geometry.attributes 挂同名 per-node 属性（共享底层数组），
// material.uniforms 同名（uTime/uPulseTime/uHoveredIdx/uHoverScale），
// 下游（animate 循环 / reveal / diff / fold）无需区分两种实现。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { _GLSL_HSL2RGB } from './graph-shaders';

// WebKitGTK 检测：命中时走 InstancedMesh 辉光，其余平台保持 Points 路径
export const IS_WEBKITGTK = navigator.userAgent.includes('WebKit') && !navigator.userAgent.includes('Chrome');

// Points 辉光与 InstancedMesh 辉光的公共类型 — 下游只碰 geometry/material
export type GlowPointsLike = THREE.Points | THREE.InstancedMesh;

/** 与 makeGlowPointMaterial 逐行对应的 InstancedMesh 版辉光材质（additive + 同一 glowTex）。 */
export function makeGlowInstancedMaterial(
  glowTex: THREE.Texture,
  alphaMul: number,
  sizeMul: number,
): THREE.ShaderMaterial {
  const hsl2rgb = _GLSL_HSL2RGB;
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: glowTex },
      uTime: { value: 0 },
      uPulseTime: { value: 0 },
      uHoveredIdx: { value: -1 },
      uHoverScale: { value: 0 },
      uViewportH: { value: 1 }, // 绘制缓冲高度（设备像素）— animate 循环每帧刷新
    },
    vertexShader: /* glsl */ `
      attribute vec4 color;
      attribute float size;
      attribute float phase;
      attribute float speed;
      attribute float mag;
      attribute float risk;
      attribute vec3  baseHSL;
      attribute float override;
      varying vec4 vColor;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uPulseTime;
      uniform float uHoveredIdx;
      uniform float uHoverScale;
      uniform float uViewportH;
      ${hsl2rgb}
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float pointScale = 28.0 * (300.0 / -mv.z);
        // ps: 与 Points 版 gl_PointSize 完全等价的像素尺寸
        float ps;
        if (override > 0.5) {
          vColor = vec4(color.rgb, color.a * mag);
          ps = size * pointScale;
        } else {
          float twinkle = 1.0 + sin(uTime * speed + phase) * 0.10;
          float riskFreq = 1.0 + risk * 0.7;
          float waveAmp = risk > 0.0 ? min(0.18, risk * 0.06) : 0.03;
          float wave = 1.0 + sin(uPulseTime * riskFreq) * waveAmp;
          float combined = twinkle * wave;
          float alpha = min(1.0, ${alphaMul.toFixed(2)} * combined * mag);
          // GPU-native hover: boost alpha + size（实例版用 gl_InstanceID 匹配节点序号）
          if (int(uHoveredIdx) == gl_InstanceID) {
            alpha = min(1.0, alpha * (1.0 + uHoverScale * 0.5));
          }
          float hueShift = sin(uTime * 0.3 + phase) * 0.05;
          float newH = mod(baseHSL.x + hueShift + 1.0, 1.0);
          float newS = min(1.0, baseHSL.y * 1.2);
          float newL = min(1.0, baseHSL.z * 1.3);
          vec3 rgb = hsl2rgb(newH, newS, newL);
          vColor = vec4(rgb, alpha);
          ps = size * combined * ${sizeMul.toFixed(2)} * pointScale;
          if (int(uHoveredIdx) == gl_InstanceID) {
            ps *= (1.0 + uHoverScale * 0.3);
          }
        }
        // 像素 → view-space 偏移：view 空间半边 = ps * (-mv.z) / (uViewportH * proj[1][1])，
        // 投影回屏幕恰好 ps/2 设备像素 —— quad 占地与 gl_PointSize 点精灵逐像素一致，
        // 且始终面向相机（偏移加在 view space，不随模型旋转）。
        vec2 corner = uv - 0.5;
        mv.xy += corner * (2.0 * ps * (-mv.z) / (uViewportH * projectionMatrix[1][1]));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      varying vec4 vColor;
      varying vec2 vUv;
      void main() { gl_FragColor = vColor * texture2D(uTex, vUv); }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
}

/**
 * 把 Points 风格的 per-node BufferGeometry 转成 InstancedMesh 广告牌：
 * 同名属性原样转为 InstancedBufferAttribute（共享底层数组，CPU 写入路径不变），
 * 另加 4 顶点 quad（uv 兼作角点坐标与纹理坐标）+ index。实例数取 position 属性计数，
 * 尾部未用实例 alpha=0（additive 下不可见），与 Points 画满 capacity 的行为一致。
 */
export function makeGlowInstancedMesh(
  nodeGeo: THREE.BufferGeometry,
  material: THREE.ShaderMaterial,
): THREE.InstancedMesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const count = nodeGeo.attributes.position.count;
  for (const name of Object.keys(nodeGeo.attributes)) {
    const attr = nodeGeo.attributes[name] as THREE.BufferAttribute;
    geo.setAttribute(name, new THREE.InstancedBufferAttribute(attr.array as Float32Array, attr.itemSize));
  }
  const mesh = new THREE.InstancedMesh(geo, material, count);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

/** 释放 InstancedMesh 内部 instanceMatrix 的 GPU 缓冲（Points 无此缓冲，直接跳过）。 */
export function disposeGlowInstanced(obj: GlowPointsLike): void {
  if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
}
