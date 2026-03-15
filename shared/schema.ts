import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, pgEnum, serial, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const userRoleEnum = pgEnum("user_role", ["applicant", "admin", "trainer", "referrer", "employer"]);
export const applicationStatusEnum = pgEnum("application_status", ["submitted", "under_review", "accepted", "rejected", "started_working", "pulled_out"]);
export const trainingStatusEnum = pgEnum("training_status", ["requested", "scheduled", "confirmed", "reschedule_requested", "completed"]);
export const sessionStatusEnum = pgEnum("session_status", ["open", "filled", "completed"]);

export const preferredContactEnum = pgEnum("preferred_contact", ["whatsapp", "telegram", "email"]);
export const experienceLevelEnum = pgEnum("experience_level", ["entry", "some", "experienced"]);
export const availabilityEnum = pgEnum("availability", ["full_time", "part_time", "flexible"]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password"),
  role: userRoleEnum("role").notNull(),
  referralCode: text("referral_code"),
  referredBy: text("referred_by"),
  phone: text("phone"),
  whatsappNumber: text("whatsapp_number"),
  whatsappNumber2: text("whatsapp_number_2"),
  whatsappNumber3: text("whatsapp_number_3"),
  telegramHandle: text("telegram_handle"),
  preferredContact: preferredContactEnum("preferred_contact"),
  affiliateCode: text("affiliate_code"),
  address: text("address"),
  bio: text("bio"),
  skills: text("skills").array(),
  linkedinUrl: text("linkedin_url"),
  country: text("country"),
  experienceLevel: experienceLevelEnum("experience_level"),
  availability: availabilityEnum("availability"),
  motivation: text("motivation"),
  hasComputerAccess: text("has_computer_access").default("false"),
  isCertified: text("is_certified").default("false"),
  certifiedAt: timestamp("certified_at"),
  isApproved: text("is_approved").default("true"),
  approvedAt: timestamp("approved_at"),
  resetToken: text("reset_token"),
  resetTokenExpiry: timestamp("reset_token_expiry"),
  twoFactorEnabled: text("two_factor_enabled").default("false"),
  twoFactorCode: text("two_factor_code"),
  twoFactorExpiry: timestamp("two_factor_expiry"),
  timezone: text("timezone"),
  gender: text("gender"),
  nationality: text("nationality"),
  primaryDevice: text("primary_device"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const applications = pgTable("applications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicantId: varchar("applicant_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: applicationStatusEnum("status").notNull().default("under_review"),
  appliedAt: timestamp("applied_at").defaultNow().notNull(),
  resumeUrl: text("resume_url"),
  adminNotes: text("admin_notes"),
  trainingStatus: trainingStatusEnum("training_status"),
  trainerId: varchar("trainer_id").references(() => users.id),
  trainingSessionId: varchar("training_session_id").references(() => trainingSessions.id),
  traineeConfirmed: text("trainee_confirmed").default("false"),
  traineeConfirmedAt: timestamp("trainee_confirmed_at"),
  trainerConfirmed: text("trainer_confirmed").default("false"),
  trainerConfirmedAt: timestamp("trainer_confirmed_at"),
  onboardedAt: timestamp("onboarded_at"),
  offerLetterRef: text("offer_letter_ref"),
  certificateId: text("certificate_id"),
  trainingCompletedAt: timestamp("training_completed_at"),
  ipAddress: text("ip_address"),
  ipCountry: text("ip_country"),
  ipCity: text("ip_city"),
  certificateRevoked: text("certificate_revoked").default("false"),
  certificateRevokedAt: timestamp("certificate_revoked_at"),
  certificateRevokedBy: varchar("certificate_revoked_by"),
  certificateRevokedReason: text("certificate_revoked_reason"),
});

export const trainingSessions = pgTable("training_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id),
  startTime: timestamp("start_time").notNull(),
  durationMinutes: text("duration_minutes").notNull(),
  maxAttendees: text("max_attendees").notNull(),
  status: sessionStatusEnum("status").notNull().default("open"),
  isArchived: text("is_archived").default("false"),
  archivedAt: timestamp("archived_at"),
});

export const dayOfWeekEnum = pgEnum("day_of_week", ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

export const trainerWeeklyAvailability = pgTable("trainer_weekly_availability", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  dayOfWeek: dayOfWeekEnum("day_of_week").notNull(),
  slotIndex: text("slot_index").notNull().default("1"),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  durationMinutes: text("duration_minutes").notNull().default("120"),
  maxAttendees: text("max_attendees").notNull().default("5"),
  timezone: text("timezone").notNull().default("UTC"),
  isActive: text("is_active").notNull().default("true"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  applications: many(applications),
  trainingSessions: many(trainingSessions),
}));

