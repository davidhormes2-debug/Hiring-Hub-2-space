import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { storage } from "./storage";
import { logger } from "./logger";
import { getRegionalTerms } from "./region-utils";
import { db } from "./db";
import { smtpAccounts } from "@shared/schema";
import { eq } from "drizzle-orm";

const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || "smtp.hostinger.com",
  port: parseInt(process.env.SMTP_PORT || "465", 10),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || "info@portermetricscareeronboarding.com",
    pass: process.env.SMTP_PASSWORD,
  },
};

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    if (!SMTP_CONFIG.auth.pass) {
      logger.warn("SMTP_PASSWORD not configured — emails will fail");
    }
    transporter = nodemailer.createTransport(SMTP_CONFIG);
  }
  return transporter;
}

const transporterCache = new Map<number, { transporter: nodemailer.Transporter; fromEmail: string; fromName: string }>();

async function getTransporterForAccount(smtpAccountId: number): Promise<{ transporter: nodemailer.Transporter; fromEmail: string; fromName: string } | null> {
  const cached = transporterCache.get(smtpAccountId);
  if (cached) return cached;

  try {
    const [account] = await db.select().from(smtpAccounts).where(eq(smtpAccounts.id, smtpAccountId));
    if (!account) {
      logger.warn(`SMTP account ${smtpAccountId} not found`);
      return null;
    }

    const t = nodemailer.createTransport({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: {
        user: account.username,
        pass: account.password,
      },
    });

    const entry = { transporter: t, fromEmail: account.fromEmail, fromName: account.fromName };
    transporterCache.set(smtpAccountId, entry);
    return entry;
  } catch (error) {
    logger.error(`Failed to create transporter for SMTP account ${smtpAccountId}`, error);
    return null;
  }
}

export function clearSmtpTransporterCache(smtpAccountId?: number) {
  if (smtpAccountId !== undefined) {
    transporterCache.delete(smtpAccountId);
  } else {
    transporterCache.clear();
  }
}

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  fromEmail?: string;
  fromName?: string;
  smtpAccountId?: number;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }>;
}

interface EmailLogOptions {
  recipientEmail: string;
  recipientName?: string;
  emailType: string;
  subject: string;
  applicationId?: string;
  sentBy?: string;
}

async function getSystemFolderId(folderName: string): Promise<string | null> {
  try {
    const folders = await storage.getAllEmailFolders();
    const folder = folders.find(f => f.isSystem && f.name === folderName);
    return folder?.id || null;
  } catch {
    return null;
  }
}

function getEmailFolderName(emailType: string): string {
  const typeMap: Record<string, string> = {
    "welcome": "Welcome Emails",
    "welcome_email": "Welcome Emails",
    "onboarding": "Welcome Emails",
    "bulk_campaign": "Bulk Campaigns",
    "bulk": "Bulk Campaigns",
    "campaign": "Bulk Campaigns",
    "mass_email": "Bulk Campaigns",
  };
  return typeMap[emailType.toLowerCase()] || "Sent";
}

async function logEmail(options: EmailLogOptions, success: boolean, errorMessage?: string) {
  try {
    const folderName = getEmailFolderName(options.emailType);
    const folderId = await getSystemFolderId(folderName);
    await storage.createEmailLog({
      ...options,
      status: success ? "sent" : "failed",
      errorMessage: errorMessage,
      folderId,
    });
    if (folderId) {
      storage.updateEmailFolderCounts().catch(() => {});
    }
  } catch (err) {
    logger.error("Failed to log email", err);
  }
}

export async function sendEmail({ to, subject, html, attachments, fromEmail, fromName, smtpAccountId }: EmailOptions): Promise<boolean> {
  try {
    let activeTransporter = getTransporter();
    let senderEmail = fromEmail || process.env.SMTP_USER || SMTP_CONFIG.auth.user;
    let senderName = fromName || "The Metrics";

    if (smtpAccountId) {
      const accountTransporter = await getTransporterForAccount(smtpAccountId);
      if (accountTransporter) {
        activeTransporter = accountTransporter.transporter;
        senderEmail = fromEmail || accountTransporter.fromEmail;
        senderName = fromName || accountTransporter.fromName;
      } else {
        logger.warn(`SMTP account ${smtpAccountId} not found, falling back to default transporter`);
      }
    }

    const unsubscribeMailto = `mailto:info@portermetricscareeronboarding.com?subject=Unsubscribe&body=Please%20unsubscribe%20me`;
    const finalHtml = html.replace(/\{\{unsubscribe_url\}\}/g, unsubscribeMailto);
    await activeTransporter.sendMail({
      from: `"${senderName}" <${senderEmail}>`,
      to,
      subject,
      html: finalHtml,
      attachments: attachments || [],
      headers: {
        "List-Unsubscribe": `<${unsubscribeMailto}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    logger.info("Email sent successfully", { to, smtpAccountId });
    return true;
  } catch (error) {
    logger.error("Failed to send email", error, { to, smtpAccountId });
    return false;
  }
}

export async function sendEmailWithAttachment(
  to: string,
  subject: string,
  html: string,
  attachments: Array<{ filename: string; content: Buffer; contentType: string }>
): Promise<boolean> {
  return sendEmail({ to, subject, html, attachments });
}

export async function sendEmailWithLogging(
  { to, subject, html, attachments, smtpAccountId }: EmailOptions,
  logOptions: Omit<EmailLogOptions, 'recipientEmail' | 'subject'>
): Promise<boolean> {
  try {
    let activeTransporter = getTransporter();
    let senderEmail = process.env.SMTP_USER || SMTP_CONFIG.auth.user;
    let senderName = "The Metrics";

    if (smtpAccountId) {
      const accountTransporter = await getTransporterForAccount(smtpAccountId);
      if (accountTransporter) {
        activeTransporter = accountTransporter.transporter;
        senderEmail = accountTransporter.fromEmail;
        senderName = accountTransporter.fromName;
      } else {
        logger.warn(`SMTP account ${smtpAccountId} not found, falling back to default transporter`);
      }
    }

    const unsubscribeMailto = `mailto:info@portermetricscareeronboarding.com?subject=Unsubscribe&body=Please%20unsubscribe%20me`;
    const finalHtml = html.replace(/\{\{unsubscribe_url\}\}/g, unsubscribeMailto);
    await activeTransporter.sendMail({
      from: `"${senderName}" <${senderEmail}>`,
      to,
      subject,
      html: finalHtml,
      attachments: attachments || [],
      headers: {
        "List-Unsubscribe": `<${unsubscribeMailto}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    logger.info(`Email sent successfully to ${to}`);
    await logEmail({ ...logOptions, recipientEmail: to, subject }, true);
    return true;
  } catch (error: any) {
    logger.error("Failed to send email", error);
    await logEmail({ ...logOptions, recipientEmail: to, subject }, false, error.message);
    return false;
  }
}

interface EmailBranding {
  companyName?: string;
  companyTagline?: string;
  companyEmail?: string;
  companyFooterName?: string;
}

export function officialEmailWrapper(content: string, accentColor: string = '#0f172a', language: string = 'en', branding?: EmailBranding): string {
  const brandName = branding?.companyName || 'THE METRICS';
  const brandTagline = branding?.companyTagline || 'Global Remote Workforce Platform';
  const brandEmail = branding?.companyEmail || 'info@portermetricscareeronboarding.com';
  const brandFooter = branding?.companyFooterName || branding?.companyName || 'The Metrics Inc.';
  const dateLocale = language === "es" ? "es-ES" : language === "pt" ? "pt-BR" : language === "fr" ? "fr-FR" : language === "zh" ? "zh-CN" : language === "hi" ? "hi-IN" : "en-US";
  const htmlLang = language === "es" ? "es" : language === "pt" ? "pt" : language === "fr" ? "fr" : language === "zh" ? "zh" : language === "hi" ? "hi" : "en";
  const formattedDate = new Date().toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' });
  const accentLight = accentColor + '18';
  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f0f4f8; padding: 40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width: 640px; width: 100%; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);">

          <!-- Header with gradient accent -->
          <tr>
            <td style="background: linear-gradient(135deg, ${accentColor} 0%, ${accentColor}dd 100%); padding: 32px 40px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align: middle;">
                    <h1 style="margin: 0; font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; line-height: 1.2;">${brandName}</h1>
                    <p style="margin: 6px 0 0; font-size: 11px; color: rgba(255,255,255,0.75); letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">${brandTagline}</p>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <p style="margin: 0; font-size: 12px; color: rgba(255,255,255,0.7); font-weight: 500;">${formattedDate}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 40px 44px 44px;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 0 44px;">
              <div style="border-top: 1px solid #e8ecf1; margin: 0;"></div>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 44px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align: top;">
                    <p style="margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #1e293b;">${brandFooter}</p>
                    <p style="margin: 0; font-size: 12px; color: #64748b; line-height: 1.8;">
                      ${brandTagline}<br>
                      <a href="mailto:${brandEmail}" style="color: ${accentColor}; text-decoration: none; font-weight: 500;">${brandEmail}</a>
                    </p>
                  </td>
                  <td align="right" style="vertical-align: bottom;">
                    <p style="margin: 0; font-size: 11px; color: #94a3b8; line-height: 1.6;">&copy; ${new Date().getFullYear()} ${brandFooter}<br>All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <!-- Legal / Unsubscribe -->
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width: 640px; width: 100%;">
          <tr>
            <td style="padding: 20px 40px; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #a0aec0; line-height: 1.8;">
                This is an official communication from ${brandFooter}.<br>
                Please do not reply directly to this email.
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

function statusBadge(text: string, bgColor: string, textColor: string): string {
  return `<span style="display: inline-block; background-color: ${bgColor}; color: ${textColor}; padding: 7px 18px; border-radius: 20px; font-weight: 700; font-size: 12px; letter-spacing: 0.8px; text-transform: uppercase;">${text}</span>`;
}

function infoBox(content: string, borderColor: string = '#e2e8f0', bgColor: string = '#f8fafc'): string {
  return `<div style="background-color: ${bgColor}; border: 1px solid ${borderColor}33; border-left: 4px solid ${borderColor}; border-radius: 8px; padding: 22px 24px; margin: 24px 0;">${content}</div>`;
}

function ctaButton(text: string, url: string, bgColor: string = '#0f172a'): string {
  return `<div style="margin: 32px 0; text-align: center;">
    <a href="${url}" style="display: inline-block; background-color: ${bgColor}; color: #ffffff; padding: 16px 40px; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 14px; letter-spacing: 0.4px; box-shadow: 0 4px 14px ${bgColor}44;">${text}</a>
  </div>`;
}

function sectionHeading(text: string): string {
  return `<h2 style="margin: 32px 0 16px; font-size: 15px; font-weight: 700; color: #0f172a; padding-bottom: 10px; border-bottom: 2px solid #e2e8f0; letter-spacing: 0.2px;">${text}</h2>`;
}

export async function sendCustomEmail(
  to: string,
  subject: string,
  body: string,
  recipientName?: string,
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>,
  fromEmail?: string,
  fromName?: string
): Promise<boolean> {
  const content = `
    <div style="font-size: 15px; color: #334155; line-height: 1.7;">
      ${body.replace(/\n/g, '<br>')}
    </div>
  `;
  const html = officialEmailWrapper(content);
  const toAddress = recipientName ? `"${recipientName}" <${to}>` : to;
  return sendEmail({ to: toAddress, subject, html, attachments, fromEmail, fromName });
}

export async function sendBulkEmail(
  recipients: { email: string; name: string }[],
  subject: string,
  htmlTemplate: (name: string) => string,
  sentBy?: string,
  smtpAccountId?: number
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const html = htmlTemplate(recipient.name);
    const success = await sendEmailWithLogging(
      { to: recipient.email, subject, html, smtpAccountId },
      { recipientName: recipient.name, emailType: "bulk_announcement", sentBy }
    );
    if (success) sent++;
    else failed++;
  }

  return { sent, failed };
}

export async function sendApplicationRejectedEmail(email: string, name: string): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Thank you for your interest in the <strong>Remote Product Insights Upload Associate</strong> position at The Metrics. We appreciate the time you invested in your application.
    </p>

    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      After a thorough review, we regret to inform you that we are unable to proceed with your application at this time. This decision was not made lightly, and we encourage you to reapply as new opportunities become available.
    </p>

    ${infoBox(`
      <p style="margin: 0; font-size: 14px; color: #475569; line-height: 1.6;">
        <strong>What you can do:</strong> Continue developing your skills and consider reapplying in the future. Our team regularly opens new positions, and we welcome returning applicants.
      </p>
    `, '#e2e8f0')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      If you have any questions about this decision, please contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: email,
    subject: "Application Status Update — The Metrics",
    html: officialEmailWrapper(content, '#64748b'),
  });
}

export async function sendTrainingScheduledEmail(
  email: string, 
  name: string, 
  trainerName: string, 
  sessionTime: string
): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Your training session has been ${statusBadge('Scheduled', '#dbeafe', '#1e40af')}. Please review the details below and ensure you are available at the designated time.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px; vertical-align: top;">Trainer</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainerName}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Session Time</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${sessionTime}</td>
        </tr>
      </table>
    `, '#3b82f6')}

    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      Please log in to your profile to confirm your attendance or reschedule if needed.
    </p>

    ${ctaButton('View Training Details', 'https://www.portermetricscareeronboarding.com/status')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      For questions or to reschedule, contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: email,
    subject: "Training Session Scheduled — The Metrics",
    html: officialEmailWrapper(content, '#3b82f6'),
  });
}

export async function sendApplicationReceivedEmail(email: string, name: string): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Thank you for submitting your application for the <strong>Remote Product Insights Upload Associate</strong> position at The Metrics. Your application has been ${statusBadge('Received', '#dbeafe', '#1e40af')} and is now under review.
    </p>

    ${sectionHeading('What Happens Next')}
    <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li>Our recruitment team will review your application within 24–48 hours</li>
      <li>You will receive an email notification once a decision has been made</li>
      <li>You may check your application status at any time using your email</li>
    </ol>

    ${ctaButton('Check Application Status', 'https://www.portermetricscareeronboarding.com/status')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      If you have any questions, please contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: email,
    subject: "Application Received — The Metrics",
    html: officialEmailWrapper(content),
  });
}

export async function sendTrainingReminderEmail(
  email: string, 
  name: string, 
  trainerName: string, 
  sessionTime: string,
  hoursUntil: number
): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      This is a reminder that your scheduled training session is in <strong>${hoursUntil} hours</strong>. Please ensure you are prepared and available.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px; vertical-align: top;">Trainer</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainerName}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Session Time</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${sessionTime}</td>
        </tr>
      </table>
    `, '#f59e0b', '#fffbeb')}

    ${sectionHeading('Preparation Checklist')}
    <ul style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li>Ensure you have a stable internet connection</li>
      <li>Find a quiet environment for the training session</li>
      <li>Prepare any questions for your trainer</li>
    </ul>

    ${ctaButton('View Training Details', 'https://www.portermetricscareeronboarding.com/status')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      If you need to reschedule, contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: email,
    subject: `Training Reminder — Session in ${hoursUntil} Hours | The Metrics`,
    html: officialEmailWrapper(content, '#f59e0b'),
  });
}

export async function sendTrainerSignupNotificationEmail(
  trainerName: string,
  trainerEmail: string
): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      A new trainer has submitted an application on The Metrics platform. Please review their profile at your earliest convenience.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 100px; vertical-align: top;">Name</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainerName}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Email</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;"><a href="mailto:${trainerEmail}" style="color: #3b82f6; text-decoration: none;">${trainerEmail}</a></td>
        </tr>
      </table>
    `, '#3b82f6')}

    ${ctaButton('Review in Admin Dashboard', 'https://www.portermetricscareeronboarding.com/admin/login')}
  `;

  return sendEmail({
    to: "info@portermetricscareeronboarding.com",
    subject: `New Trainer Application — ${trainerName}`,
    html: officialEmailWrapper(content),
  });
}

