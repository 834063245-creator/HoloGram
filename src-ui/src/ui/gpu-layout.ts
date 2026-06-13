/// <reference types="@webgpu/types" />

// ═══════════════════════════════════════════════════════════════
// GPU Compute Layout — WebGPU force-directed graph layout
// Replaces CPU layout3D with parallel compute shaders.
// Three compute passes per iteration: repulsion → attraction → update.
// Falls back gracefully if WebGPU is unavailable.
//
// Core parameters (rep, att, damp, shellRadius, caps) are LOCKED —
// kept identical to the JS layout3D function.
// ═══════════════════════════════════════════════════════════════

const WGSL = /* wgsl */ `
struct Params {
  n: u32,
  rep: f32,
  att: f32,
  damp: f32,
  REP_CAP: f32,
  ATT_CAP: f32,
  VEL_CAP: f32,
  shellRadius: f32,
  sp: f32,
  originStr: f32,
}

@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> vel: array<f32>;
@group(0) @binding(2) var<storage, read>       adjOff: array<u32>;
@group(0) @binding(3) var<storage, read>       adjTgt: array<u32>;
@group(0) @binding(4) var<storage, read>       params: Params;

// ── Repulsion: O(n) threads, O(n) work each = O(n²) parallel ──

@compute @workgroup_size(64)
fn repulsion(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }

  let ix = pos[i * 3u];
  let iy = pos[i * 3u + 1u];
  let iz = pos[i * 3u + 2u];

  var fx = 0.0f;
  var fy = 0.0f;
  var fz = 0.0f;

  for (var j = 0u; j < params.n; j++) {
    if (j == i) { continue; }

    let dx = ix - pos[j * 3u];
    let dy = iy - pos[j * 3u + 1u];
    let dz = iz - pos[j * 3u + 2u];
    let d2 = dx * dx + dy * dy + dz * dz;
    let dist = max(0.3f, sqrt(d2));
    let f = min(params.rep / (d2 + 1.0f), params.REP_CAP);
    let inv = 1.0f / dist;

    fx += dx * inv * f;
    fy += dy * inv * f;
    fz += dz * inv * f;
  }

  vel[i * 3u] += fx;
  vel[i * 3u + 1u] += fy;
  vel[i * 3u + 2u] += fz;
}

// ── Attraction: per-node, walks its incident edges (no atomics) ──

@compute @workgroup_size(64)
fn attraction(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }

  let begin = adjOff[i];
  let end = adjOff[i + 1u];
  if (begin == end) { return; }

  let ix = pos[i * 3u];
  let iy = pos[i * 3u + 1u];
  let iz = pos[i * 3u + 2u];

  var ax = 0.0f;
  var ay = 0.0f;
  var az = 0.0f;

  for (var ei = begin; ei < end; ei++) {
    let j = adjTgt[ei];
    let dx = ix - pos[j * 3u];
    let dy = iy - pos[j * 3u + 1u];
    let dz = iz - pos[j * 3u + 2u];
    let dist = max(0.3f, sqrt(dx * dx + dy * dy + dz * dz));
    let f = min(dist * params.att, params.ATT_CAP);
    let inv = 1.0f / dist;

    ax -= dx * inv * f;
    ay -= dy * inv * f;
    az -= dz * inv * f;
  }

  vel[i * 3u] += ax;
  vel[i * 3u + 1u] += ay;
  vel[i * 3u + 2u] += az;
}

// ── Update: velocity cap, damping, origin attraction, shell constraint ──

@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }

  // Origin attraction
  vel[i * 3u] -= pos[i * 3u] * params.originStr;
  vel[i * 3u + 1u] -= pos[i * 3u + 1u] * params.originStr;
  vel[i * 3u + 2u] -= pos[i * 3u + 2u] * params.originStr;

  // Velocity cap
  let vx = vel[i * 3u];
  let vy = vel[i * 3u + 1u];
  let vz = vel[i * 3u + 2u];
  let vm = sqrt(vx * vx + vy * vy + vz * vz);
  if (vm > params.VEL_CAP) {
    let s = params.VEL_CAP / vm;
    vel[i * 3u] = vx * s;
    vel[i * 3u + 1u] = vy * s;
    vel[i * 3u + 2u] = vz * s;
  }

  // Damping
  vel[i * 3u] *= params.damp;
  vel[i * 3u + 1u] *= params.damp;
  vel[i * 3u + 2u] *= params.damp;

  // Position update
  pos[i * 3u] += vel[i * 3u];
  pos[i * 3u + 1u] += vel[i * 3u + 1u];
  pos[i * 3u + 2u] += vel[i * 3u + 2u];

  // Shell constraint (adaptive strength: params.sp)
  let dx = pos[i * 3u];
  let dy = pos[i * 3u + 1u];
  let dz = pos[i * 3u + 2u];
  let dist = sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > 1.0f) {
    let drift = (dist - params.shellRadius) * params.sp;
    let inv = 1.0f / dist;
    pos[i * 3u] -= dx * inv * drift;
    pos[i * 3u + 1u] -= dy * inv * drift;
    pos[i * 3u + 2u] -= dz * inv * drift;
  }
}
`;

