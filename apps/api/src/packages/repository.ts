import type { PackageConfig, PublicPackage } from "../domain/package-catalog.ts";

export type PackageView = PublicPackage & { code: string; version: number };

export type CreatePackageInput = {
  code: string;
  config: PackageConfig;
  actorId: string;
};

export type PublishPackageInput = {
  id: string;
  config: PackageConfig;
  actorId: string;
};

export interface PackageRepository {
  create(input: CreatePackageInput): Promise<PackageView>;
  publish(input: PublishPackageInput): Promise<PackageView | null>;
  list(options: { includeInactive: boolean }): Promise<readonly PackageView[]>;
}
