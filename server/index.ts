import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { seedAdminUser } from "./seed-admin";
import { logger } from "./logger";
import session from "express-session";
import pgSession from "connect-pg-simple";
import crypto from "crypto";
import helmet from "helmet";

declare module "express-session" {
  interface SessionData {
    userId: string;
    userRole: string;
  }
}

const app = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

const PgSession = pgSession(session);

const sessionStore = new PgSession({
  conString: process.env.DATABASE_URL,
  createTableIfMissing: false,
});

async function ensureSessionTable() {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `);
  } finally {
    await pool.end();
  }
}

ensureSessionTable().catch((err) => logger.error("Failed to ensure session table", err));

app.use(
  session({
    store: sessionStore,
    secret: (() => {
      const secret = process.env.SESSION_SECRET;
      if (!secret && process.env.NODE_ENV === "production") {
        throw new Error("SESSION_SECRET must be set in production");
      }
      return secret || crypto.randomBytes(32).toString("hex");
    })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
    proxy: true,
  })
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const sensitiveRoutes = ["/api/auth/login", "/api/auth/me", "/api/auth/register"];
        if (sensitiveRoutes.some(r => path.startsWith(r))) {
          const safe = capturedJsonResponse.id ? { id: capturedJsonResponse.id, role: capturedJsonResponse.role } : {};
          logLine += ` :: ${JSON.stringify(safe)}`;
        } else if (Array.isArray(capturedJsonResponse)) {
          logLine += ` :: [${capturedJsonResponse.length} items]`;
        } else if (typeof capturedJsonResponse === "object" && capturedJsonResponse !== null) {
          const keys = Object.keys(capturedJsonResponse);
          if (keys.includes("success") || keys.includes("error") || keys.includes("message")) {
            const summary: Record<string, any> = {};
            if (capturedJsonResponse.success !== undefined) summary.success = capturedJsonResponse.success;
            if (capturedJsonResponse.error) summary.error = capturedJsonResponse.error;
            if (capturedJsonResponse.message) summary.message = String(capturedJsonResponse.message).slice(0, 200);
            if (capturedJsonResponse.id) summary.id = capturedJsonResponse.id;
            logLine += ` :: ${JSON.stringify(summary)}`;
          } else {
            logLine += ` :: {${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""}}`;
          }
        }
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await seedAdminUser();
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    logger.error("Internal Server Error", err, { status });

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
