import { buildDiffusion, stableDiffusionDt, type TissueGeometry } from './fem';
import type { IonicModel } from './ionic';
import { ACT_THRESHOLD, REPOL_THRESHOLD, type ActivationRecord, type BackendInit, type SolverBackend } from './backend';
import { MAX_STIM_SITES } from './stimulus';

/**
 * WebGPU compute backend: same splitting scheme and update order as CpuBackend.
 * Per time step: (nSub − 1) diffusion-only passes, then one fused pass doing the last diffusion
 * substep + stimulus + reaction + activation detection. Per-step uniforms (time, stimulus
 * amplitudes) live in one buffer addressed with dynamic offsets, so a whole batch of steps is
 * encoded into a single command buffer. Storage buffers are packed to fit the default limit of
 * 8 per shader stage.
 */
const WG = 64;
const STEP_STRIDE = 256; // minUniformBufferOffsetAlignment
const MAX_BATCH = 512;
const NEG = -1e30; // stands in for −Infinity in f32 storage

function shader(model: IonicModel, n: number): string {
  return /* wgsl */ `
const N: u32 = ${n}u;
const ACT: f32 = ${ACT_THRESHOLD};
const REPOL: f32 = ${REPOL_THRESHOLD};

struct StepU {
  t0: f32,
  dt: f32,
  dts: f32,
  pad: f32,
  amps0: vec4<f32>,
  amps1: vec4<f32>,
};

@group(0) @binding(0) var<uniform> U: StepU;
@group(0) @binding(1) var<storage, read> graph: array<u32>;      // rowPtr[N+1] ++ col[]
@group(0) @binding(2) var<storage, read> w: array<f32>;
@group(0) @binding(3) var<storage, read> vIn: array<f32>;
@group(0) @binding(4) var<storage, read_write> vOut: array<f32>;
@group(0) @binding(5) var<storage, read> vStart: array<f32>;
@group(0) @binding(6) var<storage, read_write> gates: array<vec2<f32>>;
@group(0) @binding(7) var<storage, read> vparams: array<vec4<f32>>; // apdScale, excitable, site, 0
@group(0) @binding(8) var<storage, read_write> act: array<vec4<f32>>; // last, prev, repol, count

${model.wgsl()}

fn lap(i: u32) -> f32 {
  let vi = vIn[i];
  var acc = 0.0;
  let s = graph[i];
  let e = graph[i + 1u];
  for (var k = s; k < e; k = k + 1u) {
    acc = acc + w[k] * (vIn[graph[N + 1u + k]] - vi);
  }
  return acc;
}

fn amp(site: i32) -> f32 {
  if (site < 4) { return U.amps0[site]; }
  return U.amps1[site - 4];
}

@compute @workgroup_size(${WG})
fn diffuse(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= N) { return; }
  vOut[i] = vIn[i] + U.dts * lap(i);
}

@compute @workgroup_size(${WG})
fn finalStep(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= N) { return; }
  var v = vIn[i] + U.dts * lap(i);
  let p = vparams[i];
  let site = i32(p.z);
  if (site >= 0) { v = v + U.dt * amp(site); }
  let g = gates[i];
  let r = react(v, g.x, g.y, p.x, U.dt, p.y > 0.5);
  vOut[i] = r.x;
  gates[i] = vec2<f32>(r.y, r.z);
  let a = vStart[i];
  let b = r.x;
  var A = act[i];
  if (a < ACT && b >= ACT) {
    A.y = A.x;
    A.x = U.t0 + U.dt * (ACT - a) / (b - a);
    A.w = A.w + 1.0;
    act[i] = A;
  } else if (a > REPOL && b <= REPOL) {
    A.z = U.t0 + U.dt * (a - REPOL) / (a - b);
    act[i] = A;
  }
}
`;
}

export class WebGpuBackend implements SolverBackend {
  readonly kind = 'webgpu' as const;
  readonly nV: number;
  diffusionSubsteps = 1;
  private readonly geom: TissueGeometry;
  private readonly dt: number;
  private readonly model: IonicModel;
  private readonly device: GPUDevice;
  private readonly bufs: Record<'graph' | 'w' | 'vA' | 'vB' | 'vS' | 'gates' | 'vparams' | 'act' | 'uni', GPUBuffer>;
  private readonly layout: GPUBindGroupLayout;
  private readonly pDiffuse: GPUComputePipeline;
  private readonly pFinal: GPUComputePipeline;
  private cur: 'vA' | 'vB' = 'vA';
  private readonly bindCache = new Map<string, GPUBindGroup>();
  private readonly uniData = new ArrayBuffer(STEP_STRIDE * MAX_BATCH);
  private apd: Float32Array;
  private exc: Uint8Array;
  private siteOf: Int32Array;

