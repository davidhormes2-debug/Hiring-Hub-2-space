import type { Express } from "express";
import { requireAuth, requireRole, logActivity } from "./helpers";
import { storage } from "../storage";
import { db } from "../db";
import { logger } from "../logger";
import { z } from "zod";
import crypto from "crypto";
import { insertFeedbackSchema, Application, User, applications, users, trainingSessions, announcements, leads } from "@shared/schema";
import { eq, sql, inArray } from "drizzle-orm";
import { sendNewApplicationNotificationEmail, sendWithdrawalApprovedEmail, sendWithdrawalFinalisedEmail, sendStampFeeExplanationEmail, generateStampFeeExplanationHtml } from "../email";
import { processScheduledReminders, getUpcomingSessions, getPendingTasksForTrainer, sendPendingTasksReminder } from "../reminder-service";
import { generateTrainerRecommendations, getQuickTip, generateAdminInsights, generateTraineePerformanceInsights } from "../ai-recommendations";
import { sendBackupToExternal } from "../backup-scheduler";
import { getVapidPublicKey, sendPushToRole } from "../push-service";

const geoCache = new Map<string, { country: string | null; city: string | null; ts: number }>();
const GEO_CACHE_TTL = 1000 * 60 * 60 * 24;

async function lookupIpGeo(ip: string): Promise<{ country: string | null; city: string | null } | null> {
  if (!ip || ip === "unknown" || ip === "::1" || ip === "127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.")) {
    return null;
  }
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) {
    return { country: cached.country, city: cached.city };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (data && data.status === "success" && data.country) {
      const result = { country: data.country || null, city: data.city || null };
      geoCache.set(ip, { ...result, ts: Date.now() });
      if (geoCache.size > 10000) {
        const firstKey = geoCache.keys().next().value;
        if (firstKey) geoCache.delete(firstKey);
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

const visitorTrackLimiter = new Map<string, number>();
setInterval(() => visitorTrackLimiter.clear(), 60000);

let lastVisitorPushTime = 0;
const VISITOR_PUSH_COOLDOWN_MS = 10000;

const refereeExcelColumns = [
  { header: "Referee Name", key: "refereeName", width: 25 },
  { header: "Referee Email", key: "refereeEmail", width: 30 },
  { header: "Referee Phone", key: "refereePhone", width: 20 },
  { header: "Referee WhatsApp 1", key: "refereeWhatsapp", width: 20 },
  { header: "Referee WhatsApp 2", key: "refereeWhatsapp2", width: 20 },
  { header: "Referee WhatsApp 3", key: "refereeWhatsapp3", width: 20 },
  { header: "Telegram", key: "refereeTelegram", width: 20 },
  { header: "Preferred Contact", key: "preferredContact", width: 18 },
  { header: "Country", key: "refereeCountry", width: 18 },
  { header: "Nationality", key: "nationality", width: 18 },
  { header: "Gender", key: "gender", width: 12 },
  { header: "Timezone", key: "timezone", width: 18 },
  { header: "Address", key: "address", width: 30 },
  { header: "LinkedIn", key: "linkedinUrl", width: 30 },
  { header: "Experience Level", key: "experienceLevel", width: 18 },
  { header: "Availability", key: "availability", width: 16 },
  { header: "Primary Device", key: "primaryDevice", width: 16 },
  { header: "Has Computer Access", key: "hasComputerAccess", width: 18 },
  { header: "Motivation", key: "motivation", width: 35 },
  { header: "Skills", key: "skills", width: 30 },
  { header: "Bio", key: "bio", width: 35 },
  { header: "Registered At", key: "registeredAt", width: 20 },
  { header: "Application Status", key: "appStatus", width: 18 },
  { header: "Applied At", key: "appliedAt", width: 20 },
  { header: "Admin Notes", key: "adminNotes", width: 30 },
  { header: "Resume URL", key: "resumeUrl", width: 30 },
  { header: "IP Address", key: "ipAddress", width: 16 },
  { header: "IP Country", key: "ipCountry", width: 16 },
  { header: "IP City", key: "ipCity", width: 16 },
  { header: "Training Status", key: "trainingStatus", width: 18 },
  { header: "Trainer Name", key: "trainerName", width: 25 },
  { header: "Trainer Email", key: "trainerEmail", width: 30 },
  { header: "Trainer Phone", key: "trainerPhone", width: 20 },
  { header: "Trainee Confirmed", key: "traineeConfirmed", width: 18 },
  { header: "Trainee Confirmed At", key: "traineeConfirmedAt", width: 20 },
  { header: "Trainer Confirmed", key: "trainerConfirmed", width: 18 },
  { header: "Trainer Confirmed At", key: "trainerConfirmedAt", width: 20 },
  { header: "Training Completed At", key: "trainingCompletedAt", width: 20 },
  { header: "Onboarded At", key: "onboardedAt", width: 20 },
  { header: "Is Certified", key: "isCertified", width: 14 },
  { header: "Certified At", key: "certifiedAt", width: 20 },
  { header: "Certificate ID", key: "certificateId", width: 20 },
  { header: "Certificate Revoked", key: "certificateRevoked", width: 18 },
  { header: "Offer Letter Ref", key: "offerLetterRef", width: 20 },
  { header: "Referrer Name", key: "referrerName", width: 25 },
  { header: "Referrer Email", key: "referrerEmail", width: 30 },
  { header: "Referrer Phone", key: "referrerPhone", width: 20 },
  { header: "Referrer WhatsApp", key: "referrerWhatsapp", width: 20 },
  { header: "Referral Code", key: "referralCode", width: 18 },
];

function buildRefereeRow(user: any, app: any, referrer: any, trainerMap: Map<string, any>) {
  const trainer = app?.trainerId ? trainerMap.get(app.trainerId) : null;
  const fmtDate = (d: any) => d ? new Date(d).toLocaleDateString() : "";
  return {
    refereeName: user.name || "",
    refereeEmail: user.email,
    refereePhone: user.phone || "",
    refereeWhatsapp: user.whatsappNumber || "",
    refereeWhatsapp2: user.whatsappNumber2 || "",
    refereeWhatsapp3: user.whatsappNumber3 || "",
    refereeTelegram: user.telegramHandle || "",
    preferredContact: user.preferredContact || "",
    refereeCountry: user.country || "",
    nationality: user.nationality || "",
    gender: user.gender || "",
    timezone: user.timezone || "",
    address: user.address || "",
    linkedinUrl: user.linkedinUrl || "",
    experienceLevel: user.experienceLevel || "",
    availability: user.availability || "",
    primaryDevice: user.primaryDevice || "",
    hasComputerAccess: user.hasComputerAccess === "true" ? "Yes" : "No",
    motivation: user.motivation || "",
    skills: user.skills?.join(", ") || "",
    bio: user.bio || "",
    registeredAt: fmtDate(user.createdAt),
    appStatus: app?.status || "N/A",
    appliedAt: fmtDate(app?.appliedAt),
    adminNotes: app?.adminNotes || "",
    resumeUrl: app?.resumeUrl || "",
    ipAddress: app?.ipAddress || "",
    ipCountry: app?.ipCountry || "",
    ipCity: app?.ipCity || "",
    trainingStatus: app?.trainingStatus || "N/A",
    trainerName: trainer?.name || "",
    trainerEmail: trainer?.email || "",
    trainerPhone: trainer?.phone || trainer?.whatsappNumber || "",
    traineeConfirmed: app?.traineeConfirmed === "true" ? "Yes" : "No",
    traineeConfirmedAt: fmtDate(app?.traineeConfirmedAt),
    trainerConfirmed: app?.trainerConfirmed === "true" ? "Yes" : "No",
    trainerConfirmedAt: fmtDate(app?.trainerConfirmedAt),
    trainingCompletedAt: fmtDate(app?.trainingCompletedAt),
    onboardedAt: fmtDate(app?.onboardedAt),
    isCertified: user.isCertified === "true" ? "Yes" : "No",
    certifiedAt: fmtDate(user.certifiedAt),
    certificateId: app?.certificateId || "",
    certificateRevoked: app?.certificateRevoked === "true" ? "Yes" : "No",
    offerLetterRef: app?.offerLetterRef || "",
    referrerName: referrer?.name || "",
    referrerEmail: referrer?.email || "",
    referrerPhone: referrer?.phone || "",
    referrerWhatsapp: referrer?.whatsappNumber || "",
    referralCode: referrer?.referralCode || "",
  };
}

function styleRefereeHeader(sheet: any) {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
  headerRow.alignment = { horizontal: "center" };
}

export function registerAdminRoutes(app: Express) {
  app.get("/api/admin/email-templates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const path = await import("path");
      const fs = await import("fs");
      const dirs = [
        path.resolve(process.cwd(), "client/public/email-templates"),
        path.resolve(process.cwd(), "dist/public/email-templates"),
        path.resolve(process.cwd(), "attached_assets"),
      ];
      let files: string[] = [];
      for (const dir of dirs) {
        if (fs.existsSync(dir)) {
          files = fs.readdirSync(dir).filter((f: string) => f.startsWith("ibccf") && f.endsWith(".html"));
          if (files.length > 0) break;
        }
      }
      const templates = files.map((f: string) => ({
        filename: f,
        name: f.replace(/\.html$/, "").replace(/ibccf-/g, "").replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
      }));
      res.json(templates);
    } catch (error) {
      logger.error("Failed to list email templates:", error);
      res.status(500).json({ error: "Failed to list email templates" });
    }
  });

  app.get("/api/admin/email-templates/:filename", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const path = await import("path");
      const fs = await import("fs");
      const filename = path.basename(req.params.filename as string);
      if (!filename.startsWith("ibccf") || !filename.endsWith(".html")) {
        return res.status(400).json({ error: "Invalid template filename" });
      }
      const dirs = [
        path.resolve(process.cwd(), "client/public/email-templates"),
        path.resolve(process.cwd(), "dist/public/email-templates"),
        path.resolve(process.cwd(), "attached_assets"),
      ];
      let filePath = "";
      const fsModule = fs;
      for (const dir of dirs) {
        const candidate = path.resolve(dir, filename);
        if (fsModule.existsSync(candidate)) {
          filePath = candidate;
          break;
        }
      }
      if (!filePath) {
        return res.status(404).json({ error: "Template not found" });
      }
      const html = fsModule.readFileSync(filePath, "utf-8");
      res.setHeader("Content-Type", "text/html");
      res.send(html);
    } catch (error) {
      logger.error("Failed to get email template:", error);
      res.status(500).json({ error: "Failed to get email template" });
    }
  });

  app.get("/api/downloads/:filename", async (req, res) => {
    try {
      const path = await import("path");
      const fs = await import("fs");
      const filename = req.params.filename as string;
      const safeName = path.basename(filename);
      const filePath = path.resolve(process.cwd(), "client/public/assets", safeName);
      
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }
      
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
    } catch (error) {
      res.status(500).json({ error: "Failed to download file" });
    }
  });

  app.get("/api/dashboard/stats", requireAuth, async (req, res) => {
    try {
      const [allApps, allUsers, allSessions] = await Promise.all([
        storage.getAllApplications(),
        storage.getAllUsers(),
        storage.getAllTrainingSessions(),
      ]);

      const stats = {
        totalApplications: allApps.length,
        pendingReview: allApps.filter(a => a.status === "under_review" || a.status === "submitted").length,
        accepted: allApps.filter(a => a.status === "accepted").length,
        rejected: allApps.filter(a => a.status === "rejected").length,
        totalTrainers: allUsers.filter(u => u.role === "trainer").length,
        totalReferrers: allUsers.filter(u => u.role === "referrer").length,
        activeSessions: allSessions.filter(s => s.status === "open" && allApps.some(a => a.trainingSessionId === s.id)).length,
        completedTraining: allApps.filter(a => a.trainingStatus === "completed").length,
      };

      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch dashboard stats" });
    }
  });

  app.post("/api/feedback", async (req, res) => {
    try {
      const feedbackData = insertFeedbackSchema.parse(req.body);
      
      // Check if user already submitted feedback
      const existingFeedback = await storage.getFeedbackByEmail(feedbackData.email);
      if (existingFeedback) {
        return res.status(400).json({ error: "You have already submitted feedback" });
      }
      
      const newFeedback = await storage.createFeedback(feedbackData);
      res.json(newFeedback);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to submit feedback" });
    }
  });

  app.get("/api/feedback", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const allFeedback = await storage.getAllFeedback();
      res.json(allFeedback);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.get("/api/feedback/check/:email", async (req, res) => {
    try {
      const existingFeedback = await storage.getFeedbackByEmail(req.params.email as string);
      res.json({ hasSubmitted: !!existingFeedback });
    } catch (error) {
      res.status(500).json({ error: "Failed to check feedback status" });
    }
  });

  app.get("/api/feedback/token/:token", async (req, res) => {
    try {
      const fb = await storage.getTraineeFeedbackByToken(req.params.token);
      if (!fb) return res.status(404).json({ error: "Feedback request not found" });
      if (fb.submittedAt) return res.json({ alreadySubmitted: true, feedback: fb });
      const trainer = await storage.getUser(fb.trainerId);
      const trainee = fb.traineeId ? await storage.getUser(fb.traineeId) : null;
      res.json({ feedback: fb, trainerName: trainer?.name || "Your Trainer", traineeName: trainee?.name || "Trainee" });
    } catch (error) {
      res.status(500).json({ error: "Failed to load feedback form" });
    }
  });

  app.post("/api/feedback/token/:token", async (req, res) => {
    try {
      const existing = await storage.getTraineeFeedbackByToken(req.params.token);
      if (!existing) return res.status(404).json({ error: "Feedback request not found" });
      if (existing.submittedAt) return res.status(400).json({ error: "Feedback already submitted" });
      const { overallRating, communicationRating, knowledgeRating, helpfulnessRating, comment, wouldRecommend } = req.body;
      if (!overallRating || overallRating < 1 || overallRating > 5) {
        return res.status(400).json({ error: "Overall rating (1-5) is required" });
      }
      const result = await storage.submitTraineeFeedback(req.params.token, {
        overallRating,
        communicationRating,
        knowledgeRating,
        helpfulnessRating,
        comment,
        wouldRecommend,
      });
      res.json({ success: true, feedback: result });
    } catch (error) {
      res.status(500).json({ error: "Failed to submit feedback" });
    }
  });

  app.get("/api/trainee-feedback", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const allFeedback = await storage.getAllTraineeFeedback();
      const enriched = await Promise.all(allFeedback.map(async (fb) => {
        const trainer = await storage.getUser(fb.trainerId);
        const trainee = fb.traineeId ? await storage.getUser(fb.traineeId) : null;
        return { ...fb, trainerName: trainer?.name || "Unknown", traineeName: trainee?.name || "Unknown" };
      }));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.post("/api/trainee-feedback/generate", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { applicationId, trainerId, traineeId } = req.body;
      if (!applicationId || !trainerId || !traineeId) {
        return res.status(400).json({ error: "applicationId, trainerId, and traineeId required" });
      }
      const crypto = await import("crypto");
      const token = crypto.randomBytes(32).toString("hex");
      const fb = await storage.createTraineeFeedback({
        applicationId,
        trainerId,
        traineeId,
        overallRating: 0,
        token,
      });
      res.json({ success: true, feedback: fb, feedbackUrl: `/feedback?token=${token}` });
    } catch (error) {
      res.status(500).json({ error: "Failed to generate feedback link" });
    }
  });

  app.post("/api/activity-logs", requireAuth, async (req, res) => {
    try {
      const log = await storage.createActivityLog(req.body);
      res.json(log);
    } catch (error) {
      res.status(500).json({ error: "Failed to create activity log" });
    }
  });

  app.get("/api/activity-logs", requireAuth, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const logs = await storage.getActivityLogs(limit);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to get activity logs" });
    }
  });

  app.post("/api/activity-logs/:id/undo", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const actLog = await storage.getActivityLog(req.params.id as string);
      if (!actLog) {
        return res.status(404).json({ error: "Activity log not found" });
      }
      if (actLog.isUndone === "true") {
        return res.status(400).json({ error: "This action has already been undone" });
      }
      if (!actLog.previousState) {
        return res.status(400).json({ error: "This action cannot be undone" });
      }

      const prev = JSON.parse(actLog.previousState);
      const entityType = actLog.entityType;
      const entityId = actLog.entityId;

      const allowedUndoTypes = ["Application", "User", "TrainingSession"];
      if (!entityType || !allowedUndoTypes.includes(entityType) || !entityId) {
        return res.status(400).json({ error: "This action type cannot be undone" });
      }

      if (entityType === "Application") {
        const app = await storage.getApplication(entityId);
        if (!app) {
          return res.status(404).json({ error: "Application no longer exists" });
        }
        const revertData: Record<string, any> = {};
        const appFields = ["status", "trainingStatus", "trainerId", "trainingSessionId", "traineeConfirmed", "trainerConfirmed", "onboardedAt", "traineeConfirmedAt", "trainerConfirmedAt", "trainingCompletedAt"];
        for (const field of appFields) {
          if (prev[field] !== undefined) revertData[field] = prev[field];
        }
        if (Object.keys(revertData).length > 0) {
          await storage.updateApplication(entityId, revertData);
        }
      } else if (entityType === "User") {
        const user = await storage.getUser(entityId);
        if (!user) {
          return res.status(404).json({ error: "User no longer exists" });
        }
        const revertData: Record<string, any> = {};
        if (prev.isApproved !== undefined) revertData.isApproved = prev.isApproved;
        if (prev.isCertified !== undefined) revertData.isCertified = prev.isCertified;
        if (Object.keys(revertData).length > 0) {
          await storage.updateUser(entityId, revertData);
        }
      } else if (entityType === "TrainingSession") {
        if (prev.isArchived === "false") {
          await storage.unarchiveTrainingSession(entityId);
        }
      }

      await storage.markActivityLogUndone(actLog.id, req.session.userId!);
      logActivity("Undid action", entityType, entityId, `Undid: ${actLog.action} - ${actLog.details || ""}`, req.session.userId);

      res.json({ success: true, message: "Action has been undone successfully" });
    } catch (error) {
      logger.error("Error undoing activity:", error);
      res.status(500).json({ error: "Failed to undo action" });
    }
  });

  app.get("/api/export/feedback", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const feedbackList = await storage.getAllFeedback();
      
      const csvRows = [
        ["ID", "Email", "Rating", "Trainer Rating", "Training Quality", "Would Recommend", "Comments", "Created At"].join(",")
      ];

      for (const fb of feedbackList) {
        csvRows.push([
          fb.id,
          fb.email,
          fb.rating,
          fb.trainerRating || "",
          fb.trainingQuality || "",
          fb.wouldRecommend || "",
          `"${(fb.comments || "").replace(/"/g, '""')}"`,
          fb.createdAt.toISOString()
        ].join(","));
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=feedback.csv");
      res.send(csvRows.join("\n"));
    } catch (error) {
      res.status(500).json({ error: "Failed to export feedback" });
    }
  });

  app.get("/api/admin/dashboard-stats", requireRole("admin"), async (req, res) => {
    try {
      const apps = await storage.getAllApplications();
      const allUsers = await storage.getAllUsers();
      const sessions = await storage.getAllTrainingSessions();
      
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      
      // Count new applications in last 24 hours
      const newAppsToday = apps.filter(app => {
        const appliedAt = new Date(app.appliedAt);
        return appliedAt >= today;
      }).length;
      
      // Count pending reviews
      const pendingReviews = apps.filter(app => app.status === "under_review" || app.status === "submitted").length;
      
      // Count upcoming sessions (within next 7 days)
      const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const upcomingSessions = sessions.filter(session => {
        const sessionDate = new Date(session.startTime);
        return sessionDate >= now && sessionDate <= nextWeek && session.status === "open";
      }).length;
      
      // Pending trainer certifications
      const pendingCertifications = allUsers.filter(u => 
        u.role === "trainer" && u.isCertified !== "true"
      ).length;

      res.json({
        newAppsToday,
        pendingReviews,
        upcomingSessions,
        pendingCertifications,
        totalApplications: apps.length,
        totalAccepted: apps.filter(a => a.status === "accepted").length,
        totalTrainers: allUsers.filter(u => u.role === "trainer").length
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch dashboard stats" });
    }
  });

  app.get("/api/settings", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { category } = req.query;
      if (category && typeof category === "string") {
        const settings = await storage.getAppSettingsByCategory(category);
        res.json(settings);
      } else {
        const settings = await storage.getAllAppSettings();
        res.json(settings);
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.get("/api/settings/:key", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const key = req.params.key as string;
      const setting = await storage.getAppSetting(key);
      if (!setting) {
        return res.status(404).json({ error: "Setting not found" });
      }
      res.json(setting);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch setting" });
    }
  });

  app.post("/api/settings", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { key, value, category, description, updatedBy } = req.body;
      if (!key || !category) {
        return res.status(400).json({ error: "Key and category are required" });
      }
      const setting = await storage.upsertAppSetting(key, value || "", category, description, updatedBy);
      res.json(setting);
      logActivity("Created setting", "Settings", undefined, `Created setting: ${req.body.key}`, req.session.userId);
    } catch (error) {
      res.status(500).json({ error: "Failed to save setting" });
    }
  });

  app.put("/api/settings/:key", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const key = req.params.key as string;
      const { value, category, description, updatedBy } = req.body;
      const setting = await storage.upsertAppSetting(key, value || "", category || "general", description, updatedBy);
      res.json(setting);
      logActivity("Updated setting", "Settings", undefined, `Updated setting: ${req.params.key}`, req.session.userId);
    } catch (error) {
      res.status(500).json({ error: "Failed to update setting" });
    }
  });

  app.delete("/api/settings/:key", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const key = req.params.key as string;
      await storage.deleteAppSetting(key);
      logActivity("Deleted setting", "Settings", undefined, `Deleted setting: ${req.params.key}`, req.session.userId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete setting" });
    }
  });

  app.post("/api/settings/initialize-defaults", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const defaults = [
        // Website & Branding
        { key: "site_name", value: "The Metrics", category: "website", description: "Website name displayed in header" },
        { key: "site_tagline", value: "Remote Product Insights Upload Associates", category: "website", description: "Website tagline" },
        { key: "contact_email", value: "info@portermetricscareeronboarding.com", category: "website", description: "Contact email address" },
        { key: "support_phone", value: "", category: "website", description: "Support phone number (optional)" },
        { key: "primary_color", value: "#3b82f6", category: "website", description: "Primary brand color (hex)" },
        
        // Features
        { key: "enable_chatbot", value: "true", category: "features", description: "Enable Porter AI chatbot" },
        { key: "enable_live_chat", value: "true", category: "features", description: "Enable Smartsupp live chat" },
        { key: "enable_referral_program", value: "true", category: "features", description: "Enable referral tracking" },
        { key: "enable_document_upload", value: "true", category: "features", description: "Allow applicants to upload documents" },
        { key: "enable_training_calendar", value: "true", category: "features", description: "Enable interactive training calendar" },
        
        // Application
        { key: "default_application_status", value: "under_review", category: "application", description: "Default status for new applications" },
        { key: "require_resume", value: "false", category: "application", description: "Require resume for application" },
        { key: "auto_assign_trainer", value: "false", category: "application", description: "Automatically assign trainers to accepted applicants" },
        
        // Training
        { key: "training_session_duration", value: "60", category: "training", description: "Default training session duration in minutes" },
        { key: "max_session_attendees", value: "5", category: "training", description: "Default maximum attendees per session" },
        { key: "require_dual_confirmation", value: "true", category: "training", description: "Both trainer and trainee must confirm completion" },
        
        // Earnings
        { key: "commission_min", value: "0.5", category: "earnings", description: "Minimum commission percentage" },
        { key: "commission_max", value: "2", category: "earnings", description: "Maximum commission percentage" },
        { key: "combo_multiplier", value: "6", category: "earnings", description: "Commission multiplier for combo products" },
        
        // Notifications
        { key: "enable_email_notifications", value: "true", category: "notifications", description: "Send email notifications for status changes" },
        { key: "enable_push_notifications", value: "true", category: "notifications", description: "Enable browser push notifications" },
        { key: "admin_email_alerts", value: "true", category: "notifications", description: "Email admins on new applications" },
        { key: "reminder_hours_before", value: "24", category: "notifications", description: "Hours before session to send reminder" },
        { key: "trainer_assignment_notify", value: "true", category: "notifications", description: "Notify trainers when trainees are assigned" },
        { key: "session_booking_notify", value: "true", category: "notifications", description: "Notify trainers when sessions are booked" },
        
        // Application Form
        { key: "resume_required", value: "false", category: "application_form", description: "Require resume/CV upload" },
        { key: "linkedin_required", value: "false", category: "application_form", description: "Require LinkedIn profile URL" },
        { key: "application_auto_close_days", value: "30", category: "application_form", description: "Days before auto-closing incomplete applications" },
        
        // Referral System
        { key: "referral_bonus_enabled", value: "false", category: "referral", description: "Enable referral bonuses" },
        { key: "referral_bonus_amount", value: "50", category: "referral", description: "Bonus amount per successful referral ($)" },
        { key: "referral_min_training_complete", value: "true", category: "referral", description: "Require training completion for bonus" },
        
        // Conversion Elements
        { key: "show_urgency_banner", value: "true", category: "conversion", description: "Show urgency banner on landing page" },
        { key: "show_social_proof", value: "true", category: "conversion", description: "Show 'Someone just applied' notifications" },
        { key: "show_countdown_timer", value: "true", category: "conversion", description: "Show application deadline countdown" },
        { key: "show_visitor_counter", value: "true", category: "conversion", description: "Show live visitor counter" },
        { key: "show_earnings_calculator", value: "true", category: "conversion", description: "Show earnings calculator section" },
        
        // Archive & Maintenance
        { key: "auto_archive_days", value: "7", category: "maintenance", description: "Days after session to auto-archive" },
        { key: "session_cleanup_enabled", value: "true", category: "maintenance", description: "Enable automatic session cleanup" },
        { key: "data_retention_days", value: "365", category: "maintenance", description: "Days to retain application data" },
        
        // Security
        { key: "require_staff_approval", value: "true", category: "security", description: "Require admin approval for new staff" },
        { key: "session_timeout_hours", value: "24", category: "security", description: "Session timeout in hours" },
        { key: "max_login_attempts", value: "5", category: "security", description: "Maximum failed login attempts before lockout" },
        { key: "password_min_length", value: "8", category: "security", description: "Minimum password length" },
        
        // Appearance
        { key: "accent_color", value: "#6366f1", category: "appearance", description: "Accent/secondary brand color (hex)" },
        { key: "logo_url", value: "", category: "appearance", description: "Custom logo URL" },
        { key: "favicon_url", value: "", category: "appearance", description: "Custom favicon URL" },
      ];

      for (const setting of defaults) {
        const existing = await storage.getAppSetting(setting.key);
        if (!existing) {
          await storage.upsertAppSetting(setting.key, setting.value, setting.category, setting.description);
        }
      }

      const allSettings = await storage.getAllAppSettings();
      res.json(allSettings);
    } catch (error) {
      res.status(500).json({ error: "Failed to initialize default settings" });
    }
  });

  app.get("/api/reminders/settings/:trainerId", requireAuth, async (req, res) => {
    try {
      const trainerId = req.params.trainerId as string;
      let settings = await storage.getReminderSettings(trainerId);
      
      if (!settings) {
        settings = await storage.upsertReminderSettings(trainerId, {});
      }
      
      res.json(settings);
    } catch (error) {
      logger.error("Failed to fetch reminder settings:", error);
      res.status(500).json({ error: "Failed to fetch reminder settings" });
    }
  });

  app.put("/api/reminders/settings/:trainerId", requireAuth, async (req, res) => {
    try {
      const trainerId = req.params.trainerId as string;
      const settings = await storage.upsertReminderSettings(trainerId, req.body);
      res.json(settings);
    } catch (error) {
      logger.error("Failed to update reminder settings:", error);
      res.status(500).json({ error: "Failed to update reminder settings" });
    }
  });

  app.get("/api/reminders/upcoming/:trainerId", requireAuth, async (req, res) => {
    try {
      const { trainerId } = req.params;
      const sessions24h = await getUpcomingSessions(24);
      const trainerSessions = sessions24h.filter(s => s.trainerId === trainerId);
      res.json(trainerSessions);
    } catch (error) {
      logger.error("Failed to fetch upcoming sessions:", error);
      res.status(500).json({ error: "Failed to fetch upcoming sessions" });
    }
  });

  app.get("/api/reminders/pending-tasks/:trainerId", requireAuth, async (req, res) => {
    try {
      const trainerId = req.params.trainerId as string;
      const tasks = await getPendingTasksForTrainer(trainerId);
      res.json(tasks);
    } catch (error) {
      logger.error("Failed to fetch pending tasks:", error);
      res.status(500).json({ error: "Failed to fetch pending tasks" });
    }
  });

  app.get("/api/reminders/history/:trainerId", requireAuth, async (req, res) => {
    try {
      const trainerId = req.params.trainerId as string;
      const reminders = await storage.getScheduledRemindersByTrainer(trainerId);
      res.json(reminders);
    } catch (error) {
      logger.error("Failed to fetch reminder history:", error);
      res.status(500).json({ error: "Failed to fetch reminder history" });
    }
  });

  app.get("/api/reminders/all-logs", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const reminders = await storage.getAllScheduledReminders();
      const allUsers = await storage.getAllUsers();
      const userMap = new Map(allUsers.map(u => [u.id, u.name]));
      const enriched = reminders.map(r => ({
        ...r,
        trainerName: userMap.get(r.trainerId) || "Unknown"
      }));
      res.json(enriched);
    } catch (error) {
      logger.error("Failed to fetch all reminder logs:", error);
      res.status(500).json({ error: "Failed to fetch reminder logs" });
    }
  });

  app.post("/api/reminders/send-test/:trainerId", requireAuth, async (req, res) => {
    try {
      const trainerId = req.params.trainerId as string;
      const { type, applicationIds } = req.body;
      
      if (type === "pending_tasks") {
        const success = await sendPendingTasksReminder(trainerId, applicationIds);
        res.json({ success, message: success ? "Pending tasks reminder sent" : "No pending tasks or notifications disabled" });
      } else {
        res.status(400).json({ error: "Invalid reminder type" });
      }
    } catch (error) {
      logger.error("Failed to send test reminder:", error);
      res.status(500).json({ error: "Failed to send test reminder" });
    }
  });

  app.post("/api/reminders/process", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const result = await processScheduledReminders();
      res.json(result);
    } catch (error) {
      logger.error("Failed to process reminders:", error);
      res.status(500).json({ error: "Failed to process reminders" });
    }
  });

  app.get("/api/push/vapid-public-key", (req, res) => {
    res.json({ publicKey: getVapidPublicKey() });
  });

  app.post("/api/push/subscribe", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId as string;
      const { subscription, userAgent } = req.body;
      
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return res.status(400).json({ error: "Invalid subscription data" });
      }
      
      const existing = await storage.getPushSubscriptionByEndpoint(subscription.endpoint);
      if (existing) {
        await storage.updatePushSubscription(existing.id, {
          userId,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          userAgent,
          isActive: "true"
        });
        return res.json({ success: true, message: "Subscription updated" });
      }
      
      await storage.createPushSubscription({
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent,
        isActive: "true"
      });
      
      res.json({ success: true, message: "Subscription created" });
    } catch (error) {
      logger.error("Failed to save push subscription:", error);
      res.status(500).json({ error: "Failed to save subscription" });
    }
  });

  app.post("/api/push/unsubscribe", async (req, res) => {
    try {
      const { endpoint } = req.body;
      
      if (!endpoint) {
        return res.status(400).json({ error: "Endpoint required" });
      }
      
      await storage.deletePushSubscriptionByEndpoint(endpoint);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to unsubscribe:", error);
      res.status(500).json({ error: "Failed to unsubscribe" });
    }
  });

  app.get("/api/push/subscriptions/:userId", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId as string;
      const subscriptions = await storage.getPushSubscriptionsByUser(userId);
      res.json(subscriptions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch subscriptions" });
    }
  });

  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId as string;
      const notificationList = await storage.getNotificationsByUser(userId);
      res.json(notificationList);
    } catch (error) {
      logger.error("Error fetching notifications:", error);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  app.get("/api/notifications/count", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId as string;
      const count = await storage.getUnreadNotificationCount(userId);
      res.json({ count });
    } catch (error) {
      res.status(500).json({ error: "Failed to get notification count" });
    }
  });

  app.post("/api/notifications", requireAuth, async (req, res) => {
    try {
      const notification = await storage.createNotification(req.body);
      res.json(notification);
    } catch (error) {
      logger.error("Error creating notification:", error);
      res.status(500).json({ error: "Failed to create notification" });
    }
  });

  app.put("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId as string;
      const userNotifications = await storage.getNotificationsByUser(userId);
      const owned = userNotifications.find((n: any) => n.id === req.params.id);
      if (!owned) {
        return res.status(404).json({ error: "Notification not found" });
      }
      const notification = await storage.markNotificationAsRead(req.params.id as string);
      res.json(notification);
    } catch (error) {
      res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  app.put("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId as string;
      await storage.markAllNotificationsAsRead(userId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark all as read" });
    }
  });

  app.delete("/api/notifications/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId as string;
      const userNotifications = await storage.getNotificationsByUser(userId);
      const owned = userNotifications.find((n: any) => n.id === req.params.id);
      if (!owned) {
        return res.status(404).json({ error: "Notification not found" });
      }
      await storage.deleteNotification(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete notification" });
    }
  });

  app.delete("/api/notifications", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId as string;
      await storage.deleteAllNotifications(userId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete all notifications" });
    }
  });

  app.get("/api/referrer-stats/:referrerId", requireAuth, async (req, res) => {
    try {
      const referrerId = req.params.referrerId as string;
      const user = await storage.getUser(referrerId);
      if (!user || user.role !== 'referrer') {
        return res.status(404).json({ error: "Referrer not found" });
      }
      
      // Get referral code for this referrer
      const referralCode = user.referralCode || user.affiliateCode;
      
      // Get all users referred by this referrer
      const allUsers = await storage.getAllUsers();
      const referredUsers = referralCode 
        ? allUsers.filter((u: User) => u.referredBy === referralCode && u.role === 'applicant')
        : [];
      
      // Get applications for referred users
      const allApplications = await storage.getAllApplications();
      const referredApplications = allApplications.filter(app => 
        referredUsers.some(u => u.id === app.applicantId)
      );
      
      // Calculate stats
      const totalReferrals = referredApplications.length;
      const acceptedReferrals = referredApplications.filter(a => a.status === 'accepted').length;
      const inTraining = referredApplications.filter(a => a.trainingStatus === 'scheduled' || a.trainingStatus === 'confirmed').length;
      const completedTraining = referredApplications.filter(a => a.trainingStatus === 'completed').length;
      const pendingReview = referredApplications.filter(a => a.status === 'under_review' || a.status === 'submitted').length;
      
      // Calculate conversion rate
      const conversionRate = totalReferrals > 0 
        ? Math.round((acceptedReferrals / totalReferrals) * 100)
        : 0;
      
      // Build response with user info
      const referredAppsWithInfo = referredApplications.map(app => {
        const appUser = referredUsers.find(u => u.id === app.applicantId);
        return {
          id: app.id,
          name: appUser?.name || 'Unknown',
          email: appUser?.email || 'Unknown',
          status: app.status,
          trainingStatus: app.trainingStatus,
          appliedAt: app.appliedAt
        };
      });
      
      res.json({
        referrerId,
        referralCode,
        totalReferrals,
        acceptedReferrals,
        inTraining,
        completedTraining,
        pendingReview,
        conversionRate,
        referredApplications: referredAppsWithInfo
      });
    } catch (error) {
      logger.error("Error fetching referrer stats:", error);
      res.status(500).json({ error: "Failed to fetch referrer stats" });
    }
  });

  app.get("/api/recommendations/:trainerId", requireAuth, async (req, res) => {
    try {
      const trainerId = req.params.trainerId as string;
      const user = await storage.getUser(trainerId);
      
      if (!user || user.role !== "trainer") {
        return res.status(404).json({ error: "Trainer not found" });
      }
      
      const insights = await generateTrainerRecommendations(trainerId);
      res.json(insights);
    } catch (error) {
      logger.error("Failed to generate recommendations:", error);
      res.status(500).json({ error: "Failed to generate recommendations" });
    }
  });

  app.get("/api/recommendations/:trainerId/quick-tip", requireAuth, async (req, res) => {
    try {
      const trainerId = req.params.trainerId as string;
      const tip = await getQuickTip(trainerId);
      res.json(tip);
    } catch (error) {
      logger.error("Failed to get quick tip:", error);
      res.status(500).json({ error: "Failed to get quick tip" });
    }
  });

  app.get("/api/admin/insights", requireRole("admin"), async (req, res) => {
    try {
      const insights = await generateAdminInsights();
      res.json(insights);
    } catch (error) {
      logger.error("Failed to generate admin insights:", error);
      res.status(500).json({ error: "Failed to generate admin insights" });
    }
  });

  app.get("/api/recommendations/:trainerId/trainee-performance", requireAuth, async (req, res) => {
    try {
      const trainerId = req.params.trainerId as string;
      const user = await storage.getUser(trainerId);
      
      if (!user || user.role !== "trainer") {
        return res.status(404).json({ error: "Trainer not found" });
      }
      
      const insights = await generateTraineePerformanceInsights(trainerId);
      res.json(insights);
    } catch (error) {
      logger.error("Failed to generate trainee performance insights:", error);
      res.status(500).json({ error: "Failed to generate trainee performance insights" });
    }
  });

  app.get("/api/dashboard-widgets/:userId", requireAuth, async (req, res) => {
    try {
      const userId = req.params.userId as string;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const widgets = await storage.initializeDefaultWidgets(userId, user.role);
      res.json(widgets);
    } catch (error) {
      logger.error("Failed to fetch dashboard widgets:", error);
      res.status(500).json({ error: "Failed to fetch dashboard widgets" });
    }
  });

  app.post("/api/dashboard-widgets", requireAuth, async (req, res) => {
    try {
      const widget = await storage.createDashboardWidget(req.body);
      res.json(widget);
    } catch (error) {
      logger.error("Failed to create dashboard widget:", error);
      res.status(500).json({ error: "Failed to create dashboard widget" });
    }
  });

  app.patch("/api/dashboard-widgets/:id", requireAuth, async (req, res) => {
    try {
      const id = req.params.id as string;
      const widget = await storage.updateDashboardWidget(id, req.body);
      if (!widget) {
        return res.status(404).json({ error: "Widget not found" });
      }
      res.json(widget);
    } catch (error) {
      logger.error("Failed to update dashboard widget:", error);
      res.status(500).json({ error: "Failed to update dashboard widget" });
    }
  });

  app.delete("/api/dashboard-widgets/:id", requireAuth, async (req, res) => {
    try {
      const id = req.params.id as string;
      await storage.deleteDashboardWidget(id);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete dashboard widget:", error);
      res.status(500).json({ error: "Failed to delete dashboard widget" });
    }
  });

  app.put("/api/dashboard-widgets/positions", requireAuth, async (req, res) => {
    try {
      const { userId, positions } = req.body;
      await storage.updateDashboardWidgetPositions(userId, positions);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to update widget positions:", error);
      res.status(500).json({ error: "Failed to update widget positions" });
    }
  });

  app.post("/api/upload-announcement-image", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter: (_req: any, file: any, cb: any) => {
          if (file.mimetype.startsWith("image/")) {
            cb(null, true);
          } else {
            cb(new Error("Only image files are allowed"));
          }
        },
      });

      upload.single("image")(req, res, async (err: any) => {
        if (err) {
          return res.status(400).json({ error: err.message || "Image upload failed" });
        }
        if (!req.file) {
          return res.status(400).json({ error: "No image file provided" });
        }

        try {
          const { ObjectStorageService } = await import("../replit_integrations/object_storage/objectStorage");
          const objectStorageService = new ObjectStorageService();
          const uploadURL = await objectStorageService.getObjectEntityUploadURL();

          const uploadRes = await fetch(uploadURL, {
            method: "PUT",
            headers: { "Content-Type": req.file.mimetype },
            body: req.file.buffer as unknown as BodyInit,
          });

          if (!uploadRes.ok) {
            throw new Error("Failed to upload to object storage");
          }

          const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
          const publicUrl = `${req.protocol}://${req.get("host")}${objectPath}`;

          res.json({ imageUrl: publicUrl, objectPath });
        } catch (uploadError) {
          logger.error("Failed to upload announcement image:", uploadError);
          res.status(500).json({ error: "Failed to upload image" });
        }
      });
    } catch (error) {
      logger.error("Announcement image upload error:", error);
      res.status(500).json({ error: "Failed to process image upload" });
    }
  });

  app.post("/api/announcements", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { adminId, subject, message, recipientType, recipientIds, imageUrl, smtpAccountId: rawSmtpId, companyName, companyTagline, companyEmail } = req.body;
      
      if (!subject || !message || !recipientType) {
        return res.status(400).json({ error: "Subject, message, and recipient type are required" });
      }

      const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
      if (smtpAccountId !== undefined && isNaN(smtpAccountId)) {
        return res.status(400).json({ error: "Invalid smtpAccountId" });
      }
      const branding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } as any : undefined;
      
      // Get recipients based on type
      const allUsers = await db.select().from(users);
      let recipients: typeof allUsers = [];
      
      if (recipientType === "all_staff") {
        recipients = allUsers.filter((u) => u.role === "trainer" || u.role === "referrer");
      } else if (recipientType === "trainers") {
        recipients = allUsers.filter((u) => u.role === "trainer");
      } else if (recipientType === "referrers") {
        recipients = allUsers.filter((u) => u.role === "referrer");
      } else if (recipientType === "selected" && recipientIds?.length) {
        recipients = allUsers.filter((u) => recipientIds.includes(u.id));
      }
      
      if (recipients.length === 0) {
        return res.status(400).json({ error: "No recipients found" });
      }
      
      // Fire-and-forget email sending
      const { sendStaffAnnouncementEmail } = await import('../email');
      
      for (const recipient of recipients) {
        sendStaffAnnouncementEmail(recipient.email, recipient.name, subject, message, imageUrl, { smtpAccountId, branding })
          .catch(err => logger.error(`Failed to send announcement to ${recipient.email}:`, err));
      }
      
      // Send in-app notifications
      for (const recipient of recipients) {
        try {
          const dashboardPath = recipient.role === "trainer" ? "/trainer" : recipient.role === "referrer" ? "/referrer" : "/dashboard";
          await storage.createNotification({
            userId: recipient.id,
            title: `📢 ${subject}`,
            message: message.substring(0, 200) + (message.length > 200 ? "..." : ""),
            type: "system",
            link: `${dashboardPath}?section=announcements`,
            isRead: "false",
          });
        } catch (notifError) {
          logger.error(`Failed to create notification for ${recipient.id}:`, notifError);
        }
      }
      
      // Store announcement
      await db.insert(announcements).values({
        adminId,
        subject,
        message,
        recipientType,
        recipientIds: recipientIds || [],
        imageUrl: imageUrl || null,
        emailsSent: recipients.length,
      });
      
      res.json({ 
        success: true, 
        emailsSent: recipients.length,
        notificationsSent: recipients.length,
        message: `Announcement sent to ${recipients.length} staff members`
      });
    } catch (error) {
      logger.error("Failed to send announcement:", error);
      res.status(500).json({ error: "Failed to send announcement" });
    }
  });

  app.get("/api/announcements", requireAuth, async (req, res) => {
    try {
      const { role, userId } = req.query;
      let allAnnouncements = await db.select().from(announcements).orderBy(sql`created_at DESC`).limit(50);
      
      if (role && typeof role === "string" && role !== "admin") {
        allAnnouncements = allAnnouncements.filter(a => {
          if (a.recipientType === "all_staff") return true;
          if (a.recipientType === "trainers" && role === "trainer") return true;
          if (a.recipientType === "referrers" && role === "referrer") return true;
          if (a.recipientType === "selected" && userId && a.recipientIds?.includes(userId as string)) return true;
          return false;
        });
      }
      
      res.json(allAnnouncements);
    } catch (error) {
      logger.error("Failed to get announcements:", error);
      res.status(500).json({ error: "Failed to get announcements" });
    }
  });

  app.post("/api/visitors/track", async (req, res) => {
    const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "unknown";
    const count = visitorTrackLimiter.get(clientIp) || 0;
    if (count > 30) {
      return res.status(429).json({ error: "Too many requests" });
    }
    visitorTrackLimiter.set(clientIp, count + 1);
    try {
      const { page, referrer, sessionId } = req.body;
      if (!page) return res.status(400).json({ error: "Page is required" });

      const userAgent = req.headers["user-agent"] || "";
      const ipAddress = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "unknown";
      
      let device = "Desktop";
      if (/mobile|android|iphone|ipad/i.test(userAgent)) device = "Mobile";
      else if (/tablet|ipad/i.test(userAgent)) device = "Tablet";

      let browser = "Unknown";
      if (/edg/i.test(userAgent)) browser = "Edge";
      else if (/chrome/i.test(userAgent)) browser = "Chrome";
      else if (/firefox/i.test(userAgent)) browser = "Firefox";
      else if (/safari/i.test(userAgent)) browser = "Safari";
      else if (/opera|opr/i.test(userAgent)) browser = "Opera";

      let os = "Unknown";
      if (/windows/i.test(userAgent)) os = "Windows";
      else if (/mac/i.test(userAgent)) os = "macOS";
      else if (/linux/i.test(userAgent)) os = "Linux";
      else if (/android/i.test(userAgent)) os = "Android";
      else if (/iphone|ipad/i.test(userAgent)) os = "iOS";

      let country: string | null = null;
      let city: string | null = null;
      try {
        const geoData = await lookupIpGeo(ipAddress);
        if (geoData) {
          country = geoData.country;
          city = geoData.city;
        }
      } catch {}

      const { visitor, isNew } = await storage.trackSiteVisitor({
        ipAddress,
        userAgent,
        page,
        referrer: referrer || null,
        country,
        city,
        device,
        browser,
        os,
        sessionId: sessionId || null,
      });

      if (isNew) {
        const now = Date.now();
        if (now - lastVisitorPushTime >= VISITOR_PUSH_COOLDOWN_MS) {
          lastVisitorPushTime = now;
          sendPushToRole("admin", {
            title: "New Website Visitor",
            body: `${device} visitor from ${country || "Unknown"} on ${page}`,
            url: "/admin",
            tag: "visitor-alert",
            requireInteraction: false,
          }).catch((err: any) => logger.error("Visitor push failed:", err));
        }
      }

      res.json({ success: true, id: visitor.id, isNew, visitCount: visitor.visitCount });
    } catch (error) {
      logger.error("Failed to track visitor:", error);
      res.status(500).json({ error: "Failed to track visitor" });
    }
  });

  app.get("/api/visitors/stats", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const stats = await storage.getSiteVisitorStats();
      res.json(stats);
    } catch (error) {
      logger.error("Failed to get visitor stats:", error);
      res.status(500).json({ error: "Failed to get visitor stats" });
    }
  });

  app.get("/api/visitors", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const result = await storage.getSiteVisitors({ page, limit });
      res.json(result);
    } catch (error) {
      logger.error("Failed to get visitors:", error);
      res.status(500).json({ error: "Failed to get visitors" });
    }
  });

  app.get("/api/customer-reports", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const stage = req.query.stage as string;
      const reports = stage ? await storage.getCustomerReportsByStage(stage) : await storage.getAllCustomerReports();
      res.json(reports);
    } catch (error) {
      logger.error("Failed to get customer reports:", error);
      res.status(500).json({ error: "Failed to get customer reports" });
    }
  });

  app.post("/api/customer-reports", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const report = await storage.createCustomerReport({
        ...req.body,
        createdBy: req.session.userId || null,
      });
      res.json(report);
    } catch (error) {
      logger.error("Failed to create customer report:", error);
      res.status(500).json({ error: "Failed to create customer report" });
    }
  });

  app.post("/api/customer-reports/bulk-update-stage", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { ids, stage } = req.body;
      if (!Array.isArray(ids) || !stage) return res.status(400).json({ error: "ids and stage required" });
      const count = await storage.bulkUpdateCustomerBillingStage(ids, stage, req.session.userId || undefined);
      res.json({ success: true, updated: count });
    } catch (error) {
      logger.error("Failed to bulk update:", error);
      res.status(500).json({ error: "Failed to bulk update" });
    }
  });

  app.get("/api/customer-reports/stats", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const stats = await storage.getCustomerReportStats();
      res.json(stats);
    } catch (error) {
      logger.error("Failed to get customer report stats:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  app.get("/api/customer-reports/export/csv", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const stage = req.query.stage as string;
      const reports = stage ? await storage.getCustomerReportsByStage(stage) : await storage.getAllCustomerReports();
      const allHistory = await storage.getAllCustomerReportHistory();
      const historyMap = new Map<string, typeof allHistory>();
      for (const h of allHistory) {
        const arr = historyMap.get(h.customerReportId) || [];
        arr.push(h);
        historyMap.set(h.customerReportId, arr);
      }

      let csv = "ID,Customer Name,Email,Phone,Billing Stage,Deposit,Negative Amount,Revenue,Notes,Created At,Change History\n";
      for (const r of reports) {
        const history = historyMap.get(r.id) || [];
        const historyStr = history.map(h => `${h.field}: ${h.oldValue} -> ${h.newValue} (${h.changedBy || 'system'} at ${h.createdAt})`).join(" | ");
        csv += `"${r.id}","${r.customerName}","${r.email || ''}","${r.phone || ''}","${r.billingStage}","${r.depositAmount}","${r.negativeAmount}","${r.revenue}","${(r.notes || '').replace(/"/g, '""')}","${r.createdAt}","${historyStr.replace(/"/g, '""')}"\n`;
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=customer-reports.csv");
      res.send(csv);
    } catch (error) {
      logger.error("Failed to export customer reports:", error);
      res.status(500).json({ error: "Failed to export" });
    }
  });

  app.patch("/api/customer-reports/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const updated = await storage.updateCustomerReport(req.params.id as string, req.body, req.session.userId || undefined);
      if (!updated) return res.status(404).json({ error: "Report not found" });
      res.json(updated);
    } catch (error) {
      logger.error("Failed to update customer report:", error);
      res.status(500).json({ error: "Failed to update customer report" });
    }
  });

  app.delete("/api/customer-reports/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteCustomerReport(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete customer report:", error);
      res.status(500).json({ error: "Failed to delete" });
    }
  });

  app.get("/api/customer-reports/:id/history", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const history = await storage.getCustomerReportHistory(req.params.id as string);
      res.json(history);
    } catch (error) {
      logger.error("Failed to get customer report history:", error);
      res.status(500).json({ error: "Failed to get history" });
    }
  });

  app.get("/api/job-offers", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.expireOldJobOffers();
      const offers = await storage.getAllJobOffers();
      const stats = await storage.getJobOfferStats();
      res.json({ offers, stats });
    } catch (error) {
      logger.error("Failed to get job offers:", error);
      res.status(500).json({ error: "Failed to get job offers" });
    }
  });

  app.post("/api/job-offers", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { emails, country, smtpAccountId: rawSmtpId, companyName, companyTagline, companyEmail } = req.body;
      if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: "Please provide at least one email address" });
      }

      const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
      if (smtpAccountId !== undefined && isNaN(smtpAccountId)) {
        return res.status(400).json({ error: "Invalid smtpAccountId" });
      }
      const branding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } as any : undefined;

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const results: { email: string; success: boolean; error?: string }[] = [];
      const adminId = req.session.userId;

      for (const rawEmail of emails) {
        const email = String(rawEmail).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          results.push({ email, success: false, error: "Invalid email format" });
          continue;
        }

        try {
          const crypto = await import("crypto");
          const token = crypto.randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

          await storage.createJobOffer({
            email,
            token,
            status: "pending",
            expiresAt,
            country: country || null,
            sentBy: adminId || undefined,
          });

          const { sendJobOfferEmail } = await import("../email");
          sendJobOfferEmail(email, token, baseUrl, country, { smtpAccountId, branding }).catch(err => {
            logger.error(`Failed to send job offer email to ${email}:`, err);
          });

          results.push({ email, success: true });
        } catch (err: any) {
          results.push({ email, success: false, error: err.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      logActivity("Sent job offers", "JobOffer", undefined, `Sent ${successCount} job offer(s)`, adminId);
      res.json({ results, sent: successCount, failed: results.length - successCount });
    } catch (error) {
      logger.error("Failed to create job offers:", error);
      res.status(500).json({ error: "Failed to send job offers" });
    }
  });

  app.post("/api/job-offers/:id/resend", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const offerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const offer = await storage.getJobOfferById(offerId);
      if (!offer) return res.status(404).json({ error: "Job offer not found" });
      if (offer.status === "accepted") return res.status(400).json({ error: "This offer has already been accepted" });

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await storage.updateJobOffer(offer.id, {
        status: "pending",
        expiresAt: newExpiresAt,
        resentAt: new Date(),
        resentCount: (offer.resentCount || 0) + 1,
      });

      const { smtpAccountId: rawSmtpId, companyName, companyTagline, companyEmail } = req.body || {};
      const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
      const branding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } as any : undefined;

      const { sendJobOfferEmail } = await import("../email");
      sendJobOfferEmail(offer.email, offer.token, baseUrl, offer.country, { smtpAccountId: (smtpAccountId && !isNaN(smtpAccountId)) ? smtpAccountId : undefined, branding }).catch(err => {
        logger.error(`Failed to resend job offer email to ${offer.email}:`, err);
      });

      res.json({ success: true, message: "Job offer resent successfully" });
    } catch (error) {
      logger.error("Failed to resend job offer:", error);
      res.status(500).json({ error: "Failed to resend job offer" });
    }
  });

  app.get("/api/job-offers/by-token/:token", async (req, res) => {
    try {
      const offer = await storage.getJobOfferByToken(req.params.token);
      if (!offer) return res.status(404).json({ error: "Job offer not found" });

      if (offer.status === "accepted") {
        return res.json({ status: "accepted", message: "This offer has already been accepted." });
      }

      if (offer.status === "expired" || (offer.expiresAt && offer.expiresAt < new Date())) {
        if (offer.status !== "expired") {
          await storage.updateJobOffer(offer.id, { status: "expired" });
        }
        return res.json({ status: "expired", message: "This offer has expired." });
      }

      res.json({
        status: "pending",
        email: offer.email,
        expiresAt: offer.expiresAt,
      });
    } catch (error) {
      logger.error("Failed to get job offer:", error);
      res.status(500).json({ error: "Failed to get job offer" });
    }
  });

  app.post("/api/job-offers/by-token/:token/accept", async (req, res) => {
    try {
      const offer = await storage.getJobOfferByToken(req.params.token);
      if (!offer) return res.status(404).json({ error: "Job offer not found" });

      if (offer.status === "accepted") {
        return res.status(400).json({ error: "This offer has already been accepted." });
      }
      if (offer.status === "expired" || (offer.expiresAt && offer.expiresAt < new Date())) {
        return res.status(400).json({ error: "This offer has expired." });
      }

      const { name, whatsappNumber, telegramHandle, preferredContact, country, gender, nationality,
        experienceLevel, availability, motivation, hasComputerAccess, primaryDevice, linkedinUrl,
        preferredDate, preferredTime, timezone, notes } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ error: "Name is required" });
      }

      const validExperienceLevels = ["entry", "some", "experienced"];
      const validAvailabilities = ["full_time", "part_time", "flexible"];
      const safeExperienceLevel = validExperienceLevels.includes(experienceLevel) ? experienceLevel : undefined;
      const safeAvailability = validAvailabilities.includes(availability) ? availability : undefined;

      const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

      let user = await storage.getUserByEmail(offer.email);
      if (!user) {
        user = await storage.createUser({
          name: name.trim(),
          email: offer.email,
          role: "applicant",
          whatsappNumber: whatsappNumber || undefined,
          telegramHandle: telegramHandle || undefined,
          preferredContact: preferredContact || undefined,
          country: country || undefined,
          experienceLevel: safeExperienceLevel,
          availability: safeAvailability,
          motivation: motivation || undefined,
          hasComputerAccess: hasComputerAccess || "false",
          primaryDevice: primaryDevice || undefined,
          linkedinUrl: linkedinUrl || undefined,
          gender: gender || undefined,
          nationality: nationality || undefined,
        });
      } else {
        const userUpdates: Record<string, any> = { name: name.trim() };
        if (whatsappNumber) userUpdates.whatsappNumber = whatsappNumber;
        if (telegramHandle) userUpdates.telegramHandle = telegramHandle;
        if (preferredContact) userUpdates.preferredContact = preferredContact;
        if (country) userUpdates.country = country;
        if (safeExperienceLevel) userUpdates.experienceLevel = safeExperienceLevel;
        if (safeAvailability) userUpdates.availability = safeAvailability;
        if (motivation) userUpdates.motivation = motivation;
        if (hasComputerAccess) userUpdates.hasComputerAccess = hasComputerAccess;
        if (primaryDevice) userUpdates.primaryDevice = primaryDevice;
        if (linkedinUrl) userUpdates.linkedinUrl = linkedinUrl;
        if (gender) userUpdates.gender = gender;
        if (nationality) userUpdates.nationality = nationality;
        await storage.updateUser(user.id, userUpdates);
      }

      let application = await storage.getApplicationByApplicantId(user.id);
      if (!application) {
        application = await storage.createApplication({
          applicantId: user.id,
          status: "under_review",
          ipAddress: clientIp,
        });

        lookupIpGeo(clientIp).then(geo => {
          if (geo) {
            storage.updateApplication(application!.id, { ipCountry: geo.country, ipCity: geo.city }).catch(logger.error);
          }
        }).catch(logger.error);

        storage.linkVisitorToApplicant(clientIp, name.trim()).catch(logger.error);
      }

      if (preferredDate && preferredTime && whatsappNumber) {
        try {
          await storage.createTrainingAppointment({
            applicationId: application.id,
            applicantId: user.id,
            trainerId: user.id,
            startTime: new Date(`${preferredDate}T${preferredTime}`),
            endTime: new Date(`${preferredDate}T${preferredTime}`),
            preferredDate,
            preferredTime,
            whatsappNumber: whatsappNumber.trim(),
            timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
            notes: notes || undefined,
          });
        } catch (appointmentErr) {
          logger.error("Failed to create training appointment from job offer:", appointmentErr);
        }
      }

      await storage.updateJobOffer(offer.id, {
        status: "accepted",
        acceptedAt: new Date(),
        ipAddress: clientIp,
        applicationId: application.id,
      });

      lookupIpGeo(clientIp).then(geo => {
        if (geo) {
          storage.updateJobOffer(offer.id, { ipCountry: geo.country, ipCity: geo.city }).catch(logger.error);
        }
      }).catch(logger.error);

      const { sendJobOfferConfirmationEmail } = await import("../email");
      if (preferredDate && preferredTime) {
        sendJobOfferConfirmationEmail(
          offer.email, name.trim(), preferredDate, preferredTime,
          whatsappNumber || "", timezone || "UTC"
        ).catch(logger.error);
      }

      const { sendNewApplicationNotificationEmail } = await import("../email");
      sendNewApplicationNotificationEmail(name.trim(), offer.email, null, country, experienceLevel, motivation).catch(logger.error);

      logActivity("Job offer accepted", "JobOffer", offer.id, `${name} (${offer.email}) accepted job offer`, undefined, clientIp);

      res.json({ success: true, message: "Your application has been submitted and training scheduled!" });
    } catch (error) {
      logger.error("Failed to accept job offer:", error);
      res.status(500).json({ error: "Failed to process your application" });
    }
  });

  app.get("/api/admin/document-templates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const templates = await storage.getAllDocumentTemplates();
      res.json(templates);
    } catch (error) {
      logger.error("Failed to get document templates:", error);
      res.status(500).json({ error: "Failed to get templates" });
    }
  });

  app.post("/api/admin/document-templates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { name, subject, htmlBody, placeholders, theme } = req.body;
      if (!name || !subject || !htmlBody) {
        return res.status(400).json({ error: "Name, subject, and HTML body are required" });
      }
      const template = await storage.createDocumentTemplate({
        name,
        subject,
        htmlBody,
        placeholders: placeholders || [],
        theme: theme || "light",
        isBuiltIn: false,
        createdBy: req.session.userId,
      });
      res.json({ success: true, template });
    } catch (error) {
      logger.error("Failed to create document template:", error);
      res.status(500).json({ error: "Failed to create template" });
    }
  });

  app.put("/api/admin/document-templates/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { name, subject, htmlBody, placeholders, theme } = req.body;
      const template = await storage.updateDocumentTemplate(req.params.id as string, {
        name,
        subject,
        htmlBody,
        placeholders,
        theme,
      });
      if (!template) return res.status(404).json({ error: "Template not found" });
      res.json({ success: true, template });
    } catch (error) {
      logger.error("Failed to update document template:", error);
      res.status(500).json({ error: "Failed to update template" });
    }
  });

  app.delete("/api/admin/document-templates/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const deleted = await storage.deleteDocumentTemplate(req.params.id as string);
      if (!deleted) return res.status(404).json({ error: "Template not found" });
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete document template:", error);
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  app.post("/api/admin/official-documents/send-template", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { templateId, recipientEmail, recipientName, subject, placeholderValues, companyName, departmentName, companyEmail, ccEmail, smtpAccountId, senderAlias } = req.body;

      if (!templateId || !recipientEmail || !recipientName) {
        return res.status(400).json({ error: "Template, recipient email and name are required" });
      }

      const template = await storage.getDocumentTemplate(templateId);
      if (!template) return res.status(404).json({ error: "Template not found" });

      const finalCompanyName = companyName || "PORTERMETRICS AFFILIATES DEPARTMENT";
      const finalCompanyEmail = companyEmail || "info@portermetricscareeronboarding.com";
      const finalSubject = (subject || template.subject).replace(/\[COMPANY NAME\]/g, finalCompanyName).replace(/\[USER NAME\]/g, recipientName);

      const doc = await storage.createOfficialDocument({
        templateId,
        templateName: template.name,
        recipientEmail,
        recipientName,
        subject: finalSubject,
        placeholderValues: JSON.stringify(placeholderValues || {}),
        companyName: finalCompanyName,
        departmentName: departmentName || "Affiliates Operations & Account Integration Division",
        companyEmail: finalCompanyEmail,
        ccEmail: ccEmail || null,
        sentBy: req.session.userId,
      });

      const { sendTemplateEmail } = await import("../email");
      sendTemplateEmail({
        recipientEmail,
        recipientName,
        subject: finalSubject,
        htmlBody: template.htmlBody,
        companyName: finalCompanyName,
        companyEmail: finalCompanyEmail,
        ccEmail: ccEmail || undefined,
        placeholderValues: placeholderValues || {},
        smtpAccountId: smtpAccountId ? Number(smtpAccountId) : undefined,
        senderAlias: senderAlias || undefined,
      }).catch(err => {
        logger.error("Failed to send template email", err);
      });

      res.json({ success: true, document: doc });
    } catch (error) {
      logger.error("Failed to send template document:", error);
      res.status(500).json({ error: "Failed to send template document" });
    }
  });

  app.get("/api/admin/official-documents", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const docs = await storage.getAllOfficialDocuments();
      res.json(docs);
    } catch (error) {
      logger.error("Failed to get official documents:", error);
      res.status(500).json({ error: "Failed to get official documents" });
    }
  });

  app.delete("/api/admin/official-documents/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const docId = req.params.id as string;
      const deleted = await storage.deleteOfficialDocument(docId);
      if (!deleted) return res.status(404).json({ error: "Document not found" });
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete official document:", error);
      res.status(500).json({ error: "Failed to delete official document" });
    }
  });

  app.post("/api/admin/migrate-referral-codes", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const referrers = allUsers.filter(u => u.role === "referrer" && u.referralCode);
      let migrated = 0;

      const { randomBytes } = await import("crypto");
      const usedCodes = new Set(referrers.map(r => r.referralCode));

      for (const referrer of referrers) {
        const oldCode = referrer.referralCode!;
        if (/^REF[A-Z0-9]{7}$/.test(oldCode)) continue;

        let newCode: string;
        do {
          newCode = 'REF' + randomBytes(4).toString('hex').substring(0, 7).toUpperCase();
        } while (usedCodes.has(newCode));
        usedCodes.add(newCode);

        await db.update(users).set({ referralCode: newCode }).where(eq(users.id, referrer.id));
        await db.update(users).set({ referredBy: newCode }).where(eq(users.referredBy, oldCode));

        migrated++;
        logger.info("Migrated referral code", { userId: referrer.id, oldCode, newCode });
      }

      res.json({ success: true, migrated, total: referrers.length });
    } catch (error: any) {
      logger.error("Failed to migrate referral codes", { error: error.message });
      res.status(500).json({ error: "Migration failed: " + error.message });
    }
  });

  app.get("/api/admin/backup", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const allApplications = await storage.getAllApplications();
      const allSessions = await storage.getAllTrainingSessions();
      const allRecords = await storage.getAllTrainerDailyRecords();
      const allCustomerReports = await storage.getAllCustomerReports();
      const allFeedback = await storage.getAllFeedback();
      const allLeads = await storage.getAllLeads();

      const safeUsers = allUsers.map(u => ({
        id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone,
        country: u.country, createdAt: u.createdAt,
      }));

      const backup = {
        exportedAt: new Date().toISOString(),
        version: "1.0",
        data: {
          users: safeUsers,
          applications: allApplications,
          trainingSessions: allSessions,
          trainerDailyRecords: allRecords,
          customerReports: allCustomerReports,
          feedback: allFeedback,
          leads: allLeads,
        },
      };

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename=backup-${new Date().toISOString().split("T")[0]}.json`);
      res.json(backup);
    } catch (error) {
      logger.error("Failed to create backup:", error);
      res.status(500).json({ error: "Failed to create backup" });
    }
  });

  app.post("/api/admin/send-withdrawal-approved", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { email, recipientName, username, withdrawalAmount, paymentMethod, smtpAccountId: rawSmtpId, profileBalance, totalDeposited, stampFee, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, companyName, companyTagline, companyEmail } = req.body;
      if (!email || !recipientName || !username || !withdrawalAmount) {
        return res.status(400).json({ error: "Missing required fields: email, recipientName, username, withdrawalAmount" });
      }
      const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
      if (smtpAccountId !== undefined && isNaN(smtpAccountId)) {
        return res.status(400).json({ error: "Invalid smtpAccountId" });
      }
      const method = paymentMethod || "crypto";
      const hasCrypto = btcAddress || ethAddress || trcAddress;
      const hasBank = accountNumber;
      if ((method === "crypto" || method === "both") && !hasCrypto) {
        return res.status(400).json({ error: "At least one crypto wallet address (BTC, ETH, or TRC) is required" });
      }
      if ((method === "bank" || method === "both") && !hasBank) {
        return res.status(400).json({ error: "Bank account number is required" });
      }
      if (!hasCrypto && !hasBank) {
        return res.status(400).json({ error: "At least one deposit method is required" });
      }
      const branding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } : undefined;
      const success = await sendWithdrawalApprovedEmail(email, {
        recipientName, username, withdrawalAmount, profileBalance: profileBalance || "N/A", totalDeposited: totalDeposited || "N/A",
        stampFee: stampFee || undefined, btcAddress: btcAddress || undefined, ethAddress: ethAddress || undefined, trcAddress: trcAddress || undefined,
        bankName: bankName || undefined, accountHolderName: accountHolderName || undefined, accountNumber: accountNumber || undefined, iban: iban || undefined, swiftBic: swiftBic || undefined,
        branding, smtpAccountId,
      });
      if (success) {
        res.json({ success: true, message: "Withdrawal approved email sent successfully" });
      } else {
        res.status(500).json({ error: "Failed to send email" });
      }
    } catch (error: any) {
      logger.error("Failed to send withdrawal approved email:", error);
      res.status(500).json({ error: "Server error: " + error.message });
    }
  });

  app.post("/api/admin/send-withdrawal-finalised", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { email, recipientName, username, withdrawalAmount, paymentMethod, smtpAccountId: rawSmtpId, profileBalance, totalDeposited, stampFee, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, companyName, companyTagline, companyEmail } = req.body;
      if (!email || !recipientName || !username || !withdrawalAmount) {
        return res.status(400).json({ error: "Missing required fields: email, recipientName, username, withdrawalAmount" });
      }
      const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
      if (smtpAccountId !== undefined && isNaN(smtpAccountId)) {
        return res.status(400).json({ error: "Invalid smtpAccountId" });
      }
      const method = paymentMethod || "crypto";
      const hasCrypto = btcAddress || ethAddress || trcAddress;
      const hasBank = accountNumber;
      if ((method === "crypto" || method === "both") && !hasCrypto) {
        return res.status(400).json({ error: "At least one crypto wallet address (BTC, ETH, or TRC) is required" });
      }
      if ((method === "bank" || method === "both") && !hasBank) {
        return res.status(400).json({ error: "Bank account number is required" });
      }
      if (!hasCrypto && !hasBank) {
        return res.status(400).json({ error: "At least one deposit method is required" });
      }
      const branding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } : undefined;
      const success = await sendWithdrawalFinalisedEmail(email, {
        recipientName, username, withdrawalAmount, profileBalance: profileBalance || "N/A", totalDeposited: totalDeposited || "N/A",
        stampFee: stampFee || undefined, btcAddress: btcAddress || undefined, ethAddress: ethAddress || undefined, trcAddress: trcAddress || undefined,
        bankName: bankName || undefined, accountHolderName: accountHolderName || undefined, accountNumber: accountNumber || undefined, iban: iban || undefined, swiftBic: swiftBic || undefined,
        branding, smtpAccountId,
      });
      if (success) {
        res.json({ success: true, message: "Withdrawal finalised email sent successfully" });
      } else {
        res.status(500).json({ error: "Failed to send email" });
      }
    } catch (error: any) {
      logger.error("Failed to send withdrawal finalised email:", error);
      res.status(500).json({ error: "Server error: " + error.message });
    }
  });

  app.post("/api/admin/send-stamp-fee-explanation", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { email, recipientName, stampFee, withdrawalAmount, depositAddress, networkType, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, smtpAccountId: rawSmtpId, companyName, companyTagline, companyEmail } = req.body;
      if (!email || !recipientName || !stampFee) {
        return res.status(400).json({ error: "Missing required fields: email, recipientName, stampFee" });
      }
      const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
      if (smtpAccountId !== undefined && isNaN(smtpAccountId)) {
        return res.status(400).json({ error: "Invalid smtpAccountId" });
      }
      const branding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } : undefined;
      const success = await sendStampFeeExplanationEmail(email, {
        recipientName,
        stampFee,
        withdrawalAmount: withdrawalAmount || undefined,
        depositAddress: depositAddress || undefined,
        networkType: networkType || undefined,
        btcAddress: btcAddress || undefined, ethAddress: ethAddress || undefined, trcAddress: trcAddress || undefined,
        bankName: bankName || undefined, accountHolderName: accountHolderName || undefined, accountNumber: accountNumber || undefined, iban: iban || undefined, swiftBic: swiftBic || undefined,
        branding,
        smtpAccountId,
      });
      if (success) {
        res.json({ success: true, message: "Stamp fee explanation email sent successfully" });
      } else {
        res.status(500).json({ error: "Failed to send email" });
      }
    } catch (error: any) {
      logger.error("Failed to send stamp fee explanation email:", error);
      res.status(500).json({ error: "Server error: " + error.message });
    }
  });

  app.post("/api/admin/preview-stamp-fee-explanation", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { recipientName, stampFee, withdrawalAmount, depositAddress, networkType, btcAddress, ethAddress, trcAddress, bankName, accountHolderName, accountNumber, iban, swiftBic, companyName, companyTagline, companyEmail } = req.body;
      if (!recipientName || !stampFee) {
        return res.status(400).json({ error: "Missing required fields: recipientName, stampFee" });
      }
      const branding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } : undefined;
      const html = generateStampFeeExplanationHtml({
        recipientName,
        stampFee,
        withdrawalAmount: withdrawalAmount || undefined,
        depositAddress: depositAddress || undefined,
        networkType: networkType || undefined,
        btcAddress: btcAddress || undefined, ethAddress: ethAddress || undefined, trcAddress: trcAddress || undefined,
        bankName: bankName || undefined, accountHolderName: accountHolderName || undefined, accountNumber: accountNumber || undefined, iban: iban || undefined, swiftBic: swiftBic || undefined,
        branding,
      });
      res.json({ html });
    } catch (error: any) {
      logger.error("Failed to preview stamp fee explanation:", error);
      res.status(500).json({ error: "Server error: " + error.message });
    }
  });

  app.post("/api/admin/send-backup", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const result = await sendBackupToExternal();
      res.json(result);
    } catch (error: any) {
      logger.error("Failed to send backup:", error);
      res.status(500).json({ success: false, message: "Failed to send backup: " + error.message });
    }
  });

  app.get("/api/admin/referrer-export/:referrerId", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const referrerId = req.params.referrerId as string;
      const referrer = await storage.getUser(referrerId);
      if (!referrer || referrer.role !== "referrer") {
        return res.status(404).json({ error: "Referrer not found" });
      }

      const allUsers = await storage.getUsersByRole("applicant");
      const referredUsers = allUsers.filter(u => u.referredBy === referrer.referralCode);

      if (referredUsers.length === 0) {
        return res.status(404).json({ error: "No referees found for this referrer" });
      }

      const referredIds = referredUsers.map(u => u.id);
      const allApps = await db.select().from(applications).where(inArray(applications.applicantId, referredIds));
      const appMap = new Map(allApps.map(a => [a.applicantId, a]));

      const trainerIds = Array.from(new Set(allApps.filter(a => a.trainerId).map(a => a.trainerId!)));
      const trainers = trainerIds.length > 0 ? await db.select().from(users).where(inArray(users.id, trainerIds)) : [];
      const trainerMap = new Map(trainers.map(t => [t.id, t]));

      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.default.Workbook();
      const sheet = workbook.addWorksheet("Referees");
      sheet.columns = refereeExcelColumns;
      styleRefereeHeader(sheet);

      for (const user of referredUsers) {
        sheet.addRow(buildRefereeRow(user, appMap.get(user.id), referrer, trainerMap));
      }

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=referees_${referrer.name?.replace(/\s+/g, "_") || referrerId}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      logger.error("Failed to export referrer data:", error);
      res.status(500).json({ error: "Failed to export referrer data" });
    }
  });

  app.get("/api/admin/referrer-export-all", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const referrers = await storage.getUsersByRole("referrer");
      const applicants = await storage.getUsersByRole("applicant");
      const allApps = await db.select().from(applications);
      const appMap = new Map(allApps.map(a => [a.applicantId, a]));

      const trainerIds = Array.from(new Set(allApps.filter(a => a.trainerId).map(a => a.trainerId!)));
      const trainers = trainerIds.length > 0 ? await db.select().from(users).where(inArray(users.id, trainerIds)) : [];
      const trainerMap = new Map(trainers.map(t => [t.id, t]));

      const referrerMap = new Map(referrers.map(r => [r.referralCode, r]));

      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.default.Workbook();
      const sheet = workbook.addWorksheet("All Referees");
      sheet.columns = refereeExcelColumns;
      styleRefereeHeader(sheet);

      for (const user of applicants) {
        if (!user.referredBy) continue;
        const referrer = referrerMap.get(user.referredBy);
        if (!referrer) continue;
        sheet.addRow(buildRefereeRow(user, appMap.get(user.id), referrer, trainerMap));
      }

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=all_referees_export.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      logger.error("Failed to export all referrer data:", error);
      res.status(500).json({ error: "Failed to export referrer data" });
    }
  });
}
