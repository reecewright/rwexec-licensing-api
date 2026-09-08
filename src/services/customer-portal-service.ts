import crypto from "node:crypto";
import type { Response } from "express";
import { prisma } from "../db.js";
import { config } from "../config.js";

const PORTAL_COOKIE = "rwexec_customer_session";
const PORTAL_SESSION_SECONDS = 60 * 60 * 24 * 7;
const MAGIC_LINK_MINUTES = 30;

function deriveKey(label: string) {
  return crypto
    .createHmac("sha256", config.LICENSE_KEY_PEPPER)
    .update(`rwexec:${label}`)
    .digest();
}

function hashToken(token: string) {
  return crypto
    .createHmac("sha256", deriveKey("portal-token"))
    .update(token)
    .digest("hex");
}

function signSession(payload: string) {
  return crypto
    .createHmac("sha256", deriveKey("portal-session"))
    .update(payload)
    .digest("hex");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function createPortalMagicLink(customerId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_MINUTES * 60_000);

  await prisma.customerPortalToken.create({
    data: { customerId, tokenHash, expiresAt },
  });

  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/verify?token=${encodeURIComponent(token)}`;
}

export async function consumePortalMagicLink(token: string) {
  const tokenHash = hashToken(token);
  const record = await prisma.customerPortalToken.findUnique({
    where: { tokenHash },
  });

  if (!record || record.usedAt || record.expiresAt <= new Date()) return null;

  await prisma.customerPortalToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record.customerId;
}

export function setCustomerSession(res: Response, customerId: string) {
  const expires = Math.floor(Date.now() / 1000) + PORTAL_SESSION_SECONDS;
  const payload = `${customerId}.${expires}`;
  const token = `${payload}.${signSession(payload)}`;

  res.cookie(PORTAL_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: PORTAL_SESSION_SECONDS * 1000,
    path: "/account",
  });
}

export function clearCustomerSession(res: Response) {
  res.clearCookie(PORTAL_COOKIE, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    path: "/account",
  });
}

export function customerIdFromCookie(cookieHeader?: string) {
  if (!cookieHeader) return null;

  const raw = cookieHeader
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${PORTAL_COOKIE}=`));

  if (!raw) return null;

  const token = decodeURIComponent(raw.slice(PORTAL_COOKIE.length + 1));
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [customerId, expiresRaw, signature] = parts;
  const expires = Number(expiresRaw);

  if (
    !customerId ||
    !signature ||
    !Number.isFinite(expires) ||
    expires < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  const payload = `${customerId}.${expiresRaw}`;
  return safeEqual(signature, signSession(payload)) ? customerId : null;
}

function encryptLicenceKey(rawKey: string) {
  const key = deriveKey("licence-delivery");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(rawKey, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptStoredLicenceKey(secret: {
  ciphertext: string;
  iv: string;
  authTag: string;
}) {
  if (!secret.ciphertext || !secret.iv || !secret.authTag) return null;

  const key = deriveKey("licence-delivery");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(secret.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Persist the encrypted plaintext licence key for authenticated retrieval.
 *
 * The underlying Prisma model is still named LicenseDelivery for backwards
 * compatibility with the existing production database, but it is now treated
 * as permanent encrypted secret storage. The legacy expiresAt/claimedAt fields
 * are retained only so this release does not require a risky data migration.
 */
export async function storeLicenceSecret(
  licenseId: string,
  customerId: string,
  rawKey: string,
) {
  const encrypted = encryptLicenceKey(rawKey);

  // The legacy column is no longer used to decide whether a key can be revealed.
  // Give it a long compatibility value rather than preserving the old 7-day rule.
  const compatibilityExpiresAt = new Date("9999-12-31T23:59:59.000Z");

  await prisma.licenseDelivery.upsert({
    where: { licenseId },
    update: {
      customerId,
      ...encrypted,
      expiresAt: compatibilityExpiresAt,
      claimedAt: null,
    },
    create: {
      licenseId,
      customerId,
      ...encrypted,
      expiresAt: compatibilityExpiresAt,
    },
  });
}

export async function revealLicenceKey(licenseId: string, customerId: string) {
  const secret = await prisma.licenseDelivery.findUnique({
    where: { licenseId },
  });

  if (!secret || secret.customerId !== customerId) return null;

  try {
    return decryptStoredLicenceKey(secret);
  } catch {
    return null;
  }
}

// Compatibility exports for older route/service files while the codebase is
// transitioned from the old one-time “delivery” terminology. Neither function
// destroys the encrypted key or applies the old delivery expiry.
export const storeLicenceDelivery = storeLicenceSecret;
export async function claimLicenceDelivery(
  licenseId: string,
  customerId: string,
) {
  return revealLicenceKey(licenseId, customerId);
}
