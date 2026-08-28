import type { Sql } from "postgres";
import type { PackageConfig, PackageFeature, PackageType } from "../domain/package-catalog.ts";
import type { CreatePackageInput, PackageRepository, PackageView, PublishPackageInput } from "./repository.ts";

type PackageRow = {
  id: string;
  code: string;
  name: string;
  package_type: PackageType;
  price_idr: string | number;
  duration_days: number;
  features: string[];
  max_targets_per_minute: number;
  max_accounts: number;
  interval_min_seconds: number;
  interval_max_seconds: number;
  display_order: number;
  active: boolean;
  version: number;
};

function databaseConfig(config: PackageConfig) {
  return {
    name: config.name,
    packageType: config.type,
    priceIdr: config.priceIdr,
    durationDays: config.durationDays,
    features: config.features,
    maxTargetsPerMinute: config.maxTargetsPerMinute,
    maxAccounts: config.maxAccounts,
    intervalMinSeconds: config.intervalMinSeconds,
    intervalMaxSeconds: config.intervalMaxSeconds,
    displayOrder: config.displayOrder,
    active: config.active,
  };
}

function toView(row: PackageRow): PackageView {
  return Object.freeze({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.package_type,
    priceIdr: Number(row.price_idr),
    durationDays: row.duration_days,
    features: Object.freeze([...row.features] as PackageFeature[]),
    maxTargetsPerMinute: row.max_targets_per_minute,
    maxAccounts: row.max_accounts,
    intervalMinSeconds: row.interval_min_seconds,
    intervalMaxSeconds: row.interval_max_seconds,
    displayOrder: row.display_order,
    active: row.active,
    version: row.version,
  });
}

export class PostgresPackageRepository implements PackageRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async create(input: CreatePackageInput): Promise<PackageView> {
    const rows = await this.sql<{ id: string }[]>`
      select public.create_package_with_version(
        ${input.code},
        ${this.sql.json(databaseConfig(input.config))},
        ${input.actorId}::uuid
      )::text as id
    `;
    return this.readOne(rows[0].id);
  }

  async publish(input: PublishPackageInput): Promise<PackageView | null> {
    const existing = await this.sql<{ exists: boolean }[]>`
      select exists(select 1 from public.package_catalog where id = ${input.id}::uuid) as exists
    `;
    if (!existing[0]?.exists) return null;
    await this.sql`
      select public.publish_package_version(
        ${input.id}::uuid,
        ${this.sql.json(databaseConfig(input.config))},
        ${input.actorId}::uuid
      )
    `;
    return this.readOne(input.id);
  }

  async list(options: { includeInactive: boolean }): Promise<readonly PackageView[]> {
    const rows = options.includeInactive
      ? await this.sql<PackageRow[]>`
          select c.id::text, c.code, c.name, c.package_type, c.price_idr, c.duration_days,
                 c.features, c.max_targets_per_minute, c.max_accounts,
                 c.interval_min_seconds, c.interval_max_seconds, c.display_order, c.active,
                 v.version
            from public.package_catalog c
            join public.package_versions v on v.id = c.current_version_id
           order by c.display_order, c.created_at
        `
      : await this.sql<PackageRow[]>`
          select c.id::text, c.code, c.name, c.package_type, c.price_idr, c.duration_days,
                 c.features, c.max_targets_per_minute, c.max_accounts,
                 c.interval_min_seconds, c.interval_max_seconds, c.display_order, c.active,
                 v.version
            from public.package_catalog c
            join public.package_versions v on v.id = c.current_version_id
           where c.active
           order by c.display_order, c.created_at
        `;
    return Object.freeze(rows.map(toView));
  }

  private async readOne(id: string): Promise<PackageView> {
    const rows = await this.sql<PackageRow[]>`
      select c.id::text, c.code, c.name, c.package_type, c.price_idr, c.duration_days,
             c.features, c.max_targets_per_minute, c.max_accounts,
             c.interval_min_seconds, c.interval_max_seconds, c.display_order, c.active,
             v.version
        from public.package_catalog c
        join public.package_versions v on v.id = c.current_version_id
       where c.id = ${id}::uuid
    `;
    if (!rows[0]) throw new Error("package version was not persisted");
    return toView(rows[0]);
  }
}
