// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {strict as assert} from 'node:assert';
import {SceneEditor, prepareSceneEdit} from '../src/edits';
import THREE from '../src/three-author';
import {toGLBData} from '../src/three-view';
function scene(name = 'Tower', height = 2) {
  const s = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, height, 1), new THREE.MeshStandardMaterial({color: 0x336699}));
  mesh.name = name; mesh.position.set(1, 2, 3); s.add(mesh);
  return toGLBData(s.toGLB().buffer);
}
async function main() {
  const original = scene(), replacement = scene('NewTower');
  let current = original, revision = 0, loads = 0, fail = false;
  const host = {get sceneRevision() { return revision; }, getLoadedModel: () => current,
    async loadModel(model: any) { revision++; loads++; if (fail) throw Error('GPU preparation failed'); current = model; }};
  const editor = new SceneEditor(host);
  const proposed = await editor.previewEdit({target: 'Tower', replacement, constraints: {preserveHeight: true}});
  assert.equal(proposed.status, 'preview'); assert.equal(proposed.applied, true);
  assert.equal(current.gltf.nodes[0].name, original.gltf.nodes[0].name);
  const exported = JSON.parse(JSON.stringify(current.gltf));
  assert.ok(exported.nodes.some((n: any) => n.name === 'Tower'));
  assert.deepEqual(original.bin, scene().bin, 'preparation never mutates input bytes');
  assert.equal(editor.acceptEdit().status, 'accepted');
  assert.equal((await editor.undoEdit()).status, 'undone');
  assert.deepEqual(current.gltf, original.gltf, 'undo restores the complete authored document');
  const beforeFailure = current, previousLoads = loads;
  const rejected = await editor.previewEdit({target: 'Tower', replacement: scene('Tall', 8), constraints: {preserveHeight: true}});
  assert.equal(rejected.status, 'rejected'); assert.equal(current, beforeFailure); assert.equal(loads, previousLoads);
  assert.equal(rejected.constraints[0].passed, false);
  assert.equal((await editor.previewEdit({target: 'Missing', replacement})).status, 'rejected');
  assert.equal((await editor.previewEdit({target: 'Tower', replacement, constraints: {preserveHeight: {tolerance: NaN}}})).status, 'rejected');
  await editor.previewEdit({target: 'Tower', replacement});
  assert.equal((await editor.rejectEdit()).status, 'rejected');
  assert.deepEqual(current.gltf, original.gltf, 'reject restores exported state as well as visible state');
  let resolve!: (value: any) => void;
  const pending = editor.previewEdit({target: 'Tower', replacement: new Promise(r => { resolve = r; })});
  revision++; // A later external fetch has started but has not committed yet.
  resolve(replacement);
  assert.match((await pending).errors.join(), /superseded/);
  assert.equal(current.gltf.nodes[0].name, original.gltf.nodes[0].name);
  fail = true;
  assert.equal((await editor.previewEdit({target: 'Tower', replacement})).status, 'rejected');
  assert.equal(current.gltf.nodes[0].name, original.gltf.nodes[0].name);
  fail = false;
  await editor.previewEdit({target: 'Tower', replacement}); editor.acceptEdit();
  await editor.previewEdit({target: 'Tower', replacement});
  assert.equal(editor.acceptEdit().status, 'accepted', 'repeated named edits retain an unambiguous target');
  const prepared = prepareSceneEdit(original, replacement, {target: 'Tower', replacement, copyMaterialFrom: 'Tower', constraints: {matchMaterialOf: 'Tower'}});
  assert.ok(prepared.constraints.every(c => c.passed));
  assert.ok(prepared.model.bin.byteLength > original.bin.byteLength);
  const duplicated = scene(); duplicated.gltf.nodes.push(structuredClone(duplicated.gltf.nodes.find((n: any) => n.name === 'Tower')));
  assert.throws(() => prepareSceneEdit(duplicated, replacement, {target: 'Tower', replacement}), /ambiguous/);
  const unsupported = scene(); unsupported.gltf.extensionsRequired = ['UNKNOWN_extension'];
  assert.throws(() => prepareSceneEdit(original, unsupported, {target: 'Tower', replacement: unsupported}), /adapter/);
  // Failed rollback retains the preview and undo snapshot for a later retry.
  await editor.previewEdit({target: 'Tower', replacement}); fail = true;
  assert.ok((await editor.rejectEdit()).errors.length);
  fail = false;
  assert.equal(editor.acceptEdit().status, 'accepted');
  assert.equal((await editor.undoEdit()).status, 'undone');
  const multi = scene();
  const firstNode = multi.gltf.nodes.find((n: any) => n.name === 'Tower');
  const sibling = structuredClone(firstNode); sibling.name = 'Other';
  const siblingIndex = multi.gltf.nodes.push(sibling) - 1;
  multi.gltf.scenes[0].nodes.push(siblingIndex);
  const both = prepareSceneEdit(multi, replacement, {target: ['Tower', 'Other'], replacement});
  const a = both.model.gltf.nodes.find((n: any) => n.name === 'Tower');
  const b = both.model.gltf.nodes.find((n: any) => n.name === 'Other');
  assert.notEqual(a.children[0], b.children[0], 'multi-target replacements own distinct node subtrees');
  await editor.dispose();
  console.log('PASS document editing: preview, accept, reject, undo, constraints, names, bytes, and revision races');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
