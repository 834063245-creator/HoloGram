// Layout Worker — runs layout3D off the main thread
// ⛔ CANONICAL LAYOUT — DO NOT MODIFY CORE PARAMETERS ⛔
// Safety layers (caps, adaptive constraints, NaN guards) are maintained
// in sync with graph.ts. Core aesthetic params (rep, att, damp, shellRadius)
// are LOCKED.

function fibonacciSphere(n: number, radius: number): Float32Array {
  const pos = new Float32Array(n * 3);
  const phi = Math.PI * (1 + Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    pos[i * 3] = Math.cos(theta) * r * radius;
    pos[i * 3 + 1] = y * radius;
    pos[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  return pos;
}

function layout3D(n: number, edgePairs: [number, number][]): Float32Array {
  if (n === 0) return new Float32Array(0);

  // ── Core parameters (LOCKED) ──
  const shellRadius = Math.cbrt(n) * 14;
  const rep = 600, att = 0.018, damp = 0.72;
  const pos = fibonacciSphere(n, shellRadius);
  const vel = new Float32Array(n * 3);

  // ── Adaptive shell constraint — tighter for large graphs ──
  const sp = 0.006 + (n > 2000 ? 0.008 : 0) + (n > 4000 ? 0.006 : 0);

  // ── Adaptive iteration budget ──
  const maxIter = Math.min(60, Math.max(15, 60 - Math.floor(n / 800)));

  // ── Safety caps ──
  const REP_CAP = shellRadius * 8;
  const ATT_CAP = shellRadius;
  const VEL_CAP = shellRadius * 0.25;

  for (let iter = 0; iter < maxIter; iter++) {
    // Repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const dist = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const f = Math.min(rep / (dist * dist + 1), REP_CAP);
        vel[i * 3] += (dx / dist) * f; vel[i * 3 + 1] += (dy / dist) * f; vel[i * 3 + 2] += (dz / dist) * f;
        vel[j * 3] -= (dx / dist) * f; vel[j * 3 + 1] -= (dy / dist) * f; vel[j * 3 + 2] -= (dz / dist) * f;
      }
    }
    // Attraction
    for (const [s, t] of edgePairs) {
      const dx = pos[s * 3] - pos[t * 3], dy = pos[s * 3 + 1] - pos[t * 3 + 1], dz = pos[s * 3 + 2] - pos[t * 3 + 2];
      const dist = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const f = Math.min(dist * att, ATT_CAP);
      vel[s * 3] -= (dx / dist) * f; vel[s * 3 + 1] -= (dy / dist) * f; vel[s * 3 + 2] -= (dz / dist) * f;
      vel[t * 3] += (dx / dist) * f; vel[t * 3 + 1] += (dy / dist) * f; vel[t * 3 + 2] += (dz / dist) * f;
    }
    // Origin attraction
    for (let i = 0; i < n; i++) {
      vel[i * 3] -= pos[i * 3] * 0.0004;
      vel[i * 3 + 1] -= pos[i * 3 + 1] * 0.0004;
      vel[i * 3 + 2] -= pos[i * 3 + 2] * 0.0004;
    }
    // Per-node velocity cap
    for (let i = 0; i < n; i++) {
      const vx = vel[i * 3], vy = vel[i * 3 + 1], vz = vel[i * 3 + 2];
      const vm = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vm > VEL_CAP) { const s = VEL_CAP / vm; vel[i * 3] = vx * s; vel[i * 3 + 1] = vy * s; vel[i * 3 + 2] = vz * s; }
    }
    // Damping + position update
    for (let i = 0; i < n * 3; i++) { vel[i] *= damp; pos[i] += vel[i]; }
    // NaN guard (full sweep every 5, sampling every iter)
    if (iter % 5 === 0) {
      let diverged = false;
      for (let i = 0; i < n * 3; i++) {
        if (!isFinite(pos[i]) || !isFinite(vel[i])) { diverged = true; break; }
      }
      if (diverged) {
        const fresh = fibonacciSphere(n, shellRadius);
        for (let i = 0; i < n * 3; i++) { pos[i] = fresh[i]; vel[i] = 0; }
      }
    } else {
      const sample = Math.max(10, Math.floor(Math.sqrt(n)));
      let diverged = false;
      for (let k = 0; k < sample && !diverged; k++) {
        const i = (k * 2654435761 + iter * 0x9e3779b9) % n;
        const i3 = i * 3;
        if (!isFinite(pos[i3]) || !isFinite(pos[i3 + 1]) || !isFinite(pos[i3 + 2]) ||
            !isFinite(vel[i3]) || !isFinite(vel[i3 + 1]) || !isFinite(vel[i3 + 2])) {
          diverged = true;
        }
      }
      if (diverged) {
        const fresh = fibonacciSphere(n, shellRadius);
        for (let i = 0; i < n * 3; i++) { pos[i] = fresh[i]; vel[i] = 0; }
      }
    }
    // Shell constraint (adaptive)
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3], dy = pos[i * 3 + 1], dz = pos[i * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 1) {
        const drift = (dist - shellRadius) * sp;
        pos[i * 3] -= (dx / dist) * drift;
        pos[i * 3 + 1] -= (dy / dist) * drift;
        pos[i * 3 + 2] -= (dz / dist) * drift;
      }
    }
  }
  return pos;
}

self.onmessage = (e: MessageEvent) => {
  const { nodes, pairs } = e.data;
  const pos = layout3D(nodes, pairs);
  self.postMessage({ pos }, undefined as any);
};
