/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
import {strict as assert} from 'node:assert';
import {mat4Create} from '../../three-live/src/math';
import {getSplatRenderStatus} from '../src/gaussian';
import {getSharedRegistry} from '../../three-live/src/plugin';
import {AnisotropicSplatRenderer, GAUSSIAN_SPLAT_CAPABILITIES, packGaussianSplats} from '../src/plugins/gaussian-splat-renderer';
import {MAX_SPLATS, type SplatData, SplatRenderer, XRSplatLoader, sortSplatsByDepth} from '../src/plugins/splat-loader';

function cloud(positions=[2,0,-2,-2,0,-2,0,1,-3]): SplatData {
  const count=positions.length/3,rotations=new Float32Array(count*4);
  for(let i=0;i<count;i++)rotations[i*4+3]=1;
  return {count,positions:new Float32Array(positions),scales:new Float32Array(count*3).fill(.2),
    colors:new Uint8Array(count*4).fill(128),rotations};
}
function vp(x=0): Float32Array {const m=mat4Create();m[3]=x;m[11]=-1;m[15]=0;return m;}
function mockGL() {
  type Resource={id:number;order?:Uint32Array;indices?:Resource};
  let n=0,vao:Resource|null=null,array:Resource|null=null,active=3,texture:Resource|null=null;
  let blend=false,depth=true,failBuffer=false;
  let queries=0,pointers=0;
  const bindings=new Map<number,Resource|null>();
  const vaos:Resource[]=[],deletedVAOs:Resource[]=[];
  const buffers:Resource[]=[],deleted:Resource[]=[],shaders:Resource[]=[],deletedShaders:Resource[]=[];
  const textures:Resource[]=[],deletedTextures:Resource[]=[],programs:Resource[]=[],deletedPrograms:Resource[]=[];
  const divisors=new Map<number,number>();
  const uploads:number[][]=[],draws:number[][]=[],dimensions:number[][]=[],sources:string[]=[];
  const gl={
    MAX_TEXTURE_SIZE:1,TEXTURE_BINDING_2D:2,ACTIVE_TEXTURE:3,TEXTURE0:10,TEXTURE_2D:11,
    ARRAY_BUFFER:12,STATIC_DRAW:13,DYNAMIC_DRAW:14,VERTEX_SHADER:15,FRAGMENT_SHADER:16,
    COMPILE_STATUS:17,LINK_STATUS:18,TEXTURE_MIN_FILTER:19,TEXTURE_MAG_FILTER:20,
    TEXTURE_WRAP_S:21,TEXTURE_WRAP_T:22,NEAREST:23,CLAMP_TO_EDGE:24,RGBA32UI:25,
    RGBA_INTEGER:26,UNSIGNED_INT:27,TRIANGLE_STRIP:28,BLEND:29,ONE:30,ONE_MINUS_SRC_ALPHA:31,
    ELEMENT_ARRAY_BUFFER:32,FLOAT:33,UNSIGNED_BYTE:34,VIEWPORT:35,drawingBufferWidth:600,drawingBufferHeight:400,
    compileOk:true,linkOk:true,vaoOk:true,textureOk:true,
    getParameter(p:number){queries++;return p===1?2048:p===2?(bindings.get(active)??null):p===3?active:p===35?new Int32Array([100,0,300,400]):null;},
    createShader(){const r={id:n++};shaders.push(r);return r;},shaderSource(_s:unknown,src:string){sources.push(src);},compileShader(){},
    getShaderParameter(){return gl.compileOk;},deleteShader(s:Resource){deletedShaders.push(s);},
    createProgram(){const r={id:n++};programs.push(r);return r;},attachShader(){},linkProgram(){},
    getProgramParameter(){return gl.linkOk;},deleteProgram(p:Resource){deletedPrograms.push(p);},
    createVertexArray(){if(!gl.vaoOk)return null;const v={id:n++};vaos.push(v);return v;},bindVertexArray(v:Resource|null){vao=v;},deleteVertexArray(v:Resource){deletedVAOs.push(v);},
    createTexture(){if(!gl.textureOk)return null;const t={id:n++};textures.push(t);return t;},
    bindTexture(_t:number,t:Resource|null){texture=t;bindings.set(active,t);},texParameteri(){},texImage2D(){},deleteTexture(t:Resource){deletedTextures.push(t);},
    activeTexture(v:number){active=v;},
    createBuffer(){if(failBuffer)return null;const b={id:n++};buffers.push(b);return b;},
    bindBuffer(_t:number,b:Resource){array=b;},bufferData(_t:number,data:number|ArrayBufferView){if(typeof data==='number')array!.order=new Uint32Array(data/4);},
    bufferSubData(_t:number,o:number,data:Uint32Array){assert.equal(o,0);array!.order!.set(data);uploads.push(Array.from(data));},
    deleteBuffer(b:Resource){deleted.push(b);},getUniformLocation(_p:unknown,name:string){return name;},
    enableVertexAttribArray(){},vertexAttribIPointer(){assert.ok(vao);vao.indices=array!;pointers++;},vertexAttribDivisor(l:number,v:number){divisors.set(l,v);assert.equal(v,l===0?1:0);},
    vertexAttribPointer(){},useProgram(){},uniformMatrix4fv(){},uniform1i(){},uniform1f(){},
    uniform2f(_l:unknown,w:number,h:number){dimensions.push([w,h]);},
    enable(){blend=true;},disable(){blend=false;},blendFunc(){},depthMask(v:boolean){depth=v;},
    drawArraysInstanced(mode:number,start:number,vertices:number,count:number){assert.equal(mode,28);assert.equal(start,0);assert.equal(vertices,4);assert.ok(vao&&blend&&!depth);assert.equal(divisors.get(0),1);assert.equal(divisors.get(1),0,'WebGL2 needs an active divisor-zero vertex attribute');draws.push(Array.from(vao!.indices!.order!.subarray(0,count)));},
  };
  return {gl:gl as unknown as WebGL2RenderingContext,raw:gl,buffers,deleted,uploads,draws,dimensions,sources,
    shaders,deletedShaders,textures,deletedTextures,programs,deletedPrograms,vaos,deletedVAOs,bindings,
    get queries(){return queries;},get pointers(){return pointers;},
    set failBuffer(v:boolean){failBuffer=v;},get vao(){return vao;},get active(){return active;},get texture(){return texture;},get blend(){return blend;},get depth(){return depth;}};
}
const cases:Array<[string,()=>void|Promise<void>]>=[];
const test=(name:string,run:()=>void|Promise<void>)=>cases.push([name,run]);

