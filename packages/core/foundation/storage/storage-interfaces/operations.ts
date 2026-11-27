import type { CallContext, RequestContext, WorkspaceContext } from '../../common/context/call-context';

/** 绑定到已验证的身份。适配器按操作重新检查授权，禁止从 HTTP body 构造。 */
export interface StorageScopes {
  readonly principal: RequestContext;
  readonly project: CallContext;
  readonly workspace: WorkspaceContext;
}

export type StorageOperationKind = 'snapshot' | 'transaction' | 'analytical-query' | 'analytical-append' | 'analytical-delete';

/** 类型目录由调用模块提供。宿主把固定操作名绑定到参数校验、授权和对应后端操作。 */
export interface StorageOperation<Kind extends StorageOperationKind, Scope extends keyof StorageScopes, Input, Output> {
  readonly kind: Kind;
  readonly scope: Scope;
  readonly input: Input;
  readonly output: Output;
}

export type OperationCatalog<C> = {
  readonly [K in keyof C]: StorageOperation<StorageOperationKind, keyof StorageScopes, unknown, unknown>;
};

type OperationNames<C, Kind> = Extract<{
  [K in keyof C]: C[K] extends { readonly kind: Kind } ? K : never
}[keyof C], string>;

/** 每一组参数由同一个操作名决定，操作名为联合类型时也不能混搭输入和身份。 */
export type OperationArgs<C extends OperationCatalog<C>, Kind extends StorageOperationKind> = {
  [K in OperationNames<C, Kind>]: [
    operation: K, context: StorageScopes[C[K]['scope']], input: C[K]['input'],
  ]
}[OperationNames<C, Kind>];

export type OperationResult<C, Args> = Args extends readonly [infer K extends keyof C, ...unknown[]]
  ? C[K] extends { readonly output: infer Output } ? Output : never
  : never;
