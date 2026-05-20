type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|secret|token|api[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token/i;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/g;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[A-Za-z0-9_-]{20,}\b/g;
const GOOGLE_OAUTH_TOKEN_PATTERN = /\bya29\.[A-Za-z0-9._-]+\b/g;
const POSTGRES_PASSWORD_PATTERN = /(postgres(?:ql)?:\/\/[^:\s"']+:)([^@\s"']+)(@)/gi;

function getMinimumLevel(): LogLevel {
  const configuredLevel = process.env.LOG_LEVEL?.toLowerCase();

  if (
    configuredLevel === "debug" ||
    configuredLevel === "info" ||
    configuredLevel === "warn" ||
    configuredLevel === "error"
  ) {
    return configuredLevel;
  }

  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function shouldLog(level: LogLevel) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinimumLevel()];
}

function redactString(value: string) {
  const redacted = value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED_OPENAI_KEY]")
    .replace(GOOGLE_API_KEY_PATTERN, "[REDACTED_GOOGLE_API_KEY]")
    .replace(GOOGLE_OAUTH_TOKEN_PATTERN, "[REDACTED_GOOGLE_OAUTH_TOKEN]")
    .replace(POSTGRES_PASSWORD_PATTERN, "$1[REDACTED]$3")
    .replace(EMAIL_PATTERN, "[EMAIL]");

  return redacted.length > 1_000 ? `${redacted.slice(0, 1_000)}...` : redacted;
}

export function sanitizeForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (depth >= 6) {
    return "[MAX_DEPTH]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }

    seen.add(value);

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, entryValue]) => [
          key,
          SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeForLog(entryValue, depth + 1, seen)
        ])
    );
  }

  return String(value);
}

export function serializeError(error: unknown) {
  if (!(error instanceof Error)) {
    return {
      name: "UnknownError",
      message: String(sanitizeForLog(error))
    };
  }

  return {
    name: error.name,
    message: redactString(error.message),
    stack: process.env.NODE_ENV === "production" ? undefined : redactString(error.stack ?? "")
  };
}

function writeLog(level: LogLevel, message: string, context: LogContext = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const safeContext = sanitizeForLog(context) as LogContext;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "jobmatch-crm",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    version: process.env.APP_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12),
    message,
    ...safeContext
  };

  const serialized = JSON.stringify(entry);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}

export const logger = {
  debug(message: string, context?: LogContext) {
    writeLog("debug", message, context);
  },
  info(message: string, context?: LogContext) {
    writeLog("info", message, context);
  },
  warn(message: string, context?: LogContext) {
    writeLog("warn", message, context);
  },
  error(message: string, context?: LogContext) {
    writeLog("error", message, context);
  }
};

export function captureException(error: unknown, context: LogContext = {}) {
  logger.error("exception.captured", {
    ...context,
    error: serializeError(error)
  });
}
