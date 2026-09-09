import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import path from "node:path";
import { prisma } from "../db.js";
import { adminCss } from "../admin/styles.js";
import { escapeHtml } from "../admin/html.js";
import {
  revealLicenceKey,
  clearCustomerSession,
  consumePortalMagicLink,
  customerIdFromCookie,
  setCustomerSession,
} from "../services/customer-portal-service.js";
import {
  customerEmailConfigured,
  sendCustomerPortalEmail,
} from "../services/email-service.js";
import {
  cancelStripeSubscriptionPlanChange,
  createCheckoutSession,
  createPaymentMethodPortalSession,
  createSubscriptionCancelPortalSession,
  createSubscriptionUpdateConfirmPortalSession,
  fetchAndSyncStripeSubscription,
  getStripeSubscriptionPlanChange,
  resumeStripeSubscription,
  retrieveCheckoutSession,
  scheduleStripeSubscriptionPlanChange,
  updateStripeCustomerEmail,
} from "../services/stripe-service.js";
import {
  consumeCustomerEmailChangeToken,
  requestCustomerEmailChange,
} from "../services/customer-account-service.js";
import { writeAudit } from "../services/audit-service.js";

export const customerPortalRouter = Router();

const ACCOUNT_HOST = "account.rwexec.com";
const ENTITLED_STATUSES = ["ACTIVE", "TRIALING", "COMPLIMENTARY"];

const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message:
    "Too many sign-in link requests. Please wait a few minutes and try again.",
});

const licenceRevealLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message:
    "Too many licence reveal requests. Please wait a moment and try again.",
});

