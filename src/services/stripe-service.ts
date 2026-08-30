import crypto from "node:crypto";
import type { SubscriptionStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { generateLicenseKey, hashLicenseKey } from "../utils/license-key.js";
import { writeAudit } from "./audit-service.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 300;

type StripeObject = Record<string, any>;

function asId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof (value as any).id === "string") return (value as any).id;
  return null;
}

function asDateFromUnix(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

async function stripeRequest(path: string, init?: RequestInit): Promise<StripeObject> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
      ...(init?.headers ?? {})
    }
  });

  const data = (await response.json()) as StripeObject;
  if (!response.ok) {
    const message = data?.error?.message || `Stripe request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export async function createCheckoutSession(input: {
  planId: string;
  customerEmail?: string;
  customerName?: string;
  successUrl: string;
  cancelUrl: string;
}) {
  const plan = await prisma.plan.findUnique({ where: { id: input.planId }, include: { product: true } });
  if (!plan || !plan.active || !plan.product.active) throw new Error("Plan is not available.");
  if (!plan.stripePriceId) throw new Error("Plan does not have a Stripe Price ID.");

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", plan.stripePriceId);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);
  params.set("allow_promotion_codes", "true");
  params.set("billing_address_collection", "auto");
  params.set("metadata[rwexec_plan_id]", plan.id);
  params.set("subscription_data[metadata][rwexec_plan_id]", plan.id);
  params.set("subscription_data[metadata][rwexec_product_slug]", plan.product.slug);
  if (input.customerEmail) params.set("customer_email", input.customerEmail);
  if (input.customerName) params.set("metadata[rwexec_customer_name]", input.customerName);

  return stripeRequest("/checkout/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
}

export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined) {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestampPart || signatures.length === 0) return false;

  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const payload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", config.STRIPE_WEBHOOK_SECRET).update(payload).digest("hex");

  return signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  });
}

function mapStripeSubscriptionStatus(status: string | undefined): SubscriptionStatus {
  switch (status) {
    case "active": return "ACTIVE";
    case "trialing": return "TRIALING";
    case "past_due":
    case "unpaid":
    case "incomplete": return "PAST_DUE";
    case "incomplete_expired": return "EXPIRED";
    case "paused": return "SUSPENDED";
    case "canceled": return "CANCELED";
    default: return "PAST_DUE";
  }
}

function stripePriceId(subscription: StripeObject): string | null {
  return asId(subscription?.items?.data?.[0]?.price);
}

function stripeCurrentPeriodEnd(subscription: StripeObject): Date | null {
  return asDateFromUnix(subscription.current_period_end)
    ?? asDateFromUnix(subscription?.items?.data?.[0]?.current_period_end)
    ?? null;
}

async function loadStripeCustomer(customerId: string): Promise<StripeObject> {
  return stripeRequest(`/customers/${encodeURIComponent(customerId)}`);
}

async function ensureCustomer(customerId: string, fallback?: StripeObject) {
  const existingSubscription = await prisma.subscription.findFirst({
    where: { externalProvider: "stripe", externalCustomerId: customerId },
    include: { customer: true }
  });
  if (existingSubscription) return existingSubscription.customer;

  const stripeCustomer = fallback?.email ? fallback : await loadStripeCustomer(customerId);
  const email = typeof stripeCustomer.email === "string" ? stripeCustomer.email.trim().toLowerCase() : "";
  if (!email) throw new Error(`Stripe customer ${customerId} has no email address.`);
  const name = typeof stripeCustomer.name === "string" && stripeCustomer.name.trim() ? stripeCustomer.name.trim() : null;

  return prisma.customer.upsert({
    where: { email },
    update: { name: name ?? undefined },
    create: { email, name }
  });
}

async function ensureSubscriptionLicence(subscriptionId: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { product: true, licenses: true, customer: true }
  });
  if (!subscription || subscription.licenses.length > 0) return null;
  if (!["ACTIVE", "TRIALING"].includes(subscription.status)) return null;

  let rawKey = "";
  let keyHash = "";
  for (let i = 0; i < 5; i += 1) {
    rawKey = generateLicenseKey(subscription.product.slug);
    keyHash = hashLicenseKey(rawKey);
    const existing = await prisma.license.findUnique({ where: { keyHash } });
    if (!existing) break;
    rawKey = "";
    keyHash = "";
  }
  if (!rawKey || !keyHash) throw new Error("Could not generate a unique licence key.");

  const licence = await prisma.license.create({
    data: {
      keyHash,
      keyLastFour: rawKey.slice(-4),
      productId: subscription.productId,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      activationLimit: 1
    }
  });

  await writeAudit({
    action: "license.stripe_auto_created",
    entityType: "license",
    entityId: licence.id,
    summary: `Licence automatically created for Stripe subscription (${subscription.customer.email})`,
    metadata: { subscriptionId: subscription.id, keyLastFour: licence.keyLastFour }
  });

  // The raw key is intentionally not persisted. It can be regenerated from the admin UI for delivery.
  return licence;
}

export async function syncStripeSubscription(subscriptionObject: StripeObject) {
  const externalSubscriptionId = asId(subscriptionObject.id);
  const externalCustomerId = asId(subscriptionObject.customer);
  const priceId = stripePriceId(subscriptionObject);
  if (!externalSubscriptionId || !externalCustomerId || !priceId) {
    throw new Error("Stripe subscription payload is missing subscription, customer or price information.");
  }

  const plan = await prisma.plan.findUnique({ where: { stripePriceId: priceId }, include: { product: true } });
  if (!plan) {
    await writeAudit({
      action: "stripe.subscription_ignored",
      entityType: "stripe_subscription",
      entityId: externalSubscriptionId,
      summary: `Stripe subscription ignored because price ${priceId} is not mapped to an RWExec plan.`
    });
    return null;
  }

  const customer = await ensureCustomer(externalCustomerId);
  const status = mapStripeSubscriptionStatus(subscriptionObject.status);
  const currentPeriodEnd = stripeCurrentPeriodEnd(subscriptionObject);
  const cancelAtPeriodEnd = Boolean(subscriptionObject.cancel_at_period_end);

  const subscription = await prisma.subscription.upsert({
    where: { externalSubscriptionId },
    update: {
      customerId: customer.id,
      productId: plan.productId,
      planId: plan.id,
      status,
      complimentary: false,
      externalProvider: "stripe",
      externalCustomerId,
      currentPeriodEnd,
      cancelAtPeriodEnd
    },
    create: {
      customerId: customer.id,
      productId: plan.productId,
      planId: plan.id,
      status,
      complimentary: false,
      externalProvider: "stripe",
      externalCustomerId,
      externalSubscriptionId,
      currentPeriodEnd,
      cancelAtPeriodEnd
    }
  });

  await ensureSubscriptionLicence(subscription.id);
  return subscription;
}

export async function fetchAndSyncStripeSubscription(subscriptionId: string) {
  const object = await stripeRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  return syncStripeSubscription(object);
}

function subscriptionIdFromInvoice(invoice: StripeObject): string | null {
  return asId(invoice.subscription)
    ?? asId(invoice?.parent?.subscription_details?.subscription)
    ?? asId(invoice?.lines?.data?.find?.((line: StripeObject) => line?.parent?.subscription_item_details)?.parent?.subscription_item_details?.subscription)
    ?? null;
}

export async function processStripeEvent(event: StripeObject) {
  const type = String(event.type || "");
  const object = event?.data?.object as StripeObject | undefined;
  if (!object) return { processed: false, reason: "missing_object" };

  switch (type) {
    case "checkout.session.completed": {
      if (object.mode !== "subscription") return { processed: false, reason: "not_subscription_checkout" };
      const subscriptionId = asId(object.subscription);
      if (!subscriptionId) return { processed: false, reason: "missing_subscription" };
      await fetchAndSyncStripeSubscription(subscriptionId);
      return { processed: true };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncStripeSubscription(object);
      return { processed: true };
    case "invoice.paid":
    case "invoice.payment_failed": {
      const subscriptionId = subscriptionIdFromInvoice(object);
      if (!subscriptionId) return { processed: false, reason: "missing_subscription" };
      await fetchAndSyncStripeSubscription(subscriptionId);
      return { processed: true };
    }
    default:
      return { processed: false, reason: "event_not_used" };
  }
}
