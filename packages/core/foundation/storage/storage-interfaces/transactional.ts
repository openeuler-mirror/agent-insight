import type { OperationArgs, OperationCatalog, OperationResult } from './operations';

/** 业务层入口。一个注册操作在存储宿主的一条连接内完成，不传递 SQL 或远程回调。 */
export interface TransactionalStore<C extends OperationCatalog<C>> {
  read<A extends OperationArgs<C, 'snapshot'>>(...args: A): Promise<OperationResult<C, A>>;
  /** 只有完整提交后才返回成功。多对象写入的保护范围和幂等语义由该操作定义。 */
  transaction<A extends OperationArgs<C, 'transaction'>>(...args: A): Promise<OperationResult<C, A>>;
}
