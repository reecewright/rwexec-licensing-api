import { prisma } from "../db.js";
import { hashLicenseKey } from "../utils/license-key.js";
import { effectiveStatus } from "../utils/license-status.js";
import { normalizeSiteUrl } from "../utils/site-url.js";

type ClientInput = {
  licenseKey: string;
  product: string;
  siteUrl: string;
  instanceId: string;
  pluginVersion?: string;
};

async function findLicense(licenseKey: string, productSlug: string) {
  return prisma.license.findFirst({
    where: {
      keyHash: hashLicenseKey(licenseKey),
      product: { slug: productSlug }
    },
    include: {
      product: true,
      activations: {
        where: { deactivatedAt: null }
      }
    }
  });
}

export async function activateLicense(input: ClientInput) {
  const siteUrl = normalizeSiteUrl(input.siteUrl);

  return prisma.$transaction(async (tx) => {
    const license = await tx.license.findFirst({
      where: {
        keyHash: hashLicenseKey(input.licenseKey),
        product: { slug: input.product }
      },
      include: {
        product: true,
        activations: {
          where: { deactivatedAt: null }
        }
      }
    });

    if (!license) {
      return { ok: false as const, reason: "invalid_license" as const };
    }

    const status = effectiveStatus(license);
    if (status !== "active") {
      return { ok: false as const, reason: status };
    }

    const existing = await tx.activation.findUnique({
      where: {
        licenseId_instanceId: {
          licenseId: license.id,
          instanceId: input.instanceId
        }
      }
    });

    if (existing) {
      const activation = await tx.activation.update({
        where: { id: existing.id },
        data: {
          siteUrl,
          pluginVersion: input.pluginVersion,
          lastCheckedAt: new Date(),
          deactivatedAt: null
        }
      });

      return {
        ok: true as const,
        license,
        activation,
        status: "active" as const
      };
    }

    const activeCount = license.activations.length;
    if (activeCount >= license.activationLimit) {
      return {
        ok: false as const,
        reason: "activation_limit_reached" as const,
        activationLimit: license.activationLimit,
        activations: activeCount
      };
    }

    const activation = await tx.activation.create({
      data: {
        licenseId: license.id,
        siteUrl,
        instanceId: input.instanceId,
        pluginVersion: input.pluginVersion
      }
    });

    return {
      ok: true as const,
      license,
      activation,
      status: "active" as const
    };
  });
}

export async function validateLicense(input: ClientInput) {
  const siteUrl = normalizeSiteUrl(input.siteUrl);
  const license = await findLicense(input.licenseKey, input.product);

  if (!license) {
    return { ok: false as const, reason: "invalid_license" as const };
  }

  const status = effectiveStatus(license);
  if (status !== "active") {
    return { ok: false as const, reason: status };
  }

  const activation = await prisma.activation.findUnique({
    where: {
      licenseId_instanceId: {
        licenseId: license.id,
        instanceId: input.instanceId
      }
    }
  });

  if (!activation || activation.deactivatedAt) {
    return { ok: false as const, reason: "not_activated" as const };
  }

  if (normalizeSiteUrl(activation.siteUrl) !== siteUrl) {
    return { ok: false as const, reason: "site_mismatch" as const };
  }

  const updated = await prisma.activation.update({
    where: { id: activation.id },
    data: {
      lastCheckedAt: new Date(),
      pluginVersion: input.pluginVersion
    }
  });

  return {
    ok: true as const,
    license,
    activation: updated,
    status: "active" as const
  };
}

export async function deactivateLicense(input: ClientInput) {
  const siteUrl = normalizeSiteUrl(input.siteUrl);
  const license = await findLicense(input.licenseKey, input.product);

  if (!license) {
    return { ok: false as const, reason: "invalid_license" as const };
  }

  const activation = await prisma.activation.findUnique({
    where: {
      licenseId_instanceId: {
        licenseId: license.id,
        instanceId: input.instanceId
      }
    }
  });

  if (!activation || activation.deactivatedAt) {
    return { ok: true as const, alreadyDeactivated: true };
  }

  if (normalizeSiteUrl(activation.siteUrl) !== siteUrl) {
    return { ok: false as const, reason: "site_mismatch" as const };
  }

  await prisma.activation.update({
    where: { id: activation.id },
    data: {
      deactivatedAt: new Date(),
      lastCheckedAt: new Date()
    }
  });

  return { ok: true as const, alreadyDeactivated: false };
}

export function publicLicensePayload(
  license: {
    expiresAt: Date | null;
    activationLimit: number;
    activations: unknown[];
  },
  activationId?: string
) {
  return {
    valid: true,
    status: "active",
    expires_at: license.expiresAt?.toISOString() ?? null,
    activation_limit: license.activationLimit,
    activations: license.activations.length,
    activation_id: activationId ?? null
  };
}
