import crypto from "node:crypto";
import { prisma } from "../db.js";
import { writeAudit } from "./audit-service.js";
import { sendCustomerEmailChangeEmail } from "./email-service.js";

const EMAIL_CHANGE_TTL_MS = 30 * 60 * 1000;

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isEmail(value: string) {
  return /^\S+@\S+\.\S+$/.test(value);
}

async function sendEmailChangeMessage(input: {
  to: string;
  verifyUrl: string;
}) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();

  if (!apiKey || !from) {
    throw new Error("Customer email delivery is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: "Confirm your new RWExec email address",
      html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;color:#111827">
    <div style="max-width:620px;margin:0 auto;padding:32px 18px">
      <div style="background:#111827;border-radius:12px;padding:18px 22px;margin-bottom:18px">
        <div style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:.3px">RWExec</div>
      </div>
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
        <h1 style="font-size:22px;margin:0 0 12px">Confirm Your Email Address</h1>
        <p style="line-height:1.6;margin:0 0 20px">Use the button below to confirm this email address for your RWExec account. The link expires in 30 minutes.</p>
        <a
  href="${input.verifyUrl}"
  style="
    display:inline-block;
    background:#fe6b02;
    color:#111111;
    text-decoration:none;
    font-weight:700;
    padding:12px 18px;
    border-radius:8px;
  "
>
  Confirm Email Address
</a>
        <p style="font-size:13px;color:#6b7280;line-height:1.5;margin:22px 0 0">If you did not request this change, you can ignore this email and your current sign-in email will stay unchanged.</p>
      </div>
    </div>
  </body>
</html>`,
    }),
  });

  if (!response.ok) {
    let message = `Email delivery failed (${response.status}).`;
    try {
      const data = (await response.json()) as { message?: string };
      if (data.message) message = data.message;
    } catch {
      // Keep the generic delivery error.
    }
    throw new Error(message);
  }
}

export async function requestCustomerEmailChange(input: {
  customerId: string;
  newEmail: string;
  verifyUrlForToken: (token: string) => string;
}) {
  const newEmail = input.newEmail.trim().toLowerCase();
  if (!isEmail(newEmail)) throw new Error("Enter a valid email address.");

  const customer = await prisma.customer.findUnique({
    where: { id: input.customerId },
  });
  if (!customer) throw new Error("Customer account not found.");
  if (customer.email === newEmail) {
    throw new Error("That is already your account email address.");
  }

  const existing = await prisma.customer.findUnique({
    where: { email: newEmail },
  });
  if (existing && existing.id !== customer.id) {
    throw new Error("That email address is already in use.");
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);

  await prisma.$transaction(async (tx) => {
    await tx.customerEmailChangeToken.deleteMany({
      where: {
        customerId: customer.id,
        usedAt: null,
      },
    });

    await tx.customerEmailChangeToken.create({
      data: {
        customerId: customer.id,
        newEmail,
        tokenHash,
        expiresAt,
      },
    });
  });

  try {
    await sendCustomerEmailChangeEmail(
      newEmail,
      input.verifyUrlForToken(rawToken)
    );
  } catch (error) {
    await prisma.customerEmailChangeToken.deleteMany({
      where: { tokenHash },
    });
    throw error;
  }

  await writeAudit({
    action: "customer.email_change_requested",
    entityType: "customer",
    entityId: customer.id,
    summary: "Customer requested an account email change",
    metadata: { newEmail },
  });

  return { newEmail, expiresAt };
}

export async function consumeCustomerEmailChangeToken(rawToken: string) {
  const tokenHash = hashToken(rawToken);

  return prisma.$transaction(async (tx) => {
    const token = await tx.customerEmailChangeToken.findUnique({
      where: { tokenHash },
      include: { customer: true },
    });

    if (!token || token.usedAt || token.expiresAt <= new Date()) return null;

    const existing = await tx.customer.findUnique({
      where: { email: token.newEmail },
    });
    if (existing && existing.id !== token.customerId) return null;

    const previousEmail = token.customer.email;
    const customer = await tx.customer.update({
      where: { id: token.customerId },
      data: { email: token.newEmail },
    });

    await tx.customerEmailChangeToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });

    await tx.customerEmailChangeToken.deleteMany({
      where: {
        customerId: token.customerId,
        id: { not: token.id },
        usedAt: null,
      },
    });

    return {
      customerId: customer.id,
      previousEmail,
      newEmail: customer.email,
    };
  });
}
