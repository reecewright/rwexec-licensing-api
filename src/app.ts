import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { adminRouter } from "./routes/admin-routes.js";
import { licenseRouter } from "./routes/license-routes.js";

export const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet());
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rwexec-licensing-api"
  });
});

app.use(
  "/v1/licenses",
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }),
  licenseRouter
);

app.use(
  "/v1/admin",
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }),
  adminRouter
);

app.use((_req, res) => {
  res.status(404).json({
    error: "not_found"
  });
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(error);
    res.status(500).json({
      error: "server_error",
      message: "An unexpected server error occurred."
    });
  }
);