export async function sendTrainerWelcomeEmail(
  email: string,
  name: string
): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Welcome to The Metrics. Your trainer account has been successfully created. You will be granted full dashboard access once an administrator has reviewed and certified your profile.
    </p>

    ${sectionHeading('Onboarding Process')}
    <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li>An administrator will review your profile and credentials</li>
      <li>Upon certification, you will receive full access to the trainer dashboard</li>
      <li>You can then create training sessions and onboard new associates</li>
    </ol>

    ${ctaButton('Access Staff Portal', 'https://www.portermetricscareeronboarding.com/staff-login')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      If you have any questions, contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: email,
    subject: "Welcome to The Metrics — Trainer Account Created",
    html: officialEmailWrapper(content),
  });
}

export async function sendReferrerNotificationEmail(
  referrerEmail: string,
  referrerName: string,
  applicantName: string,
  referralCode: string
): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${referrerName}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      We are pleased to notify you that a new applicant has submitted an application using your referral code.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px; vertical-align: top;">Applicant Name</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${applicantName}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Referral Code Used</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 700; font-family: 'Courier New', monospace;">${referralCode}</td>
        </tr>
      </table>
    `, '#16a34a', '#f0fdf4')}

    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      The application is currently under review. You will receive updates as it progresses through the hiring process. Thank you for contributing to the growth of The Metrics community.
    </p>

    ${ctaButton('View Your Referrals Dashboard', 'https://www.portermetricscareeronboarding.com/staff-login')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      Questions? Contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: referrerEmail,
    subject: `Referral Notification — ${applicantName} Has Applied | The Metrics`,
    html: officialEmailWrapper(content, '#16a34a'),
  });
}

export async function sendTrainerAssignmentEmail(
  trainerEmail: string,
  trainerName: string,
  applicantName: string,
  applicantEmail: string,
  applicantPhone: string | null,
  sessionTime: string
): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${trainerName}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      A new trainee has been assigned to you. Please review the details below and prepare for the upcoming training session.
    </p>

    ${sectionHeading('Trainee Details')}
    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px; vertical-align: top;">Trainee Name</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${applicantName}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Email</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;"><a href="mailto:${applicantEmail}" style="color: #3b82f6; text-decoration: none;">${applicantEmail}</a></td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Phone / WhatsApp</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${applicantPhone ? `<a href="https://wa.me/${applicantPhone.replace(/[^0-9]/g, '')}" style="color: #25d366; text-decoration: none;">${applicantPhone}</a>` : '<span style="color: #94a3b8; font-style: italic;">Not provided</span>'}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Training Session</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${sessionTime}</td>
        </tr>
      </table>
    `, '#3b82f6')}

    ${sectionHeading('Your Responsibilities')}
    <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li>Reach out to the trainee before the session to introduce yourself</li>
      <li>Prepare the training materials and ensure readiness for the scheduled session</li>
      <li>Guide the trainee through the onboarding process on the workbench</li>
      <li>Provide hands-on support as they complete their initial assignments</li>
    </ol>

    ${ctaButton('Go to Trainer Dashboard', 'https://www.portermetricscareeronboarding.com/staff-login')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      If you have any questions, contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: trainerEmail,
    subject: `New Trainee Assigned — ${applicantName} | The Metrics`,
    html: officialEmailWrapper(content),
  });
}

export async function sendTrainerInfoToTrainee(
  traineeEmail: string,
  traineeName: string,
  trainerName: string,
  trainerEmail: string,
  trainerWhatsApp: string | null,
  trainerReferralCode: string | null,
  onboardingUrl: string
): Promise<boolean> {
  const contactRows = `
    <tr>
      <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px; vertical-align: top;">Trainer Name</td>
      <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainerName}</td>
    </tr>
    <tr>
      <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Email</td>
      <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;"><a href="mailto:${trainerEmail}" style="color: #3b82f6; text-decoration: none;">${trainerEmail}</a></td>
    </tr>
    ${trainerWhatsApp ? `<tr>
      <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">WhatsApp</td>
      <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;"><a href="https://wa.me/${trainerWhatsApp.replace(/[^0-9]/g, '')}" style="color: #25d366; text-decoration: none;">${trainerWhatsApp}</a></td>
    </tr>` : `<tr>
      <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">WhatsApp</td>
      <td style="padding: 4px 0; font-size: 14px; color: #94a3b8; font-style: italic;">Not provided</td>
    </tr>`}
    ${trainerReferralCode ? `<tr>
      <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Referral Code</td>
      <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 700; font-family: 'Courier New', monospace;">${trainerReferralCode}</td>
    </tr>` : ''}
  `;

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${traineeName}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Below you will find the contact information for your assigned trainer at The Metrics. Please reach out to them for guidance and practical training support.
    </p>

    ${sectionHeading('Your Assigned Trainer')}
    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        ${contactRows}
      </table>
    `, '#3b82f6')}

    ${trainerReferralCode ? `
    <div style="background-color: #fef2f2; border: 2px solid #dc2626; border-radius: 4px; padding: 20px; margin: 24px 0; text-align: center;">
      <p style="margin: 0 0 12px; font-size: 14px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px;">Mandatory — Use This Referral Code During Registration</p>
      <div style="background-color: #ffffff; border: 2px dashed #dc2626; padding: 14px 24px; border-radius: 4px; display: inline-block;">
        <span style="font-size: 26px; font-weight: 700; font-family: 'Courier New', monospace; color: #dc2626; letter-spacing: 3px;">${trainerReferralCode}</span>
      </div>
      <p style="margin: 12px 0 0; font-size: 12px; color: #991b1b;">This code links your account to your assigned trainer.</p>
    </div>
    ` : ''}

    ${sectionHeading('Registration Guide')}
    <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li><strong>Register on the Affiliate Platform</strong> using the link below</li>
      ${trainerReferralCode ? `<li><strong>Enter referral code <span style="color: #dc2626; font-family: 'Courier New', monospace;">${trainerReferralCode}</span></strong> during sign-up</li>` : ''}
      <li><strong>Contact your trainer</strong> (${trainerName}) via ${trainerWhatsApp ? 'WhatsApp or ' : ''}email</li>
      <li><strong>Complete your training</strong> as instructed by your trainer</li>
      <li><strong>Begin earning</strong> once training is confirmed complete</li>
    </ol>

    ${ctaButton('Register on Affiliate Platform', onboardingUrl, '#16a34a')}
    <p style="text-align: center; margin: -16px 0 20px;">
      <a href="${onboardingUrl}" style="font-size: 12px; color: #3b82f6; word-break: break-all;">${onboardingUrl}</a>
    </p>

    ${ctaButton('Check Your Application Status', 'https://www.portermetricscareeronboarding.com/status')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      If you have any questions, contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: traineeEmail,
    subject: `Your Trainer Information & Registration Guide | The Metrics`,
    html: officialEmailWrapper(content),
  });
}

export async function sendNewApplicationNotificationEmail(
  applicantName: string,
  applicantEmail: string,
  resumeUrl: string | null,
  country: string | null,
  experienceLevel: string | null,
  motivation: string | null
): Promise<boolean> {
  const baseUrl = "https://www.portermetricscareeronboarding.com";
  const fullResumeUrl = resumeUrl ? `${baseUrl}${resumeUrl}` : null;

  const content = `
    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      A new application has been submitted for the <strong>Remote Product Insights Upload Associate</strong> position. Please review the details below.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px; vertical-align: top;">Name</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${applicantName}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Email</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;"><a href="mailto:${applicantEmail}" style="color: #3b82f6; text-decoration: none;">${applicantEmail}</a></td>
        </tr>
        ${country ? `<tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Country</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${country}</td>
        </tr>` : ''}
        ${experienceLevel ? `<tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Experience</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${experienceLevel}</td>
        </tr>` : ''}
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Resume</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${fullResumeUrl ? `<a href="${fullResumeUrl}" style="color: #3b82f6; text-decoration: none;">View Resume</a>` : '<em style="color: #94a3b8;">Not provided</em>'}</td>
        </tr>
      </table>
    `, '#3b82f6')}

    ${motivation ? `
    ${sectionHeading('Applicant Motivation')}
    <div style="background-color: #fffbeb; border: 1px solid #fde68a; border-left: 3px solid #f59e0b; border-radius: 4px; padding: 20px; margin: 16px 0;">
      <p style="margin: 0; font-size: 14px; color: #475569; font-style: italic; line-height: 1.7;">"${motivation}"</p>
    </div>
    ` : ''}

    ${ctaButton('Review Application', 'https://www.portermetricscareeronboarding.com/admin/login')}
  `;

  return sendEmail({
    to: "info@portermetricscareeronboarding.com",
    subject: `New Application — ${applicantName} | The Metrics`,
    html: officialEmailWrapper(content),
  });
}

function drawCompanyStamp(doc: PDFKit.PDFDocument, centerX: number, centerY: number, radius: number, companyName: string = 'THE METRICS INC.') {
  doc.save();
  doc.translate(centerX, centerY);
  doc.rotate(-8);
  doc.opacity(0.85);

  const stampColor = '#b91c1c';

  doc.circle(0, 0, radius).lineWidth(2.5).strokeColor(stampColor).stroke();
  doc.circle(0, 0, radius - 4).lineWidth(1).strokeColor(stampColor).stroke();
  doc.circle(0, 0, radius - 18).lineWidth(0.75).strokeColor(stampColor).stroke();

  doc.fillColor(stampColor).fontSize(radius * 0.22).font('Helvetica-Bold');
  doc.text(companyName.toUpperCase(), -radius + 10, -radius * 0.55, {
    width: (radius - 10) * 2,
    align: 'center',
  });

  const starSize = radius * 0.18;
  const starY = -2;
  doc.save();
  doc.translate(0, starY);
  const points = 5;
  const outerR = starSize;
  const innerR = starSize * 0.4;
  doc.moveTo(0, -outerR);
  for (let i = 0; i < points; i++) {
    const outerAngle = (Math.PI * 2 * i) / points - Math.PI / 2;
    const innerAngle = outerAngle + Math.PI / points;
    doc.lineTo(Math.cos(outerAngle) * outerR, Math.sin(outerAngle) * outerR);
    doc.lineTo(Math.cos(innerAngle) * innerR, Math.sin(innerAngle) * innerR);
  }
  doc.closePath().fill(stampColor);
  doc.restore();

  const dotRadius = 2;
  const dotCount = 8;
  const dotRingRadius = radius - 11;
  for (let i = 0; i < dotCount; i++) {
    const angle = (Math.PI * 2 * i) / dotCount - Math.PI / 2;
    doc.circle(Math.cos(angle) * dotRingRadius, Math.sin(angle) * dotRingRadius, dotRadius).fill(stampColor);
  }

  doc.fillColor(stampColor).fontSize(radius * 0.17).font('Helvetica-Bold');
  doc.text('CERTIFIED', -radius + 10, radius * 0.12, {
    width: (radius - 10) * 2,
    align: 'center',
  });

  doc.fillColor(stampColor).fontSize(radius * 0.14).font('Helvetica');
  doc.text('EST. 2024', -radius + 10, radius * 0.38, {
    width: (radius - 10) * 2,
    align: 'center',
  });

  doc.restore();
}

function drawSignature(doc: PDFKit.PDFDocument, x: number, y: number, signerName: string, signerTitle: string, companyName?: string) {
  doc.save();
  const inkColor = '#1e293b';

  try {
    const path = require('path');
    const fs = require('fs');
    const signaturePath = path.resolve(process.cwd(), 'server', 'assets', 'signature.png');
    if (fs.existsSync(signaturePath)) {
      doc.image(signaturePath, x, y - 10, { width: 110, height: 24 });
    }
  } catch {
    doc.strokeColor(inkColor).lineWidth(1.2).lineCap('round').lineJoin('round');
    doc.moveTo(x, y)
      .bezierCurveTo(x + 8, y - 12, x + 18, y + 6, x + 30, y - 4)
      .bezierCurveTo(x + 38, y - 10, x + 48, y + 8, x + 55, y - 2)
      .bezierCurveTo(x + 62, y - 8, x + 72, y + 5, x + 80, y - 3)
      .bezierCurveTo(x + 88, y - 10, x + 95, y + 4, x + 105, y - 1)
      .stroke();
    doc.lineWidth(0.8);
    doc.moveTo(x + 30, y + 3)
      .bezierCurveTo(x + 40, y + 10, x + 50, y - 3, x + 65, y + 5)
      .bezierCurveTo(x + 75, y + 10, x + 85, y + 2, x + 95, y + 6)
      .stroke();
  }

  doc.moveTo(x - 5, y + 18).lineTo(x + 115, y + 18).lineWidth(0.5).strokeColor('#94a3b8').stroke();

  doc.fillColor(inkColor).fontSize(10).font('Helvetica-Bold');
  doc.text(signerName, x - 5, y + 23, { width: 120 });
  doc.fillColor('#64748b').fontSize(8).font('Helvetica');
  doc.text(signerTitle, x - 5, y + 35, { width: 120 });

  doc.restore();
}

export interface OfferLetterData {
  applicantName: string;
  applicantEmail: string;
  applicantWhatsapp?: string;
  offerId: string;
  trainerName?: string;
  trainerEmail?: string;
  trainerWhatsapp?: string;
  trainerCode?: string;
  sessionTime?: string;
  sessionTimezone?: string;
  scheduleTrainingUrl?: string;
  country?: string | null;
}

