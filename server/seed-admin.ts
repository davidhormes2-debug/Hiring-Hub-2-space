import { db } from "./db";
import { users, documentTemplates, smtpAccounts } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { logger } from "./logger";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "info@portermetricscareeronboarding.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_NAME = process.env.ADMIN_NAME || "Admin";

async function migrateUnhashedPasswords() {
  try {
    const allUsers = await db.select({ id: users.id, password: users.password }).from(users);
    let migrated = 0;
    for (const user of allUsers) {
      if (user.password && !user.password.startsWith("$2")) {
        const hashed = await bcrypt.hash(user.password, 12);
        await db.update(users).set({ password: hashed }).where(eq(users.id, user.id));
        migrated++;
      }
    }
    if (migrated > 0) {
      logger.info(`Migrated ${migrated} plain-text passwords to bcrypt`);
    }
  } catch (error) {
    logger.error("Failed to migrate passwords", error);
  }
}

export async function seedAdminUser() {
  try {
    const existingAdmin = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${ADMIN_EMAIL})`)
      .limit(1);

    if (!ADMIN_PASSWORD) {
      logger.warn("ADMIN_PASSWORD not set — skipping admin seed");
      await seedBuiltInTemplates();
      await seedSmtpAccounts();
      return;
    }

    if (existingAdmin.length === 0) {
      const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 12);
      await db.insert(users).values({
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password: hashedPassword,
        role: "admin",
        isApproved: "true",
      });
      logger.info("Admin user created successfully");
    } else {
      const passwordMatch = existingAdmin[0].password
        ? await bcrypt.compare(ADMIN_PASSWORD, existingAdmin[0].password)
        : false;
      if (!passwordMatch || existingAdmin[0].role !== "admin") {
        const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 12);
        await db
          .update(users)
          .set({ password: hashedPassword, role: "admin", isApproved: "true" })
          .where(eq(users.id, existingAdmin[0].id));
        logger.info("Admin user credentials synced");
      } else {
        logger.info("Admin user already exists");
      }
    }

    await migrateUnhashedPasswords();
    await seedBuiltInTemplates();
    await seedSmtpAccounts();
  } catch (error) {
    logger.error("Failed to seed admin user", error);
  }
}

const LINKEDIN_OUTREACH_TEMPLATE_NAME = "LinkedIn Referral Outreach";

function getLinkedInOutreachHtml(): string {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f0f4f8; padding: 40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width: 640px; width: 100%; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e293bdd 100%); padding: 32px 40px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align: middle;">
                    <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">[COMPANY NAME]</h1>
                    <p style="margin: 6px 0 0; font-size: 11px; color: rgba(255,255,255,0.7); letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">Human Resources</p>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <p style="margin: 0; font-size: 12px; color: rgba(255,255,255,0.6); font-weight: 500;">[DATE]</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 40px 44px 20px;">

              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.8; color: #1e293b;">Dear <strong>[APPLICANT NAME]</strong>,</p>

              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.8; color: #334155;">I hope this message finds you well.</p>

              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.8; color: #334155;">
                My name is <strong style="color: #0f172a;">[HR NAME]</strong>, and I am a member of the Human Resources team at <strong style="color: #0f172a;">[COMPANY NAME]</strong>. I am reaching out to you following a referral from our HR colleague, <strong style="color: #0f172a;">[REFERRAL NAME]</strong>, via <strong style="color: #0f172a;">[REFERRAL PLATFORM]</strong> regarding your interest in current job opportunities.
              </p>

              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.8; color: #334155;">
                Please find the job overview attached for your review. We kindly encourage you to go through the details carefully and confirm your interest if you would like to proceed to the next stage of the process.
              </p>

              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.8; color: #334155;">
                Once you have reviewed the information, please share your availability for a brief <strong>text-based training session</strong>, along with your <strong>WhatsApp number</strong>. This session will provide an introduction to the role, outline key expectations, and guide you through the onboarding process.
              </p>

              <!-- Referral Code Box -->
              <div style="background: linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%); border: 1px solid #bfdbfe; border-left: 4px solid #3b82f6; border-radius: 8px; padding: 20px 24px; margin: 28px 0;">
                <p style="margin: 0 0 4px; font-size: 11px; color: #3b82f6; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;">Your Referral Code</p>
                <p style="margin: 8px 0 0; font-size: 22px; font-weight: 800; color: #0f172a; letter-spacing: 1px; font-family: 'Courier New', Courier, monospace;">[REFERRAL CODE]</p>
                <p style="margin: 10px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">Please keep this code for your records. You may be asked to provide it during onboarding.</p>
              </div>

              <p style="margin: 20px 0; font-size: 15px; line-height: 1.8; color: #334155;">
                If you have any questions or need further clarification, please feel free to reach out. We are happy to assist.
              </p>

              <p style="margin: 0 0 0; font-size: 15px; line-height: 1.8; color: #334155;">We look forward to hearing from you.</p>

            </td>
          </tr>

          <!-- Signature -->
          <tr>
            <td style="padding: 8px 44px 36px;">
              <div style="border-top: 1px solid #e2e8f0; padding-top: 24px; margin-top: 8px;">
                <p style="margin: 0 0 2px; font-size: 14px; color: #94a3b8;">Kind regards,</p>
                <p style="margin: 12px 0 2px; font-size: 16px; font-weight: 700; color: #0f172a;">[HR NAME]</p>
                <p style="margin: 0 0 2px; font-size: 13px; color: #64748b;">Human Resources Team</p>
                <p style="margin: 0 0 2px; font-size: 13px; font-weight: 600; color: #334155;">[COMPANY NAME]</p>
                <p style="margin: 4px 0 0; font-size: 12px; color: #94a3b8; line-height: 1.6;">[COMPANY ADDRESS]</p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 44px; border-top: 1px solid #e8ecf1;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <img src="https://portermetricscareeronboarding.com/favicon.png" alt="The Metrics" style="width: 36px; height: 36px; border-radius: 8px; margin-bottom: 8px;" />
                    <p style="margin: 0 0 4px; font-size: 13px; font-weight: 700; color: #1e293b;">THE METRICS</p>
                    <p style="margin: 0; font-size: 11px; color: #94a3b8;">&copy; ${year} The Metrics Inc. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <!-- Legal -->
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width: 640px; width: 100%;">
          <tr>
            <td style="padding: 20px 40px; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #a0aec0; line-height: 1.8;">
                This is an official communication from [COMPANY NAME].<br>
                If you believe you received this message in error, please disregard it.
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function seedBuiltInTemplates() {
  try {
    const templateHtml = getLinkedInOutreachHtml();
    const templateSubject = "Job Opportunity — [COMPANY NAME] | Referred by [REFERRAL NAME]";
    const templatePlaceholders = ["APPLICANT NAME", "HR NAME", "REFERRAL NAME", "REFERRAL PLATFORM", "COMPANY NAME", "COMPANY ADDRESS", "REFERRAL CODE"];

    const existing = await db
      .select()
      .from(documentTemplates)
      .where(eq(documentTemplates.name, LINKEDIN_OUTREACH_TEMPLATE_NAME))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(documentTemplates).values({
        name: LINKEDIN_OUTREACH_TEMPLATE_NAME,
        subject: templateSubject,
        htmlBody: templateHtml,
        placeholders: templatePlaceholders,
        theme: "light",
        isBuiltIn: true,
      });
      logger.info("Built-in template seeded: LinkedIn Referral Outreach");
    } else {
      await db.update(documentTemplates)
        .set({ htmlBody: templateHtml, subject: templateSubject, placeholders: templatePlaceholders })
        .where(eq(documentTemplates.id, existing[0].id));
      logger.info("Built-in template updated: LinkedIn Referral Outreach");
    }
  } catch (error) {
    logger.error("Failed to seed built-in templates", error);
  }
}

async function seedSmtpAccounts() {
  try {
    const jonathanExisting = await db
      .select()
      .from(smtpAccounts)
      .where(eq(smtpAccounts.fromEmail, "jonathan@portermetricscareeronboarding.com"))
      .limit(1);

    const jonathanEmail = process.env.JONATHAN_SMTP_EMAIL || "jonathan@portermetricscareeronboarding.com";
    const jonathanPassword = process.env.JONATHAN_SMTP_PASSWORD || "";
    const jonathanHost = process.env.JONATHAN_SMTP_HOST || "smtp.hostinger.com";
    const jonathanName = process.env.JONATHAN_SMTP_NAME || "Jonathan Harry";

    if (jonathanPassword && jonathanExisting.length === 0) {
      await db.insert(smtpAccounts).values({
        name: "Jonathan HR",
        host: jonathanHost,
        port: 465,
        secure: true,
        username: jonathanEmail,
        password: jonathanPassword,
        fromEmail: jonathanEmail,
        fromName: jonathanName,
        companyTagline: "Human Resources Department",
        isDefault: false,
      });
      logger.info("SMTP account seeded: Jonathan HR");
    }

    const searchbloomEmail = process.env.SEARCHBLOOM_SMTP_EMAIL || "Support@Bloomintls.com";
    const searchbloomPassword = process.env.SEARCHBLOOM_SMTP_PASSWORD || "";
    const searchbloomHost = process.env.SEARCHBLOOM_SMTP_HOST || "smtp.zoho.com";
    const searchbloomName = process.env.SEARCHBLOOM_SMTP_NAME || "Searchbloom LLC";

    const searchbloomExisting = await db
      .select()
      .from(smtpAccounts)
      .where(eq(smtpAccounts.fromEmail, searchbloomEmail))
      .limit(1);

    if (searchbloomPassword && searchbloomExisting.length === 0) {
      await db.insert(smtpAccounts).values({
        name: searchbloomName,
        host: searchbloomHost,
        port: 465,
        secure: true,
        username: searchbloomEmail,
        password: searchbloomPassword,
        fromEmail: searchbloomEmail,
        fromName: searchbloomName,
        companyTagline: "Internet Marketing & Digital Growth Solutions",
        isDefault: false,
      });
      logger.info("SMTP account seeded: Searchbloom LLC");
    }

    const antavoEmail = process.env.ANTAVO_SMTP_EMAIL || "support@antavoicloudenterprises.com";
    const antavoPassword = process.env.ANTAVO_SMTP_PASSWORD || "";
    const antavoHost = process.env.ANTAVO_SMTP_HOST || "smtp.hostinger.com";
    const antavoName = process.env.ANTAVO_SMTP_NAME || "Antavo Cloud Enterprises";

    const antavoExisting = await db
      .select()
      .from(smtpAccounts)
      .where(eq(smtpAccounts.fromEmail, antavoEmail))
      .limit(1);

    if (antavoPassword && antavoExisting.length > 0) {
      await db.update(smtpAccounts)
        .set({ password: antavoPassword })
        .where(eq(smtpAccounts.id, antavoExisting[0].id));
      logger.info("SMTP account password updated: Antavo Cloud Enterprises");
    } else if (antavoPassword && antavoExisting.length === 0) {
      await db.insert(smtpAccounts).values({
        name: antavoName,
        host: antavoHost,
        port: 465,
        secure: true,
        username: antavoEmail,
        password: antavoPassword,
        fromEmail: antavoEmail,
        fromName: antavoName,
        companyTagline: "Cloud Enterprise Solutions",
        isDefault: false,
      });
      logger.info("SMTP account seeded: Antavo Cloud Enterprises");
    }
  } catch (error) {
    logger.error("Failed to seed SMTP accounts", error);
  }
}
