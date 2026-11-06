# Browser anisotropic Gaussian splats

The optional `xr-live-gaussian` add-on renders the scale and quaternion in
`.splat` and SPZ v2/v3 captures as projected anisotropic Gaussian ellipses.
It shares the existing loader, URL policy, download/decompression limits and
`splatUrl` trait. It does not change glTF/USDZ serialization or native renderers.

## Enable explicitly

Load the spatial plugins (or full bundle), plus the Gaussian add-on from the
same build, and opt in on the host:

```html
<script src="xr-live.min.js"></script>
<script src="xr-live-plugins.min.js"></script>
<script src="xr-live-gaussian.min.js"></script>
<xr-live src="capture-scene.glb" splat-render-mode="anisotropic"></xr-live>
```

For ESM, import `xr-live/gaussian` alongside
the existing spatial plugins. The add-on registers a factory in the shared
registry, so ESM and IIFE builds work together. Loading it after the viewer
is supported. An opted-in viewer waits until the factory is available; it does
not silently substitute the lite renderer.

Without the attribute, the existing point-splat renderer stays in use.
Removing the attribute switches back on the next loader sync. The attribute is
browser-specific, not a canonical `userData.xr` trait or an exported setting.
Native Android, iOS and visionOS behavior is unchanged.

`GAUSSIAN_SPLAT_CAPABILITIES` describes the implementation explicitly:
projected 3D covariance, instanced quads, DC-only color, three-sigma support,
and a maximum 128-pixel major semi-axis. `getSplatRenderStatus(getSplatLoader(viewer))`
reports counts of anisotropic, lite, pending and failed clouds. A failed
anisotropic initialization is reported as failed, not as successful lite output.

## Rendering and limits

- The shader projects all three rotated scale axes through the actual
  model-view-projection Jacobian, including perspective divide. It therefore
  accounts for camera orientation, nonuniform model transforms, off-axis
  stereo projection and the active eye's viewport.
- The projected 2D covariance receives a 0.3 pixel-squared diagonal low-pass
  filter. Its eigenvectors orient a quad; fragments evaluate
  `opacity * exp(-0.5 * squaredSigmaDistance)` with premultiplied alpha.
- Three-sigma support is clipped to an ellipse. Alpha below 1/255 is discarded
  and alpha is capped at 0.99. Oversized footprints shrink uniformly to a
  128-pixel major semi-axis, preserving aspect ratio while bounding raster work.
  Nonfinite covariance and centers outside the near/far clip range are culled.
- Sorting remains per-cloud, back-to-front, 16-bit quantized and limited to
  every fourth draw while moving. Stationary views avoid sorting/uploads.
  Stereo eyes with identical active depth rows share one order, buffer, VAO
  and cooldown. Divergent eyes retain independent orders, bounded to two GPU
  index buffers. Previously split storage is pooled until disposal.
  Orthographic views use clip-space depth instead of constant clip-space w.
- Source texture storage is 48 bytes per splat plus less than one texture row
  (at most 32 KiB padding). Sorting and stereo storage are also bounded by the
  existing one-million-splat cap. This is more GPU input storage than lite.
- Higher-order spherical harmonics, cross-cloud global sorting, per-pixel
  Gaussian depth, order-independent transparency, and native image-quality
  parity are not implemented. Existing four-draw sorting can remain stale for
  three draws while moving. This is anisotropic geometry, not full radiance-field
  or production 3DGS renderer parity.

The mathematical approach follows projected Gaussian covariance described in
[3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/).
The low-pass convention is also used in the authors'
[reference rasterizer](https://github.com/graphdeco-inria/diff-gaussian-rasterization/blob/main/cuda_rasterizer/forward.cu).
This implementation is independent WebGL2 code, not copied CUDA code.

## Validation

`node scripts/build.js --test` includes packing, sorting, stereo cache,
resource lifecycle, factory-loading, failure and interoperability-path tests.
`node scripts/build.js` enforces all existing bundle budgets unchanged and a
separate `< 8 KB gz` budget for the optional Gaussian add-on.

The package-consumer check verifies CJS/ESM imports and the full distributed
license from the actual npm tarball: `node scripts/test_gaussian_package.cjs`.

Optional real-context checks:

```sh
# Browser pixel checks and software timing samples; requires Playwright/Chromium.
CHROMIUM_PATH=/usr/bin/chromium node scripts/test_gaussian_splats_browser.cjs /tmp/gaussian-browser

# Linux software GLES shader/pixel smoke test, not browser validation.
# Requires libEGL, numpy and Pillow.
python3 scripts/test_gaussian_splats_egl.py /tmp/gaussian-egl
```

The EGL test compiles the actual shader strings and measures rendered ellipse
moments for 0/45/90-degree rotations, nonuniform transforms, viewport changes,
orthographic projection, clipping and offscreen overlap. It outputs a labeled
comparison image and machine-readable results. The browser script also exercises
parser inputs and the real WebGL draw-state contract and labels its software timing
samples. Neither replaces testing on physical GPUs or WebXR headsets.

The add-on reserves texture unit 15 during drawing, clears its binding afterward,
and leaves unit 0 active. Units 0–14 retain their texture bindings. Each cached
eye owns its VAO; stationary draws make no GL state queries or attribute setup
calls. Integrations must respect this explicit post-pass contract, rather than
expect arbitrary active-unit restoration.
