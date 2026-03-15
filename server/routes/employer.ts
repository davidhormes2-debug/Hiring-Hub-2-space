import type { Express } from "express";
import { requireAuth, requireRole, sanitizeUser, logActivity, registerLimiter } from "./helpers";
import { storage } from "../storage";
import { logger } from "../logger";
import bcrypt from "bcryptjs";
import { createCheckoutSession, retrieveCheckoutSession, isStripeConfigured } from "../stripe";

export function registerEmployerRoutes(app: Express) {
  app.post("/api/employer/register", registerLimiter, async (req, res) => {
    try {
      const { businessName, contactPerson, email, password, phone, businessType, website, description } = req.body;
      if (!businessName || !contactPerson || !email || !password) {
        return res.status(400).json({ error: "Business name, contact person, email, and password are required" });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Please enter a valid email address" });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }
      const existing = await storage.getUserByEmail(email.toLowerCase());
      if (existing) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await storage.createUser({
        name: contactPerson,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: "employer",
        phone: phone || null,
        isApproved: "true",
      });
      const profile = await storage.createEmployerProfile({
        userId: user.id,
        businessName,
        businessType: businessType || null,
        website: website || null,
        description: description || null,
        contactPerson,
        contactPhone: phone || null,
        status: "pending",
      });
      req.session.userId = user.id;
      req.session.userRole = "employer";
      res.status(201).json({ user: sanitizeUser(user), profile });
      logActivity("Employer registered", "Employer", user.id, `${businessName} registered as employer`, user.id);
    } catch (error) {
      logger.error("Employer registration failed:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.get("/api/employer/profile", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      res.json(profile);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  });

  app.put("/api/employer/profile", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      const { businessName, businessType, website, description, contactPerson, contactPhone, logoUrl } = req.body;
      const updated = await storage.updateEmployerProfile(profile.id, {
        ...(businessName && { businessName }),
        ...(businessType !== undefined && { businessType }),
        ...(website !== undefined && { website }),
        ...(description !== undefined && { description }),
        ...(contactPerson && { contactPerson }),
        ...(contactPhone !== undefined && { contactPhone }),
        ...(logoUrl !== undefined && { logoUrl }),
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  app.get("/api/employer/payment-details", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const settings = await storage.getPaymentSettings();
      const stripeAvailable = isStripeConfigured() && (settings?.stripeEnabled === true);
      res.json({
        cryptoWallets: settings?.cryptoWallets || null,
        bankDetails: settings?.bankDetails || null,
        cardInstructions: settings?.cardInstructions || null,
        instructions: settings?.instructions || null,
        stripeEnabled: stripeAvailable,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch payment details" });
    }
  });

  app.post("/api/employer/submit-payment", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      const { tier, paymentMethod, proofOfPaymentUrl, amount } = req.body;
      if (!tier || !paymentMethod || !proofOfPaymentUrl) {
        return res.status(400).json({ error: "Tier, payment method, and proof of payment are required" });
      }
      if (!["starter", "basic", "premium", "custom", "enterprise"].includes(tier)) {
        return res.status(400).json({ error: "Invalid subscription tier" });
      }
      if (!["crypto", "bank", "card"].includes(paymentMethod)) {
        return res.status(400).json({ error: "Invalid payment method" });
      }
      const tierConfig: Record<string, { slots: number; price: string }> = {
        starter: { slots: 3, price: "99" },
        basic: { slots: 10, price: "200" },
        premium: { slots: 25, price: "500" },
        enterprise: { slots: 50, price: "999" },
        custom: { slots: 0, price: "0" },
      };
      const config = tierConfig[tier] || tierConfig.basic;
      const slots = config.slots;
      const payment = await storage.createEmployerPayment({
        employerId: profile.id,
        amount: amount || config.price,
        currency: "USD",
        paymentMethod,
        paymentStatus: "pending",
        proofOfPaymentUrl,
        tier,
        candidateSlots: slots,
      });
      res.status(201).json(payment);
      logActivity("Payment submitted", "Employer", req.session.userId!, `${profile.businessName} submitted ${tier} payment proof`, req.session.userId!);
    } catch (error) {
      logger.error("Payment submission failed:", error);
      res.status(500).json({ error: "Failed to submit payment" });
    }
  });

  app.post("/api/employer/create-checkout-session", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Stripe payments are not available" });
      }
      const settings = await storage.getPaymentSettings();
      if (!settings?.stripeEnabled) {
        return res.status(503).json({ error: "Online card payments are currently disabled" });
      }
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      const { tier } = req.body;
      if (!tier || !["starter", "basic", "premium", "enterprise"].includes(tier)) {
        return res.status(400).json({ error: "Invalid tier." });
      }
      const origin = `${req.protocol}://${req.get("host")}`;
      const session = await createCheckoutSession(tier, profile.id, req.session.userId!, origin);
      res.json({ url: session.url });
    } catch (error) {
      logger.error("Failed to create Stripe checkout session:", error);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  app.post("/api/employer/verify-payment", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      const session = await retrieveCheckoutSession(sessionId);
      if (session.payment_status !== "paid") {
        return res.status(400).json({ error: "Payment not completed" });
      }
      if (session.metadata?.employerId !== String(profile.id)) {
        return res.status(403).json({ error: "Payment does not belong to this employer" });
      }
      const existingPayments = await storage.getEmployerPaymentsByEmployer(profile.id);
      const alreadyProcessed = existingPayments.some(p => p.proofOfPaymentUrl === `stripe:${sessionId}`);
      if (alreadyProcessed) {
        return res.json({ success: true, message: "Payment already processed" });
      }
      const tier = (session.metadata?.tier || "basic") as "custom" | "starter" | "basic" | "premium" | "enterprise";
      const tierSlots: Record<string, number> = { starter: 3, basic: 10, premium: 25, enterprise: 50 };
      const tierPrices: Record<string, string> = { starter: "99", basic: "200", premium: "500", enterprise: "999" };
      const slots = tierSlots[tier] || 10;
      const amount = tierPrices[tier] || "200";
      await storage.createEmployerPayment({
        employerId: profile.id,
        amount,
        currency: "USD",
        paymentMethod: "card",
        paymentStatus: "approved",
        proofOfPaymentUrl: `stripe:${sessionId}`,
        tier,
        candidateSlots: slots,
      });
      await storage.updateEmployerProfile(profile.id, {
        status: "active",
        subscriptionTier: tier,
        candidateSlots: (profile.candidateSlots || 0) + slots,
      });
      res.json({ success: true, message: "Payment verified and subscription activated" });
      logActivity("Stripe payment verified", "Employer", req.session.userId!, `${profile.businessName} paid via Stripe for ${tier} plan`, req.session.userId!);
    } catch (error) {
      logger.error("Failed to verify Stripe payment:", error);
      res.status(500).json({ error: "Failed to verify payment" });
    }
  });

  app.get("/api/employer/subscription-status", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      const payments = await storage.getEmployerPaymentsByEmployer(profile.id);
      res.json({
        status: profile.status,
        tier: profile.subscriptionTier,
        candidateSlots: profile.candidateSlots,
        candidateSlotsUsed: profile.candidateSlotsUsed,
        payments,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch subscription status" });
    }
  });

  app.get("/api/public/job-listings", async (req, res) => {
    try {
      const listings = await storage.getActiveEmployerJobListings();
      res.json(listings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch job listings" });
    }
  });

  app.get("/api/employer/job-listings", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      const listings = await storage.getEmployerJobListingsByEmployer(profile.id);
      res.json(listings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch job listings" });
    }
  });

  app.post("/api/employer/job-listings", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      if (profile.status !== "active") {
        return res.status(403).json({ error: "Your subscription must be active to create job listings" });
      }
      const { title, description, requirements, location, salary, employmentType, status } = req.body;
      if (!title) return res.status(400).json({ error: "Job title is required" });
      const listing = await storage.createEmployerJobListing({
        employerId: profile.id,
        title,
        description: description || null,
        requirements: requirements || null,
        location: location || null,
        salary: salary || null,
        employmentType: employmentType || "full_time",
        status: "pending_approval",
        postedAt: null,
      });
      res.status(201).json(listing);
    } catch (error) {
      res.status(500).json({ error: "Failed to create job listing" });
    }
  });

  app.put("/api/employer/job-listings/:id", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      const listing = await storage.getEmployerJobListing(parseInt(req.params.id as string));
      if (!listing || listing.employerId !== profile.id) {
        return res.status(404).json({ error: "Job listing not found" });
      }
      const { title, description, requirements, location, salary, employmentType, status } = req.body;
      const updateData: any = {};
      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (requirements !== undefined) updateData.requirements = requirements;
      if (location !== undefined) updateData.location = location;
      if (salary !== undefined) updateData.salary = salary;
      if (employmentType !== undefined) updateData.employmentType = employmentType;
      if (status !== undefined) {
        if (status === "active") {
          updateData.status = "pending_approval";
        } else {
          updateData.status = status;
        }
        if (status === "closed" || status === "filled") updateData.closedAt = new Date();
      }
      const updated = await storage.updateEmployerJobListing(listing.id, updateData);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update job listing" });
    }
  });

  app.get("/api/employer/candidates", requireAuth, requireRole("employer"), async (req, res) => {
    try {
      const profile = await storage.getEmployerProfileByUserId(req.session.userId!);
      if (!profile) return res.status(404).json({ error: "Employer profile not found" });
      const assignments = await storage.getEmployerCandidateAssignmentsByEmployer(profile.id);
      const enriched = await Promise.all(assignments.map(async (a) => {
        const user = await storage.getUser(a.applicantId);
        return { ...a, applicantName: user?.name, applicantEmail: user?.email, applicantPhone: user?.phone };
      }));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch candidates" });
    }
  });

  app.get("/api/admin/employers", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const profiles = await storage.getAllEmployerProfiles();
      const enriched = await Promise.all(profiles.map(async (p) => {
        const user = await storage.getUser(p.userId);
        return { ...p, email: user?.email };
      }));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch employers" });
    }
  });

  app.put("/api/admin/employers/:id/status", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { status } = req.body;
      if (!["pending", "active", "suspended"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      const updated = await storage.updateEmployerProfile(parseInt(req.params.id as string), { status });
      if (!updated) return res.status(404).json({ error: "Employer not found" });
      res.json(updated);
      logActivity("Updated employer status", "Employer", req.params.id as string, `Set employer ${updated.businessName} to ${status}`, req.session.userId!);
    } catch (error) {
      res.status(500).json({ error: "Failed to update employer status" });
    }
  });

  app.post("/api/admin/employers/:id/assign-candidate", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const employerId = parseInt(req.params.id as string);
      const profile = await storage.getEmployerProfile(employerId);
      if (!profile) return res.status(404).json({ error: "Employer not found" });
      const { applicantId, jobListingId, notes } = req.body;
      if (!applicantId) return res.status(400).json({ error: "Applicant ID is required" });
      const existingAssignments = await storage.getEmployerCandidateAssignmentsByEmployer(employerId);
      if (existingAssignments.some(a => a.applicantId === applicantId)) {
        return res.status(409).json({ error: "This applicant is already assigned to this employer" });
      }
      const freshProfile = await storage.getEmployerProfile(employerId);
      const slotsAvailable = (freshProfile!.candidateSlots || 0) - (freshProfile!.candidateSlotsUsed || 0);
      if (slotsAvailable <= 0) {
        return res.status(400).json({ error: "No candidate slots available. Employer needs to upgrade their subscription." });
      }
      const assignment = await storage.createEmployerCandidateAssignment({
        employerId,
        applicantId,
        jobListingId: jobListingId ? parseInt(jobListingId) : null,
        status: "assigned",
        assignedBy: req.session.userId!,
        notes: notes || null,
      });
      await storage.updateEmployerProfile(employerId, {
        candidateSlotsUsed: (freshProfile!.candidateSlotsUsed || 0) + 1,
      });
      res.status(201).json(assignment);
      logActivity("Assigned candidate to employer", "Employer", req.session.userId!, `Assigned applicant ${applicantId} to ${profile.businessName}`, req.session.userId!);
    } catch (error) {
      logger.error("Failed to assign candidate:", error);
      res.status(500).json({ error: "Failed to assign candidate" });
    }
  });

  app.put("/api/admin/employer-assignments/:id/status", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const assignmentId = parseInt(req.params.id as string);
      const { status } = req.body;
      if (!["assigned", "onboarding", "completed", "withdrawn"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      const updated = await storage.updateEmployerCandidateAssignment(assignmentId, { status });
      if (!updated) return res.status(404).json({ error: "Assignment not found" });
      res.json(updated);
    } catch (error) {
      logger.error("Failed to update assignment status:", error);
      res.status(500).json({ error: "Failed to update assignment status" });
    }
  });

  app.delete("/api/admin/employer-assignments/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const assignmentId = parseInt(req.params.id as string);
      const allAssignments = await storage.getAllEmployerCandidateAssignments();
      const target = allAssignments.find(a => a.id === assignmentId);
      if (!target) return res.status(404).json({ error: "Assignment not found" });
      await storage.deleteEmployerCandidateAssignment(target.id);
      const profile = await storage.getEmployerProfile(target.employerId);
      if (profile && (profile.candidateSlotsUsed || 0) > 0) {
        await storage.updateEmployerProfile(target.employerId, {
          candidateSlotsUsed: (profile.candidateSlotsUsed || 0) - 1,
        });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to remove assignment" });
    }
  });

  app.get("/api/admin/employer-job-listings", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const listings = await storage.getAllEmployerJobListings();
      const enriched = await Promise.all(listings.map(async (l) => {
        const profile = await storage.getEmployerProfile(l.employerId);
        return { ...l, businessName: profile?.businessName };
      }));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch job listings" });
    }
  });

  app.post("/api/admin/employer-job-listings", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { employerId, title, description, requirements, location, salary, employmentType, status } = req.body;
      if (!employerId || !title) return res.status(400).json({ error: "Employer and title are required" });
      const profile = await storage.getEmployerProfile(parseInt(employerId));
      if (!profile) return res.status(404).json({ error: "Employer not found" });
      const listing = await storage.createEmployerJobListing({
        employerId: parseInt(employerId),
        title,
        description: description || null,
        requirements: requirements || null,
        location: location || null,
        salary: salary || null,
        employmentType: employmentType || "full_time",
        status: status || "draft",
        postedAt: status === "active" ? new Date() : null,
      });
      res.status(201).json(listing);
    } catch (error) {
      res.status(500).json({ error: "Failed to create job listing" });
    }
  });

  app.put("/api/admin/employer-job-listings/:id", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { title, description, requirements, location, salary, employmentType, status } = req.body;
      const listing = await storage.getEmployerJobListing(parseInt(req.params.id as string));
      if (!listing) return res.status(404).json({ error: "Job listing not found" });
      const updateData: any = {};
      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (requirements !== undefined) updateData.requirements = requirements;
      if (location !== undefined) updateData.location = location;
      if (salary !== undefined) updateData.salary = salary;
      if (employmentType !== undefined) updateData.employmentType = employmentType;
      if (status !== undefined) {
        updateData.status = status;
        if (status === "active" && listing.status !== "active") updateData.postedAt = new Date();
        if (status === "closed" || status === "filled") updateData.closedAt = new Date();
      }
      const updated = await storage.updateEmployerJobListing(listing.id, updateData);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update job listing" });
    }
  });

  app.get("/api/admin/employer-payments", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const payments = await storage.getAllEmployerPayments();
      const enriched = await Promise.all(payments.map(async (p) => {
        const profile = await storage.getEmployerProfile(p.employerId);
        return { ...p, businessName: profile?.businessName };
      }));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch payments" });
    }
  });

  app.put("/api/admin/employer-payments/:id/review", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { paymentStatus, adminNotes } = req.body;
      if (!["approved", "rejected"].includes(paymentStatus)) {
        return res.status(400).json({ error: "Status must be approved or rejected" });
      }
      const payment = await storage.getEmployerPayment(parseInt(req.params.id as string));
      if (!payment) return res.status(404).json({ error: "Payment not found" });
      const updated = await storage.updateEmployerPaymentStatus(payment.id, {
        paymentStatus,
        adminNotes: adminNotes || null,
        reviewedBy: req.session.userId!,
        reviewedAt: new Date(),
      });
      if (paymentStatus === "approved") {
        const profile = await storage.getEmployerProfile(payment.employerId);
        if (profile) {
          await storage.updateEmployerProfile(profile.id, {
            status: "active",
            subscriptionTier: payment.tier,
            candidateSlots: (profile.candidateSlots || 0) + payment.candidateSlots,
          });
        }
      }
      res.json(updated);
      logActivity("Reviewed employer payment", "Employer", req.session.userId!, `${paymentStatus} payment #${payment.id}`, req.session.userId!);
    } catch (error) {
      res.status(500).json({ error: "Failed to review payment" });
    }
  });

  app.post("/api/admin/employer-grant-plan", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { employerId, tier, adminNotes } = req.body;
      const parsedId = Number(employerId);
      if (!parsedId || isNaN(parsedId)) {
        return res.status(400).json({ error: "Valid employer ID is required" });
      }
      if (!tier || !["starter", "basic", "premium", "enterprise"].includes(tier)) {
        return res.status(400).json({ error: "Invalid tier" });
      }
      if (adminNotes && typeof adminNotes !== "string") {
        return res.status(400).json({ error: "Notes must be a string" });
      }
      const profile = await storage.getEmployerProfile(parsedId);
      if (!profile) return res.status(404).json({ error: "Employer not found" });

      const slotsMap: Record<string, number> = { starter: 3, basic: 10, premium: 25, enterprise: 50 };
      const amountMap: Record<string, number> = { starter: 99, basic: 200, premium: 500, enterprise: 999 };
      const slots = slotsMap[tier];
      const amount = amountMap[tier];

      const payment = await storage.createEmployerPayment({
        employerId: profile.id,
        amount: String(amount),
        currency: "USD",
        paymentMethod: "admin_grant",
        paymentStatus: "approved",
        proofOfPaymentUrl: null,
        tier,
        candidateSlots: slots,
        adminNotes: adminNotes || "Granted by admin",
        reviewedBy: req.session.userId!,
        reviewedAt: new Date(),
      });

      await storage.updateEmployerProfile(profile.id, {
        status: "active",
        subscriptionTier: tier,
        candidateSlots: (profile.candidateSlots || 0) + slots,
      });

      res.json({ success: true, payment, message: `Granted ${tier} plan to employer` });
      logActivity("Granted employer plan", "Employer", req.session.userId!, `Granted ${tier} plan to employer #${profile.id}`, req.session.userId!);
    } catch (error) {
      logger.error("Failed to grant employer plan:", error);
      res.status(500).json({ error: "Failed to grant plan" });
    }
  });

  app.get("/api/admin/payment-settings", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const settings = await storage.getPaymentSettings();
      res.json(settings || { cryptoWallets: null, bankDetails: null, cardInstructions: null, instructions: null });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch payment settings" });
    }
  });

  app.put("/api/admin/payment-settings", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const { cryptoWallets, bankDetails, cardInstructions, instructions, stripeEnabled } = req.body;
      const settings = await storage.upsertPaymentSettings({
        cryptoWallets: cryptoWallets || null,
        bankDetails: bankDetails || null,
        cardInstructions: cardInstructions || null,
        instructions: instructions || null,
        stripeEnabled: stripeEnabled === true,
      });
      res.json(settings);
    } catch (error) {
      res.status(500).json({ error: "Failed to update payment settings" });
    }
  });

  app.get("/api/admin/employer-candidates", requireAuth, requireRole("admin"), async (req, res) => {
    try {
      const assignments = await storage.getAllEmployerCandidateAssignments();
      const enriched = await Promise.all(assignments.map(async (a) => {
        const user = await storage.getUser(a.applicantId);
        const profile = await storage.getEmployerProfile(a.employerId);
        return { ...a, applicantName: user?.name, applicantEmail: user?.email, businessName: profile?.businessName };
      }));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch candidate assignments" });
    }
  });
}
