import { storage } from "./storage";
import { logger } from "./logger";

const BACKUP_URL = process.env.BACKUP_URL || "";
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

let consecutiveFailures = 0;
let lastBackupStatus: { success: boolean; message: string; timestamp: string } | null = null;

async function collectBackupData() {
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

  return {
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
}

export function getBackupStatus() {
  return { lastBackupStatus, consecutiveFailures };
}

export async function sendBackupToExternal(): Promise<{ success: boolean; message: string }> {
  try {
    if (!BACKUP_URL) {
      const msg = "BACKUP_URL not configured — skipping backup";
      lastBackupStatus = { success: false, message: msg, timestamp: new Date().toISOString() };
      return { success: false, message: msg };
    }

    const apiKey = process.env.BACKUP_API_KEY;
    if (!apiKey) {
      const msg = "BACKUP_API_KEY not set — skipping backup send";
      if (consecutiveFailures === 0) {
        logger.warn(msg);
      }
      consecutiveFailures++;
      lastBackupStatus = { success: false, message: msg, timestamp: new Date().toISOString() };
      return { success: false, message: msg };
    }

    if (consecutiveFailures === 0) {
      logger.info("Collecting backup data...");
    }
    const backupData = await collectBackupData();

    if (consecutiveFailures === 0) {
      logger.info("Sending backup to external app...");
    }
    const response = await fetch(BACKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "hiring-hub",
        data: backupData,
        apiKey,
      }),
    });

    if (response.ok) {
      const msg = `Backup sent successfully (status ${response.status})`;
      logger.info(msg);
      if (consecutiveFailures > 0) {
        logger.info(`Backup recovered after ${consecutiveFailures} consecutive failure(s)`);
      }
      consecutiveFailures = 0;
      lastBackupStatus = { success: true, message: msg, timestamp: new Date().toISOString() };
      return { success: true, message: msg };
    } else {
      const body = await response.text().catch(() => "");
      const msg = `Backup send failed: ${response.status} ${response.statusText} — ${body}`;
      consecutiveFailures++;
      lastBackupStatus = { success: false, message: msg, timestamp: new Date().toISOString() };
      if (consecutiveFailures === 1) {
        logger.warn(msg);
      } else {
        logger.debug(`Backup still failing (attempt #${consecutiveFailures}): ${response.status} ${response.statusText}`);
      }
      return { success: false, message: msg };
    }
  } catch (error: any) {
    const msg = `Backup send error: ${error.message}`;
    consecutiveFailures++;
    lastBackupStatus = { success: false, message: msg, timestamp: new Date().toISOString() };
    if (consecutiveFailures === 1) {
      logger.warn(msg);
    } else {
      logger.debug(`Backup still failing (attempt #${consecutiveFailures}): ${error.message}`);
    }
    return { success: false, message: msg };
  }
}

export function startBackupScheduler() {
  if (!BACKUP_URL) {
    logger.info("Backup scheduler disabled — BACKUP_URL not configured");
    lastBackupStatus = { success: false, message: "Disabled — no BACKUP_URL", timestamp: new Date().toISOString() };
    return;
  }

  logger.info(`Backup scheduler started — will send every ${INTERVAL_MS / 3600000}h`);

  setTimeout(() => {
    sendBackupToExternal();
  }, STARTUP_DELAY_MS);

  setInterval(() => {
    sendBackupToExternal();
  }, INTERVAL_MS);
}
