/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
// Type-only contracts: the lean core registry must not pull in XR implementation.

import type {SplatData} from './splat-loader';
export type {SplatData} from './splat-loader';

/** Optional browser quality renderer contract. No change to serialized traits. */
export interface GaussianSplatRenderer {
  readonly ready: boolean;
  draw(vp: Float32Array, model: Float32Array, width: number, height: number, eye?: string): void;
  dispose(): void;
}

/** Installed by the optional Gaussian add-on, shared across ESM/IIFE bundles. */
export interface GaussianSplatRendererFactory {
  create(gl: WebGL2RenderingContext, data: SplatData): GaussianSplatRenderer;
}
