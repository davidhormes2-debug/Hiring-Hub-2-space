type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isProduction = process.env.NODE_ENV === "production";
const minLevel: LogLevel = isProduction ? "info" : "debug";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

function formatLog(entry: LogEntry): string {
  const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${contextStr}`;
}

function createLogEntry(level: LogLevel, message: string, context?: Record<string, unknown>): LogEntry {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    context,
  };
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>) {
    if (!shouldLog("debug")) return;
    const entry = createLogEntry("debug", message, context);
    console.log(formatLog(entry));
  },

  info(message: string, context?: Record<string, unknown>) {
    if (!shouldLog("info")) return;
    const entry = createLogEntry("info", message, context);
    console.log(formatLog(entry));
  },

  warn(message: string, context?: Record<string, unknown>) {
    if (!shouldLog("warn")) return;
    const entry = createLogEntry("warn", message, context);
    console.warn(formatLog(entry));
  },

  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    if (!shouldLog("error")) return;
    const errorContext = {
      ...context,
      ...(error instanceof Error ? { 
        errorMessage: error.message, 
        stack: error.stack 
      } : { errorDetails: String(error) }),
    };
    const entry = createLogEntry("error", message, errorContext);
    console.error(formatLog(entry));
  },

  request(method: string, path: string, statusCode: number, durationMs: number) {
    if (!shouldLog("info")) return;
    const entry = createLogEntry("info", `${method} ${path} ${statusCode} in ${durationMs}ms`);
    console.log(formatLog(entry));
  },
};

export default logger;
