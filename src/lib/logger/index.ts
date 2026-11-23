/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLogLevel, isLogEnabled, sanitizeLogValue, type LogLevel } from './server';
export { installServerLogging, isLogEnabled } from './server';

const DEFAULT_LOG_DIR = "/var/log/agent-insight";
const LOG_FILE_NAME = "agent-insight.log";

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

let initializedDirectory: string | undefined;
let fileLoggingAvailable = false;
let logFilePath = "";

function initializeFileLogging(): void {
  const { logDir } = getLoggerConfig();
  if (initializedDirectory === logDir || !isNodeRuntime()) {
    return;
  }
  initializedDirectory = logDir;

  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    logFilePath = join(logDir, LOG_FILE_NAME);
    fileLoggingAvailable = true;
  } catch (error) {
    fileLoggingAvailable = false;
    const err = error as NodeJS.ErrnoException;
    // Keep this warning visible even if file logging is unavailable.
    console.error(`[logger] Failed to initialize file logging: ${err.code || err.name}`);
  }
}

function writeLine(line: string): void {
  initializeFileLogging();
  if (!fileLoggingAvailable || !logFilePath) {
    return;
  }
  try {
    appendFileSync(logFilePath, `${line}\n`, "utf-8");
  } catch {
    fileLoggingAvailable = false;
    console.error('[logger] Failed to append log file; continuing with console output');
  }
}

function emit(level: LogLevel, scope: string, message: string, context?: unknown): void {
  if (!isLogEnabled(level)) {
    return;
  }

  const payload: LogPayload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context !== undefined ? { context } : {}),
  };

  let line: string;
  try { line = JSON.stringify(sanitizeLogValue(payload)); }
  catch { line = JSON.stringify({ ts: payload.ts, level, scope, message: '[logger] log formatting failed' }); }
  try {
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
  } catch { /* Logging cannot fail a business operation. */ }
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
  return { logDir: process.env.AGENT_INSIGHT_LOG_DIR || DEFAULT_LOG_DIR, level: getLogLevel() };
}
