import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { adminRouter } from "./routes/admin-routes.js";
import { adminWebRouter } from "./routes/admin-web-routes.js";
import { licenseRouter } from "./routes/license-routes.js";
import { stripeWebhookRouter } from "./routes/stripe-routes.js";
import { customerPortalRouter } from "./routes/customer-portal-routes.js";

export const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet());

// Stripe must receive the exact raw request body so webhook signatures can be verified.
app.use("/v1/stripe", stripeWebhookRouter);

app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "rwexec-licensing-api" });
});

app.get("/", (req, res, next) => {
  if (req.hostname === "account.rwexec.com") {
    return res.redirect("/account");
  }

  next();
});

app.use("/account", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }), customerPortalRouter);

app.use("/admin", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }), adminWebRouter);

app.use("/v1/licenses", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }), licenseRouter);

app.use("/v1/admin", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }), adminRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "server_error", message: "An unexpected server error occurred." });
});
