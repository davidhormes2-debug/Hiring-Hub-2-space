import type { Express } from "express";
import { requireAuth, requireRole, sanitizeUser, logActivity } from "./helpers";
import { storage } from "../storage";
import { logger } from "../logger";
import { z } from "zod";
import { insertTrainingSessionSchema, insertTrainingMaterialSchema, Application, User } from "@shared/schema";
import { sendEmail, sendTrainingReminderEmail, sendTrainingCompletionCertificate, sendWithdrawalCertificate, generateTrainingCertificatePDF, generateWithdrawalCertificatePDF, sendTrainerCertifiedEmail, generateTrainerCertificateHtml, sendManualAssignmentEmail } from "../email";
import { runDailySessionMaintenance } from "../session-scheduler";
import crypto from "crypto";

function verifySchedulingToken(token: string): { applicationId: string; email: string } | null {
  try {
    const secret = process.env.SESSION_SECRET || "scheduling-secret-key";
    const decoded = Buffer.from(token, "base64url").toString();
    const parts = decoded.split(":");
    if (parts.length < 4) return null;
    const [applicationId, email, timestamp, hmac] = [parts[0], parts[1], parts[2], parts[3]];
    const payload = `${applicationId}:${email}:${timestamp}`;
    const expectedHmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    if (hmac !== expectedHmac) return null;
    const tokenAge = Date.now() - parseInt(timestamp);
    if (tokenAge > 30 * 24 * 60 * 60 * 1000) return null;
    return { applicationId, email };
  } catch {
    return null;
  }
}

