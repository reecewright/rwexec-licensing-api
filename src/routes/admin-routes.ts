import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAdminApiKey } from "../middleware/admin-auth.js";
import { generateLicenseKey, hashLicenseKey } from "../utils/license-key.js";
import { writeAudit } from "../services/audit-service.js";

const router = Router();
router.use(requireAdminApiKey);

const createLicenseSchema = z.object({
  product: z.string().min(2).max(100),
  customer_email: z.email().optional(),
  customer_name: z.string().trim().max(200).optional(),
  activation_limit: z.coerce.number().int().min(1).max(1000).default(1),
  expires_at: z.iso.datetime().nullable().optional()
});

router.get("/dashboard", async (_req, res, next) => {
  try {
    const [customers, products, subscriptions, licenses] = await Promise.all([
      prisma.customer.count(),
      prisma.product.count({ where: { active: true } }),
      prisma.subscription.count({ where: { status: { in: ["ACTIVE", "TRIALING", "COMPLIMENTARY"] } } }),
      prisma.license.count({ where: { status: "ACTIVE" } })
    ]);
    res.json({ customers, products, active_subscriptions: subscriptions, active_licenses: licenses });
  } catch (error) { next(error); }
});

router.get("/products", async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { name: "asc" }, include: { plans: { include: { entitlements: true } } } });
    res.json(products);
  } catch (error) { next(error); }
});

router.post("/products", async (req, res, next) => {
  try {
    const parsed = z.object({ slug: z.string().min(2).max(100), name: z.string().min(2).max(200), description: z.string().max(1000).nullable().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    const product = await prisma.product.create({ data: { slug: parsed.data.slug, name: parsed.data.name, description: parsed.data.description ?? null } });
    res.status(201).json(product);
  } catch (error) { next(error); }
});

router.get("/customers", async (_req, res, next) => {
  try {
    const customers = await prisma.customer.findMany({ orderBy: { createdAt: "desc" }, include: { subscriptions: { include: { product: true, plan: true } }, licenses: { include: { product: true } } } });
    res.json(customers);
  } catch (error) { next(error); }
});

const updateCustomerSchema = z.object({
  name: z.string().trim().max(200).nullable().optional(),
  email: z.email().optional(),
  billing_email: z.email().nullable().optional()
});

router.patch("/customers/:id", async (req, res, next) => {
  try {
    const parsed = updateCustomerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    const data: { name?: string | null; email?: string; billingEmail?: string | null } = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.email !== undefined) data.email = parsed.data.email.toLowerCase();
    if (parsed.data.billing_email !== undefined) data.billingEmail = parsed.data.billing_email?.toLowerCase() ?? null;
    const customer = await prisma.customer.update({ where: { id: req.params.id }, data });
    res.json(customer);
  } catch (error) { next(error); }
});

router.get("/plans", async (_req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({ orderBy: { name: "asc" }, include: { product: true, entitlements: true } });
    res.json(plans);
  } catch (error) { next(error); }
});

const createPlanSchema = z.object({
  product: z.string().min(2),
  slug: z.string().min(1).max(100),
  name: z.string().min(2).max(200),
  billing_interval: z.string().max(30).nullable().optional(),
  price_minor: z.coerce.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).default("GBP"),
  entitlements: z.array(z.object({
    key: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    type: z.enum(["boolean", "limit"]),
    enabled: z.boolean().optional(),
    limit: z.coerce.number().int().min(0).optional()
  })).default([])
});

router.post("/plans", async (req, res, next) => {
  try {
    const parsed = createPlanSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    const product = await prisma.product.findUnique({ where: { slug: parsed.data.product } });
    if (!product) return res.status(404).json({ error: "product_not_found" });
    const plan = await prisma.plan.create({ data: {
      productId: product.id,
      slug: parsed.data.slug,
      name: parsed.data.name,
      billingInterval: parsed.data.billing_interval ?? null,
      priceMinor: parsed.data.price_minor ?? null,
      currency: parsed.data.currency.toUpperCase(),
      entitlements: { create: parsed.data.entitlements.map(e => ({ key: e.key, label: e.label, type: e.type === "limit" ? "LIMIT" : "BOOLEAN", enabled: e.type === "boolean" ? (e.enabled ?? true) : null, limit: e.type === "limit" ? (e.limit ?? 0) : null })) }
    }, include: { entitlements: true, product: true } });
    res.status(201).json(plan);
  } catch (error) { next(error); }
});

