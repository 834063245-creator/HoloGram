// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import * as THREE from 'three';

// ── GPU point sprite shader materials ─────────────────────────

export const _GLSL_HSL2RGB = /* glsl */ `
  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }
`;

export function makeGlowPointMaterial(
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
      uniform float uTime;
      uniform float uPulseTime;
      ${hsl2rgb}
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float pointScale = 28.0 * (300.0 / -mv.z);
        if (override > 0.5) {
          vColor = color;
          gl_PointSize = size * pointScale;
        } else {
          float twinkle = 1.0 + sin(uTime * speed + phase) * 0.10;
          float riskFreq = 1.0 + risk * 0.7;
          float waveAmp = risk > 0.0 ? min(0.18, risk * 0.06) : 0.03;
          float wave = 1.0 + sin(uPulseTime * riskFreq) * waveAmp;
          float combined = twinkle * wave;
          float alpha = min(1.0, ${alphaMul.toFixed(2)} * combined * mag);
          float hueShift = sin(uTime * 0.3 + phase) * 0.05;
          float newH = mod(baseHSL.x + hueShift + 1.0, 1.0);
          float newS = min(1.0, baseHSL.y * 1.2);
          float newL = min(1.0, baseHSL.z * 1.3);
          vec3 rgb = hsl2rgb(newH, newS, newL);
          vColor = vec4(rgb, alpha);
          gl_PointSize = size * combined * ${sizeMul.toFixed(2)} * pointScale;
        }
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      varying vec4 vColor;
      void main() { gl_FragColor = vColor * texture2D(uTex, gl_PointCoord); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
}

/** ponytail: restores Fresnel rim on InstancedMesh via onBeforeCompile injection.
 *  Uses sphere pos→normal trick (unit sphere: localNormal = normalize(position)). */
export function makeCoreFresnelMaterial(spikeTex: THREE.Texture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  });
  mat.onBeforeCompile = (shader) => {
    // ── Vertex: varyings for world-normal, UV, world-pos ──
    shader.vertexShader = shader.vertexShader.replace(
      'void main()',
      `varying vec3 vFresnelWorldNormal;
       varying vec3 vFresnelWorldPos;
       varying vec2 vCoreUv;
       void main()`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `// Fresnel: sphere pos IS the local normal (unit sphere geometry)
       vec3 _fLocalN = normalize(position);
       vFresnelWorldNormal = normalize(mat3(instanceMatrix) * _fLocalN);
       vFresnelWorldPos = (instanceMatrix * vec4(position, 1.0)).xyz;
       vCoreUv = uv;
       #include <project_vertex>`,
    );

    // ── Fragment: center-glow (star-like) + crystalline surface detail ──
    shader.uniforms.uSpikeTex = { value: spikeTex };
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main()',
      `varying vec3 vFresnelWorldNormal;
       varying vec3 vFresnelWorldPos;
       varying vec2 vCoreUv;
       uniform sampler2D uSpikeTex;
       void main()`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `vec3 _fViewDir = normalize(cameraPosition - vFresnelWorldPos);
       float _fNdotV = abs(dot(normalize(vFresnelWorldNormal), _fViewDir));
       float _fCore = pow(_fNdotV, 2.5);
       float _fSpike = texture2D(uSpikeTex, vCoreUv * 2.5).r;
       outgoingLight = outgoingLight * (0.45 + _fCore * 2.1) * (1.0 + _fSpike * 0.12);
       #include <opaque_fragment>`,
    );
  };
  return mat;
}
