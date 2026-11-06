# Optional document editing

Import `SceneEditor` from `three-live/edits`. It is a host application layer;
viewer, author, full and XR bundles do not import it. It works with an element
that exposes `getLoadedModel()`, `loadModel()` and `sceneRevision` (including the
scene-lifecycle branch). No model or generated JavaScript is required.

```js
import {SceneEditor} from 'three-live/edits';
const edits = new SceneEditor(document.querySelector('three-live'));
const receipt = await edits.previewEdit({
  target: 'Tower',
  replacement: replacementGLB,
  constraints: {preserveHeight: true, preserveFootprint: {tolerance: 0.1}},
});
if (receipt.status === 'preview') edits.acceptEdit();
// Alternatively: await edits.rejectEdit();
// Later: await edits.undoEdit();
```

`replacement` may be a GLB, a typed document, or a promise from an external
compiler. Script compilation must still use Three-Live's worker/iframe sandbox;
this module never evaluates scripts. Starting another edit or any element load
invalidates pending compilation, including a fetch that has not completed yet.

Preparation merges document references and binary offsets before touching the
viewer. GPU preparation uses the ordinary atomic loader. Preview renders the
candidate; accept retains it, reject restores the prior document, and undo
restores an accepted document. Exports observe the same document as rendering.
Receipts report constraints and errors separately. Failed constraints never
publish a candidate. Failed GPU preparation retains the existing scene.

Targets use unique node names. Transforms and target names are preserved by
default. Optional replacementTarget, copyMaterialFrom, preserveHeight,
preserveBounds, preserveFootprint, maxBounds and matchMaterialOf are supported.
Replacement meshes/materials/textures use standard single-buffer glTF references.
Unsupported replacement extensions, cameras, skins and animations are refused;
editing skinned/instanced targets or animated descendants requires an explicit
adapter. These refusals prevent silently discarding their behavior. This does
not implement native editing or arbitrary GLB composition.

Snapshots are bounded: 64 MiB binary and 4 MiB JSON per document, at most 16 undo
steps, and 128 MiB retained undo binary data. The default is eight steps.
Call `dispose()` when the editor is retired. Authoring models remain optional.
