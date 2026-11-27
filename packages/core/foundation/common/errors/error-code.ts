export type ErrorCategory =
  | 'invalid-input' | 'unauthenticated' | 'forbidden' | 'not-found'
  | 'conflict' | 'gone' | 'payload-too-large' | 'unsupported-media' | 'invalid-content'
  | 'capacity' | 'unsupported-operation' | 'upstream-failure' | 'unavailable' | 'internal';

/** 各模块登记稳定的业务码。可重试指可依操作契约重试，写操作必须核对幂等键。 */
export interface ErrorDefinition {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly safeMessage: string;
  readonly retryable: boolean;
}
