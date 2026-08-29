import type { EntitlementView } from "./repository.ts";

export type EntitlementFeature = "JASEB" | "AUTO_COMMENT_MF";
export type EntitlementAccess =
  | Readonly<{ ok: true; limit: number }>
  | Readonly<{ ok: false; code: "SUBSCRIPTION_REQUIRED" | "SUBSCRIPTION_EXPIRED" }>;

function matches(feature: EntitlementFeature, item: EntitlementView): boolean {
  return feature === "JASEB"
    ? item.packageType === "JASEB_WORKER" || item.packageType === "USERBOT"
    : item.packageType === "USERBOT";
}
export function resolveEntitlementAccess(
  entitlements: readonly EntitlementView[],
  feature: EntitlementFeature,
  now = Date.now(),
): EntitlementAccess {
  const related = entitlements.filter((item) => matches(feature, item));
  const active = related.filter((item) => item.status === "ACTIVE" && Date.parse(item.expiresAt) > now);
  if (active.length > 0) {
    const limit = feature === "JASEB"
      ? Math.max(...active.map((item) => item.maxLpmGroups))
      : Math.max(...active.map((item) => item.maxChannelTargets));
    return Object.freeze({ ok: true, limit });
  }
  const expired = related.some((item) => item.status === "EXPIRED" || (item.status === "ACTIVE" && Date.parse(item.expiresAt) <= now));
  return Object.freeze({ ok: false, code: expired ? "SUBSCRIPTION_EXPIRED" : "SUBSCRIPTION_REQUIRED" });
}