function generateOfferLetterPDF(data: OfferLetterData): Promise<Buffer> {
  const t = getRegionalTerms(data.country);

  return new Promise((resolve, reject) => {
    const { applicantName, offerId, trainerName, trainerEmail, trainerWhatsapp, sessionTime, sessionTimezone } = data;
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = 595.28;
    const pageHeight = 841.89;

    const offerSubtitle = t.language === "es" ? "OFERTA OFICIAL DE EMPLEO"
      : t.language === "pt" ? "OFERTA OFICIAL DE EMPREGO"
      : t.language === "fr" ? "OFFRE OFFICIELLE D'EMPLOI"
      : t.language === "zh" ? "OFFICIAL OFFER OF EMPLOYMENT"
      : "OFFICIAL OFFER OF EMPLOYMENT";

    const pdfLang = (t.language === "zh" || t.language === "hi") ? "en" : t.language;
    const dateLocale = pdfLang === "es" ? "es-ES" : pdfLang === "pt" ? "pt-BR" : pdfLang === "fr" ? "fr-FR" : "en-US";
    const dateStr = new Date().toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' });
    const dateLabel = pdfLang === "es" ? "Fecha" : pdfLang === "pt" ? "Data" : pdfLang === "fr" ? "Date" : "Date";
    const refLabel = pdfLang === "es" ? "Referencia" : pdfLang === "pt" ? "Referência" : pdfLang === "fr" ? "Référence" : "Reference";

    doc.rect(20, 20, pageWidth - 40, pageHeight - 40).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    doc.rect(24, 24, pageWidth - 48, pageHeight - 48).lineWidth(0.25).strokeColor('#e2e8f0').stroke();

    doc.rect(24, 24, pageWidth - 48, 70).fill('#0f172a');
    doc.fillColor('#ffffff').fontSize(26).font('Helvetica-Bold')
      .text('THE METRICS', 50, 42, { align: 'center', width: pageWidth - 100 });
    doc.fontSize(9).fillColor('#94a3b8').font('Helvetica')
      .text(offerSubtitle, 50, 68, { align: 'center', width: pageWidth - 100 });

    doc.y = 110;
    doc.fillColor('#64748b').fontSize(9).font('Helvetica');
    doc.text(`${dateLabel}: ${dateStr}`, 50, 110);
    doc.text(`${refLabel}: ${offerId}`, 50, 110, { align: 'right', width: pageWidth - 100 });

    doc.y = 128;
    doc.moveTo(50, 128).lineTo(pageWidth - 50, 128).lineWidth(0.5).strokeColor('#e2e8f0').stroke();

    const greetingText = t.language === "es" ? `Estimado/a ${applicantName},`
      : t.language === "pt" ? `Prezado(a) ${applicantName},`
      : t.language === "fr" ? `Cher(e) ${applicantName},`
      : t.language === "zh" ? `Dear ${applicantName},`
      : `Dear ${applicantName},`;

    doc.y = 145;
    doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold')
      .text(greetingText, 50);
    doc.moveDown(0.7);

    const bodyText = t.language === "es"
      ? `Nos complace extenderle esta oferta oficial de empleo para el puesto de ${t.positionTitle} en The Metrics Inc. Su solicitud ha sido revisada y aprobada, y creemos que será una excelente incorporación a nuestro equipo global.`
      : t.language === "pt"
      ? `Temos o prazer de lhe oferecer esta oferta oficial de emprego para o cargo de ${t.positionTitle} na The Metrics Inc. Sua candidatura foi analisada e aprovada, e acreditamos que você será uma excelente adição à nossa equipe global.`
      : t.language === "fr"
      ? `Nous avons le plaisir de vous adresser cette offre officielle d'emploi pour le poste de ${t.positionTitle} chez The Metrics Inc. Votre candidature a été examinée et approuvée, et nous sommes convaincus que vous serez un excellent atout pour notre équipe mondiale.`
      : `We are pleased to extend this official offer of employment for the position of ${t.positionTitle} at The Metrics Inc. Your application has been reviewed and approved, and we believe you will be an excellent addition to our global team.`;

    doc.font('Helvetica').fontSize(11).fillColor('#334155');
    doc.text(bodyText, 50, doc.y, { align: 'justify', lineGap: 3, width: pageWidth - 100 });
    doc.moveDown(1.2);

    const compLabel = t.language === "es" ? "ESTRUCTURA DE COMPENSACIÓN"
      : t.language === "pt" ? "ESTRUTURA DE COMPENSAÇÃO"
      : t.language === "fr" ? "STRUCTURE DE RÉMUNÉRATION"
      : "COMPENSATION STRUCTURE";
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(compLabel, 50);
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(200, doc.y).lineWidth(1.5).strokeColor('#0f172a').stroke();
    doc.moveDown(0.6);

    const tableTop = doc.y;
    doc.rect(50, tableTop, pageWidth - 100, 22).fill('#0f172a');
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
    doc.text('Upload Type', 60, tableTop + 7, { width: 200 });
    doc.text('Commission Rate', 280, tableTop + 7, { width: 120 });
    doc.text('Multiplier', 430, tableTop + 7, { width: 100 });

    const rows = [
      ['Standard Product Upload', '0.5% — 2%', '1x'],
      ['Combination Product Upload', '0.5% — 2%', '6x'],
    ];

    let rowY = tableTop + 22;
    rows.forEach((row, i) => {
      doc.rect(50, rowY, pageWidth - 100, 22).fill(i % 2 === 0 ? '#f8fafc' : '#ffffff');
      doc.rect(50, rowY, pageWidth - 100, 22).lineWidth(0.25).strokeColor('#e2e8f0').stroke();
      doc.fillColor('#334155').fontSize(10).font('Helvetica').text(row[0], 60, rowY + 6, { width: 200 });
      doc.fillColor('#16a34a').font('Helvetica-Bold').text(row[1], 280, rowY + 6, { width: 120 });
      doc.fillColor(row[2] === '6x' ? '#dc2626' : '#334155').font('Helvetica-Bold').text(row[2], 430, rowY + 6, { width: 100 });
      rowY += 22;
    });

    doc.y = rowY + 16;

    const perfLabel = t.language === "es" ? "NIVELES DE RENDIMIENTO"
      : t.language === "pt" ? "NÍVEIS DE DESEMPENHO"
      : t.language === "fr" ? "NIVEAUX DE PERFORMANCE"
      : "PERFORMANCE TIERS";
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(perfLabel, 50);
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(200, doc.y).lineWidth(1.5).strokeColor('#0f172a').stroke();
    doc.moveDown(0.6);
    doc.fillColor('#334155').fontSize(10).font('Helvetica');
    doc.text('Bronze (Entry) \u2192 Silver (50+ uploads/mo, +10%) \u2192 Gold (100+ uploads/mo, +25%) \u2192 Diamond (200+ uploads/mo, +40%)', 50, doc.y, { lineGap: 2, width: pageWidth - 100 });
    doc.moveDown(1.2);

    if (trainerName) {
      const trainerLabel = t.language === "es" ? "SU ENTRENADOR ASIGNADO"
        : t.language === "pt" ? "SEU TREINADOR DESIGNADO"
        : t.language === "fr" ? "VOTRE FORMATEUR ASSIGNÉ"
        : "YOUR ASSIGNED TRAINER";
      doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(trainerLabel, 50);
      doc.moveDown(0.4);
      doc.moveTo(50, doc.y).lineTo(200, doc.y).lineWidth(1.5).strokeColor('#0f172a').stroke();
      doc.moveDown(0.6);

      const boxY = doc.y;
      doc.rect(50, boxY, pageWidth - 100, 50).fill('#f8fafc').stroke('#e2e8f0');
      doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text(trainerName, 65, boxY + 10);
      if (trainerEmail) doc.fillColor('#64748b').fontSize(10).font('Helvetica').text(`Email: ${trainerEmail}`, 65, boxY + 24);
      if (trainerWhatsapp) doc.text(`WhatsApp: ${trainerWhatsapp}`, 300, boxY + 24);
      if (sessionTime) doc.fillColor('#16a34a').font('Helvetica-Bold').text(`Training: ${sessionTime}${sessionTimezone ? ` (${sessionTimezone})` : ''}`, 65, boxY + 38);
      doc.y = boxY + 60;
    }

    const keyLabel = t.language === "es" ? "INFORMACIÓN IMPORTANTE"
      : t.language === "pt" ? "INFORMAÇÕES IMPORTANTES"
      : t.language === "fr" ? "INFORMATIONS CLÉS"
      : "KEY INFORMATION";
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(keyLabel, 50);
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(200, doc.y).lineWidth(1.5).strokeColor('#0f172a').stroke();
    doc.moveDown(0.6);
    doc.fillColor('#334155').fontSize(10).font('Helvetica');
    const points = t.language === "es" ? [
      'Esta oferta es válida por 7 días calendario desde la fecha indicada',
      'Todas las cargas de productos están sujetas a inspección de calidad',
      'Las comisiones se acreditan instantáneamente tras la aprobación',
      'Compromiso diario estimado: menos de 1 hora',
    ] : t.language === "pt" ? [
      'Esta oferta é válida por 7 dias corridos a partir da data acima',
      'Todos os uploads de produtos estão sujeitos a inspeção de qualidade',
      'As comissões são creditadas instantaneamente após aprovação',
      'Comprometimento diário estimado: menos de 1 hora',
    ] : t.language === "fr" ? [
      'Cette offre est valable 7 jours calendaires à compter de la date ci-dessus',
      'Tous les téléchargements de produits sont soumis à un contrôle qualité',
      'Les commissions sont créditées instantanément après approbation',
      'Engagement quotidien estimé : moins d\'1 heure',
    ] : [
      'This offer is valid for 7 calendar days from the date above',
      'All product uploads are subject to quality inspection',
      'Commissions are credited instantly upon approval',
      'Estimated daily commitment: under 1 hour',
    ];
    points.forEach(p => {
      doc.text(`\u2022  ${p}`, 50, doc.y, { lineGap: 2, width: pageWidth - 100 });
      doc.moveDown(0.3);
    });

    doc.moveDown(1);

    const closingText = t.language === "es" ? 'Esperamos tenerle como parte de nuestro equipo.'
      : t.language === "pt" ? 'Estamos ansiosos para tê-lo(a) como parte da nossa equipe.'
      : t.language === "fr" ? 'Nous avons hâte de vous compter parmi notre équipe.'
      : 'We look forward to having you as part of our team.';
    const regardsText = t.language === "es" ? 'Atentamente,'
      : t.language === "pt" ? 'Atenciosamente,'
      : t.language === "fr" ? 'Cordialement,'
      : 'Warm regards,';

    doc.fillColor('#334155').fontSize(11).font('Helvetica')
      .text(closingText, 50);
    doc.moveDown(0.8);
    doc.text(regardsText, 50);
    doc.moveDown(0.5);

    const maxSigY = pageHeight - 160;
    const offerSigY = Math.min(doc.y, maxSigY);
    drawSignature(doc, 50, offerSigY, 'The Metrics', 'Recruitment Dept.');

    const deptName = t.language === "es" ? 'Departamento de Reclutamiento de The Metrics'
      : t.language === "pt" ? 'Departamento de Recrutamento da The Metrics'
      : t.language === "fr" ? 'Département de Recrutement de The Metrics'
      : 'The Metrics Recruitment Department';
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(deptName, 50, offerSigY + 48);
    doc.fillColor('#64748b').font('Helvetica').fontSize(9).text('info@portermetricscareeronboarding.com', 50);

    drawCompanyStamp(doc, pageWidth - 120, offerSigY + 15, 45);

    doc.rect(24, pageHeight - 55, pageWidth - 48, 31).fill('#0f172a');
    doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
      .text('The Metrics Inc.  |  Global Remote Workforce Platform  |  Confidential', 50, pageHeight - 48, { align: 'center', width: pageWidth - 100 });
    doc.fillColor('#64748b').fontSize(7)
      .text(`\u00A9 ${new Date().getFullYear()} The Metrics Inc. All rights reserved.`, 50, pageHeight - 38, { align: 'center', width: pageWidth - 100 });

    doc.end();
  });
}

export async function sendOfferLetter(data: OfferLetterData): Promise<boolean> {
  const { applicantName, applicantEmail, applicantWhatsapp, offerId, trainerName, trainerEmail, trainerWhatsapp, trainerCode, sessionTime, sessionTimezone, scheduleTrainingUrl, country } = data;
  const t = getRegionalTerms(country);

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateOfferLetterPDF(data);
  } catch (error) {
    logger.error("Failed to generate PDF offer letter", error);
    return false;
  }

  const affiliateRegisterUrl = trainerCode 
    ? `https://affiliates-portermetrics.com/register?ref=${trainerCode}`
    : 'https://affiliates-portermetrics.com/register';

  const approvedLabel = t.language === "es" ? "Aprobada" : t.language === "pt" ? "Aprovada" : t.language === "fr" ? "Approuvée" : t.language === "zh" ? "已批准" : "Approved";
  const attachmentLabel = t.language === "es" ? "Adjunto" : t.language === "pt" ? "Anexo" : t.language === "fr" ? "Pièce jointe" : t.language === "zh" ? "附件" : "Attachment";
  const referenceLabel = t.language === "es" ? "Referencia" : t.language === "pt" ? "Referência" : t.language === "fr" ? "Référence" : t.language === "zh" ? "参考编号" : "Reference";
  const pdfLabel = t.language === "es" ? "Carta de Oferta Oficial (PDF)" : t.language === "pt" ? "Carta de Oferta Oficial (PDF)" : t.language === "fr" ? "Lettre d'Offre Officielle (PDF)" : t.language === "zh" ? "正式录用函 (PDF)" : "Official Offer Letter (PDF)";
  const introText = t.language === "es"
    ? `Nos complace informarle que su solicitud para el puesto de <strong>${t.positionTitle}</strong> ha sido ${statusBadge(approvedLabel, '#dcfce7', '#166534')}. Su carta de oferta oficial está adjunta a este correo como documento PDF.`
    : t.language === "pt"
    ? `Temos o prazer de informar que sua candidatura para o cargo de <strong>${t.positionTitle}</strong> foi ${statusBadge(approvedLabel, '#dcfce7', '#166534')}. Sua carta de oferta oficial está anexada a este e-mail como documento PDF.`
    : t.language === "fr"
    ? `Nous avons le plaisir de vous informer que votre candidature pour le poste de <strong>${t.positionTitle}</strong> a été ${statusBadge(approvedLabel, '#dcfce7', '#166534')}. Votre lettre d'offre officielle est jointe à cet e-mail en format PDF.`
    : t.language === "zh"
    ? `我们很高兴地通知您，您申请的<strong>${t.positionTitle}</strong>职位已${statusBadge(approvedLabel, '#dcfce7', '#166534')}。您的正式录用函已作为PDF文档附在本邮件中。`
    : `We are pleased to inform you that your application for the <strong>${t.positionTitle}</strong> position has been ${statusBadge(approvedLabel, '#dcfce7', '#166534')}. Your official offer letter is attached to this email as a PDF document.`;

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">${t.greeting(applicantName)}</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      ${introText}
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">${attachmentLabel}</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${pdfLabel}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">${referenceLabel}</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 700; font-family: 'Courier New', monospace;">${offerId}</td>
        </tr>
      </table>
    `, '#16a34a', '#f0fdf4')}

    ${trainerName ? `
    ${sectionHeading('Your Assigned Trainer')}
    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">Trainer</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainerName}</td>
        </tr>
        ${trainerEmail ? `<tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Email</td>
          <td style="padding: 4px 0; font-size: 14px;"><a href="mailto:${trainerEmail}" style="color: #3b82f6; text-decoration: none;">${trainerEmail}</a></td>
        </tr>` : ''}
        ${trainerWhatsapp ? `<tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">WhatsApp</td>
          <td style="padding: 4px 0; font-size: 14px;"><a href="https://wa.me/${trainerWhatsapp.replace(/[^0-9]/g, '')}" style="color: #25d366; text-decoration: none;">${trainerWhatsapp}</a></td>
        </tr>` : ''}
        ${sessionTime ? `<tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Training</td>
          <td style="padding: 4px 0; font-size: 14px; color: #16a34a; font-weight: 600;">${sessionTime}${sessionTimezone ? ` (${sessionTimezone})` : ''}</td>
        </tr>` : ''}
      </table>
    `, '#3b82f6')}
    ` : ''}

    ${trainerName ? `
    ${sectionHeading('Complete Your Registration')}
    <p style="margin: 0 0 16px; font-size: 15px; color: #334155; line-height: 1.7;">
      To begin your onboarding, you must register on the Porter Metrics Affiliate Platform:
    </p>

    ${ctaButton('Register on Porter Metrics', affiliateRegisterUrl, '#16a34a')}
    <p style="text-align: center; margin: -16px 0 20px;">
      <a href="${affiliateRegisterUrl}" style="font-size: 12px; color: #3b82f6; word-break: break-all;">${affiliateRegisterUrl}</a>
    </p>

    ${trainerCode ? `
    <div style="background-color: #fef2f2; border: 2px solid #dc2626; border-radius: 4px; padding: 20px; margin: 24px 0; text-align: center;">
      <p style="margin: 0 0 12px; font-size: 14px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px;">Mandatory — Use This Referral Code During Registration</p>
      <div style="background-color: #ffffff; border: 2px dashed #dc2626; padding: 14px 24px; border-radius: 4px; display: inline-block;">
        <span style="font-size: 26px; font-weight: 700; font-family: 'Courier New', monospace; color: #dc2626; letter-spacing: 3px;">${trainerCode}</span>
      </div>
      <p style="margin: 12px 0 0; font-size: 12px; color: #991b1b;">Enter this code in the referral field when creating your account.</p>
    </div>
    ` : ''}
    ` : ''}

    ${scheduleTrainingUrl && !trainerName ? `
    ${sectionHeading('Schedule Your Training')}
    <div style="background-color: #f0fdf4; border: 2px solid #25d366; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: center;">
      <p style="margin: 0 0 8px; font-size: 14px; font-weight: 700; color: #166534;">TRAINING IS VIA WHATSAPP</p>
      <p style="margin: 0; font-size: 13px; color: #166534;">Pick a date and time, provide your WhatsApp number, and we'll assign a trainer who will contact you.</p>
    </div>
    ${ctaButton('Schedule Your Training Now', scheduleTrainingUrl, '#25d366')}
    ` : ''}

    ${compensationTablesHtml(t)}

    ${sectionHeading(t.nextStepsHeading)}
    <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      ${trainerName ? `<li><strong>Register on Porter Metrics</strong> using the button above</li>` : ''}
      ${trainerCode ? `<li><strong>Enter referral code <span style="color: #dc2626; font-family: 'Courier New', monospace;">${trainerCode}</span></strong> during registration</li>` : ''}
      ${trainerName ? `<li><strong>Complete your profile</strong> with accurate information</li>` : ''}
      ${scheduleTrainingUrl && !trainerName ? `<li><strong>Schedule your training</strong> — Choose a date/time and provide your WhatsApp number</li>` : ''}
      ${trainerName ? `<li><strong>Contact your trainer</strong> (${trainerName}) for guidance</li>` : ''}
      ${sessionTime ? `<li><strong>Attend your training session</strong> on ${sessionTime}</li>` : !scheduleTrainingUrl ? '<li><strong>Book a training session</strong> from your dashboard</li>' : '<li><strong>Wait for trainer assignment</strong> — We\'ll email you with your trainer\'s WhatsApp and registration link</li>'}
      <li><strong>Start earning</strong> after completing onboarding</li>
    </ol>

    ${ctaButton(t.language === "es" ? "Ver Estado de su Solicitud" : t.language === "pt" ? "Verificar Status da Candidatura" : t.language === "fr" ? "Vérifier le Statut de votre Candidature" : t.language === "zh" ? "查看申请状态" : "Check Your Application Status", 'https://www.portermetricscareeronboarding.com/status')}

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 12px 16px; margin: 16px 0;">
      <p style="margin: 0; font-size: 12px; color: #64748b; line-height: 1.6;">
        ${t.legalDisclaimer}
      </p>
    </div>

    <p style="margin: 24px 0 0; font-size: 15px; color: #334155; line-height: 1.7;">
      ${t.welcomeMessage}
    </p>
    <p style="margin: 12px 0 0; font-size: 15px; color: #334155;">
      ${t.closing}<br>
      <strong>${t.companySignature}</strong>
    </p>
  `;

  try {
    await getTransporter().sendMail({
      from: `"The Metrics" <${process.env.SMTP_USER || SMTP_CONFIG.auth.user}>`,
      to: applicantEmail,
      subject: `Official Offer Letter — The Metrics [Ref: ${offerId}]`,
      html: officialEmailWrapper(content, '#16a34a', t.language),
      attachments: [
        {
          filename: `The_Metrics_Offer_Letter_${offerId}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
    logger.info(`Offer letter with PDF sent successfully to ${applicantEmail}`);
    return true;
  } catch (error) {
    logger.error("Failed to send offer letter email", error);
    return false;
  }
}

