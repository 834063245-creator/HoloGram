// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

/// <reference types="@webgpu/types" />

// ═══════════════════════════════════════════════════════════════
// GPU 计算布局 — WebGPU 力导向图布局
// 用并行计算着色器替代 CPU layout3D。
// 每次迭代三趟计算：排斥 → 吸引 → 更新。
// WebGPU 不可用时优雅降级。
//
// 核心参数（rep、att、damp、shellRadius、caps）已锁定 —
// 与 JS layout3D 函数保持一致。
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

// ── 排斥：O(n) 线程，每个 O(n) 工作量 = O(n²) 并行 ──

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

// ── 吸引：逐节点遍历邻接边（无需原子操作）──

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

// ── 更新：速度上限、阻尼、原点吸引、外壳约束 ──

@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }

  // 原点吸引
  vel[i * 3u] -= pos[i * 3u] * params.originStr;
  vel[i * 3u + 1u] -= pos[i * 3u + 1u] * params.originStr;
  vel[i * 3u + 2u] -= pos[i * 3u + 2u] * params.originStr;

  // 速度上限
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

  // 阻尼
  vel[i * 3u] *= params.damp;
  vel[i * 3u + 1u] *= params.damp;
  vel[i * 3u + 2u] *= params.damp;

  // 位置更新
  pos[i * 3u] += vel[i * 3u];
  pos[i * 3u + 1u] += vel[i * 3u + 1u];
  pos[i * 3u + 2u] += vel[i * 3u + 2u];

  // 外壳约束 — 软约束，仅拉回远端离群点（与 graph-layout.ts 修复一致）
  let dx = pos[i * 3u];
  let dy = pos[i * 3u + 1u];
  let dz = pos[i * 3u + 2u];
  let dist = sqrt(dx * dx + dy * dy + dz * dz);
  let hardLimit = params.shellRadius * 2.5;
  if (dist > hardLimit) {
    let pull = (dist - hardLimit) * params.sp * 3.0;
    let inv = 1.0f / dist;
    pos[i * 3u] -= dx * inv * pull;
    pos[i * 3u + 1u] -= dy * inv * pull;
    pos[i * 3u + 2u] -= dz * inv * pull;
  }
}
`;

/** 一次布局运行的参数。必须与 CPU layout3D 的值完全一致。 */
interface GPULayoutParams {
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
  private _initPromise: Promise<boolean> | null = null;

  /** 初始化 WebGPU。幂等 — 并发调用者共享同一个 Promise。 */
  init(): Promise<boolean> {
    if (!this._initPromise) this._initPromise = this._doInit();
    return this._initPromise;
  }

  private async _doInit(): Promise<boolean> {
    if (this.ready) return true; // 已初始化
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
   * 运行 GPU 加速的力导向布局。
   * 返回 Float32Array 格式的位置，GPU 不可用时返回 null。
   *
   * @param n - 节点数
   * @param pairs - 边对 [s, t]（与传入 layout3D 的相同）
   * @param initPos - 初始位置（斐波那契球面）
   * @param params - 锁定的布局参数
   * @param maxIter - 自适应迭代预算
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
      // ── 构建邻接表（CSR 格式）──
      const deg = new Uint32Array(n);
      for (const [s, t] of pairs) {
        deg[s]++;
        deg[t]++;
      }

      const adjOff = new Uint32Array(n + 1);
      let off = 0;
      for (let i = 0; i < n; i++) {
        adjOff[i] = off;
        off += deg[i];
      }
      adjOff[n] = off;

      const adjTgt = new Uint32Array(off);
      const cursor = new Uint32Array(n);
      for (const [s, t] of pairs) {
        adjTgt[adjOff[s] + cursor[s]++] = t;
        adjTgt[adjOff[t] + cursor[t]++] = s;
      }

      // ── 上传缓冲区 ──
      const posBuf = this._upload(
        initPos.buffer,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      );
      const velBuf = this._upload(new Float32Array(n * 3).buffer, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const adjOffBuf = this._upload(adjOff.buffer, GPUBufferUsage.STORAGE);
      const adjTgtBuf = this._upload(adjTgt.buffer, GPUBufferUsage.STORAGE);

      // 参数缓冲区：偏移 0 处为 u32 n，随后 9 × f32
      const paramsBuf = this._uploadParams(n, params);

      const stagingBuf = device.createBuffer({
        size: n * 3 * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      // ── 绑定组 ──
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

      // ── 命令编码：maxIter ×（排斥 → 吸引 → 更新）──
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

      // 将最终位置复制到暂存缓冲区供 CPU 回读
      encoder.copyBufferToBuffer(posBuf, 0, stagingBuf, 0, n * 3 * 4);

      device.queue.submit([encoder.finish()]);

      // ── 回读 ──
      await device.queue.onSubmittedWorkDone();
      await stagingBuf.mapAsync(GPUMapMode.READ);
      const mapped = new Float32Array(stagingBuf.getMappedRange());
      const result = new Float32Array(mapped); // 拷贝 — 映射范围在 unmap 后失效
      stagingBuf.unmap();

      // ── 清理非暂存 GPU 资源 ──
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

  /** 从 ArrayBuffer 创建并上传 GPU 缓冲区。 */
  private _upload(data: ArrayBuffer | SharedArrayBuffer, usage: number): GPUBuffer {
    const buf = this.device?.createBuffer({
      size: data.byteLength,
      usage,
      mappedAtCreation: true,
    });
    if (!buf) throw new Error('GPU buffer creation failed');
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data));
    buf.unmap();
    return buf;
  }

  /** 创建参数缓冲区：偏移 0 处为 u32 n，随后 9 × f32。 */
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

/** 单例 — 初始化一次，跨布局运行复用。 */
export const gpuLayout = new GPULayout();