/** Parameters for one layout run. Must match the CPU layout3D values exactly. */
export interface GPULayoutParams {
  n: number;
  rep: number;
  att: number;
  damp: number;
  REP_CAP: number;
  ATT_CAP: number;
  VEL_CAP: number;
  shellRadius: number;
  sp: number;
  originStr: number;
}

export class GPULayout {
  private device: GPUDevice | null = null;
  private repulsionPipeline: GPUComputePipeline | null = null;
  private attractionPipeline: GPUComputePipeline | null = null;
  private updatePipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  ready = false;

  /** Initialize WebGPU. Returns true on success, false → fall back to CPU. */
  async init(): Promise<boolean> {
    if (this.ready) return true; // already initialized
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) {
        console.warn('[GPULayout] WebGPU not available — using CPU layout');
        return false;
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.warn('[GPULayout] No GPU adapter — using CPU layout');
        return false;
      }

      this.device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: 256 * 1024 * 1024,
          maxComputeWorkgroupsPerDimension: 65535,
        },
      });

      this.device.lost.then((info) => {
        console.warn('[GPULayout] Device lost:', info.reason);
        this.ready = false;
        this.device = null;
      });

      const shaderModule = this.device.createShaderModule({ code: WGSL });

      this.bindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } },
        ],
      });

      const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      });

      this.repulsionPipeline = this.device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: 'repulsion' },
      });
      this.attractionPipeline = this.device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: 'attraction' },
      });
      this.updatePipeline = this.device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: 'update' },
      });

      this.ready = true;
      console.log('[GPULayout] WebGPU compute pipeline ready');
      return true;
    } catch (e) {
      console.warn('[GPULayout] Init failed — using CPU layout:', e);
      return false;
    }
  }

  /**
   * Run GPU-accelerated force-directed layout.
   * Returns positions as Float32Array, or null if GPU is unavailable.
   *
   * @param n - node count
   * @param pairs - edge pairs [s, t] (same as passed to layout3D)
   * @param initPos - initial positions (fibonacci sphere)
   * @param params - locked layout parameters
   * @param maxIter - adaptive iteration budget
   */
  async compute(
    n: number,
    pairs: [number, number][],
    initPos: Float32Array,
    params: GPULayoutParams,
    maxIter: number,
  ): Promise<Float32Array | null> {
    if (!this.ready || !this.device || n === 0) return null;

    const device = this.device;

    try {
      // ── Build adjacency lists (CSR format) ──
      const deg = new Uint32Array(n);
      for (const [s, t] of pairs) { deg[s]++; deg[t]++; }

      const adjOff = new Uint32Array(n + 1);
      let off = 0;
      for (let i = 0; i < n; i++) { adjOff[i] = off; off += deg[i]; }
      adjOff[n] = off;

      const adjTgt = new Uint32Array(off);
      const cursor = new Uint32Array(n);
      for (const [s, t] of pairs) {
        adjTgt[adjOff[s] + cursor[s]++] = t;
        adjTgt[adjOff[t] + cursor[t]++] = s;
      }

      // ── Upload buffers ──
      const posBuf = this._upload(initPos.buffer,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
      const velBuf = this._upload(new Float32Array(n * 3).buffer,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const adjOffBuf = this._upload(adjOff.buffer, GPUBufferUsage.STORAGE);
      const adjTgtBuf = this._upload(adjTgt.buffer, GPUBufferUsage.STORAGE);

      // Params buffer: u32 n at [0], then 9 × f32
      const paramsBuf = this._uploadParams(n, params);

      const stagingBuf = device.createBuffer({
        size: n * 3 * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      // ── Bind group ──
      const bindGroup = device.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: posBuf } },
          { binding: 1, resource: { buffer: velBuf } },
          { binding: 2, resource: { buffer: adjOffBuf } },
          { binding: 3, resource: { buffer: adjTgtBuf } },
          { binding: 4, resource: { buffer: paramsBuf } },
        ],
      });

      // ── Command encoding: maxIter × (repulsion → attraction → update) ──
      const encoder = device.createCommandEncoder();
      const computePass = encoder.beginComputePass();
      const wgCount = Math.ceil(n / 64);

      for (let iter = 0; iter < maxIter; iter++) {
        computePass.setPipeline(this.repulsionPipeline!);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(wgCount);

        computePass.setPipeline(this.attractionPipeline!);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(wgCount);

        computePass.setPipeline(this.updatePipeline!);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(wgCount);
      }

      computePass.end();

      // Copy final positions to staging buffer for CPU readback
      encoder.copyBufferToBuffer(posBuf, 0, stagingBuf, 0, n * 3 * 4);

      device.queue.submit([encoder.finish()]);

      // ── Read back ──
      await device.queue.onSubmittedWorkDone();
      await stagingBuf.mapAsync(GPUMapMode.READ);
      const mapped = new Float32Array(stagingBuf.getMappedRange());
      const result = new Float32Array(mapped); // copy — mapped range invalidated on unmap
      stagingBuf.unmap();

      // ── Cleanup non-staging GPU resources ──
      posBuf.destroy();
      velBuf.destroy();
      adjOffBuf.destroy();
      adjTgtBuf.destroy();
      paramsBuf.destroy();
      stagingBuf.destroy();

      return result;
    } catch (e) {
      console.warn('[GPULayout] Compute failed — using CPU layout:', e);
      return null;
    }
  }

  /** Create and upload a GPU buffer from an ArrayBuffer. */
  private _upload(data: ArrayBuffer | SharedArrayBuffer, usage: number): GPUBuffer {
    const buf = this.device!.createBuffer({
      size: data.byteLength,
      usage,
      mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data));
    buf.unmap();
    return buf;
  }

  /** Create params buffer: u32 n at offset 0, then 9 × f32. */
  private _uploadParams(n: number, p: GPULayoutParams): GPUBuffer {
    const ab = new ArrayBuffer(40); // 10 × 4 bytes
    const u32 = new Uint32Array(ab);
    const f32 = new Float32Array(ab);
    u32[0] = n;
    f32[1] = p.rep;
    f32[2] = p.att;
    f32[3] = p.damp;
    f32[4] = p.REP_CAP;
    f32[5] = p.ATT_CAP;
    f32[6] = p.VEL_CAP;
    f32[7] = p.shellRadius;
    f32[8] = p.sp;
    f32[9] = p.originStr;
    return this._upload(ab, GPUBufferUsage.STORAGE);
  }
}

/** Singleton — initialized once, reused across layout runs. */
export const gpuLayout = new GPULayout();
