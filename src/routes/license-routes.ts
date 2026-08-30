import { Router } from "express";
import { z } from "zod";
import {
  activateLicense,
  deactivateLicense,
  publicLicensePayload,
  validateLicense
} from "../services/license-service.js";

const router = Router();

const clientSchema = z.object({
  license_key: z.string().min(8).max(200),
  product: z.string().min(2).max(100),
  site_url: z.url(),
  instance_id: z.uuid(),
  version: z.string().trim().max(50).optional()
});

function errorStatus(reason: string): number {
  if (reason === "invalid_license") return 404;
  if (reason === "activation_limit_reached") return 409;
  if (reason === "site_mismatch") return 409;
  if (reason === "not_activated") return 403;
  if (["expired", "suspended", "revoked", "subscription_inactive"].includes(reason)) return 403;
  return 400;
}

router.post("/activate", async (req, res, next) => {
  try {
    const parsed = clientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        details: parsed.error.flatten()
      });
      return;
    }

    const result = await activateLicense({
      licenseKey: parsed.data.license_key,
      product: parsed.data.product,
      siteUrl: parsed.data.site_url,
      instanceId: parsed.data.instance_id,
      pluginVersion: parsed.data.version
    });

    if (!result.ok) {
      res.status(errorStatus(result.reason)).json({
        valid: false,
        status: result.reason,
        activation_limit:
          "activationLimit" in result ? result.activationLimit : undefined,
        activations:
          "activations" in result ? result.activations : undefined
      });
      return;
    }

    res.json(
      publicLicensePayload(
        result.license,
        result.activation.id
      )
    );
  } catch (error) {
    next(error);
  }
});

router.post("/validate", async (req, res, next) => {
  try {
    const parsed = clientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        details: parsed.error.flatten()
      });
      return;
    }

    const result = await validateLicense({
      licenseKey: parsed.data.license_key,
      product: parsed.data.product,
      siteUrl: parsed.data.site_url,
      instanceId: parsed.data.instance_id,
      pluginVersion: parsed.data.version
    });

    if (!result.ok) {
      res.status(errorStatus(result.reason)).json({
        valid: false,
        status: result.reason
      });
      return;
    }

    res.json(
      publicLicensePayload(
        result.license,
        result.activation.id
      )
    );
  } catch (error) {
    next(error);
  }
});

router.post("/deactivate", async (req, res, next) => {
  try {
    const parsed = clientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        details: parsed.error.flatten()
      });
      return;
    }

    const result = await deactivateLicense({
      licenseKey: parsed.data.license_key,
      product: parsed.data.product,
      siteUrl: parsed.data.site_url,
      instanceId: parsed.data.instance_id,
      pluginVersion: parsed.data.version
    });

    if (!result.ok) {
      res.status(errorStatus(result.reason)).json({
        valid: false,
        status: result.reason
      });
      return;
    }

    res.json({
      success: true,
      status: "deactivated",
      already_deactivated: result.alreadyDeactivated
    });
  } catch (error) {
    next(error);
  }
});

export { router as licenseRouter };
