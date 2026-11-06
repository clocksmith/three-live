/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
// Real WebGL pixel/rollback check. Requires Playwright and esbuild.
const fs = require('node:fs'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2]);
if (fs.existsSync(out)) throw Error('Use a new evidence directory');
fs.mkdirSync(out, {recursive: true});
const bundle = fs.readFileSync(path.join(root, 'dist/three-live.min.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(root, 'three-live/dist/three-live-edits.min.js'), 'utf8') +
  '\nwindow.Test = {...ThreeLive, ...ThreeLiveEdits};';
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH,
    args: ['--use-angle=metal', '--enable-gpu']});
  try {
    const page = await browser.newPage({viewport: {width: 640, height: 480}});
    await page.setContent('<style>body{background:#111;color:white}three-live{display:block;width:400px;height:360px}</style><h1>Document edit preview / rollback</h1>');
    await page.addScriptTag({content: bundle});
    const result = await page.evaluate(async () => {
      const el = document.createElement('three-live'); document.body.append(el);
      function scene(color) {
        const s = new Test.THREE.Scene();
        const mesh = new Test.THREE.Mesh(new Test.THREE.BoxGeometry(1, 2, 1), new Test.THREE.MeshStandardMaterial({color}));
        mesh.name = 'Tower'; s.add(mesh); return s.toGLB().buffer;
      }
      await el.loadModel(scene(0xef4444));
      const canvas = el.querySelector('canvas'), gl = canvas.getContext('webgl2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
      function pixels() {el.viewer.render();const a = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, a); return a;}
      const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const before = pixels(), editor = new Test.SceneEditor(el), checks = [];
      const check = (value, name) => {if (!value) throw Error(name); checks.push(name);};
      const receipt = await editor.previewEdit({target: 'Tower', replacement: scene(0x3b82f6), constraints: {preserveHeight: true}});
      check(receipt.applied && receipt.status === 'preview', 'typed replacement admitted');
      check(!same(before, pixels()), 'preview visibly changes pixels');
      await editor.rejectEdit(); check(same(before, pixels()), 'reject restores exact canvas pixels');
      await editor.previewEdit({target: 'Tower', replacement: scene(0x3b82f6)});
      editor.acceptEdit(); check(!same(before, pixels()), 'accept retains candidate');
      await editor.undoEdit(); check(same(before, pixels()), 'undo restores exact canvas pixels');
      const failed = await editor.previewEdit({target: 'Tower', replacement: scene(0x3b82f6), constraints: {maxBounds: [0, 0, 0]}});
      check(failed.status === 'rejected' && same(before, pixels()), 'constraint failure preserves visible scene');
      check(gl.getError() === gl.NO_ERROR, 'WebGL remains error free');
      await editor.dispose();
      return {renderer, checks};
    });
    await page.screenshot({path: path.join(out, 'restored-scene.png')});
    const receipt = {executedAt: new Date().toISOString(), ...result,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
      sourceDirty: execFileSync('git', ['status', '--porcelain', '--', 'three-live/src', 'scripts'], {cwd: root, encoding: 'utf8'}).trim(),
      bundleSha256: createHash('sha256').update(bundle).digest('hex')};
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
