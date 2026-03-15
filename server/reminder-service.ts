import { storage } from "./storage";
import { sendEmailWithLogging } from "./email";
import { logger } from "./logger";

interface SessionReminder {
  sessionId: string;
  trainerId: string;
  trainerName: string;
  trainerEmail: string;
  sessionTime: Date;
  attendeeCount: number;
  attendees: { name: string; email: string }[];
}

interface PendingTask {
  type: "unconfirmed_session" | "incomplete_training" | "pending_attendance";
  description: string;
  count: number;
  items: any[];
}

export async function getUpcomingSessions(hoursAhead: number): Promise<SessionReminder[]> {
  const now = new Date();
  const futureTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
  const pastBuffer = new Date(now.getTime() + (hoursAhead - 1) * 60 * 60 * 1000);
  
  const sessions = await storage.getAllTrainingSessions();
  const users = await storage.getAllUsers();
  const applications = await storage.getAllApplications();
  
  const upcomingSessions: SessionReminder[] = [];
  
  for (const session of sessions) {
    const sessionTime = new Date(session.startTime);
    
    // Check for open or filled sessions (filled means someone booked it)
    if (sessionTime > pastBuffer && sessionTime <= futureTime && (session.status === "open" || session.status === "filled") && session.isArchived !== "true") {
      const trainer = users.find(u => u.id === session.trainerId);
      if (!trainer) continue;
      
      const sessionApps = applications.filter(app => 
        app.trainingSessionId === session.id && 
        (app.trainingStatus === "scheduled" || app.trainingStatus === "confirmed")
      );
      
      const attendees = sessionApps.map(app => {
        const applicant = users.find(u => u.id === app.applicantId);
        return {
          name: applicant?.name || "Unknown",
          email: applicant?.email || ""
        };
      }).filter(a => a.email);
      
      // Only include sessions that have at least one attendee
      if (attendees.length > 0) {
        upcomingSessions.push({
          sessionId: session.id,
          trainerId: trainer.id,
          trainerName: trainer.name,
          trainerEmail: trainer.email,
          sessionTime,
          attendeeCount: attendees.length,
          attendees
        });
      }
    }
  }
  
  return upcomingSessions;
}

export async function getPendingTasksForTrainer(trainerId: string): Promise<PendingTask[]> {
  const applications = await storage.getAllApplications();
  const sessions = await storage.getTrainingSessionsByTrainer(trainerId);
  const tasks: PendingTask[] = [];

  const relevantApps = applications.filter(app => app.trainerId === trainerId);
  const allUsers = await storage.getAllUsers();
  const userMap = new Map<string, { name: string; email: string }>();
  for (const user of allUsers) {
    userMap.set(user.id, { name: user.name, email: user.email });
  }

  const enrichItems = (apps: typeof applications) =>
    apps.map(app => {
      const user = userMap.get(app.applicantId);
      return { ...app, applicantName: user?.name || "Unknown", applicantEmail: user?.email || "" };
    });
  
  const unconfirmedSessions = relevantApps.filter(app => 
    app.trainingStatus === "scheduled" &&
    app.traineeConfirmed !== "true"
  );
  
  if (unconfirmedSessions.length > 0) {
    tasks.push({
      type: "unconfirmed_session",
      description: "Trainees with unconfirmed training sessions",
      count: unconfirmedSessions.length,
      items: enrichItems(unconfirmedSessions)
    });
  }
  
  const incompleteTraining = relevantApps.filter(app =>
    app.trainingStatus === "confirmed" &&
    app.trainerConfirmed !== "true"
  );
  
  if (incompleteTraining.length > 0) {
    tasks.push({
      type: "incomplete_training",
      description: "Training sessions awaiting completion confirmation",
      count: incompleteTraining.length,
      items: enrichItems(incompleteTraining)
    });
  }
  
  return tasks;
}