  static async create(init: BackendInit, device?: GPUDevice): Promise<WebGpuBackend> {
    let dev = device;
    if (!dev) {
      const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
      if (!gpu) throw new Error('WebGPU is not available in this browser');
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No WebGPU adapter');
      dev = await adapter.requestDevice();
    }
    const b = new WebGpuBackend(init, dev);
    const info = await b.compileInfo();
    if (info.length) throw new Error(`WGSL compile errors:\n${info.join('\n')}`);
    return b;
  }

  private constructor(init: BackendInit, device: GPUDevice) {
    this.geom = init.geom;
    this.dt = init.dt;
    this.model = init.model;
    this.device = device;
    const n = (this.nV = init.geom.nV);
    this.apd = init.apdScale;
    this.exc = init.excitable;
    this.siteOf = init.siteOf;
    const S = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
    const nnz = init.geom.col.length;
    const mk = (size: number, usage: number) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    this.bufs = {
      graph: mk(4 * (n + 1 + nnz), S | CD),
      w: mk(4 * nnz, S | CD),
      vA: mk(4 * n, S | CD | CS),
      vB: mk(4 * n, S | CD | CS),
      vS: mk(4 * n, S | CD | CS),
      gates: mk(8 * n, S | CD | CS),
      vparams: mk(16 * n, S | CD),
      act: mk(16 * n, S | CD | CS),
      uni: device.createBuffer({ size: STEP_STRIDE * MAX_BATCH, usage: GPUBufferUsage.UNIFORM | CD }),
    };
    const graph = new Uint32Array(n + 1 + nnz);
    graph.set(init.geom.rowPtr, 0);
    graph.set(init.geom.col, n + 1);
    device.queue.writeBuffer(this.bufs.graph, 0, graph);
    const rest = init.model.restState();
    device.queue.writeBuffer(this.bufs.vA, 0, new Float32Array(n).fill(rest[0]));
    const gates = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) { gates[2 * i] = rest[1]; gates[2 * i + 1] = rest[2]; }
    device.queue.writeBuffer(this.bufs.gates, 0, gates);
    this.resetActivation();
    this.writeVertexParams();
    this.setEdgeDiffusivity(init.edgeD);

