/** Copyright 2026 Google LLC. SPDX-License-Identifier: Apache-2.0 */
export interface SceneDocument {gltf: any; bin: ArrayBuffer;}
export interface SceneEditHost {
  readonly sceneRevision: number;
  getLoadedModel(): unknown;
  loadModel(model: SceneDocument): Promise<void>;
}
export interface SceneEditConstraints {
  preserveHeight?: boolean | {tolerance?: number};
  preserveBounds?: boolean | {tolerance?: number};
  preserveFootprint?: boolean | {tolerance?: number};
  maxBounds?: [number, number, number];
  matchMaterialOf?: string;
}
export interface SceneEditOptions {
  target: string | string[];
  replacement: SceneDocument | ArrayBuffer | ArrayBufferView | Promise<SceneDocument | ArrayBuffer | ArrayBufferView>;
  replacementTarget?: string | string[];
  preserveTransform?: boolean;
  preserveTargetName?: boolean;
  copyMaterialFrom?: string;
  constraints?: SceneEditConstraints;
  warnings?: string[];
}
export interface SceneEditReceipt {
  editId: number;
  revision: number;
  status: 'preview' | 'accepted' | 'rejected' | 'undone';
  applied: boolean;
  targets: string[];
  constraints: Array<{name: string; passed: boolean}>;
  errors: string[];
  warnings: string[];
  undoDepth: number;
}
export declare function prepareSceneEdit(input: SceneDocument, replacement: SceneDocument, options: SceneEditOptions): {model: SceneDocument; constraints: SceneEditReceipt['constraints']};
export declare class SceneEditor {
  constructor(host: SceneEditHost, maxUndoSteps?: number);
  previewEdit(options: SceneEditOptions): Promise<SceneEditReceipt>;
  acceptEdit(): SceneEditReceipt;
  rejectEdit(): Promise<SceneEditReceipt>;
  undoEdit(): Promise<SceneEditReceipt>;
  dispose(): Promise<void>;
}