router.get("/subscriptions", async (_req, res, next) => {
  try {
    const subscriptions = await prisma.subscription.findMany({ orderBy: { createdAt: "desc" }, include: { customer: true, product: true, plan: { include: { entitlements: true } }, usage: true } });
    res.json(subscriptions);
  } catch (error) { next(error); }
});

const createSubscriptionSchema = z.object({
  customer_email: z.email(),
  customer_name: z.string().trim().max(200).optional(),
  billing_email: z.email().nullable().optional(),
  product: z.string().min(2),
  plan: z.string().min(1).nullable().optional(),
  complimentary: z.boolean().default(false),
  current_period_end: z.iso.datetime().nullable().optional(),
  external_provider: z.string().max(50).nullable().optional(),
  external_customer_id: z.string().max(200).nullable().optional(),
  external_subscription_id: z.string().max(200).nullable().optional()
});

router.post("/subscriptions", async (req, res, next) => {
  try {
    const parsed = createSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    const product = await prisma.product.findUnique({ where: { slug: parsed.data.product } });
    if (!product) return res.status(404).json({ error: "product_not_found" });
    const customer = await prisma.customer.upsert({ where: { email: parsed.data.customer_email.toLowerCase() }, update: { name: parsed.data.customer_name, ...(parsed.data.billing_email !== undefined ? { billingEmail: parsed.data.billing_email?.toLowerCase() ?? null } : {}) }, create: { email: parsed.data.customer_email.toLowerCase(), name: parsed.data.customer_name, billingEmail: parsed.data.billing_email?.toLowerCase() ?? null } });
    let planId: string | null = null;
    if (parsed.data.plan) {
      const plan = await prisma.plan.findUnique({ where: { productId_slug: { productId: product.id, slug: parsed.data.plan } } });
      if (!plan) return res.status(404).json({ error: "plan_not_found" });
      planId = plan.id;
    }
    const subscription = await prisma.subscription.create({ data: {
      customerId: customer.id,
      productId: product.id,
      planId,
      status: parsed.data.complimentary ? "COMPLIMENTARY" : "ACTIVE",
      complimentary: parsed.data.complimentary,
      currentPeriodEnd: parsed.data.current_period_end ? new Date(parsed.data.current_period_end) : null,
      externalProvider: parsed.data.external_provider ?? null,
      externalCustomerId: parsed.data.external_customer_id ?? null,
      externalSubscriptionId: parsed.data.external_subscription_id ?? null
    }, include: { customer: true, product: true, plan: { include: { entitlements: true } } } });
    res.status(201).json(subscription);
  } catch (error) { next(error); }
});

router.post("/licenses", async (req, res, next) => {
  try {
    const parsed = createLicenseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const product = await prisma.product.findUnique({ where: { slug: parsed.data.product } });
    if (!product) return res.status(404).json({ error: "product_not_found" });
    let customerId: string | null = null;
    if (parsed.data.customer_email) {
      const customer = await prisma.customer.upsert({
        where: { email: parsed.data.customer_email.toLowerCase() },
        update: { name: parsed.data.customer_name },
        create: { email: parsed.data.customer_email.toLowerCase(), name: parsed.data.customer_name }
      });
      customerId = customer.id;
    }
    let rawKey = ""; let keyHash = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      rawKey = generateLicenseKey(product.slug); keyHash = hashLicenseKey(rawKey);
      if (!(await prisma.license.findUnique({ where: { keyHash } }))) break;
      rawKey = ""; keyHash = "";
    }
    if (!rawKey || !keyHash) throw new Error("Could not generate a unique licence key.");
    const license = await prisma.license.create({ data: {
      keyHash, keyLastFour: rawKey.slice(-4), status: "ACTIVE",
      activationLimit: parsed.data.activation_limit,
      expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
      productId: product.id, customerId
    } });
    res.status(201).json({ id: license.id, license_key: rawKey, product: product.slug, status: "active", activation_limit: license.activationLimit, expires_at: license.expiresAt?.toISOString() ?? null, note: "This is the only response containing the full raw licence key." });
  } catch (error) { next(error); }
});

