import type { ErrorCategory, ErrorDefinition } from './error-code';
import type { ApiError } from './safe-error';
import type { LogFields } from '../logging/logger';

export interface AppError extends Error {
  readonly definition: ErrorDefinition;
  readonly cause?: unknown;
}

/** 入口捕获未处理异常一次。日志与返回值使用同一 error_id/request_id。 */
export interface ErrorReporter {
  capture(error: unknown, context: LogFields): { readonly category: ErrorCategory; readonly response: ApiError };
}
