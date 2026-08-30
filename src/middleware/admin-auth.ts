import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

export function requireAdminApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const supplied = req.header("x-rwexec-admin-key") ?? "";

  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(config.ADMIN_API_KEY);

  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    res.status(401).json({
      error: "unauthorized",
      message: "Valid admin API key required."
    });
    return;
  }

  next();
}