router.get("/licenses", async (_req, res, next) => {
  try {
    const licenses = await prisma.license.findMany({ orderBy: { createdAt: "desc" }, include: { product: true, customer: true, activations: true } });
    res.json(licenses.map(license => ({
      id: license.id,
      key_last_four: license.keyLastFour,
      status: license.status.toLowerCase(),
      activation_limit: license.activationLimit,
      active_activations: license.activations.filter(a => !a.deactivatedAt).length,
      expires_at: license.expiresAt?.toISOString() ?? null,
      product: { slug: license.product.slug, name: license.product.name },
      customer: license.customer ? { id: license.customer.id, name: license.customer.name, email: license.customer.email } : null
    })));
  } catch (error) { next(error); }
});

router.get("/licenses/:id", async (req, res, next) => {
  try {
    const license = await prisma.license.findUnique({ where: { id: req.params.id }, include: { product: true, customer: true, activations: true } });
    if (!license) return res.status(404).json({ error: "license_not_found" });
    res.json({ id: license.id, key_last_four: license.keyLastFour, status: license.status.toLowerCase(), activation_limit: license.activationLimit, expires_at: license.expiresAt?.toISOString() ?? null, product: { slug: license.product.slug, name: license.product.name }, customer: license.customer ? { id: license.customer.id, name: license.customer.name, email: license.customer.email } : null, activations: license.activations.map(a => ({ id: a.id, site_url: a.siteUrl, instance_id: a.instanceId, plugin_version: a.pluginVersion, activated_at: a.activatedAt.toISOString(), last_checked_at: a.lastCheckedAt.toISOString(), deactivated_at: a.deactivatedAt?.toISOString() ?? null })) });
  } catch (error) { next(error); }
});