    const st = (type: GPUBufferBindingType): GPUBindGroupLayoutEntry['buffer'] => ({ type });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: st('read-only-storage') },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: st('read-only-storage') },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: st('read-only-storage') },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: st('storage') },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: st('read-only-storage') },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: st('storage') },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: st('read-only-storage') },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: st('storage') },
      ],
    });
    const module = device.createShaderModule({ code: shader(init.model, n) });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pDiffuse = device.createComputePipeline({ layout, compute: { module, entryPoint: 'diffuse' } });
    this.pFinal = device.createComputePipeline({ layout, compute: { module, entryPoint: 'finalStep' } });
    this.module = module;
  }

  private module: GPUShaderModule;

  private async compileInfo(): Promise<string[]> {
    const info = await this.module.getCompilationInfo();
    return info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  }

  private bind(inp: 'vA' | 'vB', start: 'vA' | 'vB' | 'vS'): GPUBindGroup {
    const key = `${inp}:${start}`;
    let bg = this.bindCache.get(key);
    if (!bg) {
      const out = inp === 'vA' ? 'vB' : 'vA';
      const b = this.bufs;
      bg = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: b.uni, size: 48 } },
          { binding: 1, resource: { buffer: b.graph } },
          { binding: 2, resource: { buffer: b.w } },
          { binding: 3, resource: { buffer: b[inp] } },
          { binding: 4, resource: { buffer: b[out] } },
          { binding: 5, resource: { buffer: b[start] } },
          { binding: 6, resource: { buffer: b.gates } },
          { binding: 7, resource: { buffer: b.vparams } },
          { binding: 8, resource: { buffer: b.act } },
        ],
      });
      this.bindCache.set(key, bg);
    }
    return bg;
  }

  private writeVertexParams(): void {
    const n = this.nV;
    const p = new Float32Array(4 * n);
    for (let i = 0; i < n; i++) {
      p[4 * i] = this.apd[i]!;
      p[4 * i + 1] = this.exc[i]!;
      p[4 * i + 2] = this.siteOf[i]!;
    }
    this.device.queue.writeBuffer(this.bufs.vparams, 0, p);
  }

  setEdgeDiffusivity(edgeD: Float32Array): void {
    const op = buildDiffusion(this.geom, edgeD);
    this.diffusionSubsteps = Math.max(1, Math.ceil(this.dt / stableDiffusionDt(op)));
    this.device.queue.writeBuffer(this.bufs.w, 0, op.w);
  }

  setVertexParams(apdScale: Float32Array, excitable: Uint8Array): void {
    this.apd = apdScale;
    this.exc = excitable;
    this.writeVertexParams();
  }

  setSiteMap(siteOf: Int32Array): void {
    this.siteOf = siteOf;
    this.writeVertexParams();
  }

  async step(nSteps: number, t0: number, amps: Float32Array): Promise<void> {
    const nSub = this.diffusionSubsteps;
    const groups = Math.ceil(this.nV / WG);
    for (let done = 0; done < nSteps; ) {
      const batch = Math.min(MAX_BATCH, nSteps - done);
      const f = new Float32Array(this.uniData);
      for (let s = 0; s < batch; s++) {
        const o = (s * STEP_STRIDE) / 4;
        f[o] = t0 + (done + s) * this.dt;
        f[o + 1] = this.dt;
        f[o + 2] = this.dt / nSub;
        f[o + 3] = 0;
        for (let k = 0; k < MAX_STIM_SITES; k++) f[o + 4 + k] = amps[(done + s) * MAX_STIM_SITES + k]!;
      }
      this.device.queue.writeBuffer(this.bufs.uni, 0, this.uniData, 0, batch * STEP_STRIDE);
      const enc = this.device.createCommandEncoder();
      let pass: GPUComputePassEncoder | null = null;
      for (let s = 0; s < batch; s++) {
        const off = [s * STEP_STRIDE];
        if (nSub > 1) {
          pass?.end();
          pass = null;
          enc.copyBufferToBuffer(this.bufs[this.cur], 0, this.bufs.vS, 0, 4 * this.nV);
        }
        pass ??= enc.beginComputePass();
        for (let k = 0; k < nSub - 1; k++) {
          pass.setPipeline(this.pDiffuse);
          pass.setBindGroup(0, this.bind(this.cur, 'vS'), off);
          pass.dispatchWorkgroups(groups);
          this.cur = this.cur === 'vA' ? 'vB' : 'vA';
        }
        pass.setPipeline(this.pFinal);
        pass.setBindGroup(0, this.bind(this.cur, nSub > 1 ? 'vS' : this.cur), off);
        pass.dispatchWorkgroups(groups);
        this.cur = this.cur === 'vA' ? 'vB' : 'vA';
      }
      pass?.end();
      this.device.queue.submit([enc.finish()]);
      done += batch;
    }
    await this.device.queue.onSubmittedWorkDone();
  }

  private async read(src: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return out;
  }

  async readV(): Promise<Float32Array> {
    return new Float32Array(await this.read(this.bufs[this.cur], 4 * this.nV));
  }

  async readActivation(): Promise<ActivationRecord> {
    const a = new Float32Array(await this.read(this.bufs.act, 16 * this.nV));
    const n = this.nV;
    const fix = (x: number) => (x <= NEG / 2 ? -Infinity : x);
    const rec: ActivationRecord = { last: new Float32Array(n), prev: new Float32Array(n), repol: new Float32Array(n), count: new Uint32Array(n) };
    for (let i = 0; i < n; i++) {
      rec.last[i] = fix(a[4 * i]!);
      rec.prev[i] = fix(a[4 * i + 1]!);
      rec.repol[i] = fix(a[4 * i + 2]!);
      rec.count[i] = a[4 * i + 3]!;
    }
    return rec;
  }

  setState(v: Float32Array, g0?: Float32Array, g1?: Float32Array): void {
    this.device.queue.writeBuffer(this.bufs[this.cur], 0, v);
    if (g0 || g1) {
      const rest = this.model.restState();
      const g = new Float32Array(2 * this.nV);
      for (let i = 0; i < this.nV; i++) {
        g[2 * i] = g0 ? g0[i]! : rest[1];
        g[2 * i + 1] = g1 ? g1[i]! : rest[2];
      }
      this.device.queue.writeBuffer(this.bufs.gates, 0, g);
    }
  }

  async getState(): Promise<{ v: Float32Array; g0: Float32Array; g1: Float32Array }> {
    const v = await this.readV();
    const g = new Float32Array(await this.read(this.bufs.gates, 8 * this.nV));
    const g0 = new Float32Array(this.nV), g1 = new Float32Array(this.nV);
    for (let i = 0; i < this.nV; i++) { g0[i] = g[2 * i]!; g1[i] = g[2 * i + 1]!; }
    return { v, g0, g1 };
  }

  resetActivation(): void {
    const a = new Float32Array(4 * this.nV);
    for (let i = 0; i < this.nV; i++) { a[4 * i] = NEG; a[4 * i + 1] = NEG; a[4 * i + 2] = NEG; }
    this.device.queue.writeBuffer(this.bufs.act, 0, a);
  }

  dispose(): void {
    for (const b of Object.values(this.bufs)) b.destroy();
  }
}
