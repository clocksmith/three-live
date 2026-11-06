/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
/** Optional host-side document editing. Never imported by the viewer bundles. */
import {readAccessorAsFloat32} from './accessor';
import {resolveNodeWorldMatrices} from './math';
import {toGLBData, type GLBData} from './three-view';

export interface SceneEditHost {
  readonly sceneRevision: number;
  getLoadedModel(): unknown;
  loadModel(model: GLBData): Promise<void>;
}
export interface SceneEditConstraints {
  preserveHeight?: boolean | {tolerance?: number};
  preserveBounds?: boolean | {tolerance?: number};
  preserveFootprint?: boolean | {tolerance?: number};
  maxBounds?: [number, number, number];
  matchMaterialOf?: string;
}
export interface SceneEditOptions {
  target: string | string[];
  replacement: GLBData | ArrayBuffer | ArrayBufferView | Promise<GLBData | ArrayBuffer | ArrayBufferView>;
  replacementTarget?: string | string[];
  preserveTransform?: boolean;
  preserveTargetName?: boolean;
  copyMaterialFrom?: string;
  constraints?: SceneEditConstraints;
  warnings?: string[];
}
export interface SceneEditReceipt {
  editId: number;
  revision: number;
  status: 'preview' | 'accepted' | 'rejected' | 'undone';
  applied: boolean;
  targets: string[];
  constraints: Array<{name: string; passed: boolean}>;
  errors: string[];
  warnings: string[];
  undoDepth: number;
}
const MAX_BYTES = 64 * 1024 * 1024;
function snapshot(input: unknown): GLBData {
  const data = toGLBData(input as GLBData);
  const json = JSON.stringify(data.gltf);
  if (data.bin.byteLength > MAX_BYTES || new TextEncoder().encode(json).byteLength > 4 * 1024 * 1024) throw Error('Edit document exceeds storage limit');
  return {...data, gltf: JSON.parse(json), bin: data.bin.slice(0), animations: undefined};
}
function targets(gltf: any, names: string | string[]): number[] {
  const requested = Array.isArray(names) ? names : [names];
  if (!requested.length || requested.some(name => typeof name !== 'string' || !name.trim())) throw Error('An edit needs named targets');
  return [...new Set(requested.map(name => {
    const found = (gltf.nodes || []).map((node: any, i: number) => node.name === name ? i : -1).filter((i: number) => i >= 0);
    if (found.length !== 1) throw Error(`Target "${name}" is absent or ambiguous`);
    return found[0];
  }))] as number[];
}
function descendants(gltf: any, roots: number[]): Set<number> {
  const result = new Set<number>(), pending = [...roots];
  while (pending.length) {
    const i = pending.pop()!;
    if (result.has(i)) continue;
    if (!gltf.nodes?.[i]) throw Error('Invalid node reference');
    result.add(i);
    pending.push(...(gltf.nodes[i].children || []));
  }
  return result;
}
function bounds(data: GLBData, roots: number[]): number[] {
  const g = data.gltf, matrices = resolveNodeWorldMatrices(g);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const i of descendants(g, roots)) {
    const node = g.nodes[i];
    if (node.extensions?.EXT_mesh_gpu_instancing || node.skin !== undefined) throw Error('Bounds constraints on skinned or instanced targets need an explicit adapter');
    for (const primitive of g.meshes?.[node.mesh]?.primitives || []) {
      const accessor = g.accessors?.[primitive.attributes?.POSITION];
      if (accessor?.sparse) throw Error('Sparse position bounds need an explicit adapter');
      const positions = readAccessorAsFloat32(g, data.bin, accessor, 3);
      if (!positions) throw Error('Target has no readable positions');
      const m = matrices[i];
      for (let p = 0; p < positions.length; p += 3) for (let axis = 0; axis < 3; axis++) {
        const v = m[axis] * positions[p] + m[4 + axis] * positions[p + 1] + m[8 + axis] * positions[p + 2] + m[12 + axis];
        if (!Number.isFinite(v) || !Number.isFinite(Math.fround(v))) throw Error('Target transform is not representable');
        min[axis] = Math.min(min[axis], v); max[axis] = Math.max(max[axis], v);
      }
    }
  }
  if (!Number.isFinite(min[0])) throw Error('Target has no geometry');
  return max.map((v, i) => v - min[i]);
}
function firstMaterial(g: any, roots: number[]): any {
  for (const i of descendants(g, roots)) {
    const primitive = g.meshes?.[g.nodes[i].mesh]?.primitives?.[0];
    if (primitive) return g.materials?.[primitive.material] || {};
  }
  throw Error('Material target has no primitives');
}

