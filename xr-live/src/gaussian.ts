/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Optional browser-only anisotropic Gaussian renderer. Load alongside spatial
 * plugins and set splat-render-mode="anisotropic" on the viewer host.
 */
import {getSharedRegistry} from '../../three-live/src/plugin';
import {AnisotropicSplatRenderer} from './plugins/gaussian-splat-renderer';
getSharedRegistry().xrGaussianRenderer = {
  create: (gl, data) => new AnisotropicSplatRenderer(gl, data),
};
export * from './plugins/gaussian-splat-renderer';

/** Derive diagnostics from actual renderer state; omitted from default bundles. */
export function getSplatRenderStatus(loader: import('./plugins/splat-loader').XRSplatLoader) {
  const status = {anisotropic: 0, lite: 0, pending: 0, failed: 0};
  for (const entry of loader.renderers) {
    if (entry.failed) status.failed++;
    else if (!entry.renderer) status.pending++;
    else status[entry.mode]++;
  }
  return status;
}