function requestOrigin(req: Request) {
  const origin = String(req.get("origin") || "").trim();
  if (origin) return origin;
  const referer = String(req.get("referer") || "").trim();
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function expectedOrigin(req: Request) {
  return `${req.protocol || "https"}://${req.get("host") || ACCOUNT_HOST}`;
}

function sameOriginPost(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();

  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();

  // Reject only requests the browser explicitly identifies as cross-site.
  // Same-origin, same-site and direct/none navigations are valid.
  if (fetchSite === "cross-site") {
    return res
      .status(403)
      .send("Request could not be verified. Refresh the page and try again.");
  }

  const origin = requestOrigin(req);

  // Validate Origin/Referer when supplied, but do not require it.
  if (origin && origin !== "null") {
    try {
      const originUrl = new URL(origin);
      if (originUrl.hostname.toLowerCase() !== req.hostname.toLowerCase()) {
        return res
          .status(403)
          .send(
            "Request could not be verified. Refresh the page and try again.",
          );
      }
    } catch {
      return res
        .status(403)
        .send("Request could not be verified. Refresh the page and try again.");
    }
  }

  return next();
}

customerPortalRouter.use(sameOriginPost);

type PortalCustomer = {
  id: string;
  name: string | null;
  companyName: string | null;
  email: string;
};

function isCleanAccountHost(req: Request) {
  return req.hostname === ACCOUNT_HOST;
}

function portalPath(req: Request, pathname = "") {
  const prefix = isCleanAccountHost(req) ? "" : "/account";
  if (!pathname) return prefix || "/";
  const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${prefix}${cleanPath}`;
}

function portalAbsoluteUrl(req: Request, pathname = "") {
  const protocol = req.protocol || "https";
  const host = req.get("host") || ACCOUNT_HOST;
  return `${protocol}://${host}${portalPath(req, pathname)}`;
}

function normaliseCustomerCookiePath(req: Request, res: Response) {
  if (!isCleanAccountHost(req)) return;
  const setCookie = res.getHeader("set-cookie");
  if (!setCookie) return;
  const rewrite = (value: string) =>
    value.replace(/Path=\/account(?=;|$)/gi, "Path=/");
  if (Array.isArray(setCookie)) {
    res.setHeader(
      "set-cookie",
      setCookie.map((value) => rewrite(String(value))),
    );
    return;
  }
  res.setHeader("set-cookie", rewrite(String(setCookie)));
}

function date(value: Date | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(value);
}

function shortDate(value: Date | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(value);
}

function planPrice(plan: {
  priceMinor: number | null;
  billingInterval: string | null;
  currency?: string;
}) {
  if (typeof plan.priceMinor !== "number") return "Custom price";
  const currency = plan.currency || "GBP";
  const amount = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(plan.priceMinor / 100);
  if (plan.billingInterval === "month") return `${amount}/month`;
  if (plan.billingInterval === "year") return `${amount}/year`;
  return amount;
}

function planActivationLimit(
  plan:
    | {
      entitlements?: Array<{
        key: string;
        type: string;
        limit: number | null;
      }>;
    }
    | null
    | undefined,
) {
  const entitlement = plan?.entitlements?.find(
    (item) => item.key === "site_activations" && item.type === "LIMIT",
  );
  return typeof entitlement?.limit === "number" && entitlement.limit > 0
    ? entitlement.limit
    : null;
}

function statusClass(status: string) {
  const value = status.toLowerCase();
  if (["active", "trialing", "complimentary"].includes(value)) return "good";
  if (["past_due", "suspended"].includes(value)) return "warn";
  return "bad";
}

function subscriptionDisplayName(subscription: {
  label: string | null;
  product: { name: string; };
  plan: { name: string; } | null;
}) {
  return subscription.label?.trim() || subscription.product.name;
}

type SubscriptionLifecycle = "active" | "ending" | "expired" | "attention";

function subscriptionLifecycle(subscription: {
  status: string;
  cancelAtPeriodEnd: boolean;
}): SubscriptionLifecycle {
  if (["CANCELED", "EXPIRED"].includes(subscription.status)) return "expired";
  if (
    subscription.cancelAtPeriodEnd &&
    ENTITLED_STATUSES.includes(subscription.status)
  )
    return "ending";
  if (["PAST_DUE", "SUSPENDED"].includes(subscription.status))
    return "attention";
  return "active";
}

function billingPeriodText(subscription: {
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
}) {
  const lifecycle = subscriptionLifecycle(subscription);
  if (lifecycle === "expired")
    return subscription.currentPeriodEnd
      ? `Ended ${shortDate(subscription.currentPeriodEnd)}`
      : "Ended";
  if (lifecycle === "ending")
    return `Ends ${shortDate(subscription.currentPeriodEnd)}`;
  return subscription.currentPeriodEnd
    ? `Next renewal ${shortDate(subscription.currentPeriodEnd)}`
    : "No renewal date";
}

function customerActivityText(event: {
  action: string;
  summary: string;
  metadata: unknown;
}) {
  const metadata =
    event.metadata && typeof event.metadata === "object"
      ? (event.metadata as Record<string, unknown>)
      : {};

  switch (event.action) {
    case "subscription.label_updated":
      return event.summary;
    case "subscription.plan_changed":
      return "Subscription plan changed";
    case "subscription.cancellation_scheduled":
      return "Subscription cancellation scheduled";
    case "subscription.cancellation_reversed":
    case "stripe.subscription_cancellation_reversed":
      return "Subscription kept active";
    case "subscription.reactivated":
      return "Subscription reactivated";
    case "subscription.status_changed": {
      const status =
        typeof metadata.status === "string" ? metadata.status : "updated";
      if (status === "PAST_DUE") return "Payment needs attention";
      if (status === "CANCELED" || status === "EXPIRED")
        return "Subscription ended";
      if (status === "ACTIVE") return "Subscription is active";
      return null;
    }
    case "license.activation_customer_deactivated":
      return "Website deactivated from licence";
    case "customer.profile_updated":
      return "Account details updated";
    case "customer.email_changed":
      return "Account email changed";
    case "stripe.subscription_plan_change_cancelled":
      return "Scheduled plan change cancelled";
    case "license.stripe_auto_created":
      return "Licence created and ready to use";
    default:
      return null;
  }
}

function navLink(
  req: Request,
  href: string,
  label: string,
  active: string,
  key: string,
) {
  return `<a class="account-nav__link ${active === key ? "is-active" : ""}" href="${portalPath(req, href)}">${label}</a>`;
}

function logoBlock(req: Request, compact = false) {
  return `<div class="account-brand ${compact ? "account-brand--compact" : ""}">
    <img src="${portalPath(req, "/assets/rwexec-logo.png")}" alt="RWExec">
  </div>`;
}

function baseHead(req: Request, title: string, extraCss = "") {
  const faviconUrl = portalPath(req, "/assets/rwexec-favicon.png");
  const cssUrl = portalPath(req, "/assets/admin.css");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} · RWExec</title>
  <link rel="icon" href="${faviconUrl}">
  <link rel="stylesheet" href="${cssUrl}">
  <style>
    :root { --rw-orange:#fe6b02; --rw-ink:#111827; --rw-muted:#64748b; --rw-line:#e5e7eb; --rw-bg:#f5f7fb; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--rw-bg); color:var(--rw-ink); }
    .account-brand { display:flex; align-items:center; justify-content:center; background:#0b0f17; border-radius:12px; padding:14px 18px; }
    .account-brand img { display:block; width:190px; height:auto; }
    .account-brand--compact img { width:170px; }
    .account-login { min-height:100vh; display:grid; place-items:center; padding:28px 18px; }
    .account-login__card { width:min(520px,100%); background:#fff; border:1px solid var(--rw-line); border-radius:16px; padding:28px; box-shadow:0 12px 36px rgba(15,23,42,.08); }
    .account-login__card .account-brand { margin-bottom:24px; }
    .account-login__card h1 { margin:0 0 8px; }
    .account-layout { min-height:100vh; display:grid; grid-template-columns:260px minmax(0,1fr); }
    .account-sidebar { position:sticky; top:0; height:100vh; background:#0b0f17; padding:22px 18px; display:flex; flex-direction:column; gap:22px; }
    .account-sidebar .account-brand { padding:8px 6px 18px; border-radius:0; justify-content:flex-start; }
    .account-sidebar .account-brand img { width:180px; }
    .account-nav { display:grid; gap:5px; }
    .account-nav__link { color:#cbd5e1; text-decoration:none; padding:11px 12px; border-radius:8px; font-weight:650; }
    .account-nav__link:hover { background:#172033; color:#fff; }
    .account-nav__link.is-active { background:rgba(254,107,2,.16); color:#fff; box-shadow:inset 3px 0 0 var(--rw-orange); }
    .account-sidebar__bottom { margin-top:auto; border-top:1px solid #263244; padding-top:16px; }
    .account-user { color:#fff; margin-bottom:12px; }
    .account-user strong { display:block; font-size:14px; }
    .account-user span { display:block; font-size:12px; color:#94a3b8; margin-top:3px; overflow-wrap:anywhere; }
    .signout-button { width:100%; border:1px solid #39465a; background:#151d2b; color:#fff; border-radius:8px; padding:10px 12px; font:inherit; font-weight:700; cursor:pointer; text-align:left; }
    .signout-button:hover { border-color:#64748b; background:#202a3a; }
    .account-main { min-width:0; padding:32px clamp(18px,4vw,48px) 56px; }
    .account-content { max-width:1180px; margin:0 auto; }
    .page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; margin-bottom:24px; }
    .page-head h1 { margin:0 0 6px; font-size:30px; }
    .page-head p { margin:0; color:var(--rw-muted); }
    .eyebrow { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--rw-orange); font-weight:800; margin-bottom:6px; }
    .stats-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:20px; }
    .stat-card { background:#fff; border:1px solid var(--rw-line); border-radius:12px; padding:18px; }
    .stat-card__label { font-size:13px; color:var(--rw-muted); }
    .stat-card__value { font-size:30px; line-height:1; font-weight:800; margin-top:8px; }
    .section-grid { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(280px,.75fr); gap:18px; }
    .account-card { background:#fff; border:1px solid var(--rw-line); border-radius:12px; padding:20px; margin-bottom:16px; box-shadow:0 2px 10px rgba(15,23,42,.025); }
    .account-card h2, .account-card h3 { margin-top:0; }
    .card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:14px; }
    .card-head h2, .card-head h3 { margin:0; }
    .muted { color:var(--rw-muted); }
    .small { font-size:13px; }
    .status-pill { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:5px 9px; font-size:12px; font-weight:800; text-transform:capitalize; }
    .status-pill.good { background:#ecfdf3; color:#047857; }
    .status-pill.warn { background:#fff7ed; color:#c2410c; }
    .status-pill.bad { background:#fef2f2; color:#b91c1c; }
    .notice { border-radius:10px; padding:14px 16px; margin-bottom:16px; border:1px solid; }
    .notice strong { display:block; margin-bottom:3px; }
    .notice.success { background:#ecfdf3; color:#065f46; border-color:#a7f3d0; }
    .notice.warning { background:#fff7ed; color:#9a3412; border-color:#fed7aa; }
    .notice.info { background:#eff6ff; color:#1e40af; border-color:#bfdbfe; }
    .notice.error { background:#fef2f2; color:#991b1b; border-color:#fecaca; }
    .subscription-card { border-left:4px solid var(--rw-orange); }
    .subscription-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .subscription-title h2 { margin:0; font-size:20px; }
    .subscription-rename { display:inline-block; position:relative; }
    .subscription-rename > summary { list-style:none; display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border:1px solid #d6dce5; border-radius:7px; background:#fff; color:#475569; cursor:pointer; user-select:none; }
    .subscription-rename > summary::-webkit-details-marker { display:none; }
    .subscription-rename > summary:hover { background:#f8fafc; color:#111827; border-color:#b8c2d0; }
    .subscription-rename > summary svg { width:15px; height:15px; display:block; }
    .subscription-rename[open] > summary { border-color:var(--rw-orange); color:var(--rw-orange); box-shadow:0 0 0 2px rgba(254,107,2,.10); }
    .subscription-rename__form { position:absolute; z-index:20; top:36px; left:0; display:flex; gap:8px; align-items:center; width:min(440px,calc(100vw - 80px)); padding:10px; background:#fff; border:1px solid #d6dce5; border-radius:10px; box-shadow:0 12px 28px rgba(15,23,42,.14); }
    .subscription-rename__form input { flex:1 1 auto; min-width:0; }
    .subscription-rename__form .button { flex:0 0 auto; white-space:nowrap; }
    .subscription-meta { display:flex; gap:8px 18px; flex-wrap:wrap; color:var(--rw-muted); font-size:13px; margin-top:5px; }
    .subscription-body { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:end; margin-top:16px; padding-top:16px; border-top:1px solid #edf0f4; }
    .licence-summary { display:flex; gap:20px; flex-wrap:wrap; }
    .licence-summary strong { display:block; font-size:14px; }
    .licence-summary span { color:var(--rw-muted); font-size:13px; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .tabs { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 18px; }
    .tab-link { display:inline-flex; align-items:center; gap:7px; padding:9px 12px; border:1px solid #d6dce5; border-radius:999px; background:#fff; color:#334155; text-decoration:none; font-size:13px; font-weight:750; }
    .tab-link.is-active { border-color:var(--rw-orange); background:rgba(254,107,2,.08); color:#9a3d00; }
    .tab-count { display:inline-flex; min-width:22px; height:22px; padding:0 6px; align-items:center; justify-content:center; border-radius:999px; background:#eef2f7; font-size:11px; }
    .tab-link.is-active .tab-count { background:#fff; }
    .button { display:inline-flex; align-items:center; justify-content:center; border-radius:8px; padding:10px 13px; font:inherit; font-weight:750; text-decoration:none; cursor:pointer; border:1px solid transparent; min-height:40px; }
    .button.primary { background:var(--rw-orange); color:#111827; border-color:var(--rw-orange); }
    .button.primary:hover { filter:brightness(.96); }
    .button.secondary { background:#fff; color:#111827; border-color:#d6dce5; }
    .button.secondary:hover { background:#f8fafc; }
    .button.danger { background:#fff; color:#b91c1c; border-color:#fecaca; }
    .button:disabled { opacity:.48; cursor:not-allowed; }
    .rename-form { display:flex; gap:8px; align-items:center; margin-top:12px; flex-wrap:wrap; }
    .rename-form input { flex:1 1 260px; min-width:0; }
    .form-grid { display:grid; gap:14px; }
    .form-grid.two { grid-template-columns:repeat(2,minmax(0,1fr)); }
    label { display:grid; gap:6px; font-weight:650; font-size:14px; }
    input, select, textarea { width:100%; border:1px solid #d6dce5; border-radius:8px; padding:10px 11px; font:inherit; background:#fff; color:#111827; }
    input:focus, select:focus, textarea:focus { outline:2px solid rgba(254,107,2,.18); border-color:var(--rw-orange); }
    .plan-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .plan-option { border:1px solid #dfe5ed; border-radius:10px; padding:16px; }
    .plan-option.is-scheduled { border-color:#93c5fd; background:#f8fbff; }
    .plan-option h3 { margin:0 0 5px; }
    .plan-option__meta { color:var(--rw-muted); font-size:13px; margin-bottom:12px; }
    .site-list { display:grid; gap:9px; margin-top:12px; }
    .site-row { display:flex; align-items:center; justify-content:space-between; gap:14px; border:1px solid #e7ebf0; border-radius:9px; padding:12px 13px; }
    .site-row__url { font-weight:700; overflow-wrap:anywhere; }
    .site-row__meta { color:var(--rw-muted); font-size:12px; margin-top:3px; }
    .empty-state { text-align:center; padding:34px 20px; color:var(--rw-muted); }
    .activity-list { display:grid; gap:0; }
    .activity-row { padding:12px 0; border-bottom:1px solid #edf0f4; }
    .activity-row:last-child { border-bottom:0; }
    .activity-row strong { display:block; font-size:13px; }
    .activity-row span { color:var(--rw-muted); font-size:12px; }
    .mobile-topbar { display:none; }
    ${extraCss}
    @media (max-width:900px) {
      .account-layout { grid-template-columns:1fr; }
      .account-sidebar { position:static; height:auto; padding:12px 14px; gap:12px; }
      .account-sidebar .account-brand, .account-sidebar__bottom { display:none; }
      .account-nav { grid-template-columns:repeat(5,max-content); overflow-x:auto; padding-bottom:2px; }
      .account-nav__link { white-space:nowrap; }
      .mobile-topbar { display:flex; align-items:center; justify-content:space-between; gap:12px; background:#0b0f17; padding:12px 14px; }
      .mobile-topbar .account-brand { padding:0; border-radius:0; }
      .mobile-topbar .account-brand img { width:145px; }
      .mobile-topbar .signout-button { width:auto; padding:8px 10px; }
      .account-main { padding-top:24px; }
      .section-grid { grid-template-columns:1fr; }
    }
    @media (max-width:700px) {
      .stats-grid { grid-template-columns:1fr; }
      .plan-grid, .form-grid.two { grid-template-columns:1fr; }
      .page-head, .card-head, .subscription-body, .site-row { align-items:stretch; flex-direction:column; display:flex; }
      .subscription-body { gap:12px; }
      .rename-form { align-items:stretch; flex-direction:column; }
      .rename-form input { min-width:0; }
    }
  </style>
</head>`;
}

function publicShell(req: Request, title: string, body: string) {
  return `${baseHead(req, title)}<body><main class="account-login">${body}</main></body></html>`;
}

function appShell(
  req: Request,
  title: string,
  active: string,
  customer: PortalCustomer,
  body: string,
) {
  const displayName =
    customer.name || customer.companyName || "RWExec customer";
  return `${baseHead(req, title)}
<body>
  <div class="mobile-topbar">
    ${logoBlock(req, true)}
    <form method="post" action="${portalPath(req, "/logout")}">
      <button class="signout-button" type="submit">Sign Out</button>
    </form>
  </div>
  <div class="account-layout">
    <aside class="account-sidebar">
      ${logoBlock(req, true)}
      <nav class="account-nav" aria-label="Account navigation">
        ${navLink(req, "/", "Dashboard", active, "dashboard")}
        ${navLink(req, "/subscriptions", "Subscriptions", active, "subscriptions")}
        ${navLink(req, "/licenses", "Licences & Sites", active, "licenses")}
        ${navLink(req, "/billing", "Billing", active, "billing")}
        ${navLink(req, "/profile", "Account", active, "profile")}
      </nav>
      <div class="account-sidebar__bottom">
        <div class="account-user">
          <strong>${escapeHtml(displayName)}</strong>
          <span>${escapeHtml(customer.email)}</span>
        </div>
        <form method="post" action="${portalPath(req, "/logout")}">
          <button class="signout-button" type="submit">Sign Out</button>
        </form>
      </div>
    </aside>
    <main class="account-main"><div class="account-content">${body}</div></main>
  </div>
</body>
</html>`;
}

async function requireCustomer(req: Request, res: Response) {
  const customerId = customerIdFromCookie(req.headers.cookie);
  if (!customerId) return null;
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });
  if (!customer) {
    clearCustomerSession(res);
    normaliseCustomerCookiePath(req, res);
    return null;
  }
  return customer;
}

async function loadCustomerSubscriptions(customerId: string) {
  return prisma.subscription.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    include: {
      product: true,
      plan: { include: { entitlements: true } },
      licenses: {
        include: {
          delivery: true,
          activations: {
            where: { deactivatedAt: null },
            orderBy: { activatedAt: "desc" },
          },
        },
      },
    },
  });
}

function licenceDeliveryText(licence: {
  delivery: { ciphertext: string; iv: string; authTag: string; } | null;
}) {
  const canReveal = Boolean(
    licence.delivery?.ciphertext &&
    licence.delivery.iv &&
    licence.delivery.authTag,
  );

  if (canReveal) {
    return { canReveal: true, text: "Secure key available" };
  }

  return {
    canReveal: false,
    text: "Full key is not stored for this older licence — contact RWExec if you need it regenerated",
  };
}

function subscriptionCard(
  req: Request,
  subscription: Awaited<ReturnType<typeof loadCustomerSubscriptions>>[number],
) {
  const licence = subscription.licenses[0];
  const displayName = subscriptionDisplayName(subscription);
  const lifecycle = subscriptionLifecycle(subscription);
  const renewalText =
    lifecycle === "expired"
      ? subscription.currentPeriodEnd
        ? `Ended ${shortDate(subscription.currentPeriodEnd)}`
        : "Ended"
      : subscription.cancelAtPeriodEnd
        ? `Access until ${shortDate(subscription.currentPeriodEnd)}`
        : subscription.currentPeriodEnd
          ? `Renews ${shortDate(subscription.currentPeriodEnd)}`
          : "No renewal date";
  const delivery = licence ? licenceDeliveryText(licence) : null;

  return `<section class="account-card subscription-card">
    <div class="card-head">
      <div>
        <div class="subscription-title">
          <h2>${escapeHtml(displayName)}</h2>
          <details class="subscription-rename">
            <summary aria-label="Edit subscription reference" title="Edit subscription reference">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </summary>
            <form class="subscription-rename__form" method="post" action="${portalPath(req, `/subscriptions/${subscription.id}/label`)}">
              <input name="label" maxlength="80" value="${escapeHtml(subscription.label || "")}" placeholder="Your reference here" aria-label="Subscription reference">
              <button class="button secondary" type="submit">Save</button>
            </form>
          </details>
          <span class="status-pill ${statusClass(subscription.status)}">${escapeHtml(subscription.status.replaceAll("_", " ").toLowerCase())}</span>
        </div>
        <div class="subscription-meta">
          <span>${escapeHtml(subscription.product.name)}</span>
          <span>${escapeHtml(subscription.plan?.name || "Custom plan")}</span>
          ${subscription.plan ? `<span>${escapeHtml(planPrice(subscription.plan))}</span>` : ""}
          <span>${escapeHtml(renewalText)}</span>
        </div>
      </div>
    </div>
    ${subscription.cancelAtPeriodEnd ? `<div class="notice warning"><strong>Cancellation scheduled</strong>This subscription will remain active until ${escapeHtml(date(subscription.currentPeriodEnd))} and will not renew.</div>` : ""}
    <div class="subscription-body">
      <div class="licence-summary">
        ${licence ? `<div><strong>Licence •••• ${escapeHtml(licence.keyLastFour)}</strong><span>${licence.activations.length} / ${licence.activationLimit} sites activated</span></div><div><strong>Licence status</strong><span>${escapeHtml(licence.status.toLowerCase())} · ${escapeHtml(delivery?.text || "")}</span></div>` : `<div><strong>Licence</strong><span>No licence linked yet</span></div>`}
      </div>
      <div class="actions">
        ${licence && delivery?.canReveal ? `<form method="post" action="${portalPath(req, `/licenses/${licence.id}/reveal`)}"><button class="button secondary" type="submit">Reveal Licence Key</button></form>` : ""}
        <a class="button primary" href="${portalPath(req, `/subscriptions/${subscription.id}/manage`)}">Manage Subscription</a>
      </div>
    </div>
  </section>`;
}

async function scheduledChangeFor(subscriptionId: string | null) {
  if (!subscriptionId) return null;
  try {
    const change = await getStripeSubscriptionPlanChange(subscriptionId);
    if (!change) return null;
    const targetPlan = await prisma.plan.findUnique({
      where: { stripePriceId: change.targetPriceId },
      include: { entitlements: true },
    });
    return targetPlan ? { ...change, targetPlan } : null;
  } catch (error) {
    console.error("Could not load Stripe scheduled plan change:", error);
    return null;
  }
}

customerPortalRouter.get("/assets/admin.css", (_req, res) => {
  res.type("text/css").send(adminCss);
});

customerPortalRouter.get("/assets/rwexec-logo.png", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "src/admin/assets/rwexec-logo.png"));
});

customerPortalRouter.get("/assets/rwexec-favicon.png", (_req, res) => {
  res.sendFile(
    path.resolve(process.cwd(), "src/admin/assets/rwexec-favicon.png"),
  );
});

customerPortalRouter.get("/assets/licence-key.js", (_req, res) => {
  res.type("application/javascript").send(`(() => {
  const key = document.getElementById("licence-key");
  const toggle = document.getElementById("toggle-licence-key");
  const copy = document.getElementById("copy-licence-key");
  const status = document.getElementById("copy-status");

  if (!key || !toggle || !copy || !status) return;

  let shown = false;

  function setShown(nextShown) {
    shown = nextShown;
    key.style.filter = shown ? "none" : "blur(7px)";
    key.style.userSelect = shown ? "text" : "none";
    toggle.textContent = shown ? "Hide" : "Reveal";
    copy.disabled = !shown;
    copy.setAttribute("aria-disabled", shown ? "false" : "true");
    status.textContent = shown
      ? "The licence key is visible. You can now copy it."
      : "The key is hidden by default on each visit.";
  }

  setShown(false);

  toggle.addEventListener("click", () => {
    setShown(!shown);
  });

  copy.addEventListener("click", async () => {
    if (!shown) return;

    const value = key.getAttribute("data-key") || "";
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      status.textContent = "Licence key copied to clipboard.";
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.textContent = "Copy key";
      }, 1800);
    } catch {
      status.textContent = "Copy was blocked by your browser. Select the visible key and copy it manually.";
    }
  });
})();`);
});

customerPortalRouter.get("/checkout-success", async (req, res, next) => {
  try {
    const sessionId = String(req.query.session_id || "");
    if (!sessionId) {
      return res
        .status(400)
        .send(
          publicShell(
            req,
            "Checkout",
            `<section class="account-login__card"><h1>Missing checkout session</h1><p class="muted">We could not verify this checkout.</p></section>`,
          ),
        );
    }
    const session = await retrieveCheckoutSession(sessionId);
    const complete =
      session.status === "complete" ||
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required";
    if (!complete) {
      return res
        .status(409)
        .send(
          publicShell(
            req,
            "Checkout pending",
            `<section class="account-login__card">${logoBlock(req)}<h1>Payment is still processing</h1><p class="muted">Please wait a moment and refresh this page.</p></section>`,
          ),
        );
    }
    return res.send(
      publicShell(
        req,
        "Subscription active",
        `<section class="account-login__card">${logoBlock(req)}<h1>Subscription confirmed</h1><div class="notice success"><strong>Payment successful</strong>RWExec is setting up your account and licence.</div><p>We’ve emailed you a secure link to access your customer account.</p><a class="button primary" href="${portalPath(req)}">Open Customer Account</a></section>`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.get("/", async (req, res, next) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) {
      const msg =
        req.query.sent === "1"
          ? `<div class="notice success"><strong>Check your inbox</strong>If that email belongs to an RWExec customer, a secure sign-in link has been sent.</div>`
          : "";
      return res.send(
        publicShell(
          req,
          "Customer account",
          `<section class="account-login__card">${logoBlock(req)}<h1>Customer account</h1><p class="muted">Enter your RWExec account email and we’ll send a secure sign-in link.</p>${msg}<form class="form-grid" method="post" action="${portalPath(req, "/request-link")}"><label>Email address<input type="email" name="email" required autocomplete="email"></label><button class="button primary" type="submit">Email Sign-In Link</button></form>${customerEmailConfigured() ? "" : `<div class="notice error" style="margin-top:16px"><strong>Email unavailable</strong>Customer email delivery is not configured yet.</div>`}</section>`,
        ),
      );
    }

    const subscriptions = await loadCustomerSubscriptions(customer.id);
    const activeSubscriptions = subscriptions.filter((s) =>
      ENTITLED_STATUSES.includes(s.status),
    );
    const licences = subscriptions.flatMap((s) => s.licenses);
    const activeSites = licences.reduce(
      (sum, licence) => sum + licence.activations.length,
      0,
    );
    const totalSites = licences.reduce(
      (sum, licence) => sum + licence.activationLimit,
      0,
    );
    const entityIds = [
      customer.id,
      ...subscriptions.map((s) => s.id),
      ...licences.map((l) => l.id),
    ];
    const rawActivity = await prisma.auditLog.findMany({
      where: { entityId: { in: entityIds } },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    const activity = rawActivity
      .map((event) => ({ event, text: customerActivityText(event) }))
      .filter(
        (item): item is { event: (typeof rawActivity)[number]; text: string; } =>
          Boolean(item.text),
      )
      .slice(0, 7);
    const attention = subscriptions.filter(
      (s) =>
        s.cancelAtPeriodEnd || ["PAST_DUE", "SUSPENDED"].includes(s.status),
    );
    const nextRenewal = subscriptions
      .filter((s) => !s.cancelAtPeriodEnd && s.currentPeriodEnd)
      .sort(
        (a, b) =>
          (a.currentPeriodEnd?.getTime() || 0) -
          (b.currentPeriodEnd?.getTime() || 0),
      )[0];

    const body = `<div class="page-head"><div><div class="eyebrow">Customer dashboard</div><h1>Welcome${customer.name ? `, ${escapeHtml(customer.name.split(" ")[0])}` : ""}</h1><p>Manage your RWExec subscriptions, licences, sites and account.</p></div></div>
      ${attention.length ? `<div class="notice warning"><strong>${attention.length} subscription${attention.length === 1 ? " needs" : "s need"} your attention</strong><a href="${portalPath(req, "/subscriptions")}" style="color:inherit;font-weight:700">Review Subscriptions</a> to see the details.</div>` : ""}
      <div class="stats-grid"><div class="stat-card"><div class="stat-card__label">Active subscriptions</div><div class="stat-card__value">${activeSubscriptions.length}</div></div><div class="stat-card"><div class="stat-card__label">Sites activated</div><div class="stat-card__value">${activeSites}<span class="muted" style="font-size:16px"> / ${totalSites}</span></div></div><div class="stat-card"><div class="stat-card__label">Next renewal</div><div class="stat-card__value" style="font-size:19px;line-height:1.25">${nextRenewal ? escapeHtml(shortDate(nextRenewal.currentPeriodEnd)) : "—"}</div></div></div>
      <div class="section-grid"><div><div class="card-head"><h2>Your Subscriptions</h2><a class="button secondary" href="${portalPath(req, "/subscriptions")}">View All</a></div>${subscriptions
        .slice(0, 3)
        .map((s) => subscriptionCard(req, s))
        .join("") ||
      `<section class="account-card empty-state">No subscriptions yet.</section>`
      }</div><div><section class="account-card"><h2>Recent Activity</h2><div class="activity-list">${activity.length ? activity.map(({ event, text }) => `<div class="activity-row"><strong>${escapeHtml(text)}</strong><span>${escapeHtml(shortDate(event.createdAt))}</span></div>`).join("") : `<div class="muted small">No recent account activity.</div>`}</div></section><section class="account-card"><h2>Quick Links</h2><div class="actions"><a class="button secondary" href="${portalPath(req, "/licenses")}">Manage Sites</a><a class="button secondary" href="${portalPath(req, "/profile")}">Account Details</a></div></section></div></div>`;
    return res.send(appShell(req, "Dashboard", "dashboard", customer, body));
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.get("/subscriptions", async (req, res, next) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return res.redirect(portalPath(req));
    const subscriptions = await loadCustomerSubscriptions(customer.id);
    const saved =
      req.query.named === "1"
        ? `<div class="notice success"><strong>Subscription name saved</strong>Your custom name has been updated.</div>`
        : "";
    const body = `<div class="page-head"><div><div class="eyebrow">Subscriptions</div><h1>Your Subscriptions</h1><p>Each subscription is grouped with its licence and site allowance so you can tell them apart easily.</p></div></div>${saved}${subscriptions.map((s) => subscriptionCard(req, s)).join("") || `<section class="account-card empty-state">No subscriptions yet.</section>`}`;
    return res.send(
      appShell(req, "Subscriptions", "subscriptions", customer, body),
    );
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.post(
  "/subscriptions/:id/label",
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));
      const label =
        String(req.body.label || "")
          .trim()
          .slice(0, 80) || null;
      const subscription = await prisma.subscription.findFirst({
        where: { id: req.params.id, customerId: customer.id },
      });
      if (!subscription) return res.status(404).send("Subscription not found.");
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { label },
      });
      await writeAudit({
        action: "subscription.label_updated",
        entityType: "subscription",
        entityId: subscription.id,
        summary: label
          ? `Subscription renamed to ${label}`
          : "Subscription custom name removed",
      });
      const referer = String(req.get("referer") || "");
      const returnPath = referer.includes(
        `/subscriptions/${subscription.id}/manage`,
      )
        ? `/subscriptions/${subscription.id}/manage?named=1`
        : "/subscriptions?named=1";
      return res.redirect(portalPath(req, returnPath));
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.get("/licenses", async (req, res, next) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return res.redirect(portalPath(req));

    const subscriptions = await loadCustomerSubscriptions(customer.id);
    const requestedTab = String(req.query.status || "active");
    const tab = ["active", "ending", "expired"].includes(requestedTab)
      ? (requestedTab as "active" | "ending" | "expired")
      : "active";

    const counts = { active: 0, ending: 0, expired: 0 };
    for (const subscription of subscriptions) {
      const lifecycle = subscriptionLifecycle(subscription);
      if (lifecycle === "expired")
        counts.expired += subscription.licenses.length;
      else if (lifecycle === "ending")
        counts.ending += subscription.licenses.length;
      else counts.active += subscription.licenses.length;
    }

    const visibleSubscriptions = subscriptions.filter((subscription) => {
      const lifecycle = subscriptionLifecycle(subscription);
      if (tab === "expired") return lifecycle === "expired";
      if (tab === "ending") return lifecycle === "ending";
      return lifecycle === "active" || lifecycle === "attention";
    });

    const deactivated =
      req.query.deactivated === "1"
        ? `<div class="notice success"><strong>Site Deactivated</strong>The licence slot is now available to use on another website. The deactivated WordPress site may temporarily show its previous cached status; open RWExec Reservations → Licence and click <strong style="display:inline">Check Licence Now</strong> to refresh it immediately.</div>`
        : "";
    const reactivationCancelled =
      req.query.reactivation_cancelled === "1"
        ? `<div class="notice info"><strong>Reactivation cancelled</strong>No changes were made to your licence.</div>`
        : "";

    const cards = visibleSubscriptions.flatMap((subscription) =>
      subscription.licenses.map((licence) => {
        const secret = licenceDeliveryText(licence);
        const lifecycle = subscriptionLifecycle(subscription);
        const canReactivate =
          lifecycle === "expired" &&
          !subscription.complimentary &&
          subscription.externalProvider === "stripe" &&
          Boolean(subscription.plan?.stripePriceId);

        const lifecycleNotice =
          lifecycle === "ending"
            ? `<div class="notice warning"><strong>Ending ${escapeHtml(shortDate(subscription.currentPeriodEnd))}</strong>This licence remains usable until the end of the paid period.</div>`
            : lifecycle === "expired"
              ? `<div class="notice info"><strong>Subscription ended</strong>${subscription.complimentary ? "This entitlement is managed directly by RWExec." : "Your licence history and activated sites are kept here so you can reactivate without losing the licence reference."}</div>`
              : "";

        const primaryAction = canReactivate
          ? `<form method="post" action="${portalPath(req, `/subscriptions/${subscription.id}/reactivate`)}"><button class="button primary" type="submit">Reactivate</button></form>`
          : lifecycle === "expired" && subscription.complimentary
            ? `<span class="muted small"><strong>Managed by RWExec</strong></span>`
            : secret.canReveal
              ? `<form method="post" action="${portalPath(req, `/licenses/${licence.id}/reveal`)}"><button class="button primary" type="submit">Reveal Licence Key</button></form>`
              : "";

        return `<section class="account-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">${escapeHtml(subscriptionDisplayName(subscription))}</div>
              <h2>${escapeHtml(subscription.product.name)} licence</h2>
              <div class="subscription-meta">
                <span>•••• ${escapeHtml(licence.keyLastFour)}</span>
                <span>${licence.activations.length} / ${licence.activationLimit} sites</span>
                <span>${escapeHtml(licence.status.toLowerCase())}</span>
              </div>
            </div>
            <div class="actions">${primaryAction}</div>
          </div>
          ${lifecycleNotice}
          <div class="muted small">${escapeHtml(secret.text)}</div>
          <div class="site-list">
            ${licence.activations.length
            ? licence.activations
              .map(
                (activation) =>
                  `<div class="site-row"><div><div class="site-row__url">${escapeHtml(activation.siteUrl)}</div><div class="site-row__meta">Activated ${escapeHtml(shortDate(activation.activatedAt))}${activation.pluginVersion ? ` · Plugin ${escapeHtml(activation.pluginVersion)}` : ""}</div></div>${lifecycle === "expired" ? "" : `<form method="post" action="${portalPath(req, `/activations/${activation.id}/deactivate`)}"><button class="button secondary" type="submit">Deactivate</button></form>`}</div>`,
              )
              .join("")
            : `<div class="empty-state" style="padding:20px">No active sites on this licence.</div>`
          }
          </div>
        </section>`;
      }),
    );

    const tabs = `<div class="tabs" aria-label="Licence status">
      <a class="tab-link ${tab === "active" ? "is-active" : ""}" href="${portalPath(req, "/licenses?status=active")}">Active <span class="tab-count">${counts.active}</span></a>
      <a class="tab-link ${tab === "ending" ? "is-active" : ""}" href="${portalPath(req, "/licenses?status=ending")}">Ending <span class="tab-count">${counts.ending}</span></a>
      <a class="tab-link ${tab === "expired" ? "is-active" : ""}" href="${portalPath(req, "/licenses?status=expired")}">Expired <span class="tab-count">${counts.expired}</span></a>
    </div>`;

    const emptyText =
      tab === "expired"
        ? "No expired licences."
        : tab === "ending"
          ? "No licences are currently ending."
          : "No active licences yet.";

    const body = `<div class="page-head"><div><div class="eyebrow">Licences & Sites</div><h1>Licence Usage</h1><p>Manage active sites and keep previous licences available if you ever need to reactivate.</p></div></div>${deactivated}${reactivationCancelled}${tabs}${cards.join("") || `<section class="account-card empty-state">${emptyText}</section>`}`;
    return res.send(
      appShell(req, "Licences & Sites", "licenses", customer, body),
    );
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.post(
  "/activations/:id/deactivate",
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));
      const activation = await prisma.activation.findFirst({
        where: {
          id: req.params.id,
          deactivatedAt: null,
          license: { customerId: customer.id },
        },
        include: { license: true },
      });
      if (!activation) return res.status(404).send("Activation not found.");
      await prisma.activation.update({
        where: { id: activation.id },
        data: { deactivatedAt: new Date() },
      });
      await writeAudit({
        action: "license.activation_customer_deactivated",
        entityType: "license",
        entityId: activation.licenseId,
        summary: `Customer deactivated ${activation.siteUrl}`,
        metadata: { activationId: activation.id, siteUrl: activation.siteUrl },
      });
      return res.redirect(`${portalPath(req, "/licenses")}?deactivated=1`);
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.get("/billing", async (req, res, next) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return res.redirect(portalPath(req));
    const subscriptions = await loadCustomerSubscriptions(customer.id);
    const body = `<div class="page-head"><div><div class="eyebrow">Billing</div><h1>Billing & Renewals</h1><p>Plan changes and payment details are handled securely through Stripe, while RWExec keeps your licence entitlement in sync.</p></div></div>${subscriptions.map((s) => `<section class="account-card"><div class="card-head"><div><h2>${escapeHtml(s.label?.trim() || s.product.name)}</h2><div class="subscription-meta"><span>${escapeHtml(s.plan?.name || "Custom plan")}</span>${s.plan ? `<span>${escapeHtml(planPrice(s.plan))}</span>` : ""}<span>${escapeHtml(billingPeriodText(s))}</span></div></div><span class="status-pill ${statusClass(s.status)}">${escapeHtml(s.status.replaceAll("_", " ").toLowerCase())}</span></div>${s.cancelAtPeriodEnd ? `<div class="notice warning"><strong>Cancellation scheduled</strong>Your subscription remains active until ${escapeHtml(date(s.currentPeriodEnd))}.</div>` : ""}<div class="actions"><a class="button primary" href="${portalPath(req, `/subscriptions/${s.id}/manage`)}">Manage Subscription</a></div></section>`).join("") || `<section class="account-card empty-state">No subscriptions yet.</section>`}`;
    return res.send(appShell(req, "Billing", "billing", customer, body));
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.get("/profile", async (req, res, next) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return res.redirect(portalPath(req));
    const fullCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
    });
    if (!fullCustomer) return res.redirect(portalPath(req));
    const saved =
      req.query.saved === "1"
        ? `<div class="notice success"><strong>Account details saved</strong>Your details have been updated.</div>`
        : "";
    const emailSent =
      req.query.email_sent === "1"
        ? `<div class="notice info"><strong>Verification email sent</strong>Open the link sent to your new email address to finish the change.</div>`
        : "";
    const emailChanged =
      req.query.email_changed === "1"
        ? `<div class="notice success"><strong>Email address changed</strong>Your new email address is now used to sign in.</div>`
        : "";
    const errorMessage =
      typeof req.query.error === "string"
        ? `<div class="notice error"><strong>Could not update email</strong>${escapeHtml(req.query.error)}</div>`
        : "";
    const body = `<div class="page-head"><div><div class="eyebrow">Account</div><h1>Account Details</h1><p>Keep your contact and billing details up to date.</p></div></div>${saved}${emailSent}${emailChanged}${errorMessage}<div class="section-grid"><section class="account-card"><h2>Profile</h2><form class="form-grid" method="post" action="${portalPath(req, "/profile")}"><div class="form-grid two"><label>Your name<input name="name" maxlength="120" value="${escapeHtml(fullCustomer.name || "")}" placeholder="Your name"></label><label>Company / business<input name="company_name" maxlength="160" value="${escapeHtml(fullCustomer.companyName || "")}" placeholder="Optional business name"></label></div><label>Billing email <span class="muted small">Optional. Leave blank to use your account email.</span><input type="email" name="billing_email" value="${escapeHtml(fullCustomer.billingEmail || "")}" placeholder="billing@example.com"></label><button class="button primary" type="submit">Save Account Details</button></form></section><section class="account-card"><h2>Sign-In Email</h2><p class="muted small">Current email</p><p><strong>${escapeHtml(fullCustomer.email)}</strong></p><form class="form-grid" method="post" action="${portalPath(req, "/profile/email")}"><label>New email address<input type="email" name="email" required placeholder="new@example.com"></label><button class="button secondary" type="submit" ${customerEmailConfigured() ? "" : "disabled"}>Send Verification Email</button></form><p class="muted small" style="margin-bottom:0">We verify the new address before changing your account so a typo cannot lock you out.</p></section></div>`;
    return res.send(appShell(req, "Account", "profile", customer, body));
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.post("/profile", async (req, res, next) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return res.redirect(portalPath(req));
    const name =
      String(req.body.name || "")
        .trim()
        .slice(0, 120) || null;
    const companyName =
      String(req.body.company_name || "")
        .trim()
        .slice(0, 160) || null;
    const billingEmail =
      String(req.body.billing_email || "")
        .trim()
        .toLowerCase() || null;
    if (billingEmail && !/^\S+@\S+\.\S+$/.test(billingEmail)) {
      return res.redirect(
        `${portalPath(req, "/profile")}?error=${encodeURIComponent("Enter a valid billing email address.")}`,
      );
    }
    await prisma.customer.update({
      where: { id: customer.id },
      data: { name, companyName, billingEmail },
    });
    await writeAudit({
      action: "customer.profile_updated",
      entityType: "customer",
      entityId: customer.id,
      summary: "Customer updated account details",
    });
    return res.redirect(`${portalPath(req, "/profile")}?saved=1`);
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.post(
  "/profile/email",
  magicLinkLimiter,
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));
      const newEmail = String(req.body.email || "")
        .trim()
        .toLowerCase();
      await requestCustomerEmailChange({
        customerId: customer.id,
        newEmail,
        verifyUrlForToken: (token) =>
          portalAbsoluteUrl(
            req,
            `/verify-email?token=${encodeURIComponent(token)}`,
          ),
      });
      return res.redirect(`${portalPath(req, "/profile")}?email_sent=1`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Email change could not be started.";
      return res.redirect(
        `${portalPath(req, "/profile")}?error=${encodeURIComponent(message)}`,
      );
    }
  },
);

customerPortalRouter.get("/verify-email", async (req, res, next) => {
  try {
    const token = String(req.query.token || "");
    const result = token ? await consumeCustomerEmailChangeToken(token) : null;
    if (!result) {
      return res
        .status(400)
        .send(
          publicShell(
            req,
            "Email link expired",
            `<section class="account-login__card">${logoBlock(req)}<h1>That email-change link is no longer valid</h1><p class="muted">Return to your account and request a new verification email.</p><a class="button primary" href="${portalPath(req, "/profile")}">Open Account</a></section>`,
          ),
        );
    }
    const stripeCustomers = await prisma.subscription.findMany({
      where: {
        customerId: result.customerId,
        externalProvider: "stripe",
        externalCustomerId: { not: null },
      },
      select: { externalCustomerId: true },
      distinct: ["externalCustomerId"],
    });
    for (const item of stripeCustomers) {
      if (!item.externalCustomerId) continue;
      try {
        await updateStripeCustomerEmail(
          item.externalCustomerId,
          result.newEmail,
        );
      } catch (error) {
        console.error("Could not update Stripe customer email:", error);
      }
    }
    await writeAudit({
      action: "customer.email_changed",
      entityType: "customer",
      entityId: result.customerId,
      summary: "Customer verified and changed account email",
      metadata: {
        previousEmail: result.previousEmail,
        newEmail: result.newEmail,
      },
    });
    setCustomerSession(res, result.customerId);
    normaliseCustomerCookiePath(req, res);
    return res.redirect(`${portalPath(req, "/profile")}?email_changed=1`);
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.get(
  "/subscriptions/:id/manage",
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));

      let subscription = await prisma.subscription.findFirst({
        where: { id: req.params.id, customerId: customer.id },
        include: {
          product: true,
          plan: { include: { entitlements: true } },
          licenses: {
            include: { activations: { where: { deactivatedAt: null } } },
          },
        },
      });
      if (
        !subscription?.externalSubscriptionId ||
        !subscription.externalCustomerId ||
        !subscription.plan
      ) {
        return res
          .status(404)
          .send(
            appShell(
              req,
              "Subscription unavailable",
              "subscriptions",
              customer,
              `<div class="page-head"><div><h1>Subscription unavailable</h1><p>This subscription cannot be managed online.</p></div></div><a class="button secondary" href="${portalPath(req, "/subscriptions")}">Back to Subscriptions</a>`,
            ),
          );
      }

      try {
        await fetchAndSyncStripeSubscription(
          subscription.externalSubscriptionId,
        );
        subscription = await prisma.subscription.findFirst({
          where: { id: req.params.id, customerId: customer.id },
          include: {
            product: true,
            plan: { include: { entitlements: true } },
            licenses: {
              include: { activations: { where: { deactivatedAt: null } } },
            },
          },
        });
      } catch (error) {
        console.error(
          "Could not refresh Stripe subscription before rendering account:",
          error,
        );
      }
      if (
        !subscription?.externalSubscriptionId ||
        !subscription.externalCustomerId ||
        !subscription.plan
      )
        return res.redirect(portalPath(req, "/subscriptions"));

      const scheduled = await scheduledChangeFor(
        subscription.externalSubscriptionId,
      );
      const plans = await prisma.plan.findMany({
        where: {
          productId: subscription.productId,
          active: true,
          stripePriceId: { not: null },
        },
        orderBy: [{ priceMinor: "asc" }, { billingInterval: "asc" }],
        include: { entitlements: true },
      });
      const currentLimit = planActivationLimit(subscription.plan);
      const licence = subscription.licenses[0];
      const displayName = subscriptionDisplayName(subscription);

      const lifecycle = subscriptionLifecycle(subscription);

      if (lifecycle === "expired") {
        const canReactivate =
          !subscription.complimentary &&
          subscription.externalProvider === "stripe" &&
          Boolean(subscription.plan.stripePriceId);
        const action = canReactivate
          ? `<form method="post" action="${portalPath(req, `/subscriptions/${subscription.id}/reactivate`)}"><button class="button primary" type="submit">Reactivate Subscription</button></form>`
          : `<div class="muted"><strong>${subscription.complimentary ? "Managed by RWExec" : "Online reactivation is unavailable"}</strong>${subscription.complimentary ? " — this entitlement is controlled manually by RWExec." : ""}</div>`;
        const body = `<div class="page-head"><div><div class="eyebrow">Manage Subscription</div><h1>${escapeHtml(displayName)}</h1><p>${escapeHtml(subscription.product.name)} · ${escapeHtml(subscription.plan.name)}</p></div><a class="button secondary" href="${portalPath(req, "/subscriptions")}">Back to Subscriptions</a></div><div class="notice info"><strong>Subscription ended</strong>Your previous subscription and licence history have been kept in your account.</div><section class="account-card"><div class="card-head"><div><h2>Previous Plan</h2><div class="subscription-meta"><span>${escapeHtml(subscription.plan.name)}</span><span>${escapeHtml(planPrice(subscription.plan))}</span>${currentLimit ? `<span>${currentLimit} sites</span>` : ""}${licence ? `<span>Licence •••• ${escapeHtml(licence.keyLastFour)}</span>` : ""}</div></div><span class="status-pill bad">Ended</span></div><div class="actions">${action}</div></section>`;
        return res.send(
          appShell(
            req,
            `Manage ${displayName}`,
            "subscriptions",
            customer,
            body,
          ),
        );
      }

      const flash =
        req.query.scheduled === "1"
          ? `<div class="notice success"><strong>Plan change scheduled</strong>Your current plan and site allowance stay unchanged until renewal.</div>`
          : req.query.schedule_cancelled === "1"
            ? `<div class="notice success"><strong>Scheduled plan change removed</strong>Your current plan will now continue at renewal.</div>`
            : req.query.kept === "1"
              ? `<div class="notice success"><strong>Cancellation reversed</strong>Your subscription will now renew as normal.</div>`
              : req.query.named === "1"
                ? `<div class="notice success"><strong>Subscription name saved</strong>Your custom name has been updated.</div>`
                : req.query.payment_updated === "1"
                  ? `<div class="notice success"><strong>Payment method updated</strong>Your Stripe billing details have been saved.</div>`
                  : "";

      const stateBanner = subscription.cancelAtPeriodEnd
        ? `<div class="notice warning"><strong>Cancellation scheduled</strong>Your ${escapeHtml(subscription.plan.name)} subscription remains active with ${currentLimit || licence?.activationLimit || "your current"} site${(currentLimit || licence?.activationLimit) === 1 ? "" : "s"} until <strong style="display:inline">${escapeHtml(date(subscription.currentPeriodEnd))}</strong>. It will not renew.<form method="post" action="${portalPath(req, `/subscriptions/${subscription.id}/keep`)}" style="margin-top:12px"><button class="button primary" type="submit">Keep My Subscription</button></form></div>`
        : scheduled
          ? `<div class="notice info"><strong>Plan change scheduled</strong>${escapeHtml(subscription.plan.name)} → <strong style="display:inline">${escapeHtml(scheduled.targetPlan.name)}</strong> on ${escapeHtml(date(scheduled.effectiveAt || subscription.currentPeriodEnd))}. You keep your current ${currentLimit || licence?.activationLimit || ""}-site allowance until then.<form method="post" action="${portalPath(req, `/subscriptions/${subscription.id}/cancel-scheduled-change`)}" style="margin-top:12px"><button class="button secondary" type="submit">Cancel Scheduled Change</button></form></div>`
          : `<div class="notice success"><strong>Subscription active</strong>${subscription.currentPeriodEnd ? `Your current plan renews on ${escapeHtml(date(subscription.currentPeriodEnd))}.` : "Your subscription is active."}</div>`;

      const planOptions = plans
        .filter((plan) => plan.id !== subscription?.planId)
        .map((plan) => {
          const targetLimit = planActivationLimit(plan);
          if (targetLimit === null || currentLimit === null) return "";
          const lowerTier = targetLimit < currentLimit;
          const shorterSameTier =
            targetLimit === currentLimit &&
            subscription?.plan?.billingInterval === "year" &&
            plan.billingInterval === "month";
          const deferred = lowerTier || shorterSameTier;
          const isScheduled = scheduled?.targetPlan.id === plan.id;
          const disabled = subscription?.cancelAtPeriodEnd;
          const actionLabel = isScheduled
            ? "Scheduled"
            : deferred
              ? "Schedule for Renewal"
              : "Switch Now";
          const actionNote = isScheduled
            ? `Changes on ${date(scheduled?.effectiveAt || subscription?.currentPeriodEnd)}`
            : deferred
              ? "No immediate credit or loss of site allowance."
              : "Stripe shows any prorated charge before you confirm.";
          return `<div class="plan-option ${isScheduled ? "is-scheduled" : ""}"><h3>${escapeHtml(plan.name)}</h3><div class="plan-option__meta">${escapeHtml(planPrice(plan))} · ${targetLimit} site${targetLimit === 1 ? "" : "s"}</div><div class="muted small" style="margin-bottom:12px">${escapeHtml(actionNote)}</div><form method="post" action="${portalPath(req, `/subscriptions/${subscription?.id}/change-plan`)}"><input type="hidden" name="plan_id" value="${escapeHtml(plan.id)}"><button class="button ${deferred ? "secondary" : "primary"}" type="submit" ${disabled || isScheduled ? "disabled" : ""}>${escapeHtml(actionLabel)}</button></form></div>`;
        })
        .join("");

      const body = `<div class="page-head"><div>
      <div class="eyebrow">Manage Subscription</div>
      <h1>${escapeHtml(displayName)}</h1>
      <p>${escapeHtml(subscription.product.name)} · ${escapeHtml(subscription.plan.name)}</p>
      </div>
      <a class="button secondary" href="${portalPath(req, "/subscriptions")}">Back to Subscriptions</a>
      </div>${flash}${stateBanner}<section class="account-card">
      <div class="card-head">
      <div>
      <h2>Current Plan</h2>
      <div class="subscription-meta">
      <span>${escapeHtml(subscription.plan.name)}</span>
      <span>${escapeHtml(planPrice(subscription.plan))}</span>
      ${currentLimit ? `<span>${currentLimit} sites</span>` : ""}${licence ? `<span>Licence •••• ${escapeHtml(licence.keyLastFour)}</span><span>${licence.activations.length}/${licence.activationLimit} activated</span>` : ""}</div></div><span class="status-pill ${statusClass(subscription.status)}">${escapeHtml(subscription.status.replaceAll("_", " ").toLowerCase())}</span></div><details class="subscription-rename" style="margin-top:12px"><summary aria-label="Edit subscription reference" title="Edit subscription reference"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></summary><form class="subscription-rename__form" method="post" action="${portalPath(req, `/subscriptions/${subscription.id}/label`)}"><input name="label" maxlength="80" value="${escapeHtml(subscription.label || "")}" placeholder="Your reference here" aria-label="Subscription reference"><button class="button secondary" type="submit">Save</button></form></details></section><section class="account-card"><h2>Change Plan</h2>${subscription.cancelAtPeriodEnd ? `<div class="notice warning"><strong>Plan changes are paused</strong>Keep your subscription first if you want to change plan.</div>` : `<p class="muted">Upgrades take effect immediately after Stripe confirms the prorated payment. Downgrades take effect at renewal.</p>`}<div class="plan-grid">${planOptions || `<div class="muted">No alternative plans are currently available.</div>`}</div></section><section class="account-card"><h2>Billing</h2><p class="muted">Payment details are updated securely in Stripe.</p><div class="actions"><form method="post" action="${portalPath(req, `/subscriptions/${subscription.id}/payment-method`)}"><button class="button secondary" type="submit">Update Payment Method</button></form></div></section><section class="account-card"><h2>Subscription Status</h2>${subscription.cancelAtPeriodEnd ? `<p class="muted">Cancellation is already scheduled. Use “Keep my subscription” above to reactivate renewal.</p>` : `<p class="muted">You can cancel at the end of the current billing period. Your licence remains active until that date.</p><form method="post" action="${portalPath(req, `/subscriptions/${subscription.id}/cancel`)}"><button class="button danger" type="submit">Cancel Subscription</button></form>`}</section>`;
      return res.send(
        appShell(req, `Manage ${displayName}`, "subscriptions", customer, body),
      );
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.post(
  "/subscriptions/:id/reactivate",
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));

      const subscription = await prisma.subscription.findFirst({
        where: {
          id: req.params.id,
          customerId: customer.id,
          complimentary: false,
          externalProvider: "stripe",
          status: { in: ["CANCELED", "EXPIRED"] },
        },
        include: { plan: true },
      });

      if (!subscription?.plan?.stripePriceId) {
        return res
          .status(404)
          .send("Subscription cannot be reactivated online.");
      }

      const session = await createCheckoutSession({
        planId: subscription.plan.id,
        customerEmail: customer.email,
        customerName: customer.name || undefined,
        stripeCustomerId: subscription.externalCustomerId || undefined,
        reactivateSubscriptionId: subscription.id,
        successUrl: portalAbsoluteUrl(
          req,
          "/checkout-success?session_id={CHECKOUT_SESSION_ID}",
        ),
        cancelUrl: portalAbsoluteUrl(
          req,
          "/licenses?status=expired&reactivation_cancelled=1",
        ),
      });

      if (!session.url || typeof session.url !== "string") {
        throw new Error("Stripe did not return a reactivation checkout URL.");
      }

      return res.redirect(303, session.url);
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.post(
  "/subscriptions/:id/change-plan",
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));
      const subscription = await prisma.subscription.findFirst({
        where: {
          id: req.params.id,
          customerId: customer.id,
          externalProvider: "stripe",
          complimentary: false,
          status: { in: ["ACTIVE", "TRIALING"] },
        },
        include: { plan: { include: { entitlements: true } } },
      });
      if (subscription?.cancelAtPeriodEnd)
        return res.redirect(
          portalPath(req, `/subscriptions/${req.params.id}/manage`),
        );
      const targetPlanId = String(req.body.plan_id || "");
      const targetPlan = targetPlanId
        ? await prisma.plan.findFirst({
          where: {
            id: targetPlanId,
            productId: subscription?.productId,
            active: true,
            stripePriceId: { not: null },
          },
          include: { entitlements: true },
        })
        : null;
      if (
        !subscription?.externalCustomerId ||
        !subscription.externalSubscriptionId ||
        !subscription.plan ||
        !targetPlan?.stripePriceId ||
        targetPlan.id === subscription.planId
      )
        return res.status(400).send("Plan change unavailable.");
      const currentLimit = planActivationLimit(subscription.plan);
      const targetLimit = planActivationLimit(targetPlan);
      if (currentLimit === null || targetLimit === null)
        throw new Error("Plan activation limits are not configured.");
      const deferred =
        targetLimit < currentLimit ||
        (targetLimit === currentLimit &&
          subscription.plan.billingInterval === "year" &&
          targetPlan.billingInterval === "month");
      if (deferred) {
        if (
          targetPlan.billingInterval !== "month" &&
          targetPlan.billingInterval !== "year"
        )
          throw new Error("Target plan billing interval is not supported.");
        await scheduleStripeSubscriptionPlanChange({
          subscriptionId: subscription.externalSubscriptionId,
          targetPriceId: targetPlan.stripePriceId,
          targetBillingInterval: targetPlan.billingInterval,
        });
        return res.redirect(
          `${portalPath(req, `/subscriptions/${subscription.id}/manage`)}?scheduled=1`,
        );
      }
      const session = await createSubscriptionUpdateConfirmPortalSession({
        customerId: subscription.externalCustomerId,
        subscriptionId: subscription.externalSubscriptionId,
        targetPriceId: targetPlan.stripePriceId,
        returnUrl: portalAbsoluteUrl(
          req,
          `/subscriptions/${subscription.id}/manage?stripe_return=1`,
        ),
      });
      if (!session.url || typeof session.url !== "string")
        throw new Error("Stripe did not return a plan-change URL.");
      return res.redirect(303, session.url);
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.post(
  "/subscriptions/:id/cancel-scheduled-change",
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));
      const subscription = await prisma.subscription.findFirst({
        where: {
          id: req.params.id,
          customerId: customer.id,
          externalProvider: "stripe",
          complimentary: false,
          status: { in: ["ACTIVE", "TRIALING"] },
        },
      });
      if (!subscription?.externalSubscriptionId)
        return res.status(404).send("Subscription unavailable.");
      await cancelStripeSubscriptionPlanChange(
        subscription.externalSubscriptionId,
      );
      return res.redirect(
        `${portalPath(req, `/subscriptions/${subscription.id}/manage`)}?schedule_cancelled=1`,
      );
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.post("/subscriptions/:id/keep", async (req, res, next) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return res.redirect(portalPath(req));
    const subscription = await prisma.subscription.findFirst({
      where: {
        id: req.params.id,
        customerId: customer.id,
        externalProvider: "stripe",
        complimentary: false,
        status: { in: ["ACTIVE", "TRIALING"] },
        cancelAtPeriodEnd: true,
      },
    });
    if (!subscription?.externalSubscriptionId)
      return res.status(404).send("Subscription unavailable.");
    await resumeStripeSubscription(subscription.externalSubscriptionId);
    return res.redirect(
      `${portalPath(req, `/subscriptions/${subscription.id}/manage`)}?kept=1`,
    );
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.post(
  "/subscriptions/:id/payment-method",
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));
      const subscription = await prisma.subscription.findFirst({
        where: {
          id: req.params.id,
          customerId: customer.id,
          externalProvider: "stripe",
          complimentary: false,
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        },
      });
      if (!subscription?.externalCustomerId)
        return res.status(404).send("Subscription unavailable.");
      const session = await createPaymentMethodPortalSession({
        customerId: subscription.externalCustomerId,
        returnUrl: portalAbsoluteUrl(
          req,
          `/subscriptions/${subscription.id}/manage?payment_updated=1`,
        ),
      });
      if (!session.url || typeof session.url !== "string")
        throw new Error("Stripe did not return a payment-method URL.");
      return res.redirect(303, session.url);
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.post(
  "/subscriptions/:id/cancel",
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));
      const subscription = await prisma.subscription.findFirst({
        where: {
          id: req.params.id,
          customerId: customer.id,
          externalProvider: "stripe",
          complimentary: false,
          status: { in: ["ACTIVE", "TRIALING"] },
          cancelAtPeriodEnd: false,
        },
      });
      if (
        !subscription?.externalCustomerId ||
        !subscription.externalSubscriptionId
      )
        return res.status(404).send("Subscription unavailable.");
      await cancelStripeSubscriptionPlanChange(
        subscription.externalSubscriptionId,
      ).catch((error) => {
        if (
          error instanceof Error &&
          error.message.includes("not created by RWExec")
        )
          throw error;
      });
      const session = await createSubscriptionCancelPortalSession({
        customerId: subscription.externalCustomerId,
        subscriptionId: subscription.externalSubscriptionId,
        returnUrl: portalAbsoluteUrl(
          req,
          `/subscriptions/${subscription.id}/manage?stripe_return=1`,
        ),
      });
      if (!session.url || typeof session.url !== "string")
        throw new Error("Stripe did not return a cancellation URL.");
      return res.redirect(303, session.url);
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.post(
  "/request-link",
  magicLinkLimiter,
  async (req, res, next) => {
    try {
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();
      const customer = email
        ? await prisma.customer.findUnique({ where: { email } })
        : null;
      if (customer && customerEmailConfigured())
        await sendCustomerPortalEmail(customer.id, "login");
      return res.redirect(`${portalPath(req)}?sent=1`);
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.get("/verify", async (req, res, next) => {
  try {
    const token = String(req.query.token || "");
    const customerId = token ? await consumePortalMagicLink(token) : null;
    if (!customerId)
      return res
        .status(400)
        .send(
          publicShell(
            req,
            "Link expired",
            `<section class="account-login__card">${logoBlock(req)}<h1>That sign-in link is no longer valid</h1><p class="muted">Request a new secure link from the customer account page.</p><a class="button primary" href="${portalPath(req)}">Request a New Link</a></section>`,
          ),
        );
    setCustomerSession(res, customerId);
    normaliseCustomerCookiePath(req, res);
    return res.redirect(portalPath(req));
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.post("/logout", (req, res) => {
  clearCustomerSession(res);
  normaliseCustomerCookiePath(req, res);
  return res.redirect(portalPath(req));
});

customerPortalRouter.post(
  "/licenses/:id/reveal",
  licenceRevealLimiter,
  async (req, res, next) => {
    try {
      const customer = await requireCustomer(req, res);
      if (!customer) return res.redirect(portalPath(req));
      const licenceIdParam = req.params.id;
      const licenceId = Array.isArray(licenceIdParam)
        ? licenceIdParam[0]
        : licenceIdParam;
      if (!licenceId) return res.status(400).send("Licence ID is required.");

      const licence = await prisma.license.findFirst({
        where: { id: licenceId, customerId: customer.id },
      });
      if (!licence) return res.status(404).send("Licence not found.");

      const product = await prisma.product.findUnique({
        where: { id: licence.productId },
      });
      if (!product) return res.status(404).send("Licence product not found.");

      const subscription = licence.subscriptionId
        ? await prisma.subscription.findFirst({
          where: { id: licence.subscriptionId, customerId: customer.id },
        })
        : null;

      const subscriptionProduct = subscription
        ? await prisma.product.findUnique({
          where: { id: subscription.productId },
        })
        : null;
      const subscriptionPlan = subscription?.planId
        ? await prisma.plan.findUnique({ where: { id: subscription.planId } })
        : null;

      const rawKey = await revealLicenceKey(licence.id, customer.id);
      if (!rawKey)
        return res
          .status(409)
          .send(
            appShell(
              req,
              "Licence unavailable",
              "licenses",
              customer,
              `<div class="page-head"><div><h1>Licence key unavailable</h1><p>The full key is not stored for this older licence. The licence itself is unchanged and can continue working on existing sites.</p></div></div><section class="account-card"><div class="notice info"><strong>Need the full key?</strong>Contact RWExec if you need this licence regenerated. Regeneration would replace the existing key, so it should only be used when necessary.</div><a class="button secondary" href="${portalPath(req, "/licenses")}">Back to Licences</a></section>`,
            ),
          );

      const label =
        subscription && subscriptionProduct
          ? subscriptionDisplayName({
            label: subscription.label,
            product: subscriptionProduct,
            plan: subscriptionPlan,
          })
          : product.name;
      const safeRawKey = escapeHtml(rawKey);
      return res.send(
        appShell(
          req,
          "Your licence key",
          "licenses",
          customer,
          `<div class="page-head"><div><div class="eyebrow">${escapeHtml(label)}</div><h1>Your Licence Key</h1><p>${escapeHtml(product.name)}</p></div></div><section class="account-card"><div class="notice success"><strong>Secure licence access</strong>You can return to your RWExec account and reveal this key again whenever you need it.</div><div class="secret" id="licence-key" data-key="${safeRawKey}" style="filter:blur(7px);user-select:none">${safeRawKey}</div><div class="actions" style="margin-top:14px"><button class="button secondary" type="button" id="toggle-licence-key">Reveal</button><button class="button primary" type="button" id="copy-licence-key" disabled aria-disabled="true">Copy Key</button><a class="button secondary" href="${portalPath(req, "/licenses")}">Back to Licences</a></div><div class="muted small" id="copy-status" style="margin-top:10px" aria-live="polite">The key is hidden by default on each visit.</div></section><script src="${portalPath(req, "/assets/licence-key.js")}" defer></script>`,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.use(
  (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = String(res.locals.requestId || "unknown");
    console.error(`[${requestId}] Customer portal error:`, error);

    if (res.headersSent) return;

    res
      .status(500)
      .send(
        publicShell(
          req,
          "Something went wrong",
          `<section class="account-login__card">${logoBlock(req)}<h1>We couldn’t complete that request</h1><p class="muted">Please try again. If it keeps happening, give RWExec this reference so we can trace the error.</p><div class="secret" style="margin:16px 0;font-size:14px">${escapeHtml(requestId)}</div><a class="button primary" href="${portalPath(req)}">Back to Your Account</a></section>`,
        ),
      );
  },
);
