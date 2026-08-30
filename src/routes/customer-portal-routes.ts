import { Router } from "express";
import { prisma } from "../db.js";
import { adminCss } from "../admin/styles.js";
import { escapeHtml } from "../admin/html.js";
import { claimLicenceDelivery, clearCustomerSession, consumePortalMagicLink, customerIdFromCookie, setCustomerSession } from "../services/customer-portal-service.js";
import { customerEmailConfigured, sendCustomerPortalEmail } from "../services/email-service.js";
import { retrieveCheckoutSession } from "../services/stripe-service.js";

export const customerPortalRouter = Router();

function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · RWExec</title><link rel="icon" href="/admin/assets/rwexec-favicon.png"><link rel="stylesheet" href="/admin/assets/admin.css"><style>.portal-shell{min-height:100vh;background:#f5f7fb;padding:32px 18px}.portal{max-width:980px;margin:auto}.portal-head{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:24px}.portal-logo{width:220px;max-width:50vw}.portal h1{margin:0}.portal-login{max-width:520px;margin:10vh auto}.licence-row{display:flex;justify-content:space-between;gap:18px;align-items:center;flex-wrap:wrap}.portal .button{font:inherit}.portal-note{font-size:13px;color:#64748b}</style></head><body><div class="portal-shell"><main class="portal">${body}</main></div></body></html>`;
}

customerPortalRouter.get("/assets/admin.css", (_req, res) => res.type("text/css").send(adminCss));


customerPortalRouter.get("/checkout-success", async (req, res, next) => {
  try {
    const sessionId = String(req.query.session_id || "");
    if (!sessionId) return res.status(400).send(shell("Checkout", `<section class="panel portal-login"><h1>Missing checkout session</h1><p class="muted">We could not verify this checkout.</p></section>`));
    const session = await retrieveCheckoutSession(sessionId);
    const complete = session.status === "complete" || session.payment_status === "paid" || session.payment_status === "no_payment_required";
    if (!complete) return res.status(409).send(shell("Checkout pending", `<section class="panel portal-login"><h1>Payment is still processing</h1><p class="muted">Please wait a moment and refresh this page.</p></section>`));
    const email = typeof session.customer_details?.email === "string" ? session.customer_details.email.toLowerCase() : typeof session.customer_email === "string" ? session.customer_email.toLowerCase() : "";
    const customer = email ? await prisma.customer.findUnique({ where: { email } }) : null;
    const emailed = customer && customerEmailConfigured() ? await sendCustomerPortalEmail(customer.id, "welcome").then(() => true).catch(() => false) : false;
    res.send(shell("Subscription active", `<section class="panel portal-login"><img class="portal-logo" src="/admin/assets/rwexec-logo.png" alt="RWExec"><h1>Subscription confirmed</h1><div class="alert success">Your payment was successful and RWExec is setting up your account.</div><p>${emailed ? "We’ve emailed you a secure sign-in link so you can collect your licence." : "You can access your customer account to view your subscription and collect your licence once delivery is available."}</p><a class="button primary" href="/account">Open customer account</a></section>`));
  } catch (error) { next(error); }
});