export function registerTrainingRoutes(app: Express) {
  app.post("/api/training-sessions", requireAuth, async (req, res) => {
    try {
      const bodyWithDate = {
        ...req.body,
        startTime: req.body.startTime ? new Date(req.body.startTime) : undefined
      };
      const sessionData = insertTrainingSessionSchema.parse(bodyWithDate);
      const session = await storage.createTrainingSession(sessionData);
      res.json(session);
      logActivity("Created training session", "TrainingSession", session.id, `Created training session`, req.session.userId);
    } catch (error) {
      logger.error("Error creating training session:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create training session" });
    }
  });

  app.get("/api/training-sessions", requireAuth, async (req, res) => {
    try {
      const { trainerId } = req.query;
      if (trainerId && typeof trainerId === "string") {
        const sessions = await storage.getTrainingSessionsByTrainer(trainerId);
        return res.json(sessions);
      }
      const sessions = await storage.getAllTrainingSessions();
      res.json(sessions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch training sessions" });
    }
  });

  app.get("/api/training-sessions/archived", requireAuth, async (req, res) => {
    try {
      const archivedSessions = await storage.getArchivedSessions();
      res.json(archivedSessions);
    } catch (error) {
      logger.error("Error fetching archived sessions:", error);
      res.status(500).json({ error: "Failed to fetch archived sessions" });
    }
  });

  app.get("/api/training-sessions/:id", requireAuth, async (req, res) => {
    try {
      const session = await storage.getTrainingSession(req.params.id as string);
      if (!session) {
        return res.status(404).json({ error: "Training session not found" });
      }
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch training session" });
    }
  });

  app.patch("/api/training-sessions/:id", requireAuth, async (req, res) => {
    try {
      const updateData = insertTrainingSessionSchema.partial().parse(req.body);

      if (updateData.startTime) {
        const startDate = new Date(updateData.startTime);
        const utcHour = startDate.getUTCHours();
        if (utcHour < 9 || utcHour > 23) {
          return res.status(400).json({ error: "Session time must be between 9:00 AM and 11:59 PM UTC" });
        }
      }

      const session = await storage.updateTrainingSession(req.params.id as string, updateData);
      if (!session) {
        return res.status(404).json({ error: "Training session not found" });
      }
      res.json(session);
      logActivity("Updated training session", "TrainingSession", req.params.id as string, "Updated training session", req.session.userId);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to update training session" });
    }
  });

  app.delete("/api/training-sessions/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteTrainingSession(req.params.id as string);
      logActivity("Deleted training session", "TrainingSession", req.params.id as string, "Deleted training session", req.session.userId);
      res.json({ success: true, message: "Training session deleted successfully" });
    } catch (error) {
      logger.error("Error deleting training session:", error);
      res.status(500).json({ error: "Failed to delete training session" });
    }
  });

  app.post("/api/training-sessions/:id/archive", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const session = await storage.archiveTrainingSession(req.params.id as string);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json({ success: true, session });
      logActivity("Archived training session", "TrainingSession", req.params.id as string, "Archived training session", req.session.userId, undefined, { isArchived: "false" });
    } catch (error) {
      logger.error("Error archiving session:", error);
      res.status(500).json({ error: "Failed to archive session" });
    }
  });

  app.post("/api/training-sessions/:id/unarchive", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const session = await storage.unarchiveTrainingSession(req.params.id as string);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json({ success: true, session });
    } catch (error) {
      logger.error("Error unarchiving session:", error);
      res.status(500).json({ error: "Failed to unarchive session" });
    }
  });

  app.post("/api/training-sessions/auto-archive", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const sessions = await storage.getAllTrainingSessions();
      const now = new Date();
      let archivedCount = 0;
      
      for (const session of sessions) {
        if (session.isArchived === "true") continue;
        
        const sessionTime = new Date(session.startTime);
        const hoursSincePassed = (now.getTime() - sessionTime.getTime()) / (1000 * 60 * 60);
        
        // Archive sessions that passed more than 24 hours ago
        if (hoursSincePassed > 24) {
          await storage.archiveTrainingSession(session.id);
          archivedCount++;
        }
      }
      
      res.json({ success: true, archivedCount, message: `Archived ${archivedCount} past sessions` });
    } catch (error) {
      logger.error("Error auto-archiving sessions:", error);
      res.status(500).json({ error: "Failed to auto-archive sessions" });
    }
  });

  app.post("/api/training-sessions/daily-setup", requireRole("admin"), async (req, res) => {
    try {
      const result = await runDailySessionMaintenance();
      res.json({
        success: true,
        ...result,
        message: `Archived ${result.archived} old sessions, closed ${result.closedFuture} future sessions, and created ${result.created} new daily sessions for trainers.`,
      });
    } catch (error) {
      logger.error("Error running daily session setup:", error);
      res.status(500).json({ error: "Failed to run daily session setup" });
    }
  });

  app.get("/api/weekly-availability", requireAuth, async (req, res) => {
    try {
      const trainerId = req.query.trainerId as string | undefined;
      if (trainerId) {
        const availability = await storage.getWeeklyAvailabilityByTrainer(trainerId);
        res.json(availability);
      } else {
        const availability = await storage.getAllWeeklyAvailability();
        res.json(availability);
      }
    } catch (error) {
      logger.error("Error fetching weekly availability:", error);
      res.status(500).json({ error: "Failed to fetch weekly availability" });
    }
  });

  app.post("/api/weekly-availability", requireAuth, async (req, res) => {
    try {
      const user = { id: req.session.userId!, role: req.session.userRole! };
      if (user.role !== "admin" && user.role !== "trainer") {
        return res.status(403).json({ error: "Only admins and trainers can manage availability" });
      }
      if (user.role === "trainer" && req.body.trainerId && req.body.trainerId !== user.id) {
        return res.status(403).json({ error: "Trainers can only manage their own availability" });
      }
      const data = user.role === "trainer" ? { ...req.body, trainerId: user.id } : req.body;
      const availability = await storage.createWeeklyAvailability(data);
      res.json(availability);
    } catch (error) {
      logger.error("Error creating weekly availability:", error);
      res.status(500).json({ error: "Failed to create weekly availability" });
    }
  });

  app.patch("/api/weekly-availability/:id", requireAuth, async (req, res) => {
    try {
      const user = { id: req.session.userId!, role: req.session.userRole! };
      if (user.role !== "admin" && user.role !== "trainer") {
        return res.status(403).json({ error: "Only admins and trainers can manage availability" });
      }
      if (user.role === "trainer") {
        const existing = await storage.getWeeklyAvailability(req.params.id as string);
        if (!existing || existing.trainerId !== user.id) {
          return res.status(403).json({ error: "Trainers can only edit their own availability" });
        }
      }
      const availability = await storage.updateWeeklyAvailability(req.params.id as string, req.body);
      if (!availability) {
        return res.status(404).json({ error: "Weekly availability not found" });
      }
      res.json(availability);
    } catch (error) {
      logger.error("Error updating weekly availability:", error);
      res.status(500).json({ error: "Failed to update weekly availability" });
    }
  });

  app.delete("/api/weekly-availability/:id", requireAuth, async (req, res) => {
    try {
      const user = { id: req.session.userId!, role: req.session.userRole! };
      if (user.role !== "admin" && user.role !== "trainer") {
        return res.status(403).json({ error: "Only admins and trainers can manage availability" });
      }
      if (user.role === "trainer") {
        const existing = await storage.getWeeklyAvailability(req.params.id as string);
        if (!existing || existing.trainerId !== user.id) {
          return res.status(403).json({ error: "Trainers can only delete their own availability" });
        }
      }
      await storage.deleteWeeklyAvailability(req.params.id as string);
      res.json({ success: true, message: "Weekly availability deleted successfully" });
    } catch (error) {
      logger.error("Error deleting weekly availability:", error);
      res.status(500).json({ error: "Failed to delete weekly availability" });
    }
  });

  app.post("/api/weekly-availability/initialize-defaults", requireAuth, async (req, res) => {
    try {
      const user = { id: req.session.userId!, role: req.session.userRole! };
      const targetTrainerId = req.body.trainerId || user.id;
      if (user.role !== "admin" && user.role !== "trainer") {
        return res.status(403).json({ error: "Only admins and trainers can initialize availability" });
      }
      if (user.role === "trainer" && targetTrainerId !== user.id) {
        return res.status(403).json({ error: "Trainers can only initialize their own availability" });
      }

      const existing = await storage.getWeeklyAvailabilityByTrainer(targetTrainerId);
      if (existing.length > 0) {
        return res.json({ message: "Availability already initialized", availability: existing });
      }

      const defaultSlots = [
        { startTime: "10:00", endTime: "12:00", timezone: "UTC", slotIndex: "1" },
        { startTime: "13:00", endTime: "15:00", timezone: "UTC", slotIndex: "2" },
        { startTime: "16:00", endTime: "18:00", timezone: "UTC", slotIndex: "3" },
        { startTime: "15:00", endTime: "17:00", timezone: "EST", slotIndex: "4" },
        { startTime: "18:00", endTime: "20:00", timezone: "EST", slotIndex: "5" },
      ];
      const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

      const created = [];
      for (const day of days) {
        for (const slot of defaultSlots) {
          const avail = await storage.createWeeklyAvailability({
            trainerId: targetTrainerId,
            dayOfWeek: day,
            slotIndex: slot.slotIndex,
            startTime: slot.startTime,
            endTime: slot.endTime,
            durationMinutes: "120",
            maxAttendees: "5",
            timezone: slot.timezone,
            isActive: "true",
          });
          created.push(avail);
        }
      }
      res.json({ message: "Default availability initialized", availability: created });
    } catch (error) {
      logger.error("Error initializing default availability:", error);
      res.status(500).json({ error: "Failed to initialize default availability" });
    }
  });

  app.post("/api/weekly-availability/bulk-update", requireAuth, async (req, res) => {
    try {
      const user = { id: req.session.userId!, role: req.session.userRole! };
      if (user.role !== "admin" && user.role !== "trainer") {
        return res.status(403).json({ error: "Only admins and trainers can update availability" });
      }
      const { updates } = req.body;
      if (!Array.isArray(updates)) {
        return res.status(400).json({ error: "Updates array is required" });
      }
      const results = [];
      for (const update of updates) {
        if (user.role === "trainer") {
          const existing = await storage.getWeeklyAvailability(update.id);
          if (!existing || existing.trainerId !== user.id) continue;
        }
        const result = await storage.updateWeeklyAvailability(update.id, update.data);
        if (result) results.push(result);
      }
      res.json({ updated: results.length, results });
    } catch (error) {
      logger.error("Error bulk updating availability:", error);
      res.status(500).json({ error: "Failed to bulk update availability" });
    }
  });

  app.get("/api/time-slots", requireAuth, async (req, res) => {
    try {
      const { trainerId } = req.query;
      if (trainerId) {
        const slots = await storage.getTimeSlotsByTrainer(trainerId as string);
        res.json(slots);
      } else {
        const slots = await storage.getAllTimeSlots();
        res.json(slots);
      }
    } catch (error) {
      logger.error("Error fetching time slots:", error);
      res.status(500).json({ error: "Failed to fetch time slots" });
    }
  });

  app.post("/api/time-slots/initialize", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { trainerId } = req.body;
      if (!trainerId) {
        return res.status(400).json({ error: "Trainer ID is required" });
      }
      const slots = await storage.initializeTrainerTimeSlots(trainerId);
      res.status(201).json(slots);
    } catch (error) {
      logger.error("Error initializing time slots:", error);
      res.status(500).json({ error: "Failed to initialize time slots" });
    }
  });

  app.patch("/api/time-slots/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const slot = await storage.updateTimeSlot(req.params.id as string, req.body);
      if (!slot) {
        return res.status(404).json({ error: "Time slot not found" });
      }
      res.json(slot);
    } catch (error) {
      logger.error("Error updating time slot:", error);
      res.status(500).json({ error: "Failed to update time slot" });
    }
  });

  app.patch("/api/time-slots/bulk-update", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { updates } = req.body;
      if (!Array.isArray(updates)) {
        return res.status(400).json({ error: "Updates array is required" });
      }
      const results = await Promise.all(
        updates.map(({ id, ...data }: { id: string; isActive?: string }) => 
          storage.updateTimeSlot(id, data)
        )
      );
      res.json(results.filter(Boolean));
    } catch (error) {
      logger.error("Error bulk updating time slots:", error);
      res.status(500).json({ error: "Failed to bulk update time slots" });
    }
  });

  app.delete("/api/time-slots/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteTimeSlot(req.params.id as string);
      res.json({ success: true, message: "Time slot deleted" });
    } catch (error) {
      logger.error("Error deleting time slot:", error);
      res.status(500).json({ error: "Failed to delete time slot" });
    }
  });

  app.post("/api/weekly-availability/:id/generate-sessions", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { weeksAhead = 4 } = req.body;
      const availability = await storage.getWeeklyAvailability(req.params.id as string);
      
      if (!availability || availability.isActive !== "true") {
        return res.status(404).json({ error: "Active weekly availability not found" });
      }

      const dayMap: Record<string, number> = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
        thursday: 4, friday: 5, saturday: 6
      };

      const targetDay = dayMap[availability.dayOfWeek];
      const sessions: Array<Record<string, unknown>> = [];
      const today = new Date();
      
      for (let week = 0; week < weeksAhead; week++) {
        const date = new Date(today);
        date.setDate(today.getDate() + (targetDay - today.getDay() + 7 * (week + 1)) % 7 + week * 7);
        
        if (date <= today) {
          date.setDate(date.getDate() + 7);
        }

        const [hours, minutes] = availability.startTime.split(':').map(Number);
        date.setHours(hours, minutes, 0, 0);

        const session = await storage.createTrainingSession({
          trainerId: availability.trainerId,
          startTime: date,
          durationMinutes: availability.durationMinutes,
          maxAttendees: availability.maxAttendees,
          status: "open"
        });
        sessions.push(session);
      }

      res.json({ success: true, sessions, message: `Generated ${sessions.length} sessions` });
    } catch (error) {
      logger.error("Error generating sessions:", error);
      res.status(500).json({ error: "Failed to generate sessions" });
    }
  });

  app.post("/api/trainers/:id/certify", requireRole("admin"), async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id as string);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.role !== "trainer") {
        return res.status(400).json({ error: "User is not a trainer" });
      }
      const certifiedUser = await storage.certifyTrainer(req.params.id as string);
      if (certifiedUser) {
        res.json(sanitizeUser(certifiedUser));
        logActivity("Certified trainer", "User", req.params.id as string, `Certified trainer: ${user.name}`, req.session.userId, undefined, { isCertified: user.isCertified });
        sendTrainerCertifiedEmail(user.email, user.name).catch(logger.error);
      }
      else res.status(404).json({ error: "User not found" });
    } catch (error) {
      res.status(500).json({ error: "Failed to certify trainer" });
    }
  });

  app.post("/api/trainers/:id/resend-certificate", requireRole("admin"), async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id as string);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.role !== "trainer") {
        return res.status(400).json({ error: "User is not a trainer" });
      }
      if (user.isCertified !== "true") {
        return res.status(400).json({ error: "Trainer is not certified" });
      }
      await sendTrainerCertifiedEmail(user.email, user.name, user.certifiedAt);
      logActivity("Resent trainer certificate", "User", req.params.id as string, `Resent certification email to trainer: ${user.name}`, req.session.userId);
      res.json({ success: true, message: `Certification email resent to ${user.email}` });
    } catch (error) {
      logger.error("Failed to resend trainer certificate:", error);
      res.status(500).json({ error: "Failed to resend trainer certificate" });
    }
  });

  app.get("/api/trainers/:id/preview-certificate", requireRole("admin"), async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id as string);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.role !== "trainer") {
        return res.status(400).json({ error: "User is not a trainer" });
      }
      const html = generateTrainerCertificateHtml(user.name, user.certifiedAt);
      res.setHeader("Content-Type", "text/html");
      res.send(html);
    } catch (error) {
      logger.error("Failed to preview trainer certificate:", error);
      res.status(500).json({ error: "Failed to generate preview" });
    }
  });

  app.post("/api/training-sessions/:id/send-reminder", requireAuth, requireRole("admin", "trainer"), async (req, res) => {
    try {
      const session = await storage.getTrainingSession(req.params.id as string);
      if (!session) {
        return res.status(404).json({ error: "Training session not found" });
      }

      // Trainers can only send reminders for their own sessions
      const currentUser = await storage.getUser(req.session.userId!);
      if (currentUser?.role === "trainer" && session.trainerId !== currentUser.id) {
        return res.status(403).json({ error: "You can only send reminders for your own sessions" });
      }

      const trainer = await storage.getUser(session.trainerId);
      if (!trainer) {
        return res.status(404).json({ error: "Trainer not found" });
      }

      const { applicationIds } = req.body || {};

      const allApplications = await storage.getAllApplications();
      let linkedApps = allApplications.filter(app => app.trainingSessionId === session.id);
      
      if (Array.isArray(applicationIds) && applicationIds.length > 0) {
        linkedApps = linkedApps.filter(app => applicationIds.includes(app.id));
      }
      
      if (linkedApps.length === 0) {
        return res.status(404).json({ error: "No applicants found for this session" });
      }

      const sessionTime = new Date(session.startTime);
      const now = new Date();
      const hoursUntil = Math.round((sessionTime.getTime() - now.getTime()) / (1000 * 60 * 60));

      for (const app of linkedApps) {
        const applicant = await storage.getUser(app.applicantId);
        if (applicant) {
          sendTrainingReminderEmail(
            applicant.email,
            applicant.name,
            trainer.name,
            sessionTime.toLocaleString('en-US', { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric', 
              hour: '2-digit', 
              minute: '2-digit' 
            }),
            hoursUntil > 0 ? hoursUntil : 1
          ).catch(err => logger.error("Email send failed:", err));
        }
      }

      res.json({ success: true, message: `Sending reminder email(s) to ${linkedApps.length} attendee(s)` });
      logActivity("Sent training reminder", "TrainingSession", req.params.id as string, `Sent reminder to ${linkedApps.length} attendee(s)`, req.session.userId);
    } catch (error) {
      res.status(500).json({ error: "Failed to send reminder" });
    }
  });

  app.post("/api/training-sessions/send-reminders", requireAuth, requireRole("admin", "trainer"), async (req, res) => {
    try {
      const { hoursAhead = 24 } = req.body;
      const sessions = await storage.getAllTrainingSessions();
      const allApplications = await storage.getAllApplications();
      const now = new Date();
      const cutoffTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

      const upcomingSessions = sessions.filter(session => {
        const sessionTime = new Date(session.startTime);
        return session.status === "filled" && 
               sessionTime > now && 
               sessionTime <= cutoffTime;
      });

      let sentCount = 0;
      for (const session of upcomingSessions) {
        const trainer = await storage.getUser(session.trainerId);
        const linkedApps = allApplications.filter(app => app.trainingSessionId === session.id);
        
        for (const app of linkedApps) {
          const applicant = await storage.getUser(app.applicantId);
          
          if (applicant && trainer) {
            const sessionTime = new Date(session.startTime);
            const hoursUntil = Math.round((sessionTime.getTime() - now.getTime()) / (1000 * 60 * 60));
            
            const sent = await sendTrainingReminderEmail(
              applicant.email,
              applicant.name,
              trainer.name,
              sessionTime.toLocaleString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit' 
              }),
              hoursUntil > 0 ? hoursUntil : 1
            );
            if (sent) sentCount++;
          }
        }
      }

      res.json({ 
        success: true, 
        message: `Sent ${sentCount} reminder(s) for ${upcomingSessions.length} upcoming session(s)` 
      });
      logActivity("Sent batch reminders", "TrainingSession", undefined, `Sent batch reminders for ${upcomingSessions.length} upcoming sessions`, req.session.userId);
    } catch (error) {
      res.status(500).json({ error: "Failed to send reminders" });
    }
  });

  app.get("/api/referral-stats/:referralCode", async (req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const referrer = allUsers.find(u => u.referralCode === (req.params.referralCode as string));
      
      if (!referrer) {
        return res.status(404).json({ error: "Referral code not found" });
      }
      
      const referredUsers = allUsers.filter(u => u.referredBy === (req.params.referralCode as string));
      const referredAppsCount = referredUsers.length;
      
      res.json({ count: referredAppsCount });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch referral stats" });
    }
  });

  app.get("/api/training-materials", async (req, res) => {
    try {
      const trainerId = req.query.trainerId as string;
      if (trainerId) {
        const materials = await storage.getTrainingMaterialsByTrainer(trainerId);
        return res.json(materials);
      }
      const materials = await storage.getAllTrainingMaterials();
      res.json(materials);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch training materials" });
    }
  });

  app.post("/api/training-materials", requireAuth, async (req, res) => {
    try {
      const user = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!user || (user.role !== "admin" && user.role !== "trainer")) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const body = { ...req.body };
      if (user.role === "trainer") {
        body.trainerId = user.id;
      }
      const materialData = insertTrainingMaterialSchema.parse(body);
      const material = await storage.createTrainingMaterial(materialData);
      res.json(material);
      logActivity("Created training material", "TrainingMaterial", undefined, "Added new training material", req.session.userId);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create training material" });
    }
  });

  app.delete("/api/training-materials/:id", requireAuth, async (req, res) => {
    try {
      const user = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!user || (user.role !== "admin" && user.role !== "trainer")) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (user.role === "trainer") {
        const existing = await storage.getTrainingMaterialsByTrainer(user.id);
        if (!existing.some(m => m.id === req.params.id)) {
          return res.status(403).json({ error: "You can only delete your own materials" });
        }
      }
      await storage.deleteTrainingMaterial(req.params.id as string);
      logActivity("Deleted training material", "TrainingMaterial", req.params.id as string, "Deleted training material", req.session.userId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete training material" });
    }
  });

  app.patch("/api/training-materials/:id", requireAuth, async (req, res) => {
    try {
      const user = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!user || (user.role !== "admin" && user.role !== "trainer")) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (user.role === "trainer") {
        const existing = await storage.getTrainingMaterialsByTrainer(user.id);
        if (!existing.some(m => m.id === req.params.id)) {
          return res.status(403).json({ error: "You can only update your own materials" });
        }
      }
      const { category, sortOrder, isRequired } = req.body;
      const material = await storage.updateTrainingMaterial(req.params.id as string, { category, sortOrder, isRequired });
      res.json(material);
    } catch (error) {
      res.status(500).json({ error: "Failed to update training material" });
    }
  });

  app.patch("/api/training-materials/reorder", requireAuth, async (req, res) => {
    try {
      const user = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!user || (user.role !== "admin" && user.role !== "trainer")) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const { materials } = req.body;
      if (user.role === "trainer") {
        const ownMaterials = await storage.getTrainingMaterialsByTrainer(user.id);
        const ownIds = new Set(ownMaterials.map(m => m.id));
        const allOwned = materials.every((m: any) => ownIds.has(m.id));
        if (!allOwned) {
          return res.status(403).json({ error: "You can only reorder your own materials" });
        }
      }
      await storage.reorderTrainingMaterials(materials);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to reorder training materials" });
    }
  });

  app.post("/api/training-materials/:id/download", requireAuth, async (req, res) => {
    try {
      const id = req.params.id as string;
      await storage.incrementMaterialDownloadCount(id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to track download" });
    }
  });

  app.get("/api/trainer-leaderboard", requireAuth, async (req, res) => {
    try {
      const user = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!user || (user.role !== "admin" && user.role !== "trainer")) {
        return res.status(403).json({ error: "Not authorized" });
      }
      
      const period = req.query.period as string | undefined;
      let leaderboard = await storage.getTrainerLeaderboard();
      
      if (period === "week" || period === "month") {
        const now = new Date();
        const cutoff = new Date();
        if (period === "week") cutoff.setDate(now.getDate() - 7);
        else cutoff.setMonth(now.getMonth() - 1);
        
        const allSessions = await storage.getAllTrainingSessions();
        const allApps = await storage.getAllApplications();
        
        leaderboard = leaderboard.map(entry => {
          const periodSessions = allSessions.filter(s => 
            s.trainerId === entry.trainerId && 
            s.status === "completed" && 
            s.startTime && new Date(s.startTime) >= cutoff
          );
          const periodApps = allApps.filter(a => 
            a.trainerId === entry.trainerId && 
            a.appliedAt && new Date(a.appliedAt) >= cutoff
          );
          const periodStartedWorking = allApps.filter(a => 
            a.trainerId === entry.trainerId && 
            a.status === "started_working" && 
            a.trainingCompletedAt && new Date(a.trainingCompletedAt) >= cutoff
          );
          return {
            ...entry,
            completedTrainings: periodSessions.length,
            assignedTrainees: periodApps.length,
            startedWorking: periodStartedWorking.length,
          };
        }).sort((a, b) => b.completedTrainings - a.completedTrainings || b.startedWorking - a.startedWorking);
      }

      if (user.role === "trainer") {
        const sanitized = leaderboard.map((entry, index) => ({
          rank: index + 1,
          trainerName: entry.trainerName,
          trainerId: entry.trainerId,
          completedTrainings: entry.completedTrainings,
          assignedTrainees: entry.assignedTrainees,
          startedWorking: entry.startedWorking,
          isMe: entry.trainerId === user.id,
        }));
        return res.json(sanitized);
      }
      const ranked = leaderboard.map((entry, index) => ({
        rank: index + 1,
        ...entry,
      }));
      res.json(ranked);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  app.get("/api/trainer-milestones", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const leaderboardData = await storage.getTrainerLeaderboard();
      const celebrations = await storage.getTrainerCelebrations();
      
      const milestoneThresholds = [
        { count: 5, label: "5 Completed Trainings", type: "training_milestone" },
        { count: 10, label: "10 Completed Trainings", type: "training_milestone" },
        { count: 25, label: "25 Completed Trainings", type: "training_milestone" },
        { count: 50, label: "50 Completed Trainings", type: "training_milestone" },
        { count: 100, label: "100 Completed Trainings", type: "training_milestone" },
      ];
      const startedWorkingThresholds = [
        { count: 3, label: "3 Trainees Started Working", type: "impact_milestone" },
        { count: 5, label: "5 Trainees Started Working", type: "impact_milestone" },
        { count: 10, label: "10 Trainees Started Working", type: "impact_milestone" },
        { count: 25, label: "25 Trainees Started Working", type: "impact_milestone" },
      ];

      const suggestions: Array<{
        trainerId: string;
        trainerName: string;
        milestone: string;
        milestoneType: string;
        currentCount: number;
        alreadyCelebrated: boolean;
      }> = [];

      for (const trainer of leaderboardData) {
        for (const threshold of milestoneThresholds) {
          if (trainer.completedTrainings >= threshold.count) {
            const alreadyCelebrated = celebrations.some(c => 
              c.trainerId === trainer.trainerId && 
              c.message?.includes(threshold.label)
            );
            suggestions.push({
              trainerId: trainer.trainerId,
              trainerName: trainer.trainerName,
              milestone: threshold.label,
              milestoneType: threshold.type,
              currentCount: trainer.completedTrainings,
              alreadyCelebrated,
            });
          }
        }
        for (const threshold of startedWorkingThresholds) {
          if (trainer.startedWorking >= threshold.count) {
            const alreadyCelebrated = celebrations.some(c => 
              c.trainerId === trainer.trainerId && 
              c.message?.includes(threshold.label)
            );
            suggestions.push({
              trainerId: trainer.trainerId,
              trainerName: trainer.trainerName,
              milestone: threshold.label,
              milestoneType: threshold.type,
              currentCount: trainer.startedWorking,
              alreadyCelebrated,
            });
          }
        }
      }

      const uncelebrated = suggestions.filter(s => !s.alreadyCelebrated);
      res.json({ suggestions: uncelebrated, allMilestones: suggestions });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch milestones" });
    }
  });

  app.get("/api/trainer-feedback", requireAuth, async (req, res) => {
    try {
      const user = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!user || user.role !== "trainer") return res.status(403).json({ error: "Not authorized" });
      const fb = await storage.getTraineeFeedbackByTrainer(user.id);
      const enriched = await Promise.all(fb.filter(f => f.submittedAt).map(async (f) => {
        const trainee = f.traineeId ? await storage.getUser(f.traineeId) : null;
        return { ...f, traineeName: trainee?.name || "Anonymous" };
      }));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.get("/api/trainer-celebrations", requireAuth, async (req, res) => {
    try {
      const user = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!user) return res.status(403).json({ error: "Not authorized" });
      if (user.role === "admin") {
        const celebrations = await storage.getTrainerCelebrations();
        const enriched = await Promise.all(celebrations.map(async (c) => {
          const trainer = await storage.getUser(c.trainerId);
          return { ...c, trainerName: trainer?.name || "Unknown" };
        }));
        return res.json(enriched);
      }
      const celebrations = await storage.getVisibleCelebrations();
      const enriched = await Promise.all(celebrations.map(async (c) => {
        const trainer = await storage.getUser(c.trainerId);
        return { ...c, trainerName: trainer?.name || "Unknown" };
      }));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch celebrations" });
    }
  });

  app.post("/api/trainer-celebrations", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { trainerId, message, traineeApplicationId, celebrationType } = req.body;
      if (!trainerId || !message) {
        return res.status(400).json({ error: "Trainer and message are required" });
      }
      const celebration = await storage.createTrainerCelebration({
        trainerId,
        message,
        traineeApplicationId: traineeApplicationId || null,
        celebrationType: celebrationType || "started_working",
        approvedByAdminId: req.session.userId!,
        isVisible: "true",
      });
      logActivity("Created celebration", "TrainerCelebration", celebration.id, `Celebrated trainer ${trainerId}`, req.session.userId);
      res.json(celebration);
    } catch (error) {
      res.status(500).json({ error: "Failed to create celebration" });
    }
  });

  app.patch("/api/trainer-celebrations/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { isVisible } = req.body;
      const celebration = await storage.updateTrainerCelebration(req.params.id as string, {
        isVisible: isVisible ? "true" : "false",
      });
      res.json(celebration);
    } catch (error) {
      res.status(500).json({ error: "Failed to update celebration" });
    }
  });

  app.delete("/api/trainer-celebrations/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteTrainerCelebration(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete celebration" });
    }
  });

  app.post("/api/session-attendance", requireAuth, async (req, res) => {
    try {
      const { sessionId, applicationId, applicantId } = req.body;
      const attendance = await storage.createSessionAttendance({
        sessionId,
        applicationId,
        applicantId,
        status: "registered"
      });
      res.json(attendance);
    } catch (error) {
      res.status(500).json({ error: "Failed to create attendance record" });
    }
  });

  app.get("/api/session-attendance", requireAuth, async (req, res) => {
    try {
      const { sessionId } = req.query;
      if (sessionId && typeof sessionId === "string") {
        const attendance = await storage.getSessionAttendance(sessionId);
        return res.json(attendance);
      }
      const attendance = await storage.getAllSessionAttendance();
      res.json(attendance);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch attendance" });
    }
  });

  app.patch("/api/session-attendance/:id", requireAuth, async (req, res) => {
    try {
      const { status, markedBy, notes } = req.body;
      if (!status || !markedBy) {
        return res.status(400).json({ error: "Status and markedBy are required" });
      }
      const attendance = await storage.updateAttendanceStatus(req.params.id as string, status, markedBy, notes);
      if (!attendance) {
        return res.status(404).json({ error: "Attendance record not found" });
      }
      res.json(attendance);
    } catch (error) {
      res.status(500).json({ error: "Failed to update attendance" });
    }
  });

  app.post("/api/training-sessions/bulk", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { trainerIds, date, time, duration, maxAttendees } = req.body;
      
      if (!trainerIds || !Array.isArray(trainerIds) || trainerIds.length === 0) {
        return res.status(400).json({ error: "At least one trainer must be selected" });
      }
      
      if (!date || !time) {
        return res.status(400).json({ error: "Date and time are required" });
      }
      
      const startTime = new Date(`${date}T${time}:00`);
      const sessions = trainerIds.map((trainerId: string) => ({
        trainerId,
        startTime,
        durationMinutes: duration || "60",
        maxAttendees: maxAttendees || "5",
        status: "open" as const,
      }));
      
      const createdSessions = await storage.createBulkTrainingSessions(sessions);
      res.json({ 
        success: true, 
        count: createdSessions.length, 
        sessions: createdSessions 
      });
    } catch (error) {
      logger.error("Failed to create bulk training sessions:", error);
      res.status(500).json({ error: "Failed to create bulk training sessions" });
    }
  });

  app.post("/api/reschedule-requests", async (req, res) => {
    try {
      const { applicationId, traineeId, currentSessionId, requestedDate, reason } = req.body;
      
      if (!applicationId || !traineeId || !requestedDate) {
        return res.status(400).json({ message: "Application ID, trainee ID, and requested date are required" });
      }

      const application = await storage.getApplication(applicationId);
      if (!application || application.applicantId !== traineeId) {
        return res.status(404).json({ message: "Application not found" });
      }
      
      const request = await storage.createRescheduleRequest({
        applicationId,
        traineeId,
        currentSessionId: currentSessionId || null,
        requestedDate: new Date(requestedDate).toISOString(),
        reason: reason || null,
        status: "pending",
        adminNotes: null,
        reviewedBy: null,
      });
      
      // Notify admins with in-app notification
      const admins = await storage.getUsersByRole("admin");
      const trainee = await storage.getUser(traineeId);
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          type: "system",
          title: "New Reschedule Request",
          message: `${trainee?.name || 'A trainee'} has requested to reschedule their training to ${new Date(requestedDate).toLocaleDateString()}.`,
          link: "/admin?section=reschedules",
          isRead: "false",
        });
      }
      
      res.status(201).json(request);
    } catch (error: any) {
      logger.error("Failed to create reschedule request", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/reschedule-requests", requireAuth, async (req, res) => {
    try {
      const requests = await storage.getAllRescheduleRequests();
      res.json(requests);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/reschedule-requests/trainee/:traineeId", requireAuth, async (req, res) => {
    try {
      const requests = await storage.getRescheduleRequestsByTrainee(req.params.traineeId as string);
      res.json(requests);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/reschedule-requests/:id/approve", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { adminNotes, reviewedBy } = req.body;
      const request = await storage.updateRescheduleRequest(req.params.id as string, {
        status: "approved",
        adminNotes: adminNotes || null,
        reviewedBy: reviewedBy || null,
        reviewedAt: new Date(),
      });
      
      if (!request) {
        return res.status(404).json({ message: "Reschedule request not found" });
      }
      
      // Get trainee and their application
      const trainee = await storage.getUser(request.traineeId);
      const application = await storage.getApplication(request.applicationId);
      
      if (trainee && application) {
        // Get trainer info
        const trainer = application.trainerId ? await storage.getUser(application.trainerId) : null;
        
        // Send emails to trainee and trainer
        const { sendRescheduleApprovedEmail } = await import("../email");
        await sendRescheduleApprovedEmail(
          trainee.email,
          trainee.name,
          trainer?.email || "",
          trainer?.name || "Your trainer",
          request.requestedDate ? new Date(request.requestedDate).toLocaleString("en-US", { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' 
          }) : "TBD",
          adminNotes
        );
        
        // Notify trainee
        await storage.createNotification({
          userId: trainee.id,
          type: "training_scheduled",
          title: "Reschedule Approved",
          message: `Your reschedule request has been approved. New date: ${request.requestedDate ? new Date(request.requestedDate).toLocaleDateString() : "TBD"}.`,
          link: "/profile",
          isRead: "false",
        });
        
        // Notify trainer if exists
        if (trainer) {
          await storage.createNotification({
            userId: trainer.id,
            type: "training_scheduled",
            title: "Training Rescheduled",
            message: `${trainee.name}'s training has been rescheduled to ${request.requestedDate ? new Date(request.requestedDate).toLocaleDateString() : "TBD"}.`,
            link: "/trainer",
            isRead: "false",
          });
        }
      }
      
      res.json(request);
    } catch (error: any) {
      logger.error("Failed to approve reschedule request", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/reschedule-requests/:id/reject", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { adminNotes, reviewedBy } = req.body;
      const request = await storage.updateRescheduleRequest(req.params.id as string, {
        status: "rejected",
        adminNotes: adminNotes || null,
        reviewedBy: reviewedBy || null,
        reviewedAt: new Date(),
      });
      
      if (!request) {
        return res.status(404).json({ message: "Reschedule request not found" });
      }
      
      // Notify trainee
      const trainee = await storage.getUser(request.traineeId);
      if (trainee) {
        const { sendRescheduleRejectedEmail } = await import("../email");
        await sendRescheduleRejectedEmail(trainee.email, trainee.name, adminNotes);
        
        await storage.createNotification({
          userId: trainee.id,
          type: "system",
          title: "Reschedule Request Update",
          message: adminNotes ? `Your reschedule request was not approved. Reason: ${adminNotes}` : "Your reschedule request was not approved. Please keep your current schedule.",
          link: "/profile",
          isRead: "false",
        });
      }
      
      res.json(request);
    } catch (error: any) {
      logger.error("Failed to reject reschedule request", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/reschedule-requests/:id/ignore", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { adminNotes, reviewedBy } = req.body;
      const request = await storage.updateRescheduleRequest(req.params.id as string, {
        status: "ignored",
        adminNotes: adminNotes || null,
        reviewedBy: reviewedBy || null,
        reviewedAt: new Date(),
      });
      
      if (!request) {
        return res.status(404).json({ message: "Reschedule request not found" });
      }
      
      res.json(request);
    } catch (error: any) {
      logger.error("Failed to ignore reschedule request", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/training-appointments/verify-token", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) {
        return res.status(400).json({ error: "Token is required" });
      }
      
      const tokenData = verifySchedulingToken(token);
      if (!tokenData) {
        return res.status(401).json({ error: "Invalid or expired scheduling link. Please contact support for a new one." });
      }
      
      const application = await storage.getApplication(tokenData.applicationId);
      if (!application || application.status !== "accepted") {
        return res.status(400).json({ error: "Application not eligible for scheduling." });
      }
      
      const applicant = await storage.getUser(application.applicantId);
      const appointments = await storage.getTrainingAppointmentsByApplicant(application.applicantId);
      
      // Only return minimal non-sensitive info
      res.json({
        applicationId: application.id,
        applicantName: applicant?.name || "",
        email: tokenData.email,
        existingAppointments: appointments.map(apt => ({
          id: apt.id,
          preferredDate: apt.preferredDate,
          preferredTime: apt.preferredTime,
          status: apt.status,
        })),
      });
    } catch (error: any) {
      logger.error("Failed to verify scheduling token:", error);
      res.status(500).json({ error: "Failed to verify token" });
    }
  });

  app.post("/api/training-appointments", async (req, res) => {
    try {
      const { token, preferredDate, preferredTime, whatsappNumber, timezone, notes } = req.body;
      
      if (!token) {
        return res.status(401).json({ error: "Scheduling token is required. Please use the link from your acceptance email." });
      }
      
      if (!preferredDate || !preferredTime || !whatsappNumber) {
        return res.status(400).json({ error: "Preferred date, time, and WhatsApp number are required" });
      }
      
      // Validate WhatsApp number format (must contain digits, optionally with + prefix)
      const whatsappClean = whatsappNumber.replace(/[\s\-()]/g, "");
      if (!/^\+?\d{7,15}$/.test(whatsappClean)) {
        return res.status(400).json({ error: "Invalid WhatsApp number. Please include country code (e.g., +1234567890)." });
      }
      
      const schedDateTime = new Date(`${preferredDate}T${preferredTime}`);
      if (isNaN(schedDateTime.getTime())) {
        return res.status(400).json({ error: "Invalid date or time format." });
      }
      const now = new Date();
      const minScheduleTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      if (schedDateTime < minScheduleTime) {
        return res.status(400).json({ error: "Training must be scheduled at least 24 hours in advance." });
      }
      
      // Verify token
      const tokenData = verifySchedulingToken(token);
      if (!tokenData) {
        return res.status(401).json({ error: "Invalid or expired scheduling link. Please contact support for a new one." });
      }
      
      const application = await storage.getApplication(tokenData.applicationId);
      if (!application || application.status !== "accepted") {
        return res.status(400).json({ error: "Application not eligible for scheduling." });
      }
      
      // Check for existing pending/assigned appointment to prevent spam
      const existingApts = await storage.getTrainingAppointmentsByApplicant(application.applicantId);
      const activeApt = existingApts.find(a => a.status === "pending" || a.status === "assigned");
      if (activeApt) {
        return res.status(400).json({ error: "You already have an active training appointment. Please wait for your current one to be processed." });
      }
      
      const appointment = await storage.createTrainingAppointment({
        applicationId: application.id,
        applicantId: application.applicantId,
        trainerId: application.applicantId,
        startTime: schedDateTime,
        endTime: schedDateTime,
        preferredDate: preferredDate,
        preferredTime,
        whatsappNumber: whatsappClean,
        timezone: timezone || null,
        notes: notes || null,
      });
      
      // Update application training status to "requested"
      await storage.updateApplication(application.id, { trainingStatus: "requested" });
      
      // Notify admins
      const admins = await storage.getUsersByRole("admin");
      const applicant = await storage.getUser(application.applicantId);
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          type: "system",
          title: "New Training Schedule Request",
          message: `${applicant?.name || 'An applicant'} has requested training on ${schedDateTime.toLocaleDateString()} at ${preferredTime}.`,
          link: "/admin?section=training-appointments",
          isRead: "false",
        });
      }
      
      res.status(201).json({ id: appointment.id, status: appointment.status });
    } catch (error: any) {
      logger.error("Failed to create training appointment:", error);
      res.status(500).json({ error: "Failed to submit training schedule request" });
    }
  });

  app.get("/api/training-appointments", requireRole("admin"), async (req, res) => {
    try {
      const appointments = await storage.getAllTrainingAppointments();
      
      // Enrich with applicant and trainer info
      const enriched = await Promise.all(appointments.map(async (apt) => {
        const applicant = await storage.getUser(apt.applicantId);
        const trainer = apt.assignedTrainerId ? await storage.getUser(apt.assignedTrainerId) : null;
        const application = apt.applicationId ? await storage.getApplication(apt.applicationId) : null;
        return {
          ...apt,
          applicantName: applicant?.name || "Unknown",
          applicantEmail: applicant?.email || "",
          applicantWhatsapp: apt.whatsappNumber,
          trainerName: trainer?.name || null,
          trainerEmail: trainer?.email || null,
          applicationStatus: application?.status || null,
        };
      }));
      
      res.json(enriched);
    } catch (error: any) {
      logger.error("Failed to get training appointments:", error);
      res.status(500).json({ error: "Failed to get training appointments" });
    }
  });

  app.get("/api/training-appointments/pending-count", requireRole("admin"), async (req, res) => {
    try {
      const pending = await storage.getPendingTrainingAppointments();
      res.json({ count: pending.length });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get count" });
    }
  });

  app.patch("/api/training-appointments/:id/assign", requireRole("admin"), async (req, res) => {
    try {
      const { trainerId, trainerWhatsapp } = req.body;
      
      if (!trainerId) {
        return res.status(400).json({ error: "Trainer ID is required" });
      }
      
      const appointment = await storage.getTrainingAppointment(req.params.id as string);
      if (!appointment) {
        return res.status(404).json({ error: "Training appointment not found" });
      }
      
      const trainer = await storage.getUser(trainerId);
      if (!trainer) {
        return res.status(404).json({ error: "Trainer not found" });
      }
      
      // Use the selected WhatsApp or the trainer's primary
      const selectedTrainerWhatsapp = trainerWhatsapp || trainer.whatsappNumber || null;
      
      const updated = await storage.updateTrainingAppointment(req.params.id as string, {
        assignedTrainerId: trainerId,
        assignedAt: new Date(),
        trainerWhatsapp: selectedTrainerWhatsapp,
        status: "assigned",
      });
      
      // Update the application with trainer assignment and training status
      if (appointment.applicationId) {
        await storage.updateApplication(appointment.applicationId, {
          trainerId,
          trainingStatus: "scheduled",
        });
      }
      
      // Get applicant details
      const applicant = await storage.getUser(appointment.applicantId);
      
      if (applicant && trainer) {
        const dateStr = new Date(appointment.preferredDate || "").toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        const referralCode = trainer.referralCode || null;
        const onboardingUrl = referralCode
          ? `https://www.affiliates-portermetrics.com/register?ref=${encodeURIComponent(referralCode)}`
          : "https://www.affiliates-portermetrics.com/register";

        const { sendTrainingAssignedWithWhatsApp } = await import("../email");
        await sendTrainingAssignedWithWhatsApp(
          applicant.email,
          applicant.name,
          trainer.name,
          selectedTrainerWhatsapp || "",
          dateStr,
          appointment.preferredTime || "",
          trainer.email,
          referralCode,
          onboardingUrl
        ).catch(logger.error);
        
        const { sendTrainerNewTraineeWhatsApp } = await import("../email");
        await sendTrainerNewTraineeWhatsApp(
          trainer.email,
          trainer.name,
          applicant.name,
          appointment.whatsappNumber || "",
          dateStr,
          appointment.preferredTime || "",
          applicant.email,
          applicant.phone || null
        ).catch(logger.error);
        
        await storage.createNotification({
          userId: applicant.id,
          type: "system",
          title: "Trainer Assigned for Your Training",
          message: `Your trainer ${trainer.name} has been assigned. Training is via WhatsApp. Contact them at ${selectedTrainerWhatsapp || trainer.email}.`,
          link: "/status",
          isRead: "false",
        });
        
        await storage.createNotification({
          userId: trainer.id,
          type: "system",
          title: "New Trainee Assigned",
          message: `${applicant.name} has been assigned to you for training on ${new Date(appointment.preferredDate || "").toLocaleDateString()} at ${appointment.preferredTime || ""}. Their WhatsApp: ${appointment.whatsappNumber || ""}`,
          link: "/trainer",
          isRead: "false",
        });
      }
      
      res.json(updated);
    } catch (error: any) {
      logger.error("Failed to assign trainer to appointment:", error);
      res.status(500).json({ error: "Failed to assign trainer" });
    }
  });

  app.post("/api/send-certificate", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { email, recipientName, certificateType, date, position, trainerName, notes, reason, certificateId: providedCertificateId, applicationId, smtpAccountId: rawSmtpId } = req.body;
      const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
      if (smtpAccountId !== undefined && isNaN(smtpAccountId)) {
        return res.status(400).json({ error: "Invalid smtpAccountId" });
      }

      if (!email || !recipientName || !certificateType || !date) {
        return res.status(400).json({ error: "Missing required fields: email, recipientName, certificateType, date" });
      }

      const certificateId = providedCertificateId || `CERT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      const formattedDate = new Date(date).toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric"
      });

      const certBranding = (req.body.companyName || req.body.companyTagline || req.body.companyEmail) ? {
        companyName: req.body.companyName,
        companyTagline: req.body.companyTagline,
        companyEmail: req.body.companyEmail,
      } : undefined;

      if (certificateType === "training") {
        sendTrainingCompletionCertificate(
          email,
          recipientName,
          trainerName || "The Metrics Team",
          formattedDate,
          certificateId,
          certBranding,
          smtpAccountId
        ).catch(err => logger.error("Email send failed:", err));
      } else if (certificateType === "withdrawal") {
        sendWithdrawalCertificate(
          email,
          recipientName,
          formattedDate,
          certificateId,
          reason || undefined,
          notes || undefined,
          certBranding,
          smtpAccountId
        ).catch(err => logger.error("Email send failed:", err));
      } else {
        return res.status(400).json({ error: "Invalid certificateType. Must be 'training' or 'withdrawal'" });
      }

      // Log the certificate sending
      const adminUser = await storage.getUser(req.session.userId!);
      const appForLog = applicationId ? await storage.getApplication(applicationId) : null;
      await storage.createCertificateLog({
        applicationId: appForLog ? applicationId : null,
        certificateId,
        applicantId: appForLog?.applicantId || null,
        applicantName: recipientName,
        applicantEmail: email,
        action: `${certificateType}_certificate_sent`,
        actionBy: req.session.userId || null,
        actionByName: adminUser?.name || "Admin",
        reason: null,
        companyName: certBranding?.companyName || null,
        companyTagline: certBranding?.companyTagline || null,
      });

      return res.json({ success: true, certificateId });
    } catch (error: any) {
      logger.error("Failed to send certificate", error);
      res.status(500).json({ error: "Failed to send certificate" });
    }
  });

  app.get("/api/certificate-logs", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const logs = await storage.getCertificateLogs();
      res.json(logs);
    } catch (error: any) {
      logger.error("Failed to get certificate logs:", error);
      res.status(500).json({ error: "Failed to get certificate logs" });
    }
  });

  app.get("/api/certificate-logs/application/:applicationId", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const logs = await storage.getCertificateLogsByApplication(req.params.applicationId as string);
      res.json(logs);
    } catch (error: any) {
      logger.error("Failed to get certificate logs:", error);
      res.status(500).json({ error: "Failed to get certificate logs" });
    }
  });

  app.post("/api/certificates/:applicationId/revoke", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason || !reason.trim()) {
        return res.status(400).json({ error: "A reason is required to revoke a certificate" });
      }

      const application = await storage.getApplication(req.params.applicationId as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      if (!application.certificateId) {
        return res.status(400).json({ error: "No certificate exists for this application" });
      }
      if (application.certificateRevoked === "true") {
        return res.status(400).json({ error: "Certificate is already revoked" });
      }

      const adminUser = await storage.getUser(req.session.userId!);
      const applicant = await storage.getUser(application.applicantId);

      const updatedApp = await storage.updateApplication(req.params.applicationId as string, {
        certificateRevoked: "true",
        certificateRevokedAt: new Date(),
        certificateRevokedBy: req.session.userId,
        certificateRevokedReason: reason.trim(),
      });

      // Log the revocation
      await storage.createCertificateLog({
        applicationId: application.id,
        certificateId: application.certificateId,
        applicantId: application.applicantId,
        applicantName: applicant?.name || "Unknown",
        applicantEmail: applicant?.email || "Unknown",
        action: "certificate_revoked",
        actionBy: req.session.userId || null,
        actionByName: adminUser?.name || "Admin",
        reason: reason.trim(),
      });

      // Notify the applicant
      if (applicant) {
        await storage.createNotification({
          userId: applicant.id,
          type: "system",
          title: "Certificate Revoked",
          message: `Your training certificate has been revoked. Reason: ${reason.trim()}`,
          link: "/status",
          isRead: "false",
        });

        const { sendCertificateRevokedEmail } = await import("../email");
        sendCertificateRevokedEmail(applicant.email, applicant.name, application.certificateId!, reason.trim());
      }

      res.json(updatedApp);
      logActivity("Certificate revoked", "Application", application.id, `Certificate ${application.certificateId} revoked. Reason: ${reason.trim()}`, req.session.userId);
    } catch (error: any) {
      logger.error("Failed to revoke certificate:", error);
      res.status(500).json({ error: "Failed to revoke certificate" });
    }
  });

  app.post("/api/certificates/:applicationId/reactivate", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { reason } = req.body;

      const application = await storage.getApplication(req.params.applicationId as string);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      if (!application.certificateId) {
        return res.status(400).json({ error: "No certificate exists for this application" });
      }
      if (application.certificateRevoked !== "true") {
        return res.status(400).json({ error: "Certificate is not revoked" });
      }

      const adminUser = await storage.getUser(req.session.userId!);
      const applicant = await storage.getUser(application.applicantId);

      const updatedApp = await storage.updateApplication(req.params.applicationId as string, {
        certificateRevoked: "false",
        certificateRevokedAt: null,
        certificateRevokedBy: null,
        certificateRevokedReason: null,
      });

      // Log the reactivation
      await storage.createCertificateLog({
        applicationId: application.id,
        certificateId: application.certificateId,
        applicantId: application.applicantId,
        applicantName: applicant?.name || "Unknown",
        applicantEmail: applicant?.email || "Unknown",
        action: "certificate_reactivated",
        actionBy: req.session.userId || null,
        actionByName: adminUser?.name || "Admin",
        reason: reason?.trim() || null,
      });

      // Notify the applicant
      if (applicant) {
        await storage.createNotification({
          userId: applicant.id,
          type: "system",
          title: "Certificate Reactivated",
          message: "Your training certificate has been reactivated.",
          link: "/status",
          isRead: "false",
        });

        const { sendCertificateReactivatedEmail } = await import("../email");
        sendCertificateReactivatedEmail(applicant.email, applicant.name, application.certificateId!, reason?.trim());
      }

      res.json(updatedApp);
      logActivity("Certificate reactivated", "Application", application.id, `Certificate ${application.certificateId} reactivated${reason ? `. Reason: ${reason.trim()}` : ''}`, req.session.userId);
    } catch (error: any) {
      logger.error("Failed to reactivate certificate:", error);
      res.status(500).json({ error: "Failed to reactivate certificate" });
    }
  });

  app.post("/api/preview-certificate", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { recipientName, certificateType, date, trainerName, notes, reason, companyName, companyTagline, companyEmail } = req.body;

      if (!recipientName || !certificateType || !date) {
        return res.status(400).json({ error: "Missing required fields: recipientName, certificateType, date" });
      }

      const certificateId = `CERT-PREVIEW-${Date.now().toString(36).toUpperCase()}`;
      const formattedDate = new Date(date).toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric"
      });

      const previewBranding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } : undefined;
      let pdfBuffer: Buffer;

      if (certificateType === "training") {
        pdfBuffer = await generateTrainingCertificatePDF({
          name: recipientName,
          trainerName: trainerName || "The Metrics Team",
          completionDate: formattedDate,
          certificateId,
          branding: previewBranding,
        });
      } else if (certificateType === "withdrawal") {
        pdfBuffer = await generateWithdrawalCertificatePDF({
          name: recipientName,
          withdrawalDate: formattedDate,
          certificateId,
          reason: reason || undefined,
          notes: notes || undefined,
          branding: previewBranding,
        });
      } else {
        return res.status(400).json({ error: "Invalid certificateType" });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="certificate_preview.pdf"`);
      res.send(pdfBuffer);
    } catch (error: any) {
      logger.error("Failed to generate certificate preview", error);
      res.status(500).json({ error: "Failed to generate certificate preview" });
    }
  });

  app.post("/api/admin/remind-trainers-reports", requireRole("admin"), async (req, res) => {
    try {
      const trainers = await storage.getUsersByRole("trainer");
      const trainersWithEmail = trainers.filter(t => t.email);
      const adminId = req.session.userId;

      const subject = "Reminder: Update Your Trainee Reports";
      const emailPromises = trainersWithEmail.map(trainer => {
        const html = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">The Metrics</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px;">Trainer Reminder</p>
            </div>
            <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
              <h2 style="color: #1e293b; margin-top: 0;">Hi ${trainer.name},</h2>
              <p>This is a friendly reminder to <strong>update your trainee reports</strong>. Keeping reports up-to-date helps us track progress and ensure every trainee gets the support they need.</p>
              <div style="background-color: #fef3c7; padding: 16px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
                <p style="margin: 0; font-weight: bold; color: #92400e;">Action Required</p>
                <ul style="margin: 8px 0 0; padding-left: 20px; color: #92400e;">
                  <li>Review all your assigned trainees</li>
                  <li>Update their training progress and status</li>
                  <li>Add notes on any challenges or achievements</li>
                </ul>
              </div>
              <p style="margin-top: 24px; text-align: center;">
                <a href="https://www.portermetricscareeronboarding.com/staff-login" style="background-color: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Go to Trainer Dashboard</a>
              </p>
              <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">Thank you for your dedication to our trainees' success!</p>
            </div>
            <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
              <p>&copy; ${new Date().getFullYear()} The Metrics. All rights reserved.</p>
            </div>
          </body>
          </html>
        `;

        return sendEmail({ to: trainer.email, subject, html }).then(success => {
          storage.createEmailLog({
            recipientEmail: trainer.email,
            recipientName: trainer.name,
            emailType: "trainer_report_reminder",
            subject,
            sentBy: adminId,
            status: success ? "sent" : "failed",
          }).catch(err => logger.error("Failed to log email:", err));
          return success;
        });
      });

      const results = await Promise.allSettled(emailPromises);
      const sent = results.filter(r => r.status === "fulfilled" && r.value === true).length;

      res.json({ success: true, sent });
    } catch (error) {
      logger.error("Failed to send trainer report reminders:", error);
      res.status(500).json({ error: "Failed to send reminders" });
    }
  });

  app.post("/api/admin/remind-trainers-followup", requireRole("admin"), async (req, res) => {
    try {
      const trainers = await storage.getUsersByRole("trainer");
      const trainersWithEmail = trainers.filter(t => t.email);
      const adminId = req.session.userId;

      const subject = "Reminder: Follow Up With Your Trainees";
      const emailPromises = trainersWithEmail.map(trainer => {
        const html = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">The Metrics</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px;">Trainer Follow-Up Reminder</p>
            </div>
            <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
              <h2 style="color: #1e293b; margin-top: 0;">Hi ${trainer.name},</h2>
              <p>We wanted to remind you to <strong>follow up with your trainees</strong> and send them any necessary training reminders. Consistent communication is key to successful onboarding!</p>
              <div style="background-color: #eff6ff; padding: 16px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2563eb;">
                <p style="margin: 0; font-weight: bold; color: #1e40af;">Please make sure to:</p>
                <ul style="margin: 8px 0 0; padding-left: 20px; color: #1e40af;">
                  <li>Check in with each of your assigned trainees</li>
                  <li>Send training session reminders for upcoming sessions</li>
                  <li>Address any questions or concerns they may have</li>
                  <li>Encourage trainees who may be falling behind</li>
                </ul>
              </div>
              <p style="margin-top: 24px; text-align: center;">
                <a href="https://www.portermetricscareeronboarding.com/staff-login" style="background-color: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Go to Trainer Dashboard</a>
              </p>
              <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">Your trainees count on your guidance. Thank you for being an amazing trainer!</p>
            </div>
            <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
              <p>&copy; ${new Date().getFullYear()} The Metrics. All rights reserved.</p>
            </div>
          </body>
          </html>
        `;

        return sendEmail({ to: trainer.email, subject, html }).then(success => {
          storage.createEmailLog({
            recipientEmail: trainer.email,
            recipientName: trainer.name,
            emailType: "trainer_followup_reminder",
            subject,
            sentBy: adminId,
            status: success ? "sent" : "failed",
          }).catch(err => logger.error("Failed to log email:", err));
          return success;
        });
      });

      const results = await Promise.allSettled(emailPromises);
      const sent = results.filter(r => r.status === "fulfilled" && r.value === true).length;

      res.json({ success: true, sent });
    } catch (error) {
      logger.error("Failed to send trainer follow-up reminders:", error);
      res.status(500).json({ error: "Failed to send reminders" });
    }
  });

  app.post("/api/admin/remind-referrers", requireRole("admin"), async (req, res) => {
    try {
      const referrers = await storage.getUsersByRole("referrer");
      const referrersWithEmail = referrers.filter(r => r.email);
      const adminId = req.session.userId;

      const subject = "Keep the Momentum Going! Refer More Talent to The Metrics";
      const emailPromises = referrersWithEmail.map(referrer => {
        const referralLink = referrer.referralCode
          ? `https://www.portermetricscareeronboarding.com/apply?ref=${referrer.referralCode}`
          : "https://www.portermetricscareeronboarding.com/apply";
        const referralCodeDisplay = referrer.referralCode || "N/A";

        const html = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">The Metrics</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px;">Referral Program</p>
            </div>
            <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
              <h2 style="color: #1e293b; margin-top: 0;">Hi ${referrer.name},</h2>
              <p>You're doing great as a referrer! We wanted to reach out and encourage you to <strong>keep referring talented individuals</strong> to The Metrics platform.</p>
              <p>Every referral you make helps grow our community and creates new opportunities for people around the world.</p>
              <div style="background-color: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #16a34a; text-align: center;">
                <p style="margin: 0; font-weight: bold; color: #15803d; font-size: 14px;">Your Referral Code</p>
                <p style="margin: 8px 0; font-size: 28px; font-weight: bold; font-family: monospace; color: #16a34a; letter-spacing: 2px;">${referralCodeDisplay}</p>
                <p style="margin: 8px 0 0; font-size: 13px; color: #6b7280;">Share this code with potential applicants</p>
              </div>
              <p style="margin-top: 24px; text-align: center;">
                <a href="${referralLink}" style="background-color: #16a34a; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Share Your Referral Link</a>
              </p>
              <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0; font-weight: bold; color: #334155;">Your Referral Link:</p>
                <p style="margin: 8px 0 0; word-break: break-all; color: #2563eb; font-size: 13px;">${referralLink}</p>
              </div>
              <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">Thank you for being a valued member of The Metrics community. Together, we're building something amazing!</p>
            </div>
            <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
              <p>&copy; ${new Date().getFullYear()} The Metrics. All rights reserved.</p>
            </div>
          </body>
          </html>
        `;

        return sendEmail({ to: referrer.email, subject, html }).then(success => {
          storage.createEmailLog({
            recipientEmail: referrer.email,
            recipientName: referrer.name,
            emailType: "referrer_motivation_reminder",
            subject,
            sentBy: adminId,
            status: success ? "sent" : "failed",
          }).catch(err => logger.error("Failed to log email:", err));
          return success;
        });
      });

      const results = await Promise.allSettled(emailPromises);
      const sent = results.filter(r => r.status === "fulfilled" && r.value === true).length;

      res.json({ success: true, sent });
    } catch (error) {
      logger.error("Failed to send referrer reminders:", error);
      res.status(500).json({ error: "Failed to send reminders" });
    }
  });

  app.get("/api/trainer-daily-records/trend", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const startDate = (req.query.startDate as string) || new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
      const endDate = (req.query.endDate as string) || new Date().toISOString().split("T")[0];
      const records = await storage.getTrainerDailyRecordsTrend(startDate, endDate);
      const trainers = await storage.getUsersByRole("trainer");
      const trainerMap = new Map(trainers.map(t => [t.id, t.name]));
      const byDate: Record<string, { date: string; totalDeposit: number; totalWithdrawal: number; recordCount: number; trainers: string[] }> = {};
      for (const r of records) {
        if (!byDate[r.date]) byDate[r.date] = { date: r.date, totalDeposit: 0, totalWithdrawal: 0, recordCount: 0, trainers: [] };
        byDate[r.date].totalDeposit += parseFloat(r.todayDeposit || "0");
        byDate[r.date].totalWithdrawal += parseFloat(r.todayWithdrawal || "0");
        byDate[r.date].recordCount++;
        const name = trainerMap.get(r.trainerId) || r.trainerId;
        if (!byDate[r.date].trainers.includes(name)) byDate[r.date].trainers.push(name);
      }
      const trend = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
      res.json({ trend, raw: records.map(r => ({ ...r, trainerName: trainerMap.get(r.trainerId) || r.trainerId })) });
    } catch (error) {
      logger.error("Failed to get trend data:", error);
      res.status(500).json({ error: "Failed to get trend" });
    }
  });

  app.post("/api/trainer-daily-records/bulk", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { records } = req.body;
      if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ error: "Records array is required" });
      const results = [];
      for (const record of records) {
        const existing = await storage.getTrainerDailyRecordByDate(record.trainerId, record.date);
        if (existing) {
          const updated = await storage.updateTrainerDailyRecord(existing.id, { todayDeposit: record.todayDeposit, todayWithdrawal: record.todayWithdrawal, notes: record.notes });
          results.push(updated);
        } else {
          const created = await storage.createTrainerDailyRecord({ ...record, createdBy: req.session.userId });
          results.push(created);
        }
      }
      res.json({ success: true, count: results.length, records: results });
    } catch (error) {
      logger.error("Failed to bulk create trainer daily records:", error);
      res.status(500).json({ error: "Failed to bulk create records" });
    }
  });

  app.get("/api/trainer-daily-records", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const records = await storage.getAllTrainerDailyRecords();
      res.json(records);
    } catch (error) {
      logger.error("Failed to get all trainer daily records:", error);
      res.status(500).json({ error: "Failed to get records" });
    }
  });

  app.get("/api/trainer-daily-records/:trainerId", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const records = await storage.getTrainerDailyRecords(req.params.trainerId as string);
      res.json(records);
    } catch (error) {
      logger.error("Failed to get trainer daily records:", error);
      res.status(500).json({ error: "Failed to get records" });
    }
  });

  app.post("/api/trainer-daily-records", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const existing = await storage.getTrainerDailyRecordByDate(req.body.trainerId, req.body.date);
      if (existing) {
        const updated = await storage.updateTrainerDailyRecord(existing.id, {
          todayDeposit: req.body.todayDeposit,
          todayWithdrawal: req.body.todayWithdrawal,
          notes: req.body.notes,
        });
        return res.json(updated);
      }
      const record = await storage.createTrainerDailyRecord({
        ...req.body,
        createdBy: req.session.userId,
      });
      res.json(record);
    } catch (error) {
      logger.error("Failed to create trainer daily record:", error);
      res.status(500).json({ error: "Failed to create record" });
    }
  });

  app.put("/api/trainer-daily-records/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const updated = await storage.updateTrainerDailyRecord(req.params.id as string, req.body);
      if (!updated) return res.status(404).json({ error: "Record not found" });
      res.json(updated);
    } catch (error) {
      logger.error("Failed to update trainer daily record:", error);
      res.status(500).json({ error: "Failed to update record" });
    }
  });

  app.delete("/api/trainer-daily-records/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteTrainerDailyRecord(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete trainer daily record:", error);
      res.status(500).json({ error: "Failed to delete record" });
    }
  });

  app.get("/api/trainer-financial-stats", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const trainers = await storage.getUsersByRole("trainer");
      const allRecords = await storage.getAllTrainerDailyRecords();
      const allApps = await storage.getAllApplications();

      const stats = trainers.map(trainer => {
        const records = allRecords.filter(r => r.trainerId === trainer.id);
        const assignedTrainees = allApps.filter(a => a.trainerId === trainer.id && (a.status === "accepted" || a.status === "started_working")).length;
        const trainerFee = assignedTrainees * 10;

        const totalDeposit = records.reduce((sum, r) => sum + parseFloat(r.todayDeposit || "0"), 0);
        const totalWithdrawal = records.reduce((sum, r) => sum + parseFloat(r.todayWithdrawal || "0"), 0);
        const sales = totalDeposit - totalWithdrawal - trainerFee;

        return {
          trainerId: trainer.id,
          trainerName: trainer.name,
          trainerEmail: trainer.email,
          assignedTrainees,
          trainerFee,
          totalDeposit,
          totalWithdrawal,
          sales,
          recordCount: records.length,
          latestRecord: records[0] || null,
        };
      });

      res.json(stats);
    } catch (error) {
      logger.error("Failed to get trainer financial stats:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  app.post("/api/admin/manual-assignments", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (_req: any, file: any, cb: any) => {
          const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
          if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
          } else {
            cb(new Error('Invalid file type.'));
          }
        },
      });

      upload.single("resume")(req, res, async (err: any) => {
        if (err) {
          return res.status(400).json({ error: err.message });
        }

        const { traineeName, traineeEmail, traineePhone, trainerId, adminNote } = req.body;
        if (!traineeName || !traineeEmail || !traineePhone || !trainerId) {
          return res.status(400).json({ error: "Trainee name, email, phone, and trainer are required" });
        }

        let resumeUrl: string | null = null;
        const file = (req as any).file;
        if (file) {
          try {
            const { ObjectStorageService } = await import("../replit_integrations/object_storage/objectStorage");
            const objectStorageService = new ObjectStorageService();
            const uploadURL = await objectStorageService.getObjectEntityUploadURL();
            const uploadRes = await fetch(uploadURL, {
              method: "PUT",
              headers: { "Content-Type": file.mimetype },
              body: file.buffer,
            });
            if (uploadRes.ok) {
              const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
              resumeUrl = `${req.protocol}://${req.get("host")}${objectPath}`;
            }
          } catch (uploadErr) {
            logger.error("Failed to upload resume", uploadErr);
          }
        }

        const assignment = await storage.createManualTraineeAssignment({
          traineeName,
          traineeEmail,
          traineePhone,
          resumeUrl,
          trainerId,
          adminNote: adminNote || null,
          assignedBy: req.session.userId,
        });

        const trainer = await storage.getUser(trainerId);
        if (trainer) {
          const { sendManualAssignmentEmail } = await import("../email");
          sendManualAssignmentEmail(
            trainer.email,
            trainer.name,
            traineeName,
            traineeEmail,
            traineePhone,
            resumeUrl,
            adminNote || null
          ).catch(err => logger.error("Failed to send manual assignment email", err));
        }

        res.json({ success: true, assignment });
      });
    } catch (error) {
      logger.error("Failed to create manual assignment:", error);
      res.status(500).json({ error: "Failed to create manual assignment" });
    }
  });

  app.get("/api/admin/manual-assignments", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const assignments = await storage.getAllManualTraineeAssignments();
      const allUsers = await storage.getAllUsers();
      const enriched = assignments.map(a => ({
        ...a,
        trainerName: allUsers.find(u => u.id === a.trainerId)?.name || "Unknown",
        assignedByName: allUsers.find(u => u.id === a.assignedBy)?.name || "System",
      }));
      res.json(enriched);
    } catch (error) {
      logger.error("Failed to get manual assignments:", error);
      res.status(500).json({ error: "Failed to get manual assignments" });
    }
  });

  app.get("/api/trainer/manual-assignments", requireAuth, async (req, res) => {
    try {
      const assignments = await storage.getManualTraineeAssignmentsByTrainer(req.session.userId!);
      res.json(assignments);
    } catch (error) {
      logger.error("Failed to get trainer manual assignments:", error);
      res.status(500).json({ error: "Failed to get trainer manual assignments" });
    }
  });

  app.patch("/api/admin/manual-assignments/:id/status", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { status } = req.body;
      if (!status || !["pending", "contacted", "in_progress", "completed"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      const assignmentId = req.params.id as string;
      const updated = await storage.updateManualTraineeAssignmentStatus(assignmentId, status);
      if (!updated) return res.status(404).json({ error: "Assignment not found" });
      res.json(updated);
    } catch (error) {
      logger.error("Failed to update manual assignment status:", error);
      res.status(500).json({ error: "Failed to update status" });
    }
  });

  app.patch("/api/trainer/manual-assignments/:id/status", requireAuth, async (req, res) => {
    try {
      const { status } = req.body;
      if (!status || !["pending", "contacted", "in_progress", "completed"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      const assignmentId = req.params.id as string;
      const assignments = await storage.getManualTraineeAssignmentsByTrainer(req.session.userId!);
      const owns = assignments.find(a => a.id === assignmentId);
      if (!owns) return res.status(403).json({ error: "Not your assignment" });
      const updated = await storage.updateManualTraineeAssignmentStatus(assignmentId, status);
      res.json(updated);
    } catch (error) {
      logger.error("Failed to update manual assignment status:", error);
      res.status(500).json({ error: "Failed to update status" });
    }
  });

  app.delete("/api/admin/manual-assignments/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const assignmentId = req.params.id as string;
      const deleted = await storage.deleteManualTraineeAssignment(assignmentId);
      if (!deleted) return res.status(404).json({ error: "Assignment not found" });
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete manual assignment:", error);
      res.status(500).json({ error: "Failed to delete manual assignment" });
    }
  });
}