export async function sendTrainingCompletionCertificate(
  email: string,
  name: string,
  trainerName: string,
  completionDate: string,
  certificateId: string,
  branding?: EmailBranding,
  smtpAccountId?: number
): Promise<boolean> {
  const brandName = branding?.companyName || 'The Metrics';
  const brandTagline = branding?.companyTagline || 'Global Remote Workforce Platform';
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateTrainingCertificatePDF({ name, trainerName, completionDate, certificateId, branding: { companyName: brandName, companyTagline: brandTagline, companyEmail: branding?.companyEmail } });
  } catch (error) {
    logger.error("Failed to generate training certificate PDF", error);
    return false;
  }

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Hi <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Congratulations — you've completed your training! 🎉 Your official certificate is attached to this email.
    </p>

    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      You're now certified as a <strong>Remote Product Insights Upload Associate</strong> and ready to start earning.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">Certificate ID</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 700; font-family: 'Courier New', monospace;">${certificateId}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Completed</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${completionDate}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Trainer</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainerName}</td>
        </tr>
      </table>
    `, '#16a34a', '#f0fdf4')}

    ${sectionHeading('What You Learned')}
    <ul style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li>Product uploads (standard and combination)</li>
      <li>Commission tracking and quality standards</li>
      <li>Platform navigation and workflows</li>
    </ul>

    <p style="margin: 24px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Head to the platform to start uploading products and earning commissions.
    </p>

    ${ctaButton('Go to Platform & Start Earning', 'http://affiliates-portermetrics.com')}

    <p style="margin: 24px 0 0; font-size: 15px; color: #334155;">
      Best regards,<br>
      <strong>${brandName} Training Department</strong>
    </p>
  `;

  return sendEmail({
    to: email,
    subject: `Certificate of Completion — ${name} | ${brandName}`,
    html: officialEmailWrapper(content, '#16a34a', 'en', branding),
    fromName: brandName,
    smtpAccountId,
    attachments: [
      {
        filename: `${brandName.replace(/\s+/g, '_')}_Training_Certificate_${certificateId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

export function generateTrainingCertificatePDF(data: {
  name: string;
  trainerName: string;
  completionDate: string;
  certificateId: string;
  branding?: { companyName?: string; companyTagline?: string; companyEmail?: string };
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { name, trainerName, completionDate, certificateId, branding } = data;
    const brandName = branding?.companyName || 'The Metrics';
    const brandNameUpper = brandName.toUpperCase();
    const brandTagline = branding?.companyTagline || 'Global Remote Workforce Platform';
    const doc = new PDFDocument({ margin: 50, size: 'A4', layout: 'landscape' });
    doc.addPage = function() { return doc; };
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = 841.89;
    const pageHeight = 595.28;

    // Outer decorative border
    doc.rect(15, 15, pageWidth - 30, pageHeight - 30).lineWidth(2).strokeColor('#0f172a').stroke();
    doc.rect(20, 20, pageWidth - 40, pageHeight - 40).lineWidth(0.5).strokeColor('#94a3b8').stroke();
    doc.rect(28, 28, pageWidth - 56, pageHeight - 56).lineWidth(0.25).strokeColor('#cbd5e1').stroke();

    // Corner ornaments (simple L-shapes)
    const corners = [[35, 35], [pageWidth - 35, 35], [35, pageHeight - 35], [pageWidth - 35, pageHeight - 35]];
    corners.forEach(([cx, cy]) => {
      doc.circle(cx, cy, 3).fill('#0f172a');
    });

    // Top accent band
    doc.rect(28, 28, pageWidth - 56, 6).fill('#0f172a');

    // Title area
    doc.y = 55;
    doc.fillColor('#94a3b8').fontSize(10).font('Helvetica')
      .text(brandNameUpper, 0, 55, { align: 'center', width: pageWidth });
    doc.moveDown(0.3);
    doc.fillColor('#0f172a').fontSize(32).font('Helvetica-Bold')
      .text('CERTIFICATE OF COMPLETION', 0, doc.y, { align: 'center', width: pageWidth });
    doc.moveDown(0.6);

    // Decorative line
    const lineY = doc.y;
    doc.moveTo(pageWidth / 2 - 120, lineY).lineTo(pageWidth / 2 + 120, lineY).lineWidth(1).strokeColor('#0f172a').stroke();
    doc.moveTo(pageWidth / 2 - 80, lineY + 4).lineTo(pageWidth / 2 + 80, lineY + 4).lineWidth(0.5).strokeColor('#94a3b8').stroke();

    doc.y = lineY + 20;

    doc.fillColor('#64748b').fontSize(12).font('Helvetica')
      .text('This is to certify that', 0, doc.y, { align: 'center', width: pageWidth });
    doc.moveDown(0.6);

    // Name with underline
    doc.fillColor('#0f172a').fontSize(30).font('Helvetica-Bold')
      .text(name, 0, doc.y, { align: 'center', width: pageWidth });
    doc.moveDown(0.2);
    const nameLineY = doc.y;
    doc.moveTo(pageWidth / 2 - 140, nameLineY).lineTo(pageWidth / 2 + 140, nameLineY).lineWidth(0.75).strokeColor('#0f172a').stroke();

    doc.moveDown(0.8);
    doc.fillColor('#64748b').fontSize(12).font('Helvetica')
      .text('has successfully completed the onboarding training program for the position of', 0, doc.y, { align: 'center', width: pageWidth });
    doc.moveDown(0.5);
    doc.fillColor('#0f172a').fontSize(16).font('Helvetica-Bold')
      .text('Remote Product Insights Upload Associate', 0, doc.y, { align: 'center', width: pageWidth });
    doc.moveDown(0.4);
    doc.fillColor('#64748b').fontSize(11).font('Helvetica')
      .text('and is hereby authorized to commence professional duties.', 0, doc.y, { align: 'center', width: pageWidth });

    doc.moveDown(1.5);

    // Details row
    const detailY = doc.y;
    const col1X = 120;
    const col2X = pageWidth / 2 - 50;
    const col3X = pageWidth - 280;

    // Completion Date
    doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('DATE OF COMPLETION', col1X, detailY, { width: 150 });
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(completionDate, col1X, detailY + 14, { width: 150 });

    // Certificate ID
    doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('CERTIFICATE ID', col2X, detailY, { width: 180 });
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(certificateId, col2X, detailY + 14, { width: 180 });

    // Certified By
    doc.fillColor('#64748b').fontSize(9).font('Helvetica').text('CERTIFIED BY', col3X, detailY, { width: 150 });
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(trainerName, col3X, detailY + 14, { width: 150 });

    // Separator lines under each detail
    [col1X, col2X, col3X].forEach(x => {
      doc.moveTo(x, detailY + 30).lineTo(x + 140, detailY + 30).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
    });

    // Signature area
    doc.y = detailY + 50;
    const sigY = doc.y;

    drawSignature(doc, pageWidth / 2 - 55, sigY, brandName, 'Recruitment Dept.');

    doc.fillColor('#64748b').fontSize(9).font('Helvetica')
      .text('Authorized Signature', 0, sigY + 45, { align: 'center', width: pageWidth });
    doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold')
      .text(`${brandName} Recruitment Department`, 0, sigY + 58, { align: 'center', width: pageWidth });

    drawCompanyStamp(doc, pageWidth - 155, sigY + 10, 48, brandNameUpper);

    // Bottom accent band
    doc.rect(28, pageHeight - 34, pageWidth - 56, 6).fill('#0f172a');

    // Footer
    doc.fillColor('#94a3b8').fontSize(7).font('Helvetica')
      .text(`\u00A9 ${new Date().getFullYear()} ${brandName}  |  ${brandTagline}  |  Confidential`, 0, pageHeight - 48, { align: 'center', width: pageWidth });

    doc.end();
  });
}

export async function sendPasswordResetEmail(email: string, name: string, resetToken: string): Promise<boolean> {
  const resetLink = `https://www.portermetricscareeronboarding.com/reset-password?token=${resetToken}`;

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      We received a request to reset the password associated with your account at The Metrics. Click the button below to set a new password.
    </p>

    ${ctaButton('Reset My Password', resetLink, '#0f172a')}

    <p style="margin: 0 0 8px; font-size: 13px; color: #64748b;">
      If the button above does not work, copy and paste the following link into your browser:
    </p>
    <p style="margin: 0 0 20px; font-size: 12px; color: #3b82f6; word-break: break-all;">
      <a href="${resetLink}" style="color: #3b82f6; text-decoration: none;">${resetLink}</a>
    </p>

    <div style="background-color: #fffbeb; border: 1px solid #fde68a; border-left: 3px solid #f59e0b; border-radius: 4px; padding: 16px; margin: 20px 0;">
      <p style="margin: 0; font-size: 13px; color: #92400e; line-height: 1.6;">
        <strong>Security Notice:</strong> This link will expire in 1 hour. If you did not request a password reset, please disregard this email. Your account remains secure.
      </p>
    </div>
  `;

  return sendEmail({
    to: email,
    subject: `Password Reset Request — The Metrics`,
    html: officialEmailWrapper(content),
  });
}

export async function sendStaffAnnouncementEmail(
  email: string,
  name: string,
  subject: string,
  message: string,
  imageUrl?: string,
  options?: { smtpAccountId?: number; branding?: EmailBranding }
): Promise<boolean> {
  const brandName = options?.branding?.companyName || 'The Metrics';
  const imageBlock = imageUrl ? `
    <div style="margin: 20px 0; text-align: center;">
      <img src="${imageUrl}" alt="Announcement" style="max-width: 100%; height: auto; border-radius: 4px; border: 1px solid #e2e8f0;" />
    </div>
  ` : '';

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <div style="margin: 20px 0;">
      <p style="margin: 0 0 4px; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">Staff Announcement</p>
      ${sectionHeading(subject)}
    </div>

    <div style="font-size: 15px; color: #334155; line-height: 1.8; white-space: pre-wrap; margin: 16px 0;">${message}</div>

    ${imageBlock}

    ${ctaButton('Go to Dashboard', 'https://www.portermetricscareeronboarding.com/staff-login')}
  `;

  return sendEmailWithLogging({
    to: email,
    subject: `${subject} — ${brandName}`,
    html: officialEmailWrapper(content, '#0f172a', 'en', options?.branding),
    smtpAccountId: options?.smtpAccountId,
  }, { recipientName: name, emailType: "staff_announcement" });
}

export async function sendRescheduleApprovedEmail(
  traineeEmail: string,
  traineeName: string,
  trainerEmail: string,
  trainerName: string,
  approvedDate: string,
  adminNotes?: string
): Promise<boolean> {
  const traineeContent = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${traineeName}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Your training reschedule request has been ${statusBadge('Approved', '#dcfce7', '#166534')}.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">New Training Date</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${approvedDate}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Trainer</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainerName}</td>
        </tr>
        ${adminNotes ? `<tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Notes</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a;">${adminNotes}</td>
        </tr>` : ''}
      </table>
    `, '#16a34a', '#f0fdf4')}

    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      Your trainer will reach out with additional session details. Please ensure you are available at the scheduled time.
    </p>

    <p style="margin: 0; font-size: 15px; color: #334155;">
      Best regards,<br><strong>The Metrics Team</strong>
    </p>
  `;

  const trainerContent = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${trainerName}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      A trainee's training session has been rescheduled. Please review the updated details below.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">Trainee</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${traineeName} (<a href="mailto:${traineeEmail}" style="color: #3b82f6; text-decoration: none;">${traineeEmail}</a>)</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">New Date</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${approvedDate}</td>
        </tr>
        ${adminNotes ? `<tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; vertical-align: top;">Admin Notes</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a;">${adminNotes}</td>
        </tr>` : ''}
      </table>
    `, '#3b82f6')}

    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      Please coordinate with the trainee regarding the training session details.
    </p>

    <p style="margin: 0; font-size: 15px; color: #334155;">
      Best regards,<br><strong>The Metrics Team</strong>
    </p>
  `;

  try {
    await Promise.all([
      sendEmailWithLogging({
        to: traineeEmail,
        subject: "Reschedule Request Approved — The Metrics",
        html: officialEmailWrapper(traineeContent, '#16a34a'),
      }, { recipientName: traineeName, emailType: "reschedule_approved" }),
      sendEmailWithLogging({
        to: trainerEmail,
        subject: `Training Rescheduled — ${traineeName} | The Metrics`,
        html: officialEmailWrapper(trainerContent),
      }, { recipientName: trainerName, emailType: "reschedule_trainer_notification" }),
    ]);
    return true;
  } catch (error) {
    logger.error("Failed to send reschedule approved emails", error);
    return false;
  }
}

export function generateWithdrawalCertificatePDF(data: {
  name: string;
  withdrawalDate: string;
  certificateId: string;
  reason?: string;
  notes?: string;
  branding?: { companyName?: string; companyTagline?: string; companyEmail?: string };
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { name, withdrawalDate, certificateId, reason, notes, branding } = data;
    const brandName = branding?.companyName || 'The Metrics';
    const brandNameUpper = brandName.toUpperCase();
    const brandTagline = branding?.companyTagline || 'Global Remote Workforce Platform';
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.addPage = function() { return doc; };
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = 595.28;
    const pageHeight = 841.89;

    const sigAreaTop = pageHeight - 175;
    const footerTop = pageHeight - 55;
    const maxContentBottom = sigAreaTop - 10;

    doc.rect(20, 20, pageWidth - 40, pageHeight - 40).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    doc.rect(24, 24, pageWidth - 48, pageHeight - 48).lineWidth(0.25).strokeColor('#e2e8f0').stroke();

    doc.rect(24, 24, pageWidth - 48, 60).fill('#92400e');
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
      .text(brandNameUpper, 50, 38, { align: 'center', width: pageWidth - 100 });
    doc.fontSize(8).fillColor('#fde68a').font('Helvetica')
      .text('CERTIFICATE OF WITHDRAWAL', 50, 60, { align: 'center', width: pageWidth - 100 });

    doc.fillColor('#64748b').fontSize(8).font('Helvetica');
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.text(`Date: ${dateStr}`, 50, 100);
    doc.text(`Reference: ${certificateId}`, 50, 100, { align: 'right', width: pageWidth - 100 });

    doc.moveTo(50, 116).lineTo(pageWidth - 50, 116).lineWidth(0.5).strokeColor('#e2e8f0').stroke();

    doc.fillColor('#0f172a').fontSize(15).font('Helvetica-Bold')
      .text('Certificate of Withdrawal', 50, 128, { align: 'center', width: pageWidth - 100 });

    doc.y = 152;
    doc.fillColor('#334155').fontSize(11).font('Helvetica')
      .text('This document certifies that', 50, doc.y, { align: 'center', width: pageWidth - 100 });
    doc.moveDown(0.3);

    doc.fillColor('#0f172a').fontSize(22).font('Helvetica-Bold')
      .text(name, 50, doc.y, { align: 'center', width: pageWidth - 100 });
    doc.moveDown(0.3);

    doc.fillColor('#334155').fontSize(11).font('Helvetica')
      .text('has formally withdrawn from the position of', 50, doc.y, { align: 'center', width: pageWidth - 100 });
    doc.moveDown(0.3);

    doc.fillColor('#92400e').fontSize(13).font('Helvetica-Bold')
      .text('Remote Product Insights Upload Associate', 50, doc.y, { align: 'center', width: pageWidth - 100 });
    doc.moveDown(1);

    const boxHeight = reason ? 80 : 55;
    const detailsTop = doc.y;
    doc.rect(50, detailsTop, pageWidth - 100, boxHeight).fill('#fffbeb');
    doc.rect(50, detailsTop, pageWidth - 100, boxHeight).lineWidth(0.5).strokeColor('#fde68a').stroke();

    doc.fillColor('#92400e').fontSize(10).font('Helvetica-Bold');
    doc.text('Certificate ID:', 70, detailsTop + 12);
    doc.font('Helvetica').text(certificateId, 180, detailsTop + 12);
    doc.font('Helvetica-Bold').text('Date of Withdrawal:', 70, detailsTop + 28);
    doc.font('Helvetica').text(withdrawalDate, 180, detailsTop + 28);
    if (reason) {
      doc.font('Helvetica-Bold').text('Reason:', 70, detailsTop + 44);
      doc.font('Helvetica').text(reason, 180, detailsTop + 44, { width: 340, height: 28, ellipsis: true });
    }
    doc.y = detailsTop + boxHeight + 10;

    if (notes && doc.y < maxContentBottom - 60) {
      doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('Additional Notes', 50);
      doc.moveDown(0.3);
      const notesMaxHeight = maxContentBottom - doc.y - 50;
      if (notesMaxHeight > 20) {
        doc.fillColor('#334155').fontSize(10).font('Helvetica').text(notes, 50, doc.y, { align: 'justify', lineGap: 1, width: pageWidth - 100, height: notesMaxHeight, ellipsis: true });
      }
      doc.moveDown(0.5);
    }

    if (doc.y < maxContentBottom - 30) {
      doc.fillColor('#334155').fontSize(10).font('Helvetica');
      const disclaimerMaxH = maxContentBottom - doc.y;
      doc.text('This certificate is issued for record-keeping purposes and confirms the formal withdrawal of the above-named individual from the program.', 50, doc.y, { align: 'justify', lineGap: 1, width: pageWidth - 100, height: disclaimerMaxH, ellipsis: true });
    }

    doc.fillColor('#0f172a').fontSize(10).font('Helvetica').text('Issued by,', 50, sigAreaTop);

    const wdSigY = sigAreaTop + 14;
    drawSignature(doc, 50, wdSigY, brandName, 'HR Department');

    const brandEmail = branding?.companyEmail || 'info@portermetricscareeronboarding.com';
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(`${brandName} HR Department`, 50, wdSigY + 45);
    doc.font('Helvetica').fillColor('#64748b').fontSize(8).text(brandEmail, 50);

    drawCompanyStamp(doc, pageWidth - 120, wdSigY + 10, 42, brandNameUpper);

    doc.rect(24, footerTop, pageWidth - 48, 31).fill('#1e293b');
    doc.fillColor('#94a3b8').fontSize(7).font('Helvetica')
      .text(`${brandName}  |  ${brandTagline}  |  Confidential`, 50, footerTop + 7, { align: 'center', width: pageWidth - 100 });
    doc.fillColor('#64748b').fontSize(6)
      .text(`\u00A9 ${new Date().getFullYear()} ${brandName}. All rights reserved.`, 50, footerTop + 17, { align: 'center', width: pageWidth - 100 });

    doc.end();
  });
}

export async function sendWithdrawalCertificate(
  email: string,
  name: string,
  withdrawalDate: string,
  certificateId: string,
  reason?: string,
  notes?: string,
  branding?: EmailBranding,
  smtpAccountId?: number
): Promise<boolean> {
  const brandName = branding?.companyName || 'The Metrics';
  const brandTagline = branding?.companyTagline || 'Global Remote Workforce Platform';
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateWithdrawalCertificatePDF({ name, withdrawalDate, certificateId, reason, notes, branding: { companyName: brandName, companyTagline: brandTagline, companyEmail: branding?.companyEmail } });
  } catch (error) {
    logger.error("Failed to generate withdrawal certificate PDF", error);
    return false;
  }

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Please find attached your official Certificate of Withdrawal from the ${brandName} program. This document confirms your formal withdrawal from the Remote Product Insights Upload Associate position.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">Certificate ID</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 700; font-family: 'Courier New', monospace;">${certificateId}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Date</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${withdrawalDate}</td>
        </tr>
      </table>
    `, '#f59e0b', '#fffbeb')}

    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      We wish you the best in your future endeavors. Should you wish to rejoin our program, you are welcome to reapply at any time.
    </p>

    <p style="margin: 0; font-size: 15px; color: #334155;">
      Best regards,<br>
      <strong>${brandName} HR Department</strong>
    </p>
  `;

  return sendEmail({
    to: email,
    subject: `Certificate of Withdrawal — ${name} [Ref: ${certificateId}]`,
    html: officialEmailWrapper(content, '#92400e', 'en', branding),
    fromName: brandName,
    smtpAccountId,
    attachments: [
      {
        filename: `${brandName.replace(/\s+/g, '_')}_Withdrawal_Certificate_${certificateId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

export async function sendRescheduleRejectedEmail(
  traineeEmail: string,
  traineeName: string,
  adminNotes?: string
): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${traineeName}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      We have reviewed your training reschedule request. Unfortunately, it could not be approved at this time.
    </p>

    ${adminNotes ? infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 80px; vertical-align: top;">Reason</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a;">${adminNotes}</td>
        </tr>
      </table>
    `, '#f59e0b', '#fffbeb') : ''}

    <p style="margin: 0 0 20px; font-size: 15px; color: #334155; line-height: 1.7;">
      Please keep your current training schedule. If you need to request a different date, you may submit a new reschedule request through your dashboard.
    </p>

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      For further assistance, contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>

    <p style="margin: 20px 0 0; font-size: 15px; color: #334155;">
      Best regards,<br><strong>The Metrics Team</strong>
    </p>
  `;

  try {
    await sendEmailWithLogging({
      to: traineeEmail,
      subject: "Reschedule Request Update — The Metrics",
      html: officialEmailWrapper(content, '#f59e0b'),
    }, { recipientName: traineeName, emailType: "reschedule_rejected" });
    return true;
  } catch (error) {
    logger.error("Failed to send reschedule rejected email", error);
    return false;
  }
}

export async function sendTrainingAssignedWithWhatsApp(
  traineeEmail: string,
  traineeName: string,
  trainerName: string,
  trainerWhatsapp: string,
  trainingDate: string,
  trainingTime: string,
  trainerEmail?: string,
  referralCode?: string | null,
  onboardingUrl?: string
): Promise<boolean> {
  try {
    const whatsappLink = trainerWhatsapp ? `https://wa.me/${trainerWhatsapp.replace(/[^0-9]/g, '')}` : '';
    const defaultOnboardingUrl = onboardingUrl || (referralCode
      ? `https://www.affiliates-portermetrics.com/register?ref=${encodeURIComponent(referralCode)}`
      : "https://www.affiliates-portermetrics.com/register");
    
    const content = `
      <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Hi <strong>${traineeName}</strong>,</p>
      
      <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
        Your trainer has been assigned and your training session is confirmed. Please review the details below and reach out to your trainer to introduce yourself.
      </p>

      ${sectionHeading('Your Trainer & Session Details')}
      ${infoBox(`
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b; width: 140px;">Trainer</td>
            <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainerName}</td>
          </tr>
          ${trainerEmail ? `<tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Email</td>
            <td style="padding: 6px 0; font-size: 14px;"><a href="mailto:${trainerEmail}" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${trainerEmail}</a></td>
          </tr>` : ''}
          ${trainerWhatsapp ? `<tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">WhatsApp</td>
            <td style="padding: 6px 0; font-size: 14px;"><a href="${whatsappLink}" style="color: #25d366; text-decoration: none; font-weight: 600;">${trainerWhatsapp}</a></td>
          </tr>` : ''}
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Date</td>
            <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainingDate}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Time</td>
            <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainingTime}</td>
          </tr>
        </table>
      `, '#25d366', '#f0fdf4')}

      ${trainerWhatsapp ? ctaButton(`Message ${trainerName} on WhatsApp`, whatsappLink, '#25d366') : ''}

      ${referralCode ? `
      <div style="background-color: #fef2f2; border: 2px solid #dc2626; border-radius: 4px; padding: 20px; margin: 24px 0; text-align: center;">
        <p style="margin: 0 0 12px; font-size: 14px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px;">Mandatory — Use This Referral Code During Registration</p>
        <div style="background-color: #ffffff; border: 2px dashed #dc2626; padding: 14px 24px; border-radius: 4px; display: inline-block;">
          <span style="font-size: 26px; font-weight: 700; font-family: 'Courier New', monospace; color: #dc2626; letter-spacing: 3px;">${referralCode}</span>
        </div>
        <p style="margin: 12px 0 0; font-size: 12px; color: #991b1b;">This code links your account to your assigned trainer.</p>
      </div>
      ` : ''}

      ${sectionHeading('Onboarding Steps')}
      <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
        <li><strong>Contact your trainer</strong> — Send a WhatsApp message or email to introduce yourself</li>
        <li><strong>Register on the Affiliate Platform</strong> using the link below</li>
        ${referralCode ? `<li><strong>Enter referral code <span style="color: #dc2626; font-family: 'Courier New', monospace;">${referralCode}</span></strong> during sign-up</li>` : ''}
        <li><strong>Attend your training session</strong> on ${trainingDate} at ${trainingTime}</li>
        <li><strong>Complete your training</strong> as instructed by your trainer</li>
        <li><strong>Begin earning</strong> once training is confirmed complete</li>
      </ol>

      ${ctaButton('Register on Affiliate Platform', defaultOnboardingUrl, '#16a34a')}

      <div style="background-color: #fffbeb; border: 1px solid #fde68a; border-left: 3px solid #f59e0b; border-radius: 4px; padding: 14px; margin: 20px 0;">
        <p style="margin: 0; font-size: 13px; color: #92400e; line-height: 1.6;">
          <strong>Action needed:</strong> Send your trainer a WhatsApp message before ${trainingDate} to confirm you'll be there.
        </p>
      </div>

      <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
        Can't reach your trainer? Email us at
        <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
      </p>
    `;

    await sendEmail({
      to: traineeEmail,
      subject: "Trainer Assigned — Training Details & Onboarding Guide — The Metrics",
      html: officialEmailWrapper(content, '#25d366'),
    });
    return true;
  } catch (error) {
    logger.error("Failed to send training assigned with WhatsApp email", error);
    return false;
  }
}

