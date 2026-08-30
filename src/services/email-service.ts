import { config } from "../config.js";
import { prisma } from "../db.js";
import { createPortalMagicLink } from "./customer-portal-service.js";
import { writeAudit } from "./audit-service.js";

export function customerEmailConfigured() {
  return Boolean(config.RESEND_API_KEY);
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!config.RESEND_API_KEY) return { sent: false, reason: "email_not_configured" as const };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.EMAIL_FROM, to: [to], subject, html })
  });
  if (!response.ok) throw new Error(`Email delivery failed (${response.status}): ${await response.text()}`);
  return { sent: true as const };
}

export async function sendCustomerPortalEmail(customerId: string, reason: "welcome" | "login" | "licence") {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new Error("Customer not found.");
  if (!config.RESEND_API_KEY) return { sent: false, reason: "email_not_configured" as const };
  const link = await createPortalMagicLink(customer.id);
  const subject = reason === "licence" ? "Your RWExec licence is ready" : reason === "welcome" ? "Welcome to RWExec" : "Your RWExec account sign-in link";
  const intro = reason === "licence" ? "Your RWExec subscription is active and your licence is ready to collect." : reason === "welcome" ? "Your RWExec account is ready." : "Use the secure link below to sign in to your RWExec account.";
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172033"><h1 style="font-size:24px">RWExec Software Solutions</h1><p>${intro}</p><p><a href="${link}" style="display:inline-block;background:#111827;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Open RWExec account</a></p><p style="color:#64748b;font-size:13px">This link expires in 30 minutes and can only be used once.</p></div>`;
  const result = await sendEmail(customer.email, subject, html);
  await writeAudit({ action: `customer.portal_email_${reason}`, entityType: "customer", entityId: customer.id, summary: `Customer portal email sent to ${customer.email}` });
  return result;
}
