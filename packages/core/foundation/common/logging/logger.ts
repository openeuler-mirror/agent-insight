import type { LogValue } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly requestId: string;
  readonly module?: string;
  readonly instanceId?: string;
  readonly errorId?: string;
  readonly code?: string;
  readonly jobId?: string;
  readonly messageId?: string;
}

export interface Logger {
  log(level: LogLevel, message: string, fields: LogFields, details?: Readonly<Record<string, LogValue>>): void;
}
