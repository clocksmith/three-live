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

import {
  authorScriptRunner,
  buildSandboxWorkerSource,
  clearAuthorWarnings,
  createAuthorFidelityCheck,
  getAuthorWarnings,
  MeshBasicMaterial,
  setSandboxEngineSrc,
  THREE,
  type SandboxWorkerSourceOptions,
} from '../src/three-author';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string): void {
  if (condition) {
    passed++;
    console.log(`   ✅ [PASS] ${name}`);
  } else {
    failed++;
    console.error(`   ❌ [FAIL] ${name}`);
  }
}
function errorOf(check: () => void): string {
  try {
    check();
    return '';
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

interface Message {
  type: string;
  nonce?: string;
  message?: string;
  glbBuffer?: ArrayBuffer;
  transforms?: Record<string, number[]>;
}
const globals = globalThis as any;
const NONCE = 'fidelity-test';
const ENGINE_URL = 'https://example.test/three-live.min.js';
const SCRIPT_URL = 'https://example.test/scene.js';
const validScene = `
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'box';
  scene.add(mesh);
`;

// Same generated-worker harness as the sandbox tests: execute the generated
// body against a stub worker global, using the real authoring namespace.
function bootWorker(
  options?: SandboxWorkerSourceOptions,
  engine: any = THREE,
  importedScript?: (scope: any) => void,
) {
  const posted: Message[] = [];
  const scope: any = {
    THREE: engine,
    importScripts: (url: string) => {
      if (url === SCRIPT_URL) importedScript?.(scope);
    },
    postMessage: (message: Message) => posted.push(message),
    fetch: () => {},
    onmessage: null,
  };
  const withSelf = (action: () => void) => {
    const previous = globals.self;
    globals.self = scope;
    try {
      action();
    } finally {
      globals.self = previous;
    }
  };
  withSelf(() => {
    new Function(buildSandboxWorkerSource(ENGINE_URL, NONCE, options))();
  });
  return {
    posted,
    scope,
    withSelf,
    run(script: string) {
      withSelf(() => scope.onmessage?.({
        data: {type: 'EXECUTE', nonce: NONCE, script},
      }));
    },
    runUrl() {
      withSelf(() => scope.onmessage?.({
        data: {type: 'EXECUTE_URL', nonce: NONCE, scriptUrl: SCRIPT_URL},
      }));
    },
  };
}

async function runTests() {
  clearAuthorWarnings();
  const aliasCheck = createAuthorFidelityCheck();
  new MeshBasicMaterial();
  assert(getAuthorWarnings().length === 0,
    'Silent material aliases do not add warnings or change permissive behavior');
  assert(errorOf(aliasCheck).includes('MeshBasicMaterial'),
    'Known silent alias is reported by an opt-in fidelity check');
  assert(errorOf(createAuthorFidelityCheck()) === '',
    'New checks ignore degradations from earlier runs');

  const check = createAuthorFidelityCheck();
  new THREE.ShaderMaterial();
  clearAuthorWarnings();
  const otherCheck = createAuthorFidelityCheck();
  assert(errorOf(check).includes('ShaderMaterial') && errorOf(otherCheck) === '',
    'Clearing warnings or starting another check cannot reset an existing check');
  new THREE.ShaderMaterial();
  const repeatedCheck = createAuthorFidelityCheck();
  new THREE.ShaderMaterial();
  assert(errorOf(repeatedCheck).includes('ShaderMaterial'),
    'Repeated deduplicated warnings still trigger a fresh fidelity check');

  const permissive = bootWorker();
  permissive.run(validScene);
  const strict = bootWorker({strictFidelity: true});
  strict.run(validScene);
  const baseBuffer = permissive.posted.find(m => m.glbBuffer)?.glbBuffer;
  const strictBuffer = strict.posted.find(m => m.glbBuffer)?.glbBuffer;
  assert(!!baseBuffer && !!strictBuffer &&
    String(new Uint8Array(baseBuffer)) === String(new Uint8Array(strictBuffer)),
    'Supported scene emits byte-identical GLB in default and strict modes');
  assert(strict.posted.map(m => m.type).join(',') === 'READY,3D_MODEL_READY,DONE',
    'Successful strict run publishes one model then DONE');

  const degradations = [
    ['ShaderMaterial', 'new THREE.ShaderMaterial()'],
    ['IcosahedronGeometry', 'new THREE.IcosahedronGeometry()'],
    ['CapsuleGeometry', 'new THREE.CapsuleGeometry()'],
    ['SpotLight', 'new THREE.SpotLight()'],
    ['THREE.UnknownFeature', 'new THREE.UnknownFeature().ignored()'],
    ['MeshBasicMaterial', 'new THREE.MeshBasicMaterial()'],
    ['MeshLambertMaterial', 'new THREE.MeshLambertMaterial()'],
    ['MeshPhongMaterial', 'new THREE.MeshPhongMaterial()'],
    ['Mesh material array', 'new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()])'],
  ];
  for (const [feature, source] of degradations) {
    const compatible = bootWorker();
    compatible.run(`${validScene}\n${source};`);
    assert(compatible.posted.some(m => m.type === '3D_MODEL_READY') &&
      !compatible.posted.some(m => m.type === 'ERROR'),
      `Default mode still accepts ${feature}`);
    const diagnostic = bootWorker({strictFidelity: true});
    diagnostic.run(`${validScene}\n${source}; THREE.clearAuthorWarnings();`);
    assert(diagnostic.posted.map(m => m.type).join(',') === 'READY,ERROR' &&
      diagnostic.posted.some(m => m.message?.includes('FidelityError:') &&
        m.message.includes(feature) && m.message.includes('degraded to')),
      `Strict mode rejects ${feature} with a feature/fallback diagnostic and no output`);
  }

  const lateFailure = bootWorker({strictFidelity: true});
  lateFailure.run(`${validScene}
    renderer.render(scene, camera);
    mesh.position.x = 2;
    renderer.render(scene, camera);
    new THREE.CapsuleGeometry();
    THREE.clearAuthorWarnings();
    THREE.createAuthorFidelityCheck()();
  `);
  assert(lateFailure.posted.map(m => m.type).join(',') === 'READY,ERROR',
    'Late degradation after render cannot publish an early model or transforms');

  const lateException = bootWorker({strictFidelity: true});
  lateException.run(`${validScene} renderer.render(scene, camera); throw new Error('stop');`);
  assert(lateException.posted.map(m => m.type).join(',') === 'READY,ERROR',
    'Late script exception also discards strict buffered output');

  const rendering = bootWorker({strictFidelity: true});
  rendering.run(`${validScene}
    renderer.render(scene, camera);
    for (let i = 1; i <= 5; i++) {
      mesh.position.x = i;
      renderer.render(scene, camera);
    }
  `);
  assert(rendering.posted.map(m => m.type).join(',') ===
    'READY,3D_MODEL_READY,3D_UPDATE_TRANSFORMS,DONE' &&
    rendering.posted[2].transforms?.box?.[12] === 5,
    'Strict render buffering retains first model and final transforms with bounded output');

  const streaming = bootWorker();
  streaming.run(`${validScene} renderer.render(scene, camera); throw new Error('stop');`);
  assert(streaming.posted.map(m => m.type).join(',') === 'READY,3D_MODEL_READY,ERROR',
    'Default mode retains existing streaming behavior');

  const staleEngine = new Proxy({Scene: THREE.Scene}, {
    get: (target: any, prop) => prop in target ? target[prop] : () => {},
  });
  const later = bootWorker({strictFidelity: true});
  later.run(validScene);
  const beforeLater = later.posted.length;
  new MeshBasicMaterial();
  const lateError = errorOf(() => later.withSelf(() => later.scope.postMessage({type: '3D_UPDATE_TRANSFORMS', transforms: {}})));
  assert(lateError.includes('FidelityError') && later.posted.length === beforeLater,
    'Post-synchronous callbacks cannot publish after an instrumented fidelity loss');

  const stale = bootWorker({strictFidelity: true}, staleEngine);
  assert(stale.posted.length === 1 &&
    stale.posted[0].type === 'ERROR' && /^FidelityError:.*strictFidelity/.test(stale.posted[0].message || ''),
    'Stale permissive engine fails clearly instead of treating a no-op proxy as a check');

  const urlRun = bootWorker({strictFidelity: true, allowedScriptUrl: SCRIPT_URL}, THREE,
    scope => {
      assert(scope.fetch === undefined && scope.importScripts === undefined,
        'Strict URL scripts retain revoked network capabilities');
      scope.scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
      scope.renderer.render(scope.scene, scope.camera);
    });
  urlRun.runUrl();
  assert(urlRun.posted.map(m => m.type).join(',') === 'READY,ERROR' &&
    urlRun.posted[1].message?.includes('MeshBasicMaterial') === true,
    'Strict URL execution uses the same fidelity check and output gate');

  for (const sandbox of ['none', 'unsafe-host-realm']) {
    let rejected = false;
    try {
      await authorScriptRunner.execute(validScene, sandbox, {onModelReady: () => {}},
        {allowClientScripts: true, strictFidelity: true});
    } catch (error: unknown) {
      rejected = String(error).includes('SecurityError');
    }
    assert(rejected, `Strict fidelity never enables prohibited sandbox mode ${sandbox}`);
  }
  let optInRejected = false;
  try {
    await authorScriptRunner.execute(validScene, 'worker', {onModelReady: () => {}},
      {strictFidelity: true});
  } catch (error: unknown) {
    optInRejected = String(error).includes('allowClientScripts');
  }
  assert(optInRejected, 'Strict fidelity does not opt in to client script execution');

  // Exercise the public runner, not only the worker-source builder. The
  // worker double captures its Blob; handles are always terminated so the
  // unchanged sandbox watchdog and concurrency accounting are cleaned up.
  const previousWorker = globals.Worker;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  let capturedBlob: Blob | null = null;
  let terminated = 0;
  globals.Worker = class {
    postMessage() {}
    terminate() { terminated++; }
  };
  URL.createObjectURL = (blob: Blob) => {
    capturedBlob = blob;
    return 'blob:https://example.test/test-worker';
  };
  URL.revokeObjectURL = () => {};
  setSandboxEngineSrc(ENGINE_URL);
  try {
    for (const strictFidelity of [false, true]) {
      for (const kind of ['script', 'url']) {
        const callbacks = {onModelReady: () => {}};
        const options = {allowClientScripts: true, strictFidelity};
        const handle = kind === 'script'
          ? await authorScriptRunner.execute(validScene, 'worker', callbacks, options)
          : await authorScriptRunner.executeUrl!(SCRIPT_URL, 'worker', callbacks, options);
        try {
          const source = await capturedBlob!.text();
          assert(source.includes(`"strictFidelity":${strictFidelity}`) &&
            source.includes(`"allowClientScripts":${kind === 'script'}`),
            `Public worker ${kind} path forwards strictFidelity=${strictFidelity} without changing script permissions`);
        } finally {
          handle?.terminate();
        }
      }
    }
    assert(terminated === 4, 'Strict and default worker handles remain terminable');
  } finally {
    globals.Worker = previousWorker;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    setSandboxEngineSrc(null);
  }

  console.log(`\n🏆 Three-Author Fidelity Test Results: ${passed} Passed, ${failed} Failed.`);
  if (failed > 0) process.exit(1);
}
runTests();
