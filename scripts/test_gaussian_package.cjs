/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
// Run after build.js: verify the actual tarball as an isolated Node consumer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaussian-package-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], {
    cwd: path.join(root, 'xr-live'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }));
  assert.ok(pack.files.some(f => f.path === 'LICENSE'), 'distributed full license');
  const target = path.join(temp, 'node_modules', 'xr-live');
  fs.mkdirSync(target, {recursive: true});
  execFileSync('tar', ['-xzf', path.join(temp, pack.filename), '--strip-components=1', '-C', target]);
  const probe = `const assert = require('node:assert/strict');
    const addon = require('xr-live/gaussian');
    assert.equal(typeof addon.AnisotropicSplatRenderer, 'function');
    assert.equal(typeof addon.packGaussianSplats, 'function');
    assert.ok(require.resolve('xr-live/gaussian').endsWith('xr-live-gaussian.cjs'));
    import('xr-live/gaussian').then(esm => {
      assert.equal(typeof esm.AnisotropicSplatRenderer, 'function');
    }).catch(error => { console.error(error); process.exitCode = 1; });`;
  fs.writeFileSync(path.join(temp, 'probe.cjs'), probe);
  execFileSync(process.execPath, ['probe.cjs'], {cwd: temp, stdio: 'inherit'});
  console.log('PASS packed xr-live/gaussian imports through CJS and ESM; full LICENSE retained');
} finally { fs.rmSync(temp, {recursive: true, force: true}); }
