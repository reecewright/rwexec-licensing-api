import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

const COOKIE_NAME = "rwexec_admin_session";
const SESSION_SECONDS = 60 * 60 * 12;

function sign(value: string) {
  return crypto.createHmac("sha256", config.ADMIN_API_KEY).update(value).digest("hex");
}

function safeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseCookies(header?: string) {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function verifyAdminKey(candidate: string) {
  return safeEqual(candidate, config.ADMIN_API_KEY);
}

export function createAdminSession(res: Response) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = String(expires);
  const token = `${payload}.${sign(payload)}`;
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_SECONDS * 1000,
    path: "/admin"
  });
}

export function clearAdminSession(res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    path: "/admin"
  });
}

export function hasAdminSession(req: Request) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return false;
  const [expiresRaw, signature] = token.split(".");
  if (!expiresRaw || !signature) return false;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signature, sign(expiresRaw));
}

export function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  if (!hasAdminSession(req)) {
    res.redirect("/admin/login");
    return;
  }
  next();
}
