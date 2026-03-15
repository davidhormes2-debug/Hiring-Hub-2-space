import webpush from "web-push";
import { storage } from "./storage";
import { logger } from "./logger";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = "mailto:info@portermetricscareeronboarding.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  logger.info("Web Push configured successfully");
} else {
  logger.warn("VAPID keys not configured - push notifications disabled");
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  requireInteraction?: boolean;
  notificationId?: string;
  actions?: { action: string; title: string }[];
}

export async function sendPushNotification(
  userId: string,
  payload: PushNotificationPayload
): Promise<{ success: number; failed: number }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    logger.warn("Push notifications not configured");
    return { success: 0, failed: 0 };
  }

  const subscriptions = await storage.getPushSubscriptionsByUser(userId);
  let success = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    if (sub.isActive !== "true") continue;

    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        },
        JSON.stringify(payload)
      );
      success++;
    } catch (error: any) {
      failed++;
      logger.error("Push notification failed", error, { subscriptionId: sub.id });
      
      if (error.statusCode === 404 || error.statusCode === 410) {
        await storage.deletePushSubscription(sub.id);
        logger.info("Removed expired subscription", { subscriptionId: sub.id });
      }
    }
  }

  return { success, failed };
}

export async function sendPushToRole(
  role: string,
  payload: PushNotificationPayload
): Promise<{ success: number; failed: number }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return { success: 0, failed: 0 };
  }

  const subscriptions = await storage.getActivePushSubscriptionsByRole(role);
  let success = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        },
        JSON.stringify(payload)
      );
      success++;
    } catch (error: any) {
      failed++;
      if (error.statusCode === 404 || error.statusCode === 410) {
        await storage.deletePushSubscription(sub.id);
      }
    }
  }

  return { success, failed };
}

export async function notifyAdmins(
  title: string,
  body: string,
  url?: string
): Promise<void> {
  await sendPushToRole("admin", {
    title,
    body,
    url: url || "/admin",
    tag: "admin-notification",
    requireInteraction: true
  });
}

export async function notifyTrainer(
  trainerId: string,
  title: string,
  body: string,
  url?: string
): Promise<void> {
  await sendPushNotification(trainerId, {
    title,
    body,
    url: url || "/trainer",
    tag: "trainer-notification"
  });
}

export async function notifyApplicant(
  applicantId: string,
  title: string,
  body: string,
  url?: string
): Promise<void> {
  await sendPushNotification(applicantId, {
    title,
    body,
    url: url || "/status",
    tag: "applicant-notification"
  });
}

export async function notifyReferrer(
  referrerId: string,
  title: string,
  body: string,
  url?: string
): Promise<void> {
  await sendPushNotification(referrerId, {
    title,
    body,
    url: url || "/referrer",
    tag: "referrer-notification"
  });
}

export async function notifyNewApplication(applicantName: string): Promise<void> {
  await notifyAdmins(
    "New Application Received",
    `${applicantName} has submitted a new application`,
    "/admin"
  );
}

export async function notifyTrainerAssignment(
  trainerId: string,
  traineeName: string
): Promise<void> {
  await notifyTrainer(
    trainerId,
    "New Trainee Assigned",
    `${traineeName} has been assigned to you for training`,
    "/trainer"
  );
}

export async function notifyApplicationStatusChange(
  applicantId: string,
  status: string
): Promise<void> {
  const statusMessages: Record<string, string> = {
    accepted: "Congratulations! Your application has been accepted",
    rejected: "Your application status has been updated",
    under_review: "Your application is now under review"
  };
  
  await notifyApplicant(
    applicantId,
    "Application Update",
    statusMessages[status] || "Your application status has changed",
    "/status"
  );
}

export async function notifyTrainingScheduled(
  applicantId: string,
  trainerName: string,
  sessionDate: Date
): Promise<void> {
  const formattedDate = sessionDate.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  
  await notifyApplicant(
    applicantId,
    "Training Scheduled",
    `Your training with ${trainerName} is scheduled for ${formattedDate}`,
    "/status"
  );
}

export async function notifySessionReminder(
  userId: string,
  role: string,
  minutesBefore: number,
  sessionDetails: string
): Promise<void> {
  const timeLabel = minutesBefore >= 60 
    ? `${Math.floor(minutesBefore / 60)} hour${minutesBefore >= 120 ? 's' : ''}` 
    : `${minutesBefore} minutes`;
  
  await sendPushNotification(userId, {
    title: `Session Starting in ${timeLabel}`,
    body: sessionDetails,
    url: role === "trainer" ? "/trainer" : "/status",
    tag: `session-reminder-${minutesBefore}`,
    requireInteraction: true
  });
}

export async function notifyReferralUsed(
  referrerId: string,
  applicantName: string
): Promise<void> {
  await notifyReferrer(
    referrerId,
    "New Referral!",
    `${applicantName} used your referral code to apply`,
    "/referrer"
  );
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}
