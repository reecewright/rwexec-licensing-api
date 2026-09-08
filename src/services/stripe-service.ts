import crypto from "node:crypto";
import type { SubscriptionStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { generateLicenseKey, hashLicenseKey } from "../utils/license-key.js";
import { writeAudit } from "./audit-service.js";
import { storeLicenceDelivery } from "./customer-portal-service.js";
import {
  customerEmailConfigured,
  sendCustomerPortalEmail,
} from "./email-service.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 300;

type StripeObject = Record<string, any>;

function asId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as any).id === "string"
  )
    return (value as any).id;
  return null;
}

function asDateFromUnix(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000)
    : null;
}

async function stripeRequest(
  path: string,
  init?: RequestInit,
): Promise<StripeObject> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
      ...(init?.headers ?? {}),
    },
  });

  const data = (await response.json()) as StripeObject;
  if (!response.ok) {
    const message =
      data?.error?.message || `Stripe request failed (${response.status})`;
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
  const plan = await prisma.plan.findUnique({
    where: { id: input.planId },
    include: { product: true },
  });
  if (!plan || !plan.active || !plan.product.active)
    throw new Error("Plan is not available.");
  if (!plan.stripePriceId)
    throw new Error("Plan does not have a Stripe Price ID.");

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
  params.set(
    "subscription_data[metadata][rwexec_product_slug]",
    plan.product.slug,
  );
  if (input.customerEmail) params.set("customer_email", input.customerEmail);
  if (input.customerName)
    params.set("metadata[rwexec_customer_name]", input.customerName);

  return stripeRequest("/checkout/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

export async function retrieveCheckoutSession(sessionId: string) {
  return stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

export async function createBillingPortalSession(input: {
  customerId: string;
  returnUrl: string;
}) {
  const params = new URLSearchParams();
  params.set("customer", input.customerId);
  params.set("return_url", input.returnUrl);

  return stripeRequest("/billing_portal/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

async function createBillingPortalFlowSession(input: {
  customerId: string;
  returnUrl: string;
  params: URLSearchParams;
}) {
  input.params.set("customer", input.customerId);
  input.params.set("return_url", input.returnUrl);
  input.params.set("flow_data[after_completion][type]", "redirect");
  input.params.set(
    "flow_data[after_completion][redirect][return_url]",
    input.returnUrl,
  );

  return stripeRequest("/billing_portal/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: input.params.toString(),
  });
}

export async function createPaymentMethodPortalSession(input: {
  customerId: string;
  returnUrl: string;
}) {
  const params = new URLSearchParams();
  params.set("flow_data[type]", "payment_method_update");

  return createBillingPortalFlowSession({ ...input, params });
}

export async function createSubscriptionCancelPortalSession(input: {
  customerId: string;
  subscriptionId: string;
  returnUrl: string;
}) {
  const params = new URLSearchParams();
  params.set("flow_data[type]", "subscription_cancel");
  params.set(
    "flow_data[subscription_cancel][subscription]",
    input.subscriptionId,
  );

  return createBillingPortalFlowSession({ ...input, params });
}

export async function createSubscriptionUpdateConfirmPortalSession(input: {
  customerId: string;
  subscriptionId: string;
  targetPriceId: string;
  returnUrl: string;
}) {
  const subscription = await stripeRequest(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
  );
  const itemId = asId(subscription?.items?.data?.[0]?.id);

  if (!itemId) {
    throw new Error("Stripe subscription does not contain an updatable item.");
  }

  const params = new URLSearchParams();
  params.set("flow_data[type]", "subscription_update_confirm");
  params.set(
    "flow_data[subscription_update_confirm][subscription]",
    input.subscriptionId,
  );
  params.set(
    "flow_data[subscription_update_confirm][items][0][id]",
    itemId,
  );
  params.set(
    "flow_data[subscription_update_confirm][items][0][price]",
    input.targetPriceId,
  );
  params.set(
    "flow_data[subscription_update_confirm][items][0][quantity]",
    "1",
  );

  return createBillingPortalFlowSession({ ...input, params });
}

export async function scheduleStripeSubscriptionPlanChange(input: {
  subscriptionId: string;
  targetPriceId: string;
  targetBillingInterval: "month" | "year";
}) {
  const subscription = await stripeRequest(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
  );

  const currentItem = subscription?.items?.data?.[0] as
    | StripeObject
    | undefined;
  const currentPriceId = asId(currentItem?.price);
  const quantity =
    typeof currentItem?.quantity === "number" && currentItem.quantity > 0
      ? currentItem.quantity
      : 1;

  if (!currentPriceId) {
    throw new Error("Stripe subscription does not contain a current price.");
  }

  if (currentPriceId === input.targetPriceId) {
    throw new Error("The subscription is already on that price.");
  }

  const existingScheduleId = asId(subscription.schedule);
  let schedule: StripeObject;
  let scheduleId: string;
  let createdNewSchedule = false;

  if (existingScheduleId) {
    schedule = await stripeRequest(
      `/subscription_schedules/${encodeURIComponent(existingScheduleId)}`,
    );
    scheduleId = existingScheduleId;

    const scheduleMetadataManaged =
      String(schedule?.metadata?.rwexec_managed_plan_change ?? "") === "1";
    const phaseMetadataManaged = Array.isArray(schedule?.phases)
      ? schedule.phases.some(
          (phase: StripeObject) =>
            String(phase?.metadata?.rwexec_scheduled_plan_change ?? "") === "1",
        )
      : false;

    if (!scheduleMetadataManaged && !phaseMetadataManaged) {
      throw new Error(
        "This subscription already has a Stripe schedule that was not created by RWExec, so it cannot be replaced automatically.",
      );
    }
  } else {
    const createParams = new URLSearchParams();
    createParams.set("from_subscription", input.subscriptionId);

    schedule = await stripeRequest("/subscription_schedules", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createParams.toString(),
    });

    const createdScheduleId = asId(schedule.id);
    if (!createdScheduleId) {
      throw new Error("Stripe did not return a subscription schedule ID.");
    }

    scheduleId = createdScheduleId;
    createdNewSchedule = true;
  }

  const currentPhase = schedule?.current_phase as StripeObject | undefined;
  const currentPhaseStart =
    typeof currentPhase?.start_date === "number"
      ? currentPhase.start_date
      : (schedule?.phases?.[0] as StripeObject | undefined)?.start_date;
  const currentPhaseEnd =
    typeof currentPhase?.end_date === "number"
      ? currentPhase.end_date
      : (schedule?.phases?.[0] as StripeObject | undefined)?.end_date;

  if (
    typeof currentPhaseStart !== "number" ||
    typeof currentPhaseEnd !== "number"
  ) {
    if (createdNewSchedule) {
      try {
        await stripeRequest(
          `/subscription_schedules/${encodeURIComponent(scheduleId)}/release`,
          { method: "POST" },
        );
      } catch {
        // Preserve the original error below.
      }
    }

    throw new Error(
      "Stripe did not return the current schedule phase needed to defer this plan change.",
    );
  }

  const updateParams = new URLSearchParams();
  updateParams.set("end_behavior", "release");
  updateParams.set("proration_behavior", "none");
  updateParams.set("metadata[rwexec_managed_plan_change]", "1");

  updateParams.set("phases[0][items][0][price]", currentPriceId);
  updateParams.set("phases[0][items][0][quantity]", String(quantity));
  updateParams.set("phases[0][start_date]", String(currentPhaseStart));
  updateParams.set("phases[0][end_date]", String(currentPhaseEnd));
  updateParams.set("phases[0][proration_behavior]", "none");

  updateParams.set("phases[1][items][0][price]", input.targetPriceId);
  updateParams.set("phases[1][items][0][quantity]", String(quantity));
  updateParams.set(
    "phases[1][duration][interval]",
    input.targetBillingInterval,
  );
  updateParams.set("phases[1][duration][interval_count]", "1");
  updateParams.set("phases[1][proration_behavior]", "none");
  updateParams.set("phases[1][metadata][rwexec_scheduled_plan_change]", "1");

  try {
    const updatedSchedule = await stripeRequest(
      `/subscription_schedules/${encodeURIComponent(scheduleId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: updateParams.toString(),
      },
    );

    await writeAudit({
      action: existingScheduleId
        ? "stripe.subscription_plan_change_rescheduled"
        : "stripe.subscription_plan_change_scheduled",
      entityType: "stripe_subscription",
      entityId: input.subscriptionId,
      summary: existingScheduleId
        ? "Existing RWExec Stripe subscription plan change replaced"
        : "Stripe subscription plan change scheduled for the next billing period",
      metadata: {
        scheduleId,
        currentPriceId,
        targetPriceId: input.targetPriceId,
        effectiveAt: new Date(currentPhaseEnd * 1000).toISOString(),
      },
    });

    return updatedSchedule;
  } catch (error) {
    if (createdNewSchedule) {
      try {
        await stripeRequest(
          `/subscription_schedules/${encodeURIComponent(scheduleId)}/release`,
          { method: "POST" },
        );
      } catch (releaseError) {
        console.error(
          "Could not release Stripe schedule after failed plan-change setup:",
          releaseError,
        );
      }
    }

    throw error;
  }
}

export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
) {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  if (!timestampPart || signatures.length === 0) return false;

  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestamp)) return false;
  if (
    Math.abs(Math.floor(Date.now() / 1000) - timestamp) >
    WEBHOOK_TOLERANCE_SECONDS
  )
    return false;

  const payload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", config.STRIPE_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  return signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex"),
    );
  });
}

function mapStripeSubscriptionStatus(
  status: string | undefined,
): SubscriptionStatus {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "PAST_DUE";
    case "incomplete_expired":
      return "EXPIRED";
    case "paused":
      return "SUSPENDED";
    case "canceled":
      return "CANCELED";
    default:
      return "PAST_DUE";
  }
}

function stripePriceId(subscription: StripeObject): string | null {
  return asId(subscription?.items?.data?.[0]?.price);
}

function stripeCurrentPeriodEnd(subscription: StripeObject): Date | null {
  return (
    asDateFromUnix(subscription.current_period_end) ??
    asDateFromUnix(subscription?.items?.data?.[0]?.current_period_end) ??
    null
  );
}

async function loadStripeCustomer(customerId: string): Promise<StripeObject> {
  return stripeRequest(`/customers/${encodeURIComponent(customerId)}`);
}

async function ensureCustomer(customerId: string, fallback?: StripeObject) {
  const existingSubscription = await prisma.subscription.findFirst({
    where: { externalProvider: "stripe", externalCustomerId: customerId },
    include: { customer: true },
  });
  if (existingSubscription) return existingSubscription.customer;

  const stripeCustomer = fallback?.email
    ? fallback
    : await loadStripeCustomer(customerId);
  const email =
    typeof stripeCustomer.email === "string"
      ? stripeCustomer.email.trim().toLowerCase()
      : "";
  if (!email)
    throw new Error(`Stripe customer ${customerId} has no email address.`);
  const name =
    typeof stripeCustomer.name === "string" && stripeCustomer.name.trim()
      ? stripeCustomer.name.trim()
      : null;

  return prisma.customer.upsert({
    where: { email },
    update: { name: name ?? undefined },
    create: { email, name },
  });
}

function planActivationLimit(
  entitlements: Array<{
    key: string;
    type: string;
    limit: number | null;
  }>,
): number | null {
  const entitlement = entitlements.find(
    (item) => item.key === "site_activations" && item.type === "LIMIT",
  );

  if (
    !entitlement ||
    typeof entitlement.limit !== "number" ||
    !Number.isInteger(entitlement.limit) ||
    entitlement.limit < 1
  ) {
    return null;
  }

  return entitlement.limit;
}

async function ensureSubscriptionLicence(subscriptionId: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      product: true,
      licenses: true,
      customer: true,
      plan: {
        include: {
          entitlements: true,
        },
      },
    },
  });

  if (!subscription) return null;

  const configuredActivationLimit = planActivationLimit(
    subscription.plan?.entitlements ?? [],
  );

  if (subscription.licenses.length > 0) {
    if (configuredActivationLimit !== null) {
      for (const licence of subscription.licenses) {
        if (licence.activationLimit === configuredActivationLimit) continue;

        const previousActivationLimit = licence.activationLimit;

        await prisma.license.update({
          where: { id: licence.id },
          data: { activationLimit: configuredActivationLimit },
        });

        await writeAudit({
          action: "license.activation_limit_synced",
          entityType: "license",
          entityId: licence.id,
          summary: `Licence activation limit synced from subscription plan (${previousActivationLimit} → ${configuredActivationLimit})`,
          metadata: {
            subscriptionId: subscription.id,
            planId: subscription.planId,
            previousActivationLimit,
            activationLimit: configuredActivationLimit,
          },
        });
      }
    }

    return subscription.licenses[0];
  }

  if (!["ACTIVE", "TRIALING"].includes(subscription.status)) return null;

  const activationLimit = configuredActivationLimit ?? 1;

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
  if (!rawKey || !keyHash)
    throw new Error("Could not generate a unique licence key.");

  const licence = await prisma.license.create({
    data: {
      keyHash,
      keyLastFour: rawKey.slice(-4),
      productId: subscription.productId,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      activationLimit,
    },
  });

  await storeLicenceDelivery(licence.id, subscription.customerId, rawKey);

  await writeAudit({
    action: "license.stripe_auto_created",
    entityType: "license",
    entityId: licence.id,
    summary: `Licence automatically created for Stripe subscription (${subscription.customer.email})`,
    metadata: {
      subscriptionId: subscription.id,
      planId: subscription.planId,
      keyLastFour: licence.keyLastFour,
      activationLimit: licence.activationLimit,
      deliveryPrepared: true,
    },
  });

  if (customerEmailConfigured()) {
    try {
      await sendCustomerPortalEmail(subscription.customerId, "licence");
    } catch (error) {
      console.error("Could not send automatic licence delivery email:", error);
      await writeAudit({
        action: "license.delivery_email_failed",
        entityType: "license",
        entityId: licence.id,
        summary: `Automatic licence delivery email failed for ${subscription.customer.email}`,
      });
    }
  }

  return licence;
}

export async function syncStripeSubscription(subscriptionObject: StripeObject) {
  const externalSubscriptionId = asId(subscriptionObject.id);
  const externalCustomerId = asId(subscriptionObject.customer);
  const priceId = stripePriceId(subscriptionObject);
  if (!externalSubscriptionId || !externalCustomerId || !priceId) {
    throw new Error(
      "Stripe subscription payload is missing subscription, customer or price information.",
    );
  }

  const plan = await prisma.plan.findUnique({
    where: { stripePriceId: priceId },
    include: { product: true },
  });
  if (!plan) {
    await writeAudit({
      action: "stripe.subscription_ignored",
      entityType: "stripe_subscription",
      entityId: externalSubscriptionId,
      summary: `Stripe subscription ignored because price ${priceId} is not mapped to an RWExec plan.`,
    });
    return null;
  }

  const customer = await ensureCustomer(externalCustomerId);
  const status = mapStripeSubscriptionStatus(subscriptionObject.status);
  const currentPeriodEnd = stripeCurrentPeriodEnd(subscriptionObject);
  const cancelAtPeriodEnd =
  Boolean(subscriptionObject.cancel_at_period_end) ||
  asDateFromUnix(subscriptionObject.cancel_at) !== null;

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
      cancelAtPeriodEnd,
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
      cancelAtPeriodEnd,
    },
  });

  await ensureSubscriptionLicence(subscription.id);
  return subscription;
}

export async function fetchAndSyncStripeSubscription(subscriptionId: string) {
  const object = await stripeRequest(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
  return syncStripeSubscription(object);
}

function subscriptionIdFromInvoice(invoice: StripeObject): string | null {
  return (
    asId(invoice.subscription) ??
    asId(invoice?.parent?.subscription_details?.subscription) ??
    asId(
      invoice?.lines?.data?.find?.(
        (line: StripeObject) => line?.parent?.subscription_item_details,
      )?.parent?.subscription_item_details?.subscription,
    ) ??
    null
  );
}

export async function processStripeEvent(event: StripeObject) {
  const type = String(event.type || "");
  const object = event?.data?.object as StripeObject | undefined;
  if (!object) return { processed: false, reason: "missing_object" };

  switch (type) {
    case "checkout.session.completed": {
      if (object.mode !== "subscription")
        return { processed: false, reason: "not_subscription_checkout" };
      const subscriptionId = asId(object.subscription);
      if (!subscriptionId)
        return { processed: false, reason: "missing_subscription" };
      await fetchAndSyncStripeSubscription(subscriptionId);
      return { processed: true };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscriptionId = asId(object.id);

      if (!subscriptionId) {
        return {
          processed: false,
          reason: "missing_subscription",
        };
      }

      await fetchAndSyncStripeSubscription(subscriptionId);

      return { processed: true };
    }

    case "customer.subscription.deleted":
      await syncStripeSubscription(object);
      return { processed: true };
    case "invoice.paid":
    case "invoice.payment_failed": {
      const subscriptionId = subscriptionIdFromInvoice(object);
      if (!subscriptionId)
        return { processed: false, reason: "missing_subscription" };
      await fetchAndSyncStripeSubscription(subscriptionId);
      return { processed: true };
    }
    default:
      return { processed: false, reason: "event_not_used" };
  }
}