export async function sendTrainerNewTraineeWhatsApp(
  trainerEmail: string,
  trainerName: string,
  traineeName: string,
  traineeWhatsapp: string,
  trainingDate: string,
  trainingTime: string,
  traineeEmail?: string,
  traineePhone?: string | null
): Promise<boolean> {
  try {
    const whatsappLink = traineeWhatsapp ? `https://wa.me/${traineeWhatsapp.replace(/[^0-9]/g, '')}` : '';
    
    const content = `
      <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Hi <strong>${trainerName}</strong>,</p>
      
      <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
        You have a new trainee assigned to you. <strong>Please reach out to them</strong> to introduce yourself and confirm the training session.
      </p>

      ${sectionHeading('Trainee Details')}
      ${infoBox(`
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b; width: 140px;">Trainee</td>
            <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${traineeName}</td>
          </tr>
          ${traineeEmail ? `<tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Email</td>
            <td style="padding: 6px 0; font-size: 14px;"><a href="mailto:${traineeEmail}" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${traineeEmail}</a></td>
          </tr>` : ''}
          ${traineeWhatsapp ? `<tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">WhatsApp</td>
            <td style="padding: 6px 0; font-size: 14px;"><a href="${whatsappLink}" style="color: #25d366; text-decoration: none; font-weight: 600;">${traineeWhatsapp}</a></td>
          </tr>` : ''}
          ${traineePhone && traineePhone !== traineeWhatsapp ? `<tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Phone</td>
            <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${traineePhone}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Date</td>
            <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainingDate}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Time</td>
            <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${trainingTime}</td>
          </tr>
        </table>
      `, '#3b82f6')}

      ${traineeWhatsapp ? ctaButton(`Message ${traineeName} on WhatsApp`, whatsappLink, '#25d366') : ''}

      ${sectionHeading('Your Responsibilities')}
      <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
        <li>Reach out to the trainee before the session to introduce yourself</li>
        <li>Prepare the training materials for the scheduled session</li>
        <li>Guide the trainee through the onboarding process</li>
        <li>Confirm training completion when they finish</li>
      </ol>

      ${ctaButton('Go to Trainer Dashboard', 'https://www.portermetricscareeronboarding.com/staff-login')}

      <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
        Need help? Contact admin at
        <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
      </p>
    `;

    await sendEmail({
      to: trainerEmail,
      subject: `New Trainee Assigned: ${traineeName} — The Metrics`,
      html: officialEmailWrapper(content, '#3b82f6'),
    });
    return true;
  } catch (error) {
    logger.error("Failed to send trainer new trainee WhatsApp email", error);
    return false;
  }
}

export async function sendCertificateRevokedEmail(
  email: string,
  name: string,
  certificateId: string,
  reason: string
): Promise<boolean> {
  try {
    const content = `
      <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Hi <strong>${name}</strong>,</p>

      <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
        We're writing to let you know that your training certificate has been <strong>revoked</strong>.
      </p>

      ${infoBox(`
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
          <tr>
            <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">Certificate ID</td>
            <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 700; font-family: 'Courier New', monospace;">${certificateId}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Reason</td>
            <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${reason}</td>
          </tr>
        </table>
      `, '#ef4444', '#fef2f2')}

      <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
        This means your certificate is no longer valid for verification purposes. If you believe this was done in error,
        please contact our team for assistance.
      </p>

      <p style="margin: 24px 0 0; font-size: 15px; color: #334155;">
        Best regards,<br>
        <strong>The Metrics Training Department</strong>
      </p>
    `;

    await sendEmailWithLogging({
      to: email,
      subject: "Your Training Certificate Has Been Revoked",
      html: officialEmailWrapper(content, '#ef4444'),
    }, { recipientName: name, emailType: "certificate_revoked" });
    return true;
  } catch (error) {
    logger.error("Failed to send certificate revoked email", error);
    return false;
  }
}

export async function sendCertificateReactivatedEmail(
  email: string,
  name: string,
  certificateId: string,
  reason?: string
): Promise<boolean> {
  try {
    const content = `
      <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Hi <strong>${name}</strong>,</p>

      <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
        Great news — your training certificate has been <strong>reactivated</strong> and is valid again! 🎉
      </p>

      ${infoBox(`
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
          <tr>
            <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">Certificate ID</td>
            <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 700; font-family: 'Courier New', monospace;">${certificateId}</td>
          </tr>
          ${reason ? `<tr>
            <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Note</td>
            <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${reason}</td>
          </tr>` : ''}
        </table>
      `, '#16a34a', '#f0fdf4')}

      <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
        Your certificate can now be verified again and is fully valid. You can continue using it as proof of your training completion.
      </p>

      ${ctaButton('Go to Platform', 'http://affiliates-portermetrics.com')}

      <p style="margin: 24px 0 0; font-size: 15px; color: #334155;">
        Best regards,<br>
        <strong>The Metrics Training Department</strong>
      </p>
    `;

    await sendEmailWithLogging({
      to: email,
      subject: "Your Training Certificate Has Been Reactivated",
      html: officialEmailWrapper(content, '#16a34a'),
    }, { recipientName: name, emailType: "certificate_reactivated" });
    return true;
  } catch (error) {
    logger.error("Failed to send certificate reactivated email", error);
    return false;
  }
}

export async function sendStaffApprovalEmail(
  email: string,
  name: string,
  role: string
): Promise<boolean> {
  const roleLabel = role === "trainer" ? "Trainer" : "Referrer";
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Great news! Your <strong>${roleLabel}</strong> account at The Metrics has been reviewed and <strong style="color: #16a34a;">approved</strong> by our administration team. You now have access to your dashboard.
    </p>

    ${sectionHeading('What Happens Next')}
    <ul style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      ${role === "trainer" ? `
        <li>Log in to your trainer dashboard to set up your availability</li>
        <li>You can create training sessions and manage trainees</li>
        <li>An admin may certify your profile for additional privileges</li>
      ` : `
        <li>Log in to your referrer dashboard to start tracking referrals</li>
        <li>Share your unique referral link with potential applicants</li>
        <li>Monitor your referral performance and earnings</li>
      `}
    </ul>

    ${ctaButton('Go to Dashboard', 'https://www.portermetricscareeronboarding.com/staff-login')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      If you have any questions, contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return sendEmail({
    to: email,
    subject: `Your ${roleLabel} Account Has Been Approved — The Metrics`,
    html: officialEmailWrapper(content, '#16a34a'),
  });
}

export function generateTrainerCertificateHtml(name: string, certifiedAt?: Date | string | null): string {
  const certDate = certifiedAt
    ? new Date(certifiedAt).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
    : new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const content = `
    <div style="text-align: center; margin: 0 0 24px;">
      <div style="display: inline-block; background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: #fff; padding: 12px 28px; border-radius: 30px; font-size: 13px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;">Certified Trainer</div>
    </div>

    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      We are pleased to inform you that you have been officially <strong style="color: #0ea5e9;">certified</strong> as a trainer at The Metrics. This certification recognizes your readiness to conduct training sessions and onboard new Remote Product Insights Upload Associates.
    </p>

    ${sectionHeading('Certification Details')}
    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #64748b; width: 140px;">Trainer</td>
          <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${name}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Status</td>
          <td style="padding: 6px 0; font-size: 14px; color: #0ea5e9; font-weight: 700;">Certified</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Date Certified</td>
          <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${certDate}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Issued By</td>
          <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">The Metrics — Career Onboarding</td>
        </tr>
      </table>
    `, '#0ea5e9')}

    ${sectionHeading('Your Certified Privileges')}
    <ul style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li>Full access to create and manage training sessions</li>
      <li>Ability to onboard and train new associates</li>
      <li>Access to all training materials and resources</li>
      <li>Priority assignment of new trainees</li>
      <li>Your profile is now marked as a certified trainer</li>
    </ul>

    ${sectionHeading('Next Steps')}
    <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li>Log in to your Trainer Dashboard to review your availability settings</li>
      <li>Set your available time slots so trainees can be assigned to you</li>
      <li>Ensure your WhatsApp contact information is up to date</li>
      <li>Review the training materials in your dashboard</li>
    </ol>

    ${ctaButton('Open Trainer Dashboard', 'https://www.portermetricscareeronboarding.com/staff-login')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      Thank you for being part of our team. If you have any questions, contact us at 
      <a href="mailto:info@portermetricscareeronboarding.com" style="color: #3b82f6; text-decoration: none;">info@portermetricscareeronboarding.com</a>.
    </p>
  `;

  return officialEmailWrapper(content, '#0ea5e9');
}

