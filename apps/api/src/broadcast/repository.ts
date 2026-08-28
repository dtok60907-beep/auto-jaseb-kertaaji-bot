import type { BroadcastMaterial } from "../domain/broadcast-material.ts";
import type { BroadcastLpmTarget } from "../domain/broadcast-target.ts";

export type BroadcastMaterialView = Readonly<BroadcastMaterial & {
  id: string;
  active: boolean;
}>;

export type BroadcastLpmTargetView = Readonly<BroadcastLpmTarget & {
  id: string;
}>;

export interface BroadcastSettingsRepository {
  listMaterials(userId: string): Promise<readonly BroadcastMaterialView[]>;
  createMaterial(input: Readonly<{ userId: string; material: BroadcastMaterial; active: boolean }>): Promise<BroadcastMaterialView>;
  updateMaterial(input: Readonly<{ id: string; userId: string; material: BroadcastMaterial; active: boolean }>): Promise<BroadcastMaterialView | null>;
  deleteMaterial(input: Readonly<{ id: string; userId: string }>): Promise<boolean>;
  listLpmTargets(userId: string): Promise<readonly BroadcastLpmTargetView[]>;
  createLpmTarget(input: Readonly<{ userId: string; target: BroadcastLpmTarget }>): Promise<BroadcastLpmTargetView>;
  updateLpmTarget(input: Readonly<{ id: string; userId: string; target: BroadcastLpmTarget }>): Promise<BroadcastLpmTargetView | null>;
  deleteLpmTarget(input: Readonly<{ id: string; userId: string }>): Promise<boolean>;
}
