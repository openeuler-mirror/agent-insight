import type { LogRedactor } from './redaction';
import type { Logger, LogLevel } from './logger';

export type LogDestination =
  | { readonly kind: 'stdout' }
  | { readonly kind: 'file'; readonly directory: string; readonly maxFileBytes: number;
      readonly retentionDays: number; readonly maxTotalBytes: number };

export interface LoggingPolicy {
  /** 生产环境默认 warn。stdout 的轮转和保留由部署平台负责。 */
  readonly minLevel: LogLevel;
  readonly destination: LogDestination;
}

/** 由宿主统一选定输出目标、过滤等级、脱敏和文件保留策略。 */
export interface LoggerProvider {
  createLogger(policy: LoggingPolicy, redactor: LogRedactor): Logger;
}
