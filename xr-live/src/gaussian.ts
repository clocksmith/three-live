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
