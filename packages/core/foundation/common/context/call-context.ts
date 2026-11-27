/** 由可信入口在认证后构造。requestId 用于定位一次调用，不能代替业务幂等键。 */
export interface RequestContext {
  readonly principalId: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface CallContext extends RequestContext {
  readonly projectId: string;
}

export interface WorkspaceContext extends CallContext {
  readonly workspaceId: string;
}
