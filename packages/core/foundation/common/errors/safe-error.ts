/** 仅包含可以交给调用方的信息。底层异常和堆栈按定位编号写日志。 */
export interface ApiError {
  readonly code: string;
  readonly error_id: string;
  readonly request_id: string;
  readonly message: string;
  readonly retryable: boolean;
}
