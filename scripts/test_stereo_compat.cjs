/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
// Compare actual emitted render parameters with an explicit baseline checkout.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {strict: assert} = require('node:assert');
const {buildSync} = require('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-stereo-'));
const root = path.resolve(__dirname, '..'), baseline = path.resolve(process.argv[2]);
function load(dir, label) {
  const file = path.join(temp, label + '.cjs');
  buildSync({entryPoints: [path.join(dir, 'three-live/src/three-view.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: file});
  return require(file).ThreeView;
}
try {
  const before = load(baseline, 'before'), after = load(root, 'after');
  let cases = 0;
  for (const [width, height] of [[0, 0], [400, 300], [401, 301]]) for (const theta of [0, 1.2]) for (const backdrop of [false, true]) {
    function run(View) {
      const calls = [], host = {contextLost: false, stereoSBS: true,
        canvas: {width, height}, gl: {viewport: (...args) => calls.push({restore: args})},
        backdropMeshes: backdrop ? [{}] : [], bounds: {radius: .7, center: [.2, -.3, .4]},
        customTarget: theta ? [2, 3, -4] : null, currTheta: theta, currPhi: .4, currDistance: 3,
        fov: Math.PI / 3, render: args => calls.push(args)};
      View.prototype.render.call(host);
      return JSON.parse(JSON.stringify(calls));
    }
    assert.deepEqual(run(after), run(before), `stereo parameters ${width}x${height} theta=${theta} backdrop=${backdrop}`);
    cases++;
  }
  console.log(`PASS ${cases} actual stereo setup comparisons: matrices, eye positions, viewports, clear order and restoration`);
} finally {fs.rmSync(temp, {recursive: true, force: true});}
