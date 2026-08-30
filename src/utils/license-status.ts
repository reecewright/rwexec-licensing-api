import type { License } from "@prisma/client";

export type EffectiveLicenseStatus =
  | "active"
  | "expired"
  | "suspended"
  | "revoked";

export function effectiveStatus(license: License): EffectiveLicenseStatus {
  if (license.status === "SUSPENDED") return "suspended";
  if (license.status === "REVOKED") return "revoked";
  if (license.status === "EXPIRED") return "expired";

  if (license.expiresAt && license.expiresAt.getTime() <= Date.now()) {
    return "expired";
  }

  return "active";
}
