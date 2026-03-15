import type { Express } from "express";
import { requireAuth, requireRole, logActivity, applicationSubmitLimiter, getOpenAIClient } from "./helpers";
import { storage } from "../storage";
import { db } from "../db";
import { logger } from "../logger";
import { z } from "zod";
import OpenAI from "openai";
import { insertApplicationSchema, Application, User, applications, users } from "@shared/schema";
import { eq, sql, desc } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm/alias";
import { sendEmail, sendApplicationReceivedEmail, sendApplicationRejectedEmail, sendTrainingScheduledEmail, sendReferrerNotificationEmail, sendTrainerAssignmentEmail, sendNewApplicationNotificationEmail, sendOfferLetter } from "../email";
import { notifyNewApplication, notifyTrainerAssignment, notifyApplicationStatusChange, notifyTrainingScheduled, notifyReferralUsed, notifyTrainer } from "../push-service";
import crypto from "crypto";

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

function generateSchedulingToken(applicationId: string, email: string): string {
  const secret = process.env.SESSION_SECRET || "scheduling-secret-key";
  const payload = `${applicationId}:${email}:${Date.now()}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}:${hmac}`).toString("base64url");
}

export function registerApplicationRoutes(app: Express) {
  app.post("/api/applications/public-submit", applicationSubmitLimiter, async (req, res) => {
    try {
      const { name, email, whatsappNumber, telegramHandle, preferredContact, country, gender, nationality, experienceLevel, availability, motivation, hasComputerAccess, primaryDevice, linkedinUrl, referralCode, resumeUrl } = req.body;

      if (!name || !email) {
        return res.status(400).json({ error: "Name and email are required" });
      }

      if (!whatsappNumber || !String(whatsappNumber).trim()) {
        return res.status(400).json({ error: "WhatsApp number is required" });
      }

      const emailStr = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
        return res.status(400).json({ error: "Please provide a valid email address" });
      }

      const cleanWA = String(whatsappNumber).replace(/[\s\-()]/g, "");
      if (!/^\+?\d{7,15}$/.test(cleanWA)) {
        return res.status(400).json({ error: "Please provide a valid WhatsApp number with country code (e.g., +1234567890)" });
      }

      const validExpLevels = ["entry", "some", "experienced"];
      const validAvail = ["full_time", "part_time", "flexible"];
      const safeExpLevel = validExpLevels.includes(experienceLevel) ? experienceLevel : undefined;
      const safeAvail = validAvail.includes(availability) ? availability : undefined;

      let referredBy = referralCode || undefined;
      if (referredBy) {
        const referrer = await storage.getUserByReferralCode(referredBy);
        if (!referrer) {
          return res.status(400).json({ error: "Invalid Referral Code. Please check the code or leave it blank." });
        }
      }

      let user = await storage.getUserByEmail(emailStr);

      if (!user) {
        user = await storage.createUser({
          name,
          email: emailStr,
          role: "applicant",
          referredBy,
          whatsappNumber: whatsappNumber || undefined,
          telegramHandle: telegramHandle || undefined,
          preferredContact: preferredContact || undefined,
          country: country || undefined,
          experienceLevel: safeExpLevel,
          availability: safeAvail,
          motivation: motivation || undefined,
          hasComputerAccess: hasComputerAccess || "false",
          primaryDevice: primaryDevice || undefined,
          linkedinUrl: linkedinUrl || undefined,
          gender: gender || undefined,
          nationality: nationality || undefined,
        });
      } else {
        const userUpdates: Record<string, any> = {};
        if (whatsappNumber) userUpdates.whatsappNumber = whatsappNumber;
        if (telegramHandle) userUpdates.telegramHandle = telegramHandle;
        if (preferredContact) userUpdates.preferredContact = preferredContact;
        if (country) userUpdates.country = country;
        if (safeExpLevel) userUpdates.experienceLevel = safeExpLevel;
        if (safeAvail) userUpdates.availability = safeAvail;
        if (motivation) userUpdates.motivation = motivation;
        if (hasComputerAccess) userUpdates.hasComputerAccess = hasComputerAccess;
        if (primaryDevice) userUpdates.primaryDevice = primaryDevice;
        if (linkedinUrl) userUpdates.linkedinUrl = linkedinUrl;
        if (gender) userUpdates.gender = gender;
        if (nationality) userUpdates.nationality = nationality;
        if (Object.keys(userUpdates).length > 0) {
          await storage.updateUser(user.id, userUpdates);
        }
      }

      const existingApp = await storage.getApplicationByApplicantId(user.id);
      if (existingApp) {
        return res.status(400).json({ error: "You have already submitted an application with this email address." });
      }

      const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      const application = await storage.createApplication({ applicantId: user.id, resumeUrl: resumeUrl || null, status: "submitted", ipAddress: clientIp });

      lookupIpGeo(clientIp).then(geo => {
        if (geo) {
          storage.updateApplication(application.id, { ipCountry: geo.country, ipCity: geo.city }).catch(logger.error);
        }
      }).catch(logger.error);

      const restrictedCountries = ["PK", "BD", "PH"];
      const qualifyingDevices = ["laptop_desktop", "iphone_15_plus"];
      if (restrictedCountries.includes(country) && (!primaryDevice || !qualifyingDevices.includes(primaryDevice))) {
        await storage.updateApplication(application.id, { 
          status: "rejected",
          adminNotes: `Auto-rejected: Applicant from ${country} using non-qualifying device (${primaryDevice || "not specified"}). Only laptop/desktop or iPhone 15+ are accepted from this region.`
        });
      }

      // Link visitor record to applicant name by IP
      storage.linkVisitorToApplicant(clientIp, user.name).catch(logger.error);

      sendApplicationReceivedEmail(user.email, user.name).catch(logger.error);
      sendNewApplicationNotificationEmail(user.name, user.email, application.resumeUrl, user.country, user.experienceLevel, user.motivation).catch(logger.error);
      notifyNewApplication(user.name).catch(logger.error);

      if (user.referredBy) {
        const referrer = await storage.getUserByReferralCode(user.referredBy);
        if (referrer) {
          sendReferrerNotificationEmail(referrer.email, referrer.name, user.name, user.referredBy).catch(logger.error);
          notifyReferralUsed(referrer.id, user.name).catch(logger.error);
        }
      }

      res.json(application);
      logActivity("Submitted application", "Application", application.id, `New application from ${name} (${email})`, undefined, clientIp);
    } catch (error) {
      logger.error("Public application submit error:", error);
      res.status(500).json({ error: "Failed to submit application" });
    }
  });

  app.post("/api/applications", async (req, res) => {
    try {
      const applicationData = insertApplicationSchema.parse(req.body);
      
      const existingApp = await storage.getApplicationByApplicantId(applicationData.applicantId);
      if (existingApp) {
        return res.status(400).json({ error: "Application already exists for this user" });
      }
      
      const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      const application = await storage.createApplication({ ...applicationData, ipAddress: clientIp });

      lookupIpGeo(clientIp).then(geo => {
        if (geo) {
          storage.updateApplication(application.id, { ipCountry: geo.country, ipCity: geo.city }).catch(logger.error);
        }
      }).catch(logger.error);
      
      const applicant = await storage.getUser(applicationData.applicantId);
      if (applicant) {
        // Link visitor record to applicant name by IP
        storage.linkVisitorToApplicant(clientIp, applicant.name).catch(logger.error);

        sendApplicationReceivedEmail(applicant.email, applicant.name).catch(logger.error);
        sendNewApplicationNotificationEmail(
          applicant.name,
          applicant.email,
          application.resumeUrl,
          applicant.country,
          applicant.experienceLevel,
          applicant.motivation
        ).catch(logger.error);
        notifyNewApplication(applicant.name).catch(logger.error);
        
        if (applicant.referredBy) {
          const referrer = await storage.getUserByReferralCode(applicant.referredBy);
          if (referrer) {
            sendReferrerNotificationEmail(
              referrer.email,
              referrer.name,
              applicant.name,
              applicant.referredBy
            ).catch(logger.error);
            notifyReferralUsed(referrer.id, applicant.name).catch(logger.error);
          }
        }
      }
      
      res.json(application);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create application" });
    }
  });

  app.get("/api/applications", requireAuth, requireRole("admin", "trainer", "referrer"), async (req, res) => {
    try {
      if (req.query.paginated === "true") {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const result = await storage.getApplicationsPaginated({
          page,
          limit,
          status: req.query.status as string,
          trainingStatus: req.query.trainingStatus as string,
          search: req.query.search as string,
          trainerId: req.query.trainerId as string,
        });
        return res.json(result);
      }
      const allApplications = await db
        .select({
          id: applications.id,
          applicantId: applications.applicantId,
          applicantName: users.name,
          applicantEmail: users.email,
          referredBy: users.referredBy,
          status: applications.status,
          appliedAt: applications.appliedAt,
          resumeUrl: applications.resumeUrl,
          adminNotes: applications.adminNotes,
          trainingStatus: applications.trainingStatus,
          trainerId: applications.trainerId,
          trainingSessionId: applications.trainingSessionId,
          applicantWhatsapp: users.whatsappNumber,
          applicantTelegram: users.telegramHandle,
          applicantCountry: users.country,
          applicantExperience: users.experienceLevel,
          applicantAvailability: users.availability,
          applicantMotivation: users.motivation,
          applicantLinkedin: users.linkedinUrl,
          applicantGender: users.gender,
          applicantNationality: users.nationality,
          applicantPhone: users.phone,
          applicantDevice: users.primaryDevice,
          applicantPreferredContact: users.preferredContact,
          applicantHasComputerAccess: users.hasComputerAccess,
          ipAddress: applications.ipAddress,
          ipCountry: applications.ipCountry,
          ipCity: applications.ipCity,
        })
        .from(applications)
        .leftJoin(users, eq(applications.applicantId, users.id));
      
      res.json(allApplications);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch applications" });
    }
  });

  app.get("/api/applications/assignments", requireAuth, async (req, res) => {
    try {
      const trainerAlias = aliasedTable(users, "trainer");
      
      const results = await db
        .select({
          applicationId: applications.id,
          applicantId: applications.applicantId,
          applicantName: users.name,
          applicantEmail: users.email,
          applicantCountry: users.country,
          applicantPhone: users.phone,
          status: applications.status,
          trainingStatus: applications.trainingStatus,
          trainerId: applications.trainerId,
          trainerName: trainerAlias.name,
          trainerEmail: trainerAlias.email,
          referredBy: users.referredBy,
          appliedAt: applications.appliedAt,
          trainingSessionId: applications.trainingSessionId,
        })
        .from(applications)
        .leftJoin(users, eq(applications.applicantId, users.id))
        .leftJoin(trainerAlias, eq(applications.trainerId, trainerAlias.id))
        .orderBy(desc(applications.appliedAt));
      
      const allUsers = await storage.getAllUsers();
      const referrerMap = new Map(allUsers.filter(u => u.role === "referrer").map(u => [u.referralCode, u.name]));
      
      const enriched = results.map(r => ({
        ...r,
        referrerName: r.referredBy ? (referrerMap.get(r.referredBy) || r.referredBy) : null,
      }));
      
      res.json(enriched);
    } catch (error) {
      logger.error("Failed to fetch assignments:", error);
      res.status(500).json({ error: "Failed to fetch assignments" });
    }
  });

  app.get("/api/applicant-reports", requireAuth, async (req, res) => {
    try {
      const reports = await storage.getAllApplicantReports();
      const allUsers = await storage.getAllUsers();
      const userMap = new Map(allUsers.map(u => [u.id, u]));

      const enriched = reports.map(r => {
        const author = r.createdBy ? userMap.get(r.createdBy) : null;
        return {
          ...r,
          authorName: author ? (author.name || author.email) : "Unknown",
          authorRole: author?.role || "unknown",
        };
      });

      res.json(enriched);
    } catch (error) {
      logger.error("Failed to fetch applicant reports:", error);
      res.status(500).json({ error: "Failed to fetch reports" });
    }
  });

  app.post("/api/applicant-reports", requireAuth, async (req, res) => {
    try {
      const { title, content, applicationId } = req.body;
      if (!title || !content) {
        return res.status(400).json({ error: "Title and content are required" });
      }
      const report = await storage.createApplicantReport({
        title,
        content,
        applicationId: applicationId || null,
        createdBy: req.session.userId || "",
      });
      res.json(report);
    } catch (error) {
      logger.error("Failed to create applicant report:", error);
      res.status(500).json({ error: "Failed to create report" });
    }
  });

  app.patch("/api/applicant-reports/:id", requireAuth, async (req, res) => {
    try {
      const report = await storage.updateApplicantReport(req.params.id as string, req.body);
      if (!report) return res.status(404).json({ error: "Report not found" });
      res.json(report);
    } catch (error) {
      logger.error("Failed to update applicant report:", error);
      res.status(500).json({ error: "Failed to update report" });
    }
  });

  app.delete("/api/applicant-reports/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteApplicantReport(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete applicant report:", error);
      res.status(500).json({ error: "Failed to delete report" });
    }
  });

  app.post("/api/chatbot-logs", async (req, res) => {
    try {
      const { sessionId, question, answer, page, userFeedback, visitorEmail, visitorName } = req.body;
      if (!sessionId || !question || !answer) {
        return res.status(400).json({ error: "sessionId, question, and answer are required" });
      }
      const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
      const log = await storage.createChatbotLog({
        sessionId,
        question,
        answer,
        page: page || null,
        userFeedback: userFeedback || null,
        visitorEmail: visitorEmail || null,
        visitorName: visitorName || null,
        ipAddress,
      });
      res.json(log);
    } catch (error) {
      logger.error("Failed to create chatbot log:", error);
      res.status(500).json({ error: "Failed to log conversation" });
    }
  });

  app.patch("/api/chatbot-logs/:id/feedback", async (req, res) => {
    try {
      const { feedback } = req.body;
      const updated = await storage.updateChatbotLogFeedback(req.params.id as string, feedback);
      res.json(updated);
    } catch (error) {
      logger.error("Failed to update chatbot feedback:", error);
      res.status(500).json({ error: "Failed to update feedback" });
    }
  });

  app.get("/api/chatbot-logs", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const search = req.query.search as string;
      const result = await storage.getChatbotLogsPaginated({ page, limit, search });
      res.json(result);
    } catch (error) {
      logger.error("Failed to get chatbot logs:", error);
      res.status(500).json({ error: "Failed to get chatbot logs" });
    }
  });

  app.get("/api/chatbot-stats", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const stats = await storage.getChatbotStats();
      res.json(stats);
    } catch (error) {
      logger.error("Failed to get chatbot stats:", error);
      res.status(500).json({ error: "Failed to get chatbot stats" });
    }
  });

  app.get("/api/applications/status", async (req, res) => {
    try {
      const email = req.query.email as string;
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }
      const user = await storage.getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        return res.status(404).json(null);
      }
      const application = await storage.getApplicationByApplicantId(user.id);
      if (!application) {
        return res.status(404).json(null);
      }
      const trainer = application.trainerId ? await storage.getUser(application.trainerId) : null;
      res.json({
        id: application.id,
        applicantId: application.applicantId,
        applicantName: user.name,
        applicantEmail: user.email,
        status: application.status,
        trainingStatus: application.trainingStatus,
        trainingSessionId: application.trainingSessionId,
        trainerId: application.trainerId,
        trainerName: trainer?.name || null,
        createdAt: application.appliedAt,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to look up application" });
    }
  });

  app.get("/api/applications/duplicates/detect", requireRole("admin"), async (req, res) => {
    try {
      // Get all applications with user data
      const allApplications = await db
        .select({
          id: applications.id,
          applicantId: applications.applicantId,
          applicantName: users.name,
          applicantEmail: users.email,
          applicantWhatsapp: users.whatsappNumber,
          status: applications.status,
          appliedAt: applications.appliedAt,
        })
        .from(applications)
        .leftJoin(users, eq(applications.applicantId, users.id));

      // Build duplicate detection map
      const duplicateGroups: { [key: string]: { 
        applications: typeof allApplications; 
        matchType: string[];
      }} = {};

      // Helper to normalize strings for comparison
      const normalize = (str: string | null | undefined) => 
        str?.toLowerCase().trim().replace(/\s+/g, ' ') || '';

      // Check each application against others
      for (let i = 0; i < allApplications.length; i++) {
        const app1 = allApplications[i];
        
        for (let j = i + 1; j < allApplications.length; j++) {
          const app2 = allApplications[j];
          const matchTypes: string[] = [];

          // Check email match (exact)
          if (app1.applicantEmail && app2.applicantEmail && 
              normalize(app1.applicantEmail) === normalize(app2.applicantEmail)) {
            matchTypes.push('email');
          }

          // Check phone/WhatsApp match (exact, after normalizing)
          if (app1.applicantWhatsapp && app2.applicantWhatsapp) {
            const phone1 = app1.applicantWhatsapp.replace(/\D/g, '');
            const phone2 = app2.applicantWhatsapp.replace(/\D/g, '');
            if (phone1 && phone2 && (phone1 === phone2 || phone1.endsWith(phone2) || phone2.endsWith(phone1))) {
              matchTypes.push('phone');
            }
          }

          // Check name match (fuzzy - same name after normalization)
          if (app1.applicantName && app2.applicantName) {
            const name1 = normalize(app1.applicantName);
            const name2 = normalize(app2.applicantName);
            if (name1 && name2 && name1 === name2) {
              matchTypes.push('name');
            }
          }

          // If any matches found, group them
          if (matchTypes.length > 0) {
            const groupKey = [app1.id, app2.id].sort().join('-');
            if (!duplicateGroups[groupKey]) {
              duplicateGroups[groupKey] = {
                applications: [app1, app2],
                matchType: matchTypes
              };
            } else {
              // Add new match types if not already included
              matchTypes.forEach(mt => {
                if (!duplicateGroups[groupKey].matchType.includes(mt)) {
                  duplicateGroups[groupKey].matchType.push(mt);
                }
              });
            }
          }
        }
      }

      // Convert to array and return
      const duplicates = Object.entries(duplicateGroups).map(([key, value]) => ({
        groupId: key,
        applications: value.applications,
        matchTypes: value.matchType,
      }));

      // Also create a map of applicationId -> duplicate info for quick lookup
      const duplicateFlags: { [appId: string]: { hasDuplicate: boolean; matchTypes: string[]; duplicateOf: string[] } } = {};
      
      duplicates.forEach(group => {
        group.applications.forEach(app => {
          if (!duplicateFlags[app.id]) {
            duplicateFlags[app.id] = { hasDuplicate: true, matchTypes: [], duplicateOf: [] };
          }
          group.matchTypes.forEach(mt => {
            if (!duplicateFlags[app.id].matchTypes.includes(mt)) {
              duplicateFlags[app.id].matchTypes.push(mt);
            }
          });
          group.applications.forEach(otherApp => {
            if (otherApp.id !== app.id && !duplicateFlags[app.id].duplicateOf.includes(otherApp.id)) {
              duplicateFlags[app.id].duplicateOf.push(otherApp.id);
            }
          });
        });
      });

      res.json({
        duplicateGroups: duplicates,
        duplicateFlags,
        totalDuplicates: duplicates.length,
      });
    } catch (error) {
      logger.error("Failed to detect duplicates:", error);
      res.status(500).json({ error: "Failed to detect duplicates" });
    }
  });

  app.post("/api/applications/merge", requireRole("admin"), async (req, res) => {
    try {
      const { primaryApplicationId, duplicateApplicationId } = req.body;

      if (!primaryApplicationId || !duplicateApplicationId) {
        return res.status(400).json({ error: "Both primaryApplicationId and duplicateApplicationId are required" });
      }

      if (primaryApplicationId === duplicateApplicationId) {
        return res.status(400).json({ error: "Cannot merge an application with itself" });
      }

      const [primaryApp] = await db.select().from(applications).where(eq(applications.id, primaryApplicationId));
      const [duplicateApp] = await db.select().from(applications).where(eq(applications.id, duplicateApplicationId));

      if (!primaryApp || !duplicateApp) {
        return res.status(404).json({ error: "One or both applications not found" });
      }

      const [primaryUser] = await db.select().from(users).where(eq(users.id, primaryApp.applicantId));
      const [duplicateUser] = await db.select().from(users).where(eq(users.id, duplicateApp.applicantId));

      await db.transaction(async (tx) => {
        const mergedNotes = [primaryApp.adminNotes, duplicateApp.adminNotes]
          .filter(Boolean)
          .join("\n---\n");

        const mergedResumeUrl = primaryApp.resumeUrl || duplicateApp.resumeUrl;

        await tx.update(applications).set({
          adminNotes: mergedNotes || null,
          resumeUrl: mergedResumeUrl,
          ...(duplicateApp.trainerId && !primaryApp.trainerId ? { trainerId: duplicateApp.trainerId } : {}),
          ...(duplicateApp.trainingSessionId && !primaryApp.trainingSessionId ? { trainingSessionId: duplicateApp.trainingSessionId } : {}),
          ...(duplicateApp.trainingStatus && !primaryApp.trainingStatus ? { trainingStatus: duplicateApp.trainingStatus } : {}),
        }).where(eq(applications.id, primaryApplicationId));

        if (primaryUser && duplicateUser) {
          const userUpdates: Record<string, any> = {};
          if (!primaryUser.phone && duplicateUser.phone) userUpdates.phone = duplicateUser.phone;
          if (!primaryUser.whatsappNumber && duplicateUser.whatsappNumber) userUpdates.whatsappNumber = duplicateUser.whatsappNumber;
          if (!primaryUser.telegramHandle && duplicateUser.telegramHandle) userUpdates.telegramHandle = duplicateUser.telegramHandle;
          if (!primaryUser.address && duplicateUser.address) userUpdates.address = duplicateUser.address;
          if (!primaryUser.country && duplicateUser.country) userUpdates.country = duplicateUser.country;
          if (!primaryUser.linkedinUrl && duplicateUser.linkedinUrl) userUpdates.linkedinUrl = duplicateUser.linkedinUrl;
          if (!primaryUser.bio && duplicateUser.bio) userUpdates.bio = duplicateUser.bio;
          if (!primaryUser.motivation && duplicateUser.motivation) userUpdates.motivation = duplicateUser.motivation;

          if (Object.keys(userUpdates).length > 0) {
            await tx.update(users).set(userUpdates).where(eq(users.id, primaryUser.id));
          }
        }

        await tx.execute(sql`UPDATE feedback SET application_id = ${primaryApplicationId} WHERE application_id = ${duplicateApplicationId}`);
        await tx.execute(sql`UPDATE email_logs SET application_id = ${primaryApplicationId} WHERE application_id = ${duplicateApplicationId}`);
        await tx.execute(sql`UPDATE session_attendance SET application_id = ${primaryApplicationId}, applicant_id = ${primaryApp.applicantId} WHERE application_id = ${duplicateApplicationId}`);
        await tx.execute(sql`UPDATE reschedule_requests SET application_id = ${primaryApplicationId}, trainee_id = ${primaryApp.applicantId} WHERE application_id = ${duplicateApplicationId}`);
        await tx.execute(sql`UPDATE applicant_reports SET application_id = ${primaryApplicationId} WHERE application_id = ${duplicateApplicationId}`);
        await tx.execute(sql`UPDATE training_appointments SET application_id = ${primaryApplicationId}, applicant_id = ${primaryApp.applicantId} WHERE application_id = ${duplicateApplicationId}`);

        await tx.delete(applications).where(eq(applications.id, duplicateApplicationId));

        if (duplicateUser && duplicateUser.id !== primaryUser?.id) {
          const remainingResult = await tx.select({ count: sql<number>`count(*)` }).from(applications).where(eq(applications.applicantId, duplicateUser.id));
          const remainingCount = remainingResult[0]?.count ?? 1;
          if (remainingCount === 0) {
            await tx.delete(users).where(eq(users.id, duplicateUser.id));
          }
        }
      });

      logger.info("Applications merged", { primaryApplicationId, duplicateApplicationId, adminId: req.session.userId });

      res.json({
        success: true,
        message: "Applications merged successfully",
        primaryApplicationId,
      });
      logActivity("Merged applications", "Application", primaryApplicationId, `Merged duplicate application into primary`, req.session.userId);
    } catch (error) {
      logger.error("Failed to merge applications:", error);
      res.status(500).json({ error: "Failed to merge applications" });
    }
  });

  app.get("/api/applications/:id", requireAuth, async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      res.json(application);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch application" });
    }
  });

  app.get("/api/applications/applicant/:applicantId", requireAuth, async (req, res) => {
    try {
      const application = await storage.getApplicationByApplicantId(req.params.applicantId as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      res.json(application);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch application" });
    }
  });

  app.get("/api/applications/lookup/offer-ref/:ref", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const refNumber = (req.params.ref as string).toUpperCase();
      const allApplications = await storage.getAllApplications();
      const allUsers = await storage.getAllUsers();
      
      // Find application with matching offer letter reference
      const application = allApplications.find((app: Application) => 
        app.offerLetterRef?.toUpperCase() === refNumber
      );
      
      if (!application) {
        return res.status(404).json({ error: "No application found with this offer letter reference" });
      }
      
      // Get applicant details
      const applicant = allUsers.find((u: User) => u.id === application.applicantId);
      
      res.json({
        application,
        applicant: applicant ? {
          id: applicant.id,
          name: applicant.name,
          email: applicant.email,
          whatsappNumber: applicant.whatsappNumber,
        } : null
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to lookup application" });
    }
  });

  app.patch("/api/applications/:id", requireAuth, requireRole("admin", "trainer"), async (req, res) => {
    try {
      const updateData = insertApplicationSchema.partial().parse(req.body);
      
      // Get current application to check for status change
      const currentApp = await storage.getApplication(req.params.id as string);
      
      const application = await storage.updateApplication(req.params.id as string, updateData);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      // Send email notifications for status changes
      if (currentApp && updateData.status && updateData.status !== currentApp.status) {
        const applicant = await storage.getUser(application.applicantId);
        if (applicant) {
          if (updateData.status === "accepted") {
            // Send offer letter and save reference
            const offerId = `OFFER-${Date.now().toString(36).toUpperCase()}-${application.id.substring(0, 6).toUpperCase()}`;
            // Generate scheduling token for self-service training booking
            const schedulingToken = generateSchedulingToken(application.id, applicant.email);
            const scheduleUrl = `https://www.portermetricscareeronboarding.com/schedule-training?token=${schedulingToken}`;
            // Save offer letter reference to application
            await storage.updateApplication(req.params.id as string, { offerLetterRef: offerId });
            sendOfferLetter({
              applicantName: applicant.name,
              applicantEmail: applicant.email,
              applicantWhatsapp: applicant.whatsappNumber || undefined,
              offerId,
              scheduleTrainingUrl: scheduleUrl,
              country: applicant.nationality || applicant.country || undefined,
            }).catch(logger.error);
          } else if (updateData.status === "rejected") {
            sendApplicationRejectedEmail(applicant.email, applicant.name).catch(logger.error);
          }
          // Send push notification for status change
          notifyApplicationStatusChange(applicant.id, updateData.status).catch(logger.error);
        }
      }
      
      // Generate certificate ID when training is marked complete (but don't auto-send - admin must issue manually)
      if (currentApp && updateData.trainingStatus === "completed" && currentApp.trainingStatus !== "completed") {
        if (!application.certificateId) {
          const certificateId = `CERT-${Date.now().toString(36).toUpperCase()}-${application.id.substring(0, 6).toUpperCase()}`;
          await storage.updateApplication(req.params.id as string, { certificateId });
        }
      }
      
      // Send email for training assignment
      if (updateData.trainerId && updateData.trainingSessionId && updateData.trainingStatus === "scheduled") {
        const applicant = await storage.getUser(application.applicantId);
        const trainer = await storage.getUser(updateData.trainerId);
        const session = await storage.getTrainingSession(updateData.trainingSessionId);
        
        if (applicant && trainer && session) {
          const sessionTime = new Date(session.startTime).toLocaleString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short"
          });
          sendTrainingScheduledEmail(applicant.email, applicant.name, trainer.name, sessionTime).catch(logger.error);
          
          // Send email notification to trainer
          sendTrainerAssignmentEmail(
            trainer.email,
            trainer.name,
            applicant.name,
            applicant.email,
            applicant.whatsappNumber || applicant.phone || null,
            sessionTime
          ).catch(logger.error);
          
          // Send push notifications
          notifyTrainerAssignment(trainer.id, applicant.name).catch(logger.error);
          notifyTrainingScheduled(applicant.id, trainer.name, new Date(session.startTime)).catch(logger.error);
        }
      }
      
      res.json(application);
      const statusChange = currentApp && updateData.status && updateData.status !== currentApp.status ? ` - Status changed to ${updateData.status}` : "";
      const trainingChange = currentApp && updateData.trainingStatus && updateData.trainingStatus !== currentApp.trainingStatus ? ` - Training status: ${updateData.trainingStatus}` : "";
      logActivity("Updated application", "Application", req.params.id as string, `Application updated${statusChange}${trainingChange}`, req.session.userId, undefined, currentApp ? { status: currentApp.status, trainingStatus: currentApp.trainingStatus, trainerId: currentApp.trainerId, trainingSessionId: currentApp.trainingSessionId } : undefined);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to update application" });
    }
  });

  app.delete("/api/applications/:id", requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteApplication(req.params.id as string);
      logActivity("Deleted application", "Application", req.params.id as string, "Deleted application", req.session.userId);
      res.json({ success: true, message: "Application deleted successfully" });
    } catch (error) {
      logger.error("Error deleting application:", error);
      res.status(500).json({ error: "Failed to delete application" });
    }
  });

  app.post("/api/applications/:id/trainee-confirm", requireAuth, async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      // Update trainee confirmation only - training completion requires admin or trainer action
      const updatedApp = await storage.updateApplication(req.params.id as string, {
        traineeConfirmed: "true",
        traineeConfirmedAt: new Date()
      });
      
      res.json({ ...updatedApp, trainingCompleted: false });
      logActivity("Trainee confirmed", "Application", req.params.id as string, "Trainee confirmed training attendance", req.session.userId);
    } catch (error) {
      logger.error("Error confirming trainee attendance:", error);
      res.status(500).json({ error: "Failed to confirm attendance" });
    }
  });

  app.post("/api/applications/:id/trainer-confirm", requireAuth, requireRole("trainer", "admin"), async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      const updatedApp = await storage.updateApplication(req.params.id as string, {
        trainerConfirmed: "true",
        trainerConfirmedAt: new Date(),
      });
      
      res.json({ ...updatedApp, trainingCompleted: false });
      logActivity("Trainer confirmed", "Application", req.params.id as string, "Trainer confirmed training — awaiting admin authorization to complete", req.session.userId);
    } catch (error) {
      logger.error("Error confirming trainer completion:", error);
      res.status(500).json({ error: "Failed to confirm training" });
    }
  });

  app.post("/api/applications/:id/admin-complete-training", requireRole("admin"), async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (application.status !== "accepted") {
        return res.status(400).json({ error: "Application must be accepted first" });
      }

      const certificateId = `CERT-${Date.now().toString(36).toUpperCase()}-${application.id.substring(0, 6).toUpperCase()}`;
      const trainingCompletedAt = new Date();

      const completedApp = await storage.updateApplication(req.params.id as string, {
        trainingStatus: "completed",
        traineeConfirmed: "true",
        trainerConfirmed: "true",
        certificateId,
        trainingCompletedAt,
      });

      if (application.trainingSessionId) {
        await storage.archiveTrainingSession(application.trainingSessionId);
      }

      res.json(completedApp);
      logActivity("Admin completed training", "Application", req.params.id as string, "Admin marked training as completed", req.session.userId, undefined, { trainingStatus: application.trainingStatus, traineeConfirmed: application.traineeConfirmed, trainerConfirmed: application.trainerConfirmed, traineeConfirmedAt: application.traineeConfirmedAt, trainerConfirmedAt: application.trainerConfirmedAt, trainingCompletedAt: application.trainingCompletedAt });
    } catch (error) {
      logger.error("Error admin completing training:", error);
      res.status(500).json({ error: "Failed to complete training" });
    }
  });

  app.get("/api/certificate/:idOrCertId", async (req, res) => {
    try {
      const param = req.params.idOrCertId as string;
      let application = await storage.getApplication(param);
      if (!application) {
        application = await storage.getApplicationByCertificateId(param);
      }
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (application.trainingStatus !== "completed" || !application.certificateId) {
        return res.status(404).json({ error: "No certificate found for this application" });
      }

      const applicant = await storage.getUser(application.applicantId);
      const trainer = application.trainerId ? await storage.getUser(application.trainerId) : null;

      let companyName: string | null = null;
      let companyTagline: string | null = null;
      const certLogs = await storage.getCertificateLogsByApplication(application.id);
      if (certLogs.length > 0) {
        const issuedLog = certLogs.find(l => l.action === "issued") || certLogs[0];
        companyName = issuedLog.companyName || null;
        companyTagline = issuedLog.companyTagline || null;
      }

      res.json({
        certificateId: application.certificateId,
        applicantName: applicant?.name || "Unknown",
        trainerName: trainer?.name || "Unknown",
        completionDate: application.trainingCompletedAt?.toISOString() || new Date().toISOString(),
        applicationId: application.id,
        revoked: application.certificateRevoked === "true",
        revokedAt: application.certificateRevokedAt?.toISOString() || null,
        revokedReason: application.certificateRevokedReason || null,
        companyName: companyName,
        companyTagline: companyTagline,
      });
    } catch (error) {
      logger.error("Error fetching certificate:", error);
      res.status(500).json({ error: "Failed to fetch certificate" });
    }
  });

  app.post("/api/applications/:id/onboard", requireRole("admin"), async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      // Only allow onboarding if training is completed
      if (application.trainingStatus !== "completed") {
        return res.status(400).json({ error: "Training must be completed before onboarding" });
      }
      
      const updatedApp = await storage.updateApplication(req.params.id as string, {
        onboardedAt: new Date()
      });
      
      res.json(updatedApp);
      logActivity("Onboarded applicant", "Application", req.params.id as string, "Applicant marked as onboarded", req.session.userId, undefined, { onboardedAt: application.onboardedAt });
    } catch (error) {
      logger.error("Error marking as onboarded:", error);
      res.status(500).json({ error: "Failed to mark as onboarded" });
    }
  });

  app.post("/api/applications/:id/accept-with-trainer", requireRole("admin"), async (req, res) => {
    try {
      const { trainerId, sessionId, whatsappNumber } = req.body;
      
      if (!trainerId || !sessionId) {
        return res.status(400).json({ error: "Trainer and session are required" });
      }
      
      const application = await storage.getApplication(req.params.id as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      const trainer = await storage.getUser(trainerId);
      if (!trainer) {
        return res.status(404).json({ error: "Trainer not found" });
      }
      
      const session = await storage.getTrainingSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      
      // Update application with acceptance, trainer, and session
      const updatedApp = await storage.updateApplication(req.params.id as string, {
        status: "accepted",
        trainerId,
        trainingSessionId: sessionId,
        trainingStatus: "scheduled"
      });
      
      // Get applicant details
      const applicant = await storage.getUser(application.applicantId);
      if (!applicant) {
        return res.status(404).json({ error: "Applicant not found" });
      }
      
      // Send acceptance email with trainer info and onboarding link
      const sessionTime = new Date(session.startTime).toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
      });
      
      // Build onboarding URL with trainer's affiliate code
      const onboardingUrl = trainer.affiliateCode 
        ? `https://www.affiliates-portermetrics.com/register?ref=${trainer.affiliateCode}`
        : "https://www.affiliates-portermetrics.com/register";
      
      // Use admin-selected WhatsApp or fall back to trainer's available numbers
      const selectedTrainerWhatsapp = whatsappNumber || trainer.whatsappNumber || trainer.whatsappNumber2 || trainer.whatsappNumber3 || null;
      
      // Send offer letter to applicant with trainer details and save reference
      const trainerCode = trainer.referralCode || trainer.affiliateCode || "";
      const offerId = `OFFER-${Date.now().toString(36).toUpperCase()}-${application.id.substring(0, 6).toUpperCase()}`;
      await storage.updateApplication(application.id, { offerLetterRef: offerId });
      
      sendOfferLetter({
        applicantName: applicant.name,
        applicantEmail: applicant.email,
        applicantWhatsapp: applicant.whatsappNumber || undefined,
        offerId,
        trainerName: trainer.name,
        trainerEmail: trainer.email,
        trainerWhatsapp: selectedTrainerWhatsapp || undefined,
        trainerCode,
        sessionTime,
        sessionTimezone: trainer.timezone || undefined,
        country: applicant.nationality || applicant.country || undefined,
      }).catch(logger.error);
      
      // Send assignment notification to trainer with trainee email + phone/WhatsApp
      sendTrainerAssignmentEmail(
        trainer.email,
        trainer.name,
        applicant.name,
        applicant.email,
        applicant.whatsappNumber || applicant.phone || null,
        sessionTime
      ).catch(logger.error);
      
      res.json(updatedApp);
      logActivity("Accepted with trainer", "Application", req.params.id as string, `Accepted and assigned to trainer: ${trainer.name}`, req.session.userId, undefined, { status: application.status, trainerId: application.trainerId, trainingSessionId: application.trainingSessionId, trainingStatus: application.trainingStatus });
    } catch (error) {
      logger.error("Error accepting with trainer:", error);
      res.status(500).json({ error: "Failed to accept application" });
    }
  });

  app.post("/api/applications/:appId/book-session/:sessionId", async (req, res) => {
    try {
      const appId = req.params.appId as string;
      const sessionId = req.params.sessionId as string;
      
      const application = await storage.getApplication(appId);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (!req.session.userId) {
        const applicant = await storage.getUser(application.applicantId);
        if (!applicant || !req.body.email || applicant.email.toLowerCase() !== req.body.email.toLowerCase()) {
          return res.status(403).json({ error: "Verification failed" });
        }
      }
      
      const session = await storage.getTrainingSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Training session not found" });
      }
      
      if (session.status !== "open") {
        return res.status(400).json({ error: "This session is no longer available" });
      }
      
      await storage.updateTrainingSession(sessionId, { status: "filled" });
      
      const updatedApp = await storage.updateApplication(appId, {
        trainerId: session.trainerId,
        trainingSessionId: sessionId,
        trainingStatus: "scheduled"
      });
      
      const applicant = await storage.getUser(application.applicantId);
      const trainer = await storage.getUser(session.trainerId);
      
      if (applicant && trainer) {
        const sessionTime = new Date(session.startTime).toLocaleString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short"
        });
        sendTrainingScheduledEmail(applicant.email, applicant.name, trainer.name, sessionTime).catch(logger.error);
        
        // Notify trainer about the booking
        notifyTrainer(
          trainer.id,
          "New Session Booking",
          `${applicant.name} has booked your training session for ${sessionTime}`,
          "/trainer"
        ).catch(logger.error);
      }
      
      res.json(updatedApp);
    } catch (error) {
      res.status(500).json({ error: "Failed to book session" });
    }
  });

  app.post("/api/applications/:appId/reschedule/:newSessionId", async (req, res) => {
    try {
      const appId = req.params.appId as string;
      const newSessionId = req.params.newSessionId as string;
      
      const application = await storage.getApplication(appId);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (!req.session.userId) {
        const applicant = await storage.getUser(application.applicantId);
        if (!applicant || !req.body.email || applicant.email.toLowerCase() !== req.body.email.toLowerCase()) {
          return res.status(403).json({ error: "Verification failed" });
        }
      }
      
      if (application.trainingSessionId) {
        await storage.updateTrainingSession(application.trainingSessionId, { status: "open" });
      }
      
      const newSession = await storage.getTrainingSession(newSessionId);
      if (!newSession) {
        return res.status(404).json({ error: "Training session not found" });
      }
      
      if (newSession.status !== "open") {
        return res.status(400).json({ error: "This session is no longer available" });
      }
      
      await storage.updateTrainingSession(newSessionId, { status: "filled" });
      
      const updatedApp = await storage.updateApplication(appId, {
        trainerId: newSession.trainerId,
        trainingSessionId: newSessionId,
        trainingStatus: "scheduled"
      });
      
      const applicant = await storage.getUser(application.applicantId);
      const trainer = await storage.getUser(newSession.trainerId);
      
      if (applicant && trainer) {
        const sessionTime = new Date(newSession.startTime).toLocaleString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short"
        });
        sendTrainingScheduledEmail(applicant.email, applicant.name, trainer.name, sessionTime).catch(logger.error);
        
        notifyTrainer(
          trainer.id,
          "Training Rescheduled",
          `${applicant.name} has been rescheduled to your session on ${sessionTime}`,
          "/trainer"
        ).catch(logger.error);
        
        sendEmail({
          to: trainer.email,
          subject: `Training Rescheduled - ${applicant.name}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #3b82f6, #2563eb); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 24px;">Training Session Rescheduled</h1>
              </div>
              <div style="padding: 30px; background: #f9fafb; border-radius: 0 0 12px 12px;">
                <p>Dear <strong>${trainer.name}</strong>,</p>
                <p>A trainee has been rescheduled to one of your sessions.</p>
                <div style="background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0;">
                  <p style="margin: 0;"><strong>Trainee:</strong> ${applicant.name} (${applicant.email})</p>
                  <p style="margin: 8px 0 0;"><strong>Session Date:</strong> ${sessionTime}</p>
                </div>
                <p>Please coordinate with the trainee regarding the training session details.</p>
                <p style="color: #6b7280; font-size: 12px; margin-top: 30px;">— The Metrics Team</p>
              </div>
            </div>
          `
        }).catch(logger.error);
      }
      
      res.json(updatedApp);
    } catch (error) {
      res.status(500).json({ error: "Failed to reschedule session" });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { messages, systemPrompt, enableWebSearch } = req.body;

      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Messages array is required" });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const chatMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt || "You are a helpful assistant." },
        ...messages.map((m: { role: string; content: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      // Use responses API with web search when enabled
      if (enableWebSearch) {
        try {
          const client = getOpenAIClient();
          if (!client) throw new Error("OpenAI not configured");
          const response = await client.responses.create({
            model: "gpt-4o-mini",
            tools: [{ type: "web_search_preview" }],
            input: chatMessages,
          });

          // Extract text content from response
          let fullContent = "";
          for (const item of response.output) {
            if (item.type === "message" && item.content) {
              for (const block of item.content) {
                if (block.type === "output_text") {
                  fullContent += block.text;
                }
              }
            }
          }

          // Stream the response in chunks for better UX
          const chunkSize = 20;
          for (let i = 0; i < fullContent.length; i += chunkSize) {
            const chunk = fullContent.slice(i, i + chunkSize);
            res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
            await new Promise(resolve => setTimeout(resolve, 10));
          }

          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
          return;
        } catch (webSearchError) {
          logger.error("Web search error, falling back to standard chat:", webSearchError);
          // Fall through to standard chat if web search fails
        }
      }

      // Standard streaming chat without web search
      const chatClient = getOpenAIClient();
      if (!chatClient) {
        res.write(`data: ${JSON.stringify({ content: "AI features are not configured. Please set up the OpenAI API key.", done: true })}\n\n`);
        res.end();
        return;
      }
      const stream = await chatClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: chatMessages,
        stream: true,
        max_tokens: 1024,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error) {
      logger.error("Chat error:", error);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to generate response" });
      }
    }
  });

  app.get("/api/export/applications", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const apps = await storage.getAllApplications();
      const allUsers = await storage.getAllUsers();
      
      const csvRows = [
        ["ID", "Applicant Name", "Email", "Phone", "Country", "Status", "Training Status", "Applied At", "Admin Notes"].join(",")
      ];

      for (const app of apps) {
        const user = allUsers.find(u => u.id === app.applicantId);
        if (user) {
          csvRows.push([
            app.id,
            `"${user.name.replace(/"/g, '""')}"`,
            user.email,
            user.phone || "",
            user.country || "",
            app.status,
            app.trainingStatus || "",
            app.appliedAt.toISOString(),
            `"${(app.adminNotes || "").replace(/"/g, '""')}"`
          ].join(","));
        }
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=applications.csv");
      res.send(csvRows.join("\n"));
    } catch (error) {
      res.status(500).json({ error: "Failed to export applications" });
    }
  });

  app.patch("/api/applications/:id/notes", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { notes } = req.body;
      const app = await storage.updateApplication(req.params.id as string, { adminNotes: notes });
      if (!app) {
        return res.status(404).json({ error: "Application not found" });
      }
      res.json(app);
    } catch (error) {
      res.status(500).json({ error: "Failed to update application notes" });
    }
  });

  app.post("/api/applications/:id/resend-trainer-notification", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      if (!application.trainerId || !application.trainingSessionId) {
        return res.status(400).json({ error: "Application has no trainer assigned" });
      }
      
      const applicant = await storage.getUser(application.applicantId);
      const trainer = await storage.getUser(application.trainerId);
      const session = await storage.getTrainingSession(application.trainingSessionId);
      
      if (!applicant || !trainer || !session) {
        return res.status(404).json({ error: "Could not find related data" });
      }
      
      const sessionTime = new Date(session.startTime).toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
      });
      
      // Send email notification to trainer
      sendTrainerAssignmentEmail(
        trainer.email,
        trainer.name,
        applicant.name,
        applicant.email,
        applicant.whatsappNumber || applicant.phone || null,
        sessionTime
      ).catch(logger.error);
      
      // Send push notification
      notifyTrainerAssignment(trainer.id, applicant.name).catch(logger.error);
      
      res.json({ 
        success: true, 
        message: `Notification sent to ${trainer.name}` 
      });
    } catch (error) {
      logger.error("Failed to resend trainer notification:", error);
      res.status(500).json({ error: "Failed to resend notification" });
    }
  });

  app.post("/api/applications/:id/send-trainer-info", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      if (!application.trainerId) {
        return res.status(400).json({ error: "Application has no trainer assigned" });
      }
      
      const applicant = await storage.getUser(application.applicantId);
      const trainer = await storage.getUser(application.trainerId);
      
      if (!applicant || !trainer) {
        return res.status(404).json({ error: "Could not find applicant or trainer data" });
      }
      
      const { sendTrainerInfoToTrainee } = await import('../email');
      const referralCode = trainer.referralCode || null;
      const onboardingUrl = referralCode
        ? `https://www.affiliates-portermetrics.com/register?ref=${encodeURIComponent(referralCode)}`
        : "https://www.affiliates-portermetrics.com/register";
      
      const selectedWhatsapp = req.body?.whatsappNumber || trainer.whatsappNumber || trainer.whatsappNumber2 || trainer.whatsappNumber3 || null;
      
      const success = await sendTrainerInfoToTrainee(
        applicant.email,
        applicant.name,
        trainer.name,
        trainer.email,
        selectedWhatsapp,
        referralCode,
        onboardingUrl
      );
      
      if (success) {
        // Also send trainee info to the trainer
        const { sendTrainerAssignmentEmail } = await import('../email');
        const session = application.trainingSessionId ? await storage.getTrainingSession(application.trainingSessionId) : null;
        const sessionTimeStr = session ? new Date(session.startTime).toLocaleString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
          hour: "numeric", minute: "2-digit", timeZoneName: "short"
        }) : "To be scheduled";
        
        sendTrainerAssignmentEmail(
          trainer.email,
          trainer.name,
          applicant.name,
          applicant.email,
          applicant.whatsappNumber || applicant.phone || null,
          sessionTimeStr
        ).catch(logger.error);
        
        res.json({ success: true, message: `Trainer info sent to ${applicant.name} (${applicant.email}). Trainee info also sent to ${trainer.name}.` });
      } else {
        res.status(500).json({ error: "Failed to send email" });
      }
    } catch (error) {
      logger.error("Failed to send trainer info to trainee:", error);
      res.status(500).json({ error: "Failed to send trainer info" });
    }
  });
}
