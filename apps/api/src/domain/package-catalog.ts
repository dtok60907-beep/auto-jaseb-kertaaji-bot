export const PACKAGE_TYPES = ["JASEB_WORKER", "USERBOT"] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

export const PACKAGE_FEATURES = ["JASEB", "AUTO_COMMENT_MF"] as const;
export type PackageFeature = (typeof PACKAGE_FEATURES)[number];

export type PackageConfig = {
  name: string;
  type: PackageType;
  priceIdr: number;
  durationDays: number;
  features: readonly PackageFeature[];
  maxTargetsPerMinute: number;
  maxAccounts: number;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  displayOrder: number;
  active: boolean;
};

export type PublicPackage = Readonly<PackageConfig & { id: string }>;

export type PackageValidationIssue = {
  field: string;
  code: string;
};

export class PackageValidationError extends Error {
  readonly issues: readonly PackageValidationIssue[];

  constructor(issues: readonly PackageValidationIssue[]) {
    super("Konfigurasi paket tidak valid.");
    this.name = "PackageValidationError";
    this.issues = issues;
  }
}

const featureSet = new Set<string>(PACKAGE_FEATURES);
const packageTypeSet = new Set<string>(PACKAGE_TYPES);

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function addPositiveIssue(issues: PackageValidationIssue[], field: string, value: unknown, { zeroAllowed = false } = {}) {
  if (!isInteger(value) || (zeroAllowed ? value < 0 : value <= 0)) {
    issues.push({ field, code: zeroAllowed ? "MUST_BE_NON_NEGATIVE_INTEGER" : "MUST_BE_POSITIVE_INTEGER" });
  }
}

export function validatePackageConfig(input: unknown): PackageConfig {
  const value = (input ?? {}) as Record<string, unknown>;
  const issues: PackageValidationIssue[] = [];

  if (typeof value.name !== "string" || value.name.trim() === "") {
    issues.push({ field: "name", code: "REQUIRED" });
  } else if (value.name.trim().length > 80) {
    issues.push({ field: "name", code: "TOO_LONG" });
  }
  if (typeof value.type !== "string" || !packageTypeSet.has(value.type)) issues.push({ field: "type", code: "UNSUPPORTED" });
  addPositiveIssue(issues, "priceIdr", value.priceIdr, { zeroAllowed: true });
  addPositiveIssue(issues, "durationDays", value.durationDays);
  addPositiveIssue(issues, "maxTargetsPerMinute", value.maxTargetsPerMinute);
  addPositiveIssue(issues, "maxAccounts", value.maxAccounts);
  addPositiveIssue(issues, "intervalMinSeconds", value.intervalMinSeconds, { zeroAllowed: true });
  addPositiveIssue(issues, "intervalMaxSeconds", value.intervalMaxSeconds, { zeroAllowed: true });
  addPositiveIssue(issues, "displayOrder", value.displayOrder, { zeroAllowed: true });

  if (!Array.isArray(value.features) || value.features.length === 0) {
    issues.push({ field: "features", code: "REQUIRED" });
  } else {
    const seen = new Set<string>();
    for (const feature of value.features) {
      if (typeof feature !== "string" || !featureSet.has(feature)) issues.push({ field: "features", code: "UNSUPPORTED" });
      else if (seen.has(feature)) issues.push({ field: "features", code: "DUPLICATE" });
      else seen.add(feature);
    }
  }
  if (typeof value.active !== "boolean") issues.push({ field: "active", code: "MUST_BE_BOOLEAN" });
  if (isInteger(value.intervalMinSeconds) && isInteger(value.intervalMaxSeconds) && value.intervalMinSeconds > value.intervalMaxSeconds) {
    issues.push({ field: "intervalMinSeconds", code: "MUST_NOT_EXCEED_MAXIMUM" });
  }
  if (issues.length > 0) throw new PackageValidationError(issues);

  return {
    name: (value.name as string).trim(),
    type: value.type as PackageType,
    priceIdr: value.priceIdr as number,
    durationDays: value.durationDays as number,
    features: Object.freeze([...(value.features as PackageFeature[])]),
    maxTargetsPerMinute: value.maxTargetsPerMinute as number,
    maxAccounts: value.maxAccounts as number,
    intervalMinSeconds: value.intervalMinSeconds as number,
    intervalMaxSeconds: value.intervalMaxSeconds as number,
    displayOrder: value.displayOrder as number,
    active: value.active as boolean,
  };
}

export function toPublicPackage(id: string, input: unknown): PublicPackage {
  if (typeof id !== "string" || id.trim() === "") throw new TypeError("id is required");
  const config = validatePackageConfig(input);
  return Object.freeze({ id: id.trim(), ...config });
}

export function snapshotEntitlement(pkg: PublicPackage) {
  return Object.freeze({
    packageId: pkg.id,
    packageName: pkg.name,
    packageType: pkg.type,
    priceIdr: pkg.priceIdr,
    durationDays: pkg.durationDays,
    features: Object.freeze([...pkg.features]),
    maxTargetsPerMinute: pkg.maxTargetsPerMinute,
    maxAccounts: pkg.maxAccounts,
    intervalMinSeconds: pkg.intervalMinSeconds,
    intervalMaxSeconds: pkg.intervalMaxSeconds,
  });
}
