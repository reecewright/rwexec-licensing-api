import { Router, type Request, type Response } from "express";
import path from "node:path";
import { prisma } from "../db.js";
import { adminCss } from "../admin/styles.js";
import { escapeHtml } from "../admin/html.js";
import {
  claimLicenceDelivery,
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
  createBillingPortalSession,
  retrieveCheckoutSession,
} from "../services/stripe-service.js";

export const customerPortalRouter = Router();

const ACCOUNT_HOST = "account.rwexec.com";

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

function logoBlock(req: Request) {
  return `<div class="portal-logo-wrap"><img class="portal-logo" src="${portalPath(req, "/assets/rwexec-logo.png")}" alt="RWExec"></div>`;
}

function shell(req: Request, title: string, body: string) {
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
    .portal-shell {
      min-height: 100vh;
      background: #f5f7fb;
      padding: 32px 18px;
    }

    .portal {
      max-width: 980px;
      margin: auto;
    }

    .portal-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 24px;
    }

    .portal-logo-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #111827;
      padding: 12px 16px;
      border-radius: 10px;
      margin-bottom: 18px;
    }

    .portal-logo {
      display: block;
      width: 220px;
      max-width: 50vw;
      height: auto;
    }

    .portal h1 {
      margin: 0;
    }

    .portal-login {
      max-width: 520px;
      margin: 10vh auto;
    }

    .licence-row {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: center;
      flex-wrap: wrap;
    }

    .portal .button {
      font: inherit;
    }

    .portal-note {
      font-size: 13px;
      color: #64748b;
    }

    .subscription-action {
      white-space: nowrap;
    }

    .subscription-note {
      margin-top: 4px;
      font-size: 12px;
      color: #64748b;
    }

    @media (max-width: 720px) {
      .portal-head {
        align-items: stretch;
        flex-direction: column;
      }

      .portal-logo {
        width: 190px;
        max-width: 70vw;
      }
    }
  </style>
</head>
<body>
  <div class="portal-shell">
    <main class="portal">${body}</main>
  </div>
