export interface LogFields {
  readonly requestId: string;
  readonly errorId?: string;
  readonly code?: string;
  readonly jobId?: string;
  readonly messageId?: string;
}

export interface Logger {
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields: LogFields): void;
}
