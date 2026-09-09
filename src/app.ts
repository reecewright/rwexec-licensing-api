import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { adminRouter } from "./routes/admin-routes.js";
import { adminWebRouter } from "./routes/admin-web-routes.js";
import { licenseRouter } from "./routes/license-routes.js";
import { stripeWebhookRouter } from "./routes/stripe-routes.js";
import { customerPortalRouter } from "./routes/customer-portal-routes.js";
import { prisma } from "./db.js";
import { createCheckoutSession } from "./services/stripe-service.js";

export const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((req, res, next) => {
  const requestId =
    String(req.header("x-request-id") || "").trim().slice(0, 80) ||
    crypto.randomUUID();

  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "form-action": [
          "'self'",
          "https://billing.stripe.com",
          "https://checkout.stripe.com",
        ],
      },
    },
  }),
);

// Stripe must receive the exact raw request body so webhook
// signatures can be verified.
app.use("/stripe", stripeWebhookRouter);

app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rwexec-licensing-api",
  });
});



const accountRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

app.get("/checkout/:productSlug/:planSlug", async (req, res, next) => {
  try {
    const productSlug = String(req.params.productSlug || "").trim();
    const planSlug = String(req.params.planSlug || "").trim();

    const product = await prisma.product.findUnique({
      where: { slug: productSlug },
    });

    if (!product || !product.active) {
      return res.status(404).json({
        error: "product_not_found",
      });
    }

    const plan = await prisma.plan.findUnique({
      where: {
        productId_slug: {
          productId: product.id,
          slug: planSlug,
        },
      },
    });

    if (!plan || !plan.active || !plan.stripePriceId) {
      return res.status(404).json({
        error: "plan_not_found",
      });
    }

    const session = await createCheckoutSession({
      planId: plan.id,
      successUrl:
        "https://account.rwexec.com/checkout-success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl:
        "https://rwexec.com/reservations",
    });

    if (!session.url || typeof session.url !== "string") {
      throw new Error("Stripe did not return a checkout URL.");
    }

    return res.redirect(303, session.url);
  } catch (error) {
    next(error);
  }
});

/*
 * Customer account domain
 *
 * account.rwexec.com should expose the customer portal directly
 * from the root:
 *
 *   https://account.rwexec.com/
 *   https://account.rwexec.com/subscriptions
 *   https://account.rwexec.com/licenses
 *
 * rather than requiring /account in the URL.
 */
const accountHostRouter = express.Router();

accountHostRouter.use(
  accountRateLimiter,
  customerPortalRouter,
);

app.use((req, res, next) => {
  const hostname = req.hostname.toLowerCase();

  if (hostname === "account.rwexec.com") {
    return accountHostRouter(req, res, next);
  }

  next();
});

const adminHostRouter = express.Router();

adminHostRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
  adminWebRouter,
);

app.use((req, res, next) => {
  const hostname = req.hostname.toLowerCase();

  if (hostname === "admin.rwexec.com") {
    return adminHostRouter(req, res, next);
  }

  next();
});

/*
 * Keep /account available on the API domain as a fallback.
 */
app.use(
  "/account",
  accountRateLimiter,
  customerPortalRouter,
);

/*
 * Keep /account available on the API domain as a fallback.
 */
app.use(
  "/account",
  accountRateLimiter,
  customerPortalRouter,
);

app.use(
  "/admin",
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
  adminWebRouter,
);

app.use(
  "/v1/licenses",
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
  licenseRouter,
);

app.use(
  "/v1/admin",
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
  adminRouter,
);

app.use((_req, res) => {
  res.status(404).json({
    error: "not_found",
  });
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const requestId = String(
      res.locals.requestId || "unknown",
    );

    console.error(`[${requestId}]`, error);

    res.status(500).json({
      error: "server_error",
      message: "An unexpected server error occurred.",
      request_id: requestId,
    });
  },
);