</body>
</html>`;
}

customerPortalRouter.get("/assets/admin.css", (_req, res) => {
  res.type("text/css").send(adminCss);
});

customerPortalRouter.get("/assets/rwexec-logo.png", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "src/admin/assets/rwexec-logo.png"));
});

customerPortalRouter.get("/assets/rwexec-favicon.png", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "src/admin/assets/rwexec-favicon.png"));
});

customerPortalRouter.get("/checkout-success", async (req, res, next) => {
  try {
    const sessionId = String(req.query.session_id || "");

    if (!sessionId) {
      return res.status(400).send(
        shell(
          req,
          "Checkout",
          `<section class="panel portal-login">
            <h1>Missing checkout session</h1>
            <p class="muted">We could not verify this checkout.</p>
          </section>`,
        ),
      );
    }

    const session = await retrieveCheckoutSession(sessionId);

    const complete =
      session.status === "complete" ||
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required";

    if (!complete) {
      return res.status(409).send(
        shell(
          req,
          "Checkout pending",
          `<section class="panel portal-login">
            ${logoBlock(req)}
            <h1>Payment is still processing</h1>
            <p class="muted">Please wait a moment and refresh this page.</p>
          </section>`,
        ),
      );
    }

    return res.send(
      shell(
        req,
        "Subscription active",
        `<section class="panel portal-login">
          ${logoBlock(req)}
          <h1>Subscription confirmed</h1>
          <div class="alert success">
            Your payment was successful and RWExec is setting up your account.
          </div>
          <p>
            We’ve emailed you a secure link to access your customer account
            and collect your licence.
          </p>
          <a class="button primary" href="${portalPath(req)}">
            Open customer account
          </a>
        </section>`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.get("/", async (req, res, next) => {
  try {
    const customerId = customerIdFromCookie(req.headers.cookie);
    const accountUrl = portalPath(req);

    if (!customerId) {
      const msg =
        req.query.sent === "1"
          ? `<div class="alert success">
              If that email belongs to an RWExec customer, a secure sign-in
              link has been sent.
            </div>`
          : "";

      return res.send(
        shell(
          req,
          "Customer account",
          `<section class="panel portal-login">
            ${logoBlock(req)}
            <h1>Customer account</h1>
            <p class="muted">
              Enter your RWExec account email and we’ll send a secure sign-in link.
            </p>

            ${msg}

            <form
              class="form-grid"
              method="post"
              action="${portalPath(req, "/request-link")}"
            >
              <label>
                Email address
                <input type="email" name="email" required>
              </label>

              <button class="button primary" type="submit">
                Email sign-in link
              </button>
            </form>

            ${
              customerEmailConfigured()
                ? ""
                : `<div class="alert error" style="margin-top:16px">
                    Customer email delivery is not configured yet.
                    Contact RWExec support for access.
                  </div>`
            }
          </section>`,
        ),
      );
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        subscriptions: {
          orderBy: { createdAt: "desc" },
          include: {
            product: true,
            plan: true,
          },
        },
        licenses: {
          orderBy: { createdAt: "desc" },
          include: {
            product: true,
            delivery: true,
            activations: {
              where: { deactivatedAt: null },
            },
          },
        },
      },
    });

    if (!customer) {
      clearCustomerSession(res);
      normaliseCustomerCookiePath(req, res);
      return res.redirect(accountUrl);
    }

    const subs = customer.subscriptions
      .map((s) => {
        const canManage =
          s.externalProvider === "stripe" &&
          Boolean(s.externalCustomerId);

        const cancellationNote = s.cancelAtPeriodEnd
          ? `<div class="subscription-note">Cancels at the end of the current billing period.</div>`
          : "";

        const manageButton = canManage
          ? `<form
               method="post"
               action="${portalPath(req, `/subscriptions/${s.id}/manage`)}"
               class="subscription-action"
             >
               <button class="button secondary" type="submit">
                 Manage subscription
               </button>
             </form>`
          : `<span class="muted">Managed by RWExec</span>`;

        return `<tr>
          <td>${escapeHtml(s.product.name)}</td>
          <td>${escapeHtml(s.plan?.name || "Custom")}</td>
          <td>
            <span class="status ${s.status.toLowerCase()}">
              ${escapeHtml(s.status.replaceAll("_", " "))}
            </span>
            ${cancellationNote}
          </td>
          <td>
            ${
              s.currentPeriodEnd
                ? escapeHtml(s.currentPeriodEnd.toISOString().slice(0, 10))
                : "Never"
            }
          </td>
          <td>${manageButton}</td>
        </tr>`;
      })
      .join("");

    const licences = customer.licenses
      .map((l) => {
        const canClaim = Boolean(
          l.delivery &&
            !l.delivery.claimedAt &&
            l.delivery.expiresAt > new Date(),
        );

        const deliveryText = l.delivery?.claimedAt
          ? "Key already collected"
          : l.delivery && l.delivery.expiresAt <= new Date()
            ? "Delivery link expired — contact support"
            : canClaim
              ? "Ready to collect"
              : "Key was created before customer delivery was enabled — contact support to regenerate";

        return `<div class="panel licence-row">
          <div>
            <strong>${escapeHtml(l.product.name)}</strong>
            <div class="muted">
              Licence •••• ${escapeHtml(l.keyLastFour)} ·
              ${l.activations.length}/${l.activationLimit} activations
            </div>
            <div class="portal-note">${escapeHtml(deliveryText)}</div>
          </div>

          ${
            canClaim
              ? `<form
                   method="post"
                   action="${portalPath(req, `/licenses/${l.id}/reveal`)}"
                 >
                   <button class="button primary" type="submit">
                     Reveal licence key
                   </button>
                 </form>`
              : ""
          }
        </div>`;
      })
      .join("");

    return res.send(
      shell(
        req,
        "My RWExec account",
        `<div class="portal-head">
          <div>
            ${logoBlock(req)}
            <h1>${escapeHtml(customer.name || "My RWExec account")}</h1>
            <div class="muted">${escapeHtml(customer.email)}</div>
          </div>

          <form method="post" action="${portalPath(req, "/logout")}">
            <button class="button secondary" type="submit">Sign out</button>
          </form>
        </div>

        <section class="panel">
          <h2>Subscriptions</h2>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Period end</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                ${
                  subs ||
                  `<tr>
                    <td colspan="5" class="muted">No subscriptions.</td>
                  </tr>`
                }
              </tbody>
            </table>
          </div>
        </section>

        <h2>Licences</h2>

        ${
          licences ||
          `<section class="panel muted">No licences yet.</section>`
        }`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.post(
  "/subscriptions/:id/manage",
  async (req, res, next) => {
    try {
      const customerId = customerIdFromCookie(req.headers.cookie);
      const accountUrl = portalPath(req);

      if (!customerId) {
        return res.redirect(accountUrl);
      }

      const subscription = await prisma.subscription.findFirst({
        where: {
          id: req.params.id,
          customerId,
          externalProvider: "stripe",
        },
      });

      if (!subscription?.externalCustomerId) {
        return res.status(404).send(
          shell(
            req,
            "Subscription unavailable",
            `<section class="panel portal-login">
              ${logoBlock(req)}
              <h1>Subscription cannot be managed online</h1>
              <p class="muted">
                This subscription is not connected to Stripe billing.
              </p>
              <a class="button secondary" href="${accountUrl}">
                Back to account
              </a>
            </section>`,
          ),
        );
      }

      const session = await createBillingPortalSession({
        customerId: subscription.externalCustomerId,
        returnUrl: portalAbsoluteUrl(req),
      });

      if (!session.url || typeof session.url !== "string") {
        throw new Error(
          "Stripe Billing Portal did not return a portal URL.",
        );
      }

      return res.redirect(303, session.url);
    } catch (error) {
      next(error);
    }
  },
);

customerPortalRouter.post("/request-link", async (req, res, next) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const customer = email
      ? await prisma.customer.findUnique({
          where: { email },
        })
      : null;

    if (customer && customerEmailConfigured()) {
      await sendCustomerPortalEmail(customer.id, "login");
    }

    return res.redirect(`${portalPath(req)}?sent=1`);
  } catch (error) {
    next(error);
  }
});

customerPortalRouter.get("/verify", async (req, res, next) => {
  try {
    const token = String(req.query.token || "");
    const customerId = token
      ? await consumePortalMagicLink(token)
      : null;

    if (!customerId) {
      return res.status(400).send(
        shell(
          req,
          "Link expired",
          `<section class="panel portal-login">
            ${logoBlock(req)}
            <h1>That sign-in link is no longer valid</h1>
            <p class="muted">
              Request a new secure link from the customer account page.
            </p>
            <a class="button primary" href="${portalPath(req)}">
              Request a new link
            </a>
          </section>`,
        ),
      );
    }

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
  async (req, res, next) => {
    try {
      const customerId = customerIdFromCookie(req.headers.cookie);
      const accountUrl = portalPath(req);

      if (!customerId) {
        return res.redirect(accountUrl);
      }

      const licence = await prisma.license.findFirst({
        where: {
          id: req.params.id,
          customerId,
        },
        include: {
          product: true,
        },
      });

      if (!licence) {
        return res.status(404).send(
          shell(
            req,
            "Licence not found",
            `<section class="panel">Licence not found.</section>`,
          ),
        );
      }

      const rawKey = await claimLicenceDelivery(
        licence.id,
        customerId,
      );

      if (!rawKey) {
        return res.status(409).send(
          shell(
            req,
            "Licence unavailable",
            `<section class="panel">
              <h1>Licence key unavailable</h1>
              <p class="muted">
                This key has already been collected or its delivery window
                has expired. Contact RWExec support if you need the key
                regenerated.
              </p>
              <a class="button secondary" href="${accountUrl}">
                Back to account
              </a>
            </section>`,
          ),
        );
      }

      return res.send(
        shell(
          req,
          "Your licence key",
          `<section class="panel portal-login">
            ${logoBlock(req)}
            <h1>${escapeHtml(licence.product.name)} licence</h1>

            <div class="alert success">
              <strong>Copy this key now.</strong>
              For security it will not be shown again.
            </div>

            <div class="secret">${escapeHtml(rawKey)}</div>

            <p class="muted">
              If you lose this key later, RWExec can regenerate it.
              Regenerating invalidates the previous key.
            </p>

            <a class="button secondary" href="${accountUrl}">
              Back to account
            </a>
          </section>`,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);
