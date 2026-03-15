import type { Express } from "express";
import { requireAuth, requireRole, sanitizeUser, logActivity, loginLimiter, registerLimiter, forgotPasswordLimiter } from "./helpers";
import { storage } from "../storage";
import { db } from "../db";
import { logger } from "../logger";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { insertUserSchema, User, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendEmail, officialEmailWrapper, sendTrainerSignupNotificationEmail, sendTrainerWelcomeEmail, sendPasswordResetEmail, sendStaffApprovalEmail } from "../email";

export function registerAuthUserRoutes(app: Express) {
  app.post("/api/users/register", registerLimiter, async (req, res) => {
    try {
      const { name, email, password, role, whatsappNumber, telegramHandle, affiliateCode, referralCode } = req.body;

      if (!name || !email || !password) {
        return res.status(400).json({ error: "Name, email, and password are required" });
      }

      if (role !== "trainer" && role !== "referrer") {
        return res.status(400).json({ error: "Only trainer and referrer registrations are allowed" });
      }

      const emailStr = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
        return res.status(400).json({ error: "Please provide a valid email address" });
      }

      if (role === "trainer" && !whatsappNumber) {
        return res.status(400).json({ error: "WhatsApp number is required for trainer registration" });
      }

      if (whatsappNumber) {
        const cleanWA = String(whatsappNumber).replace(/[\s\-()]/g, "");
        if (!/^\+?\d{7,15}$/.test(cleanWA)) {
          return res.status(400).json({ error: "Please provide a valid WhatsApp number with country code (e.g., +1234567890)" });
        }
      }

      const existingUser = await storage.getUserByEmail(emailStr);
      if (existingUser) {
        return res.status(400).json({ error: "User with this email already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      let finalReferralCode = referralCode;
      if (role === "referrer" && finalReferralCode) {
        const existingWithCode = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, finalReferralCode));
        if (existingWithCode.length > 0) {
          const { randomBytes } = await import("crypto");
          finalReferralCode = 'REF' + randomBytes(4).toString('hex').substring(0, 7).toUpperCase();
        }
      }

      const userData: any = {
        name,
        email: emailStr,
        password: hashedPassword,
        role,
        isApproved: "false",
        whatsappNumber: whatsappNumber || undefined,
        telegramHandle: telegramHandle || undefined,
        affiliateCode: affiliateCode || undefined,
        referralCode: finalReferralCode || undefined,
      };

      const user = await storage.createUser(userData);
      logActivity("User registered", "User", user.id, `New ${role} registration: ${name} (${email})`);

      if (role === "trainer") {
        sendTrainerWelcomeEmail(user.email, user.name).catch(logger.error);
        sendTrainerSignupNotificationEmail(user.name, user.email).catch(logger.error);
      }

      res.json(sanitizeUser(user));
    } catch (error) {
      logger.error("Public registration error:", error);
      res.status(500).json({ error: "Failed to create account" });
    }
  });

  app.post("/api/users", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const userData = insertUserSchema.parse(req.body);
      
      const existingUser = await storage.getUserByEmail(userData.email);
      if (existingUser) {
        return res.status(400).json({ error: "User with this email already exists" });
      }
      
      if (userData.password) {
        userData.password = await bcrypt.hash(userData.password, 12);
      }
      
      const user = await storage.createUser(userData);
      logActivity("Created user", "User", user.id, `Created ${userData.role} user: ${userData.name} (${userData.email})`, req.session.userId);
      
      // Send emails for trainer signups
      if (userData.role === "trainer") {
        sendTrainerWelcomeEmail(user.email, user.name).catch(logger.error);
        sendTrainerSignupNotificationEmail(user.name, user.email).catch(logger.error);
      }
      
      res.json(sanitizeUser(user));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  app.get("/api/users", requireAuth, requireRole("admin", "trainer", "referrer"), async (req, res) => {
    try {
      const { role } = req.query;
      if (role && typeof role === "string") {
        const users = await storage.getUsersByRole(role);
        return res.json(users.map(sanitizeUser));
      }
      const users = await storage.getAllUsers();
      res.json(users.map(sanitizeUser));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.get("/api/users/:id", requireAuth, requireRole("admin", "trainer", "referrer"), async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id as string);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json(sanitizeUser(user));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  app.get("/api/users/email/:email", requireAuth, requireRole("admin", "trainer"), async (req, res) => {
    try {
      const user = await storage.getUserByEmail(req.params.email as string);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json(sanitizeUser(user));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  app.post("/api/auth/forgot-password", forgotPasswordLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        // Don't reveal if user exists - just return success
        return res.json({ success: true, message: "If an account exists with this email, a password reset link has been sent." });
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Save token to user
      await storage.updateUser(user.id, {
        resetToken,
        resetTokenExpiry,
      });

      // Send email
      await sendPasswordResetEmail(user.email, user.name, resetToken);

      res.json({ success: true, message: "If an account exists with this email, a password reset link has been sent." });
    } catch (error) {
      logger.error("Forgot password error:", error);
      res.status(500).json({ error: "Failed to process request" });
    }
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) {
        return res.status(400).json({ error: "Token and new password are required" });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      // Find user with this token
      const user = await storage.getUserByResetToken(token);

      if (!user) {
        return res.status(400).json({ error: "Invalid or expired reset token" });
      }

      // Check if token is expired
      if (!user.resetTokenExpiry || new Date(user.resetTokenExpiry) < new Date()) {
        return res.status(400).json({ error: "Reset token has expired. Please request a new one." });
      }

      // Update password and clear token using dedicated method
      const hashedNewPassword = await bcrypt.hash(newPassword, 12);
      await storage.resetUserPassword(user.id, hashedNewPassword);

      res.json({ success: true, message: "Password has been reset successfully. You can now log in with your new password." });
    } catch (error) {
      logger.error("Reset password error:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  app.post("/api/admin/reset-password", requireRole("admin"), async (req, res) => {
    try {
      const { userId, newPassword } = req.body;
      
      if (!userId || !newPassword) {
        return res.status(400).json({ error: "User ID and new password are required" });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const hashedAdminResetPassword = await bcrypt.hash(newPassword, 12);
      const updatedUser = await storage.resetUserPassword(userId, hashedAdminResetPassword);
      
      res.json({ success: true, message: `Password for ${user.name} has been reset successfully.` });
      logActivity("Admin reset password", "User", userId, `Admin reset password for ${user.name}`, req.session.userId);
    } catch (error) {
      logger.error("Admin reset password error:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  app.post("/api/admin/invites", requireRole("admin"), async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: "A user with this email already exists" });
      }

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const invite = await storage.createAdminInvite({
        email,
        token,
        role: "admin",
        invitedBy: req.session.userId!,
        expiresAt,
      });

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const inviteLink = `${baseUrl}/admin/accept-invite?token=${token}`;

      await sendEmail({
        to: email,
        subject: "You've Been Invited as an Admin — The Metrics",
        html: officialEmailWrapper(`
          <h2 style="color: #1a1a2e; margin-bottom: 16px;">Admin Invitation</h2>
          <p>You have been invited to join <strong>The Metrics</strong> as an administrator.</p>
          <p>Click the button below to accept your invitation and set up your account. This link expires in 7 days.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${inviteLink}" style="background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Accept Invitation</a>
          </div>
          <p style="color: #666; font-size: 13px;">If the button doesn't work, copy and paste this link into your browser:<br/><a href="${inviteLink}">${inviteLink}</a></p>
        `),
      });

      res.json({ success: true, invite });
      logActivity("Admin invite sent", "User", invite.id, `Invited ${email} as admin`, req.session.userId);
    } catch (error) {
      logger.error("Admin invite error:", error);
      res.status(500).json({ error: "Failed to send admin invite" });
    }
  });

  app.get("/api/admin/invites", requireRole("admin"), async (req, res) => {
    try {
      const invites = await storage.getAllAdminInvites();
      res.json(invites);
    } catch (error) {
      logger.error("Get admin invites error:", error);
      res.status(500).json({ error: "Failed to fetch invites" });
    }
  });

  app.get("/api/invites/:token", async (req, res) => {
    try {
      const invite = await storage.getAdminInviteByToken(req.params.token);
      if (!invite) {
        return res.status(404).json({ error: "Invalid invitation link" });
      }
      if (invite.usedAt) {
        return res.status(400).json({ error: "This invitation has already been used" });
      }
      if (new Date() > invite.expiresAt) {
        return res.status(400).json({ error: "This invitation has expired" });
      }
      res.json({ email: invite.email, role: invite.role });
    } catch (error) {
      logger.error("Verify invite error:", error);
      res.status(500).json({ error: "Failed to verify invitation" });
    }
  });

  app.post("/api/invites/:token/accept", async (req, res) => {
    try {
      const { name, password } = req.body;
      if (!name || !password) {
        return res.status(400).json({ error: "Name and password are required" });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      const invite = await storage.getAdminInviteByToken(req.params.token);
      if (!invite) {
        return res.status(404).json({ error: "Invalid invitation link" });
      }
      if (invite.usedAt) {
        return res.status(400).json({ error: "This invitation has already been used" });
      }
      if (new Date() > invite.expiresAt) {
        return res.status(400).json({ error: "This invitation has expired" });
      }

      const existingUser = await storage.getUserByEmail(invite.email);
      if (existingUser) {
        return res.status(400).json({ error: "An account with this email already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const user = await storage.createUser({
        name,
        email: invite.email,
        password: hashedPassword,
        role: "admin",
        isApproved: "true",
      });

      await storage.markAdminInviteUsed(invite.id);

      req.session.userId = user.id;
      req.session.userRole = user.role;

      res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
      logActivity("Admin invite accepted", "User", user.id, `${name} (${invite.email}) accepted admin invite`, user.id);
    } catch (error) {
      logger.error("Accept invite error:", error);
      res.status(500).json({ error: "Failed to accept invitation" });
    }
  });

  app.patch("/api/users/:id", requireAuth, async (req, res) => {
    try {
      const isAdmin = req.session.userRole === "admin";
      const isSelf = req.session.userId === req.params.id;
      if (!isAdmin && !isSelf) {
        return res.status(403).json({ error: "You can only edit your own profile" });
      }

      const cleanedData: Record<string, any> = {};
      const optionalStringFields = ['phone', 'whatsappNumber', 'telegramHandle', 'affiliateCode', 'referralCode', 'bio', 'address', 'linkedinUrl', 'country', 'motivation', 'timezone'];
      const adminOnlyFields = ['role', 'isApproved', 'isCertified', 'referralCode', 'affiliateCode'];

      for (const [key, value] of Object.entries(req.body)) {
        if (adminOnlyFields.includes(key) && !isAdmin) {
          continue;
        }
        if (optionalStringFields.includes(key) && value === "") {
          cleanedData[key] = null;
        } else {
          cleanedData[key] = value;
        }
      }

      if (cleanedData.name !== undefined && typeof cleanedData.name === 'string' && cleanedData.name.trim() === '') {
        return res.status(400).json({ error: "Name cannot be empty" });
      }
      const whatsappFields = ['whatsappNumber', 'whatsappNumber2', 'whatsappNumber3'];
      for (const waField of whatsappFields) {
        if (cleanedData[waField] && cleanedData[waField] !== null) {
          const cleanWA = String(cleanedData[waField]).replace(/[\s\-()]/g, "");
          if (!/^\+?\d{7,15}$/.test(cleanWA)) {
            return res.status(400).json({ error: `Invalid WhatsApp number. Please include country code (e.g., +1234567890)` });
          }
        }
      }

      if (cleanedData.phone && cleanedData.phone !== null) {
        const cleanPhone = String(cleanedData.phone).replace(/[\s\-()]/g, "");
        if (!/^\+?\d{7,15}$/.test(cleanPhone)) {
          return res.status(400).json({ error: "Invalid phone number. Please include country code (e.g., +1234567890)" });
        }
      }

      if (cleanedData.email !== undefined) {
        const emailStr = String(cleanedData.email).trim();
        if (!emailStr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
          return res.status(400).json({ error: "Please provide a valid email address" });
        }
        cleanedData.email = emailStr;
        const existingUser = await storage.getUserByEmail(emailStr);
        if (existingUser && existingUser.id !== req.params.id) {
          return res.status(400).json({ error: "This email is already in use by another account" });
        }
      }

      const validExpLevels = ["entry", "some", "experienced"];
      const validAvailabilities = ["full_time", "part_time", "flexible"];
      if (cleanedData.experienceLevel && !validExpLevels.includes(cleanedData.experienceLevel)) {
        delete cleanedData.experienceLevel;
      }
      if (cleanedData.availability && !validAvailabilities.includes(cleanedData.availability)) {
        delete cleanedData.availability;
      }
      
      const updateData = insertUserSchema.partial().parse(cleanedData);
      const user = await storage.updateUser(req.params.id as string, updateData);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json(sanitizeUser(user));
      logActivity("Updated user", "User", req.params.id as string, `Updated user profile`, req.session.userId);
    } catch (error) {
      logger.error("Error updating user:", error);
      if (error instanceof z.ZodError) {
        logger.error("Zod validation errors:", JSON.stringify(error.errors, null, 2));
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.delete("/api/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteUser(req.params.id as string);
      logActivity("Deleted user", "User", req.params.id as string, `Deleted user`, req.session.userId);
      res.json({ success: true, message: "User deleted successfully" });
    } catch (error) {
      logger.error("Error deleting user:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    try {
      const { email, password, role } = req.body;
      
      if (!email || !role) {
        return res.status(400).json({ error: "Email and role are required" });
      }
      
      const user = await storage.getUserByEmail(email.toLowerCase());
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      if (user.role !== role) {
        return res.status(403).json({ error: "Invalid role for this user" });
      }
      
      if (user.password) {
        const passwordMatch = await bcrypt.compare(password || "", user.password);
        if (!passwordMatch) {
          return res.status(401).json({ error: "Invalid password" });
        }
      }
      
      if ((role === "trainer" || role === "referrer") && user.isApproved !== "true") {
        return res.status(403).json({ error: "Your account is pending admin approval. Please wait for confirmation." });
      }
      
      req.session.userId = user.id;
      req.session.userRole = user.role;
      
      const loginIp = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      const displayName = user.role === "admin" ? `${user.name} (Admin)` : user.role === "trainer" ? `${user.name} (Trainer)` : user.role === "referrer" ? `${user.name} (Referrer)` : user.name;
      storage.linkVisitorToApplicant(loginIp, displayName).catch(logger.error);
      
      res.json(sanitizeUser(user));
      logActivity("User logged in", "Auth", user.id, `${user.name} (${user.role}) logged in`, user.id, loginIp);
    } catch (error) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to logout" });
      }
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }
      res.json(sanitizeUser(user));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  app.post("/api/users/:id/approve", requireRole("admin"), async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id as string);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.role !== "trainer" && user.role !== "referrer") {
        return res.status(400).json({ error: "Only trainers and referrers can be approved" });
      }
      const approvedUser = await storage.approveUser(req.params.id as string);
      if (approvedUser) {
        res.json(sanitizeUser(approvedUser));
        logActivity("Approved user", "User", req.params.id as string, `Approved ${user.role}: ${user.name}`, req.session.userId, undefined, { isApproved: user.isApproved });
        sendStaffApprovalEmail(user.email, user.name, user.role).catch(logger.error);
      }
      else res.status(404).json({ error: "User not found" });
    } catch (error) {
      res.status(500).json({ error: "Failed to approve user" });
    }
  });
}
