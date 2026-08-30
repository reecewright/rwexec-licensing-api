import crypto from "node:crypto";
import { config } from "../config.js";

export function normalizeLicenseKey(value: string): string {
  return value.trim().toUpperCase();
}

export function hashLicenseKey(value: string): string {
  return crypto
    .createHmac("sha256", config.LICENSE_KEY_PEPPER)
    .update(normalizeLicenseKey(value))
    .digest("hex");
}

function block(length = 4): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return result;
}

export function generateLicenseKey(productSlug: string): string {
  const prefix = productSlug === "rwexec-reservations" ? "RWRES" : "RWEXEC";
  return `${prefix}-${block()}-${block()}-${block()}-${block()}`;
}