export async function sendTrainerCertifiedEmail(
  email: string,
  name: string,
  certifiedAt?: Date | string | null
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: "Congratulations! You're Now a Certified Trainer — The Metrics",
    html: generateTrainerCertificateHtml(name, certifiedAt),
  });
}

export async function sendTrainerNudgeEmail(
  trainerEmail: string,
  trainerName: string,
  pendingTrainees: { name: string; email: string }[],
  nudgeType: "unscheduled_trainees" | "inactive"
): Promise<boolean> {
  const traineeList = pendingTrainees.map(t => `<li>${t.name} (${t.email})</li>`).join("");
  
  const subject = nudgeType === "unscheduled_trainees" 
    ? `Reminder: ${pendingTrainees.length} trainee(s) awaiting scheduling`
    : "We miss you! Check in on your trainees";

  const body = nudgeType === "unscheduled_trainees"
    ? `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1a56db;">Trainees Awaiting Training Schedule</h2>
        <p>Hi ${trainerName},</p>
        <p>You have <strong>${pendingTrainees.length}</strong> trainee(s) assigned to you who haven't been scheduled for training yet:</p>
        <ul style="background: #f8fafc; padding: 16px 32px; border-radius: 8px;">${traineeList}</ul>
        <p>Please log in to your dashboard to schedule their training sessions as soon as possible.</p>
        <p style="color: #64748b; font-size: 12px;">This is an automated reminder from The Metrics platform.</p>
      </div>
    `
    : `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1a56db;">Time to Check In!</h2>
        <p>Hi ${trainerName},</p>
        <p>It's been a while since your last training activity. Your trainees may need your attention:</p>
        <ul style="background: #f8fafc; padding: 16px 32px; border-radius: 8px;">${traineeList}</ul>
        <p>Log in to your dashboard to review their progress and schedule any needed sessions.</p>
        <p style="color: #64748b; font-size: 12px;">This is an automated reminder from The Metrics platform.</p>
      </div>
    `;

  return sendEmailWithLogging(
    { to: trainerEmail, subject, html: body },
    { recipientName: trainerName, emailType: "trainer_nudge" }
  );
}

function compensationTablesHtml(t: import("./region-utils").RegionalTerms): string {
  return `
    ${sectionHeading(t.salaryHeading)}
    <p style="margin: 0 0 12px; font-size: 13px; color: #64748b; line-height: 1.6;">
      ${t.minimumTaskNote}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; margin: 0 0 20px;">
      <tr style="background-color: #0f172a;">
        <th style="padding: 10px 16px; font-size: 13px; color: #ffffff; text-align: left; border-radius: 4px 0 0 0;">${t.workingDays}</th>
        <th style="padding: 10px 16px; font-size: 13px; color: #ffffff; text-align: right; border-radius: 0 4px 0 0;">${t.salary}</th>
      </tr>
      ${[
        { days: "3", amount: "150" },
        { days: "5", amount: "500" },
        { days: "10", amount: "1,000" },
        { days: "20", amount: "2,200" },
        { days: "30", amount: "3,500" },
      ].map((row, i) => {
        const bg = i % 2 === 0 ? "#f8fafc" : "#ffffff";
        const border = i < 4 ? "border-bottom: 1px solid #e2e8f0;" : "";
        return `<tr style="background-color: ${bg};">
          <td style="padding: 10px 16px; font-size: 14px; color: #334155; ${border}">${row.days} ${t.language === "es" ? "Días" : t.language === "pt" ? "Dias" : t.language === "fr" ? "Jours" : t.language === "zh" ? "天" : "Days"}</td>
          <td style="padding: 10px 16px; font-size: 14px; color: #16a34a; font-weight: 700; text-align: right; ${border}">${row.amount} USD</td>
        </tr>`;
      }).join("")}
    </table>

    ${sectionHeading(t.checkInHeading)}
    <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; margin: 0 0 20px;">
      <tr style="background-color: #0f172a;">
        <th style="padding: 10px 16px; font-size: 13px; color: #ffffff; text-align: left; border-radius: 4px 0 0 0;">${t.checkInDay}</th>
        <th style="padding: 10px 16px; font-size: 13px; color: #ffffff; text-align: right; border-radius: 0 4px 0 0;">${t.bonus}</th>
      </tr>
      ${[
        { day: "4", ordinal: t.language === "zh" ? "第4天" : t.language === "es" ? "4º Día" : t.language === "pt" ? "4º Dia" : t.language === "fr" ? "4e Jour" : "4th Day", amount: "250" },
        { day: "8", ordinal: t.language === "zh" ? "第8天" : t.language === "es" ? "8º Día" : t.language === "pt" ? "8º Dia" : t.language === "fr" ? "8e Jour" : "8th Day", amount: "500" },
        { day: "12", ordinal: t.language === "zh" ? "第12天" : t.language === "es" ? "12º Día" : t.language === "pt" ? "12º Dia" : t.language === "fr" ? "12e Jour" : "12th Day", amount: "750" },
        { day: "16", ordinal: t.language === "zh" ? "第16天" : t.language === "es" ? "16º Día" : t.language === "pt" ? "16º Dia" : t.language === "fr" ? "16e Jour" : "16th Day", amount: "750" },
      ].map((row, i) => {
        const bg = i % 2 === 0 ? "#f8fafc" : "#ffffff";
        const border = i < 3 ? "border-bottom: 1px solid #e2e8f0;" : "";
        return `<tr style="background-color: ${bg};">
          <td style="padding: 10px 16px; font-size: 14px; color: #334155; ${border}">${row.ordinal}</td>
          <td style="padding: 10px 16px; font-size: 14px; color: #d97706; font-weight: 700; text-align: right; ${border}">${row.amount} USD</td>
        </tr>`;
      }).join("")}
    </table>

    ${sectionHeading(t.vipHeading)}
    <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; margin: 0 0 20px;">
      <tr style="background-color: #0f172a;">
        <th style="padding: 10px 16px; font-size: 13px; color: #ffffff; text-align: left; border-radius: 4px 0 0 0;">${t.vipLevel}</th>
        <th style="padding: 10px 16px; font-size: 13px; color: #ffffff; text-align: center;">${t.profitDeal}</th>
        <th style="padding: 10px 16px; font-size: 13px; color: #ffffff; text-align: right; border-radius: 0 4px 0 0;">${t.frequency}</th>
      </tr>
      ${[
        { level: "VIP 1", profit: "0.5%", times: "40" },
        { level: "VIP 2", profit: "1.0%", times: "45" },
        { level: "VIP 3", profit: "1.5%", times: "50" },
        { level: "VIP 4", profit: "2.0%", times: "55" },
      ].map((row, i) => {
        const bg = i % 2 === 0 ? "#f8fafc" : "#ffffff";
        const border = i < 3 ? "border-bottom: 1px solid #e2e8f0;" : "";
        return `<tr style="background-color: ${bg};">
          <td style="padding: 10px 16px; font-size: 14px; color: #334155; font-weight: 600; ${border}">${row.level}</td>
          <td style="padding: 10px 16px; font-size: 14px; color: #7c3aed; font-weight: 700; text-align: center; ${border}">${row.profit}</td>
          <td style="padding: 10px 16px; font-size: 14px; color: #334155; text-align: right; ${border}">${row.times} ${t.language === "zh" ? "次" : t.language === "es" ? "Veces" : t.language === "pt" ? "Vezes" : t.language === "fr" ? "Fois" : "Times"}</td>
        </tr>`;
      }).join("")}
    </table>
  `;
}

export async function sendJobOfferEmail(email: string, token: string, baseUrl: string, country?: string | null, options?: { smtpAccountId?: number; branding?: EmailBranding }): Promise<boolean> {
  const t = getRegionalTerms(country);
  const brandName = options?.branding?.companyName || 'The Metrics';
  const acceptUrl = `${baseUrl}/job-offer?token=${token}`;
  const acceptBtnLabel = t.language === "es" ? "Aceptar Oferta y Comenzar" : t.language === "pt" ? "Aceitar Oferta e Começar" : t.language === "fr" ? "Accepter l'Offre et Commencer" : t.language === "zh" ? "接受录用并开始" : t.language === "hi" ? "नौकरी का प्रस्ताव स्वीकार करें" : "Accept Job Offer & Get Started";

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">${t.greeting()}</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      ${t.offerIntro()}
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">${t.language === "es" ? "Puesto" : t.language === "pt" ? "Cargo" : t.language === "fr" ? "Poste" : t.language === "zh" ? "职位" : "Position"}</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${t.positionTitle}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">${t.language === "es" ? "Tipo" : t.language === "pt" ? "Tipo" : t.language === "fr" ? "Type" : t.language === "zh" ? "类型" : "Type"}</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${t.language === "es" ? "Remoto / Flexible" : t.language === "pt" ? "Remoto / Flexível" : t.language === "fr" ? "À Distance / Flexible" : t.language === "zh" ? "远程 / 灵活" : "Remote / Flexible"}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">${t.language === "es" ? "Compensación" : t.language === "pt" ? "Compensação" : t.language === "fr" ? "Rémunération" : t.language === "zh" ? "薪酬" : "Compensation"}</td>
          <td style="padding: 4px 0; font-size: 14px; color: #16a34a; font-weight: 700;">${t.language === "es" ? "Ganancias basadas en rendimiento" : t.language === "pt" ? "Ganhos baseados em desempenho" : t.language === "fr" ? "Rémunération basée sur la performance" : t.language === "zh" ? "基于绩效的收入" : "Performance-based earnings"}</td>
        </tr>
      </table>
    `, '#16a34a', '#f0fdf4')}

    ${sectionHeading(t.whatWeOfferHeading)}
    <ul style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      ${t.offerBenefits.map(b => `<li>${b}</li>`).join("")}
    </ul>

    ${compensationTablesHtml(t)}

    ${sectionHeading(t.acceptHeading)}
    <p style="margin: 0 0 16px; font-size: 15px; color: #334155; line-height: 1.7;">
      ${t.acceptDescription}
    </p>

    ${ctaButton(acceptBtnLabel, acceptUrl, '#16a34a')}
    <p style="text-align: center; margin: -16px 0 20px;">
      <a href="${acceptUrl}" style="font-size: 12px; color: #3b82f6; word-break: break-all;">${acceptUrl}</a>
    </p>

    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; padding: 12px 16px; margin: 16px 0;">
      <p style="margin: 0; font-size: 13px; color: #991b1b;">
        ${t.expiryWarning}
      </p>
    </div>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 12px 16px; margin: 16px 0;">
      <p style="margin: 0; font-size: 12px; color: #64748b; line-height: 1.6;">
        ${t.legalDisclaimer}
      </p>
    </div>

    <p style="margin: 24px 0 0; font-size: 15px; color: #334155; line-height: 1.7;">
      ${t.welcomeMessage}
    </p>
    <p style="margin: 12px 0 0; font-size: 15px; color: #334155;">
      ${t.closing}<br>
      <strong>${t.companySignature}</strong>
    </p>
  `;

  return sendEmail({
    to: email,
    subject: `Job Offer — ${t.positionTitle} | ${brandName}`,
    html: officialEmailWrapper(content, '#16a34a', t.language, options?.branding),
    fromName: brandName,
    smtpAccountId: options?.smtpAccountId,
  });
}