/** Merge at document level: exports, provenance, and undo use the same glTF. */
export function prepareSceneEdit(input: GLBData, replacement: GLBData, options: SceneEditOptions): {
  model: GLBData; constraints: SceneEditReceipt['constraints'];
} {
  const base = snapshot(input), candidate = snapshot(replacement), g = base.gltf, r = candidate.gltf;
  const selected = targets(g, options.target);
  const affected = descendants(g, selected);
  if ([...affected].some(i => g.nodes[i].skin !== undefined || g.nodes[i].extensions?.EXT_mesh_gpu_instancing) ||
      (g.animations || []).some((a: any) => (a.channels || []).some((c: any) => affected.has(c.target?.node) && !selected.includes(c.target.node)))) {
    throw Error('Editing skinned, instanced, or animated child targets requires an explicit adapter');
  }
  // Overlapping targets would replace a subtree twice.
  for (const i of selected) if (selected.some(j => j !== i && descendants(g, [j]).has(i))) throw Error('Overlapping edit targets');
  const allowed = new Set(['KHR_materials_unlit', 'KHR_materials_clearcoat', 'KHR_materials_transmission',
    'KHR_materials_ior', 'KHR_materials_volume', 'KHR_materials_specular', 'KHR_materials_sheen', 'KHR_mesh_quantization']);
  if ([...(r.extensionsUsed || []), ...(r.extensionsRequired || [])].some((name: string) => !allowed.has(name)) || r.extensions ||
    r.skins?.length || r.animations?.length || r.cameras?.length || (r.nodes || []).some((n: any) => n.extensions || n.skin !== undefined)) {
    throw Error('Replacement extensions, skins, animation, or cameras require an explicit merge adapter');
  }
  if ((g.buffers?.length || 0) > 1 || (r.buffers?.length || 0) > 1 || (r.buffers || []).some((b: any) => b.uri)) throw Error('Edits require a single embedded binary buffer');
  const copiedMaterial = options.copyMaterialFrom ? structuredClone(firstMaterial(g, targets(g, options.copyMaterialFrom))) : null;
  const roots = options.replacementTarget ? targets(r, options.replacementTarget)
    : r.scenes?.[r.scene || 0]?.nodes || (r.nodes || []).map((_n: unknown, i: number) => i).filter((i: number) => !(r.nodes || []).some((n: any) => n.children?.includes(i)));
  if (!roots.length) throw Error('Replacement has no scene roots');
  const fields = ['bufferViews', 'accessors', 'images', 'samplers', 'textures', 'materials', 'meshes', 'nodes'];
  const offset: Record<string, number> = {};
  for (const field of fields) { g[field] ||= []; r[field] ||= []; offset[field] = g[field].length; }
  const byteOffset = Math.ceil(base.bin.byteLength / 4) * 4;
  if (byteOffset + candidate.bin.byteLength > MAX_BYTES) throw Error('Merged edit exceeds storage limit');
  for (const bv of r.bufferViews) { if (bv.buffer && bv.buffer !== 0) throw Error('Unsupported buffer reference'); bv.buffer = 0; bv.byteOffset = (bv.byteOffset || 0) + byteOffset; }
  for (const acc of r.accessors) {
    if (acc.bufferView !== undefined) acc.bufferView += offset.bufferViews;
    if (acc.sparse) for (const part of ['indices', 'values']) acc.sparse[part].bufferView += offset.bufferViews;
  }
  for (const image of r.images) if (image.bufferView !== undefined) image.bufferView += offset.bufferViews;
  for (const texture of r.textures) {
    if (texture.source !== undefined) texture.source += offset.images;
    if (texture.sampler !== undefined) texture.sampler += offset.samplers;
    if (texture.extensions) throw Error('Replacement texture extensions require an explicit adapter');
  }
  function remapTextures(value: any) {
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === 'object') {
        if (key.endsWith('Texture') && child.index !== undefined) child.index += offset.textures;
        remapTextures(child);
      }
    }
  }
  for (const material of r.materials) remapTextures(material);
  for (const mesh of r.meshes) for (const p of mesh.primitives) {
    if (p.extensions) throw Error('Replacement primitive extensions require an explicit adapter');
    for (const attrs of [p.attributes, ...(p.targets || [])]) for (const key of Object.keys(attrs)) attrs[key] += offset.accessors;
    if (p.indices !== undefined) p.indices += offset.accessors;
    if (p.material !== undefined) p.material += offset.materials;
  }
  for (const node of r.nodes) {
    if (node.mesh !== undefined) node.mesh += offset.meshes;
    if (node.children) node.children = node.children.map((i: number) => i + offset.nodes);
  }
  for (const field of fields) g[field].push(...r[field]);
  g.extensionsUsed = [...new Set([...(g.extensionsUsed || []), ...(r.extensionsUsed || [])])];
  g.extensionsRequired = [...new Set([...(g.extensionsRequired || []), ...(r.extensionsRequired || [])])];
  const bytes = new Uint8Array(byteOffset + candidate.bin.byteLength);
  bytes.set(new Uint8Array(base.bin)); bytes.set(new Uint8Array(candidate.bin), byteOffset);
  base.bin = bytes.buffer; g.buffers = [{byteLength: bytes.length}];
  for (const i of selected) {
    const node = g.nodes[i];
    delete node.mesh;
    let nodeOffset = offset.nodes;
    if (i !== selected[0]) {
      nodeOffset = g.nodes.length;
      const clones = structuredClone(r.nodes);
      for (const clone of clones) if (clone.children) clone.children = clone.children.map((j: number) => j - offset.nodes + nodeOffset);
      g.nodes.push(...clones);
    }
    node.children = roots.map((j: number) => j + nodeOffset);
    if (options.preserveTargetName !== false) for (const root of node.children) {
      if (g.nodes[root].name === node.name) delete g.nodes[root].name;
    }
    if (options.preserveTransform === false) { delete node.matrix; delete node.translation; delete node.rotation; delete node.scale; }
    if (options.preserveTargetName === false && roots.length === 1) node.name = r.nodes[roots[0]].name;
  }
  if (options.copyMaterialFrom) {
    const index = g.materials.push(copiedMaterial) - 1;
    for (const i of descendants(g, roots.map((j: number) => j + offset.nodes))) {
      for (const p of g.meshes[g.nodes[i].mesh]?.primitives || []) p.material = index;
    }
  }
  // Validate actual uploaded positions and transforms even without constraints.
  bounds(base, selected);
  const checks: SceneEditReceipt['constraints'] = [], c = options.constraints;
  if (c) {
    const before = bounds(input, targets(input.gltf, options.target)), after = bounds(base, selected);
    for (const [name, axes, fallback] of [['preserveHeight', [1], 0.05], ['preserveBounds', [0, 1, 2], 0.1], ['preserveFootprint', [0, 2], 0.1]] as const) {
      const value = c[name];
      if (!value) continue;
      const tolerance = typeof value === 'object' ? value.tolerance ?? fallback : fallback;
      if (!Number.isFinite(tolerance) || tolerance < 0) throw Error('Invalid constraint tolerance');
      checks.push({name, passed: axes.every(i => Math.abs(after[i] - before[i]) <= tolerance * Math.max(before[i], 1e-4))});
    }
    if (c.maxBounds) {
      if (c.maxBounds.length !== 3 || c.maxBounds.some(v => !Number.isFinite(v) || v < 0)) throw Error('Invalid maximum bounds');
      checks.push({name: 'maxBounds', passed: after.every((v, i) => v <= c.maxBounds![i])});
    }
    if (c.matchMaterialOf) checks.push({name: 'matchMaterialOf', passed:
      JSON.stringify(firstMaterial(g, selected)) === JSON.stringify(firstMaterial(input.gltf, targets(input.gltf, c.matchMaterialOf)))});
  }
  return {model: base, constraints: checks};
}

