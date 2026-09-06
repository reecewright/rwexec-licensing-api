import { config } from "../config.js";
import { prisma } from "../db.js";
import { createPortalMagicLink } from "./customer-portal-service.js";
import { writeAudit } from "./audit-service.js";

export function customerEmailConfigured() {
  return Boolean(config.RESEND_API_KEY);
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!config.RESEND_API_KEY) {
    return {
      sent: false,
      reason: "email_not_configured" as const,
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: [to],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Email delivery failed (${response.status}): ${await response.text()}`,
    );
  }

  return {
    sent: true as const,
  };
}

function emailTemplate(input: {
  heading: string;
  intro: string;
  buttonText: string;
  link: string;
}) {
  return `
<!doctype html>
<html>
  <body
    style="
      margin:0;
      padding:0;
      background:#f3f5f8;
      font-family:Arial,Helvetica,sans-serif;
      color:#172033;
    "
  >
    <table
      role="presentation"
      width="100%"
      cellspacing="0"
      cellpadding="0"
      border="0"
      style="background:#f3f5f8;padding:32px 16px;"
    >
      <tr>
        <td align="center">

          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            border="0"
            style="
              max-width:620px;
              background:#ffffff;
              border:1px solid #e2e8f0;
              border-radius:14px;
              overflow:hidden;
            "
          >
            <tr>
              <td
                style="
                  background:#111827;
                  padding:24px 28px;
                  text-align:left;
                "
              >
                <div
                  <img
  src="https://account.rwexec.com/assets/rwexec-logo.png"
  alt="RWExec"
  width="150"
  style="
    display:block;
    width:150px;
    max-width:100%;
    height:auto;
    border:0;
  "
/>

<div
  style="
    margin-top:8px;
    font-size:12px;
    color:#cbd5e1;
    letter-spacing:0.4px;
  "
>
  Software Solutions
</div>
              </td>
            </tr>

            <tr>
              <td style="padding:34px 28px 10px 28px;">
                <h1
                  style="
                    margin:0;
                    font-size:26px;
                    line-height:1.25;
                    color:#172033;
                  "
                >
                  ${input.heading}
                </h1>
              </td>
            </tr>

            <tr>
              <td
                style="
                  padding:10px 28px 6px 28px;
                  font-size:16px;
                  line-height:1.6;
                  color:#334155;
                "
              >
                ${input.intro}
              </td>
            </tr>

            <tr>
              <td style="padding:24px 28px 30px 28px;">
                <table
                  role="presentation"
                  cellspacing="0"
                  cellpadding="0"
                  border="0"
                >
                  <tr>
                    <td
  bgcolor="#ff6a00"
  style="
    background:#ff6a00;
    border-radius:6px;
    padding:12px 18px;
  "
>
  <a
    href="${input.link}"
    style="
      display:inline-block;
      color:#ffffff;
      text-decoration:none;
      font-size:15px;
      font-weight:700;
      line-height:1;
    "
  >
    ${input.buttonText}
  </a>
</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td
                style="
                  padding:0 28px 28px 28px;
                  font-size:13px;
                  line-height:1.5;
                  color:#64748b;
                "
              >
                This secure link expires in 30 minutes and can only be used once.
              </td>
            </tr>

            <tr>
              <td
                style="
                  border-top:1px solid #e2e8f0;
                  padding:18px 28px;
                  font-size:12px;
                  line-height:1.5;
                  color:#94a3b8;
                "
              >
                RWExec Software Solutions
                <br />
                Automated account notification
              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

export async function sendCustomerPortalEmail(
  customerId: string,
  reason: "welcome" | "login" | "licence",
) {
  const customer = await prisma.customer.findUnique({
    where: {
      id: customerId,
    },
  });

  if (!customer) {
    throw new Error("Customer not found.");
  }

  if (!config.RESEND_API_KEY) {
    return {
      sent: false,
      reason: "email_not_configured" as const,
    };
  }

  const link = await createPortalMagicLink(customer.id);

  let subject: string;
  let heading: string;
  let intro: string;
  let buttonText: string;

  switch (reason) {
    case "licence":
      subject = "Your RWExec licence is ready";
      heading = "Your licence is ready";
      intro =
        "Your RWExec subscription is active and your licence is ready to collect from your customer account.";
      buttonText = "Collect licence";
      break;

    case "welcome":
      subject = "Welcome to RWExec";
      heading = "Welcome to RWExec";
      intro =
        "Your RWExec customer account is ready. Use the secure link below to open your account and manage your software.";
      buttonText = "Open my account";
      break;

    case "login":
    default:
      subject = "Your RWExec account sign-in link";
      heading = "Sign in to your account";
      intro =
        "Use the secure link below to sign in to your RWExec customer account.";
      buttonText = "Sign in securely";
      break;
  }

  const html = emailTemplate({
    heading,
    intro,
    buttonText,
    link,
  });

  const result = await sendEmail(customer.email, subject, html);

  await writeAudit({
    action: `customer.portal_email_${reason}`,
    entityType: "customer",
    entityId: customer.id,
    summary: `Customer portal email sent to ${customer.email}`,
  });

  return result;
}
