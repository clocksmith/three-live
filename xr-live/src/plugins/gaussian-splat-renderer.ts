/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Anisotropic, DC-color Gaussian splats for the browser WebGL2 runtime.
 */

import {createProgram} from '../../../three-live/src/gl-program';
import {mat4Multiply} from '../../../three-live/src/math';
import {
  MAX_SPLATS, createSplatSortCache, type SplatData,
} from './splat-loader';

/** Bounds raster work even for malformed scales or a camera inside a cloud. */
export const MAX_GAUSSIAN_AXIS_PX = 128;
/** Browser capability, not a claim about native renderers or SH appearance. */
export const GAUSSIAN_SPLAT_CAPABILITIES = Object.freeze({
  renderer: 'anisotropic-gaussian' as const,
  covariance: 'projected-3d' as const,
  primitive: 'instanced-quad' as const,
  sphericalHarmonics: false,
  maxAxisPixels: MAX_GAUSSIAN_AXIS_PX,
  supportSigma: 3,
});

// Three RGBA32UI texels per splat retain float32 inputs exactly, including
// quaternion xyzw and every scale axis. Integer storage also retains RGBA8.
const TEXELS_PER_SPLAT = 3;

/** Packed immutable input. Bounded at 48 bytes/splat plus one texture row. */
export function packGaussianSplats(data: SplatData, width: number): Uint32Array {
  if (!Number.isInteger(data.count) || data.count < 0 || data.count > MAX_SPLATS ||
      data.positions.length !== data.count * 3 || data.scales.length !== data.count * 3 ||
      data.rotations.length !== data.count * 4 || data.colors.length !== data.count * 4 ||
      !Number.isInteger(width) || width < 1 || width > 2048) {
    throw new Error('splat-loader: invalid Gaussian data');
  }
  const height = Math.max(1, Math.ceil(data.count * TEXELS_PER_SPLAT / width));
  const packed = new Uint32Array(width * height * 4);
  const floats = new Float32Array(packed.buffer);
  for (let i = 0; i < data.count; i++) {
    const o = i * 12;
    for (let k = 0; k < 3; k++) floats[o + k] = data.positions[i * 3 + k];
    const c = i * 4;
    packed[o + 3] = (data.colors[c] | data.colors[c + 1] << 8 |
      data.colors[c + 2] << 16 | data.colors[c + 3] << 24) >>> 0;
    for (let k = 0; k < 3; k++) floats[o + 4 + k] = data.scales[i * 3 + k];
    for (let k = 0; k < 4; k++) floats[o + 8 + k] = data.rotations[c + k];
  }
  return packed;
}

const VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
layout(location=0) in uint aIndex;
layout(location=1) in vec2 aCorner;
uniform highp usampler2D uData;
uniform int uWidth;
uniform mat4 uMVP;
uniform vec2 uViewport;
out vec2 vSigma;
flat out vec4 vColor;
uvec4 readData(int i){return texelFetch(uData,ivec2(i%uWidth,i/uWidth),0);}
vec3 rotate(vec4 q,vec3 v){return v+2.0*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
void main(){
// Invalid/behind-camera splats become degenerate outside the clip volume.
gl_Position=vec4(2.0,2.0,2.0,1.0);vSigma=vec2(0.0);vColor=vec4(0.0);
int i=int(aIndex)*3;
uvec4 p=readData(i);
vec3 scales=abs(uintBitsToFloat(readData(i+1).xyz));
vec4 q=uintBitsToFloat(readData(i+2));
float qn=dot(q,q);
q=qn>1e-12&&!isinf(qn)?q*inversesqrt(qn):vec4(0.0,0.0,0.0,1.0);
vec4 c=uMVP*vec4(uintBitsToFloat(p.xyz),1.0);
if(any(isnan(c))||any(isinf(c))||c.w<=1e-6||abs(c.z)>c.w)return;
vec2 ndc=c.xy/c.w;
// Jacobian of perspective divide composed with model/view/projection and
// the rotated scale basis. This also handles nonuniform model transforms,
// off-axis stereo projections and orthographic projection without a focal
// length approximation: Sigma2D = J R S S^T R^T J^T.
vec4 bx=uMVP*vec4(rotate(q,vec3(scales.x,0.0,0.0)),0.0);
vec4 by=uMVP*vec4(rotate(q,vec3(0.0,scales.y,0.0)),0.0);
vec4 bz=uMVP*vec4(rotate(q,vec3(0.0,0.0,scales.z)),0.0);
vec2 factor=0.5*uViewport/c.w;
vec2 x=(bx.xy-ndc*bx.w)*factor;
vec2 y=(by.xy-ndc*by.w)*factor;
vec2 z=(bz.xy-ndc*bz.w)*factor;
// EWA low-pass filter: 0.3 pixel^2 on the diagonal, as in 3DGS.
float a=x.x*x.x+y.x*y.x+z.x*z.x+0.3;
float b=x.x*x.y+y.x*y.y+z.x*z.y;
float d=x.y*x.y+y.y*y.y+z.y*z.y+0.3;
vec3 cov=vec3(a,b,d);
if(any(isnan(cov))||any(isinf(cov)))return;
float mid=0.5*(a+d);
float delta=length(vec2(0.5*(a-d),b));
float major=mid+delta;
float minor=max(0.3,mid-delta);
if(isinf(major)||isnan(major))return;
vec2 dir=vec2(1.0,0.0);
if(abs(b)>1e-6)dir=normalize(vec2(b,major-a));
else if(d>a)dir=vec2(0.0,1.0);
vec2 axes=3.0*sqrt(vec2(major,minor));
// Uniformly shrink oversized footprints, preserving the ellipse aspect.
axes*=min(1.0,${MAX_GAUSSIAN_AXIS_PX}.0/max(axes.x,1e-6));
vec2 corner=aCorner;
vec2 offset=corner.x*axes.x*dir+corner.y*axes.y*vec2(-dir.y,dir.x);
gl_Position=c+vec4(2.0*offset/uViewport*c.w,0.0,0.0);
vSigma=3.0*corner;
vColor=vec4(float(p.w&255u),float((p.w>>8u)&255u),
  float((p.w>>16u)&255u),float(p.w>>24u))/255.0;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vSigma;
flat in vec4 vColor;
out vec4 o;
void main(){
float r=dot(vSigma,vSigma);
if(r>9.0)discard;
float a=min(0.99,vColor.a*exp(-0.5*r));
if(a<1.0/255.0)discard;
o=vec4(vColor.rgb*a,a);
}`;

/** Sorted, screen-space anisotropic Gaussians. Native renderers are unchanged. */
export class AnisotropicSplatRenderer {
  readonly capabilities = GAUSSIAN_SPLAT_CAPABILITIES;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private corners: WebGLBuffer | null = null;
  private readonly sorter: ReturnType<typeof createSplatSortCache>;
  private readonly mvp = new Float32Array(16);
  private uMVP: WebGLUniformLocation | null = null;
  private uViewport: WebGLUniformLocation | null = null;
  private uData: WebGLUniformLocation | null = null;
  private uWidth: WebGLUniformLocation | null = null;
  private width = 1;

  constructor(private readonly gl: WebGL2RenderingContext, readonly data: SplatData) {
    // Validate and bound data before allocating sort arrays or GPU storage.
    this.width = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    const packed = packGaussianSplats(data, this.width);
    const height = packed.length / (4 * this.width);
    if (height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      throw new Error('splat-loader: Gaussian texture exceeds GPU size limit');
    }
    this.sorter = createSplatSortCache(gl, data, gl.ARRAY_BUFFER);
    this.program = createProgram(gl, VS, FS, false);
    if (!this.program) return;
    this.texture = gl.createTexture();
    if (!this.texture) { this.dispose(); return; }
    // WebGL2 requires an enabled, active divisor-zero attribute. Using only
    // gl_VertexID for corners is legal GLES but INVALID_OPERATION in WebGL2.
    this.corners = gl.createBuffer();
    if (!this.corners) { this.dispose(); return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    this.uMVP = gl.getUniformLocation(this.program, 'uMVP');
    this.uViewport = gl.getUniformLocation(this.program, 'uViewport');
    this.uData = gl.getUniformLocation(this.program, 'uData');
    this.uWidth = gl.getUniformLocation(this.program, 'uWidth');
    const oldTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, this.width, height, 0,
      gl.RGBA_INTEGER, gl.UNSIGNED_INT, packed);
    gl.bindTexture(gl.TEXTURE_2D, oldTexture);
  }

  get ready(): boolean { return !!(this.program && this.corners && this.texture); }

  /**
   * Draw with actual per-eye viewport dimensions. At most two independent
   * sorted orders are retained; settled cameras upload nothing. Moving views
   * retain the existing four-draw sort cadence. `eye` can be a caller key.
   */
  draw(vp: Float32Array, model: Float32Array, width: number, height: number, eye = 'none'): void {
    if (!this.ready || this.data.count === 0 || !Number.isFinite(width) ||
        !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const gl = this.gl;
    mat4Multiply(this.mvp, vp, model);
    const sorted = this.sorter.update(this.mvp, eye);
    if (!sorted) return;
    if (!sorted.vao) {
      const vao = gl.createVertexArray();
      if (!vao) return;
      sorted.vao = vao;
      gl.bindVertexArray(vao);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 0);
    } else gl.bindVertexArray(sorted.vao);
    // Unit 15 is reserved for this add-on. No synchronous state queries.
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMVP, false, this.mvp);
    gl.uniform2f(this.uViewport, width, height);
    gl.uniform1i(this.uData, 15);
    gl.uniform1i(this.uWidth, this.width);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.data.count);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    const gl = this.gl;
    this.sorter.dispose();
    if (this.corners) gl.deleteBuffer(this.corners);
    this.corners = null;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.program) gl.deleteProgram(this.program);
    this.texture = this.program = null;
  }
}
