import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAdminApiKey } from "../middleware/admin-auth.js";
import {
  generateLicenseKey,
  hashLicenseKey
} from "../utils/license-key.js";

const router = Router();
router.use(requireAdminApiKey);

const createLicenseSchema = z.object({
  product: z.string().min(2).max(100),
  customer_email: z.email().optional(),
  customer_name: z.string().trim().max(200).optional(),
  activation_limit: z.coerce.number().int().min(1).max(100).default(1),
  expires_at: z.iso.datetime().nullable().optional()
});

router.post("/licenses", async (req, res, next) => {
  try {
    const parsed = createLicenseSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        details: parsed.error.flatten()
      });
      return;
    }

    const product = await prisma.product.findUnique({
      where: { slug: parsed.data.product }
    });

    if (!product) {
      res.status(404).json({
        error: "product_not_found"
      });
      return;
    }

    let customerId: string | null = null;

    if (parsed.data.customer_email) {
      const customer = await prisma.customer.upsert({
        where: { email: parsed.data.customer_email.toLowerCase() },
        update: {
          name: parsed.data.customer_name
        },
        create: {
          email: parsed.data.customer_email.toLowerCase(),
          name: parsed.data.customer_name
        }
      });
      customerId = customer.id;
    }

    let rawKey = "";
    let keyHash = "";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      rawKey = generateLicenseKey(product.slug);
      keyHash = hashLicenseKey(rawKey);
      const existing = await prisma.license.findUnique({
        where: { keyHash }
      });
      if (!existing) break;
      rawKey = "";
      keyHash = "";
    }

    if (!rawKey || !keyHash) {
      throw new Error("Could not generate a unique licence key.");
    }

    const license = await prisma.license.create({
      data: {
        keyHash,
        keyLastFour: rawKey.slice(-4),
        status: "ACTIVE",
        activationLimit: parsed.data.activation_limit,
        expiresAt: parsed.data.expires_at
          ? new Date(parsed.data.expires_at)
          : null,
        productId: product.id,
        customerId
      }
    });

    res.status(201).json({
      id: license.id,
      license_key: rawKey,
      product: product.slug,
      status: "active",
      activation_limit: license.activationLimit,
      expires_at: license.expiresAt?.toISOString() ?? null,
      note: "This is the only response containing the full raw licence key."
    });
  } catch (error) {
    next(error);
  }
});

router.get("/licenses/:id", async (req, res, next) => {
  try {
    const license = await prisma.license.findUnique({
      where: { id: req.params.id },
      include: {
        product: true,
        customer: true,
        activations: true
      }
    });

    if (!license) {
      res.status(404).json({ error: "license_not_found" });
      return;
    }

    res.json({
      id: license.id,
      key_last_four: license.keyLastFour,
      status: license.status.toLowerCase(),
      activation_limit: license.activationLimit,
      expires_at: license.expiresAt?.toISOString() ?? null,
      product: {
        slug: license.product.slug,
        name: license.product.name
      },
      customer: license.customer
        ? {
            id: license.customer.id,
            name: license.customer.name,
            email: license.customer.email
          }
        : null,
      activations: license.activations.map((activation) => ({
        id: activation.id,
        site_url: activation.siteUrl,
        instance_id: activation.instanceId,
        plugin_version: activation.pluginVersion,
        activated_at: activation.activatedAt.toISOString(),
        last_checked_at: activation.lastCheckedAt.toISOString(),
        deactivated_at: activation.deactivatedAt?.toISOString() ?? null
      }))
    });
  } catch (error) {
    next(error);
  }
});

export { router as adminRouter };