customerPortalRouter.get("/", async (req, res, next) => {
  try {
    const customerId = customerIdFromCookie(req.headers.cookie);
    if (!customerId) {
      const msg = req.query.sent === "1" ? `<div class="alert success">If that email belongs to an RWExec customer, a secure sign-in link has been sent.</div>` : "";
      return res.send(shell("Customer account", `<section class="panel portal-login"><img class="portal-logo" src="/admin/assets/rwexec-logo.png" alt="RWExec"><h1>Customer account</h1><p class="muted">Enter your RWExec account email and we’ll send a secure sign-in link.</p>${msg}<form class="form-grid" method="post" action="/account/request-link"><label>Email address<input type="email" name="email" required></label><button class="button primary" type="submit">Email sign-in link</button></form>${customerEmailConfigured() ? "" : `<div class="alert error" style="margin-top:16px">Customer email delivery is not configured yet. Contact RWExec support for access.</div>`}</section>`));
    }
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, include: { subscriptions: { orderBy: { createdAt: "desc" }, include: { product: true, plan: true } }, licenses: { orderBy: { createdAt: "desc" }, include: { product: true, delivery: true, activations: { where: { deactivatedAt: null } } } } } });
    if (!customer) { clearCustomerSession(res); return res.redirect("/account"); }
    const subs = customer.subscriptions.map(s => `<tr><td>${escapeHtml(s.product.name)}</td><td>${escapeHtml(s.plan?.name || "Custom")}</td><td><span class="status ${s.status.toLowerCase()}">${escapeHtml(s.status.replaceAll("_", " "))}</span></td><td>${s.currentPeriodEnd ? escapeHtml(s.currentPeriodEnd.toISOString().slice(0,10)) : "Never"}</td></tr>`).join("");
    const licences = customer.licenses.map(l => {
      const canClaim = Boolean(l.delivery && !l.delivery.claimedAt && l.delivery.expiresAt > new Date());
      const deliveryText = l.delivery?.claimedAt ? "Key already collected" : l.delivery && l.delivery.expiresAt <= new Date() ? "Delivery link expired — contact support" : canClaim ? "Ready to collect" : "Key was created before customer delivery was enabled — contact support to regenerate";
      return `<div class="panel licence-row"><div><strong>${escapeHtml(l.product.name)}</strong><div class="muted">Licence •••• ${escapeHtml(l.keyLastFour)} · ${l.activations.length}/${l.activationLimit} activations</div><div class="portal-note">${escapeHtml(deliveryText)}</div></div>${canClaim ? `<form method="post" action="/account/licenses/${escapeHtml(l.id)}/reveal"><button class="button primary" type="submit">Reveal licence key</button></form>` : ""}</div>`;
    }).join("");
    res.send(shell("My RWExec account", `<div class="portal-head"><div><img class="portal-logo" src="/admin/assets/rwexec-logo.png" alt="RWExec"><h1>${escapeHtml(customer.name || "My RWExec account")}</h1><div class="muted">${escapeHtml(customer.email)}</div></div><form method="post" action="/account/logout"><button class="button secondary" type="submit">Sign out</button></form></div><section class="panel"><h2>Subscriptions</h2><div class="table-wrap"><table><thead><tr><th>Product</th><th>Plan</th><th>Status</th><th>Period end</th></tr></thead><tbody>${subs || `<tr><td colspan="4" class="muted">No subscriptions.</td></tr>`}</tbody></table></div></section><h2>Licences</h2>${licences || `<section class="panel muted">No licences yet.</section>`}`));
  } catch (error) { next(error); }
});

customerPortalRouter.post("/request-link", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const customer = email ? await prisma.customer.findUnique({ where: { email } }) : null;
    if (customer && customerEmailConfigured()) await sendCustomerPortalEmail(customer.id, "login");
    res.redirect("/account?sent=1");
  } catch (error) { next(error); }
});

customerPortalRouter.get("/verify", async (req, res, next) => {
  try {
    const token = String(req.query.token || "");
    const customerId = token ? await consumePortalMagicLink(token) : null;
    if (!customerId) return res.status(400).send(shell("Link expired", `<section class="panel portal-login"><h1>That sign-in link is no longer valid</h1><p class="muted">Request a new secure link from the customer account page.</p><a class="button primary" href="/account">Request a new link</a></section>`));
    setCustomerSession(res, customerId);
    res.redirect("/account");
  } catch (error) { next(error); }
});

customerPortalRouter.post("/logout", (_req, res) => { clearCustomerSession(res); res.redirect("/account"); });

customerPortalRouter.post("/licenses/:id/reveal", async (req, res, next) => {
  try {
    const customerId = customerIdFromCookie(req.headers.cookie);
    if (!customerId) return res.redirect("/account");
    const licence = await prisma.license.findFirst({ where: { id: req.params.id, customerId }, include: { product: true } });
    if (!licence) return res.status(404).send(shell("Licence not found", `<section class="panel">Licence not found.</section>`));
    const rawKey = await claimLicenceDelivery(licence.id, customerId);
    if (!rawKey) return res.status(409).send(shell("Licence unavailable", `<section class="panel"><h1>Licence key unavailable</h1><p class="muted">This key has already been collected or its delivery window has expired. Contact RWExec support if you need the key regenerated.</p><a class="button secondary" href="/account">Back to account</a></section>`));
    res.send(shell("Your licence key", `<section class="panel portal-login"><h1>${escapeHtml(licence.product.name)} licence</h1><div class="alert success"><strong>Copy this key now.</strong> For security it will not be shown again.</div><div class="secret">${escapeHtml(rawKey)}</div><p class="muted">If you lose this key later, RWExec can regenerate it. Regenerating invalidates the previous key.</p><a class="button secondary" href="/account">Back to account</a></section>`));
  } catch (error) { next(error); }
});