export async function sendJobOfferConfirmationEmail(
  email: string,
  name: string,
  preferredDate: string,
  preferredTime: string,
  whatsappNumber: string,
  timezone: string
): Promise<boolean> {
  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${name}</strong>,</p>
    
    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Thank you for accepting the job offer! Your application has been ${statusBadge('Submitted', '#dbeafe', '#1e40af')} and your training appointment has been scheduled.
    </p>

    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b; width: 140px;">Position</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">Remote Product Insights Upload Associate</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Training Date</td>
          <td style="padding: 4px 0; font-size: 14px; color: #16a34a; font-weight: 700;">${preferredDate}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Training Time</td>
          <td style="padding: 4px 0; font-size: 14px; color: #16a34a; font-weight: 700;">${preferredTime} (${timezone})</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 14px; color: #64748b;">WhatsApp</td>
          <td style="padding: 4px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${whatsappNumber}</td>
        </tr>
      </table>
    `, '#16a34a', '#f0fdf4')}

    <div style="background-color: #f0fdf4; border: 2px solid #25d366; border-radius: 4px; padding: 16px; margin: 16px 0; text-align: center;">
      <p style="margin: 0 0 8px; font-size: 14px; font-weight: 700; color: #166534;">TRAINING IS VIA WHATSAPP</p>
      <p style="margin: 0; font-size: 13px; color: #166534;">A trainer will be assigned to you and will contact you via WhatsApp before your training session.</p>
    </div>

    ${sectionHeading('Next Steps')}
    <ol style="margin: 0; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li><strong>Wait for trainer assignment</strong> — An admin will assign a trainer to you</li>
      <li><strong>Receive trainer contact</strong> — You'll get an email with your trainer's WhatsApp</li>
      <li><strong>Attend training</strong> on ${preferredDate} at ${preferredTime}</li>
      <li><strong>Start earning</strong> after completing your training</li>
    </ol>

    ${ctaButton('Check Your Application Status', 'https://www.portermetricscareeronboarding.com/status')}

    <p style="margin: 24px 0 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Welcome to The Metrics! We're excited to have you join us.
    </p>
    <p style="margin: 12px 0 0; font-size: 15px; color: #334155;">
      Best regards,<br>
      <strong>The Metrics Recruitment Team</strong>
    </p>
  `;

  try {
    await getTransporter().sendMail({
      from: `"The Metrics" <${process.env.SMTP_USER || SMTP_CONFIG.auth.user}>`,
      to: email,
      subject: `Welcome to The Metrics — Training Scheduled | The Metrics`,
      html: officialEmailWrapper(content, '#16a34a'),
    });
    logger.info(`Job offer confirmation email sent to ${email}`);
    return true;
  } catch (error) {
    logger.error("Failed to send job offer confirmation email", error);
    return false;
  }
}

