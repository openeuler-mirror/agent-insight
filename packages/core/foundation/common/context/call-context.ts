/** 项目业务入口在认证完成后构造。取消信号仅对当前调用有效。 */
export interface CallContext {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}