router.patch("/subscriptions/:id", async (req, res, next) => {
  try {
    const parsed = z.object({
      status: z.enum(["ACTIVE", "TRIALING", "PAST_DUE", "CANCELED", "EXPIRED", "SUSPENDED", "COMPLIMENTARY"]).optional(),
      complimentary: z.boolean().optional(),
      plan_id: z.string().nullable().optional(),
      current_period_end: z.iso.datetime().nullable().optional(),
      cancel_at_period_end: z.boolean().optional(),
      external_provider: z.string().max(50).nullable().optional(),
      external_customer_id: z.string().max(200).nullable().optional(),
      external_subscription_id: z.string().max(200).nullable().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    const subscription = await prisma.subscription.findUnique({ where: { id: req.params.id } });
    if (!subscription) return res.status(404).json({ error: "subscription_not_found" });
    if (parsed.data.plan_id) {
      const plan = await prisma.plan.findUnique({ where: { id: parsed.data.plan_id } });
      if (!plan || plan.productId !== subscription.productId) return res.status(400).json({ error: "plan_product_mismatch" });
    }
    const updated = await prisma.subscription.update({ where: { id: subscription.id }, data: {
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.complimentary !== undefined ? { complimentary: parsed.data.complimentary } : {}),
      ...(parsed.data.plan_id !== undefined ? { planId: parsed.data.plan_id } : {}),
      ...(parsed.data.current_period_end !== undefined ? { currentPeriodEnd: parsed.data.current_period_end ? new Date(parsed.data.current_period_end) : null } : {}),
      ...(parsed.data.cancel_at_period_end !== undefined ? { cancelAtPeriodEnd: parsed.data.cancel_at_period_end } : {}),
      ...(parsed.data.external_provider !== undefined ? { externalProvider: parsed.data.external_provider } : {}),
      ...(parsed.data.external_customer_id !== undefined ? { externalCustomerId: parsed.data.external_customer_id } : {}),
      ...(parsed.data.external_subscription_id !== undefined ? { externalSubscriptionId: parsed.data.external_subscription_id } : {})
    }, include: { customer: true, product: true, plan: true } });
    await writeAudit({ action: "subscription.api_updated", entityType: "subscription", entityId: updated.id, summary: `Subscription updated via admin API for ${updated.customer.name || updated.customer.email}` });
    res.json(updated);
  } catch (error) { next(error); }
});

router.post("/licenses/from-subscription", async (req, res, next) => {
  try {
    const parsed = z.object({
      subscription_id: z.string().min(1),
      activation_limit: z.coerce.number().int().min(1).max(1000).default(1),
      expires_at: z.iso.datetime().nullable().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    const subscription = await prisma.subscription.findUnique({ where: { id: parsed.data.subscription_id }, include: { customer: true, product: true } });
    if (!subscription || !["ACTIVE", "TRIALING", "COMPLIMENTARY"].includes(subscription.status)) return res.status(400).json({ error: "subscription_not_entitled" });
    let rawKey = ""; let keyHash = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      rawKey = generateLicenseKey(subscription.product.slug); keyHash = hashLicenseKey(rawKey);
      if (!(await prisma.license.findUnique({ where: { keyHash } }))) break;
      rawKey = ""; keyHash = "";
    }
    if (!rawKey || !keyHash) throw new Error("Could not generate a unique licence key.");
    const licence = await prisma.license.create({ data: { keyHash, keyLastFour: rawKey.slice(-4), productId: subscription.productId, customerId: subscription.customerId, subscriptionId: subscription.id, activationLimit: parsed.data.activation_limit, expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null } });
    await writeAudit({ action: "license.api_created", entityType: "license", entityId: licence.id, summary: `Licence created from subscription for ${subscription.customer.name || subscription.customer.email}`, metadata: { subscriptionId: subscription.id } });
    res.status(201).json({ id: licence.id, license_key: rawKey, key_last_four: licence.keyLastFour, status: "active", activation_limit: licence.activationLimit, expires_at: licence.expiresAt?.toISOString() ?? null, subscription_id: subscription.id, note: "This is the only response containing the full raw licence key." });
  } catch (error) { next(error); }
});

router.patch("/licenses/:id", async (req, res, next) => {
  try {
    const parsed = z.object({
      status: z.enum(["ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED"]).optional(),
      activation_limit: z.coerce.number().int().min(1).max(1000).optional(),
      expires_at: z.iso.datetime().nullable().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    const licence = await prisma.license.update({ where: { id: req.params.id }, data: {
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.activation_limit !== undefined ? { activationLimit: parsed.data.activation_limit } : {}),
      ...(parsed.data.expires_at !== undefined ? { expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null } : {})
    } });
    await writeAudit({ action: "license.api_updated", entityType: "license", entityId: licence.id, summary: `Licence •••• ${licence.keyLastFour} updated via admin API` });
    res.json(licence);
  } catch (error) { next(error); }
});

router.post("/licenses/:id/reset-activations", async (req, res, next) => {
  try {
    const licence = await prisma.license.findUnique({ where: { id: req.params.id } });
    if (!licence) return res.status(404).json({ error: "license_not_found" });
    const result = await prisma.activation.updateMany({ where: { licenseId: licence.id, deactivatedAt: null }, data: { deactivatedAt: new Date(), lastCheckedAt: new Date() } });
    await writeAudit({ action: "license.activations_reset", entityType: "license", entityId: licence.id, summary: `Reset ${result.count} active licence activation(s)` });
    res.json({ success: true, deactivated: result.count });
  } catch (error) { next(error); }
});

router.post("/licenses/:id/regenerate", async (req, res, next) => {
  try {
    const licence = await prisma.license.findUnique({ where: { id: req.params.id }, include: { product: true } });
    if (!licence) return res.status(404).json({ error: "license_not_found" });
    let rawKey = ""; let keyHash = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      rawKey = generateLicenseKey(licence.product.slug); keyHash = hashLicenseKey(rawKey);
      if (!(await prisma.license.findUnique({ where: { keyHash } }))) break;
      rawKey = ""; keyHash = "";
    }
    if (!rawKey || !keyHash) throw new Error("Could not generate a unique licence key.");
    const updated = await prisma.license.update({ where: { id: licence.id }, data: { keyHash, keyLastFour: rawKey.slice(-4) } });
    await writeAudit({ action: "license.regenerated", entityType: "license", entityId: licence.id, summary: `Licence key regenerated for •••• ${licence.keyLastFour}` });
    res.json({ id: updated.id, license_key: rawKey, key_last_four: updated.keyLastFour, note: "This is the only response containing the full replacement key." });
  } catch (error) { next(error); }
});

router.get("/audit", async (_req, res, next) => {
  try {
    const events = await prisma.auditLog.findMany({ take: 200, orderBy: { createdAt: "desc" } });
    res.json(events);
  } catch (error) { next(error); }
});

export { router as adminRouter };