export async function sendManualAssignmentEmail(
  trainerEmail: string,
  trainerName: string,
  traineeName: string,
  traineeEmail: string,
  traineePhone: string,
  resumeUrl: string | null,
  adminNote: string | null
): Promise<boolean> {
  const whatsappLink = traineePhone ? `https://wa.me/${traineePhone.replace(/[^0-9]/g, '')}` : null;

  const content = `
    <p style="font-size: 15px; color: #334155; line-height: 1.7;">Dear <strong>${trainerName}</strong>,</p>
    <p style="font-size: 15px; color: #334155; line-height: 1.7;">A new trainee has been manually assigned to you by the admin. Please find the trainee details below and reach out to them.</p>

    ${sectionHeading('Trainee Details')}
    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #64748b; width: 130px;">Full Name</td>
          <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${traineeName}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Email</td>
          <td style="padding: 6px 0; font-size: 14px;"><a href="mailto:${traineeEmail}" style="color: #3b82f6; text-decoration: none;">${traineeEmail}</a></td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Phone / WhatsApp</td>
          <td style="padding: 6px 0; font-size: 14px;">${whatsappLink ? `<a href="${whatsappLink}" style="color: #25d366; text-decoration: none; font-weight: 600;">${traineePhone}</a>` : traineePhone}</td>
        </tr>
        ${resumeUrl ? `<tr>
          <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Resume / CV</td>
          <td style="padding: 6px 0; font-size: 14px;"><a href="${resumeUrl}" style="color: #3b82f6; text-decoration: none;">Download Resume</a></td>
        </tr>` : ''}
      </table>
    `, '#e2e8f0', '#f8fafc')}

    ${adminNote ? `
      ${sectionHeading('First WhatsApp Message to Send')}
      <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #22c55e; border-radius: 4px; padding: 20px; margin: 16px 0;">
        <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #16a34a; text-transform: uppercase; letter-spacing: 0.5px;">Copy and send this message via WhatsApp:</p>
        <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.7; white-space: pre-wrap;">${adminNote.replace(/\n/g, '<br>')}</p>
      </div>
    ` : ''}

    ${whatsappLink ? ctaButton('Open WhatsApp Chat', whatsappLink, '#25d366') : ''}

    <p style="font-size: 14px; color: #64748b; line-height: 1.7; margin-top: 24px;">Please reach out to the trainee as soon as possible and update the assignment status once contacted.</p>
  `;

  return sendEmail({
    to: trainerEmail,
    subject: `New Trainee Assigned: ${traineeName}`,
    html: officialEmailWrapper(content, '#16a34a'),
  });
}

export async function sendTemplateEmail(data: {
  recipientEmail: string;
  recipientName: string;
  subject: string;
  htmlBody: string;
  companyName: string;
  companyEmail: string;
  ccEmail?: string;
  placeholderValues: Record<string, string>;
  smtpAccountId?: number;
  senderAlias?: string;
}): Promise<boolean> {
  let rendered = data.htmlBody;
  for (const [key, value] of Object.entries(data.placeholderValues)) {
    rendered = rendered.replace(new RegExp(`\\[${key}\\]`, 'g'), value);
  }
  rendered = rendered.replace(/\[COMPANY NAME\]/g, data.companyName);
  rendered = rendered.replace(/\[COMPANY EMAIL\]/g, data.companyEmail);
  rendered = rendered.replace(/\[DATE\]/g, new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));
  rendered = rendered.replace(/\[USER NAME\]/g, data.recipientName);

  try {
    let transporter = getTransporter();
    let fromEmail = process.env.SMTP_USER || SMTP_CONFIG.auth.user;
    let fromName = data.senderAlias || data.companyName;

    if (data.smtpAccountId) {
      const accountTransporter = await getTransporterForAccount(data.smtpAccountId);
      if (accountTransporter) {
        transporter = accountTransporter.transporter;
        fromEmail = accountTransporter.fromEmail;
        if (!data.senderAlias) {
          fromName = accountTransporter.fromName;
        }
      }
    }

    const mailOptions: any = {
      from: `"${fromName}" <${fromEmail}>`,
      to: data.recipientEmail,
      subject: data.subject.replace(/\[COMPANY NAME\]/g, data.companyName).replace(/\[USER NAME\]/g, data.recipientName),
      html: rendered,
    };
    if (data.ccEmail) {
      mailOptions.cc = data.ccEmail;
    }
    await transporter.sendMail(mailOptions);
    logger.info(`Template email sent to ${data.recipientEmail}${data.ccEmail ? ` (CC: ${data.ccEmail})` : ''}${data.senderAlias ? ` as "${data.senderAlias}"` : ''}`);
    return true;
  } catch (error) {
    logger.error("Failed to send template email", error);
    return false;
  }
}

interface WithdrawalEmailData {
  recipientName: string;
  username: string;
  withdrawalAmount: string;
  profileBalance?: string;
  totalDeposited?: string;
  stampFee?: string;
  btcAddress?: string;
  ethAddress?: string;
  trcAddress?: string;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  iban?: string;
  swiftBic?: string;
  branding?: EmailBranding;
  smtpAccountId?: number;
}

export async function sendWithdrawalApprovedEmail(
  email: string,
  data: WithdrawalEmailData
): Promise<boolean> {
  const { recipientName, username, withdrawalAmount, profileBalance, totalDeposited, stampFee, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, branding, smtpAccountId } = data;

  const walletRows = [
    btcAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 80px;">BTC</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; word-break: break-all; font-family: 'Courier New', monospace;">${btcAddress}</td></tr>` : '',
    ethAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 80px;">ETH</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; word-break: break-all; font-family: 'Courier New', monospace;">${ethAddress}</td></tr>` : '',
    trcAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; width: 80px;">TRC20</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; word-break: break-all; font-family: 'Courier New', monospace;">${trcAddress}</td></tr>` : '',
  ].filter(Boolean).join('');

  const hasCrypto = !!(btcAddress || ethAddress || trcAddress);
  const hasBank = !!(bankName || accountHolderName || accountNumber || iban || swiftBic);

  const bankRows = [
    bankName ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Bank Name</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${bankName}</td></tr>` : '',
    accountHolderName ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Account Holder</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${accountHolderName}</td></tr>` : '',
    accountNumber ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Account Number</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; font-family: 'Courier New', monospace;">${accountNumber}</td></tr>` : '',
    iban ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">IBAN</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; word-break: break-all; font-family: 'Courier New', monospace;">${iban}</td></tr>` : '',
    swiftBic ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; width: 140px;">SWIFT/BIC</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; font-family: 'Courier New', monospace;">${swiftBic}</td></tr>` : '',
  ].filter(Boolean).join('');

  const cryptoSectionLabel = hasCrypto && hasBank ? 'Cryptocurrency Wallets' : 'Receiving Wallet Address(es)';
  const bankSectionLabel = hasCrypto && hasBank ? 'Bank Account Details' : 'Bank Account Details';

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${recipientName}</strong>,</p>

    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      We are pleased to inform you that your account withdrawal request has been <strong style="color: #16a34a;">approved</strong>. Please review the details below carefully.
    </p>

    ${sectionHeading('Account Details')}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; margin: 16px 0;">
      <tr style="background-color: #f8fafc;">
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0;">Username</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${username}</td>
      </tr>
      <tr>
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0;">Profile Balance</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${profileBalance}</td>
      </tr>
      <tr style="background-color: #f8fafc;">
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0;">Total Deposited</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${totalDeposited}</td>
      </tr>
      <tr>
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0;">Withdrawal Amount</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #0f172a; font-weight: 700; border-bottom: 1px solid #e2e8f0;">${withdrawalAmount}</td>
      </tr>
      ${stampFee ? `<tr style="background-color: #fffbeb;">
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #92400e;">Stamp Duty Fee</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #92400e; font-weight: 700;">${stampFee}</td>
      </tr>` : ''}
    </table>

    ${walletRows ? `
      ${sectionHeading(cryptoSectionLabel)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; margin: 16px 0;">
        ${walletRows}
      </table>
    ` : ''}

    ${bankRows ? `
      ${sectionHeading(bankSectionLabel)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; margin: 16px 0;">
        ${bankRows}
      </table>
    ` : ''}

    ${stampFee ? infoBox(`
      <p style="margin: 0 0 10px; font-size: 14px; color: #92400e; font-weight: 700; line-height: 1.5;">
        Stamp Duty Fee Required: ${stampFee}
      </p>
      <p style="margin: 0 0 10px; font-size: 13px; color: #334155; line-height: 1.7;">
        <strong>What is Stamp Duty?</strong> Stamp Duty is a government-mandated tax applied to financial transactions and fund transfers. It is required by regulatory authorities as part of the legal processing of withdrawals and is standard practice across financial institutions worldwide.
      </p>
      <p style="margin: 0 0 10px; font-size: 13px; color: #334155; line-height: 1.7;">
        <strong>Why is it required?</strong> This fee ensures your withdrawal complies with applicable financial regulations. It must be settled before your funds can be released and transferred to your designated account.
      </p>
      <p style="margin: 0; font-size: 13px; color: #334155; line-height: 1.7;">
        Once the stamp duty fee of <strong>${stampFee}</strong> has been received and confirmed, your withdrawal will be processed and released promptly. If you have any questions, please do not hesitate to contact our support team.
      </p>
    `, '#f59e0b', '#fffbeb') : ''}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      If you have any questions regarding this withdrawal, please do not hesitate to contact our support team.
    </p>
  `;

  const brandName = branding?.companyName || 'The Metrics';
  return sendEmail({
    to: email,
    subject: `Withdrawal Approved — ${brandName}`,
    html: officialEmailWrapper(content, '#16a34a', 'en', branding),
    fromName: brandName,
    smtpAccountId,
  });
}

export async function sendWithdrawalFinalisedEmail(
  email: string,
  data: WithdrawalEmailData
): Promise<boolean> {
  const { recipientName, username, withdrawalAmount, profileBalance, totalDeposited, stampFee, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, branding, smtpAccountId } = data;

  const walletRows = [
    btcAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 80px;">BTC</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; word-break: break-all; font-family: 'Courier New', monospace;">${btcAddress}</td></tr>` : '',
    ethAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 80px;">ETH</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; word-break: break-all; font-family: 'Courier New', monospace;">${ethAddress}</td></tr>` : '',
    trcAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; width: 80px;">TRC20</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; word-break: break-all; font-family: 'Courier New', monospace;">${trcAddress}</td></tr>` : '',
  ].filter(Boolean).join('');

  const hasCrypto = !!(btcAddress || ethAddress || trcAddress);
  const hasBank = !!(bankName || accountHolderName || accountNumber || iban || swiftBic);

  const bankRows = [
    bankName ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Bank Name</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${bankName}</td></tr>` : '',
    accountHolderName ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Account Holder</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${accountHolderName}</td></tr>` : '',
    accountNumber ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Account Number</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; font-family: 'Courier New', monospace;">${accountNumber}</td></tr>` : '',
    iban ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">IBAN</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; word-break: break-all; font-family: 'Courier New', monospace;">${iban}</td></tr>` : '',
    swiftBic ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; width: 140px;">SWIFT/BIC</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; font-family: 'Courier New', monospace;">${swiftBic}</td></tr>` : '',
  ].filter(Boolean).join('');

  const cryptoSectionLabel = hasCrypto && hasBank ? 'Cryptocurrency Wallets' : 'Funds Sent To';
  const bankSectionLabel = hasCrypto && hasBank ? 'Bank Account Details' : 'Bank Account Details';

  const fundsSentDescription = hasCrypto && hasBank
    ? 'The funds have been sent to the wallet address(es) and bank account provided.'
    : hasBank
    ? 'The funds have been sent to the bank account provided.'
    : 'The funds have been sent to the wallet address(es) provided.';

  const confirmationNote = hasCrypto
    ? `<strong>Note:</strong> Please allow up to 24–48 hours for the transaction to be fully confirmed on the blockchain network. You may verify the transaction using your wallet or a block explorer.`
    : `<strong>Note:</strong> Please allow up to 2–5 business days for the bank transfer to be fully processed and reflected in your account.`;

  const content = `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${recipientName}</strong>,</p>

    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Your withdrawal has been <strong style="color: #0f172a;">finalised and processed</strong>. ${fundsSentDescription} Below is a summary of the transaction.
    </p>

    ${sectionHeading('Transaction Summary')}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; margin: 16px 0;">
      <tr style="background-color: #f8fafc;">
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0;">Username</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${username}</td>
      </tr>
      <tr>
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0;">Profile Balance</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${profileBalance}</td>
      </tr>
      <tr style="background-color: #f8fafc;">
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0;">Total Deposited</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${totalDeposited}</td>
      </tr>
      <tr>
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0;">Withdrawal Amount</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #0f172a; font-weight: 700; border-bottom: 1px solid #e2e8f0;">${withdrawalAmount}</td>
      </tr>
      ${stampFee ? `<tr style="background-color: #f0fdf4;">
        <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #166534;">Stamp Duty Fee (Paid)</td>
        <td style="padding: 10px 16px; font-size: 14px; color: #166534; font-weight: 700;">${stampFee}</td>
      </tr>` : ''}
    </table>

    ${walletRows ? `
      ${sectionHeading(cryptoSectionLabel)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; margin: 16px 0;">
        ${walletRows}
      </table>
    ` : ''}

    ${bankRows ? `
      ${sectionHeading(bankSectionLabel)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; margin: 16px 0;">
        ${bankRows}
      </table>
    ` : ''}

    ${infoBox(`
      <p style="margin: 0; font-size: 13px; color: #334155; line-height: 1.6;">
        ${confirmationNote}
      </p>
    `, '#0f172a', '#f8fafc')}

    <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6;">
      Thank you for your patience. If you have any questions or concerns, please contact our support team.
    </p>
  `;

  const brandName = branding?.companyName || 'The Metrics';
  return sendEmail({
    to: email,
    subject: `Withdrawal Finalised — ${brandName}`,
    html: officialEmailWrapper(content, '#0f172a', 'en', branding),
    fromName: brandName,
    smtpAccountId,
  });
}

export async function sendStampFeeExplanationEmail(
  email: string,
  data: {
    recipientName: string;
    stampFee: string;
    withdrawalAmount?: string;
    depositAddress?: string;
    networkType?: string;
    btcAddress?: string;
    ethAddress?: string;
    trcAddress?: string;
    bankName?: string;
    accountHolderName?: string;
    accountNumber?: string;
    iban?: string;
    swiftBic?: string;
    branding?: EmailBranding;
    smtpAccountId?: number;
  }
): Promise<boolean> {
  const { recipientName, stampFee, withdrawalAmount, depositAddress, networkType, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, branding, smtpAccountId } = data;
  const brandName = branding?.companyName || 'The Metrics';
  const brandEmail = branding?.companyEmail || 'info@portermetricscareeronboarding.com';

  const content = generateStampFeeContent({ recipientName, stampFee, withdrawalAmount, depositAddress, networkType, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, brandName, brandEmail });

  return sendEmail({
    to: email,
    subject: `Stamp Duty Fee Information — ${brandName}`,
    html: officialEmailWrapper(content, '#f59e0b', 'en', branding),
    fromName: brandName,
    smtpAccountId,
  });
}

export function generateStampFeeExplanationHtml(data: {
  recipientName: string;
  stampFee: string;
  withdrawalAmount?: string;
  depositAddress?: string;
  networkType?: string;
  btcAddress?: string;
  ethAddress?: string;
  trcAddress?: string;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  iban?: string;
  swiftBic?: string;
  branding?: EmailBranding;
}): string {
  const { recipientName, stampFee, withdrawalAmount, depositAddress, networkType, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, branding } = data;
  const brandName = branding?.companyName || 'The Metrics';
  const brandEmail = branding?.companyEmail || 'info@portermetricscareeronboarding.com';

  const content = generateStampFeeContent({ recipientName, stampFee, withdrawalAmount, depositAddress, networkType, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, brandName, brandEmail });

  return officialEmailWrapper(content, '#f59e0b', 'en', branding);
}

function generateStampFeeContent(params: {
  recipientName: string;
  stampFee: string;
  withdrawalAmount?: string;
  depositAddress?: string;
  networkType?: string;
  btcAddress?: string;
  ethAddress?: string;
  trcAddress?: string;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  iban?: string;
  swiftBic?: string;
  brandName: string;
  brandEmail: string;
}): string {
  const { recipientName, stampFee, withdrawalAmount, depositAddress, networkType, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, brandName, brandEmail } = params;

  const hasCrypto = !!(btcAddress || ethAddress || trcAddress);
  const hasBank = !!(bankName || accountHolderName || accountNumber || iban || swiftBic);
  const hasWithdrawalDest = hasCrypto || hasBank;

  const cryptoRows = [
    btcAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 80px;">BTC</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; word-break: break-all; font-family: 'Courier New', monospace;">${btcAddress}</td></tr>` : '',
    ethAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 80px;">ETH</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; word-break: break-all; font-family: 'Courier New', monospace;">${ethAddress}</td></tr>` : '',
    trcAddress ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; width: 80px;">TRC20</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; word-break: break-all; font-family: 'Courier New', monospace;">${trcAddress}</td></tr>` : '',
  ].filter(Boolean).join('');

  const bankRows = [
    bankName ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Bank Name</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${bankName}</td></tr>` : '',
    accountHolderName ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Account Holder</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${accountHolderName}</td></tr>` : '',
    accountNumber ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">Account Number</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; font-family: 'Courier New', monospace;">${accountNumber}</td></tr>` : '',
    iban ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0; width: 140px;">IBAN</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; font-family: 'Courier New', monospace;">${iban}</td></tr>` : '',
    swiftBic ? `<tr><td style="padding: 8px 16px; font-size: 13px; font-weight: 600; color: #334155; width: 140px;">SWIFT/BIC</td><td style="padding: 8px 16px; font-size: 13px; color: #0f172a;">${swiftBic}</td></tr>` : '',
  ].filter(Boolean).join('');

  const withdrawalDestSection = hasWithdrawalDest ? `
    ${sectionHeading('Your Designated Withdrawal Destination')}
    <p style="margin: 0 0 12px; font-size: 14px; color: #334155; line-height: 1.7;">
      For your reference, below are the withdrawal details you have previously provided. Your funds will be released to this destination once the Stamp Duty requirement has been fulfilled.
    </p>
    ${hasCrypto ? `
      <p style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Crypto Wallet Addresses</p>
      <div style="margin: 0 0 16px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">${cryptoRows}</table>
      </div>
    ` : ''}
    ${hasBank ? `
      <p style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Bank Account Details</p>
      <div style="margin: 0 0 16px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">${bankRows}</table>
      </div>
    ` : ''}
  ` : '';

  const depositSection = depositAddress ? `
    ${sectionHeading('Stamp Duty Deposit Instructions')}
    <p style="margin: 0 0 12px; font-size: 14px; color: #334155; line-height: 1.7;">
      Kindly proceed with the deposit using the official details below:
    </p>
    <div style="margin: 0 0 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 13px; color: #64748b; font-weight: 600;">USDT Deposit Address:</td>
        </tr>
        <tr>
          <td style="padding: 0 0 12px; font-size: 14px; color: #0f172a; font-family: 'Courier New', monospace; word-break: break-all; background: #fff; border: 1px solid #e2e8f0; border-radius: 4px; padding: 10px 12px;">${depositAddress}</td>
        </tr>
        ${networkType ? `<tr>
          <td style="padding: 8px 0 4px; font-size: 13px; color: #64748b; font-weight: 600;">Network Type:</td>
        </tr>
        <tr>
          <td style="padding: 0 0 4px; font-size: 14px; color: #0f172a; font-weight: 700;">${networkType}</td>
        </tr>` : ''}
      </table>
    </div>
    ${infoBox(`
      <p style="margin: 0; font-size: 13px; color: #92400e; line-height: 1.7;">
        <strong>&#9888; Important Notice:</strong> Please ensure that the correct network${networkType ? ` (<strong>${networkType}</strong>)` : ''} and wallet address are used when making the deposit. Any incorrect submission may result in processing delays or irreversible loss of funds.
      </p>
    `, '#f59e0b', '#fffbeb')}
  ` : '';

  return `
    <p style="margin: 0 0 8px; font-size: 15px; color: #334155;">Dear <strong>${recipientName}</strong>,</p>

    <p style="margin: 20px 0; font-size: 15px; color: #334155; line-height: 1.7;">
      We are writing to provide you with <strong>comprehensive clarification and formal regulatory guidance</strong> regarding the <strong>Stamp Duty Fee</strong> associated with your ${withdrawalAmount ? `recent withdrawal request of <strong>${withdrawalAmount}</strong>` : 'pending withdrawal request'}. This notice is issued to ensure full transparency and to clearly outline the statutory compliance process required for the secure release of your funds.
    </p>

    ${sectionHeading('Regulatory Basis for the Stamp Duty Requirement')}
    <p style="margin: 0 0 16px; font-size: 14px; color: #334155; line-height: 1.8;">
      Stamp Duty is a <strong>government-mandated fiscal levy</strong> applied to specific financial transactions, including digital asset withdrawals and fund transfers. This requirement is strictly regulatory and is <strong>not imposed, controlled, or influenced</strong> by ${brandName}.
    </p>

    <p style="margin: 0 0 8px; font-size: 14px; color: #334155; line-height: 1.8;">
      For absolute clarity:
    </p>
    <ul style="margin: 0 0 16px; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li><strong>This is not a company fee</strong> — it is a statutory obligation</li>
      <li><strong>${brandName} does not receive, retain, or benefit</strong> from this deposit</li>
      <li><strong>${brandName} is not authorized</strong> to waive, reduce, or bypass this requirement</li>
    </ul>

    <p style="margin: 0 0 16px; font-size: 14px; color: #334155; line-height: 1.8;">
      This regulation is enforced by financial authorities to ensure that all transactions are properly documented, verified, and compliant with applicable legal and reporting frameworks. It is a standard compliance process observed across banks, investment institutions, and digital asset platforms globally.
    </p>

    ${sectionHeading('Purpose of the Stamp Duty Requirement')}
    <p style="margin: 0 0 8px; font-size: 14px; color: #334155; line-height: 1.8;">
      The Stamp Duty deposit serves several key regulatory and security functions:
    </p>
    <ul style="margin: 0 0 16px; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li><strong>Legal Compliance</strong> — Ensures adherence to financial laws and regulatory standards</li>
      <li><strong>Transaction Authorization</strong> — Enables official approval and release of your withdrawal</li>
      <li><strong>Security Verification</strong> — Protects against unauthorized or non-compliant transactions</li>
      <li><strong>Audit &amp; Documentation</strong> — Establishes a verifiable record for regulatory review</li>
      <li><strong>Regulatory Obligation</strong> — Not generated, controlled, or retained by ${brandName}</li>
    </ul>

    ${sectionHeading('Transaction Summary')}
    ${infoBox(`
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: #92400e; font-weight: 600;">Stamp Duty Deposit Required</td>
          <td style="padding: 6px 0; font-size: 16px; color: #92400e; font-weight: 700; text-align: right;">${stampFee}</td>
        </tr>
        ${withdrawalAmount ? `<tr>
          <td style="padding: 6px 0; font-size: 13px; color: #64748b;">Withdrawal Amount</td>
          <td style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600; text-align: right;">${withdrawalAmount}</td>
        </tr>` : ''}
        <tr>
          <td style="padding: 6px 0; font-size: 13px; color: #64748b;">Current Status</td>
          <td style="padding: 6px 0; font-size: 14px; color: #f59e0b; font-weight: 600; text-align: right;">Pending — Awaiting Stamp Duty Deposit</td>
        </tr>
      </table>
    `, '#f59e0b', '#fffbeb')}

    <p style="margin: 0 0 16px; font-size: 14px; color: #334155; line-height: 1.7;">
      Your withdrawal request is currently <strong>on hold</strong> until this regulatory requirement has been fulfilled and verified.
    </p>

    ${withdrawalDestSection}

    ${depositSection}

    ${sectionHeading('Refund Assurance')}
    <p style="margin: 0 0 8px; font-size: 14px; color: #334155; line-height: 1.8;">
      Please be assured that the <strong>Stamp Duty deposit is fully refundable</strong>.
    </p>
    <p style="margin: 0 0 8px; font-size: 14px; color: #334155; line-height: 1.8;">
      Upon successful completion of your withdrawal:
    </p>
    <ul style="margin: 0 0 16px; padding-left: 24px; color: #334155; font-size: 14px; line-height: 2.2;">
      <li>The <strong>${stampFee}</strong> deposit will be <strong>returned to you in full</strong></li>
      <li>The deposit serves solely as a <strong>temporary regulatory compliance requirement</strong></li>
      <li>It is <strong>not</strong> a deduction, charge, or operational fee</li>
    </ul>

    ${sectionHeading('Required Steps to Complete Your Withdrawal')}
    <div style="margin: 0 0 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 10px 0; vertical-align: top; width: 36px;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background-color: #f59e0b; color: white; font-size: 14px; font-weight: 700; text-align: center; line-height: 28px;">1</div>
          </td>
          <td style="padding: 10px 0 10px 12px; font-size: 14px; color: #334155; line-height: 1.6;">
            <strong>Submit the Stamp Duty deposit</strong> of <strong>${stampFee}</strong>${depositAddress ? ' using the details provided above' : ' as instructed by our support team'}
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; vertical-align: top; width: 36px;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background-color: #3b82f6; color: white; font-size: 14px; font-weight: 700; text-align: center; line-height: 28px;">2</div>
          </td>
          <td style="padding: 10px 0 10px 12px; font-size: 14px; color: #334155; line-height: 1.6;">
            <strong>Verification Phase</strong> — Our compliance team confirms and validates the deposit
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; vertical-align: top; width: 36px;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background-color: #16a34a; color: white; font-size: 14px; font-weight: 700; text-align: center; line-height: 28px;">3</div>
          </td>
          <td style="padding: 10px 0 10px 12px; font-size: 14px; color: #334155; line-height: 1.6;">
            <strong>Processing Phase</strong> — Your ${withdrawalAmount ? withdrawalAmount + ' ' : ''}withdrawal is released
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; vertical-align: top; width: 36px;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background-color: #8b5cf6; color: white; font-size: 14px; font-weight: 700; text-align: center; line-height: 28px;">4</div>
          </td>
          <td style="padding: 10px 0 10px 12px; font-size: 14px; color: #334155; line-height: 1.6;">
            <strong>Refund Phase</strong> — The ${stampFee} Stamp Duty deposit is returned following successful completion
          </td>
        </tr>
      </table>
    </div>

    ${infoBox(`
      <p style="margin: 0; font-size: 13px; color: #334155; line-height: 1.7;">
        <strong>Important Notice:</strong> Your withdrawal will remain temporarily suspended until the required deposit has been completed and successfully verified. Once confirmation is received, processing will resume immediately without further delay.
      </p>
    `, '#3b82f6', '#eff6ff')}

    <p style="margin: 24px 0 0; font-size: 15px; color: #334155; line-height: 1.7;">
      We understand that regulatory procedures of this nature may be unexpected, and we sincerely appreciate your cooperation and prompt attention. Our priority is to ensure that your transaction is handled in a secure, compliant, and efficient manner.
    </p>

    <p style="margin: 12px 0 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Should you require any clarification or assistance, please do not hesitate to contact our support team. We remain available to guide you through every step of the process.
    </p>

    <p style="margin: 12px 0 0; font-size: 15px; color: #334155; line-height: 1.7;">
      Thank you for your prompt attention to this regulatory matter.
    </p>

    <p style="margin: 24px 0 0; font-size: 15px; color: #334155;">
      Warm regards,<br>
      <strong>${brandName} Finance Department</strong><br>
      <span style="color: #64748b; font-size: 13px;">${brandName}</span>
    </p>

    <div style="margin: 24px 0 0; padding: 12px 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;">
      <p style="margin: 0; font-size: 12px; color: #991b1b; font-weight: 700;">Important Notice — Please Read Carefully</p>
      <p style="margin: 4px 0 0; font-size: 12px; color: #7f1d1d; line-height: 1.6;">
        ${brandEmail}
      </p>
    </div>
  `;
}
