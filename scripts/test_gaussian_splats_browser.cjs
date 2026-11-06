/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
// Optional real-WebGL2 validation. Requires Playwright and a Chromium binary.
// CHROMIUM_PATH=/usr/bin/chromium node scripts/test_gaussian_splats_browser.cjs [output-dir]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, {cwd:root,encoding:'utf8'}).trim();
const {chromium} = require('playwright');
const esbuild = require('esbuild');

(async () => {
  const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'gaussian-webgl-')));
  fs.mkdirSync(out, {recursive: true});
  const bundle = esbuild.buildSync({
    stdin: {contents: `export * from './xr-live/src/plugins/gaussian-splat-renderer';
      export {SplatRenderer, parseSplat, parseSpzPayload, XRSplatLoader} from './xr-live/src/plugins/splat-loader';
      export {getSharedRegistry} from './three-live/src/plugin';`, resolveDir: root},
    bundle: true, format: 'iife', globalName: 'Test', write: false,
  }).outputFiles[0].text;
  const executedAt = new Date().toISOString();
  const source = {sourceCommit:git('rev-parse','HEAD'),
    dirty:git('status','--porcelain','--untracked-files=all','--','three-live/src','xr-live/src','scripts'),
    bundleSha256:createHash('sha256').update(bundle).digest('hex')};
  const angle = process.env.ANGLE_BACKEND || 'swiftshader';
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', `--use-angle=${angle}`, ...(angle==='swiftshader'?['--enable-unsafe-swiftshader']:[])],
    env: {...process.env, HOME: out, XDG_CONFIG_HOME: out},
  });
  try {
    const page = await browser.newPage({viewport: {width: 1040, height: 670}});
    await page.setContent('<style>body{background:#111827;color:white;font:16px sans-serif}canvas{background:#030712;margin:4px}h1{font-size:22px}p{margin:6px}</style><h1>Gaussian splat WebGL2 pixel validation</h1><p>Top: original isotropic lite. Bottom: projected anisotropic quads. Rotations: 0°, 45°, 90°.</p>');
    await page.addScriptTag({content: bundle});
    const result = await page.evaluate(async () => {
      const identity = () => new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
      const projection = () => new Float32Array([1,0,0,0,0,1,0,0,0,0,-1.002,-1,0,0,-.2002,0]);
      const cloud = (angle=0, scales=[.45,.07,.05], positions=[0,0,-3]) => ({
        count: positions.length/3, positions:new Float32Array(positions),
        scales: new Float32Array(scales), colors:new Uint8Array([255,180,50,255]),
        rotations: new Float32Array([0,0,Math.sin(angle/2),Math.cos(angle/2)]),
      });
      const checks = [];
      const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
      const canvas = document.createElement('canvas');canvas.width=256;canvas.height=256;
      const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true,antialias:false});
      check(!!gl, 'WebGL2 context available');
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      const renderer=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
      function draw(data, {lite=false, model=identity(), vp=projection(), width=256, height=256, eye='none'}={}) {
        gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        const splats=lite?new Test.SplatRenderer(gl,data):new Test.AnisotropicSplatRenderer(gl,data);
        if(!lite)check(splats.ready,'Gaussian shader compile/link and GPU allocation');
        if(lite)splats.draw(vp,model,128);else splats.draw(vp,model,width,height,eye);
        const pixels=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        check(gl.getError()===gl.NO_ERROR,'WebGL draw/readback without errors');
        const image=document.createElement('canvas');image.width=256;image.height=256;image.getContext('2d').drawImage(canvas,0,0);
        splats.dispose();
        let weight=0,x=0,y=0,xx=0,xy=0,yy=0;
        for(let j=0;j<256;j++)for(let i=0;i<256;i++) {const w=pixels[(j*256+i)*4];weight+=w;x+=w*(i+.5);y+=w*(j+.5);xx+=w*(i+.5)**2;xy+=w*(i+.5)*(j+.5);yy+=w*(j+.5)**2;}
        const cx=x/weight,cy=y/weight,a=xx/weight-cx*cx,b=xy/weight-cx*cy,d=yy/weight-cy*cy;
        const delta=Math.hypot((a-d)/2,b),mid=(a+d)/2;
        return {weight,cx,cy,a,b,d,ratio:Math.sqrt((mid+delta)/(mid-delta)),angle:.5*Math.atan2(2*b,a-d),image,pixels};
      }
      const visual=[];
      for(const lite of [true,false]) {
        const row=document.createElement('div');document.body.append(row);
        for(const angle of [0,Math.PI/4,Math.PI/2]) {
          const r=draw(cloud(angle),{lite});row.append(r.image);
          visual.push({mode:lite?'lite':'anisotropic',rotation:angle,ratio:r.ratio,angle:r.angle});
          check(Math.abs(r.cx-128)<.1&&Math.abs(r.cy-128)<.1,'Centered Gaussian centroid');
          if(lite)check(Math.abs(r.ratio-1)<.03,'Lite remains circular');
          else {check(r.ratio>5.5,'Anisotropic axis ratio retained');check(Math.abs(Math.abs(r.angle)-angle)<.03,'Quaternion rotates Gaussian footprint');}
        }
      }
      const base=draw(cloud());
      const model=identity();model[0]=.5;model[5]=2;
      const transformed=draw(cloud(),{model});
      check(transformed.a<base.a*.3&&transformed.d>base.d*3.5,'Nonuniform model scale changes projected covariance');
      const iso=draw(cloud(Math.PI/4,[.14,.14,.14]));
      check(Math.abs(iso.ratio-1)<.03,'Isotropic covariance remains isotropic');
      const near=draw(cloud(0,[.45,.07,.05],[0,0,1]));check(near.weight===0,'Behind-camera splat culled');
      const invalid=draw(cloud(0,[Infinity,.1,.1]));check(invalid.weight===0,'Non-finite covariance safely culled');
      const viewport=draw(cloud(),{width:128,height:256,eye:'left'});
      check(Math.abs(viewport.cx-64)<.1&&viewport.a<base.a*.3,'Per-eye viewport width used for covariance');
      const ortho=identity();ortho[10]=-.1;
      const orthographic=draw(cloud(),{vp:ortho});check(orthographic.weight>0&&orthographic.ratio>5,'Orthographic covariance renders');
      const offscreen=draw(cloud(0,[.45,.07,.05],[3.05,0,-3]));check(offscreen.weight>0,'Offscreen center with overlapping Gaussian is retained');
      // Parser interoperability: equivalent .splat and SPZ-v2 captures reach
      // the exact same renderer; rotations remain observable in pixels.
      const bytes=new Uint8Array(32),view=new DataView(bytes.buffer);view.setFloat32(8,-3,true);
      for(const [i,v]of [.45,.07,.05].entries())view.setFloat32(12+i*4,v,true);
      bytes.set([255,180,50,255],24);bytes.set([246,128,128,177],28);
      const parsed=draw(Test.parseSplat(bytes));check(parsed.ratio>5&&parsed.b>0,'splat quaternion/scale interoperability');
      const spz=new Uint8Array(35),sv=new DataView(spz.buffer);sv.setUint32(0,0x5053474e,true);sv.setUint32(4,2,true);sv.setUint32(8,1,true);spz[13]=8;
      spz.set([0,253,255],22);spz[25]=255;spz.set([150,150,150],26);spz.set([147,117,112],29);spz.set([128,128,177],32);
      const spzResult=draw(Test.parseSpzPayload(spz));check(spzResult.ratio>5&&spzResult.b>0,'SPZ v2 quaternion/scale interoperability');
      // State isolation: texture bindings, active unit, VAO and blend/depth
      // postconditions must survive a real GL draw, including a cache hit.
      const stateRenderer=new Test.AnisotropicSplatRenderer(gl,cloud());
      gl.activeTexture(gl.TEXTURE0);const oldTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,oldTexture);gl.activeTexture(gl.TEXTURE3);
      for(let i=0;i<2;i++)stateRenderer.draw(projection(),identity(),256,256);
      check(gl.getParameter(gl.ACTIVE_TEXTURE)===gl.TEXTURE0,'Unit zero active after draw');
      gl.activeTexture(gl.TEXTURE0);check(gl.getParameter(gl.TEXTURE_BINDING_2D)===oldTexture,'Texture binding restored');
      check(gl.getParameter(gl.VERTEX_ARRAY_BINDING)===null&&!gl.isEnabled(gl.BLEND)&&gl.getParameter(gl.DEPTH_WRITEMASK),'VAO/blend/depth postconditions');
      stateRenderer.dispose();gl.deleteTexture(oldTexture);
      // Wall-clock draw+finish sample under this identified implementation.
      // Software results are NOT hardware GPU timing or quality-equivalent.
      const count=10000,positions=new Float32Array(count*3),scales=new Float32Array(count*3),colors=new Uint8Array(count*4),rotations=new Float32Array(count*4);
      for(let i=0;i<count;i++){positions.set([(i%100-50)*.04,(Math.floor(i/100)-50)*.04,-4-(i%7)*.1],i*3);scales.set([.015,.005,.005],i*3);colors.set([200,140,80,180],i*4);rotations[i*4+3]=1;}
      const data={count,positions,scales,colors,rotations},timings={};
      for(const [name,Type]of [['lite',Test.SplatRenderer],['anisotropic',Test.AnisotropicSplatRenderer]]) {
        const s=new Type(gl,data),samples=[];
        for(let i=0;i<8;i++){const t=performance.now();gl.clear(gl.COLOR_BUFFER_BIT);if(name==='lite')s.draw(projection(),identity(),128);else s.draw(projection(),identity(),256,256);gl.finish();if(i>=3)samples.push(performance.now()-t);}
        timings[name]={splats:count,samplesMs:samples,medianMs:samples.slice().sort((a,b)=>a-b)[2]};s.dispose();
      }
      check(gl.getError()===gl.NO_ERROR,'Benchmark GL calls without errors');
      return {renderer,checks,visual,timings,note:'Headless WebGL2 correctness fixture; draw+finish samples are diagnostics, not scene FPS.'};
    });
    Object.assign(result, {executedAt,reportedAt:new Date().toISOString(),source,
      machine:{id:os.hostname(),os:os.platform(),osVersion:os.release(),architecture:os.arch()},
      browser:browser.version(),angleRequested:angle});
    assert.ok(result.checks.length>20);
    await page.screenshot({path:path.join(out,'gaussian-comparison.png')});
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({output:out,...result},null,2));
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
