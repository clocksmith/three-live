/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
export interface GaussianSplatData {
  readonly count: number;
  readonly positions: Float32Array;
  readonly scales: Float32Array;
  readonly colors: Uint8Array;
  readonly rotations: Float32Array;
}
export declare const MAX_GAUSSIAN_AXIS_PX = 128;
export declare const GAUSSIAN_SPLAT_CAPABILITIES: Readonly<{
  renderer: 'anisotropic-gaussian'; covariance: 'projected-3d';
  primitive: 'instanced-quad'; sphericalHarmonics: false;
  maxAxisPixels: number; supportSigma: number;
}>;
export declare function packGaussianSplats(data: GaussianSplatData, width: number): Uint32Array;
export declare class AnisotropicSplatRenderer {
  readonly data: GaussianSplatData;
  readonly capabilities: typeof GAUSSIAN_SPLAT_CAPABILITIES;
  constructor(gl: WebGL2RenderingContext, data: GaussianSplatData);
  get ready(): boolean;
  draw(vp: Float32Array, model: Float32Array, width: number, height: number, eye?: string): void;
  dispose(): void;
}

export declare function getSplatRenderStatus(loader: {readonly renderers: Iterable<{readonly failed: boolean; readonly renderer: unknown; readonly mode: 'anisotropic' | 'lite'}>}): {anisotropic: number; lite: number; pending: number; failed: number};
