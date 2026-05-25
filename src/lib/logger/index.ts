import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type LogLevel = "debug" | "log" | "info" | "warn" | "error";

const DEFAULT_LOG_DIR = "/var/log/agent-insight";
const DEFAULT_LOG_LEVEL: LogLevel = "log";
const LOG_FILE_NAME = "agent-insight.log";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  log: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function resolveLogLevel(value?: string): LogLevel {
  const normalized = (value || "").toLowerCase();
  if (normalized === "debug" || normalized === "log" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return DEFAULT_LOG_LEVEL;
}

function isNodeRuntime(): boolean {
  return Boolean(process?.versions?.node);
}

export interface LoggerConfig {
  logDir: string;
  level: LogLevel;
}

interface LogPayload {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  context?: unknown;
}

const loggerConfig: LoggerConfig = {
  logDir: process.env.AGENT_INSIGHT_LOG_DIR || DEFAULT_LOG_DIR,
  level: resolveLogLevel(process.env.AGENT_INSIGHT_LOG_LEVEL || process.env.LOG_LEVEL),
};

let fileLoggingInitialized = false;
let fileLoggingAvailable = false;
let logFilePath = "";

function initializeFileLogging(): void {
  if (fileLoggingInitialized || !isNodeRuntime()) {
    return;
  }
  fileLoggingInitialized = true;

  try {
    if (!existsSync(loggerConfig.logDir)) {
      mkdirSync(loggerConfig.logDir, { recursive: true });
    }
    logFilePath = join(loggerConfig.logDir, LOG_FILE_NAME);
    fileLoggingAvailable = true;
  } catch (error) {
    fileLoggingAvailable = false;
    const err = error as Error;
    // Keep this warning visible even if file logging is unavailable.
    console.warn(`[logger] Failed to initialize file logging at ${loggerConfig.logDir}: ${err.message}`);
  }
}

function shouldWrite(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[loggerConfig.level];
}

function writeLine(line: string): void {
  initializeFileLogging();
  if (!fileLoggingAvailable || !logFilePath) {
    return;
  }
  try {
    appendFileSync(logFilePath, `${line}\n`, "utf-8");
  } catch (error) {
    const err = error as Error;
    console.warn(`[logger] Failed to append log file: ${err.message}`);
  }
}

function emit(level: LogLevel, scope: string, message: string, context?: unknown): void {
  if (!shouldWrite(level)) {
    return;
  }

  const payload: LogPayload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context !== undefined ? { context } : {}),
  };

  const line = JSON.stringify(payload);
  writeLine(line);

  // Console output remains available for local debugging.
  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
    case "log":
      console.log(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
    default:
      console.log(line);
  }
}

export interface AppLogger {
  debug(message: string, context?: unknown): void;
  log(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export function createLogger(scope: string): AppLogger {
  return {
    debug(message: string, context?: unknown) {
      emit("debug", scope, message, context);
    },
    log(message: string, context?: unknown) {
      emit("log", scope, message, context);
    },
    info(message: string, context?: unknown) {
      emit("info", scope, message, context);
    },
    warn(message: string, context?: unknown) {
      emit("warn", scope, message, context);
    },
    error(message: string, context?: unknown) {
      emit("error", scope, message, context);
    },
  };
}

export function getLoggerConfig(): LoggerConfig {
  return { ...loggerConfig };
}
