import type { Express } from "express";
import { requireAuth, requireRole, logActivity, getOpenAIClient, DEFAULT_WELCOME_EMAIL_BODY, DEFAULT_WELCOME_EMAIL_SUBJECT } from "./helpers";
import { storage } from "../storage";
import { db } from "../db";
import { logger } from "../logger";
import { z } from "zod";
import OpenAI from "openai";
import { insertSmtpAccountSchema, leads, leadFolders } from "@shared/schema";
import { eq, sql, inArray } from "drizzle-orm";
import { sendEmail, officialEmailWrapper, sendBulkEmail, clearSmtpTransporterCache } from "../email";

const activeBatchJobs = new Map<string, { cancel: boolean; jobType: string; startedAt: number; progress: { sent: number; failed: number; total: number; currentBatch: number; totalBatches: number; status: string; skippedDuplicate?: number; results?: Array<{ email: string; name: string; status: string; error?: string }> } }>();

export function registerEmailLeadRoutes(app: Express) {
  app.get("/api/email-templates", requireAuth, async (req, res) => {
    try {
      const { trainerId } = req.query;
      if (trainerId) {
        const templates = await storage.getEmailTemplatesByTrainer(trainerId as string);
        res.json(templates);
      } else {
        const templates = await storage.getAllEmailTemplates();
        res.json(templates);
      }
    } catch (error) {
      logger.error("Error fetching email templates:", error);
      res.status(500).json({ error: "Failed to fetch email templates" });
    }
  });

  app.get("/api/email-templates/:id", requireAuth, async (req, res) => {
    try {
      const template = await storage.getEmailTemplate(req.params.id as string);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch template" });
    }
  });

  app.post("/api/email-templates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const template = await storage.createEmailTemplate(req.body);
      res.status(201).json(template);
      logActivity("Created email template", "EmailTemplate", undefined, "Created new email template", req.session.userId);
    } catch (error) {
      logger.error("Error creating email template:", error);
      res.status(500).json({ error: "Failed to create template" });
    }
  });

  app.put("/api/email-templates/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const template = await storage.updateEmailTemplate(req.params.id as string, req.body);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template);
    } catch (error) {
      logger.error("Error updating email template:", error);
      res.status(500).json({ error: "Failed to update template" });
    }
  });

  app.delete("/api/email-templates/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteEmailTemplate(req.params.id as string);
      logActivity("Deleted email template", "EmailTemplate", req.params.id as string, "Deleted email template", req.session.userId);
      res.json({ success: true, message: "Template deleted successfully" });
    } catch (error) {
      logger.error("Error deleting email template:", error);
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  app.post("/api/email-templates/:id/send", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { recipientEmail, recipientName, variables } = req.body;
      const template = await storage.getEmailTemplate(req.params.id as string);
      
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }

      // Replace variables in subject and body
      let subject = template.subject;
      let body = template.body;
      
      // Replace common variables
      const replacements: Record<string, string> = {
        '{{recipientName}}': recipientName || '',
        '{{name}}': recipientName || '',
        ...variables
      };
      
      for (const [key, value] of Object.entries(replacements)) {
        subject = subject.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
        body = body.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
      }

      // Send the email
      const { sendCustomEmail } = await import('../email');
      const sent = await sendCustomEmail(recipientEmail, subject, body);
      
      if (sent) {
        res.json({ success: true, message: "Email sent successfully" });
        logActivity("Sent email template", "EmailTemplate", req.params.id as string, "Sent email from template", req.session.userId);
      } else {
        res.status(500).json({ error: "Failed to send email" });
      }
    } catch (error) {
      logger.error("Error sending template email:", error);
      res.status(500).json({ error: "Failed to send email" });
    }
  });

  app.get("/api/email-logs/recipient/:email", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const logs = await storage.getEmailLogsByRecipient(req.params.email as string);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch email logs" });
    }
  });

  app.post("/api/bulk-email", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { subject, message, filter, sentBy, smtpAccountId: rawSmtpId, companyName, companyTagline, companyEmail } = req.body;
      
      if (!subject || !message) {
        return res.status(400).json({ error: "Subject and message are required" });
      }

      const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
      if (smtpAccountId !== undefined && isNaN(smtpAccountId)) {
        return res.status(400).json({ error: "Invalid smtpAccountId" });
      }

      // Get all applicants based on filter
      const allApps = await storage.getAllApplications();
      const allUsers = await storage.getAllUsers();
      
      let filteredApps = allApps;
      if (filter === "accepted") {
        filteredApps = allApps.filter(app => app.status === "accepted");
      } else if (filter === "under_review") {
        filteredApps = allApps.filter(app => app.status === "under_review");
      } else if (filter === "training_scheduled") {
        filteredApps = allApps.filter(app => app.trainingStatus === "scheduled" || app.trainingStatus === "confirmed");
      }

      const recipients = filteredApps.map(app => {
        const user = allUsers.find(u => u.id === app.applicantId);
        return user ? { email: user.email, name: user.name } : null;
      }).filter(Boolean) as { email: string; name: string }[];

      const branding = (companyName || companyTagline || companyEmail) ? { companyName, companyTagline, companyEmail } : undefined;
      const htmlTemplate = (name: string) => officialEmailWrapper(`
          <h1 style="color: #2563eb; margin: 0 0 16px;">Hello ${name},</h1>
          <div style="color: #333; line-height: 1.6;">${message.replace(/\n/g, '<br>')}</div>
      `, '#0f172a', 'en', branding);

      sendBulkEmail(recipients, subject, htmlTemplate, sentBy, smtpAccountId).catch(err => logger.error("Email send failed:", err));
      res.json({ success: true, total: recipients.length });
      logActivity("Sent bulk email", "Email", undefined, `Bulk email "${subject}" sent to ${recipients.length} recipients`, req.session.userId);
    } catch (error) {
      logger.error("Bulk email error:", error);
      res.status(500).json({ error: "Failed to send bulk email" });
    }
  });

  app.get("/api/admin-email-templates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const adminId = req.query.adminId as string;
      if (adminId) {
        const templates = await storage.getAdminEmailTemplatesByAdmin(adminId);
        return res.json(templates);
      }
      const allTemplates = await storage.getAllAdminEmailTemplates();
      res.json(allTemplates);
    } catch (error) {
      logger.error("Error fetching admin email templates:", error);
      res.status(500).json({ error: "Failed to fetch templates" });
    }
  });

  app.get("/api/admin-email-templates/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const template = await storage.getAdminEmailTemplate(req.params.id as string);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch template" });
    }
  });

  app.post("/api/admin-email-templates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const template = await storage.createAdminEmailTemplate(req.body);
      res.json(template);
    } catch (error) {
      logger.error("Error creating admin email template:", error);
      res.status(500).json({ error: "Failed to create template" });
    }
  });

  app.put("/api/admin-email-templates/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const template = await storage.updateAdminEmailTemplate(req.params.id as string, req.body);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      res.json(template);
    } catch (error) {
      logger.error("Error updating admin email template:", error);
      res.status(500).json({ error: "Failed to update template" });
    }
  });

  app.delete("/api/admin-email-templates/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteAdminEmailTemplate(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  app.post("/api/admin-email-templates/:id/send", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { recipientEmail, recipientName, variables } = req.body;
      const template = await storage.getAdminEmailTemplate(req.params.id as string);
      
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }

      let subject = template.subject;
      let body = template.body;
      
      const replacements: Record<string, string> = {
        '{{recipientName}}': recipientName || '',
        '{{name}}': recipientName || '',
        '{{email}}': recipientEmail || '',
        ...variables
      };
      
      for (const [key, value] of Object.entries(replacements)) {
        subject = subject.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
        body = body.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
      }

      const { sendCustomEmail } = await import('../email');
      const sent = await sendCustomEmail(recipientEmail, subject, body);
      
      if (sent) {
        res.json({ success: true, message: "Email sent successfully" });
      } else {
        res.status(500).json({ error: "Failed to send email" });
      }
    } catch (error) {
      logger.error("Error sending admin template email:", error);
      res.status(500).json({ error: "Failed to send email" });
    }
  });

  app.post("/api/leads/capture", async (req, res) => {
    try {
      const { email, name, source, country } = req.body;
      
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }
      
      // Check if lead already exists
      const existingLead = await storage.getLeadByEmail(email.toLowerCase());
      if (existingLead) {
        return res.json({ success: true, message: "Already subscribed", lead: existingLead });
      }
      
      const lead = await storage.createLead({
        email: email.toLowerCase(),
        name: name || null,
        source: source || "tiktok",
        country: country || null,
        status: "new",
      });
      
      res.json({ success: true, message: "Successfully subscribed", lead });
    } catch (error) {
      logger.error("Failed to capture lead:", error);
      res.status(500).json({ error: "Failed to subscribe" });
    }
  });

  app.get("/api/leads", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      if (req.query.paginated === "true") {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const result = await storage.getLeadsPaginated({
          page,
          limit,
          status: req.query.status as string,
          search: req.query.search as string,
          folderId: req.query.folderId as string,
        });
        return res.json(result);
      }
      const { status } = req.query;
      let leadsList;
      if (status && typeof status === "string") {
        leadsList = await storage.getLeadsByStatus(status);
      } else {
        leadsList = await storage.getAllLeads();
      }

      const allApps = await storage.getAllApplications();
      const allUsers = await storage.getAllUsers();

      const userEmailMap = new Map<string, { userId: string; name: string }>();
      const userPhoneMap = new Map<string, { userId: string; name: string }>();
      for (const u of allUsers) {
        if (u.email) userEmailMap.set(u.email.toLowerCase(), { userId: u.id, name: u.name });
        if (u.phone) userPhoneMap.set(u.phone, { userId: u.id, name: u.name });
      }

      const appByApplicantId = new Map<string, typeof allApps[0]>();
      for (const app of allApps) {
        appByApplicantId.set(app.applicantId, app);
      }

      const enrichedLeads = leadsList.map(lead => {
        const matchedUser = userEmailMap.get(lead.email.toLowerCase());
        let applicationMatch = null;

        if (matchedUser) {
          const app = appByApplicantId.get(matchedUser.userId);
          if (app) {
            applicationMatch = {
              applicationId: app.id,
              status: app.status,
              appliedAt: app.appliedAt,
              applicantName: (app as any).applicantName || matchedUser.name,
            };
          }
        }

        if (!applicationMatch && lead.phone) {
          const phoneUser = userPhoneMap.get(lead.phone);
          if (phoneUser) {
            const app = appByApplicantId.get(phoneUser.userId);
            if (app) {
              applicationMatch = {
                applicationId: app.id,
                status: app.status,
                appliedAt: app.appliedAt,
                applicantName: (app as any).applicantName || phoneUser.name,
              };
            }
          }
        }

        return { ...lead, applicationMatch };
      });

      res.json(enrichedLeads);
    } catch (error) {
      logger.error("Failed to fetch leads:", error);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  app.get("/api/leads/export", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { status, source, country, tag } = req.query;
      let allLeads = await storage.getAllLeads();
      
      if (status && status !== 'all') {
        allLeads = allLeads.filter(l => l.status === status);
      }
      if (source && source !== 'all') {
        allLeads = allLeads.filter(l => l.source === source);
      }
      if (country && country !== 'all') {
        allLeads = allLeads.filter(l => l.country?.toLowerCase().includes((country as string).toLowerCase()));
      }
      if (tag) {
        const tagLeads = await storage.getLeadsByTag(tag as string);
        const tagLeadIds = new Set(tagLeads.map(l => l.id));
        allLeads = allLeads.filter(l => tagLeadIds.has(l.id));
      }
      
      let csv = "Name,Email,Source,Status,Country,Score,Date\n";
      for (const lead of allLeads) {
        const name = (lead.name || "").replace(/,/g, " ");
        const cntry = (lead.country || "").replace(/,/g, " ");
        const src = (lead.source || "unknown").replace(/,/g, " ");
        csv += `${name},${lead.email},${src},${lead.status},${cntry},${lead.score || 0},${new Date(lead.createdAt).toISOString().split("T")[0]}\n`;
      }
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=leads_export_${new Date().toISOString().split('T')[0]}.csv`);
      res.send(csv);
    } catch (error) {
      res.status(500).json({ error: "Failed to export leads" });
    }
  });

  app.get("/api/leads/analytics", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const allLeads = await storage.getAllLeads();
      const trackingStats = await storage.getEmailTrackingStats();
      
      const byStatus: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      const byCountry: Record<string, number> = {};
      const byMonth: Record<string, number> = {};
      
      for (const lead of allLeads) {
        byStatus[lead.status] = (byStatus[lead.status] || 0) + 1;
        const src = lead.source || 'unknown';
        bySource[src] = (bySource[src] || 0) + 1;
        const ctry = lead.country || 'Unknown';
        byCountry[ctry] = (byCountry[ctry] || 0) + 1;
        const month = new Date(lead.createdAt).toISOString().slice(0, 7);
        byMonth[month] = (byMonth[month] || 0) + 1;
      }
      
      const conversionRate = allLeads.length > 0 
        ? ((allLeads.filter(l => l.status === 'converted').length / allLeads.length) * 100).toFixed(1) 
        : '0';
      
      res.json({
        total: allLeads.length,
        byStatus,
        bySource,
        byCountry,
        byMonth,
        conversionRate,
        emailTracking: trackingStats,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  app.post("/api/leads/merge", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { updates } = req.body;
      let merged = 0;
      for (const update of updates) {
        const existing = await storage.getLeadByEmail(update.email);
        if (existing) {
          const updateData: Partial<{ name: string; country: string; source: string }> = {};
          if (update.name && !existing.name) updateData.name = update.name;
          if (update.country && !existing.country) updateData.country = update.country;
          if (update.source) updateData.source = update.source;
          if (Object.keys(updateData).length > 0) {
            await storage.updateLead(existing.id, updateData);
            merged++;
          }
        }
      }
      res.json({ success: true, merged });
    } catch (error) {
      res.status(500).json({ error: "Failed to merge leads" });
    }
  });

  app.get("/api/leads/download-all", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const allLeads = await storage.getAllLeads();
      const allUsers = await storage.getAllUsers();
      const applicants = allUsers.filter(u => u.role === "applicant");
      
      const rows: string[] = ["Name,Email,Source,Status,Country,Date Added"];
      
      for (const lead of allLeads) {
        const name = (lead.name || "").replace(/,/g, " ");
        const country = (lead.country || "").replace(/,/g, " ");
        rows.push(`${name},${lead.email},lead - ${(lead.source || "unknown").replace(/,/g, " ")},${lead.status},${country},${new Date(lead.createdAt).toISOString().split("T")[0]}`);
      }
      
      for (const user of applicants) {
        const existingLead = allLeads.find(l => l.email.toLowerCase() === user.email.toLowerCase());
        if (existingLead) continue;
        
        const name = (user.name || "").replace(/,/g, " ");
        const country = (user.country || "").replace(/,/g, " ");
        const app = await storage.getApplicationByApplicantId(user.id);
        const status = app ? app.status : "no_application";
        rows.push(`${name},${user.email},applicant,${status},${country},${new Date(user.createdAt).toISOString().split("T")[0]}`);
      }
      
      const csv = rows.join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="all_emails_${new Date().toISOString().split("T")[0]}.csv"`);
      res.send(csv);
    } catch (error) {
      logger.error("Failed to generate email export:", error);
      res.status(500).json({ error: "Failed to generate export" });
    }
  });

  app.get("/api/email-folders", requireAuth, requireRole("admin"), async (_req, res) => {
    try {
      const folders = await storage.getAllEmailFolders();
      res.json(folders);
    } catch (error) {
      logger.error("Failed to get email folders:", error);
      res.status(500).json({ error: "Failed to get email folders" });
    }
  });

  app.post("/api/email-folders", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { name, description, color } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "Folder name is required" });
      const folder = await storage.createEmailFolder({ name: name.trim(), description: description || null, color: color || "#3b82f6" });
      res.json(folder);
    } catch (error) {
      logger.error("Failed to create email folder:", error);
      res.status(500).json({ error: "Failed to create email folder" });
    }
  });

  app.put("/api/email-folders/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { name, description, color } = req.body;
      const folder = await storage.updateEmailFolder(req.params.id as string, { name, description, color });
      if (!folder) return res.status(404).json({ error: "Folder not found" });
      res.json(folder);
    } catch (error) {
      logger.error("Failed to update email folder:", error);
      res.status(500).json({ error: "Failed to update email folder" });
    }
  });

  app.delete("/api/email-folders/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const folder = await storage.getEmailFolder(req.params.id as string);
      if (!folder) return res.status(404).json({ error: "Folder not found" });
      if (folder.isSystem) return res.status(400).json({ error: "Cannot delete system folders" });
      await storage.deleteEmailFolder(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete email folder:", error);
      res.status(500).json({ error: "Failed to delete email folder" });
    }
  });

  app.get("/api/email-logs", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { folderId, archived, limit, offset, search } = req.query;
      let emails: any[];
      let total = 0;

      if (archived === "true") {
        const result = await storage.getArchivedEmails(Number(limit) || 50, Number(offset) || 0);
        emails = result.emails;
        total = result.total;
      } else if (folderId) {
        emails = await storage.getEmailLogsByFolder(folderId as string, Number(limit) || 100);
        total = emails.length;
      } else {
        emails = await storage.getAllEmailLogs(Number(limit) || 100);
        total = emails.length;
      }

      if (search) {
        const searchStr = (search as string).toLowerCase();
        emails = emails.filter((e: any) =>
          e.recipientEmail?.toLowerCase().includes(searchStr) ||
          e.recipientName?.toLowerCase().includes(searchStr) ||
          e.subject?.toLowerCase().includes(searchStr)
        );
        total = emails.length;
      }

      res.json({ emails, total });
    } catch (error) {
      logger.error("Failed to get email logs:", error);
      res.status(500).json({ error: "Failed to get email logs" });
    }
  });

  app.post("/api/email-logs/move", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { emailIds, folderId } = req.body;
      if (!emailIds || !Array.isArray(emailIds)) return res.status(400).json({ error: "Email IDs required" });
      let moved = 0;
      for (const id of emailIds) {
        const result = await storage.moveEmailToFolder(id, folderId || null);
        if (result) moved++;
      }
      await storage.updateEmailFolderCounts();
      res.json({ success: true, moved });
    } catch (error) {
      logger.error("Failed to move emails:", error);
      res.status(500).json({ error: "Failed to move emails" });
    }
  });

  app.post("/api/email-logs/archive", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { emailIds } = req.body;
      if (!emailIds || !Array.isArray(emailIds)) return res.status(400).json({ error: "Email IDs required" });
      const archived = await storage.archiveEmailsByIds(emailIds);
      res.json({ success: true, archived });
    } catch (error) {
      logger.error("Failed to archive emails:", error);
      res.status(500).json({ error: "Failed to archive emails" });
    }
  });

  app.post("/api/email-logs/:id/unarchive", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const email = await storage.unarchiveEmail(req.params.id as string);
      if (!email) return res.status(404).json({ error: "Email not found" });
      res.json(email);
    } catch (error) {
      logger.error("Failed to unarchive email:", error);
      res.status(500).json({ error: "Failed to unarchive email" });
    }
  });

  app.get("/api/lead-folders", requireRole("admin"), async (req, res) => {
    try {
      const folders = await storage.getAllLeadFolders();
      res.json(folders);
    } catch (error) {
      logger.error("Failed to get lead folders:", error);
      res.status(500).json({ error: "Failed to get folders" });
    }
  });

  app.post("/api/lead-folders", requireRole("admin"), async (req, res) => {
    try {
      const { name, description, color } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "Folder name is required" });
      const folder = await storage.createLeadFolder({ name: name.trim(), description: description || null, color: color || "#3b82f6" });
      res.json(folder);
    } catch (error) {
      logger.error("Failed to create lead folder:", error);
      res.status(500).json({ error: "Failed to create folder" });
    }
  });

  app.patch("/api/lead-folders/:id", requireRole("admin"), async (req, res) => {
    try {
      const { name, description, color } = req.body;
      const updated = await storage.updateLeadFolder(req.params.id as string, { name, description, color });
      if (!updated) return res.status(404).json({ error: "Folder not found" });
      res.json(updated);
    } catch (error) {
      logger.error("Failed to update lead folder:", error);
      res.status(500).json({ error: "Failed to update folder" });
    }
  });

  app.delete("/api/lead-folders/:id", requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteLeadFolder(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete lead folder:", error);
      res.status(500).json({ error: "Failed to delete folder" });
    }
  });

  app.post("/api/leads/auto-classify", requireRole("admin"), async (req, res) => {
    try {
      const { classifyBy } = req.body;
      if (!["status", "source", "time", "upload"].includes(classifyBy)) {
        return res.status(400).json({ error: "Invalid classification type. Use 'status', 'source', 'time', or 'upload'." });
      }

      const allLeads = await storage.getAllLeads();
      const existingFolders = await storage.getAllLeadFolders();
      const existingFolderNames = new Map(existingFolders.map(f => [f.name.toLowerCase(), f.id]));

      const statusColors: Record<string, string> = {
        "new": "#3b82f6", "contacted": "#f59e0b", "converted": "#10b981", "unsubscribed": "#ef4444",
      };
      const sourceColors = ["#6366f1", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6", "#06b6d4", "#84cc16", "#e11d48"];
      const timeColors = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#f97316", "#6366f1", "#14b8a6", "#e11d48", "#84cc16", "#64748b"];
      const uploadColors = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#f97316", "#6366f1", "#14b8a6", "#e11d48", "#84cc16", "#64748b"];
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

      const groups: Record<string, string[]> = {};
      for (const lead of allLeads) {
        let groupName: string;
        if (classifyBy === "status") {
          groupName = (lead.status || "new").charAt(0).toUpperCase() + (lead.status || "new").slice(1);
        } else if (classifyBy === "source") {
          groupName = lead.source ? lead.source.charAt(0).toUpperCase() + lead.source.slice(1) : "Unknown Source";
        } else if (classifyBy === "upload") {
          const batch = lead.uploadBatch;
          groupName = batch ? `Upload #${batch}` : "Manual / No Upload";
        } else {
          const date = new Date(lead.createdAt);
          groupName = isNaN(date.getTime()) ? "Unknown Date" : `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
        }
        if (!groups[groupName]) groups[groupName] = [];
        groups[groupName].push(lead.id);
      }

      let foldersCreated = 0;
      let leadsClassified = 0;
      let colorIndex = 0;

      await db.transaction(async (tx) => {
        for (const [groupName, leadIds] of Object.entries(groups)) {
          let folderId = existingFolderNames.get(groupName.toLowerCase());

          if (!folderId) {
            let color: string;
            if (classifyBy === "status") {
              color = statusColors[groupName.toLowerCase()] || "#64748b";
            } else if (classifyBy === "source") {
              color = sourceColors[colorIndex % sourceColors.length];
            } else if (classifyBy === "upload") {
              color = uploadColors[colorIndex % uploadColors.length];
            } else {
              color = timeColors[colorIndex % timeColors.length];
            }
            colorIndex++;

            const [folder] = await tx.insert(leadFolders).values({
              name: groupName,
              description: `Auto-classified by ${classifyBy}`,
              color,
            }).returning();
            folderId = folder.id;
            foldersCreated++;
          }

          await tx.update(leads).set({ folderId }).where(inArray(leads.id, leadIds));
          leadsClassified += leadIds.length;

          const [countResult] = await tx.select({ count: sql<number>`count(*)` }).from(leads).where(eq(leads.folderId, folderId));
          await tx.update(leadFolders).set({ leadCount: Number(countResult?.count || 0) }).where(eq(leadFolders.id, folderId));
        }

        for (const folder of existingFolders) {
          const [countResult] = await tx.select({ count: sql<number>`count(*)` }).from(leads).where(eq(leads.folderId, folder.id));
          await tx.update(leadFolders).set({ leadCount: Number(countResult?.count || 0) }).where(eq(leadFolders.id, folder.id));
        }
      });

      res.json({
        success: true,
        foldersCreated,
        leadsClassified,
        groups: Object.keys(groups).length,
        message: `Created ${foldersCreated} new folders and classified ${leadsClassified} leads into ${Object.keys(groups).length} groups by ${classifyBy}.`,
      });
    } catch (error) {
      logger.error("Failed to auto-classify leads:", error);
      res.status(500).json({ error: "Failed to auto-classify leads" });
    }
  });

  app.get("/api/lead-tags", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const tags = await storage.getAllLeadTags();
      res.json(tags);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tags" });
    }
  });

  app.post("/api/lead-tags", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const tag = await storage.createLeadTag(req.body);
      res.json(tag);
    } catch (error: any) {
      if (error.message?.includes("unique")) {
        return res.status(400).json({ error: "Tag name already exists" });
      }
      res.status(500).json({ error: "Failed to create tag" });
    }
  });

  app.delete("/api/lead-tags/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteLeadTag(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete tag" });
    }
  });

  app.post("/api/leads/:leadId/tags/:tagId", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.assignTagToLead(req.params.leadId as string, req.params.tagId as string);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to assign tag" });
    }
  });

  app.delete("/api/leads/:leadId/tags/:tagId", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.removeTagFromLead(req.params.leadId as string, req.params.tagId as string);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to remove tag" });
    }
  });

  app.get("/api/leads/:leadId/tags", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const tags = await storage.getTagsForLead(req.params.leadId as string);
      res.json(tags);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tags for lead" });
    }
  });

  app.get("/api/track/open/:trackingId", async (req, res) => {
    try {
      const trackingId = req.params.trackingId as string;
      const parts = trackingId.split("_");
      const leadId = parts[0] || null;
      const emailLogId = parts[1] || undefined;
      
      await storage.createEmailTracking({
        leadId,
        emailLogId,
        type: 'open',
        userAgent: req.headers['user-agent'] || undefined,
        ipAddress: req.ip || undefined,
      });
    } catch (e) {
    }
    
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.send(gif);
  });

  app.get("/api/track/click/:trackingId", async (req, res) => {
    try {
      const trackingId = req.params.trackingId as string;
      const url = req.query.url as string;
      const parts = trackingId.split("_");
      const leadId = parts[0] || null;
      const emailLogId = parts[1] || undefined;
      
      await storage.createEmailTracking({
        leadId,
        emailLogId,
        type: 'click',
        url,
        userAgent: req.headers['user-agent'] || undefined,
        ipAddress: req.ip || undefined,
      });
      
      if (url) {
        return res.redirect(url);
      }
    } catch (e) {}
    res.redirect('/');
  });

  app.get("/api/email-tracking/stats", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const stats = await storage.getEmailTrackingStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tracking stats" });
    }
  });

  app.get("/api/email-tracking/lead/:leadId", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const tracking = await storage.getEmailTrackingByLead(req.params.leadId as string);
      res.json(tracking);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tracking data" });
    }
  });

  app.get("/api/scheduled-emails", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const emails = await storage.getScheduledEmails();
      res.json(emails);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch scheduled emails" });
    }
  });

  app.post("/api/scheduled-emails", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const email = await storage.createScheduledEmail(req.body);
      res.json(email);
    } catch (error) {
      res.status(500).json({ error: "Failed to schedule email" });
    }
  });

  app.delete("/api/scheduled-emails/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteScheduledEmail(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete scheduled email" });
    }
  });

  app.patch("/api/scheduled-emails/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const updated = await storage.updateScheduledEmail(req.params.id as string, req.body);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update scheduled email" });
    }
  });

  app.post("/api/leads/:id/score", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { score } = req.body;
      const lead = await storage.updateLead(req.params.id as string, { score });
      res.json(lead);
    } catch (error) {
      res.status(500).json({ error: "Failed to update score" });
    }
  });

  app.patch("/api/leads/bulk-folder", requireRole("admin"), async (req, res) => {
    try {
      const { leadIds, folderId } = req.body;
      if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
        return res.status(400).json({ error: "No leads selected" });
      }

      await db.transaction(async (tx) => {
        const affectedFolderIds = new Set<string>();
        const movingLeads = await tx.select({ folderId: leads.folderId }).from(leads).where(inArray(leads.id, leadIds));
        for (const l of movingLeads) {
          if (l.folderId) affectedFolderIds.add(l.folderId);
        }
        if (folderId) affectedFolderIds.add(folderId);

        await tx.update(leads).set({ folderId: folderId || null }).where(inArray(leads.id, leadIds));

        for (const fId of Array.from(affectedFolderIds)) {
          const [countResult] = await tx.select({ count: sql<number>`count(*)` }).from(leads).where(eq(leads.folderId, fId));
          await tx.update(leadFolders).set({ leadCount: Number(countResult?.count || 0) }).where(eq(leadFolders.id, fId));
        }
      });

      res.json({ success: true, moved: leadIds.length, message: `Moved ${leadIds.length} leads to ${folderId ? "folder" : "unfiled"}` });
    } catch (error) {
      logger.error("Failed to bulk move leads:", error);
      res.status(500).json({ error: "Failed to move leads to folder" });
    }
  });

  app.patch("/api/leads/bulk-status", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { leadIds, status } = req.body;
      if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
        return res.status(400).json({ error: "No leads selected" });
      }
      const validStatuses = ["new", "contacted", "converted", "unsubscribed"];
      if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      let updated = 0;
      for (const leadId of leadIds) {
        try {
          await storage.updateLead(leadId, { status });
          updated++;
        } catch (e) {
          logger.error(`Failed to update lead ${leadId} status:`, e);
        }
      }
      res.json({ success: true, updated, message: `${updated} leads moved to "${status}"` });
    } catch (error) {
      logger.error("Failed to bulk update lead status:", error);
      res.status(500).json({ error: "Failed to update leads" });
    }
  });

  app.patch("/api/leads/bulk-viewed", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { leadIds } = req.body;
      if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
        return res.status(400).json({ error: "No leads selected" });
      }
      const now = new Date();
      let updated = 0;
      for (const leadId of leadIds) {
        try {
          await storage.updateLead(leadId, { viewedAt: now });
          updated++;
        } catch (e) {
          logger.error(`Failed to mark lead ${leadId} as viewed:`, e);
        }
      }
      res.json({ success: true, updated, message: `${updated} leads marked as viewed` });
    } catch (error) {
      logger.error("Failed to bulk mark leads as viewed:", error);
      res.status(500).json({ error: "Failed to mark leads as viewed" });
    }
  });

  app.get("/api/leads/welcome-email-settings", requireAuth, requireRole("admin"), async (_req, res) => {
    try {
      const enabledSetting = await storage.getAppSetting("lead_welcome_email_enabled");
      const subjectSetting = await storage.getAppSetting("lead_welcome_email_subject");
      const bodySetting = await storage.getAppSetting("lead_welcome_email_body");
      res.json({
        enabled: enabledSetting?.value === "true",
        subject: subjectSetting?.value || DEFAULT_WELCOME_EMAIL_SUBJECT,
        body: bodySetting?.value || DEFAULT_WELCOME_EMAIL_BODY,
      });
    } catch (error) {
      logger.error("Failed to get welcome email settings:", error);
      res.status(500).json({ error: "Failed to get settings" });
    }
  });

  app.post("/api/leads/welcome-email-settings", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { enabled, subject, body } = req.body;
      await storage.upsertAppSetting("lead_welcome_email_enabled", enabled ? "true" : "false", "leads");
      await storage.upsertAppSetting("lead_welcome_email_subject", subject || "", "leads");
      await storage.upsertAppSetting("lead_welcome_email_body", body || "", "leads");
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to update welcome email settings:", error);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  app.get("/api/leads/email-logs", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { leadId, status, emailType, search, limit, offset } = req.query;
      const result = await storage.getLeadEmailLogs({
        leadId: leadId as string | undefined,
        status: status as string | undefined,
        emailType: emailType as string | undefined,
        search: search as string | undefined,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json(result);
    } catch (error) {
      logger.error("Failed to fetch lead email logs:", error);
      res.status(500).json({ error: "Failed to fetch lead email logs" });
    }
  });

  app.get("/api/leads/active-jobs", requireAuth, requireRole("admin"), (_req, res) => {
    const jobs: Array<{ jobId: string; jobType: string; progress: any; startedAt: number }> = [];
    activeBatchJobs.forEach((job, jobId) => {
      jobs.push({ jobId, jobType: job.jobType, progress: job.progress, startedAt: job.startedAt });
    });
    res.json({ jobs });
  });

  app.post("/api/leads/send-welcome-email", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { leadIds, sequential } = req.body;
      if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
        return res.status(400).json({ error: "No leads selected" });
      }
      const subjectSetting = await storage.getAppSetting("lead_welcome_email_subject");
      const bodySetting = await storage.getAppSetting("lead_welcome_email_body");
      const subject = subjectSetting?.value || DEFAULT_WELCOME_EMAIL_SUBJECT;
      const bodyTemplate = bodySetting?.value || DEFAULT_WELCOME_EMAIL_BODY;
      
      const fs = await import("fs");
      const path = await import("path");
      const pdfPath = path.join(process.cwd(), "server", "assets", "job_overview_earnings_guide.pdf");
      let pdfBuffer: Buffer | null = null;
      try {
        pdfBuffer = fs.readFileSync(pdfPath) as Buffer;
      } catch (e) {
        logger.error("Failed to read Job Overview PDF for lead welcome email:", e);
      }

      const dailyLimitSetting = await storage.getAppSetting("daily_email_send_limit");
      const dailyLimit = parseInt(dailyLimitSetting?.value || "400") || 400;
      const sentToday = await storage.getEmailsSentToday();
      const remainingToday = Math.max(0, dailyLimit - sentToday);
      if (remainingToday === 0) {
        return res.status(429).json({ error: `Daily email limit reached (${dailyLimit}). Try again tomorrow.` });
      }
      const cappedLeadIds = leadIds.slice(0, remainingToday);

      if (sequential) {
        const jobId = `welcome_${Date.now()}`;
        activeBatchJobs.set(jobId, {
          cancel: false,
          jobType: "welcome",
          startedAt: Date.now(),
          progress: { sent: 0, failed: 0, total: cappedLeadIds.length, currentBatch: 0, totalBatches: 1, status: "running", results: [] }
        });

        res.json({ success: true, jobId, total: cappedLeadIds.length, message: `Welcome email job started for ${cappedLeadIds.length} leads${cappedLeadIds.length < leadIds.length ? ` (capped from ${leadIds.length} due to daily limit)` : ""}` });

        const userId = req.session.userId;
        (async () => {
          const job = activeBatchJobs.get(jobId)!;
          for (let i = 0; i < cappedLeadIds.length; i++) {
            if (job.cancel) { job.progress.status = "cancelled"; break; }
            const leadId = cappedLeadIds[i];
            try {
              const lead = await storage.getLead(leadId);
              if (!lead) {
                job.progress.failed++;
                job.progress.results!.push({ email: "unknown", name: "unknown", status: "skipped", error: "Lead not found" });
                continue;
              }
              if (lead.unsubscribed) {
                job.progress.failed++;
                job.progress.results!.push({ email: lead.email, name: lead.name || "Unknown", status: "skipped", error: "Unsubscribed" });
                continue;
              }
              const personalizedBody = bodyTemplate.replace(/\{\{name\}\}/g, lead.name || "there").replace(/\{\{email\}\}/g, lead.email);
              const { officialEmailWrapper, sendEmail } = await import("../email");
              const htmlBody = officialEmailWrapper(personalizedBody.replace(/\n/g, "<br>"), subject);
              const attachments = pdfBuffer ? [{
                filename: "Affiliates_Portermetrics_Job_Overview_Earnings_Guide.pdf",
                content: pdfBuffer,
                contentType: "application/pdf"
              }] : undefined;
              await sendEmail({ to: lead.email, subject, html: htmlBody, attachments });
              job.progress.sent++;
              job.progress.results!.push({ email: lead.email, name: lead.name || "Unknown", status: "sent" });
              await storage.createEmailLog({
                recipientEmail: lead.email,
                recipientName: lead.name || undefined,
                emailType: "lead_welcome",
                subject,
                body: personalizedBody,
                status: "sent",
                leadId: lead.id,
                sentBy: userId,
              });
            } catch (e: any) {
              job.progress.failed++;
              const lead = await storage.getLead(leadId).catch(() => null);
              job.progress.results!.push({ email: lead?.email || "unknown", name: lead?.name || "unknown", status: "failed", error: e.message });
              if (lead) {
                await storage.createEmailLog({
                  recipientEmail: lead.email,
                  recipientName: lead.name || undefined,
                  emailType: "lead_welcome",
                  subject,
                  body: "",
                  status: "failed",
                  errorMessage: e.message,
                  leadId: lead.id,
                  sentBy: userId,
                });
              }
              logger.error(`Failed to send welcome email to lead ${leadId}:`, e);
            }
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
          }
          if (job.progress.status !== "cancelled") {
            job.progress.status = "completed";
          }
          logger.info(`Welcome email job ${jobId} finished`, job.progress);
          setTimeout(() => activeBatchJobs.delete(jobId), 30 * 60 * 1000);
        })();
      } else {
        let sent = 0;
        let failed = 0;
        const results: Array<{ leadId: string; email: string; name: string; status: string; error?: string }> = [];
        for (const leadId of cappedLeadIds) {
          try {
            const lead = await storage.getLead(leadId);
            if (!lead) continue;
            if (lead.unsubscribed) {
              failed++;
              results.push({ leadId, email: lead.email, name: lead.name || "Unknown", status: "skipped", error: "Unsubscribed" });
              continue;
            }
            const personalizedBody = bodyTemplate.replace(/\{\{name\}\}/g, lead.name || "there").replace(/\{\{email\}\}/g, lead.email);
            const { officialEmailWrapper, sendEmail } = await import("../email");
            const htmlBody = officialEmailWrapper(personalizedBody.replace(/\n/g, "<br>"), subject);
            const attachments = pdfBuffer ? [{
              filename: "Affiliates_Portermetrics_Job_Overview_Earnings_Guide.pdf",
              content: pdfBuffer,
              contentType: "application/pdf"
            }] : undefined;
            await sendEmail({ to: lead.email, subject, html: htmlBody, attachments });
            sent++;
            results.push({ leadId, email: lead.email, name: lead.name || "Unknown", status: "sent" });
            await storage.createEmailLog({
              recipientEmail: lead.email,
              recipientName: lead.name || undefined,
              emailType: "lead_welcome",
              subject,
              body: personalizedBody,
              status: "sent",
              leadId: lead.id,
              sentBy: req.session.userId,
            });
          } catch (e: any) {
            failed++;
            const lead = await storage.getLead(leadId).catch(() => null);
            results.push({ leadId, email: lead?.email || "unknown", name: lead?.name || "unknown", status: "failed", error: e.message });
            if (lead) {
              await storage.createEmailLog({
                recipientEmail: lead.email,
                recipientName: lead.name || undefined,
                emailType: "lead_welcome",
                subject,
                body: "",
                status: "failed",
                errorMessage: e.message,
                leadId: lead.id,
                sentBy: req.session.userId,
              });
            }
            logger.error(`Failed to send welcome email to lead ${leadId}:`, e);
          }
        }
        res.json({ success: true, sent, failed, total: cappedLeadIds.length, results, message: `Welcome email sent to ${sent} of ${cappedLeadIds.length} leads${failed > 0 ? `, ${failed} failed` : ""}` });
      }
    } catch (error) {
      logger.error("Failed to send welcome emails:", error);
      res.status(500).json({ error: "Failed to send welcome emails" });
    }
  });

  app.get("/api/leads/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const lead = await storage.getLead(req.params.id as string);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }
      res.json(lead);
    } catch (error) {
      logger.error("Failed to fetch lead:", error);
      res.status(500).json({ error: "Failed to fetch lead" });
    }
  });

  app.patch("/api/leads/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const lead = await storage.updateLead(req.params.id as string, req.body);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }
      res.json(lead);
    } catch (error) {
      logger.error("Failed to update lead:", error);
      res.status(500).json({ error: "Failed to update lead" });
    }
  });

  app.post("/api/leads/upload", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const multer = (await import("multer")).default;
      const ExcelJS = await import("exceljs");
      
      const upload = multer({ 
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (_req: any, file: any, cb: any) => {
          const allowed = [
            'text/csv',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/octet-stream'
          ];
          if (allowed.includes(file.mimetype) || file.originalname.match(/\.(csv|xlsx|xls)$/i)) {
            cb(null, true);
          } else {
            cb(new Error('Only CSV and Excel files are allowed'));
          }
        }
      });
      
      upload.single('file')(req, res, async (err: any) => {
        if (err) {
          return res.status(400).json({ error: err.message || "File upload failed" });
        }
        
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }
        
        try {
          const workbook = new ExcelJS.Workbook();
          const isCsv = req.file.originalname.match(/\.csv$/i);
          if (isCsv) {
            const { Readable } = await import("stream");
            await workbook.csv.read(Readable.from(req.file.buffer));
          } else {
            await workbook.xlsx.load(req.file.buffer as any);
          }
          const worksheet = workbook.worksheets[0];
          if (!worksheet || worksheet.rowCount === 0) {
            return res.status(400).json({ error: "File is empty or has no data rows" });
          }
          const headerRow = worksheet.getRow(1);
          const headers: string[] = [];
          headerRow.eachCell((cell, colNumber) => {
            headers[colNumber] = String(cell.value || '').trim();
          });
          const rows: any[] = [];
          worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            const obj: any = {};
            for (let colNumber = 1; colNumber <= headers.length; colNumber++) {
              const key = headers[colNumber];
              if (key) {
                const cell = row.getCell(colNumber);
                obj[key] = cell.value != null ? String(cell.value) : "";
              }
            }
            if (Object.values(obj).some(v => v !== "")) {
              rows.push(obj);
            }
          });
          
          if (rows.length === 0) {
            return res.status(400).json({ error: "File is empty or has no data rows" });
          }
          
          const lowerHeaders = Object.keys(rows[0]).map(h => h.toLowerCase().trim());
          const emailCol = lowerHeaders.find(h => h === 'email' || h === 'e-mail' || h === 'email address' || h === 'emailaddress');
          
          if (!emailCol) {
            return res.status(400).json({ 
              error: "No 'email' column found. File must have a column named 'email'.",
              columns: lowerHeaders
            });
          }
          
          const originalEmailCol = Object.keys(rows[0]).find(h => h.toLowerCase().trim() === emailCol);
          const nameCol = Object.keys(rows[0]).find(h => {
            const lower = h.toLowerCase().trim();
            return lower === 'name' || lower === 'full name' || lower === 'fullname' || lower === 'first name';
          });
          const countryCol = Object.keys(rows[0]).find(h => {
            const lower = h.toLowerCase().trim();
            return lower === 'country' || lower === 'location' || lower === 'region';
          });
          const jobCol = Object.keys(rows[0]).find(h => {
            const lower = h.toLowerCase().trim();
            return lower === 'job' || lower === 'job title' || lower === 'jobtitle' || lower === 'position' || lower === 'role' || lower === 'title' || lower === 'occupation';
          });
          
          const source = (req.body?.source as string) || "file_upload";
          const folderId = (req.body?.folderId as string) || null;
          const [maxBatchResult] = await db.select({ max: sql<number>`COALESCE(MAX(upload_batch), 0)` }).from(leads);
          const nextBatch = Number(maxBatchResult?.max || 0) + 1;
          let imported = 0;
          let updated = 0;
          let skipped = 0;
          let errors: string[] = [];
          let duplicateEmails: string[] = [];
          let invalidEmails: string[] = [];
          const importedLeadIds: string[] = [];
          
          for (const row of rows) {
            const email = String(row[originalEmailCol!] || "").trim().toLowerCase();
            if (!email || !email.includes("@")) {
              skipped++;
              if (email) invalidEmails.push(email);
              continue;
            }
            
            const existingLead = await storage.getLeadByEmail(email);
            if (existingLead) {
              const newName = nameCol ? String(row[nameCol] || "").trim() || null : null;
              const newCountry = countryCol ? String(row[countryCol] || "").trim() || null : null;
              const newJob = jobCol ? String(row[jobCol] || "").trim() || null : null;
              const updates: Record<string, any> = {};
              if (newName && !existingLead.name) updates.name = newName;
              if (newCountry && !existingLead.country) updates.country = newCountry;
              if (newJob && !existingLead.job) updates.job = newJob;
              if (Object.keys(updates).length > 0) {
                try {
                  await storage.updateLead(existingLead.id, updates);
                  duplicateEmails.push(email + " (filled missing info)");
                } catch (e: any) {
                  errors.push(`${email}: ${e.message}`);
                }
              } else {
                duplicateEmails.push(email);
              }
              skipped++;
              continue;
            }
            
            const existingApplicant = await storage.getUserByEmail(email);
            if (existingApplicant) {
              skipped++;
              duplicateEmails.push(email + " (applicant)");
              continue;
            }
            
            try {
              const newLead = await storage.createLead({
                email,
                name: nameCol ? String(row[nameCol] || "").trim() || null : null,
                country: countryCol ? String(row[countryCol] || "").trim() || null : null,
                job: jobCol ? String(row[jobCol] || "").trim() || null : null,
                source,
                status: "new",
                uploadBatch: nextBatch,
                folderId: folderId || undefined,
              });
              imported++;
              importedLeadIds.push(newLead.id);
            } catch (e: any) {
              errors.push(`${email}: ${e.message}`);
            }
          }
          
          let batchTagName = null;
          if (importedLeadIds.length > 0) {
            try {
              const now = new Date();
              const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
              const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
              batchTagName = `Upload ${dateStr} ${timeStr}`;
              const colors = ["#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#ec4899", "#10b981", "#ef4444", "#6366f1"];
              const randomColor = colors[Math.floor(Math.random() * colors.length)];
              const batchTag = await storage.createLeadTag({ name: batchTagName, color: randomColor });
              for (const leadId of importedLeadIds) {
                await storage.assignTagToLead(leadId, batchTag.id);
              }
            } catch (tagError) {
              logger.error("Failed to create batch tag:", tagError);
            }
          }
          
          if (folderId && importedLeadIds.length > 0) {
            try {
              await storage.updateLeadFolderCount(folderId);
            } catch (e) {
              logger.error("Failed to update folder count:", e);
            }
          }

          res.json({
            success: true,
            total: rows.length,
            imported,
            skipped,
            errors: errors.length,
            duplicateEmails,
            invalidEmails,
            batchTag: batchTagName,
            folderId,
            updated,
            message: `Imported ${imported} leads${folderId ? " into folder" : ""}${batchTagName ? ` (tagged as "${batchTagName}")` : ""}. ${updated > 0 ? `${updated} existing leads updated. ` : ""}${skipped} skipped (${duplicateEmails.length} duplicates, ${invalidEmails.length} invalid). ${errors.length} errors.`
          });
        } catch (parseError: any) {
          logger.error("Failed to parse uploaded file:", parseError);
          res.status(400).json({ error: "Failed to parse file. Please ensure it's a valid CSV or Excel file." });
        }
      });
    } catch (error) {
      logger.error("Lead upload error:", error);
      res.status(500).json({ error: "Failed to process file upload" });
    }
  });

  app.delete("/api/leads/bulk-delete", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { leadIds } = req.body as { leadIds: string[] };
      if (!leadIds || !Array.isArray(leadIds)) {
        return res.status(400).json({ error: "Invalid lead IDs" });
      }

      let deleted = 0;
      for (const id of leadIds) {
        try {
          await storage.deleteLead(id);
          deleted++;
        } catch { /* skip */ }
      }

      res.json({ success: true, deleted });
    } catch (error) {
      logger.error("Failed to bulk delete leads:", error);
      res.status(500).json({ error: "Failed to delete leads" });
    }
  });

  app.delete("/api/leads/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteLead(req.params.id as string);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete lead:", error);
      res.status(500).json({ error: "Failed to delete lead" });
    }
  });

  app.post("/api/leads/send-email", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },
      });

      upload.array("attachments", 5)(req, res, async (err: any) => {
        if (err) {
          return res.status(400).json({ error: err.message || "File upload failed" });
        }

        const { leadIds, subject, body, markAsContacted, fromEmail, fromName, folderId } = req.body;
        let parsedLeadIds: string[];
        try {
          parsedLeadIds = typeof leadIds === "string" ? JSON.parse(leadIds) : (leadIds || []);
        } catch {
          parsedLeadIds = [];
        }

        if (folderId && (!parsedLeadIds || parsedLeadIds.length === 0)) {
          const allLeads = await storage.getAllLeads();
          const folderLeads = folderId === "unfiled"
            ? allLeads.filter(l => !l.folderId)
            : allLeads.filter(l => l.folderId === folderId);
          parsedLeadIds = folderLeads.map(l => l.id);
        }

        if (!parsedLeadIds || !Array.isArray(parsedLeadIds) || parsedLeadIds.length === 0) {
          return res.status(400).json({ error: "No leads selected" });
        }

        if (!subject || !body) {
          return res.status(400).json({ error: "Subject and body are required" });
        }

        const { sendCustomEmail } = await import('../email');
        const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

        const files = (req as any).files as Express.Multer.File[] | undefined;
        if (files && files.length > 0) {
          for (const file of files) {
            attachments.push({
              filename: file.originalname,
              content: file.buffer,
              contentType: file.mimetype,
            });
          }
        }

        const skipDuplicates = req.body.skipDuplicates !== "false" && req.body.skipDuplicates !== false;

        const allLeadEmails: string[] = [];
        const leadMap = new Map<string, any>();
        for (const leadId of parsedLeadIds) {
          const lead = await storage.getLead(leadId);
          if (lead) {
            leadMap.set(leadId, lead);
            allLeadEmails.push(lead.email.toLowerCase());
          }
        }

        let duplicateEmails = new Set<string>();
        if (skipDuplicates && allLeadEmails.length > 0) {
          duplicateEmails = await storage.checkDuplicateEmails(allLeadEmails, subject);
        }

        let successCount = 0;
        let failCount = 0;
        let skippedUnsubscribed = 0;
        let skippedDuplicate = 0;
        const skippedDuplicateList: string[] = [];

        for (const leadId of parsedLeadIds) {
          const lead = leadMap.get(leadId);
          if (!lead) continue;
          if (lead.unsubscribed) {
            skippedUnsubscribed++;
            continue;
          }
          if (skipDuplicates && duplicateEmails.has(lead.email.toLowerCase())) {
            skippedDuplicate++;
            skippedDuplicateList.push(lead.email);
            continue;
          }
          try {
            const leadName = lead.name || "Valued Candidate";
            let personalizedBody = body
              .replace(/\{\{name\}\}/gi, leadName)
              .replace(/\{name\}/gi, leadName)
              .replace(/\{\{email\}\}/gi, lead.email)
              .replace(/\{email\}/gi, lead.email)
              .replace(/\{\{country\}\}/gi, lead.country || "")
              .replace(/\{country\}/gi, lead.country || "")
              .replace(/\{\{job\}\}/gi, lead.job || "")
              .replace(/\{job\}/gi, lead.job || "");

            let personalizedSubject = subject
              .replace(/\{\{name\}\}/gi, leadName)
              .replace(/\{name\}/gi, leadName)
              .replace(/\{\{email\}\}/gi, lead.email)
              .replace(/\{email\}/gi, lead.email)
              .replace(/\{\{country\}\}/gi, lead.country || "")
              .replace(/\{country\}/gi, lead.country || "")
              .replace(/\{\{job\}\}/gi, lead.job || "")
              .replace(/\{job\}/gi, lead.job || "");

            await sendCustomEmail(lead.email, personalizedSubject, personalizedBody, lead.name || undefined, attachments, fromEmail || undefined, fromName || undefined);
            successCount++;

            await storage.createEmailLog({
              recipientEmail: lead.email,
              recipientName: lead.name || undefined,
              emailType: "lead_campaign",
              subject: subject,
              body: personalizedBody,
              status: "sent",
              leadId: lead.id,
              sentBy: req.session.userId,
            });

            if (markAsContacted === "true" || markAsContacted === true) {
              await storage.updateLead(leadId, {
                status: "contacted",
                lastContactedAt: new Date()
              });
            }
          } catch (emailError) {
            logger.error(`Failed to send email to ${lead.email}:`, emailError);
            failCount++;
            if (lead) {
              await storage.createEmailLog({
                recipientEmail: lead.email,
                recipientName: lead.name || undefined,
                emailType: "lead_campaign",
                subject: subject,
                body: "",
                status: "failed",
                errorMessage: emailError instanceof Error ? emailError.message : String(emailError),
                leadId: lead.id,
                sentBy: req.session.userId,
              }).catch(() => {});
            }
          }
        }

        const parts = [`Sent ${successCount} emails`];
        if (attachments.length > 0) parts[0] += ` with ${attachments.length} attachment(s)`;
        if (failCount > 0) parts.push(`${failCount} failed`);
        if (skippedUnsubscribed > 0) parts.push(`${skippedUnsubscribed} skipped (unsubscribed)`);
        if (skippedDuplicate > 0) parts.push(`${skippedDuplicate} skipped (already received this email)`);

        res.json({
          success: true,
          sent: successCount,
          failed: failCount,
          skippedUnsubscribed,
          skippedDuplicate,
          skippedDuplicateList: skippedDuplicateList.slice(0, 20),
          message: parts.join(", ")
        });
      });
    } catch (error) {
      logger.error("Failed to send bulk email to leads:", error);
      res.status(500).json({ error: "Failed to send emails" });
    }
  });

  app.post("/api/leads/send-email-batch", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },
      });

      upload.array("attachments", 5)(req, res, async (err: any) => {
        if (err) {
          return res.status(400).json({ error: err.message || "File upload failed" });
        }

        const { leadIds, subject, body, markAsContacted, fromEmail, fromName, batchSize: batchSizeStr, delaySeconds: delayStr, folderId } = req.body;
        let parsedLeadIds: string[];
        try {
          parsedLeadIds = typeof leadIds === "string" ? JSON.parse(leadIds) : (leadIds || []);
        } catch {
          parsedLeadIds = [];
        }

        if (folderId && (!parsedLeadIds || parsedLeadIds.length === 0)) {
          const allLeads = await storage.getAllLeads();
          const folderLeads = folderId === "unfiled"
            ? allLeads.filter(l => !l.folderId)
            : allLeads.filter(l => l.folderId === folderId);
          parsedLeadIds = folderLeads.map(l => l.id);
        }

        if (!parsedLeadIds || !Array.isArray(parsedLeadIds) || parsedLeadIds.length === 0) {
          return res.status(400).json({ error: "No leads selected" });
        }

        if (!subject || !body) {
          return res.status(400).json({ error: "Subject and body are required" });
        }

        const skipDuplicates = req.body.skipDuplicates !== "false" && req.body.skipDuplicates !== false;
        const batchSize = Math.min(Math.max(parseInt(batchSizeStr) || 25, 5), 100);
        const delaySeconds = Math.min(Math.max(parseInt(delayStr) || 60, 10), 300);

        const { sendCustomEmail } = await import('../email');
        const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

        const files = (req as any).files as Express.Multer.File[] | undefined;
        if (files && files.length > 0) {
          for (const file of files) {
            attachments.push({
              filename: file.originalname,
              content: file.buffer,
              contentType: file.mimetype,
            });
          }
        }

        let duplicateEmails = new Set<string>();
        let leadEmailMap = new Map<string, string>();
        if (skipDuplicates) {
          const allLeadEmails: string[] = [];
          for (const leadId of parsedLeadIds) {
            const lead = await storage.getLead(leadId);
            if (lead) {
              allLeadEmails.push(lead.email.toLowerCase());
              leadEmailMap.set(leadId, lead.email.toLowerCase());
            }
          }
          if (allLeadEmails.length > 0) {
            duplicateEmails = await storage.checkDuplicateEmails(allLeadEmails, subject);
          }
        }

        const filteredLeadIds = skipDuplicates
          ? parsedLeadIds.filter(id => !duplicateEmails.has(leadEmailMap.get(id) || ""))
          : parsedLeadIds;

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const totalBatches = Math.ceil(filteredLeadIds.length / batchSize);
        const jobId = `batch_${Date.now()}`;

        const dailyLimitSetting = await storage.getAppSetting("daily_email_send_limit");
        const dailyLimit = parseInt(dailyLimitSetting?.value || "400") || 400;
        const sentToday = await storage.getEmailsSentToday();
        const remainingToday = Math.max(0, dailyLimit - sentToday);

        activeBatchJobs.set(jobId, {
          cancel: false,
          jobType: "batch",
          startedAt: Date.now(),
          progress: { sent: 0, failed: 0, total: filteredLeadIds.length, currentBatch: 0, totalBatches, status: "running", skippedDuplicate: 0, dailyLimitReached: false, pausedAt: 0, dailyLimit, sentToday } as any
        });

        const willPause = filteredLeadIds.length > remainingToday;
        res.json({
          success: true,
          jobId,
          total: filteredLeadIds.length,
          batchSize,
          totalBatches,
          delaySeconds,
          dailyLimit,
          sentToday,
          remainingToday,
          willPause,
          message: willPause
            ? `Batch email job started. ${remainingToday} of ${filteredLeadIds.length} emails will be sent today (daily limit: ${dailyLimit}). Remaining emails will auto-resume tomorrow.`
            : `Batch email job started. ${filteredLeadIds.length} emails will be sent in ${totalBatches} batches of ${batchSize}, with ${delaySeconds}s delay between batches.`
        });

        (async () => {
          const job = activeBatchJobs.get(jobId)!;

          const waitUntilMidnight = async (): Promise<boolean> => {
            const remaining = filteredLeadIds.length - (job.progress.sent + job.progress.failed + ((job.progress as any).skippedDuplicate || 0));
            const currentDailyLimit = parseInt((await storage.getAppSetting("daily_email_send_limit"))?.value || "400") || 400;
            (job.progress as any).dailyLimitReached = true;
            (job.progress as any).pausedAt = job.progress.sent + job.progress.failed;
            (job.progress as any).remainingForTomorrow = remaining;
            job.progress.status = "paused_daily_limit";
            logger.info(`Batch job ${jobId} paused: daily email limit (${currentDailyLimit}) reached. ${remaining} emails remaining for tomorrow.`);

            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(0, 5, 0, 0);
            const msUntilMidnight = tomorrow.getTime() - now.getTime();

            await new Promise(resolve => setTimeout(resolve, msUntilMidnight));

            if (job.cancel) {
              job.progress.status = "cancelled";
              return false;
            }

            job.progress.status = "running";
            (job.progress as any).dailyLimitReached = false;
            (job.progress as any).resumedAt = new Date().toISOString();
            logger.info(`Batch job ${jobId} resumed after daily limit reset.`);
            return true;
          };

          const checkAndWaitForLimit = async (): Promise<boolean> => {
            const currentSentToday = await storage.getEmailsSentToday();
            const currentDailyLimit = parseInt((await storage.getAppSetting("daily_email_send_limit"))?.value || "400") || 400;
            if (currentSentToday >= currentDailyLimit) {
              return await waitUntilMidnight();
            }
            return true;
          };

          for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            if (job.cancel) {
              job.progress.status = "cancelled";
              break;
            }

            const canContinue = await checkAndWaitForLimit();
            if (!canContinue) break;

            job.progress.currentBatch = batchIndex + 1;
            const batchLeadIds = filteredLeadIds.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);

            for (const leadId of batchLeadIds) {
              if (job.cancel) break;

              const canSend = await checkAndWaitForLimit();
              if (!canSend) break;

              const lead = await storage.getLead(leadId);
              if (!lead || lead.unsubscribed) {
                job.progress.failed++;
                continue;
              }

              if (skipDuplicates && duplicateEmails.has(lead.email.toLowerCase())) {
                (job.progress as any).skippedDuplicate = ((job.progress as any).skippedDuplicate || 0) + 1;
                continue;
              }

              try {
                const leadName = lead.name || "Valued Candidate";
                let personalizedBody = body
                  .replace(/\{\{name\}\}/gi, leadName)
                  .replace(/\{name\}/gi, leadName)
                  .replace(/\{\{email\}\}/gi, lead.email)
                  .replace(/\{email\}/gi, lead.email)
                  .replace(/\{\{country\}\}/gi, lead.country || "")
                  .replace(/\{country\}/gi, lead.country || "")
                  .replace(/\{\{job\}\}/gi, lead.job || "")
                  .replace(/\{job\}/gi, lead.job || "");

                let personalizedSubject = subject
                  .replace(/\{\{name\}\}/gi, leadName)
                  .replace(/\{name\}/gi, leadName);

                const unsubUrl = `${baseUrl}/unsubscribe?email=${encodeURIComponent(lead.email)}&id=${encodeURIComponent(lead.id)}`;
                personalizedBody = personalizedBody + `\n\n<p style="font-size: 11px; color: #94a3b8; margin-top: 30px; text-align: center;"><a href="${unsubUrl}" style="color: #94a3b8;">Unsubscribe</a></p>`;

                await sendCustomEmail(lead.email, personalizedSubject, personalizedBody, lead.name || undefined, attachments, fromEmail || undefined, fromName || undefined);
                job.progress.sent++;

                await storage.createEmailLog({
                  recipientEmail: lead.email,
                  recipientName: lead.name || undefined,
                  emailType: "lead_campaign_batch",
                  subject: subject,
                  body: personalizedBody,
                  status: "sent",
                  leadId: lead.id,
                  sentBy: req.session.userId,
                });

                if (markAsContacted === "true" || markAsContacted === true) {
                  await storage.updateLead(leadId, {
                    status: "contacted",
                    lastContactedAt: new Date()
                  });
                }

                await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
              } catch (emailError) {
                logger.error(`Batch email failed for ${lead.email}:`, emailError);
                job.progress.failed++;
                if (lead) {
                  await storage.createEmailLog({
                    recipientEmail: lead.email,
                    recipientName: lead.name || undefined,
                    emailType: "lead_campaign_batch",
                    subject: subject,
                    body: "",
                    status: "failed",
                    errorMessage: emailError instanceof Error ? emailError.message : String(emailError),
                    leadId: lead.id,
                    sentBy: req.session.userId,
                  }).catch(() => {});
                }
              }
            }

            if (job.cancel) {
              job.progress.status = "cancelled";
              break;
            }

            if (batchIndex < totalBatches - 1) {
              logger.info(`Batch ${batchIndex + 1}/${totalBatches} complete. Waiting ${delaySeconds}s...`, {
                sent: job.progress.sent,
                failed: job.progress.failed
              });
              await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
            }
          }

          if (job.progress.status !== "cancelled") {
            job.progress.status = "completed";
          }
          logger.info(`Batch email job ${jobId} finished`, job.progress);

          setTimeout(() => activeBatchJobs.delete(jobId), 30 * 60 * 1000);
        })();
      });
    } catch (error) {
      logger.error("Failed to start batch email:", error);
      res.status(500).json({ error: "Failed to start batch email" });
    }
  });

  app.get("/api/leads/batch-progress/:jobId", requireAuth, requireRole("admin"), (req, res) => {
    const job = activeBatchJobs.get(req.params.jobId as string);
    if (!job) {
      return res.status(404).json({ error: "Job not found or expired" });
    }
    res.json(job.progress);
  });

  app.post("/api/leads/batch-cancel/:jobId", requireAuth, requireRole("admin"), (req, res) => {
    const job = activeBatchJobs.get(req.params.jobId as string);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    job.cancel = true;
    res.json({ success: true, message: "Batch job cancellation requested" });
  });

  app.get("/api/email/daily-stats", requireAuth, requireRole("admin"), async (_req, res) => {
    try {
      const sentToday = await storage.getEmailsSentToday();
      const dailyLimitSetting = await storage.getAppSetting("daily_email_send_limit");
      const dailyLimit = parseInt(dailyLimitSetting?.value || "400") || 400;
      res.json({ sentToday, dailyLimit, remaining: Math.max(0, dailyLimit - sentToday) });
    } catch (error) {
      logger.error("Failed to get daily email stats:", error);
      res.status(500).json({ error: "Failed to get daily email stats" });
    }
  });

  app.get("/api/unsubscribe", async (req, res) => {
    try {
      const { email, id } = req.query as { email?: string; id?: string };
      if (!email || !id) {
        return res.status(400).json({ error: "Invalid unsubscribe link" });
      }

      const lead = await storage.getLead(id);
      if (lead && lead.email === email) {
        await storage.updateLead(id, {
          unsubscribed: true,
          unsubscribedAt: new Date()
        });
        return res.json({ success: true, message: "You have been unsubscribed successfully." });
      }

      return res.status(404).json({ error: "Could not process unsubscribe request" });
    } catch (error) {
      logger.error("Unsubscribe error:", error);
      res.status(500).json({ error: "Failed to process unsubscribe" });
    }
  });

  app.post("/api/leads/:id/resubscribe", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const lead = await storage.getLead(req.params.id as string);
      if (!lead) return res.status(404).json({ error: "Lead not found" });
      await storage.updateLead(req.params.id as string, {
        unsubscribed: false,
        unsubscribedAt: null as any
      });
      res.json({ success: true });
    } catch (error) {
      logger.error("Resubscribe error:", error);
      res.status(500).json({ error: "Failed to resubscribe" });
    }
  });

  app.get("/api/leads-validate-emails", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const allLeads = await storage.getAllLeads();
      const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
      const issues: Array<{
        id: string;
        email: string;
        name: string | null;
        problems: string[];
        suggestion: string | null;
      }> = [];

      for (const lead of allLeads) {
        const problems: string[] = [];
        let suggestion: string | null = null;
        const email = lead.email || "";

        if (!email) {
          problems.push("empty");
        } else {
          let working = email.trim();
          if (working !== email) problems.push("whitespace");

          // Detect and strip wrong prefixes like "mail-", "email-", "mailto:", "email:", "e-mail:"
          const prefixMatch = working.match(/^(mailto:|mail-|email-|email:|e-mail:|e-mail-)/i);
          if (prefixMatch) {
            problems.push("wrong_prefix");
            working = working.substring(prefixMatch[0].length).trim();
            suggestion = working.toLowerCase();
          }

          // Detect name mixed with email: "John Doe johndoe@gmail.com" or "johndoe@gmail.com John Doe"
          const emailInText = working.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
          if (emailInText && emailInText[0] !== working) {
            problems.push("name_mixed_with_email");
            suggestion = emailInText[1].toLowerCase();
          }

          // Detect extra text/characters around the email like "<email@test.com>" or "(email@test.com)"
          const bracketMatch = working.match(/[<\[(]?\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\s*[>\])]/);
          if (bracketMatch && !problems.includes("name_mixed_with_email")) {
            problems.push("extra_characters");
            suggestion = bracketMatch[1].toLowerCase();
          }

          const checkEmail = suggestion || working;

          if (/\s/.test(checkEmail) && !problems.includes("name_mixed_with_email")) {
            problems.push("contains_spaces");
            if (!suggestion) suggestion = checkEmail.replace(/\s/g, "");
          }

          if (/[,;]/.test(checkEmail)) {
            problems.push("multiple_emails");
            const first = checkEmail.split(/[,;]/)[0].trim();
            suggestion = first.toLowerCase();
          }

          if (checkEmail.includes("..")) {
            problems.push("double_dots");
            suggestion = (suggestion || checkEmail).replace(/\.{2,}/g, ".");
          }

          if (checkEmail !== checkEmail.toLowerCase() && !suggestion) {
            if (problems.length === 0) problems.push("mixed_case");
            suggestion = checkEmail.toLowerCase();
          }

          if (checkEmail.startsWith(".") || (checkEmail.includes("@") && checkEmail.split("@")[0].endsWith("."))) {
            problems.push("leading_trailing_dot");
            if (!suggestion) suggestion = checkEmail.replace(/^\.+/, "").replace(/\.+@/, "@");
          }

          const finalEmail = suggestion || checkEmail;
          const domain = finalEmail.split("@")[1];
          if (domain) {
            const commonTypos: Record<string, string> = {
              "gmial.com": "gmail.com", "gmal.com": "gmail.com", "gmaill.com": "gmail.com",
              "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmail.co": "gmail.com",
              "gmail.con": "gmail.com", "gmai.com": "gmail.com", "gmaul.com": "gmail.com",
              "gemail.com": "gmail.com", "g.mail.com": "gmail.com",
              "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com",
              "yahoo.con": "yahoo.com", "yhaoo.com": "yahoo.com",
              "hotmal.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmail.co": "hotmail.com",
              "hotmail.con": "hotmail.com", "hotmial.com": "hotmail.com",
              "outloo.com": "outlook.com", "outlok.com": "outlook.com", "outlook.co": "outlook.com",
              "outllok.com": "outlook.com",
              "iclod.com": "icloud.com", "icloud.co": "icloud.com",
            };
            if (commonTypos[domain.toLowerCase()]) {
              problems.push("typo_domain");
              suggestion = finalEmail.split("@")[0] + "@" + commonTypos[domain.toLowerCase()];
            }

            if (!domain.includes(".")) {
              problems.push("missing_tld");
            }
          }

          if (!finalEmail.includes("@")) {
            problems.push("missing_at");
          }

          // Final format check on the suggestion
          if (suggestion && !emailRegex.test(suggestion)) {
            // suggestion is still invalid, keep it but add invalid_format if not already
            if (!problems.includes("invalid_format")) {
              const rawCheck = suggestion || working;
              if (!emailRegex.test(rawCheck)) problems.push("invalid_format");
            }
          } else if (!suggestion && !emailRegex.test(working)) {
            problems.push("invalid_format");
          }

          // Ensure suggestion is lowercase
          if (suggestion) suggestion = suggestion.trim().toLowerCase();
        }

        if (problems.length > 0) {
          issues.push({
            id: lead.id,
            email: lead.email,
            name: lead.name,
            problems,
            suggestion
          });
        }
      }

      res.json({
        total: allLeads.length,
        valid: allLeads.length - issues.length,
        invalid: issues.length,
        issues
      });
    } catch (error) {
      logger.error("Failed to validate lead emails:", error);
      res.status(500).json({ error: "Failed to validate emails" });
    }
  });

  app.get("/api/leads-find-duplicates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const allLeads = await storage.getAllLeads();

      const emailMap = new Map<string, typeof allLeads>();
      const nameMap = new Map<string, typeof allLeads>();

      for (const lead of allLeads) {
        const emailKey = (lead.email || "").trim().toLowerCase();
        if (emailKey) {
          if (!emailMap.has(emailKey)) emailMap.set(emailKey, []);
          emailMap.get(emailKey)!.push(lead);
        }

        const nameKey = (lead.name || "").trim().toLowerCase().replace(/\s+/g, " ");
        if (nameKey && nameKey.length > 1) {
          if (!nameMap.has(nameKey)) nameMap.set(nameKey, []);
          nameMap.get(nameKey)!.push(lead);
        }
      }

      const duplicateGroups: Array<{
        key: string;
        matchType: "email" | "name";
        leads: Array<{ id: string; email: string; name: string | null; source: string | null; country: string | null; phone: string | null; score: number | null; notes: string | null; createdAt: string }>;
      }> = [];

      const seenIds = new Set<string>();

      for (const [email, group] of Array.from(emailMap)) {
        if (group.length > 1) {
          const leadIds = group.map((l: any) => l.id);
          leadIds.forEach((id: string) => seenIds.add(id));
          duplicateGroups.push({
            key: email,
            matchType: "email",
            leads: group.map((l: any) => ({
              id: l.id, email: l.email, name: l.name, source: l.source,
              country: l.country, phone: l.phone, score: l.score, notes: l.notes,
              createdAt: l.createdAt?.toISOString() || ""
            }))
          });
        }
      }

      for (const [name, group] of Array.from(nameMap)) {
        if (group.length > 1) {
          const allAlreadySeen = group.every((l: any) => seenIds.has(l.id));
          if (allAlreadySeen) continue;
          duplicateGroups.push({
            key: name,
            matchType: "name",
            leads: group.map((l: any) => ({
              id: l.id, email: l.email, name: l.name, source: l.source,
              country: l.country, phone: l.phone, score: l.score, notes: l.notes,
              createdAt: l.createdAt?.toISOString() || ""
            }))
          });
        }
      }

      res.json({
        totalGroups: duplicateGroups.length,
        totalDuplicateLeads: duplicateGroups.reduce((sum, g) => sum + g.leads.length, 0),
        groups: duplicateGroups
      });
    } catch (error) {
      logger.error("Failed to find duplicate leads:", error);
      res.status(500).json({ error: "Failed to find duplicates" });
    }
  });

  app.post("/api/leads-merge-duplicates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { groups } = req.body as { groups: Array<{ keepId: string; deleteIds: string[] }> };
      if (!groups || !Array.isArray(groups)) {
        return res.status(400).json({ error: "Invalid merge format" });
      }

      let merged = 0;
      let deleted = 0;
      let failed = 0;

      for (const group of groups) {
        try {
          const keepLead = await storage.getLead(group.keepId);
          if (!keepLead) { failed++; continue; }

          for (const deleteId of group.deleteIds) {
            const deleteLead = await storage.getLead(deleteId);
            if (!deleteLead) continue;

            const updateData: Record<string, any> = {};
            if (!keepLead.name && deleteLead.name) updateData.name = deleteLead.name;
            if (!keepLead.phone && deleteLead.phone) updateData.phone = deleteLead.phone;
            if (!keepLead.country && deleteLead.country) updateData.country = deleteLead.country;
            if (!keepLead.job && deleteLead.job) updateData.job = deleteLead.job;
            if (!keepLead.notes && deleteLead.notes) updateData.notes = deleteLead.notes;
            if ((!keepLead.score || keepLead.score === 0) && deleteLead.score && deleteLead.score > 0) updateData.score = deleteLead.score;

            if (Object.keys(updateData).length > 0) {
              await storage.updateLead(group.keepId, updateData);
            }

            await storage.deleteLead(deleteId);
            deleted++;
          }
          merged++;
        } catch (err) {
          logger.error("Failed to merge group:", err);
          failed++;
        }
      }

      res.json({ success: true, merged, deleted, failed });
    } catch (error) {
      logger.error("Failed to merge duplicate leads:", error);
      res.status(500).json({ error: "Failed to merge duplicates" });
    }
  });

  app.post("/api/leads-fix-emails", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { fixes } = req.body as { fixes: Array<{ id: string; newEmail: string }> };
      if (!fixes || !Array.isArray(fixes)) {
        return res.status(400).json({ error: "Invalid fixes format" });
      }

      const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
      let fixed = 0;
      let failed = 0;
      const errors: string[] = [];
      for (const fix of fixes) {
        const cleaned = (fix.newEmail || "").trim().toLowerCase();
        if (!cleaned || !emailRegex.test(cleaned)) {
          failed++;
          errors.push(`${fix.newEmail || "(empty)"} is not a valid email`);
          continue;
        }
        try {
          await storage.updateLead(fix.id, { email: cleaned });
          fixed++;
        } catch {
          failed++;
        }
      }

      res.json({ success: true, fixed, failed, errors: errors.length > 0 ? errors : undefined });
    } catch (error) {
      logger.error("Failed to fix lead emails:", error);
      res.status(500).json({ error: "Failed to fix emails" });
    }
  });

  app.post("/api/ai/generate-lead-message", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { selectedCount, senderName, referrerName } = req.body;
      
      const aiClient = getOpenAIClient();
      if (!aiClient) {
        return res.status(503).json({ error: "AI features are not configured" });
      }
      const completion = await aiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert email copywriter for The Metrics, a professional recruitment platform. Write detailed, polished outreach emails for the Remote Product Insights Upload Associate position.

Key details about the role to include naturally:
- Fully remote, work-from-home position
- Product Data role accessible to individuals from a wide range of professional backgrounds
- No prior experience required, all training is provided during onboarding
- All tasks completed online through a guided workflow system
- No selling, no purchasing, no customer outreach involved
- Focuses on structured data-related tasks completed from home at your own pace
- Competitive earnings with performance bonuses and flexible payout cycles

Email style guidelines:
- Write 300-500 words (detailed and comprehensive, NOT short/generic)
- Professional yet warm and personal tone
- Use proper paragraph structure with clear sections
- Include a personal introduction from the sender (use the sender name provided, or "a Trainer with The Metrics" by default)
- Mention that a Job Overview & Earnings Guide PDF is attached (even if it isn't, the admin can attach it)
- Include the onboarding link: https://www.portermetricscareeronboarding.com
- End with a warm sign-off including the sender's name and "Onboarding Team, The Metrics"
- IMPORTANT: Always use {name} as the recipient's name in greetings (e.g., "Dear {name}," or "Hi {name},"). This will be automatically replaced with the lead's actual name, or "Valued Candidate" if no name is on file. Never use generic "Dear Applicant" — always use {name}.
- You can also use {email}, {country}, and {job} placeholders where relevant — they will be auto-replaced.
- Do NOT use emojis excessively. At most 1-2 subtle ones like 📌 or 👉 for key links.

Return a JSON object with 'subject' and 'body' fields.`
          },
          {
            role: "user",
            content: `Generate a professional, detailed outreach email to send to ${selectedCount || "multiple"} leads.${senderName ? ` The sender's name is ${senderName}.` : ""}${referrerName ? ` The leads were referred by ${referrerName}.` : ""}\n\nReturn as JSON: { "subject": "...", "body": "..." }`
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.8,
      });
      
      const result = JSON.parse(completion.choices[0].message.content || "{}");
      res.json(result);
    } catch (error) {
      logger.error("Failed to generate lead message:", error);
      res.status(500).json({ error: "Failed to generate message" });
    }
  });

  app.post("/api/ai/generate-lead-templates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { selectedCount, senderName, referrerName } = req.body;

      const systemPrompt = `You are an expert email copywriter for The Metrics, a professional recruitment platform. Write detailed, polished recruitment emails for the Remote Product Insights Upload Associate position.

Key details about the role to weave in naturally:
- Fully remote, work-from-home position
- Product Data role accessible to individuals from a wide range of professional backgrounds
- No prior experience required — all training provided during onboarding
- All tasks completed online through a guided workflow system
- No selling, no purchasing, no customer outreach involved
- Structured data-related tasks completed from home at your own pace
- Competitive earnings with performance bonuses and flexible payout cycles
- Multiple supported payment methods and withdrawal options

Email style guidelines:
- Write 300-500 words (detailed and comprehensive, NOT short or generic)
- Professional yet warm and personal tone throughout
- Use proper paragraph structure with logical flow
- Include a personal introduction from the sender${senderName ? ` (the sender's name is ${senderName})` : " (use a generic trainer introduction)"}
${referrerName ? `- Mention the referral from ${referrerName} who reviewed their inquiry` : ""}
- Reference the Job Overview & Earnings Guide PDF as an attachment with reading tips
- Include the onboarding link: https://www.portermetricscareeronboarding.com
- End with a warm, professional sign-off including sender name and "Onboarding Team, The Metrics"
- IMPORTANT: Always use {name} as the recipient's name in greetings (e.g., "Dear {name}," or "Hi {name},"). This will be automatically replaced with the lead's actual name, or "Valued Candidate" if no name is on file. Never use generic "Dear Applicant" — always use {name}.
- You can also use {email}, {country}, and {job} placeholders where relevant — they will be auto-replaced.
- Minimal emoji use — at most 1-2 like 📌 or 👉 for key links
- Do NOT be generic or overly salesy. Sound like a real person writing a thoughtful email.

Return a JSON object with 'subject' and 'body' fields.`;

      const emailTypes = [
        { type: "recruitment", label: "Initial Outreach", prompt: "Write an initial recruitment outreach email. The tone should be welcoming and informative, as if reaching out after the lead showed interest through LinkedIn or online content. Introduce yourself, explain the role comprehensively, mention the attached PDF guide with specific reading recommendations, and provide the onboarding link. Make it feel like a personal, one-on-one communication." },
        { type: "follow_up", label: "Warm Follow-Up", prompt: "Write a warm follow-up email for leads who received a previous outreach but haven't responded. Reference the previous communication naturally, re-emphasize the key benefits of the role without repeating the same content, address common concerns (is it legitimate, how much can I earn, what exactly do I do), and gently encourage them to review the attached guide and begin onboarding." },
        { type: "detailed_role", label: "Detailed Role Explanation", prompt: "Write an email that goes deep into what a typical day looks like for a Remote Product Insights Upload Associate. Describe the workflow step by step, explain how tasks are assigned, how earnings accumulate, when payouts happen, and what support is available. This email should answer every question a curious lead might have before applying." },
        { type: "success_story", label: "Success Stories & Testimonials", prompt: "Write an email that shares success stories and testimonials from team members who started with no experience and are now thriving. Include realistic scenarios of people from different backgrounds (a stay-at-home parent, a college student, someone changing careers) who found success with The Metrics. Make it inspiring but believable." },
        { type: "urgency", label: "Limited Spots Available", prompt: "Write an urgency-driven email about limited training cohort spots. Explain that training groups are kept small for quality and that the current cohort is filling up. Create genuine urgency without being spammy. Mention the benefits of getting started sooner: earlier access to higher-tier tasks, established workflow, and building experience." },
      ];

      const results = await Promise.all(emailTypes.map(async (et) => {
        try {
          const templateClient = getOpenAIClient();
          if (!templateClient) throw new Error("OpenAI not configured");
          const completion = await templateClient.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `${et.prompt}\n\nThis will be sent to ${selectedCount || "multiple"} leads.\n\nReturn as JSON: { "subject": "...", "body": "..." }`
              }
            ],
            response_format: { type: "json_object" },
            temperature: 0.85,
          });
          const parsed = JSON.parse(completion.choices[0].message.content || "{}");
          return { type: et.type, label: et.label, subject: parsed.subject || "", body: parsed.body || "" };
        } catch (e) {
          return { type: et.type, label: et.label, subject: "", body: "", error: true };
        }
      }));

      res.json({ templates: results });
    } catch (error) {
      logger.error("Failed to generate lead templates:", error);
      res.status(500).json({ error: "Failed to generate templates" });
    }
  });

  app.post("/api/send-email-with-attachment", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (_req: any, file: any, cb: any) => {
          const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
          if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
          } else {
            cb(new Error('Invalid file type. Only PDF, JPG, JPEG, PNG, and GIF files are allowed.'));
          }
        },
      });

      upload.single("attachment")(req, res, async (err: any) => {
        if (err) {
          return res.status(400).json({ error: err.message });
        }

        const { to, subject, message, brandCompanyName, brandTagline, brandEmail, brandFooterName, smtpAccountId: rawSmtpId } = req.body;
        if (!to || !subject || !message) {
          return res.status(400).json({ error: "Missing required fields: to, subject, message" });
        }
        const smtpAccountId = rawSmtpId ? parseInt(String(rawSmtpId), 10) : undefined;
        if (smtpAccountId !== undefined && isNaN(smtpAccountId)) {
          return res.status(400).json({ error: "Invalid smtpAccountId" });
        }

        const emailContent = `
          <div style="font-size: 15px; color: #334155; line-height: 1.7;">
            ${message.replace(/\n/g, '<br>')}
          </div>
        `;
        const branding = (brandCompanyName || brandTagline || brandEmail || brandFooterName) ? {
          companyName: brandCompanyName || undefined,
          companyTagline: brandTagline || undefined,
          companyEmail: brandEmail || undefined,
          companyFooterName: brandFooterName || undefined,
        } : undefined;
        const html = officialEmailWrapper(emailContent, '#0f172a', 'en', branding);

        const senderName = brandCompanyName || undefined;
        const file = (req as any).file;
        if (file) {
          const attachments = [{
            filename: file.originalname,
            content: file.buffer,
            contentType: file.mimetype,
          }];
          sendEmail({ to, subject, html, attachments, fromName: senderName, smtpAccountId }).catch(err => logger.error("Email send failed:", err));
        } else {
          sendEmail({ to, subject, html, fromName: senderName, smtpAccountId }).catch(err => logger.error("Email send failed:", err));
        }
        return res.json({ success: true });
      });
    } catch (error: any) {
      logger.error("Failed to send email with attachment", error);
      res.status(500).json({ error: "Failed to send email" });
    }
  });

  app.get("/api/admin/smtp-accounts", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const accounts = await storage.getSmtpAccounts();
      const masked = accounts.map(a => ({
        ...a,
        password: a.password.length > 4 ? "****" + a.password.slice(-4) : "****",
      }));
      res.json(masked);
    } catch (error) {
      logger.error("Failed to fetch SMTP accounts:", error);
      res.status(500).json({ error: "Failed to fetch SMTP accounts" });
    }
  });

  app.post("/api/admin/smtp-accounts", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const data = insertSmtpAccountSchema.parse(req.body);
      const account = await storage.createSmtpAccount(data);
      logActivity("Created SMTP account", "SmtpAccount", String(account.id), `Created SMTP account: ${account.name}`, req.session.userId);
      res.json({ ...account, password: "****" + account.password.slice(-4) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Failed to create SMTP account:", error);
      res.status(500).json({ error: "Failed to create SMTP account" });
    }
  });

  app.put("/api/admin/smtp-accounts/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const existing = await storage.getSmtpAccount(id);
      if (!existing) return res.status(404).json({ error: "SMTP account not found" });
      const updateData = insertSmtpAccountSchema.partial().parse(req.body);
      if (updateData.password === undefined || updateData.password === "" || updateData.password?.startsWith("****")) {
        delete updateData.password;
      }
      const updated = await storage.updateSmtpAccount(id, updateData);
      if (!updated) return res.status(404).json({ error: "SMTP account not found" });
      clearSmtpTransporterCache(id);
      logActivity("Updated SMTP account", "SmtpAccount", String(id), `Updated SMTP account: ${updated.name}`, req.session.userId);
      res.json({ ...updated, password: updated.password.length > 4 ? "****" + updated.password.slice(-4) : "****" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Failed to update SMTP account:", error);
      res.status(500).json({ error: "Failed to update SMTP account" });
    }
  });

  app.delete("/api/admin/smtp-accounts/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const deleted = await storage.deleteSmtpAccount(id);
      if (!deleted) return res.status(404).json({ error: "SMTP account not found" });
      clearSmtpTransporterCache(id);
      logActivity("Deleted SMTP account", "SmtpAccount", String(id), `Deleted SMTP account`, req.session.userId);
      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete SMTP account:", error);
      res.status(500).json({ error: "Failed to delete SMTP account" });
    }
  });

  app.post("/api/admin/smtp-accounts/:id/test", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const account = await storage.getSmtpAccount(id);
      if (!account) return res.status(404).json({ error: "SMTP account not found" });

      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: account.host,
        port: account.port,
        secure: account.secure,
        auth: {
          user: account.username,
          pass: account.password,
        },
      });

      const adminUser = await storage.getUser(req.session.userId!);
      const testRecipient = adminUser?.email || account.fromEmail;

      await transporter.sendMail({
        from: `"${account.fromName}" <${account.fromEmail}>`,
        to: testRecipient,
        subject: `SMTP Test - ${account.name}`,
        html: `<p>This is a test email from your SMTP account <strong>${account.name}</strong> (${account.host}:${account.port}).</p><p>If you received this, the SMTP configuration is working correctly.</p>`,
      });

      logActivity("Tested SMTP account", "SmtpAccount", String(id), `Test email sent via ${account.name} to ${testRecipient}`, req.session.userId);
      res.json({ success: true, message: `Test email sent to ${testRecipient}` });
    } catch (error: any) {
      logger.error("SMTP test failed:", error);
      res.status(400).json({ error: `SMTP test failed: ${error.message || "Unknown error"}` });
    }
  });

  app.post("/api/admin/generate-email-reply", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const bodySchema = z.object({
        emailContent: z.string().min(1, "Email content is required").max(10000),
        context: z.string().max(2000).optional(),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const { emailContent, context } = parsed.data;

      const client = getOpenAIClient();
      if (!client) {
        return res.status(503).json({ error: "AI features are not configured. Please set up the OpenAI API key." });
      }

      const systemPrompt = `You are a professional email reply assistant for a recruitment and HR company. Your job is to read incoming emails and generate polished, ready-to-send reply suggestions.

Generate exactly 3 reply options in different tones:
1. **Formal** — Highly professional, corporate tone. Uses proper business language and structure.
2. **Friendly** — Warm and approachable but still professional. Shows genuine care.
3. **Concise** — Short, direct, and to the point. Gets the message across efficiently.

Rules:
- Each reply must be a complete, ready-to-send email body (no subject line in the body)
- Include appropriate greeting and professional closing
- Sign off with a generic "[Your Name]" and "[Company Name]" placeholder
- Be helpful, clear, and address all points from the incoming email
- Never make up facts or commitments — keep replies general where specifics are unknown
- If the email asks questions you can't answer, acknowledge them and offer to follow up

${context ? `Additional context from the admin: ${context}` : ''}

Respond in valid JSON format only, no markdown wrapping:
[
  { "tone": "Formal", "subject": "Re: ...", "body": "..." },
  { "tone": "Friendly", "subject": "Re: ...", "body": "..." },
  { "tone": "Concise", "subject": "Re: ...", "body": "..." }
]`;

      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Here is the incoming email I need to reply to:\n\n${emailContent}` }
        ],
        temperature: 0.7,
        max_tokens: 2000,
      });

      const content = completion.choices[0]?.message?.content || "";
      let replies;
      try {
        const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((r: any) => r.tone && r.body)) {
          replies = parsed.map((r: any) => ({ tone: String(r.tone), subject: String(r.subject || ""), body: String(r.body) }));
        } else {
          replies = [
            { tone: "Formal", subject: "Re: Your Email", body: content },
            { tone: "Friendly", subject: "Re: Your Email", body: content },
            { tone: "Concise", subject: "Re: Your Email", body: content },
          ];
        }
      } catch {
        replies = [
          { tone: "Formal", subject: "Re: Your Email", body: content },
          { tone: "Friendly", subject: "Re: Your Email", body: content },
          { tone: "Concise", subject: "Re: Your Email", body: content },
        ];
      }

      res.json({ success: true, replies });
    } catch (error) {
      logger.error("Failed to generate email reply:", error);
      res.status(500).json({ error: "Failed to generate reply suggestions" });
    }
  });
}