function formatSessionTime(date: Date): string {
  return date.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

export function generateSessionReminderEmail(reminder: SessionReminder, hoursUntil: number): { subject: string; html: string } {
  const timeLabel = hoursUntil <= 1 ? "1 hour" : "24 hours";
  
  const attendeeList = reminder.attendees.length > 0 
    ? reminder.attendees.map(a => `<li>${a.name} (${a.email})</li>`).join("")
    : "<li>No confirmed attendees yet</li>";
  
  const subject = `Reminder: Training Session in ${timeLabel}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Training Session Reminder</h1>
      </div>
      <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p>Hi ${reminder.trainerName},</p>
        
        <p>This is a friendly reminder that you have a training session coming up in <strong>${timeLabel}</strong>.</p>
        
        <div style="background: #f8fafc; border-left: 4px solid #667eea; padding: 16px; margin: 20px 0; border-radius: 0 8px 8px 0;">
          <p style="margin: 0 0 8px 0;"><strong>Session Details:</strong></p>
          <p style="margin: 4px 0;">📅 <strong>Date & Time:</strong> ${formatSessionTime(reminder.sessionTime)}</p>
          <p style="margin: 4px 0;">👥 <strong>Attendees:</strong> ${reminder.attendeeCount}</p>
        </div>
        
        <p><strong>Registered Attendees:</strong></p>
        <ul style="background: #f9fafb; padding: 16px 16px 16px 32px; border-radius: 8px;">
          ${attendeeList}
        </ul>
        
        <p style="margin-top: 24px;">Please make sure you're prepared and available at the scheduled time.</p>
        
        <div style="margin-top: 30px; text-align: center;">
          <a href="https://${process.env.REPL_SLUG || 'the-metrics'}.${process.env.REPL_OWNER || 'replit'}.repl.co/staff-login" 
             style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
            View Dashboard
          </a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
        <p style="color: #6b7280; font-size: 14px; text-align: center;">
          This is an automated reminder from The Metrics Platform.
          <br>
          <a href="mailto:info@portermetricscareeronboarding.com" style="color: #667eea;">Contact Support</a>
        </p>
      </div>
    </body>
    </html>
  `;
  
  return { subject, html };
}

export function generatePendingTasksEmail(trainerName: string, tasks: PendingTask[]): { subject: string; html: string } {
  const taskItems = tasks.map(task => `
    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 12px 0; border-radius: 0 8px 8px 0;">
      <p style="margin: 0; font-weight: 600;">⚠️ ${task.description}</p>
      <p style="margin: 4px 0 0 0; color: #92400e;">Count: ${task.count}</p>
    </div>
  `).join("");
  
  const subject = `Action Required: You have ${tasks.length} pending task(s)`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Pending Tasks Reminder</h1>
      </div>
      <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p>Hi ${trainerName},</p>
        
        <p>You have pending tasks that require your attention:</p>
        
        ${taskItems}
        
        <p style="margin-top: 24px;">Please log in to your dashboard to review and complete these tasks.</p>
        
        <div style="margin-top: 30px; text-align: center;">
          <a href="https://${process.env.REPL_SLUG || 'the-metrics'}.${process.env.REPL_OWNER || 'replit'}.repl.co/staff-login" 
             style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
            View Dashboard
          </a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
        <p style="color: #6b7280; font-size: 14px; text-align: center;">
          This is an automated reminder from The Metrics Platform.
          <br>
          <a href="mailto:info@portermetricscareeronboarding.com" style="color: #667eea;">Contact Support</a>
        </p>
      </div>
    </body>
    </html>
  `;
  
  return { subject, html };
}

export function generateWeeklyDigestEmail(
  trainerName: string, 
  upcomingSessions: number,
  completedSessions: number,
  pendingTasks: PendingTask[]
): { subject: string; html: string } {
  const taskSummary = pendingTasks.length > 0 
    ? pendingTasks.map(t => `<li>${t.description}: ${t.count}</li>`).join("")
    : "<li>No pending tasks - great job!</li>";
  
  const subject = `Weekly Digest: Your Training Summary`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Weekly Training Digest</h1>
      </div>
      <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p>Hi ${trainerName},</p>
        
        <p>Here's your weekly training summary:</p>
        
        <div style="display: flex; gap: 16px; margin: 20px 0;">
          <div style="flex: 1; background: #ecfdf5; padding: 16px; border-radius: 8px; text-align: center;">
            <p style="margin: 0; font-size: 32px; font-weight: bold; color: #059669;">${upcomingSessions}</p>
            <p style="margin: 4px 0 0 0; color: #047857; font-size: 14px;">Upcoming Sessions</p>
          </div>
          <div style="flex: 1; background: #f0fdf4; padding: 16px; border-radius: 8px; text-align: center;">
            <p style="margin: 0; font-size: 32px; font-weight: bold; color: #16a34a;">${completedSessions}</p>
            <p style="margin: 4px 0 0 0; color: #15803d; font-size: 14px;">Completed This Week</p>
          </div>
        </div>
        
        <p><strong>Pending Tasks:</strong></p>
        <ul style="background: #f9fafb; padding: 16px 16px 16px 32px; border-radius: 8px;">
          ${taskSummary}
        </ul>
        
        <div style="margin-top: 30px; text-align: center;">
          <a href="https://${process.env.REPL_SLUG || 'the-metrics'}.${process.env.REPL_OWNER || 'replit'}.repl.co/staff-login" 
             style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
            View Full Dashboard
          </a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
        <p style="color: #6b7280; font-size: 14px; text-align: center;">
          This is your weekly digest from The Metrics Platform.
          <br>
          <a href="mailto:info@portermetricscareeronboarding.com" style="color: #667eea;">Contact Support</a>
        </p>
      </div>
    </body>
    </html>
  `;
  
  return { subject, html };
}

export async function sendSessionReminder(reminder: SessionReminder, reminderType: "session_24h" | "session_1h"): Promise<boolean> {
  const settings = await storage.getReminderSettings(reminder.trainerId);
  
  if (settings?.emailNotifications === "false") {
    return false;
  }
  
  if (reminderType === "session_24h" && settings?.sessionReminder24h === "false") {
    return false;
  }
  
  if (reminderType === "session_1h" && settings?.sessionReminder1h === "false") {
    return false;
  }
  
  const existing = await storage.getExistingReminder(
    reminder.trainerId, 
    reminder.sessionId, 
    reminderType
  );
  
  if (existing) {
    return false;
  }
  
  const hoursUntil = reminderType === "session_1h" ? 1 : 24;
  const email = generateSessionReminderEmail(reminder, hoursUntil);
  
  const success = await sendEmailWithLogging(
    { to: reminder.trainerEmail, subject: email.subject, html: email.html },
    { 
      recipientName: reminder.trainerName, 
      emailType: `trainer_${reminderType}`,
      sentBy: "system"
    }
  );
  
  await storage.createScheduledReminder({
    trainerId: reminder.trainerId,
    reminderType,
    sessionId: reminder.sessionId,
    scheduledFor: new Date(),
    status: success ? "sent" : "failed",
    errorMessage: success ? undefined : "Failed to send email"
  });
  
  return success;
}

export async function sendPendingTasksReminder(trainerId: string, applicationIds?: string[]): Promise<boolean> {
  const settings = await storage.getReminderSettings(trainerId);
  
  if (settings?.emailNotifications === "false" || settings?.pendingTasksReminder === "false") {
    return false;
  }
  
  if (!applicationIds || applicationIds.length === 0) {
    const existing = await storage.getExistingReminder(trainerId, undefined, "pending_tasks");
    if (existing) {
      const sentTime = new Date(existing.scheduledFor);
      const hoursSinceSent = (Date.now() - sentTime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceSent < 24) {
        return false;
      }
    }
  }
  
  const trainer = await storage.getUser(trainerId);
  if (!trainer) return false;
  
  let tasks = await getPendingTasksForTrainer(trainerId);
  if (tasks.length === 0) return false;
  
  if (applicationIds && applicationIds.length > 0) {
    const idSet = new Set(applicationIds);
    tasks = tasks.map(task => ({
      ...task,
      items: task.items.filter((item: any) => idSet.has(item.id)),
      count: task.items.filter((item: any) => idSet.has(item.id)).length
    })).filter(task => task.count > 0);
    if (tasks.length === 0) return false;
  }
  
  const email = generatePendingTasksEmail(trainer.name, tasks);
  
  const success = await sendEmailWithLogging(
    { to: trainer.email, subject: email.subject, html: email.html },
    {
      recipientName: trainer.name,
      emailType: "trainer_pending_tasks",
      sentBy: "system"
    }
  );
  
  await storage.createScheduledReminder({
    trainerId,
    reminderType: "pending_tasks",
    scheduledFor: new Date(),
    status: success ? "sent" : "failed"
  });
  
  return success;
}

export async function processScheduledReminders(): Promise<{ processed: number; sent: number; failed: number }> {
  let processed = 0;
  let sent = 0;
  let failed = 0;
  
  const sessions24h = await getUpcomingSessions(24);
  for (const session of sessions24h) {
    processed++;
    const success = await sendSessionReminder(session, "session_24h");
    if (success) sent++;
    else failed++;
  }
  
  const sessions1h = await getUpcomingSessions(1);
  for (const session of sessions1h) {
    processed++;
    const success = await sendSessionReminder(session, "session_1h");
    if (success) sent++;
    else failed++;
  }
  
  // Only send pending tasks reminders to trainers who have upcoming sessions
  const allUpcomingSessions = await getUpcomingSessions(168); // Next 7 days
  const trainersWithSessions = Array.from(new Set(allUpcomingSessions.map(s => s.trainerId)));
  
  for (const trainerId of trainersWithSessions) {
    const settings = await storage.getReminderSettings(trainerId);
    if (settings?.pendingTasksReminder === "true") {
      processed++;
      const success = await sendPendingTasksReminder(trainerId);
      if (success) sent++;
      else failed++;
    }
  }
  
  return { processed, sent, failed };
}

let reminderInterval: NodeJS.Timeout | null = null;

export function startReminderScheduler(intervalMinutes: number = 15): void {
  if (reminderInterval) {
    clearInterval(reminderInterval);
  }
  
  logger.info("Starting reminder scheduler", { intervalMinutes });
  
  processScheduledReminders()
    .then(result => logger.info("Initial reminder check", result))
    .catch(err => logger.error("Initial reminder check failed", err));
  
  reminderInterval = setInterval(async () => {
    try {
      const result = await processScheduledReminders();
      if (result.sent > 0 || result.failed > 0) {
        logger.info("Reminder check completed", result);
      }
      
      const now = new Date();
      if (now.getHours() === 9 && now.getMinutes() < 60) {
        const nudgeResult = await checkTrainerNudges();
        if (nudgeResult.nudgesSent > 0 || nudgeResult.errors > 0) {
          logger.info("Trainer nudge check completed", nudgeResult);
        }
      }
    } catch (err) {
      logger.error("Reminder scheduler error", err);
    }
  }, intervalMinutes * 60 * 1000);
}

export function stopReminderScheduler(): void {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
    logger.info("Reminder scheduler stopped");
  }
}

