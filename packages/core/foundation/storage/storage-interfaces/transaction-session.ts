import type { RequestContext } from '../../common/context/call-context';
import type { OperationCatalog, StorageScopes } from './operations';

/** 存储宿主内部契约。语句由可信适配器登记并按数据库绑定参数。 */
declare const statementTypes: unique symbol;

export interface Statement<Kind extends 'read' | 'lock' | 'write', Params, Row> {
  readonly name: string;
  readonly kind: Kind;
  readonly [statementTypes]: { readonly params: Params; readonly row: Row };
}

export interface ReadSession {
  query<P, R>(statement: Statement<'read', P, R>, params: NoInfer<P>): Promise<readonly R[]>;
}

export interface WriteResult<R> {
  readonly affectedRows: number;
  readonly rows: readonly R[];
}

export interface WriteSession extends ReadSession {
  /** 同一连接上的已存在行。空结果不能保护首次创建。锁在提交或回滚时释放。 */
  lockRows<P, R>(statement: Statement<'lock', P, R>, params: NoInfer<P>, mode: 'shared' | 'exclusive'): Promise<readonly R[]>;
  execute<P, R>(statement: Statement<'write', P, R>, params: NoInfer<P>): Promise<WriteResult<R>>;
  executeMany<P, R>(statement: Statement<'write', P, R>, params: readonly NoInfer<P>[]): Promise<WriteResult<R>>;
}

/** 仅用于拥有数据库连接的宿主。事务回调不得跨 RPC、返回会话或触发不可回滚的外部动作。 */
export interface TransactionRunner<C extends RequestContext> {
  read<T>(context: C, work: (session: ReadSession) => Promise<T>): Promise<T>;
  transaction<T>(context: C, work: (session: WriteSession) => Promise<T>): Promise<T>;
}

/** 每个写入口在宿主登记自己的保护依据，便于审查同一对象的其他写者。 */
export interface WriteGuard {
  readonly resource: string;
  readonly keyFields: readonly [string, ...string[]];
  readonly strategy: 'unique-key' | 'conditional-write' | 'row-lock';
}

export interface TransactionHandler<Context extends RequestContext, Input, Output> {
  readonly guards: readonly [WriteGuard, ...WriteGuard[]];
  run(context: Context, session: WriteSession, input: Input): Promise<Output>;
}

/** 进程内适配时，每个已登记写操作必须提供对应范围、输入和结果的处理器。 */
export type TransactionHandlers<C extends OperationCatalog<C>> = {
  readonly [K in keyof C as C[K]['kind'] extends 'transaction' ? K : never]:
    TransactionHandler<StorageScopes[C[K]['scope']], C[K]['input'], C[K]['output']>;
};
