import type { Subscription } from "@prisma/client";

export type EffectiveSubscriptionStatus =
  | "active"
  | "trialing"
  | "complimentary"
  | "past_due"
  | "canceled"
  | "expired"
  | "suspended";

export function effectiveSubscriptionStatus(subscription: Subscription): EffectiveSubscriptionStatus {
  if (subscription.status === "SUSPENDED") return "suspended";
  if (subscription.status === "CANCELED") return "canceled";
  if (subscription.status === "EXPIRED") return "expired";
  if (subscription.status === "PAST_DUE") return "past_due";

  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() <= Date.now()) {
    return "expired";
  }

  if (subscription.status === "COMPLIMENTARY") return "complimentary";
  if (subscription.status === "TRIALING") return "trialing";
  return "active";
}

export function subscriptionIsEntitled(subscription: Subscription) {
  return ["active", "trialing", "complimentary"].includes(effectiveSubscriptionStatus(subscription));
}
