import { config } from "../config.js";
import { prisma } from "../db.js";
import { createPortalMagicLink } from "./customer-portal-service.js";
import { writeAudit } from "./audit-service.js";

export function customerEmailConfigured() {
  return Boolean(config.RESEND_API_KEY);
}

async function sendEmail(
  to: string,
  subject: string,
  html: string,
) {
  if (!config.RESEND_API_KEY) {
    return {
      sent: false,
      reason: "email_not_configured" as const,
    };
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
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
    },
  );

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
<html
  xmlns="http://www.w3.org/1999/xhtml"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:o="urn:schemas-microsoft-com:office:office"
>
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1"
    />

    <!--[if mso]>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
    <![endif]-->
  </head>

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
      style="
        width:100%;
        background:#f3f5f8;
      "
    >
      <tr>
        <td
          align="center"
          style="
            padding:32px 16px;
          "
        >

          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            border="0"
            style="
              width:100%;
              max-width:620px;
              background:#ffffff;
              border:1px solid #e2e8f0;
              border-radius:12px;
              overflow:hidden;
            "
          >

            <!-- HEADER -->
            <tr>
              <td
                style="
                  background:#111827;
                  padding:28px 30px;
                "
              >
                <img
                  src="https://account.rwexec.com/assets/rwexec-logo.png"
                  alt="RWExec Software Solutions"
                  width="220"
                  style="
                    display:block;
                    width:220px;
                    max-width:100%;
                    height:auto;
                    border:0;
                    outline:none;
                    text-decoration:none;
                  "
                />
              </td>
            </tr>

            <!-- HEADING -->
            <tr>
              <td
                style="
                  padding:36px 30px 10px 30px;
                "
              >
                <h1
                  style="
                    margin:0;
                    padding:0;
                    font-size:26px;
                    line-height:1.3;
                    font-weight:700;
                    color:#172033;
                  "
                >
                  ${input.heading}
                </h1>
              </td>
            </tr>

            <!-- INTRO -->
            <tr>
              <td
                style="
                  padding:10px 30px 4px 30px;
                  font-size:16px;
                  line-height:1.6;
                  color:#334155;
                "
              >
                ${input.intro}
              </td>
            </tr>

            <!-- BUTTON -->
            <tr>
              <td
                style="
                  padding:26px 30px 32px 30px;
                "
              >

                <!--[if mso]>
                <v:roundrect
                  xmlns:v="urn:schemas-microsoft-com:vml"
                  xmlns:w="urn:schemas-microsoft-com:office:word"
                  href="${input.link}"
                  style="
                    height:46px;
                    v-text-anchor:middle;
                    width:180px;
                  "
                  arcsize="12%"
                  stroke="f"
                  fillcolor="#ff6a00"
                >
                  <w:anchorlock/>
                  <center
                    style="
                      color:#111111;
                      font-family:Arial,sans-serif;
                      font-size:15px;
                      font-weight:bold;
                    "
                  >
                    ${input.buttonText}
                  </center>
                </v:roundrect>
                <![endif]-->

                <!--[if !mso]><!-->
                <a
                  href="${input.link}"
                  style="
                    display:inline-block;
                    background:#ff6a00;
                    color:#111111;
                    text-decoration:none;
                    font-size:15px;
                    line-height:20px;
                    font-weight:700;
                    padding:13px 20px;
                    border-radius:6px;
                  "
                >
                  ${input.buttonText}
                </a>
                <!--<![endif]-->

              </td>
            </tr>

            <!-- SECURITY NOTE -->
            <tr>
              <td
                style="
                  padding:0 30px 30px 30px;
                  font-size:13px;
                  line-height:1.6;
                  color:#64748b;
                "
              >
                This secure link expires in 30 minutes
                and can only be used once.
              </td>
            </tr>

            <!-- FOOTER -->
            <tr>
              <td
                style="
                  border-top:1px solid #e2e8f0;
                  padding:20px 30px;
                  font-size:12px;
                  line-height:1.6;
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

  const link = await createPortalMagicLink(
    customer.id,
  );

  let subject: string;
  let heading: string;
  let intro: string;
  let buttonText: string;

  switch (reason) {
    case "licence":
      subject =
        "Your RWExec licence is ready";

      heading =
        "Your licence is ready";

      intro =
        "Your RWExec subscription is active and your licence is ready to collect from your customer account.";

      buttonText =
        "Collect Licence";

      break;

    case "welcome":
      subject =
        "Welcome to RWExec";

      heading =
        "Welcome to RWExec";

      intro =
        "Your RWExec customer account is ready. Use the secure link below to open your account and manage your software.";

      buttonText =
        "Open My Account";

      break;

    case "login":
    default:
      subject =
        "Your RWExec account sign-in link";

      heading =
        "Sign in to your account";

      intro =
        "Use the secure link below to sign in to your RWExec customer account.";

      buttonText =
        "Sign In Securely";

      break;
  }

  const html = emailTemplate({
    heading,
    intro,
    buttonText,
    link,
  });

  const result = await sendEmail(
    customer.email,
    subject,
    html,
  );

  await writeAudit({
    action:
      `customer.portal_email_${reason}`,
    entityType: "customer",
    entityId: customer.id,
    summary:
      `Customer portal email sent to ${customer.email}`,
  });

  return result;
}