export async function checkTrainerNudges(): Promise<{ nudgesSent: number; errors: number }> {
  let nudgesSent = 0;
  let errors = 0;
  
  try {
    const allUsers = await storage.getAllUsers();
    const trainers = allUsers.filter(u => u.role === "trainer" && u.isApproved === "true");
    const allApps = await storage.getAllApplications();
    const allSessions = await storage.getAllTrainingSessions();
    
    for (const trainer of trainers) {
      const assignedApps = allApps.filter(a => 
        a.trainerId === trainer.id && 
        a.status === "accepted" && 
        (!a.trainingStatus || a.trainingStatus === "requested")
      );
      
      if (assignedApps.length === 0) continue;
      
      const hasUpcomingSession = allSessions.some(s => 
        s.trainerId === trainer.id && 
        s.status !== "completed" && 
        s.isArchived !== "true" &&
        new Date(s.startTime) > new Date()
      );
      
      if (hasUpcomingSession) continue;
      
      const pendingTrainees = assignedApps.map(app => {
        const applicant = allUsers.find(u => u.id === app.applicantId);
        return { name: applicant?.name || "Unknown", email: applicant?.email || "" };
      }).filter(t => t.email);
      
      if (pendingTrainees.length > 0) {
        try {
          const { sendTrainerNudgeEmail } = await import("./email");
          await sendTrainerNudgeEmail(
            trainer.email,
            trainer.name,
            pendingTrainees,
            "unscheduled_trainees"
          );
          nudgesSent++;
          logger.info("Sent trainer nudge email", { trainerId: trainer.id, pendingCount: pendingTrainees.length });
        } catch (err) {
          errors++;
          logger.error("Failed to send trainer nudge", { trainerId: trainer.id, error: err });
        }
      }
    }
  } catch (err) {
    logger.error("Trainer nudge check failed", { error: err });
    errors++;
  }
  
  return { nudgesSent, errors };
}
