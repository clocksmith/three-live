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

import assert from 'node:assert/strict';
import {
  computeSubtreeBounds,
  computeSubtreeBoundsSize,
  prepareSceneEdit,
  SceneEditor,
  sceneEditsPlugin,
  type SceneEditableElement,
} from '../src/edits';
import {
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Scene,
} from '../src/three-author';
import {
  decodeMeshoptGLB,
  encodeMeshoptBuffer,
} from '../src/plugins/meshopt';
import {toGLBData} from '../src/three-view';

function buildTowerScene(
  name = 'Tower',
  size: [number, number, number] = [1, 2, 1],
  color = 0xef4444,
  asCylinder = false,
  position: [number, number, number] = [0, 0, 0],
) {
  const s = new Scene();
  const geo = asCylinder
    ? new CylinderGeometry(size[0] / 2, size[0] / 2, size[1], 32)
    : new BoxGeometry(size[0], size[1], size[2]);
  const mesh = new Mesh(
    geo,
    new MeshStandardMaterial({color, roughness: 0.4, metalness: 0.1}),
  );
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  s.add(mesh);
  return toGLBData(s.toGLB());
}

async function runTests() {
  const original = buildTowerScene(
    'Tower',
    [1, 2, 1],
    0xef4444,
    false,
    [1, 2, 3],
  );
  const cylinderReplacement = buildTowerScene(
    'Turret',
    [1, 2, 1],
    0x3b82f6,
    true,
    [0, 0, 0],
  );

  let current = original;
  let loads = 0;
  const deniedEvents: Array<{capability: string; feature: string}> = [];

  const host: SceneEditableElement & {
    dispatchEvent(ev: {type?: string; detail?: any}): boolean;
  } = {
    getLoadedModel: () => current,
    async loadModel(model: any) {
      loads++;
      current = model;
    },
    dispatchEvent(ev: {type?: string; detail?: any}) {
      if (ev?.type === 'three-capability-denied' && ev.detail) {
        deniedEvents.push({
          capability: ev.detail.capability,
          feature: ev.detail.feature,
        });
      }
      return true;
    },
  };

  // 1. Plugin installation attaches el.sceneEditor and *NodeEdit helpers cleanly
  sceneEditsPlugin.onElementConnected?.(host);
  assert.ok(host.sceneEditor instanceof SceneEditor);
  assert.equal(typeof host.previewNodeEdit, 'function');

  // 2. Object replacement preserving bounds AND copying/matching original material
  const preview = await host.previewNodeEdit!({
    target: 'Tower',
    replacement: cylinderReplacement,
    copyMaterialFrom: 'Tower',
    constraints: {
      preserveBounds: {tolerance: 0.02},
      matchMaterialOf: 'Tower',
    },
  });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.applied, true);
  assert.ok(preview.constraints.every((c) => c.passed));
  const afterBounds = computeSubtreeBoundsSize(current, [0]);
  assert.ok(Math.abs(afterBounds[0] - 1) < 0.02);
  assert.ok(Math.abs(afterBounds[1] - 2) < 0.02);
  assert.ok(Math.abs(afterBounds[2] - 1) < 0.02);

  const accepted = host.acceptNodeEdit!();
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.undoDepth, 1);

  const undone = await host.undoNodeEdit!();
  assert.equal(undone.status, 'undone');
  assert.deepEqual(current.gltf, original.gltf);

  // 3. Rejected constraint-violating edit leaves the active scene completely untouched
  const snapshotBeforeReject = current;
  const loadsBeforeReject = loads;
  const oversize = buildTowerScene('TallTower', [1, 8, 1], 0xef4444, false);
  const rejected = await host.previewNodeEdit!({
    target: 'Tower',
    replacement: oversize,
    constraints: {preserveHeight: true, preserveBounds: true},
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.applied, false);
  assert.equal(loads, loadsBeforeReject, 'Failed constraints never touch GPU loadModel');
  assert.equal(current, snapshotBeforeReject);

  // 4. Capability enforcement: remote URL replacement fails closed without remote_content
  const deniedReceipt = await host.previewNodeEdit!({
    target: 'Tower',
    replacement: 'https://cdn.example.com/turret.glb',
  });
  assert.equal(deniedReceipt.status, 'rejected');
  assert.equal(deniedReceipt.applied, false);
  assert.ok(
    deniedEvents.some(
      (e) => e.capability === 'remote_content' && e.feature === 'previewEdit',
    ),
  );
  assert.match(deniedReceipt.errors.join(' '), /Capability 'remote_content'/);
  assert.equal(current, snapshotBeforeReject);

  // 5. External host.loadModel call during pending async replacement supersedes the edit
  let resolveSlow!: (v: any) => void;
  const slowPromise = host.previewNodeEdit!({
    target: 'Tower',
    replacement: new Promise((r) => {
      resolveSlow = r;
    }),
  });
  const externalScene = buildTowerScene(
    'Tower',
    [1, 2, 1],
    0x22c55e,
    false,
    [1, 2, 3],
  );
  await host.loadModel(externalScene);
  resolveSlow(cylinderReplacement);
  const superseded = await slowPromise;
  assert.equal(superseded.status, 'rejected');
  assert.match(superseded.errors.join(' '), /superseded/);
  assert.equal(current, externalScene, 'Superseded edit never clobbers external load');

  // 6. preserveBounds rejects an equal-size replacement translated 50 units away
  const translated50Local = buildTowerScene(
    'ShiftedLocal',
    [1, 2, 1],
    0x22c55e,
    false,
    [50, 0, 0],
  );
  const rejectedTranslatedLocal = await host.previewNodeEdit!({
    target: 'Tower',
    replacement: translated50Local,
    constraints: {preserveBounds: true},
  });
  assert.equal(rejectedTranslatedLocal.status, 'rejected');
  assert.equal(rejectedTranslatedLocal.applied, false);
  assert.deepEqual(rejectedTranslatedLocal.constraints, [
    {name: 'preserveBounds', passed: false},
  ]);

  const translated50World = buildTowerScene(
    'Tower',
    [1, 2, 1],
    0x22c55e,
    false,
    [51, 2, 3],
  );
  const rejectedTranslatedWorld = await host.previewNodeEdit!({
    target: 'Tower',
    replacement: translated50World,
    preserveTransform: false,
    constraints: {preserveBounds: true},
  });
  assert.equal(rejectedTranslatedWorld.status, 'rejected');
  assert.equal(rejectedTranslatedWorld.applied, false);
  assert.equal(current, externalScene);

  // 7. Repeated replacements reclaim detached meshes, materials, accessors, and binary bytes
  const boxInitial = buildTowerScene(
    'Box',
    [1, 1, 1],
    0xef4444,
    false,
    [0, 0, 0],
  );
  const initialBinBytes = boxInitial.bin.byteLength;
  assert.equal(initialBinBytes, 840);
  await host.loadModel(boxInitial);

  for (let iter = 0; iter < 8; iter++) {
    const nextBox = buildTowerScene(
      'Box',
      [1, 1, 1],
      0x100000 + iter * 0x112200,
      false,
      [0, 0, 0],
    );
    const r = await host.previewNodeEdit!({
      target: 'Box',
      replacement: nextBox,
      constraints: {preserveBounds: {tolerance: 0.01}},
    });
    assert.equal(r.status, 'preview');
    assert.equal(r.applied, true);
    const acc = host.acceptNodeEdit!();
    assert.equal(acc.status, 'accepted');
  }
  assert.equal(
    current.gltf.meshes.length,
    1,
    'Repeated replacements reclaim prior detached meshes (1 active mesh after 8 edits)',
  );
  assert.equal(
    current.gltf.materials.length,
    1,
    'Repeated replacements reclaim prior detached materials',
  );
  assert.equal(
    current.bin.byteLength,
    initialBinBytes,
    'Repeated replacements repack BIN without unbounded binary growth (840 B -> 840 B)',
  );
  const boundsAfter8 = computeSubtreeBounds(current, [0]);
  assert.deepEqual(boundsAfter8.min, [-0.5, -0.5, -0.5]);
  assert.deepEqual(boundsAfter8.max, [0.5, 0.5, 0.5]);

  // 8. Multi-target subtree isolation & duplicate-target rejection
  const multi = buildTowerScene(
    'Tower',
    [1, 2, 1],
    0xef4444,
    false,
    [1, 2, 3],
  );
  const firstNode = multi.gltf.nodes.find((n: any) => n.name === 'Tower');
  const sibling = structuredClone(firstNode);
  sibling.name = 'Other';
  const siblingIdx = multi.gltf.nodes.push(sibling) - 1;
  multi.gltf.scenes[0].nodes.push(siblingIdx);
  const mergedBoth = prepareSceneEdit(multi, cylinderReplacement, {
    target: ['Tower', 'Other'],
    replacement: cylinderReplacement,
  });
  const nodeA = mergedBoth.model.gltf.nodes.find((n: any) => n.name === 'Tower');
  const nodeB = mergedBoth.model.gltf.nodes.find((n: any) => n.name === 'Other');
  assert.notEqual(nodeA.children[0], nodeB.children[0]);

  // 9. Untouched EXT_meshopt_compression sibling survives BIN compaction and decodes cleanly
  for (const useFallbackBuffer of [false, true]) {
    const plainCylinder = buildTowerScene(
      'EditMe',
      [1, 2, 1],
      0xef4444,
      true,
      [-2, 0, 0],
    );
    const rawPos = new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]);
    const rawIdx = new Uint16Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    ]);
    const encPos = encodeMeshoptBuffer(
      new Uint8Array(rawPos.buffer),
      8,
      12,
      'ATTRIBUTES',
    );
    const encIdx = encodeMeshoptBuffer(
      new Uint8Array(rawIdx.buffer),
      12,
      2,
      'TRIANGLES',
    );
    const plainLen = (plainCylinder.bin.byteLength + 3) & ~3;
    const posCompOff = plainLen;
    const idxCompOff = (posCompOff + encPos.byteLength + 3) & ~3;
    const combinedLen = (idxCompOff + encIdx.byteLength + 3) & ~3;
    const combinedBin = new Uint8Array(combinedLen);
    combinedBin.set(new Uint8Array(plainCylinder.bin), 0);
    combinedBin.set(encPos, posCompOff);
    combinedBin.set(encIdx, idxCompOff);

    const mixedDoc = {
      gltf: structuredClone(plainCylinder.gltf),
      bin: combinedBin.buffer,
      lights: [],
    };
    const mg = mixedDoc.gltf;
    mg.extensionsUsed = ['EXT_meshopt_compression'];
    mg.buffers = [{byteLength: combinedLen}];
    if (useFallbackBuffer) {
      mg.buffers.push({
        byteLength: rawPos.byteLength + rawIdx.byteLength,
        extensions: {EXT_meshopt_compression: {fallback: true}},
      });
    }
    const posBvIdx =
      mg.bufferViews.push({
        buffer: useFallbackBuffer ? 1 : 0,
        byteOffset: 0,
        byteLength: rawPos.byteLength,
        byteStride: 12,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: posCompOff,
            byteLength: encPos.byteLength,
            byteStride: 12,
            count: 8,
            mode: 'ATTRIBUTES',
          },
        },
      }) - 1;
    const idxBvIdx =
      mg.bufferViews.push({
        buffer: useFallbackBuffer ? 1 : 0,
        byteOffset: useFallbackBuffer ? rawPos.byteLength : 0,
        byteLength: rawIdx.byteLength,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: idxCompOff,
            byteLength: encIdx.byteLength,
            byteStride: 2,
            count: 12,
            mode: 'TRIANGLES',
          },
        },
      }) - 1;
    const posAccIdx =
      mg.accessors.push({
        bufferView: posBvIdx,
        componentType: 5126,
        count: 8,
        type: 'VEC3',
      }) - 1;
    const idxAccIdx =
      mg.accessors.push({
        bufferView: idxBvIdx,
        componentType: 5123,
        count: 12,
        type: 'SCALAR',
      }) - 1;
    const compMeshIdx =
      mg.meshes.push({
        name: 'CompressedBoxMesh',
        primitives: [{attributes: {POSITION: posAccIdx}, indices: idxAccIdx}],
      }) - 1;
    const compNodeIdx =
      mg.nodes.push({
        name: 'CompressedBox',
        mesh: compMeshIdx,
        translation: [2, 0, 0],
      }) - 1;
    mg.scenes[0].nodes.push(compNodeIdx);

    // Verify untouched meshopt box decodes before the edit
    const preCheck = {
      gltf: structuredClone(mixedDoc.gltf),
      bin: mixedDoc.bin.slice(0),
      lights: [],
    };
    decodeMeshoptGLB(preCheck);

    // Replace the large plain cylinder beside it with a smaller 840-byte box (shrinking BIN!)
    const smallBox = buildTowerScene(
      'SmallBox',
      [1, 1, 1],
      0x3b82f6,
      false,
      [0, 0, 0],
    );
    const editedMixed = prepareSceneEdit(mixedDoc, smallBox, {
      target: 'EditMe',
      replacement: smallBox,
    }).model;

    assert.ok(
      editedMixed.bin.byteLength < mixedDoc.bin.byteLength,
      'Replacing cylinder with box shrinks repacked BIN while remapping meshopt offsets',
    );
    const postCheck = {
      gltf: structuredClone(editedMixed.gltf),
      bin: editedMixed.bin.slice(0),
      lights: [],
    };
    decodeMeshoptGLB(postCheck);
    const compNodeAfter = postCheck.gltf.nodes.find(
      (n: any) => n.name === 'CompressedBox',
    );
    const compPrimAfter =
      postCheck.gltf.meshes[compNodeAfter.mesh].primitives[0];
    const decPosBv =
      postCheck.gltf.bufferViews[
        postCheck.gltf.accessors[compPrimAfter.attributes.POSITION].bufferView
      ];
    const decIdxBv =
      postCheck.gltf.bufferViews[
        postCheck.gltf.accessors[compPrimAfter.indices].bufferView
      ];
    const decodedPos = new Float32Array(
      postCheck.bin,
      decPosBv.byteOffset,
      rawPos.length,
    );
    const decodedIdx = new Uint16Array(
      postCheck.bin,
      decIdxBv.byteOffset,
      rawIdx.length,
    );
    assert.deepEqual(Array.from(decodedPos), Array.from(rawPos));
    assert.deepEqual(Array.from(decodedIdx), Array.from(rawIdx));
  }

  sceneEditsPlugin.onElementDisconnected?.(host);
  console.log(
    '   ✅ [PASS] scene-edits add-on: bounds/material preservation, constraint rejection, fail-closed capabilities, supersession, and undo',
  );
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
