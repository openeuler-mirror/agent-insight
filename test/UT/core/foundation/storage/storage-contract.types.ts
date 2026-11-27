import type { CallContext, WorkspaceContext } from '../../../../../packages/core/foundation/common/context/call-context';
import type { Storage, StorageOperation } from '../../../../../packages/core/foundation/storage';
import type { Statement, TransactionHandler, TransactionRunner } from '../../../../../packages/core/foundation/storage/storage-interfaces/transaction-session';
import type { ErrorReporter } from '../../../../../packages/core/foundation/common/errors/app-error';

type Edit = { id: string; expectedRevision: string; operationKey: string; digest: string };
type Saved = { revision: string };
type TracePage = { ids: readonly string[]; nextCursor?: string };

// 业务操作名和数据由模块约定，foundation 无需导入评测集或 Trace 模块。
interface ExampleOperations {
  'dataset.save': StorageOperation<'transaction', 'workspace', Edit, Saved>;
  'dataset.head': StorageOperation<'snapshot', 'workspace', { id: string }, Saved>;
  'trace.page': StorageOperation<'analytical-query', 'workspace', { cursor?: string }, TracePage>;
  'facts.append': StorageOperation<'analytical-append', 'workspace', { eventId: string; revision: string }, void>;
  'facts.delete': StorageOperation<'analytical-delete', 'workspace', { ids: readonly string[] }, void>;
}

export async function saveDataset(store: Storage<ExampleOperations>, ctx: WorkspaceContext, input: Edit): Promise<Saved> {
  return store.transactional.transaction('dataset.save', ctx, input);
}

export async function readTraces(store: Storage<ExampleOperations>, ctx: WorkspaceContext): Promise<TracePage> {
  return store.analytical.query('trace.page', ctx, {});
}

// 编译期反例。真实并发与回滚另外用两个独立数据库连接验证。
export async function checkBoundaries(
  store: Storage<ExampleOperations>, runner: TransactionRunner<WorkspaceContext>, ctx: WorkspaceContext,
  project: CallContext, edit: Edit, update: Statement<'write', Edit, Saved>, errors: ErrorReporter,
): Promise<void> {
  // @ts-expect-error 该写操作不属于只读目录。
  await store.transactional.read('dataset.save', ctx, edit);
  // @ts-expect-error 仅有项目身份不能读取工作区数据。
  await store.analytical.query('trace.page', project, {});
  // @ts-expect-error 缺少版本、摘要和操作键。
  await store.transactional.transaction('dataset.save', ctx, { id: edit.id });
  // @ts-expect-error 分析查询不能作为事务控制记录写入。
  await store.transactional.transaction('trace.page', ctx, {});
  await runner.read(ctx, async session => {
    // @ts-expect-error 只读事务没有写入能力。
    await session.execute(update, edit);
  });
  const { response: safe } = errors.capture(new Error('internal cause'), { requestId: ctx.requestId });
  // @ts-expect-error 底层异常不会作为安全响应的字段交给调用方。
  void safe.cause;
}

// 仅示范已有草稿的单行版本更新。完整发布时还要在同一 session 写 release、回执及 outbox。
export function editDraftHandler(
  compareAndSet: Statement<'write', { id: string; expectedRevision: string; digest: string }, Saved>,
  versionConflict: () => Error,
): TransactionHandler<WorkspaceContext, { id: string; expectedRevision: string; digest: string }, Saved> {
  return {
    guards: [{ resource: 'asset_drafts', keyFields: ['draft_id', 'edit_revision'], strategy: 'conditional-write' }],
    async run(_context, session, edit) {
      const result = await session.execute(compareAndSet, edit);
      if (result.affectedRows !== 1) throw versionConflict();
      const [saved] = result.rows;
      if (!saved) throw new Error('Missing updated draft revision');
      return saved;
    },
  };
}