/** Owns bounded document snapshots, never shared GPU handles or renderer internals. */
export class SceneEditor {
  private generation = 0;
  private installed: unknown;
  private revision: number;
  private active: {before: GLBData; after: GLBData; receipt: SceneEditReceipt} | null = null;
  private undo: GLBData[] = [];
  constructor(private readonly host: SceneEditHost, private readonly maxUndoSteps = 8) {
    if (!Number.isInteger(maxUndoSteps) || maxUndoSteps < 0 || maxUndoSteps > 16) throw Error('Undo limit must be 0–16');
    this.installed = host.getLoadedModel(); this.revision = host.sceneRevision;
  }
  private synchronize(): void {
    if (this.installed !== this.host.getLoadedModel() || this.revision !== this.host.sceneRevision) {
      this.generation++; this.active = null; this.undo = [];
      this.installed = this.host.getLoadedModel(); this.revision = this.host.sceneRevision;
    }
  }
  private receipt(status: SceneEditReceipt['status'], errors: string[] = []): SceneEditReceipt {
    return {editId: this.generation, revision: this.host.sceneRevision, status, applied: false,
      targets: [], constraints: [], warnings: [], errors, undoDepth: this.undo.length};
  }
  async previewEdit(options: SceneEditOptions): Promise<SceneEditReceipt> {
    this.synchronize();
    if (this.active) {
      const rejected = await this.rejectEdit();
      if (rejected.errors.length) return rejected;
    }
    const token = ++this.generation, revision = this.host.sceneRevision, source = this.host.getLoadedModel();
    try {
      const replacement = snapshot(await options.replacement), before = snapshot(source);
      if (token !== this.generation || revision !== this.host.sceneRevision || source !== this.host.getLoadedModel()) throw Error('Edit was superseded');
      const prepared = prepareSceneEdit(before, replacement, options);
      const receipt = {...this.receipt('preview'), targets: Array.isArray(options.target) ? [...options.target] : [options.target],
        constraints: prepared.constraints, warnings: [...(options.warnings || [])]};
      if (prepared.constraints.some(c => !c.passed)) return {...receipt, status: 'rejected', errors: ['Edit constraints failed']};
      await this.host.loadModel(prepared.model);
      if (token !== this.generation || this.host.getLoadedModel() !== prepared.model) throw Error('Edit was superseded');
      this.installed = prepared.model; this.revision = this.host.sceneRevision;
      receipt.revision = this.revision; receipt.applied = true;
      this.active = {before, after: prepared.model, receipt};
      return structuredClone(receipt);
    } catch (error) {
      if (token === this.generation && source === this.host.getLoadedModel()) this.revision = this.host.sceneRevision;
      return this.receipt('rejected', [String(error)]);
    }
  }
  acceptEdit(): SceneEditReceipt {
    this.synchronize();
    if (!this.active) return this.receipt('rejected', ['No active preview']);
    const {before, receipt} = this.active; this.active = null;
    this.undo.push(before);
    while (this.undo.length > this.maxUndoSteps || this.undo.reduce((n, d) => n + d.bin.byteLength, 0) > MAX_BYTES * 2) this.undo.shift();
    return {...structuredClone(receipt), status: 'accepted', applied: true, undoDepth: this.undo.length};
  }
  async rejectEdit(): Promise<SceneEditReceipt> {
    this.synchronize(); this.generation++;
    if (!this.active) return this.receipt('rejected', ['No active preview']);
    const previous = this.active.before;
    try {
      await this.host.loadModel(previous);
      if (this.host.getLoadedModel() !== previous) throw Error('Edit was superseded');
      this.active = null; this.installed = previous; this.revision = this.host.sceneRevision;
      return this.receipt('rejected');
    } catch (error) {
      if (this.host.getLoadedModel() === this.installed) this.revision = this.host.sceneRevision;
      return this.receipt('rejected', [String(error)]);
    }
  }
  async undoEdit(): Promise<SceneEditReceipt> {
    this.synchronize();
    if (this.active) {
      const rejected = await this.rejectEdit();
      if (rejected.errors.length) return rejected;
    }
    const previous = this.undo[this.undo.length - 1];
    if (!previous) return this.receipt('rejected', ['No accepted edit to undo']);
    this.generation++;
    try {
      await this.host.loadModel(previous);
      if (this.host.getLoadedModel() !== previous) throw Error('Edit was superseded');
      this.undo.pop(); this.installed = previous; this.revision = this.host.sceneRevision;
      return {...this.receipt('undone'), applied: true};
    } catch (error) {
      if (this.host.getLoadedModel() === this.installed) this.revision = this.host.sceneRevision;
      return this.receipt('rejected', [String(error)]);
    }
  }
  async dispose(): Promise<void> {
    if (this.active) {
      const rejected = await this.rejectEdit();
      if (rejected.errors.length) throw Error(rejected.errors.join('; '));
    }
    this.generation++; this.undo = [];
  }
}
