import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { startReminderScheduler } from "./reminder-service";
import { startSessionScheduler } from "./session-scheduler";
import { startBackupScheduler } from "./backup-scheduler";

import { registerAuthUserRoutes } from "./routes/auth-users";
import { registerApplicationRoutes } from "./routes/applications";
import { registerTrainingRoutes } from "./routes/training";
import { registerEmailLeadRoutes } from "./routes/email-leads";
import { registerAdminRoutes } from "./routes/admin";
import { registerEmployerRoutes } from "./routes/employer";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  registerObjectStorageRoutes(app);

  registerAuthUserRoutes(app);
  registerApplicationRoutes(app);
  registerTrainingRoutes(app);
  registerEmailLeadRoutes(app);
  registerAdminRoutes(app);
  registerEmployerRoutes(app);

  startReminderScheduler();
  startSessionScheduler();
  startBackupScheduler();

  return httpServer;
}