test('capability truthfully identifies browser anisotropic geometry and DC-only color',()=>{
  assert.equal(GAUSSIAN_SPLAT_CAPABILITIES.covariance,'projected-3d');
  assert.equal(GAUSSIAN_SPLAT_CAPABILITIES.sphericalHarmonics,false);
  assert.equal(GAUSSIAN_SPLAT_CAPABILITIES.maxAxisPixels,128);
  assert.ok(Object.isFrozen(GAUSSIAN_SPLAT_CAPABILITIES));
});
test('packing preserves positions, each scale, xyzw rotation and RGBA byte order',()=>{
  const data=cloud([1,2,-3]);data.scales.set([.1,.2,.3]);data.rotations.set([.1,.2,.3,.4]);data.colors.set([1,127,128,255]);
  const packed=packGaussianSplats(data,2),f=new Float32Array(packed.buffer);
  assert.equal(packed.length,16);assert.deepEqual(Array.from(f.slice(0,3)),[1,2,-3]);
  assert.equal(packed[3],0xff807f01);assert.deepEqual(f.slice(4,7),data.scales);assert.deepEqual(f.slice(8,12),data.rotations);
});
test('empty data is a bounded single row and invalid sizes fail before allocation',()=>{
  assert.equal(packGaussianSplats(cloud([]),8).length,32);
  for(const width of [0,-1,2049,NaN,Infinity,1.5])assert.throws(()=>packGaussianSplats(cloud(),width));
  for(const count of [-1,MAX_SPLATS+1,NaN,1.5])assert.throws(()=>packGaussianSplats({...cloud(),count},2));
  assert.throws(()=>packGaussianSplats({...cloud(),scales:new Float32Array(1)},2));
});
test('first draw sorts and 32 stationary draws reuse the immutable input and order',()=>{
  const m=mockGL(),d=cloud(),r=new AnisotropicSplatRenderer(m.gl,d);
  for(let i=0;i<33;i++)r.draw(vp(),mat4Create(),600,400);
  assert.equal(m.uploads.length,1);assert.equal(m.draws.length,33);assert.equal(m.buffers.length,2);
  for(const order of m.draws)assert.deepEqual(order,Array.from(sortSplatsByDepth(d,vp())));
});
test('parallel eyes share the GPU order and VAO without doubling the moving cadence',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud());
  const queries=m.queries;
  for(let frame=0;frame<60;frame++)for(const eye of frame%2?['right','left']:['left','right']){
    const matrix=vp(Math.sin(frame+1));matrix[8]=eye==='left'?.1:-.1;
    r.draw(matrix,mat4Create(),300,400,eye);
  }
  assert.equal(m.uploads.length,15);assert.equal(m.buffers.length,2,'corner + one order buffer');
  assert.equal(m.vaos.length,1);assert.equal(m.pointers,1);assert.equal(m.queries,queries);
  r.dispose();r.dispose();assert.equal(m.deleted.length,m.buffers.length);
  assert.deepEqual(new Set(m.deletedVAOs),new Set(m.vaos));
});
test('moving views preserve four-draw cadence and settle without uploads',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud());
  for(let i=0;i<40;i++)r.draw(vp(Math.sin(i)),mat4Create(),600,400);
  assert.equal(m.uploads.length,10);
  for(let i=0;i<20;i++)r.draw(vp(1),mat4Create(),600,400);
  assert.equal(m.uploads.length,11);
});
test('canted stereo views retain independently sorted GPU orders and viewport dimensions',()=>{
  const m=mockGL(),d=cloud(),r=new AnisotropicSplatRenderer(m.gl,d);
  for(let i=0;i<12;i++)for(const [eye,x] of [['left',1],['right',-1]] as const){
    r.draw(vp(x),mat4Create(),300,400,eye);
    assert.deepEqual(m.draws.at(-1),Array.from(sortSplatsByDepth(d,vp(x))));
  }
  assert.equal(m.uploads.length,2);assert.equal(m.buffers.length,3);assert.deepEqual(m.dimensions.at(-1),[300,400]);
});
test('stereo/mono switching remains bounded to two buffers and sorts evicted views',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud());
  for(const eye of ['left','right','left','none','left','right'])r.draw(vp(eye==='left'?1:eye==='right'?-1:0),mat4Create(),300,400,eye);
  assert.equal(m.buffers.length,3);assert.equal(m.uploads.length,4);
});
test('model depth changes invalidate order and projection-only changes do not',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud()),model=mat4Create();
  for(let i=0;i<8;i++)r.draw(vp(1),model,600,400);
  model[0]=-1;r.draw(vp(1),model,600,400);assert.equal(m.uploads.length,2);
  const changed=vp(1);changed[0]=2;changed[5]=3;
  for(let i=0;i<8;i++)r.draw(changed,model,400,500);assert.equal(m.uploads.length,2);
});
test('orthographic projection sorts using clip z instead of constant w',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud()),p=mat4Create();p[10]=-.1;
  r.draw(p,mat4Create(),600,400);assert.deepEqual(m.draws[0],[2,0,1]);
  p[2]=1;for(let i=0;i<4;i++)r.draw(p,mat4Create(),600,400);assert.deepEqual(m.draws.at(-1),[0,2,1]);
});
test('float32 depth rounding cannot create duplicate sorted indices',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud());r.draw(vp(Math.sin(4)),mat4Create(),600,400);
  assert.deepEqual(m.draws[0],[1,2,0]);
});
test('draw preserves other texture units and uses no synchronous queries or repeated attributes',()=>{
  const m=mockGL(),old={id:-1};m.raw.bindTexture(m.raw.TEXTURE_2D,old);
  const r=new AnisotropicSplatRenderer(m.gl,cloud());assert.equal(m.texture,old);
  const queries=m.queries;
  for(let i=0;i<33;i++)r.draw(vp(),mat4Create(),600,400);
  assert.equal(m.bindings.get(3),old);assert.equal(m.bindings.get(m.raw.TEXTURE0+15),null);
  assert.equal(m.active,m.raw.TEXTURE0);assert.equal(m.queries,queries);assert.equal(m.pointers,1);
  assert.equal(m.vao,null);assert.equal(m.blend,false);assert.equal(m.depth,true);
});
test('failed shader compilation or link disposes resources without rendering',()=>{
  for(const failure of ['compileOk','linkOk','textureOk'] as const){
    const m=mockGL();m.raw[failure]=false;const r=new AnisotropicSplatRenderer(m.gl,cloud());
    assert.equal(r.ready,false);r.draw(vp(),mat4Create(),600,400);assert.equal(m.draws.length,0);
    assert.deepEqual(m.deletedShaders,m.shaders);assert.deepEqual(m.deletedPrograms,m.programs);assert.deepEqual(m.deletedTextures,m.textures);
  }
});
test('failed static corner allocation cleans up initialization and never draws',()=>{
  const m=mockGL();m.failBuffer=true;
  const r=new AnisotropicSplatRenderer(m.gl,cloud());
  assert.equal(r.ready,false);r.draw(vp(),mat4Create(),600,400);
  assert.equal(m.draws.length,0);assert.deepEqual(m.deletedPrograms,m.programs);
  assert.deepEqual(m.deletedTextures,m.textures);r.dispose();
});
test('failed order allocation retries and does not corrupt existing per-eye cache',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud());r.draw(vp(1),mat4Create(),600,400,'left');
  m.failBuffer=true;r.draw(vp(-1),mat4Create(),600,400,'right');assert.equal(m.draws.length,1);
  r.draw(vp(1),mat4Create(),600,400,'left');assert.deepEqual(m.draws[1],m.draws[0]);
  m.failBuffer=false;r.draw(vp(-1),mat4Create(),600,400,'right');assert.equal(m.uploads.length,2);
});
test('a failed per-view VAO allocation retries without leaks or partial draws',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud());
  m.raw.vaoOk=false;r.draw(vp(),mat4Create(),600,400);assert.equal(m.draws.length,0);
  m.raw.vaoOk=true;r.draw(vp(),mat4Create(),600,400);assert.equal(m.draws.length,1);
  r.dispose();assert.deepEqual(new Set(m.deletedVAOs),new Set(m.vaos));
});
test('loader fallback dimensions come from drawing buffer without querying viewport',async()=>{
  const registry=getSharedRegistry(),saved=registry.xrGaussianRenderer,args:unknown[][]=[];
  try {
    registry.xrGaussianRenderer={create:()=>({ready:true,draw:(...a)=>args.push(a),dispose(){}})};
    const m=mockGL(),v=viewer(m),loader=new XRSplatLoader(fetchData as typeof fetch);
    loader.sync(v);await flush();const queries=m.queries;
    loader.draw(v,vp(),'left');assert.deepEqual(args[0].slice(2),[600,400,'left']);
    assert.equal(m.queries,queries);loader.dispose();
  } finally {registry.xrGaussianRenderer=saved;}
});
test('empty data and invalid viewport never draw or allocate order buffers',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud([]));r.draw(vp(),mat4Create(),600,400);
  const s=new AnisotropicSplatRenderer(m.gl,cloud());
  for(const v of [0,-1,NaN,Infinity]){s.draw(vp(),mat4Create(),v,400);s.draw(vp(),mat4Create(),600,v);}
  assert.equal(m.buffers.length,2,'only static corner buffers');assert.equal(m.draws.length,0);
});
test('dispose frees both orders/texture/program, is repeatable and disables draws',()=>{
  const m=mockGL(),r=new AnisotropicSplatRenderer(m.gl,cloud());r.draw(vp(),mat4Create(),600,400,'left');r.draw(vp(),mat4Create(),600,400,'right');
  r.dispose();r.dispose();r.draw(vp(),mat4Create(),600,400);
  assert.equal(r.ready,false);assert.deepEqual(new Set(m.deleted),new Set(m.buffers));assert.deepEqual(m.deletedTextures,m.textures);assert.deepEqual(m.deletedPrograms,m.programs);assert.deepEqual(new Set(m.deletedVAOs),new Set(m.vaos));assert.equal(m.draws.length,2);
});
async function flush(){await new Promise(resolve=>setTimeout(resolve,0));}
function viewer(m:ReturnType<typeof mockGL>,mode='anisotropic'){
  return {gl:m.gl,meshes:[{transform:mat4Create(),userData:{xr:{splatUrl:'https://localhost/test.splat'}}}],
    container:{hasAttribute:()=>false,getAttribute:(name:string)=>name==='splat-render-mode'?mode:null}} as any;
}
const fetchData=async()=>new Response(new Uint8Array(32));
test('anisotropic opt-in waits for add-on without fetching or silently drawing lite',async()=>{
  const registry=getSharedRegistry(),saved=registry.xrGaussianRenderer;delete registry.xrGaussianRenderer;
  try {let calls=0;const loader=new XRSplatLoader((async()=>{calls++;return fetchData();}) as typeof fetch),v=viewer(mockGL());
    loader.sync(v);await flush();assert.equal(calls,0);assert.deepEqual(getSplatRenderStatus(loader),{anisotropic:0,lite:0,pending:1,failed:0});
    registry.xrGaussianRenderer={create:(gl,data)=>new AnisotropicSplatRenderer(gl,data)};
    loader.sync(v);await flush();assert.equal(calls,1);assert.equal(getSplatRenderStatus(loader).anisotropic,1);loader.dispose();
  } finally {registry.xrGaussianRenderer=saved;}
});
test('default lite mode preserves original behavior even when the add-on is installed',async()=>{
  const registry=getSharedRegistry(),saved=registry.xrGaussianRenderer;registry.xrGaussianRenderer={create:()=>{throw Error('must not use add-on');}};
  try {const loader=new XRSplatLoader(fetchData as typeof fetch);loader.sync(viewer(mockGL(),'lite'));await flush();assert.equal(getSplatRenderStatus(loader).lite,1);loader.dispose();}
  finally{registry.xrGaussianRenderer=saved;}
});
test('loader forwards per-eye viewport and reports renderer failure without fallback',async()=>{
  const registry=getSharedRegistry(),saved=registry.xrGaussianRenderer,args:unknown[][]=[];let disposed=0;
  try {registry.xrGaussianRenderer={create:()=>({ready:true,draw:(...a)=>args.push(a),dispose:()=>disposed++})};
    const loader=new XRSplatLoader(fetchData as typeof fetch),v=viewer(mockGL());loader.sync(v);await flush();loader.draw(v,vp(),'right',[100,0,300,400]);
    assert.deepEqual(args[0].slice(2),[300,400,'right']);loader.dispose();assert.equal(disposed,1);
    registry.xrGaussianRenderer={create:()=>({ready:false,draw(){},dispose:()=>disposed++})};
    loader.sync(v);await flush();assert.equal(getSplatRenderStatus(loader).failed,1);assert.equal(disposed,2);loader.dispose();
  } finally {registry.xrGaussianRenderer=saved;}
});
test('lite loader forwards each eye to the per-eye sorting renderer',async()=>{
  const calls: unknown[][]=[];
  const original=SplatRenderer.prototype.draw;
  SplatRenderer.prototype.draw=function(...args: Parameters<SplatRenderer['draw']>){calls.push(args);};
  try {
    const loader=new XRSplatLoader(fetchData as typeof fetch),v=viewer(mockGL(),'lite');
    loader.sync(v);await flush();
    assert.equal(getSplatRenderStatus(loader).lite,1);
    loader.draw(v,vp(),'left');loader.draw(v,vp(),'right',[100,0,300,400]);
    assert.deepEqual(calls.map(args=>args[6]),['left','right']);
    loader.dispose();
  } finally {SplatRenderer.prototype.draw=original;}
});
test('loading removed cloud cannot create a stale renderer',async()=>{
  const registry=getSharedRegistry(),saved=registry.xrGaussianRenderer;let created=0,resolve!:(r:Response)=>void;
  registry.xrGaussianRenderer={create:()=>{created++;return{ready:true,draw(){},dispose(){}};}};
  try{const loader=new XRSplatLoader((()=>new Promise(r=>resolve=r)) as typeof fetch),v=viewer(mockGL());loader.sync(v);v.meshes=[];loader.sync(v);resolve(await fetchData());await flush();assert.equal(created,0);assert.equal(getSplatRenderStatus(loader).pending,0);}
  finally{registry.xrGaussianRenderer=saved;}
});

(async()=>{let failed=0;for(const [name,run]of cases){try{await run();console.log(`PASS ${name}`);}catch(error){failed++;console.error(`FAIL ${name}`,error);}}console.log(`Gaussian splats: ${cases.length-failed} passed, ${failed} failed.`);if(failed)process.exitCode=1;})();