export const applicationsRelations = relations(applications, ({ one }) => ({
  applicant: one(users, {
    fields: [applications.applicantId],
    relationName: "applicant",
    references: [users.id],
  }),
  trainer: one(users, {
    fields: [applications.trainerId],
    relationName: "trainer",
    references: [users.id],
  }),
  trainingSession: one(trainingSessions, {
    fields: [applications.trainingSessionId],
    references: [trainingSessions.id],
  }),
}));

export const trainingSessionsRelations = relations(trainingSessions, ({ one, many }) => ({
  trainer: one(users, {
    fields: [trainingSessions.trainerId],
    references: [users.id],
  }),
  applications: many(applications),
}));

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertApplicationSchema = createInsertSchema(applications).omit({
  id: true,
  appliedAt: true,
});

export const insertTrainingSessionSchema = createInsertSchema(trainingSessions).omit({
  id: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type Application = typeof applications.$inferSelect;
export type InsertTrainingSession = z.infer<typeof insertTrainingSessionSchema>;
export type TrainingSession = typeof trainingSessions.$inferSelect;

export const insertWeeklyAvailabilitySchema = createInsertSchema(trainerWeeklyAvailability).omit({
  id: true,
  createdAt: true,
});

export type InsertWeeklyAvailability = z.infer<typeof insertWeeklyAvailabilitySchema>;
export type WeeklyAvailability = typeof trainerWeeklyAvailability.$inferSelect;

export const leadStatusEnum = pgEnum("lead_status", ["new", "contacted", "converted", "unsubscribed"]);

export const leadFolders = pgTable("lead_folders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#3b82f6"),
  leadCount: integer("lead_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLeadFolderSchema = createInsertSchema(leadFolders).omit({ id: true, createdAt: true, leadCount: true });
export type InsertLeadFolder = z.infer<typeof insertLeadFolderSchema>;
export type LeadFolder = typeof leadFolders.$inferSelect;

export const leads = pgTable("leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name"),
  source: text("source").default("tiktok"),
  status: leadStatusEnum("status").notNull().default("new"),
  country: text("country"),
  phone: text("phone"),
  job: text("job"),
  notes: text("notes"),
  score: integer("score").default(0),
  uploadBatch: integer("upload_batch"),
  folderId: varchar("folder_id").references(() => leadFolders.id, { onDelete: "set null" }),
  lastContactedAt: timestamp("last_contacted_at"),
  viewedAt: timestamp("viewed_at"),
  autoTagOnUpload: text("auto_tag_on_upload"),
  unsubscribed: boolean("unsubscribed").default(false),
  unsubscribedAt: timestamp("unsubscribed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLeadSchema = createInsertSchema(leads).omit({
  id: true,
  createdAt: true,
});

export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leads.$inferSelect;

export const leadTags = pgTable("lead_tags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#3b82f6"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const leadTagAssignments = pgTable("lead_tag_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  tagId: varchar("tag_id").notNull().references(() => leadTags.id, { onDelete: "cascade" }),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
});

export const insertLeadTagSchema = createInsertSchema(leadTags).omit({ id: true, createdAt: true });
export type InsertLeadTag = z.infer<typeof insertLeadTagSchema>;
export type LeadTag = typeof leadTags.$inferSelect;
export type LeadTagAssignment = typeof leadTagAssignments.$inferSelect;

export const emailTracking = pgTable("email_tracking", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").references(() => leads.id, { onDelete: "set null" }),
  emailLogId: varchar("email_log_id"),
  type: text("type").notNull(),
  url: text("url"),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type EmailTracking = typeof emailTracking.$inferSelect;

export const scheduledEmails = pgTable("scheduled_emails", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  recipientType: text("recipient_type").notNull(),
  recipientFilter: text("recipient_filter"),
  recipientIds: text("recipient_ids").array(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  sentAt: timestamp("sent_at"),
  status: text("status").notNull().default("scheduled"),
  totalRecipients: integer("total_recipients").default(0),
  sentCount: integer("sent_count").default(0),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertScheduledEmailSchema = createInsertSchema(scheduledEmails).omit({ id: true, createdAt: true, sentAt: true, sentCount: true });
export type InsertScheduledEmail = z.infer<typeof insertScheduledEmailSchema>;
export type ScheduledEmail = typeof scheduledEmails.$inferSelect;

export const announcementRecipientEnum = pgEnum("announcement_recipient", ["all_staff", "trainers", "referrers", "selected"]);

export const announcements = pgTable("announcements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  adminId: varchar("admin_id").notNull().references(() => users.id),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  recipientType: announcementRecipientEnum("recipient_type").notNull(),
  recipientIds: text("recipient_ids").array(),
  imageUrl: text("image_url"),
  emailsSent: integer("emails_sent").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAnnouncementSchema = createInsertSchema(announcements).omit({
  id: true,
  createdAt: true,
  emailsSent: true,
});

export type InsertAnnouncement = z.infer<typeof insertAnnouncementSchema>;
export type Announcement = typeof announcements.$inferSelect;

export const trainerTimeSlots = pgTable("trainer_time_slots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  dayOfWeek: dayOfWeekEnum("day_of_week").notNull(),
  hour: text("hour").notNull(),
  isActive: text("is_active").notNull().default("true"),
  durationMinutes: text("duration_minutes").notNull().default("60"),
  maxAttendees: text("max_attendees").notNull().default("5"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTrainerTimeSlotSchema = createInsertSchema(trainerTimeSlots).omit({
  id: true,
  createdAt: true,
});

export type InsertTrainerTimeSlot = z.infer<typeof insertTrainerTimeSlotSchema>;
export type TrainerTimeSlot = typeof trainerTimeSlots.$inferSelect;

export const trainingMaterials = pgTable("training_materials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  fileName: text("file_name").notNull(),
  fileUrl: text("file_url").notNull(),
  fileType: text("file_type"),
  fileSize: text("file_size"),
  category: text("category").default("Uncategorized"),
  sortOrder: integer("sort_order").default(0),
  isRequired: text("is_required").default("false"),
  downloadCount: integer("download_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const trainingMaterialsRelations = relations(trainingMaterials, ({ one }) => ({
  trainer: one(users, {
    fields: [trainingMaterials.trainerId],
    references: [users.id],
  }),
}));

export const insertTrainingMaterialSchema = createInsertSchema(trainingMaterials).omit({
  id: true,
  createdAt: true,
});

export type InsertTrainingMaterial = z.infer<typeof insertTrainingMaterialSchema>;
export type TrainingMaterial = typeof trainingMaterials.$inferSelect;

export const emailTemplateCategoryEnum = pgEnum("email_template_category", [
  "welcome",
  "training_reminder",
  "follow_up",
  "completion",
  "general",
  "custom"
]);

export const emailTemplates = pgTable("email_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  category: emailTemplateCategoryEnum("category").notNull().default("general"),
  isDefault: text("is_default").default("false"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const emailTemplatesRelations = relations(emailTemplates, ({ one }) => ({
  trainer: one(users, {
    fields: [emailTemplates.trainerId],
    references: [users.id],
  }),
}));

export const insertEmailTemplateSchema = createInsertSchema(emailTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEmailTemplate = z.infer<typeof insertEmailTemplateSchema>;
export type EmailTemplate = typeof emailTemplates.$inferSelect;

export const feedbackRatingEnum = pgEnum("feedback_rating", ["1", "2", "3", "4", "5"]);

export const feedback = pgTable("feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicantId: varchar("applicant_id").references(() => users.id, { onDelete: "cascade" }),
  trainerId: varchar("trainer_id").references(() => users.id, { onDelete: "set null" }),
  applicationId: varchar("application_id").references(() => applications.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  rating: feedbackRatingEnum("rating").notNull(),
  trainerRating: feedbackRatingEnum("trainer_rating"),
  trainingQuality: feedbackRatingEnum("training_quality"),
  easeOfUse: text("ease_of_use"),
  wouldRecommend: text("would_recommend"),
  comments: text("comments"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertFeedbackSchema = createInsertSchema(feedback).omit({
  id: true,
  createdAt: true,
});

export type InsertFeedback = z.infer<typeof insertFeedbackSchema>;
export type Feedback = typeof feedback.$inferSelect;

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export const activityLogs = pgTable("activity_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  details: text("details"),
  ipAddress: text("ip_address"),
  previousState: text("previous_state"),
  isUndone: text("is_undone").default("false"),
  undoneAt: timestamp("undone_at"),
  undoneBy: varchar("undone_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  user: one(users, {
    fields: [activityLogs.userId],
    references: [users.id],
  }),
}));

export const insertActivityLogSchema = createInsertSchema(activityLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogs.$inferSelect;

// Email Folders
export const emailFolders = pgTable("email_folders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#3b82f6"),
  isSystem: boolean("is_system").default(false),
  emailCount: integer("email_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEmailFolderSchema = createInsertSchema(emailFolders).omit({ id: true, createdAt: true, emailCount: true });
export type InsertEmailFolder = z.infer<typeof insertEmailFolderSchema>;
export type EmailFolder = typeof emailFolders.$inferSelect;

// Email Logs
export const emailStatusEnum = pgEnum("email_status", ["sent", "failed", "pending"]);

export const emailLogs = pgTable("email_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  recipientEmail: text("recipient_email").notNull(),
  recipientName: text("recipient_name"),
  emailType: text("email_type").notNull(),
  subject: text("subject").notNull(),
  body: text("body"),
  status: emailStatusEnum("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  applicationId: varchar("application_id").references(() => applications.id, { onDelete: "set null" }),
  leadId: varchar("lead_id").references(() => leads.id, { onDelete: "set null" }),
  sentBy: varchar("sent_by").references(() => users.id, { onDelete: "set null" }),
  folderId: varchar("folder_id").references(() => emailFolders.id, { onDelete: "set null" }),
  isArchived: boolean("is_archived").default(false),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const emailLogsRelations = relations(emailLogs, ({ one }) => ({
  application: one(applications, {
    fields: [emailLogs.applicationId],
    references: [applications.id],
  }),
  lead: one(leads, {
    fields: [emailLogs.leadId],
    references: [leads.id],
  }),
  sender: one(users, {
    fields: [emailLogs.sentBy],
    references: [users.id],
  }),
}));

export const insertEmailLogSchema = createInsertSchema(emailLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertEmailLog = z.infer<typeof insertEmailLogSchema>;
export type EmailLog = typeof emailLogs.$inferSelect;

// Session Attendance
export const attendanceStatusEnum = pgEnum("attendance_status", ["registered", "attended", "no_show", "cancelled"]);

export const sessionAttendance = pgTable("session_attendance", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => trainingSessions.id, { onDelete: "cascade" }),
  applicationId: varchar("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  applicantId: varchar("applicant_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: attendanceStatusEnum("status").notNull().default("registered"),
  notes: text("notes"),
  markedAt: timestamp("marked_at"),
  markedBy: varchar("marked_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sessionAttendanceRelations = relations(sessionAttendance, ({ one }) => ({
  session: one(trainingSessions, {
    fields: [sessionAttendance.sessionId],
    references: [trainingSessions.id],
  }),
  application: one(applications, {
    fields: [sessionAttendance.applicationId],
    references: [applications.id],
  }),
  applicant: one(users, {
    fields: [sessionAttendance.applicantId],
    references: [users.id],
  }),
  marker: one(users, {
    fields: [sessionAttendance.markedBy],
    references: [users.id],
    relationName: "marker",
  }),
}));

export const insertSessionAttendanceSchema = createInsertSchema(sessionAttendance).omit({
  id: true,
  createdAt: true,
});

export type InsertSessionAttendance = z.infer<typeof insertSessionAttendanceSchema>;
export type SessionAttendance = typeof sessionAttendance.$inferSelect;

// Manual Assignment Status Enum
export const manualAssignmentStatusEnum = pgEnum("manual_assignment_status", ["pending", "contacted", "in_progress", "completed"]);

// Manual Trainee Assignments
export const manualTraineeAssignments = pgTable("manual_trainee_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  traineeName: text("trainee_name").notNull(),
  traineeEmail: text("trainee_email").notNull(),
  traineePhone: text("trainee_phone").notNull(),
  resumeUrl: text("resume_url"),
  trainerId: varchar("trainer_id").notNull().references(() => users.id),
  adminNote: text("admin_note"),
  status: manualAssignmentStatusEnum("status").notNull().default("pending"),
  assignedBy: varchar("assigned_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertManualTraineeAssignmentSchema = createInsertSchema(manualTraineeAssignments).omit({
  id: true,
  createdAt: true,
});

export type InsertManualTraineeAssignment = z.infer<typeof insertManualTraineeAssignmentSchema>;
export type ManualTraineeAssignment = typeof manualTraineeAssignments.$inferSelect;

// Trainer Reminder Settings
export const trainerReminderSettings = pgTable("trainer_reminder_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  sessionReminder24h: text("session_reminder_24h").default("true"),
  sessionReminder1h: text("session_reminder_1h").default("true"),
  pendingTasksReminder: text("pending_tasks_reminder").default("true"),
  unconfirmedSessionsReminder: text("unconfirmed_sessions_reminder").default("true"),
  dailyDigest: text("daily_digest").default("false"),
  weeklyDigest: text("weekly_digest").default("false"),
  emailNotifications: text("email_notifications").default("true"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTrainerReminderSettingsSchema = createInsertSchema(trainerReminderSettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertTrainerReminderSettings = z.infer<typeof insertTrainerReminderSettingsSchema>;
export type TrainerReminderSettings = typeof trainerReminderSettings.$inferSelect;

// Scheduled Reminders
export const scheduledReminders = pgTable("scheduled_reminders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: varchar("session_id").references(() => trainingSessions.id, { onDelete: "cascade" }),
  reminderType: text("reminder_type").notNull(),
  scheduledFor: timestamp("scheduled_for").notNull(),
  sentAt: timestamp("sent_at"),
  status: text("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertScheduledReminderSchema = createInsertSchema(scheduledReminders).omit({
  id: true,
  createdAt: true,
});

export type InsertScheduledReminder = z.infer<typeof insertScheduledReminderSchema>;
export type ScheduledReminder = typeof scheduledReminders.$inferSelect;

// Push Subscriptions
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  isActive: text("is_active").default("true"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
});

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;

// App Settings
export const appSettings = pgTable("app_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  value: text("value"),
  category: text("category").notNull().default("general"),
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
});

export const insertAppSettingSchema = createInsertSchema(appSettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertAppSetting = z.infer<typeof insertAppSettingSchema>;
export type AppSetting = typeof appSettings.$inferSelect;

// Notification types
export const notificationTypeEnum = pgEnum("notification_type", [
  "application_submitted",
  "application_accepted",
  "application_rejected",
  "training_scheduled",
  "training_reminder",
  "training_completed",
  "new_referral",
  "system",
  "message"
]);

// In-app notifications
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: notificationTypeEnum("type").notNull().default("system"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  link: text("link"),
  isRead: text("is_read").default("false"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});

export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;

// Admin email templates (separate from trainer templates)
export const adminEmailTemplates = pgTable("admin_email_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  adminId: varchar("admin_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  category: emailTemplateCategoryEnum("category").notNull().default("general"),
  isDefault: text("is_default").default("false"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAdminEmailTemplateSchema = createInsertSchema(adminEmailTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAdminEmailTemplate = z.infer<typeof insertAdminEmailTemplateSchema>;
export type AdminEmailTemplate = typeof adminEmailTemplates.$inferSelect;

// Dashboard widgets
export const dashboardWidgets = pgTable("dashboard_widgets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  widgetType: text("widget_type").notNull(),
  title: text("title").notNull(),
  position: integer("position").default(0),
  width: integer("width").default(1),
  height: integer("height").default(1),
  isVisible: text("is_visible").default("true"),
  config: text("config"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
});

export const insertDashboardWidgetSchema = createInsertSchema(dashboardWidgets).omit({
  id: true,
  createdAt: true,
});

export type InsertDashboardWidget = z.infer<typeof insertDashboardWidgetSchema>;
export type DashboardWidget = typeof dashboardWidgets.$inferSelect;

// Reschedule requests
export const rescheduleRequests = pgTable("reschedule_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  traineeId: varchar("trainee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  currentSessionId: varchar("current_session_id").references(() => trainingSessions.id),
  requestedDate: text("requested_date"),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"),
  adminNotes: text("admin_notes"),
  reviewedBy: varchar("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const rescheduleRequestsRelations = relations(rescheduleRequests, ({ one }) => ({
  application: one(applications, {
    fields: [rescheduleRequests.applicationId],
    references: [applications.id],
  }),
  trainee: one(users, {
    fields: [rescheduleRequests.traineeId],
    references: [users.id],
  }),
  currentSession: one(trainingSessions, {
    fields: [rescheduleRequests.currentSessionId],
    relationName: "currentSession",
    references: [trainingSessions.id],
  }),
}));

export const insertRescheduleRequestSchema = createInsertSchema(rescheduleRequests).omit({
  id: true,
  createdAt: true,
});

export type InsertRescheduleRequest = z.infer<typeof insertRescheduleRequestSchema>;
export type RescheduleRequest = typeof rescheduleRequests.$inferSelect;

// Applicant Reports
export const applicantReports = pgTable("applicant_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => applications.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
});

export const applicantReportsRelations = relations(applicantReports, ({ one }) => ({
  application: one(applications, {
    fields: [applicantReports.applicationId],
    references: [applications.id],
  }),
  author: one(users, {
    fields: [applicantReports.createdBy],
    references: [users.id],
  }),
}));

export const insertApplicantReportSchema = createInsertSchema(applicantReports).omit({
  id: true,
  createdAt: true,
});

export type InsertApplicantReport = z.infer<typeof insertApplicantReportSchema>;
export type ApplicantReport = typeof applicantReports.$inferSelect;

// Chatbot Logs
export const chatbotLogs = pgTable("chatbot_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: text("session_id").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  page: text("page"),
  userFeedback: text("user_feedback"),
  visitorEmail: text("visitor_email"),
  visitorName: text("visitor_name"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertChatbotLogSchema = createInsertSchema(chatbotLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertChatbotLog = z.infer<typeof insertChatbotLogSchema>;
export type ChatbotLog = typeof chatbotLogs.$inferSelect;

// Trainer Daily Records
export const trainerDailyRecords = pgTable("trainer_daily_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  todayDeposit: text("today_deposit").default("0"),
  todayWithdrawal: text("today_withdrawal").default("0"),
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
});

export const insertTrainerDailyRecordSchema = createInsertSchema(trainerDailyRecords).omit({
  id: true,
  createdAt: true,
});

export type InsertTrainerDailyRecord = z.infer<typeof insertTrainerDailyRecordSchema>;
export type TrainerDailyRecord = typeof trainerDailyRecords.$inferSelect;

// Site Visitors Tracking
export const siteVisitors = pgTable("site_visitors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ipAddress: text("ip_address").notNull(),
  userAgent: text("user_agent"),
  page: text("page").notNull(),
  referrer: text("referrer"),
  country: text("country"),
  city: text("city"),
  os: text("os"),
  browser: text("browser"),
  device: text("device"),
  applicantName: text("applicant_name"),
  sessionId: text("session_id"),
  lastVisitAt: timestamp("last_visit_at").defaultNow().notNull(),
  visitCount: integer("visit_count").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSiteVisitorSchema = createInsertSchema(siteVisitors).omit({
  id: true,
  lastVisitAt: true,
  visitCount: true,
  createdAt: true,
});

export type InsertSiteVisitor = z.infer<typeof insertSiteVisitorSchema>;
export type SiteVisitor = typeof siteVisitors.$inferSelect;

// Training Appointments (Booking system)
export const trainingAppointments = pgTable("training_appointments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicantId: varchar("applicant_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trainerId: varchar("trainer_id").notNull().references(() => users.id),
  applicationId: varchar("application_id"),
  assignedTrainerId: varchar("assigned_trainer_id"),
  assignedAt: timestamp("assigned_at"),
  trainerWhatsapp: text("trainer_whatsapp"),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  preferredDate: text("preferred_date"),
  preferredTime: text("preferred_time"),
  whatsappNumber: text("whatsapp_number"),
  timezone: text("timezone"),
  status: text("status").notNull().default("pending"),
  meetingLink: text("meeting_link"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTrainingAppointmentSchema = createInsertSchema(trainingAppointments).omit({
  id: true,
  createdAt: true,
});

export type InsertTrainingAppointment = z.infer<typeof insertTrainingAppointmentSchema>;
export type TrainingAppointment = typeof trainingAppointments.$inferSelect;

// Certificate Generation Logs
export const certificateLogs = pgTable("certificate_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => applications.id, { onDelete: "cascade" }),
  certificateId: text("certificate_id").notNull().unique(),
  applicantId: text("applicant_id"),
  applicantName: text("applicant_name"),
  applicantEmail: text("applicant_email"),
  action: text("action").notNull(),
  actionBy: text("action_by"),
  actionByName: text("action_by_name"),
  reason: text("reason"),
  companyName: text("company_name"),
  companyTagline: text("company_tagline"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCertificateLogSchema = createInsertSchema(certificateLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertCertificateLog = z.infer<typeof insertCertificateLogSchema>;
export type CertificateLog = typeof certificateLogs.$inferSelect;

// Trainer Celebrations
export const trainerCelebrations = pgTable("trainer_celebrations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  traineeApplicationId: varchar("trainee_application_id").references(() => applications.id),
  celebrationType: text("celebration_type").notNull(),
  message: text("message").notNull(),
  approvedByAdminId: varchar("approved_by_admin_id").references(() => users.id),
  isVisible: text("is_visible").default("true"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTrainerCelebrationSchema = createInsertSchema(trainerCelebrations).omit({
  id: true,
  createdAt: true,
});

export type InsertTrainerCelebration = z.infer<typeof insertTrainerCelebrationSchema>;
export type TrainerCelebration = typeof trainerCelebrations.$inferSelect;

// Trainee Feedback
export const traineeFeedback = pgTable("trainee_feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trainerId: varchar("trainer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  traineeId: varchar("trainee_id").references(() => users.id),
  applicationId: varchar("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  overallRating: integer("overall_rating").notNull(),
  communicationRating: integer("communication_rating"),
  knowledgeRating: integer("knowledge_rating"),
  helpfulnessRating: integer("helpfulness_rating"),
  comment: text("comment"),
  wouldRecommend: text("would_recommend"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  submittedAt: timestamp("submitted_at"),
});

export const insertTraineeFeedbackSchema = createInsertSchema(traineeFeedback).omit({
  id: true,
  createdAt: true,
  submittedAt: true,
});

export type InsertTraineeFeedback = z.infer<typeof insertTraineeFeedbackSchema>;
export type TraineeFeedback = typeof traineeFeedback.$inferSelect;

// Customer Reports
export const customerReports = pgTable("customer_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerName: text("customer_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  billingStage: text("billing_stage").notNull().default("active"),
  depositAmount: text("deposit_amount"),
  negativeAmount: text("negative_amount"),
  revenue: text("revenue"),
  notes: text("notes"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCustomerReportSchema = createInsertSchema(customerReports).omit({
  id: true,
  createdAt: true,
});

export type InsertCustomerReport = z.infer<typeof insertCustomerReportSchema>;
export type CustomerReport = typeof customerReports.$inferSelect;

// Customer Report History
export const customerReportHistory = pgTable("customer_report_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerReportId: varchar("customer_report_id").notNull().references(() => customerReports.id, { onDelete: "cascade" }),
  changedBy: text("changed_by"),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCustomerReportHistorySchema = createInsertSchema(customerReportHistory).omit({
  id: true,
  createdAt: true,
});

export type InsertCustomerReportHistory = z.infer<typeof insertCustomerReportHistorySchema>;
export type CustomerReportHistory = typeof customerReportHistory.$inferSelect;

// Job Offers
export const jobOffers = pgTable("job_offers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  status: text("status").notNull().default("sent"),
  expiresAt: timestamp("expires_at"),
  acceptedAt: timestamp("accepted_at"),
  ipAddress: text("ip_address"),
  ipCountry: text("ip_country"),
  ipCity: text("ip_city"),
  applicationId: varchar("application_id").references(() => applications.id, { onDelete: "cascade" }),
  sentBy: varchar("sent_by").references(() => users.id),
  resentAt: timestamp("resent_at"),
  resentCount: integer("resent_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  country: text("country"),
});

export const jobOffersRelations = relations(jobOffers, ({ one }) => ({
  application: one(applications, {
    fields: [jobOffers.applicationId],
    references: [applications.id],
  }),
  sender: one(users, {
    fields: [jobOffers.sentBy],
    references: [users.id],
  }),
}));

export const insertJobOfferSchema = createInsertSchema(jobOffers).omit({
  id: true,
  createdAt: true,
  acceptedAt: true,
  applicationId: true,
  resentAt: true,
  resentCount: true,
});

export type InsertJobOffer = z.infer<typeof insertJobOfferSchema>;
export type JobOffer = typeof jobOffers.$inferSelect;

export const documentTemplates = pgTable("document_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  htmlBody: text("html_body").notNull(),
  placeholders: text("placeholders").array().notNull().default(sql`ARRAY[]::text[]`),
  theme: text("theme").notNull().default("light"),
  isBuiltIn: boolean("is_built_in").notNull().default(false),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDocumentTemplateSchema = createInsertSchema(documentTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDocumentTemplate = z.infer<typeof insertDocumentTemplateSchema>;
export type DocumentTemplate = typeof documentTemplates.$inferSelect;

export const officialDocuments = pgTable("official_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateId: varchar("template_id").references(() => documentTemplates.id),
  templateName: text("template_name"),
  recipientEmail: text("recipient_email").notNull(),
  recipientName: text("recipient_name").notNull(),
  subject: text("subject"),
  placeholderValues: text("placeholder_values"),
  fileReference: text("file_reference"),
  bmUniqueCode: text("bm_unique_code"),
  accountStatus: text("account_status").default("Verified & Approved for Integration"),
  portalUrl: text("portal_url"),
  username: text("username"),
  tempLoginPassword: text("temp_login_password"),
  tempWithdrawalPassword: text("temp_withdrawal_password"),
  companyName: text("company_name").default("PORTERMETRICS AFFILIATES DEPARTMENT"),
  departmentName: text("department_name").default("Affiliates Operations & Account Integration Division"),
  companyEmail: text("company_email").default("info@portermetricscareeronboarding.com"),
  ccEmail: text("cc_email"),
  sentBy: varchar("sent_by").references(() => users.id),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});

export const insertOfficialDocumentSchema = createInsertSchema(officialDocuments).omit({
  id: true,
  sentAt: true,
});

export type InsertOfficialDocument = z.infer<typeof insertOfficialDocumentSchema>;
export type OfficialDocument = typeof officialDocuments.$inferSelect;

export const smtpAccounts = pgTable("smtp_accounts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(465),
  secure: boolean("secure").notNull().default(true),
  username: text("username").notNull(),
  password: text("password").notNull(),
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name").notNull(),
  companyTagline: text("company_tagline"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSmtpAccountSchema = createInsertSchema(smtpAccounts).omit({
  id: true,
  createdAt: true,
});

export type InsertSmtpAccount = z.infer<typeof insertSmtpAccountSchema>;
export type SmtpAccount = typeof smtpAccounts.$inferSelect;

export const employerStatusEnum = pgEnum("employer_status", ["pending", "active", "suspended"]);
export const employmentTypeEnum = pgEnum("employment_type", ["full_time", "part_time", "contract", "remote"]);
export const jobListingStatusEnum = pgEnum("job_listing_status", ["draft", "pending_approval", "active", "closed", "filled"]);
export const subscriptionTierEnum = pgEnum("subscription_tier", ["starter", "basic", "premium", "custom", "enterprise"]);
export const paymentMethodEnum = pgEnum("payment_method", ["crypto", "bank", "card", "admin_grant"]);
export const paymentStatusEnum = pgEnum("employer_payment_status", ["pending", "approved", "rejected"]);
export const candidateAssignmentStatusEnum = pgEnum("candidate_assignment_status", ["assigned", "onboarding", "completed", "withdrawn"]);

export const employerProfiles = pgTable("employer_profiles", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessName: text("business_name").notNull(),
  businessType: text("business_type"),
  website: text("website"),
  description: text("description"),
  logoUrl: text("logo_url"),
  contactPerson: text("contact_person").notNull(),
  contactPhone: text("contact_phone"),
  status: employerStatusEnum("status").notNull().default("pending"),
  subscriptionTier: subscriptionTierEnum("subscription_tier"),
  candidateSlots: integer("candidate_slots").default(0),
  candidateSlotsUsed: integer("candidate_slots_used").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEmployerProfileSchema = createInsertSchema(employerProfiles).omit({
  id: true,
  createdAt: true,
});

export type InsertEmployerProfile = z.infer<typeof insertEmployerProfileSchema>;
export type EmployerProfile = typeof employerProfiles.$inferSelect;

export const employerPayments = pgTable("employer_payments", {
  id: serial("id").primaryKey(),
  employerId: integer("employer_id").notNull().references(() => employerProfiles.id, { onDelete: "cascade" }),
  amount: text("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  paymentMethod: paymentMethodEnum("payment_method").notNull(),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("pending"),
  proofOfPaymentUrl: text("proof_of_payment_url"),
  tier: subscriptionTierEnum("tier").notNull(),
  candidateSlots: integer("candidate_slots").notNull(),
  adminNotes: text("admin_notes"),
  reviewedBy: varchar("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEmployerPaymentSchema = createInsertSchema(employerPayments).omit({
  id: true,
  createdAt: true,
});

export type InsertEmployerPayment = z.infer<typeof insertEmployerPaymentSchema>;
export type EmployerPayment = typeof employerPayments.$inferSelect;

export const employerJobListings = pgTable("employer_job_listings", {
  id: serial("id").primaryKey(),
  employerId: integer("employer_id").notNull().references(() => employerProfiles.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  requirements: text("requirements"),
  location: text("location"),
  salary: text("salary"),
  employmentType: employmentTypeEnum("employment_type").default("full_time"),
  status: jobListingStatusEnum("status").notNull().default("draft"),
  postedAt: timestamp("posted_at"),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEmployerJobListingSchema = createInsertSchema(employerJobListings).omit({
  id: true,
  createdAt: true,
});

export type InsertEmployerJobListing = z.infer<typeof insertEmployerJobListingSchema>;
export type EmployerJobListing = typeof employerJobListings.$inferSelect;

export const employerCandidateAssignments = pgTable("employer_candidate_assignments", {
  id: serial("id").primaryKey(),
  employerId: integer("employer_id").notNull().references(() => employerProfiles.id, { onDelete: "cascade" }),
  applicantId: varchar("applicant_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  jobListingId: integer("job_listing_id").references(() => employerJobListings.id, { onDelete: "set null" }),
  status: candidateAssignmentStatusEnum("status").notNull().default("assigned"),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  assignedBy: varchar("assigned_by").references(() => users.id),
  notes: text("notes"),
});

export const insertEmployerCandidateAssignmentSchema = createInsertSchema(employerCandidateAssignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertEmployerCandidateAssignment = z.infer<typeof insertEmployerCandidateAssignmentSchema>;
export type EmployerCandidateAssignment = typeof employerCandidateAssignments.$inferSelect;

export const paymentSettings = pgTable("payment_settings", {
  id: serial("id").primaryKey(),
  cryptoWallets: text("crypto_wallets"),
  bankDetails: text("bank_details"),
  cardInstructions: text("card_instructions"),
  instructions: text("instructions"),
  stripeEnabled: boolean("stripe_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export const insertPaymentSettingsSchema = createInsertSchema(paymentSettings).omit({
  id: true,
});

export type InsertPaymentSettings = z.infer<typeof insertPaymentSettingsSchema>;
export type PaymentSettings = typeof paymentSettings.$inferSelect;

export const adminInvites = pgTable("admin_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  role: userRoleEnum("role").notNull().default("admin"),
  invitedBy: varchar("invited_by").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAdminInviteSchema = createInsertSchema(adminInvites).omit({
  id: true,
  createdAt: true,
});

export type InsertAdminInvite = z.infer<typeof insertAdminInviteSchema>;
export type AdminInvite = typeof adminInvites.$inferSelect;
