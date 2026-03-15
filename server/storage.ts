import {
  users,
  applications,
  trainingSessions,
  feedback,
  trainingMaterials,
  activityLogs,
  emailLogs,
  emailFolders,
  sessionAttendance,
  trainerWeeklyAvailability,
  trainerTimeSlots,
  appSettings,
  emailTemplates,
  trainerReminderSettings,
  scheduledReminders,
  pushSubscriptions,
  notifications,
  adminEmailTemplates,
  dashboardWidgets,
  leads,
  leadFolders,
  leadTags,
  leadTagAssignments,
  emailTracking,
  scheduledEmails,
  rescheduleRequests,
  applicantReports,
  type User,
  type InsertUser,
  type Application,
  type InsertApplication,
  type TrainingSession,
  type InsertTrainingSession,
  type Feedback,
  type InsertFeedback,
  type TrainingMaterial,
  type InsertTrainingMaterial,
  type ActivityLog,
  type InsertActivityLog,
  type EmailLog,
  type InsertEmailLog,
  type EmailFolder,
  type InsertEmailFolder,
  type SessionAttendance,
  type InsertSessionAttendance,
  type WeeklyAvailability,
  type InsertWeeklyAvailability,
  type TrainerTimeSlot,
  type InsertTrainerTimeSlot,
  type AppSetting,
  type InsertAppSetting,
  type EmailTemplate,
  type InsertEmailTemplate,
  type TrainerReminderSettings,
  type InsertTrainerReminderSettings,
  type ScheduledReminder,
  type InsertScheduledReminder,
  type PushSubscription as PushSubscriptionType,
  type InsertPushSubscription,
  type Notification,
  type InsertNotification,
  type AdminEmailTemplate,
  type InsertAdminEmailTemplate,
  type DashboardWidget,
  type InsertDashboardWidget,
  type Lead,
  type InsertLead,
  type LeadFolder,
  type InsertLeadFolder,
  type LeadTag,
  type InsertLeadTag,
  type LeadTagAssignment,
  type EmailTracking,
  type ScheduledEmail,
  type InsertScheduledEmail,
  type RescheduleRequest,
  type InsertRescheduleRequest,
  type ApplicantReport,
  type InsertApplicantReport,
  chatbotLogs,
  type ChatbotLog,
  type InsertChatbotLog,
  trainerDailyRecords,
  type TrainerDailyRecord,
  type InsertTrainerDailyRecord,
  siteVisitors,
  type SiteVisitor,
  type InsertSiteVisitor,
  trainingAppointments,
  type TrainingAppointment,
  type InsertTrainingAppointment,
  certificateLogs,
  type CertificateLog,
  type InsertCertificateLog,
  trainerCelebrations,
  type TrainerCelebration,
  type InsertTrainerCelebration,
  traineeFeedback,
  type TraineeFeedback,
  type InsertTraineeFeedback,
  customerReports,
  type CustomerReport,
  type InsertCustomerReport,
  customerReportHistory,
  type CustomerReportHistory,
  type InsertCustomerReportHistory,
  jobOffers,
  type JobOffer,
  type InsertJobOffer,
  officialDocuments,
  type OfficialDocument,
  type InsertOfficialDocument,
  documentTemplates,
  type DocumentTemplate,
  type InsertDocumentTemplate,
  manualTraineeAssignments,
  type ManualTraineeAssignment,
  type InsertManualTraineeAssignment,
  smtpAccounts,
  type SmtpAccount,
  type InsertSmtpAccount,
  employerProfiles,
  type EmployerProfile,
  type InsertEmployerProfile,
  employerPayments,
  type EmployerPayment,
  type InsertEmployerPayment,
  employerJobListings,
  type EmployerJobListing,
  type InsertEmployerJobListing,
  employerCandidateAssignments,
  type EmployerCandidateAssignment,
  type InsertEmployerCandidateAssignment,
  paymentSettings,
  type PaymentSettings,
  type InsertPaymentSettings,
  adminInvites,
  type AdminInvite,
  type InsertAdminInvite,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, or, desc, sql, inArray, ilike, isNotNull, type SQL } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByReferralCode(code: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  getUsersByRole(role: string): Promise<User[]>;
  certifyTrainer(id: string): Promise<User | undefined>;
  resetUserPassword(id: string, newPassword: string): Promise<User | undefined>;
  getUserByResetToken(token: string): Promise<User | undefined>;
  approveUser(id: string): Promise<User | undefined>;
  
  getApplication(id: string): Promise<Application | undefined>;
  getApplicationByApplicantId(applicantId: string): Promise<Application | undefined>;
  getApplicationByCertificateId(certificateId: string): Promise<Application | undefined>;
  getAllApplications(): Promise<Application[]>;
  createApplication(application: InsertApplication): Promise<Application>;
  updateApplication(id: string, data: Partial<InsertApplication>): Promise<Application | undefined>;
  
  getTrainingSession(id: string): Promise<TrainingSession | undefined>;
  getAllTrainingSessions(): Promise<TrainingSession[]>;
  getTrainingSessionsByTrainer(trainerId: string): Promise<TrainingSession[]>;
  createTrainingSession(session: InsertTrainingSession): Promise<TrainingSession>;
  updateTrainingSession(id: string, data: Partial<InsertTrainingSession>): Promise<TrainingSession | undefined>;
  
  createFeedback(feedbackData: InsertFeedback): Promise<Feedback>;
  getFeedbackByEmail(email: string): Promise<Feedback | undefined>;
  getAllFeedback(): Promise<Feedback[]>;
  
  deleteUser(id: string): Promise<boolean>;
  deleteApplication(id: string): Promise<boolean>;
  deleteTrainingSession(id: string): Promise<boolean>;
  
  // Archive Methods
  archiveTrainingSession(id: string): Promise<TrainingSession | undefined>;
  unarchiveTrainingSession(id: string): Promise<TrainingSession | undefined>;
  getArchivedSessions(): Promise<TrainingSession[]>;
  
  // Training Materials
  getTrainingMaterial(id: string): Promise<TrainingMaterial | undefined>;
  getTrainingMaterialsByTrainer(trainerId: string): Promise<TrainingMaterial[]>;
  getAllTrainingMaterials(): Promise<TrainingMaterial[]>;
  createTrainingMaterial(material: InsertTrainingMaterial): Promise<TrainingMaterial>;
  deleteTrainingMaterial(id: string): Promise<boolean>;
  updateTrainingMaterial(id: string, updates: { category?: string; sortOrder?: number; isRequired?: string }): Promise<TrainingMaterial | undefined>;
  reorderTrainingMaterials(materials: { id: string; category: string; sortOrder: number }[]): Promise<void>;
  incrementMaterialDownloadCount(id: string): Promise<void>;
  
  // Activity Logs
  createActivityLog(log: InsertActivityLog): Promise<ActivityLog>;
  getActivityLogs(limit?: number): Promise<ActivityLog[]>;
  getActivityLog(id: string): Promise<ActivityLog | undefined>;
  markActivityLogUndone(id: string, undoneBy: string): Promise<ActivityLog | undefined>;
  
  // Email Folders
  getAllEmailFolders(): Promise<EmailFolder[]>;
  getEmailFolder(id: string): Promise<EmailFolder | undefined>;
  createEmailFolder(folder: InsertEmailFolder): Promise<EmailFolder>;
  updateEmailFolder(id: string, data: Partial<InsertEmailFolder>): Promise<EmailFolder | undefined>;
  deleteEmailFolder(id: string): Promise<boolean>;
  
  // Email Logs
  createEmailLog(log: InsertEmailLog): Promise<EmailLog>;
  getAllEmailLogs(limit?: number): Promise<EmailLog[]>;
  getEmailLogsByRecipient(email: string): Promise<EmailLog[]>;
  checkDuplicateEmails(recipientEmails: string[], subject: string): Promise<Set<string>>;
  getEmailLogsByFolder(folderId: string, limit?: number): Promise<EmailLog[]>;
  getArchivedEmails(limit?: number, offset?: number): Promise<{ emails: EmailLog[]; total: number }>;
  moveEmailToFolder(emailId: string, folderId: string | null): Promise<EmailLog | undefined>;
  archiveEmail(emailId: string): Promise<EmailLog | undefined>;
  archiveEmailsByIds(emailIds: string[]): Promise<number>;
  unarchiveEmail(emailId: string): Promise<EmailLog | undefined>;
  updateEmailFolderCounts(): Promise<void>;
  getLeadEmailLogs(options?: { leadId?: string; status?: string; emailType?: string; search?: string; limit?: number; offset?: number }): Promise<{ logs: EmailLog[]; total: number }>;
  getEmailsSentToday(): Promise<number>;
  
  // Session Attendance
  createSessionAttendance(attendance: InsertSessionAttendance): Promise<SessionAttendance>;
  getSessionAttendance(sessionId: string): Promise<SessionAttendance[]>;
  getAllSessionAttendance(): Promise<SessionAttendance[]>;
  updateAttendanceStatus(id: string, status: "registered" | "attended" | "no_show" | "cancelled", markedBy: string, notes?: string): Promise<SessionAttendance | undefined>;
  
  // Weekly Availability
  getWeeklyAvailability(id: string): Promise<WeeklyAvailability | undefined>;
  getWeeklyAvailabilityByTrainer(trainerId: string): Promise<WeeklyAvailability[]>;
  getAllWeeklyAvailability(): Promise<WeeklyAvailability[]>;
  createWeeklyAvailability(availability: InsertWeeklyAvailability): Promise<WeeklyAvailability>;
  updateWeeklyAvailability(id: string, data: Partial<InsertWeeklyAvailability>): Promise<WeeklyAvailability | undefined>;
  deleteWeeklyAvailability(id: string): Promise<boolean>;
  
  // Trainer Time Slots
  getTimeSlotsByTrainer(trainerId: string): Promise<TrainerTimeSlot[]>;
  getAllTimeSlots(): Promise<TrainerTimeSlot[]>;
  updateTimeSlot(id: string, data: Partial<InsertTrainerTimeSlot>): Promise<TrainerTimeSlot | undefined>;
  deleteTimeSlot(id: string): Promise<boolean>;
  initializeTrainerTimeSlots(trainerId: string): Promise<TrainerTimeSlot[]>;
  
  // App Settings
  getAppSetting(key: string): Promise<AppSetting | undefined>;
  getAllAppSettings(): Promise<AppSetting[]>;
  getAppSettingsByCategory(category: string): Promise<AppSetting[]>;
  upsertAppSetting(key: string, value: string, category: string, description?: string, updatedBy?: string): Promise<AppSetting>;
  deleteAppSetting(key: string): Promise<boolean>;
  
  // Email Templates
  getEmailTemplate(id: string): Promise<EmailTemplate | undefined>;
  getEmailTemplatesByTrainer(trainerId: string): Promise<EmailTemplate[]>;
  getAllEmailTemplates(): Promise<EmailTemplate[]>;
  createEmailTemplate(template: InsertEmailTemplate): Promise<EmailTemplate>;
  updateEmailTemplate(id: string, data: Partial<InsertEmailTemplate>): Promise<EmailTemplate | undefined>;
  deleteEmailTemplate(id: string): Promise<boolean>;
  
  // Trainer Reminder Settings
  getReminderSettings(trainerId: string): Promise<TrainerReminderSettings | undefined>;
  upsertReminderSettings(trainerId: string, settings: Partial<InsertTrainerReminderSettings>): Promise<TrainerReminderSettings>;
  
  // Scheduled Reminders
  createScheduledReminder(reminder: InsertScheduledReminder): Promise<ScheduledReminder>;
  getScheduledRemindersByTrainer(trainerId: string): Promise<ScheduledReminder[]>;
  getAllScheduledReminders(): Promise<ScheduledReminder[]>;
  getExistingReminder(trainerId: string, sessionId: string | undefined, reminderType: string): Promise<ScheduledReminder | undefined>;
  
  // Push Subscriptions
  createPushSubscription(subscription: InsertPushSubscription): Promise<PushSubscriptionType>;
  getPushSubscriptionsByUser(userId: string): Promise<PushSubscriptionType[]>;
  getPushSubscriptionByEndpoint(endpoint: string): Promise<PushSubscriptionType | undefined>;
  getActivePushSubscriptionsByRole(role: string): Promise<PushSubscriptionType[]>;
  updatePushSubscription(id: string, data: Partial<InsertPushSubscription>): Promise<PushSubscriptionType | undefined>;
  deletePushSubscription(id: string): Promise<boolean>;
  deletePushSubscriptionByEndpoint(endpoint: string): Promise<boolean>;
  
  // Notifications
  createNotification(notification: InsertNotification): Promise<Notification>;
  getNotificationsByUser(userId: string): Promise<Notification[]>;
  getUnreadNotificationCount(userId: string): Promise<number>;
  markNotificationAsRead(id: string): Promise<Notification | undefined>;
  markAllNotificationsAsRead(userId: string): Promise<void>;
  deleteNotification(id: string): Promise<boolean>;
  deleteAllNotifications(userId: string): Promise<boolean>;
  
  // Admin Email Templates
  getAdminEmailTemplate(id: string): Promise<AdminEmailTemplate | undefined>;
  getAdminEmailTemplatesByAdmin(adminId: string): Promise<AdminEmailTemplate[]>;
  getAllAdminEmailTemplates(): Promise<AdminEmailTemplate[]>;
  createAdminEmailTemplate(template: InsertAdminEmailTemplate): Promise<AdminEmailTemplate>;
  updateAdminEmailTemplate(id: string, data: Partial<InsertAdminEmailTemplate>): Promise<AdminEmailTemplate | undefined>;
  deleteAdminEmailTemplate(id: string): Promise<boolean>;
  
  // Leads
  getLead(id: string): Promise<Lead | undefined>;
  getLeadByEmail(email: string): Promise<Lead | undefined>;
  getAllLeads(): Promise<Lead[]>;
  getLeadsByStatus(status: string): Promise<Lead[]>;
  createLead(lead: InsertLead): Promise<Lead>;
  updateLead(id: string, data: Partial<InsertLead>): Promise<Lead | undefined>;
  deleteLead(id: string): Promise<boolean>;

  // Lead Folders
  createLeadFolder(folder: InsertLeadFolder): Promise<LeadFolder>;
  getAllLeadFolders(): Promise<LeadFolder[]>;
  updateLeadFolder(id: string, data: Partial<InsertLeadFolder>): Promise<LeadFolder | undefined>;
  deleteLeadFolder(id: string): Promise<boolean>;
  updateLeadFolderCount(id: string): Promise<void>;

  // Lead Tags
  getAllLeadTags(): Promise<LeadTag[]>;
  createLeadTag(tag: InsertLeadTag): Promise<LeadTag>;
  deleteLeadTag(id: string): Promise<boolean>;
  assignTagToLead(leadId: string, tagId: string): Promise<void>;
  removeTagFromLead(leadId: string, tagId: string): Promise<void>;
  getTagsForLead(leadId: string): Promise<LeadTag[]>;
  getLeadsByTag(tagId: string): Promise<Lead[]>;

  // Email Tracking
  createEmailTracking(data: { leadId?: string | null; emailLogId?: string; type: string; url?: string; userAgent?: string; ipAddress?: string }): Promise<EmailTracking>;
  getEmailTrackingByLead(leadId: string): Promise<EmailTracking[]>;
  getEmailTrackingStats(): Promise<{ opens: number; clicks: number; uniqueOpens: number; uniqueClicks: number }>;

  // Scheduled Emails
  createScheduledEmail(data: InsertScheduledEmail): Promise<ScheduledEmail>;
  getScheduledEmails(): Promise<ScheduledEmail[]>;
  updateScheduledEmail(id: string, data: Partial<ScheduledEmail>): Promise<ScheduledEmail | undefined>;
  deleteScheduledEmail(id: string): Promise<boolean>;

  // Reschedule Requests
  createRescheduleRequest(request: InsertRescheduleRequest): Promise<RescheduleRequest>;
  getAllRescheduleRequests(): Promise<RescheduleRequest[]>;
  getRescheduleRequestsByTrainee(traineeId: string): Promise<RescheduleRequest[]>;
  updateRescheduleRequest(id: string, data: Partial<InsertRescheduleRequest> & { reviewedAt?: Date }): Promise<RescheduleRequest | undefined>;

  // Applicant Reports
  getAllApplicantReports(): Promise<ApplicantReport[]>;
  createApplicantReport(report: InsertApplicantReport): Promise<ApplicantReport>;
  updateApplicantReport(id: string, data: Partial<InsertApplicantReport>): Promise<ApplicantReport | undefined>;
  deleteApplicantReport(id: string): Promise<boolean>;

  // Chatbot Logs
  createChatbotLog(log: InsertChatbotLog): Promise<ChatbotLog>;
  getChatbotLogsPaginated(options: { page: number; limit: number; search?: string }): Promise<{ data: ChatbotLog[]; total: number; page: number; totalPages: number }>;
  updateChatbotLogFeedback(id: string, feedback: string): Promise<ChatbotLog | undefined>;
  getChatbotStats(): Promise<{ totalConversations: number; totalQuestions: number; uniqueSessions: number; positiveCount: number; negativeCount: number }>;

  // Trainer Daily Records
  createTrainerDailyRecord(record: InsertTrainerDailyRecord): Promise<TrainerDailyRecord>;
  getTrainerDailyRecords(trainerId: string): Promise<TrainerDailyRecord[]>;
  getAllTrainerDailyRecords(): Promise<TrainerDailyRecord[]>;
  getTrainerDailyRecordByDate(trainerId: string, date: string): Promise<TrainerDailyRecord | undefined>;
  updateTrainerDailyRecord(id: string, data: Partial<InsertTrainerDailyRecord>): Promise<TrainerDailyRecord | undefined>;
  deleteTrainerDailyRecord(id: string): Promise<boolean>;

  // Site Visitors
  trackSiteVisitor(visitor: InsertSiteVisitor): Promise<{ visitor: SiteVisitor; isNew: boolean }>;
  getSiteVisitors(options: { page: number; limit: number; }): Promise<{ data: SiteVisitor[]; total: number; page: number; totalPages: number }>;
  getSiteVisitorStats(): Promise<{ totalVisits: number; uniqueVisitors: number; todayVisits: number; todayUnique: number; topPages: { page: string; count: number }[]; topCountries: { country: string; count: number }[]; recentVisitors: SiteVisitor[] }>;
  linkVisitorToApplicant(ipAddress: string, applicantName: string): Promise<void>;

  // Training Appointments
  createTrainingAppointment(appointment: InsertTrainingAppointment): Promise<TrainingAppointment>;
  getTrainingAppointment(id: string): Promise<TrainingAppointment | undefined>;
  getTrainingAppointmentsByApplicant(applicantId: string): Promise<TrainingAppointment[]>;
  getAllTrainingAppointments(): Promise<TrainingAppointment[]>;
  getPendingTrainingAppointments(): Promise<TrainingAppointment[]>;
  updateTrainingAppointment(id: string, data: Partial<TrainingAppointment>): Promise<TrainingAppointment | undefined>;

  // Certificate Logs
  createCertificateLog(log: InsertCertificateLog): Promise<CertificateLog>;
  getCertificateLogs(): Promise<CertificateLog[]>;
  getCertificateLogsByApplication(applicationId: string): Promise<CertificateLog[]>;

  // Trainer Celebrations
  createTrainerCelebration(celebration: InsertTrainerCelebration): Promise<TrainerCelebration>;
  getTrainerCelebrations(limit?: number): Promise<TrainerCelebration[]>;
  getVisibleCelebrations(limit?: number): Promise<TrainerCelebration[]>;
  updateTrainerCelebration(id: string, updates: Partial<InsertTrainerCelebration>): Promise<TrainerCelebration>;
  deleteTrainerCelebration(id: string): Promise<boolean>;

  // Trainer Leaderboard
  getTrainerLeaderboard(): Promise<Array<{ trainerId: string; trainerName: string; completedTrainings: number; assignedTrainees: number; startedWorking: number }>>;

  // Trainee Feedback
  createTraineeFeedback(data: InsertTraineeFeedback): Promise<TraineeFeedback>;
  getTraineeFeedbackByToken(token: string): Promise<TraineeFeedback | undefined>;
  submitTraineeFeedback(token: string, data: { overallRating: number; communicationRating?: number; knowledgeRating?: number; helpfulnessRating?: number; comment?: string; wouldRecommend?: string }): Promise<TraineeFeedback | undefined>;
  getTraineeFeedbackByTrainer(trainerId: string): Promise<TraineeFeedback[]>;
  getAllTraineeFeedback(): Promise<TraineeFeedback[]>;

  // Paginated queries
  getApplicationsPaginated(options: { page: number; limit: number; status?: string; trainingStatus?: string; search?: string; trainerId?: string }): Promise<{ data: Application[]; total: number; page: number; totalPages: number }>;
  getLeadsPaginated(options: { page: number; limit: number; status?: string; search?: string; folderId?: string }): Promise<{ data: Lead[]; total: number; page: number; totalPages: number }>;

  // Manual Trainee Assignments
  createManualTraineeAssignment(data: InsertManualTraineeAssignment): Promise<ManualTraineeAssignment>;
  getAllManualTraineeAssignments(): Promise<ManualTraineeAssignment[]>;
  getManualTraineeAssignmentsByTrainer(trainerId: string): Promise<ManualTraineeAssignment[]>;
  updateManualTraineeAssignmentStatus(id: string, status: string): Promise<ManualTraineeAssignment | undefined>;
  deleteManualTraineeAssignment(id: string): Promise<boolean>;

  // SMTP Accounts
  getSmtpAccounts(): Promise<SmtpAccount[]>;
  getSmtpAccount(id: number): Promise<SmtpAccount | undefined>;
  createSmtpAccount(data: InsertSmtpAccount): Promise<SmtpAccount>;
  updateSmtpAccount(id: number, data: Partial<InsertSmtpAccount>): Promise<SmtpAccount | undefined>;
  deleteSmtpAccount(id: number): Promise<boolean>;

  // Employer Profiles
  createEmployerProfile(data: InsertEmployerProfile): Promise<EmployerProfile>;
  getEmployerProfile(id: number): Promise<EmployerProfile | undefined>;
  getEmployerProfileByUserId(userId: string): Promise<EmployerProfile | undefined>;
  getAllEmployerProfiles(): Promise<EmployerProfile[]>;
  updateEmployerProfile(id: number, data: Partial<InsertEmployerProfile>): Promise<EmployerProfile | undefined>;

  // Employer Payments
  createEmployerPayment(data: InsertEmployerPayment): Promise<EmployerPayment>;
  getEmployerPayment(id: number): Promise<EmployerPayment | undefined>;
  getEmployerPaymentsByEmployer(employerId: number): Promise<EmployerPayment[]>;
  getAllEmployerPayments(): Promise<EmployerPayment[]>;
  updateEmployerPaymentStatus(id: number, data: { paymentStatus: string; adminNotes?: string; reviewedBy?: string; reviewedAt?: Date }): Promise<EmployerPayment | undefined>;

  // Employer Job Listings
  createEmployerJobListing(data: InsertEmployerJobListing): Promise<EmployerJobListing>;
  getEmployerJobListing(id: number): Promise<EmployerJobListing | undefined>;
  getEmployerJobListingsByEmployer(employerId: number): Promise<EmployerJobListing[]>;
  getAllEmployerJobListings(): Promise<EmployerJobListing[]>;
  getActiveEmployerJobListings(): Promise<(EmployerJobListing & { businessName: string | null })[]>;
  updateEmployerJobListing(id: number, data: Partial<InsertEmployerJobListing>): Promise<EmployerJobListing | undefined>;
  deleteEmployerJobListing(id: number): Promise<boolean>;

  // Employer Candidate Assignments
  createEmployerCandidateAssignment(data: InsertEmployerCandidateAssignment): Promise<EmployerCandidateAssignment>;
  getEmployerCandidateAssignmentsByEmployer(employerId: number): Promise<EmployerCandidateAssignment[]>;
  getEmployerCandidateAssignmentsByApplicant(applicantId: string): Promise<EmployerCandidateAssignment[]>;
  getAllEmployerCandidateAssignments(): Promise<EmployerCandidateAssignment[]>;
  updateEmployerCandidateAssignment(id: number, data: Partial<InsertEmployerCandidateAssignment>): Promise<EmployerCandidateAssignment | undefined>;
  deleteEmployerCandidateAssignment(id: number): Promise<boolean>;

  // Payment Settings
  getPaymentSettings(): Promise<PaymentSettings | undefined>;
  upsertPaymentSettings(data: Partial<InsertPaymentSettings>): Promise<PaymentSettings>;

  // Admin Invites
  createAdminInvite(invite: InsertAdminInvite): Promise<AdminInvite>;
  getAdminInviteByToken(token: string): Promise<AdminInvite | undefined>;
  getAllAdminInvites(): Promise<AdminInvite[]>;
  markAdminInviteUsed(id: string): Promise<AdminInvite | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(sql`LOWER(${users.email}) = LOWER(${email})`);
    return user || undefined;
  }

  async getUserByReferralCode(code: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.referralCode, code));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined> {
    const [user] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return user || undefined;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async getUsersByRole(role: string): Promise<User[]> {
    return await db.select().from(users).where(eq(users.role, role as any));
  }

  async certifyTrainer(id: string): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ isCertified: "true", certifiedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  async resetUserPassword(id: string, newPassword: string): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ 
        password: newPassword,
        resetToken: sql`NULL`,
        resetTokenExpiry: sql`NULL`
      })
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  async getUserByResetToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.resetToken, token));
    return user || undefined;
  }

  async approveUser(id: string): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ isApproved: "true", approvedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  async getApplication(id: string): Promise<Application | undefined> {
    const [application] = await db.select().from(applications).where(eq(applications.id, id));
    return application || undefined;
  }

  async getApplicationByApplicantId(applicantId: string): Promise<Application | undefined> {
    const [application] = await db.select().from(applications).where(eq(applications.applicantId, applicantId));
    return application || undefined;
  }

  async getApplicationByCertificateId(certificateId: string): Promise<Application | undefined> {
    const [application] = await db.select().from(applications).where(eq(applications.certificateId, certificateId));
    return application || undefined;
  }

  async getAllApplications(): Promise<Application[]> {
    return await db.select().from(applications).orderBy(desc(applications.appliedAt));
  }

  async createApplication(insertApplication: InsertApplication): Promise<Application> {
    const [application] = await db.insert(applications).values(insertApplication).returning();
    return application;
  }

  async updateApplication(id: string, data: Partial<InsertApplication>): Promise<Application | undefined> {
    const [application] = await db.update(applications).set(data).where(eq(applications.id, id)).returning();
    return application || undefined;
  }

  async getTrainingSession(id: string): Promise<TrainingSession | undefined> {
    const [session] = await db.select().from(trainingSessions).where(eq(trainingSessions.id, id));
    return session || undefined;
  }

  async getAllTrainingSessions(): Promise<TrainingSession[]> {
    return await db.select().from(trainingSessions).where(
      sql`${trainingSessions.isArchived} = 'false' OR ${trainingSessions.isArchived} IS NULL`
    );
  }

  async getTrainingSessionsByTrainer(trainerId: string): Promise<TrainingSession[]> {
    return await db.select().from(trainingSessions).where(
      and(
        eq(trainingSessions.trainerId, trainerId),
        sql`(${trainingSessions.isArchived} = 'false' OR ${trainingSessions.isArchived} IS NULL)`
      )
    );
  }

  async createTrainingSession(insertSession: InsertTrainingSession): Promise<TrainingSession> {
    const [session] = await db.insert(trainingSessions).values(insertSession).returning();
    return session;
  }

  async updateTrainingSession(id: string, data: Partial<InsertTrainingSession>): Promise<TrainingSession | undefined> {
    const [session] = await db.update(trainingSessions).set(data).where(eq(trainingSessions.id, id)).returning();
    return session || undefined;
  }

  async createFeedback(feedbackData: InsertFeedback): Promise<Feedback> {
    const [newFeedback] = await db.insert(feedback).values(feedbackData).returning();
    return newFeedback;
  }

  async getFeedbackByEmail(email: string): Promise<Feedback | undefined> {
    const [result] = await db.select().from(feedback).where(eq(feedback.email, email));
    return result || undefined;
  }

  async getAllFeedback(): Promise<Feedback[]> {
    return await db.select().from(feedback).orderBy(desc(feedback.createdAt));
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id));
    return true;
  }

  async deleteApplication(id: string): Promise<boolean> {
    const result = await db.delete(applications).where(eq(applications.id, id));
    return true;
  }

  async deleteTrainingSession(id: string): Promise<boolean> {
    const result = await db.delete(trainingSessions).where(eq(trainingSessions.id, id));
    return true;
  }

  async archiveTrainingSession(id: string): Promise<TrainingSession | undefined> {
    const [session] = await db.update(trainingSessions)
      .set({ isArchived: "true", archivedAt: new Date() })
      .where(eq(trainingSessions.id, id))
      .returning();
    return session || undefined;
  }

  async unarchiveTrainingSession(id: string): Promise<TrainingSession | undefined> {
    const [session] = await db.update(trainingSessions)
      .set({ isArchived: "false", archivedAt: null })
      .where(eq(trainingSessions.id, id))
      .returning();
    return session || undefined;
  }

  async getArchivedSessions(): Promise<TrainingSession[]> {
    return db.select().from(trainingSessions).where(eq(trainingSessions.isArchived, "true"));
  }

  async getTrainingMaterial(id: string): Promise<TrainingMaterial | undefined> {
    const [material] = await db.select().from(trainingMaterials).where(eq(trainingMaterials.id, id));
    return material || undefined;
  }

  async getTrainingMaterialsByTrainer(trainerId: string): Promise<TrainingMaterial[]> {
    return await db.select().from(trainingMaterials).where(eq(trainingMaterials.trainerId, trainerId)).orderBy(desc(trainingMaterials.createdAt));
  }

  async getAllTrainingMaterials(): Promise<TrainingMaterial[]> {
    return await db.select().from(trainingMaterials).orderBy(desc(trainingMaterials.createdAt));
  }

  async createTrainingMaterial(material: InsertTrainingMaterial): Promise<TrainingMaterial> {
    const [newMaterial] = await db.insert(trainingMaterials).values(material).returning();
    return newMaterial;
  }

  async deleteTrainingMaterial(id: string): Promise<boolean> {
    await db.delete(trainingMaterials).where(eq(trainingMaterials.id, id));
    return true;
  }

  async updateTrainingMaterial(id: string, updates: { category?: string; sortOrder?: number; isRequired?: string }): Promise<TrainingMaterial | undefined> {
    const [updated] = await db.update(trainingMaterials)
      .set(updates)
      .where(eq(trainingMaterials.id, id))
      .returning();
    return updated || undefined;
  }

  async reorderTrainingMaterials(materials: { id: string; category: string; sortOrder: number }[]): Promise<void> {
    for (const material of materials) {
      await db.update(trainingMaterials)
        .set({ category: material.category, sortOrder: material.sortOrder })
        .where(eq(trainingMaterials.id, material.id));
    }
  }

  async incrementMaterialDownloadCount(id: string): Promise<void> {
    await db.update(trainingMaterials)
      .set({ downloadCount: sql`COALESCE(${trainingMaterials.downloadCount}, 0) + 1` })
      .where(eq(trainingMaterials.id, id));
  }

  async createActivityLog(log: InsertActivityLog): Promise<ActivityLog> {
    const [newLog] = await db.insert(activityLogs).values(log).returning();
    return newLog;
  }

  async getActivityLogs(limit: number = 100): Promise<ActivityLog[]> {
    return await db.select().from(activityLogs).orderBy(desc(activityLogs.createdAt)).limit(limit);
  }

  async getActivityLog(id: string): Promise<ActivityLog | undefined> {
    const [log] = await db.select().from(activityLogs).where(eq(activityLogs.id, id));
    return log;
  }

  async markActivityLogUndone(id: string, undoneBy: string): Promise<ActivityLog | undefined> {
    const [updated] = await db.update(activityLogs).set({ isUndone: "true", undoneAt: new Date(), undoneBy }).where(eq(activityLogs.id, id)).returning();
    return updated;
  }

  // Email Folders
  async getAllEmailFolders(): Promise<EmailFolder[]> {
    return await db.select().from(emailFolders).orderBy(emailFolders.createdAt);
  }

  async getEmailFolder(id: string): Promise<EmailFolder | undefined> {
    const [folder] = await db.select().from(emailFolders).where(eq(emailFolders.id, id));
    return folder || undefined;
  }

  async createEmailFolder(folder: InsertEmailFolder): Promise<EmailFolder> {
    const [newFolder] = await db.insert(emailFolders).values(folder).returning();
    return newFolder;
  }

  async updateEmailFolder(id: string, data: Partial<InsertEmailFolder>): Promise<EmailFolder | undefined> {
    const [folder] = await db.update(emailFolders).set(data).where(eq(emailFolders.id, id)).returning();
    return folder || undefined;
  }

  async deleteEmailFolder(id: string): Promise<boolean> {
    await db.update(emailLogs).set({ folderId: null }).where(eq(emailLogs.folderId, id));
    await db.delete(emailFolders).where(eq(emailFolders.id, id));
    return true;
  }

  // Email Logs
  async createEmailLog(log: InsertEmailLog): Promise<EmailLog> {
    const [newLog] = await db.insert(emailLogs).values(log).returning();
    return newLog;
  }

  async getAllEmailLogs(limit: number = 100): Promise<EmailLog[]> {
    return await db.select().from(emailLogs).orderBy(desc(emailLogs.createdAt)).limit(limit);
  }

  async getEmailLogsByRecipient(email: string): Promise<EmailLog[]> {
    return await db.select().from(emailLogs).where(eq(emailLogs.recipientEmail, email)).orderBy(desc(emailLogs.createdAt));
  }

  async checkDuplicateEmails(recipientEmails: string[], subject: string): Promise<Set<string>> {
    if (recipientEmails.length === 0) return new Set();
    const existing = await db.select({ recipientEmail: emailLogs.recipientEmail })
      .from(emailLogs)
      .where(
        and(
          inArray(emailLogs.recipientEmail, recipientEmails),
          eq(emailLogs.subject, subject),
          eq(emailLogs.status, "sent")
        )
      );
    return new Set(existing.map(e => e.recipientEmail.toLowerCase()));
  }

  async getEmailLogsByFolder(folderId: string, limit: number = 100): Promise<EmailLog[]> {
    return await db.select().from(emailLogs).where(eq(emailLogs.folderId, folderId)).orderBy(desc(emailLogs.createdAt)).limit(limit);
  }

  async getArchivedEmails(limit: number = 50, offset: number = 0): Promise<{ emails: EmailLog[]; total: number }> {
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(emailLogs).where(eq(emailLogs.isArchived, true));
    const emails = await db.select().from(emailLogs).where(eq(emailLogs.isArchived, true)).orderBy(desc(emailLogs.createdAt)).limit(limit).offset(offset);
    return { emails, total: Number(countResult?.count || 0) };
  }

  async moveEmailToFolder(emailId: string, folderId: string | null): Promise<EmailLog | undefined> {
    const [log] = await db.update(emailLogs).set({ folderId }).where(eq(emailLogs.id, emailId)).returning();
    return log || undefined;
  }

  async archiveEmail(emailId: string): Promise<EmailLog | undefined> {
    const [log] = await db.update(emailLogs).set({ isArchived: true, archivedAt: new Date() }).where(eq(emailLogs.id, emailId)).returning();
    return log || undefined;
  }

  async archiveEmailsByIds(emailIds: string[]): Promise<number> {
    if (emailIds.length === 0) return 0;
    const result = await db.update(emailLogs).set({ isArchived: true, archivedAt: new Date() }).where(inArray(emailLogs.id, emailIds)).returning();
    return result.length;
  }

  async unarchiveEmail(emailId: string): Promise<EmailLog | undefined> {
    const [log] = await db.update(emailLogs).set({ isArchived: false, archivedAt: null }).where(eq(emailLogs.id, emailId)).returning();
    return log || undefined;
  }

  async updateEmailFolderCounts(): Promise<void> {
    const folders = await db.select().from(emailFolders);
    for (const folder of folders) {
      const [result] = await db.select({ count: sql<number>`count(*)` }).from(emailLogs).where(eq(emailLogs.folderId, folder.id));
      await db.update(emailFolders).set({ emailCount: Number(result?.count || 0) }).where(eq(emailFolders.id, folder.id));
    }
  }

  async getLeadEmailLogs(options: { leadId?: string; status?: string; emailType?: string; search?: string; limit?: number; offset?: number } = {}): Promise<{ logs: EmailLog[]; total: number }> {
    const { leadId, status, emailType, search, limit = 50, offset = 0 } = options;
    const leadEmailSubquery = db.select({ email: leads.email }).from(leads);
    const baseCondition = leadId 
      ? eq(emailLogs.leadId, leadId)
      : or(
          isNotNull(emailLogs.leadId),
          ilike(emailLogs.emailType, 'lead_%'),
          inArray(emailLogs.recipientEmail, leadEmailSubquery)
        )!;
    const conditions: SQL[] = [baseCondition];
    if (status) conditions.push(eq(emailLogs.status, status as any));
    if (emailType) conditions.push(eq(emailLogs.emailType, emailType));
    if (search) {
      conditions.push(
        or(
          ilike(emailLogs.recipientEmail, `%${search}%`),
          ilike(emailLogs.recipientName, `%${search}%`),
          ilike(emailLogs.subject, `%${search}%`)
        )!
      );
    }
    const where = and(...conditions);
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(emailLogs).where(where);
    const logs = await db.select().from(emailLogs).where(where).orderBy(desc(emailLogs.createdAt)).limit(limit).offset(offset);
    return { logs, total: Number(countResult?.count || 0) };
  }

  async getEmailsSentToday(): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [result] = await db.select({ count: sql<number>`count(*)` })
      .from(emailLogs)
      .where(and(
        eq(emailLogs.status, "sent"),
        sql`${emailLogs.createdAt} >= ${today}`
      ));
    return Number(result?.count || 0);
  }

  // Session Attendance
  async createSessionAttendance(attendance: InsertSessionAttendance): Promise<SessionAttendance> {
    const [newAttendance] = await db.insert(sessionAttendance).values(attendance).returning();
    return newAttendance;
  }

  async getSessionAttendance(sessionId: string): Promise<SessionAttendance[]> {
    return await db.select().from(sessionAttendance).where(eq(sessionAttendance.sessionId, sessionId)).orderBy(desc(sessionAttendance.createdAt));
  }

  async getAllSessionAttendance(): Promise<SessionAttendance[]> {
    return await db.select().from(sessionAttendance).orderBy(desc(sessionAttendance.createdAt));
  }

  async updateAttendanceStatus(id: string, status: "registered" | "attended" | "no_show" | "cancelled", markedBy: string, notes?: string): Promise<SessionAttendance | undefined> {
    const [attendance] = await db.update(sessionAttendance)
      .set({ status, markedBy, markedAt: new Date(), notes })
      .where(eq(sessionAttendance.id, id))
      .returning();
    return attendance || undefined;
  }

  // Weekly Availability
  async getWeeklyAvailability(id: string): Promise<WeeklyAvailability | undefined> {
    const [availability] = await db.select().from(trainerWeeklyAvailability).where(eq(trainerWeeklyAvailability.id, id));
    return availability || undefined;
  }

  async getWeeklyAvailabilityByTrainer(trainerId: string): Promise<WeeklyAvailability[]> {
    return await db.select().from(trainerWeeklyAvailability)
      .where(eq(trainerWeeklyAvailability.trainerId, trainerId))
      .orderBy(trainerWeeklyAvailability.dayOfWeek);
  }

  async getAllWeeklyAvailability(): Promise<WeeklyAvailability[]> {
    return await db.select().from(trainerWeeklyAvailability).orderBy(trainerWeeklyAvailability.dayOfWeek);
  }

  async createWeeklyAvailability(availability: InsertWeeklyAvailability): Promise<WeeklyAvailability> {
    const [newAvailability] = await db.insert(trainerWeeklyAvailability).values(availability).returning();
    return newAvailability;
  }

  async updateWeeklyAvailability(id: string, data: Partial<InsertWeeklyAvailability>): Promise<WeeklyAvailability | undefined> {
    const [availability] = await db.update(trainerWeeklyAvailability)
      .set(data)
      .where(eq(trainerWeeklyAvailability.id, id))
      .returning();
    return availability || undefined;
  }

  async deleteWeeklyAvailability(id: string): Promise<boolean> {
    const result = await db.delete(trainerWeeklyAvailability).where(eq(trainerWeeklyAvailability.id, id));
    return true;
  }

  // Trainer Time Slots
  async getTimeSlotsByTrainer(trainerId: string): Promise<TrainerTimeSlot[]> {
    return await db.select().from(trainerTimeSlots)
      .where(eq(trainerTimeSlots.trainerId, trainerId))
      .orderBy(trainerTimeSlots.dayOfWeek, trainerTimeSlots.hour);
  }

  async getAllTimeSlots(): Promise<TrainerTimeSlot[]> {
    return await db.select().from(trainerTimeSlots)
      .orderBy(trainerTimeSlots.trainerId, trainerTimeSlots.dayOfWeek, trainerTimeSlots.hour);
  }

  async updateTimeSlot(id: string, data: Partial<InsertTrainerTimeSlot>): Promise<TrainerTimeSlot | undefined> {
    const [slot] = await db.update(trainerTimeSlots)
      .set(data)
      .where(eq(trainerTimeSlots.id, id))
      .returning();
    return slot || undefined;
  }

  async deleteTimeSlot(id: string): Promise<boolean> {
    await db.delete(trainerTimeSlots).where(eq(trainerTimeSlots.id, id));
    return true;
  }

  async initializeTrainerTimeSlots(trainerId: string): Promise<TrainerTimeSlot[]> {
    const existingSlots = await this.getTimeSlotsByTrainer(trainerId);
    if (existingSlots.length > 0) {
      return existingSlots;
    }
    
    const days: Array<"monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday"> = [
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"
    ];
    const hours = Array.from({ length: 14 }, (_, i) => String(9 + i).padStart(2, '0'));
    
    const slots: InsertTrainerTimeSlot[] = [];
    for (const day of days) {
      for (const hour of hours) {
        slots.push({
          trainerId,
          dayOfWeek: day,
          hour: `${hour}:00`,
          isActive: "true",
          durationMinutes: "60",
          maxAttendees: "5"
        });
      }
    }
    
    if (slots.length === 0) return [];
    return await db.insert(trainerTimeSlots).values(slots).returning();
  }

  // App Settings
  async getAppSetting(key: string): Promise<AppSetting | undefined> {
    const [setting] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    return setting || undefined;
  }

  async getAllAppSettings(): Promise<AppSetting[]> {
    return await db.select().from(appSettings).orderBy(appSettings.category, appSettings.key);
  }

  async getAppSettingsByCategory(category: string): Promise<AppSetting[]> {
    return await db.select().from(appSettings).where(eq(appSettings.category, category)).orderBy(appSettings.key);
  }

  async upsertAppSetting(key: string, value: string, category: string, description?: string, updatedBy?: string): Promise<AppSetting> {
    const existing = await this.getAppSetting(key);
    if (existing) {
      const [updated] = await db.update(appSettings)
        .set({ value, category, description, updatedBy, updatedAt: new Date() })
        .where(eq(appSettings.key, key))
        .returning();
      return updated;
    }
    const [newSetting] = await db.insert(appSettings).values({
      key,
      value,
      category,
      description,
      updatedBy,
    }).returning();
    return newSetting;
  }

  async deleteAppSetting(key: string): Promise<boolean> {
    await db.delete(appSettings).where(eq(appSettings.key, key));
    return true;
  }

  // Email Templates
  async getEmailTemplate(id: string): Promise<EmailTemplate | undefined> {
    const [template] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id));
    return template || undefined;
  }

  async getEmailTemplatesByTrainer(trainerId: string): Promise<EmailTemplate[]> {
    return await db.select().from(emailTemplates)
      .where(eq(emailTemplates.trainerId, trainerId))
      .orderBy(desc(emailTemplates.createdAt));
  }

  async getAllEmailTemplates(): Promise<EmailTemplate[]> {
    return await db.select().from(emailTemplates).orderBy(desc(emailTemplates.createdAt));
  }

  async createEmailTemplate(template: InsertEmailTemplate): Promise<EmailTemplate> {
    const [newTemplate] = await db.insert(emailTemplates).values(template).returning();
    return newTemplate;
  }

  async updateEmailTemplate(id: string, data: Partial<InsertEmailTemplate>): Promise<EmailTemplate | undefined> {
    const [updated] = await db.update(emailTemplates)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(emailTemplates.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteEmailTemplate(id: string): Promise<boolean> {
    await db.delete(emailTemplates).where(eq(emailTemplates.id, id));
    return true;
  }
  
  // Trainer Reminder Settings
  async getReminderSettings(trainerId: string): Promise<TrainerReminderSettings | undefined> {
    const [settings] = await db.select()
      .from(trainerReminderSettings)
      .where(eq(trainerReminderSettings.trainerId, trainerId));
    return settings || undefined;
  }
  
  async upsertReminderSettings(trainerId: string, settings: Partial<InsertTrainerReminderSettings>): Promise<TrainerReminderSettings> {
    const existing = await this.getReminderSettings(trainerId);
    if (existing) {
      const [updated] = await db.update(trainerReminderSettings)
        .set({ ...settings, updatedAt: new Date() })
        .where(eq(trainerReminderSettings.trainerId, trainerId))
        .returning();
      return updated;
    }
    const [created] = await db.insert(trainerReminderSettings)
      .values({ trainerId, ...settings })
      .returning();
    return created;
  }
  
  // Scheduled Reminders
  async createScheduledReminder(reminder: InsertScheduledReminder): Promise<ScheduledReminder> {
    const [created] = await db.insert(scheduledReminders)
      .values(reminder)
      .returning();
    return created;
  }
  
  async getScheduledRemindersByTrainer(trainerId: string): Promise<ScheduledReminder[]> {
    return await db.select()
      .from(scheduledReminders)
      .where(eq(scheduledReminders.trainerId, trainerId))
      .orderBy(desc(scheduledReminders.scheduledFor));
  }

  async getAllScheduledReminders(): Promise<ScheduledReminder[]> {
    return await db.select()
      .from(scheduledReminders)
      .orderBy(desc(scheduledReminders.scheduledFor));
  }
  
  async getExistingReminder(trainerId: string, sessionId: string | undefined, reminderType: string): Promise<ScheduledReminder | undefined> {
    const conditions = [
      eq(scheduledReminders.trainerId, trainerId),
      eq(scheduledReminders.reminderType, reminderType as any),
    ];
    
    if (sessionId) {
      conditions.push(eq(scheduledReminders.sessionId, sessionId));
    }
    
    const [existing] = await db.select()
      .from(scheduledReminders)
      .where(and(...conditions))
      .orderBy(scheduledReminders.scheduledFor)
      .limit(1);
    return existing || undefined;
  }
  
  // Push Subscriptions
  async createPushSubscription(subscription: InsertPushSubscription): Promise<PushSubscriptionType> {
    const [created] = await db.insert(pushSubscriptions)
      .values(subscription)
      .returning();
    return created;
  }
  
  async getPushSubscriptionsByUser(userId: string): Promise<PushSubscriptionType[]> {
    return await db.select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  }
  
  async getPushSubscriptionByEndpoint(endpoint: string): Promise<PushSubscriptionType | undefined> {
    const [subscription] = await db.select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
    return subscription || undefined;
  }
  
  async getActivePushSubscriptionsByRole(role: string): Promise<PushSubscriptionType[]> {
    const allSubscriptions = await db.select({
      subscription: pushSubscriptions,
      user: users
    })
      .from(pushSubscriptions)
      .innerJoin(users, eq(pushSubscriptions.userId, users.id))
      .where(
        and(
          eq(pushSubscriptions.isActive, "true"),
          eq(users.role, role as any)
        )
      );
    return allSubscriptions.map(s => s.subscription);
  }
  
  async updatePushSubscription(id: string, data: Partial<InsertPushSubscription>): Promise<PushSubscriptionType | undefined> {
    const [updated] = await db.update(pushSubscriptions)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(pushSubscriptions.id, id))
      .returning();
    return updated || undefined;
  }
  
  async deletePushSubscription(id: string): Promise<boolean> {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
    return true;
  }
  
  async deletePushSubscriptionByEndpoint(endpoint: string): Promise<boolean> {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    return true;
  }
  
  // Notifications
  async createNotification(notification: InsertNotification): Promise<Notification> {
    const [created] = await db.insert(notifications).values(notification).returning();
    return created;
  }
  
  async getNotificationsByUser(userId: string): Promise<Notification[]> {
    return db.select().from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt));
  }
  
  async getUnreadNotificationCount(userId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, "false")));
    return Number(result[0]?.count || 0);
  }
  
  async markNotificationAsRead(id: string): Promise<Notification | undefined> {
    const [updated] = await db.update(notifications)
      .set({ isRead: "true" })
      .where(eq(notifications.id, id))
      .returning();
    return updated || undefined;
  }
  
  async markAllNotificationsAsRead(userId: string): Promise<void> {
    await db.update(notifications)
      .set({ isRead: "true" })
      .where(eq(notifications.userId, userId));
  }
  
  async deleteNotification(id: string): Promise<boolean> {
    await db.delete(notifications).where(eq(notifications.id, id));
    return true;
  }
  
  async deleteAllNotifications(userId: string): Promise<boolean> {
    await db.delete(notifications).where(eq(notifications.userId, userId));
    return true;
  }
  
  // Admin Email Templates
  async getAdminEmailTemplate(id: string): Promise<AdminEmailTemplate | undefined> {
    const [template] = await db.select().from(adminEmailTemplates)
      .where(eq(adminEmailTemplates.id, id));
    return template || undefined;
  }
  
  async getAdminEmailTemplatesByAdmin(adminId: string): Promise<AdminEmailTemplate[]> {
    return db.select().from(adminEmailTemplates)
      .where(eq(adminEmailTemplates.adminId, adminId))
      .orderBy(desc(adminEmailTemplates.createdAt));
  }
  
  async getAllAdminEmailTemplates(): Promise<AdminEmailTemplate[]> {
    return db.select().from(adminEmailTemplates)
      .orderBy(desc(adminEmailTemplates.createdAt));
  }
  
  async createAdminEmailTemplate(template: InsertAdminEmailTemplate): Promise<AdminEmailTemplate> {
    const [created] = await db.insert(adminEmailTemplates).values(template).returning();
    return created;
  }
  
  async updateAdminEmailTemplate(id: string, data: Partial<InsertAdminEmailTemplate>): Promise<AdminEmailTemplate | undefined> {
    const [updated] = await db.update(adminEmailTemplates)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(adminEmailTemplates.id, id))
      .returning();
    return updated || undefined;
  }
  
  async deleteAdminEmailTemplate(id: string): Promise<boolean> {
    await db.delete(adminEmailTemplates).where(eq(adminEmailTemplates.id, id));
    return true;
  }

  // Dashboard Widgets
  async createDashboardWidget(widget: InsertDashboardWidget): Promise<DashboardWidget> {
    const [created] = await db.insert(dashboardWidgets).values(widget).returning();
    return created;
  }

  async updateDashboardWidget(id: string, data: Partial<InsertDashboardWidget>): Promise<DashboardWidget | undefined> {
    const [updated] = await db.update(dashboardWidgets)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(dashboardWidgets.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteDashboardWidget(id: string): Promise<boolean> {
    await db.delete(dashboardWidgets).where(eq(dashboardWidgets.id, id));
    return true;
  }

  async updateDashboardWidgetPositions(userId: string, widgetPositions: { id: string; position: number }[]): Promise<boolean> {
    for (const wp of widgetPositions) {
      await db.update(dashboardWidgets)
        .set({ position: wp.position, updatedAt: new Date() })
        .where(and(eq(dashboardWidgets.id, wp.id), eq(dashboardWidgets.userId, userId)));
    }
    return true;
  }

  async initializeDefaultWidgets(userId: string, role: string): Promise<DashboardWidget[]> {
    const existingWidgets = await db.select().from(dashboardWidgets)
      .where(eq(dashboardWidgets.userId, userId))
      .orderBy(dashboardWidgets.position);
    if (existingWidgets.length > 0) return existingWidgets;

    const defaultWidgets: InsertDashboardWidget[] = [];
    
    if (role === 'admin') {
      defaultWidgets.push(
        { userId, widgetType: 'stats_overview', title: 'Platform Statistics', position: 0, width: 4, height: 1 },
        { userId, widgetType: 'recent_applications', title: 'Recent Applications', position: 1, width: 2, height: 2 },
        { userId, widgetType: 'upcoming_sessions', title: 'Upcoming Sessions', position: 2, width: 2, height: 2 },
        { userId, widgetType: 'staff_overview', title: 'Staff Overview', position: 3, width: 2, height: 1 },
        { userId, widgetType: 'activity_feed', title: 'Activity Feed', position: 4, width: 2, height: 2 },
      );
    } else if (role === 'trainer') {
      defaultWidgets.push(
        { userId, widgetType: 'trainer_stats', title: 'My Statistics', position: 0, width: 4, height: 1 },
        { userId, widgetType: 'my_trainees', title: 'My Trainees', position: 1, width: 2, height: 2 },
        { userId, widgetType: 'upcoming_sessions', title: 'Upcoming Sessions', position: 2, width: 2, height: 2 },
        { userId, widgetType: 'quick_actions', title: 'Quick Actions', position: 3, width: 2, height: 1 },
      );
    } else if (role === 'referrer') {
      defaultWidgets.push(
        { userId, widgetType: 'referral_stats', title: 'Referral Statistics', position: 0, width: 4, height: 1 },
        { userId, widgetType: 'my_referrals', title: 'My Referrals', position: 1, width: 2, height: 2 },
        { userId, widgetType: 'referral_link', title: 'Referral Link', position: 2, width: 2, height: 1 },
      );
    } else if (role === 'applicant') {
      defaultWidgets.push(
        { userId, widgetType: 'application_status', title: 'Application Status', position: 0, width: 4, height: 1 },
        { userId, widgetType: 'training_info', title: 'Training Information', position: 1, width: 2, height: 2 },
        { userId, widgetType: 'quick_links', title: 'Quick Links', position: 2, width: 2, height: 1 },
      );
    }

    const created: DashboardWidget[] = [];
    for (const widget of defaultWidgets) {
      const w = await this.createDashboardWidget(widget);
      created.push(w);
    }
    return created;
  }

  // Bulk session creation
  async createBulkTrainingSessions(sessions: InsertTrainingSession[]): Promise<TrainingSession[]> {
    const created: TrainingSession[] = [];
    for (const session of sessions) {
      const [s] = await db.insert(trainingSessions).values(session).returning();
      created.push(s);
    }
    return created;
  }

  // Leads
  async getLead(id: string): Promise<Lead | undefined> {
    const [lead] = await db.select().from(leads).where(eq(leads.id, id));
    return lead || undefined;
  }

  async getLeadByEmail(email: string): Promise<Lead | undefined> {
    const [lead] = await db.select().from(leads).where(eq(leads.email, email));
    return lead || undefined;
  }

  async getAllLeads(): Promise<Lead[]> {
    return db.select().from(leads).orderBy(desc(leads.createdAt));
  }

  async getLeadsByStatus(status: string): Promise<Lead[]> {
    return db.select().from(leads).where(eq(leads.status, status as any)).orderBy(desc(leads.createdAt));
  }

  async createLead(lead: InsertLead): Promise<Lead> {
    const [created] = await db.insert(leads).values(lead).returning();
    return created;
  }

  async updateLead(id: string, data: Partial<InsertLead>): Promise<Lead | undefined> {
    const [updated] = await db.update(leads).set(data).where(eq(leads.id, id)).returning();
    return updated || undefined;
  }

  async deleteLead(id: string): Promise<boolean> {
    const result = await db.delete(leads).where(eq(leads.id, id));
    return true;
  }

  // Lead Folders
  async createLeadFolder(folder: InsertLeadFolder): Promise<LeadFolder> {
    const [created] = await db.insert(leadFolders).values(folder).returning();
    return created;
  }

  async getAllLeadFolders(): Promise<LeadFolder[]> {
    return db.select().from(leadFolders).orderBy(desc(leadFolders.createdAt));
  }

  async updateLeadFolder(id: string, data: Partial<InsertLeadFolder>): Promise<LeadFolder | undefined> {
    const [updated] = await db.update(leadFolders).set(data).where(eq(leadFolders.id, id)).returning();
    return updated || undefined;
  }

  async deleteLeadFolder(id: string): Promise<boolean> {
    await db.update(leads).set({ folderId: null }).where(eq(leads.folderId, id));
    await db.delete(leadFolders).where(eq(leadFolders.id, id));
    return true;
  }

  async updateLeadFolderCount(id: string): Promise<void> {
    const [result] = await db.select({ count: sql<number>`count(*)` }).from(leads).where(eq(leads.folderId, id));
    await db.update(leadFolders).set({ leadCount: Number(result?.count || 0) }).where(eq(leadFolders.id, id));
  }

  // Lead Tags
  async getAllLeadTags(): Promise<LeadTag[]> {
    return db.select().from(leadTags).orderBy(leadTags.name);
  }

  async createLeadTag(tag: InsertLeadTag): Promise<LeadTag> {
    const [created] = await db.insert(leadTags).values(tag).returning();
    return created;
  }

  async deleteLeadTag(id: string): Promise<boolean> {
    const result = await db.delete(leadTags).where(eq(leadTags.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async assignTagToLead(leadId: string, tagId: string): Promise<void> {
    await db.insert(leadTagAssignments).values({ leadId, tagId }).onConflictDoNothing();
  }

  async removeTagFromLead(leadId: string, tagId: string): Promise<void> {
    await db.delete(leadTagAssignments).where(
      and(eq(leadTagAssignments.leadId, leadId), eq(leadTagAssignments.tagId, tagId))
    );
  }

  async getTagsForLead(leadId: string): Promise<LeadTag[]> {
    const assignments = await db.select({ tag: leadTags })
      .from(leadTagAssignments)
      .innerJoin(leadTags, eq(leadTagAssignments.tagId, leadTags.id))
      .where(eq(leadTagAssignments.leadId, leadId));
    return assignments.map(a => a.tag);
  }

  async getLeadsByTag(tagId: string): Promise<Lead[]> {
    const assignments = await db.select({ lead: leads })
      .from(leadTagAssignments)
      .innerJoin(leads, eq(leadTagAssignments.leadId, leads.id))
      .where(eq(leadTagAssignments.tagId, tagId));
    return assignments.map(a => a.lead);
  }

  // Email Tracking
  async createEmailTracking(data: { leadId?: string | null; emailLogId?: string; type: string; url?: string; userAgent?: string; ipAddress?: string }): Promise<EmailTracking> {
    const [created] = await db.insert(emailTracking).values(data).returning();
    return created;
  }

  async getEmailTrackingByLead(leadId: string): Promise<EmailTracking[]> {
    return db.select().from(emailTracking).where(eq(emailTracking.leadId, leadId)).orderBy(desc(emailTracking.createdAt));
  }

  async getEmailTrackingStats(): Promise<{ opens: number; clicks: number; uniqueOpens: number; uniqueClicks: number }> {
    const allTracking = await db.select().from(emailTracking);
    const opens = allTracking.filter(t => t.type === 'open').length;
    const clicks = allTracking.filter(t => t.type === 'click').length;
    const uniqueOpens = new Set(allTracking.filter(t => t.type === 'open').map(t => t.leadId)).size;
    const uniqueClicks = new Set(allTracking.filter(t => t.type === 'click').map(t => t.leadId)).size;
    return { opens, clicks, uniqueOpens, uniqueClicks };
  }

  // Scheduled Emails
  async createScheduledEmail(data: InsertScheduledEmail): Promise<ScheduledEmail> {
    const [created] = await db.insert(scheduledEmails).values(data).returning();
    return created;
  }

  async getScheduledEmails(): Promise<ScheduledEmail[]> {
    return db.select().from(scheduledEmails).orderBy(desc(scheduledEmails.createdAt));
  }

  async updateScheduledEmail(id: string, data: Partial<ScheduledEmail>): Promise<ScheduledEmail | undefined> {
    const [updated] = await db.update(scheduledEmails).set(data).where(eq(scheduledEmails.id, id)).returning();
    return updated;
  }

  async deleteScheduledEmail(id: string): Promise<boolean> {
    const result = await db.delete(scheduledEmails).where(eq(scheduledEmails.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async createRescheduleRequest(request: InsertRescheduleRequest): Promise<RescheduleRequest> {
    const [created] = await db.insert(rescheduleRequests).values(request).returning();
    return created;
  }

  async getAllRescheduleRequests(): Promise<RescheduleRequest[]> {
    return await db.select().from(rescheduleRequests).orderBy(desc(rescheduleRequests.createdAt));
  }

  async getRescheduleRequestsByTrainee(traineeId: string): Promise<RescheduleRequest[]> {
    return await db.select().from(rescheduleRequests).where(eq(rescheduleRequests.traineeId, traineeId)).orderBy(desc(rescheduleRequests.createdAt));
  }

  async updateRescheduleRequest(id: string, data: Partial<InsertRescheduleRequest> & { reviewedAt?: Date }): Promise<RescheduleRequest | undefined> {
    const [updated] = await db.update(rescheduleRequests).set(data).where(eq(rescheduleRequests.id, id)).returning();
    return updated || undefined;
  }

  async getApplicationsPaginated(options: { page: number; limit: number; status?: string; trainingStatus?: string; search?: string; trainerId?: string }): Promise<{ data: Application[]; total: number; page: number; totalPages: number }> {
    const { page, limit, status, trainingStatus, search, trainerId } = options;
    const offset = (page - 1) * limit;

    const conditions: SQL<unknown>[] = [];
    if (status) conditions.push(sql`${applications.status} = ${status}`);
    if (trainingStatus) conditions.push(sql`${applications.trainingStatus} = ${trainingStatus}`);
    if (trainerId) conditions.push(eq(applications.trainerId, trainerId));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(applications)
      .where(whereClause!);
    
    const data = whereClause
      ? await db.select().from(applications).where(whereClause).orderBy(desc(applications.appliedAt)).limit(limit).offset(offset)
      : await db.select().from(applications).orderBy(desc(applications.appliedAt)).limit(limit).offset(offset);

    return { data, total: Number(total), page, totalPages: Math.ceil(Number(total) / limit) };
  }

  async getLeadsPaginated(options: { page: number; limit: number; status?: string; search?: string; folderId?: string }): Promise<{ data: Lead[]; total: number; page: number; totalPages: number }> {
    const { page, limit, status, search, folderId } = options;
    const offset = (page - 1) * limit;

    const conditions: SQL<unknown>[] = [];
    if (status) conditions.push(sql`${leads.status} = ${status}`);
    if (folderId === "unfiled") {
      conditions.push(sql`${leads.folderId} IS NULL`);
    } else if (folderId) {
      conditions.push(eq(leads.folderId, folderId));
    }
    if (search) {
      const searchCondition = or(
        sql`${leads.email} ILIKE ${'%' + search + '%'}`,
        sql`${leads.name} ILIKE ${'%' + search + '%'}`
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(leads)
      .where(whereClause!);
    
    const data = whereClause
      ? await db.select().from(leads).where(whereClause).orderBy(desc(leads.createdAt)).limit(limit).offset(offset)
      : await db.select().from(leads).orderBy(desc(leads.createdAt)).limit(limit).offset(offset);

    return { data, total: Number(total), page, totalPages: Math.ceil(Number(total) / limit) };
  }

  async getAllApplicantReports(): Promise<ApplicantReport[]> {
    return await db.select().from(applicantReports).orderBy(desc(applicantReports.createdAt));
  }

  async createApplicantReport(report: InsertApplicantReport): Promise<ApplicantReport> {
    const [created] = await db.insert(applicantReports).values(report).returning();
    return created;
  }

  async updateApplicantReport(id: string, data: Partial<InsertApplicantReport>): Promise<ApplicantReport | undefined> {
    const [updated] = await db.update(applicantReports).set({ ...data, updatedAt: new Date() }).where(eq(applicantReports.id, id)).returning();
    return updated || undefined;
  }

  async deleteApplicantReport(id: string): Promise<boolean> {
    const result = await db.delete(applicantReports).where(eq(applicantReports.id, id));
    return true;
  }

  async createChatbotLog(log: InsertChatbotLog): Promise<ChatbotLog> {
    const [created] = await db.insert(chatbotLogs).values(log).returning();
    return created;
  }

  async getChatbotLogsPaginated(options: { page: number; limit: number; search?: string }): Promise<{ data: ChatbotLog[]; total: number; page: number; totalPages: number }> {
    const { page, limit, search } = options;
    const offset = (page - 1) * limit;
    const conditions: SQL<unknown>[] = [];

    if (search) {
      const searchCondition = or(
        sql`LOWER(${chatbotLogs.question}) LIKE LOWER(${'%' + search + '%'})`,
        sql`LOWER(${chatbotLogs.answer}) LIKE LOWER(${'%' + search + '%'})`,
        sql`LOWER(${chatbotLogs.visitorEmail}) LIKE LOWER(${'%' + search + '%'})`,
        sql`LOWER(${chatbotLogs.visitorName}) LIKE LOWER(${'%' + search + '%'})`
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(chatbotLogs)
      .where(whereClause!);
    
    const data = whereClause
      ? await db.select().from(chatbotLogs).where(whereClause).orderBy(desc(chatbotLogs.createdAt)).limit(limit).offset(offset)
      : await db.select().from(chatbotLogs).orderBy(desc(chatbotLogs.createdAt)).limit(limit).offset(offset);

    return { data, total: Number(total), page, totalPages: Math.ceil(Number(total) / limit) };
  }

  async updateChatbotLogFeedback(id: string, feedback: string): Promise<ChatbotLog | undefined> {
    const [updated] = await db.update(chatbotLogs).set({ userFeedback: feedback }).where(eq(chatbotLogs.id, id)).returning();
    return updated || undefined;
  }

  async getChatbotStats(): Promise<{ totalConversations: number; totalQuestions: number; uniqueSessions: number; positiveCount: number; negativeCount: number }> {
    const [stats] = await db.select({
      totalQuestions: sql<number>`count(*)`,
      uniqueSessions: sql<number>`count(distinct ${chatbotLogs.sessionId})`,
      positiveCount: sql<number>`count(*) filter (where ${chatbotLogs.userFeedback} = 'up')`,
      negativeCount: sql<number>`count(*) filter (where ${chatbotLogs.userFeedback} = 'down')`,
    }).from(chatbotLogs);

    return {
      totalConversations: Number(stats.uniqueSessions),
      totalQuestions: Number(stats.totalQuestions),
      uniqueSessions: Number(stats.uniqueSessions),
      positiveCount: Number(stats.positiveCount),
      negativeCount: Number(stats.negativeCount),
    };
  }
  async createTrainerDailyRecord(record: InsertTrainerDailyRecord): Promise<TrainerDailyRecord> {
    const [created] = await db.insert(trainerDailyRecords).values(record).returning();
    return created;
  }

  async getTrainerDailyRecords(trainerId: string): Promise<TrainerDailyRecord[]> {
    return db.select().from(trainerDailyRecords).where(eq(trainerDailyRecords.trainerId, trainerId)).orderBy(desc(trainerDailyRecords.date));
  }

  async getAllTrainerDailyRecords(): Promise<TrainerDailyRecord[]> {
    return db.select().from(trainerDailyRecords).orderBy(desc(trainerDailyRecords.date));
  }

  async getTrainerDailyRecordByDate(trainerId: string, date: string): Promise<TrainerDailyRecord | undefined> {
    const [record] = await db.select().from(trainerDailyRecords).where(and(eq(trainerDailyRecords.trainerId, trainerId), eq(trainerDailyRecords.date, date)));
    return record || undefined;
  }

  async updateTrainerDailyRecord(id: string, data: Partial<InsertTrainerDailyRecord>): Promise<TrainerDailyRecord | undefined> {
    const [updated] = await db.update(trainerDailyRecords).set({ ...data, updatedAt: new Date() }).where(eq(trainerDailyRecords.id, id)).returning();
    return updated || undefined;
  }

  async deleteTrainerDailyRecord(id: string): Promise<boolean> {
    const result = await db.delete(trainerDailyRecords).where(eq(trainerDailyRecords.id, id));
    return true;
  }

  async trackSiteVisitor(visitor: InsertSiteVisitor): Promise<{ visitor: SiteVisitor; isNew: boolean }> {
    const existing = await db.select().from(siteVisitors)
      .where(and(
        eq(siteVisitors.ipAddress, visitor.ipAddress || ""),
        eq(siteVisitors.device, visitor.device || "Desktop"),
        eq(siteVisitors.browser, visitor.browser || "Unknown"),
      ))
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await db.update(siteVisitors)
        .set({
          lastVisitAt: new Date(),
          visitCount: sql`"visit_count" + 1`,
          page: visitor.page,
          sessionId: visitor.sessionId,
        })
        .where(eq(siteVisitors.id, existing[0].id))
        .returning();
      return { visitor: updated, isNew: false };
    }

    const [created] = await db.insert(siteVisitors).values(visitor).returning();
    return { visitor: created, isNew: true };
  }

  async getSiteVisitors(options: { page: number; limit: number }): Promise<{ data: SiteVisitor[]; total: number; page: number; totalPages: number }> {
    const offset = (options.page - 1) * options.limit;
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(siteVisitors);
    const total = Number(countResult.count);
    const data = await db.select().from(siteVisitors).orderBy(desc(siteVisitors.lastVisitAt)).limit(options.limit).offset(offset);
    return { data, total, page: options.page, totalPages: Math.ceil(total / options.limit) };
  }

  async getSiteVisitorStats(): Promise<{ totalVisits: number; uniqueVisitors: number; todayVisits: number; todayUnique: number; topPages: { page: string; count: number }[]; topCountries: { country: string; count: number }[]; recentVisitors: SiteVisitor[] }> {
    const [totalResult] = await db.select({ count: sql<number>`coalesce(sum(${siteVisitors.visitCount}), 0)` }).from(siteVisitors);
    const [uniqueResult] = await db.select({ count: sql<number>`count(*)` }).from(siteVisitors);
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [todayResult] = await db.select({ count: sql<number>`count(*)` }).from(siteVisitors).where(sql`${siteVisitors.lastVisitAt} >= ${todayStart}`);
    const [todayUniqueResult] = await db.select({ count: sql<number>`count(distinct ${siteVisitors.ipAddress})` }).from(siteVisitors).where(sql`${siteVisitors.lastVisitAt} >= ${todayStart}`);

    const topPages = await db.select({ page: siteVisitors.page, count: sql<number>`count(*)` }).from(siteVisitors).groupBy(siteVisitors.page).orderBy(sql`count(*) desc`).limit(10);
    const topCountries = await db.select({ country: siteVisitors.country, count: sql<number>`count(*)` }).from(siteVisitors).where(sql`${siteVisitors.country} is not null`).groupBy(siteVisitors.country).orderBy(sql`count(*) desc`).limit(10);
    const recentVisitors = await db.select().from(siteVisitors).orderBy(desc(siteVisitors.lastVisitAt)).limit(50);

    return {
      totalVisits: Number(totalResult.count),
      uniqueVisitors: Number(uniqueResult.count),
      todayVisits: Number(todayResult.count),
      todayUnique: Number(todayUniqueResult.count),
      topPages: topPages.map(p => ({ page: p.page, count: Number(p.count) })),
      topCountries: topCountries.map(c => ({ country: c.country || "Unknown", count: Number(c.count) })),
      recentVisitors,
    };
  }

  async linkVisitorToApplicant(ipAddress: string, applicantName: string): Promise<void> {
    await db.update(siteVisitors)
      .set({ applicantName })
      .where(eq(siteVisitors.ipAddress, ipAddress));
  }

  async createTrainingAppointment(appointment: InsertTrainingAppointment): Promise<TrainingAppointment> {
    const [created] = await db.insert(trainingAppointments).values(appointment).returning();
    return created;
  }

  async getTrainingAppointment(id: string): Promise<TrainingAppointment | undefined> {
    const [appointment] = await db.select().from(trainingAppointments).where(eq(trainingAppointments.id, id));
    return appointment;
  }

  async getTrainingAppointmentsByApplicant(applicantId: string): Promise<TrainingAppointment[]> {
    return db.select().from(trainingAppointments).where(eq(trainingAppointments.applicantId, applicantId)).orderBy(desc(trainingAppointments.createdAt));
  }

  async getAllTrainingAppointments(): Promise<TrainingAppointment[]> {
    return db.select().from(trainingAppointments).orderBy(desc(trainingAppointments.createdAt));
  }

  async getPendingTrainingAppointments(): Promise<TrainingAppointment[]> {
    return db.select().from(trainingAppointments).where(eq(trainingAppointments.status, "pending")).orderBy(desc(trainingAppointments.createdAt));
  }

  async updateTrainingAppointment(id: string, data: Partial<TrainingAppointment>): Promise<TrainingAppointment | undefined> {
    const [updated] = await db.update(trainingAppointments).set(data).where(eq(trainingAppointments.id, id)).returning();
    return updated;
  }

  async createCertificateLog(log: InsertCertificateLog): Promise<CertificateLog> {
    const [created] = await db.insert(certificateLogs).values(log).returning();
    return created;
  }

  async getCertificateLogs(): Promise<CertificateLog[]> {
    return db.select().from(certificateLogs).orderBy(desc(certificateLogs.createdAt));
  }

  async getCertificateLogsByApplication(applicationId: string): Promise<CertificateLog[]> {
    return db.select().from(certificateLogs).where(eq(certificateLogs.applicationId, applicationId)).orderBy(desc(certificateLogs.createdAt));
  }

  async createTrainerCelebration(celebration: InsertTrainerCelebration): Promise<TrainerCelebration> {
    const [created] = await db.insert(trainerCelebrations).values(celebration).returning();
    return created;
  }

  async getTrainerCelebrations(limit = 50): Promise<TrainerCelebration[]> {
    return db.select().from(trainerCelebrations).orderBy(desc(trainerCelebrations.createdAt)).limit(limit);
  }

  async getVisibleCelebrations(limit = 20): Promise<TrainerCelebration[]> {
    return db.select().from(trainerCelebrations).where(eq(trainerCelebrations.isVisible, "true")).orderBy(desc(trainerCelebrations.createdAt)).limit(limit);
  }

  async updateTrainerCelebration(id: string, updates: Partial<InsertTrainerCelebration>): Promise<TrainerCelebration> {
    const [updated] = await db.update(trainerCelebrations).set(updates).where(eq(trainerCelebrations.id, id)).returning();
    return updated;
  }

  async deleteTrainerCelebration(id: string): Promise<boolean> {
    const result = await db.delete(trainerCelebrations).where(eq(trainerCelebrations.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getTrainerLeaderboard(): Promise<Array<{ trainerId: string; trainerName: string; completedTrainings: number; assignedTrainees: number; startedWorking: number }>> {
    const trainers = await db.select().from(users).where(eq(users.role, "trainer"));
    const allApps = await db.select().from(applications);
    const allSessions = await db.select().from(trainingSessions);

    return trainers.map(trainer => {
      const assignedApps = allApps.filter(a => a.trainerId === trainer.id);
      const completedSessions = allSessions.filter(s => s.trainerId === trainer.id && s.status === "completed");
      const startedWorkingApps = assignedApps.filter(a => a.status === "started_working");

      return {
        trainerId: trainer.id,
        trainerName: trainer.name,
        completedTrainings: completedSessions.length,
        assignedTrainees: assignedApps.length,
        startedWorking: startedWorkingApps.length,
      };
    }).sort((a, b) => b.completedTrainings - a.completedTrainings || b.startedWorking - a.startedWorking);
  }

  // Trainee Feedback
  async createTraineeFeedback(data: InsertTraineeFeedback): Promise<TraineeFeedback> {
    const [result] = await db.insert(traineeFeedback).values(data).returning();
    return result;
  }

  async getTraineeFeedbackByToken(token: string): Promise<TraineeFeedback | undefined> {
    const [result] = await db.select().from(traineeFeedback).where(eq(traineeFeedback.token, token));
    return result || undefined;
  }

  async submitTraineeFeedback(token: string, data: { overallRating: number; communicationRating?: number; knowledgeRating?: number; helpfulnessRating?: number; comment?: string; wouldRecommend?: string }): Promise<TraineeFeedback | undefined> {
    const [result] = await db
      .update(traineeFeedback)
      .set({ ...data, submittedAt: new Date() })
      .where(eq(traineeFeedback.token, token))
      .returning();
    return result || undefined;
  }

  async getTraineeFeedbackByTrainer(trainerId: string): Promise<TraineeFeedback[]> {
    return db.select().from(traineeFeedback).where(eq(traineeFeedback.trainerId, trainerId)).orderBy(desc(traineeFeedback.createdAt));
  }

  async getAllTraineeFeedback(): Promise<TraineeFeedback[]> {
    return db.select().from(traineeFeedback).orderBy(desc(traineeFeedback.createdAt));
  }

  async createCustomerReport(data: InsertCustomerReport): Promise<CustomerReport> {
    const [created] = await db.insert(customerReports).values(data).returning();
    return created;
  }

  async getAllCustomerReports(): Promise<CustomerReport[]> {
    return db.select().from(customerReports).orderBy(desc(customerReports.updatedAt));
  }

  async getCustomerReportsByStage(stage: string): Promise<CustomerReport[]> {
    return db.select().from(customerReports).where(eq(customerReports.billingStage, stage as any)).orderBy(desc(customerReports.updatedAt));
  }

  async updateCustomerReport(id: string, data: Partial<InsertCustomerReport>, changedBy?: string): Promise<CustomerReport | undefined> {
    const existing = await db.select().from(customerReports).where(eq(customerReports.id, id));
    if (!existing.length) return undefined;
    const old = existing[0];
    const historyEntries: InsertCustomerReportHistory[] = [];
    for (const [key, value] of Object.entries(data)) {
      const oldVal = (old as any)[key];
      if (oldVal !== undefined && String(oldVal) !== String(value)) {
        historyEntries.push({ customerReportId: id, changedBy: changedBy || null, field: key, oldValue: String(oldVal), newValue: String(value) });
      }
    }
    if (historyEntries.length > 0) {
      await db.insert(customerReportHistory).values(historyEntries);
    }
    const [updated] = await db.update(customerReports).set({ ...data, updatedAt: new Date() }).where(eq(customerReports.id, id)).returning();
    return updated || undefined;
  }

  async bulkUpdateCustomerBillingStage(ids: string[], stage: string, changedBy?: string): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const result = await this.updateCustomerReport(id, { billingStage: stage as any }, changedBy);
      if (result) count++;
    }
    return count;
  }

  async deleteCustomerReport(id: string): Promise<boolean> {
    await db.delete(customerReports).where(eq(customerReports.id, id));
    return true;
  }

  async getCustomerReportHistory(reportId: string): Promise<CustomerReportHistory[]> {
    return db.select().from(customerReportHistory).where(eq(customerReportHistory.customerReportId, reportId)).orderBy(desc(customerReportHistory.createdAt));
  }

  async getAllCustomerReportHistory(): Promise<CustomerReportHistory[]> {
    return db.select().from(customerReportHistory).orderBy(desc(customerReportHistory.createdAt));
  }

  async getCustomerReportStats(): Promise<{ totalCustomers: number; totalDeposits: number; totalNegative: number; totalRevenue: number; byStage: Record<string, number> }> {
    const all = await db.select().from(customerReports);
    const byStage: Record<string, number> = {};
    let totalDeposits = 0, totalNegative = 0, totalRevenue = 0;
    for (const r of all) {
      byStage[r.billingStage] = (byStage[r.billingStage] || 0) + 1;
      totalDeposits += parseFloat(r.depositAmount || "0");
      totalNegative += parseFloat(r.negativeAmount || "0");
      totalRevenue += parseFloat(r.revenue || "0");
    }
    return { totalCustomers: all.length, totalDeposits, totalNegative, totalRevenue, byStage };
  }

  async bulkCreateTrainerDailyRecords(records: InsertTrainerDailyRecord[]): Promise<TrainerDailyRecord[]> {
    if (records.length === 0) return [];
    const created = await db.insert(trainerDailyRecords).values(records).returning();
    return created;
  }

  async getTrainerDailyRecordsTrend(startDate: string, endDate: string): Promise<TrainerDailyRecord[]> {
    return db.select().from(trainerDailyRecords)
      .where(and(
        sql`${trainerDailyRecords.date} >= ${startDate}`,
        sql`${trainerDailyRecords.date} <= ${endDate}`
      ))
      .orderBy(trainerDailyRecords.date);
  }

  async createJobOffer(data: InsertJobOffer): Promise<JobOffer> {
    const [offer] = await db.insert(jobOffers).values(data).returning();
    return offer;
  }

  async getJobOfferByToken(token: string): Promise<JobOffer | undefined> {
    const [offer] = await db.select().from(jobOffers).where(eq(jobOffers.token, token));
    return offer;
  }

  async getJobOfferById(id: string): Promise<JobOffer | undefined> {
    const [offer] = await db.select().from(jobOffers).where(eq(jobOffers.id, id));
    return offer;
  }

  async updateJobOffer(id: string, data: Partial<JobOffer>): Promise<JobOffer | undefined> {
    const [offer] = await db.update(jobOffers).set(data).where(eq(jobOffers.id, id)).returning();
    return offer;
  }

  async getAllJobOffers(): Promise<JobOffer[]> {
    return db.select().from(jobOffers).orderBy(desc(jobOffers.createdAt));
  }

  async getJobOfferStats(): Promise<{ total: number; pending: number; accepted: number; expired: number }> {
    const all = await db.select().from(jobOffers);
    const now = new Date();
    let pending = 0, accepted = 0, expired = 0;
    for (const o of all) {
      if (o.status === "accepted") accepted++;
      else if (o.status === "expired" || (o.expiresAt && o.expiresAt < now)) expired++;
      else pending++;
    }
    return { total: all.length, pending, accepted, expired };
  }

  async expireOldJobOffers(): Promise<number> {
    const now = new Date();
    const result = await db.update(jobOffers)
      .set({ status: "expired" })
      .where(and(
        eq(jobOffers.status, "pending"),
        sql`${jobOffers.expiresAt} < ${now}`
      ))
      .returning();
    return result.length;
  }

  async createOfficialDocument(data: InsertOfficialDocument): Promise<OfficialDocument> {
    const [doc] = await db.insert(officialDocuments).values(data).returning();
    return doc;
  }

  async getAllOfficialDocuments(): Promise<OfficialDocument[]> {
    return await db.select().from(officialDocuments).orderBy(desc(officialDocuments.sentAt));
  }

  async deleteOfficialDocument(id: string): Promise<boolean> {
    const result = await db.delete(officialDocuments).where(eq(officialDocuments.id, id)).returning();
    return result.length > 0;
  }

  async createDocumentTemplate(data: InsertDocumentTemplate): Promise<DocumentTemplate> {
    const [t] = await db.insert(documentTemplates).values(data).returning();
    return t;
  }

  async getAllDocumentTemplates(): Promise<DocumentTemplate[]> {
    return await db.select().from(documentTemplates).orderBy(desc(documentTemplates.createdAt));
  }

  async getDocumentTemplate(id: string): Promise<DocumentTemplate | undefined> {
    const [t] = await db.select().from(documentTemplates).where(eq(documentTemplates.id, id));
    return t;
  }

  async updateDocumentTemplate(id: string, data: Partial<InsertDocumentTemplate>): Promise<DocumentTemplate | undefined> {
    const [t] = await db.update(documentTemplates).set({ ...data, updatedAt: new Date() }).where(eq(documentTemplates.id, id)).returning();
    return t;
  }

  async deleteDocumentTemplate(id: string): Promise<boolean> {
    const result = await db.delete(documentTemplates).where(eq(documentTemplates.id, id)).returning();
    return result.length > 0;
  }

  async createManualTraineeAssignment(data: InsertManualTraineeAssignment): Promise<ManualTraineeAssignment> {
    const [assignment] = await db.insert(manualTraineeAssignments).values(data).returning();
    return assignment;
  }

  async getAllManualTraineeAssignments(): Promise<ManualTraineeAssignment[]> {
    return await db.select().from(manualTraineeAssignments).orderBy(desc(manualTraineeAssignments.createdAt));
  }

  async getManualTraineeAssignmentsByTrainer(trainerId: string): Promise<ManualTraineeAssignment[]> {
    return await db.select().from(manualTraineeAssignments).where(eq(manualTraineeAssignments.trainerId, trainerId)).orderBy(desc(manualTraineeAssignments.createdAt));
  }

  async updateManualTraineeAssignmentStatus(id: string, status: string): Promise<ManualTraineeAssignment | undefined> {
    const [updated] = await db.update(manualTraineeAssignments).set({ status: status as any }).where(eq(manualTraineeAssignments.id, id)).returning();
    return updated;
  }

  async deleteManualTraineeAssignment(id: string): Promise<boolean> {
    const result = await db.delete(manualTraineeAssignments).where(eq(manualTraineeAssignments.id, id)).returning();
    return result.length > 0;
  }

  async getSmtpAccounts(): Promise<SmtpAccount[]> {
    return await db.select().from(smtpAccounts).orderBy(desc(smtpAccounts.createdAt));
  }

  async getSmtpAccount(id: number): Promise<SmtpAccount | undefined> {
    const [account] = await db.select().from(smtpAccounts).where(eq(smtpAccounts.id, id));
    return account || undefined;
  }

  async createSmtpAccount(data: InsertSmtpAccount): Promise<SmtpAccount> {
    const [account] = await db.insert(smtpAccounts).values(data).returning();
    return account;
  }

  async updateSmtpAccount(id: number, data: Partial<InsertSmtpAccount>): Promise<SmtpAccount | undefined> {
    const [account] = await db.update(smtpAccounts).set(data).where(eq(smtpAccounts.id, id)).returning();
    return account || undefined;
  }

  async deleteSmtpAccount(id: number): Promise<boolean> {
    const result = await db.delete(smtpAccounts).where(eq(smtpAccounts.id, id)).returning();
    return result.length > 0;
  }

  async createEmployerProfile(data: InsertEmployerProfile): Promise<EmployerProfile> {
    const [profile] = await db.insert(employerProfiles).values(data).returning();
    return profile;
  }

  async getEmployerProfile(id: number): Promise<EmployerProfile | undefined> {
    const [profile] = await db.select().from(employerProfiles).where(eq(employerProfiles.id, id));
    return profile || undefined;
  }

  async getEmployerProfileByUserId(userId: string): Promise<EmployerProfile | undefined> {
    const [profile] = await db.select().from(employerProfiles).where(eq(employerProfiles.userId, userId));
    return profile || undefined;
  }

  async getAllEmployerProfiles(): Promise<EmployerProfile[]> {
    return await db.select().from(employerProfiles).orderBy(desc(employerProfiles.createdAt));
  }

  async updateEmployerProfile(id: number, data: Partial<InsertEmployerProfile>): Promise<EmployerProfile | undefined> {
    const [profile] = await db.update(employerProfiles).set(data).where(eq(employerProfiles.id, id)).returning();
    return profile || undefined;
  }

  async createEmployerPayment(data: InsertEmployerPayment): Promise<EmployerPayment> {
    const [payment] = await db.insert(employerPayments).values(data).returning();
    return payment;
  }

  async getEmployerPayment(id: number): Promise<EmployerPayment | undefined> {
    const [payment] = await db.select().from(employerPayments).where(eq(employerPayments.id, id));
    return payment || undefined;
  }

  async getEmployerPaymentsByEmployer(employerId: number): Promise<EmployerPayment[]> {
    return await db.select().from(employerPayments).where(eq(employerPayments.employerId, employerId)).orderBy(desc(employerPayments.createdAt));
  }

  async getAllEmployerPayments(): Promise<EmployerPayment[]> {
    return await db.select().from(employerPayments).orderBy(desc(employerPayments.createdAt));
  }

  async updateEmployerPaymentStatus(id: number, data: { paymentStatus: string; adminNotes?: string; reviewedBy?: string; reviewedAt?: Date }): Promise<EmployerPayment | undefined> {
    const [payment] = await db.update(employerPayments).set({
      paymentStatus: data.paymentStatus as any,
      adminNotes: data.adminNotes,
      reviewedBy: data.reviewedBy,
      reviewedAt: data.reviewedAt || new Date(),
    }).where(eq(employerPayments.id, id)).returning();
    return payment || undefined;
  }

  async createEmployerJobListing(data: InsertEmployerJobListing): Promise<EmployerJobListing> {
    const [listing] = await db.insert(employerJobListings).values(data).returning();
    return listing;
  }

  async getEmployerJobListing(id: number): Promise<EmployerJobListing | undefined> {
    const [listing] = await db.select().from(employerJobListings).where(eq(employerJobListings.id, id));
    return listing || undefined;
  }

  async getEmployerJobListingsByEmployer(employerId: number): Promise<EmployerJobListing[]> {
    return await db.select().from(employerJobListings).where(eq(employerJobListings.employerId, employerId)).orderBy(desc(employerJobListings.createdAt));
  }

  async getAllEmployerJobListings(): Promise<EmployerJobListing[]> {
    return await db.select().from(employerJobListings).orderBy(desc(employerJobListings.createdAt));
  }

  async getActiveEmployerJobListings(): Promise<(EmployerJobListing & { businessName: string | null })[]> {
    return await db.select({
      id: employerJobListings.id,
      employerId: employerJobListings.employerId,
      title: employerJobListings.title,
      description: employerJobListings.description,
      requirements: employerJobListings.requirements,
      location: employerJobListings.location,
      salary: employerJobListings.salary,
      employmentType: employerJobListings.employmentType,
      status: employerJobListings.status,
      postedAt: employerJobListings.postedAt,
      closedAt: employerJobListings.closedAt,
      createdAt: employerJobListings.createdAt,
      businessName: employerProfiles.businessName,
    }).from(employerJobListings)
      .innerJoin(employerProfiles, eq(employerJobListings.employerId, employerProfiles.id))
      .where(eq(employerJobListings.status, "active"))
      .orderBy(desc(employerJobListings.postedAt));
  }

  async updateEmployerJobListing(id: number, data: Partial<InsertEmployerJobListing>): Promise<EmployerJobListing | undefined> {
    const [listing] = await db.update(employerJobListings).set(data).where(eq(employerJobListings.id, id)).returning();
    return listing || undefined;
  }

  async deleteEmployerJobListing(id: number): Promise<boolean> {
    const result = await db.delete(employerJobListings).where(eq(employerJobListings.id, id)).returning();
    return result.length > 0;
  }

  async createEmployerCandidateAssignment(data: InsertEmployerCandidateAssignment): Promise<EmployerCandidateAssignment> {
    const [assignment] = await db.insert(employerCandidateAssignments).values(data).returning();
    return assignment;
  }

  async getEmployerCandidateAssignmentsByEmployer(employerId: number): Promise<EmployerCandidateAssignment[]> {
    return await db.select().from(employerCandidateAssignments).where(eq(employerCandidateAssignments.employerId, employerId)).orderBy(desc(employerCandidateAssignments.assignedAt));
  }

  async getEmployerCandidateAssignmentsByApplicant(applicantId: string): Promise<EmployerCandidateAssignment[]> {
    return await db.select().from(employerCandidateAssignments).where(eq(employerCandidateAssignments.applicantId, applicantId)).orderBy(desc(employerCandidateAssignments.assignedAt));
  }

  async getAllEmployerCandidateAssignments(): Promise<EmployerCandidateAssignment[]> {
    return await db.select().from(employerCandidateAssignments).orderBy(desc(employerCandidateAssignments.assignedAt));
  }

  async updateEmployerCandidateAssignment(id: number, data: Partial<InsertEmployerCandidateAssignment>): Promise<EmployerCandidateAssignment | undefined> {
    const [assignment] = await db.update(employerCandidateAssignments).set(data).where(eq(employerCandidateAssignments.id, id)).returning();
    return assignment || undefined;
  }

  async deleteEmployerCandidateAssignment(id: number): Promise<boolean> {
    const result = await db.delete(employerCandidateAssignments).where(eq(employerCandidateAssignments.id, id)).returning();
    return result.length > 0;
  }

  async getPaymentSettings(): Promise<PaymentSettings | undefined> {
    const [settings] = await db.select().from(paymentSettings).limit(1);
    return settings || undefined;
  }

  async upsertPaymentSettings(data: Partial<InsertPaymentSettings>): Promise<PaymentSettings> {
    const existing = await this.getPaymentSettings();
    if (existing) {
      const [updated] = await db.update(paymentSettings).set({ ...data, updatedAt: new Date() }).where(eq(paymentSettings.id, existing.id)).returning();
      return updated;
    }
    const [created] = await db.insert(paymentSettings).values({ ...data, updatedAt: new Date() } as any).returning();
    return created;
  }

  async createAdminInvite(invite: InsertAdminInvite): Promise<AdminInvite> {
    const [created] = await db.insert(adminInvites).values(invite).returning();
    return created;
  }

  async getAdminInviteByToken(token: string): Promise<AdminInvite | undefined> {
    const [invite] = await db.select().from(adminInvites).where(eq(adminInvites.token, token));
    return invite || undefined;
  }

  async getAllAdminInvites(): Promise<AdminInvite[]> {
    return await db.select().from(adminInvites).orderBy(desc(adminInvites.createdAt));
  }

  async markAdminInviteUsed(id: string): Promise<AdminInvite | undefined> {
    const [updated] = await db.update(adminInvites).set({ usedAt: new Date() }).where(eq(adminInvites.id, id)).returning();
    return updated || undefined;
  }
}

export const storage = new DatabaseStorage();
