import type { Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import type { User } from "@shared/schema";
import rateLimit from "express-rate-limit";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (!req.session.userRole || !roles.includes(req.session.userRole)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

export function sanitizeUser(user: User) {
  const { password, resetToken, resetTokenExpiry, twoFactorCode, twoFactorExpiry, ...safe } = user;
  return safe;
}

export async function logActivity(action: string, entityType: string, entityId?: string, details?: string, userId?: string, ipAddress?: string, previousState?: Record<string, any>) {
  try {
    await storage.createActivityLog({ action, entityType, entityId: entityId || undefined, details: details || undefined, userId: userId || undefined, ipAddress: ipAddress || undefined, previousState: previousState ? JSON.stringify(previousState) : undefined });
  } catch (e) {
    logger.error("Failed to log activity", e);
  }
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

export const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many registration attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

export const applicationSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: "Too many application submissions. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

export const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many password reset attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

export function getOpenAIClient() {
  const OpenAI = require("openai").default;
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    return null;
  }
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

export const DEFAULT_WELCOME_EMAIL_BODY = `Greetings,

Thank you for expressing interest in the remote work-from-home opportunity you recently engaged with on LinkedIn and through our online content. We appreciate your initiative in exploring flexible digital work and are pleased to guide you through the next steps.

Following a review of your initial inquiry by our Human Resources team, including Upendra Nath, we are pleased to move forward with your onboarding communication on behalf of The Metrics.

This position is a fully remote Product Data role designed to be accessible to individuals from a wide range of professional backgrounds. No prior experience is required, and all necessary training is provided during onboarding. All tasks are completed online through our guided workflow system. Please note that this role does not involve selling, purchasing, or customer outreach. The responsibilities focus strictly on structured data-related tasks that can be completed from home at your own pace.

To help you better understand the opportunity, we have attached a Job Overview & Earnings Guide (PDF). This document outlines:

• The nature of the work and daily responsibilities
• How our platform operates and how tasks are assigned
• Earnings structure, performance bonuses, and payout cycles
• Supported payment methods and withdrawal options
• The purpose of our human verification process and how it protects accounts

How to review the document effectively:

We recommend beginning with the Job Role and Daily Earnings sections, as they provide the clearest overview of the day-to-day workflow. You may then review the remaining sections for additional details regarding platform functionality, earning potential, and onboarding requirements.

Once you have reviewed the guide and feel confident moving forward, you may begin the onboarding process using the official link below:

https://www.portermetricscareeronboarding.com

If you prefer to use a referral link for tracking and support purposes, you may use:

https://www.portermetricscareeronboarding.com/apply?ref=claradaviduex9

Our onboarding system is designed to guide you through each step clearly and efficiently. Should you have any questions regarding the guide, the role, the verification process, or the onboarding steps, please feel free to reply directly to this email. Our team is available to support you throughout the process and ensure you have everything needed to get started successfully.

We look forward to supporting you on your journey and potentially welcoming you to the Affiliate PorterMetrics team.

Warm regards,
The Metrics Team`;

export const DEFAULT_WELCOME_EMAIL_SUBJECT = "Job Overview and Earnings Guide Attached";
