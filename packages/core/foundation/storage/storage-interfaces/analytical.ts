import type { OperationArgs, OperationCatalog, OperationResult } from './operations';

export interface AnalyticalStore<C extends OperationCatalog<C>> {
  /** 由操作声明筛选、排序、分页或聚合，以及快照版本。 */
  query<A extends OperationArgs<C, 'analytical-query'>>(...args: A): Promise<OperationResult<C, A>>;
  /** 批次标识、版本和摘要由已注册的写操作校验，用于提交结果不明后的重放。 */
  append<A extends OperationArgs<C, 'analytical-append'>>(...args: A): Promise<OperationResult<C, A>>;
  /** 限定已授权范围；需要同步删除的操作在后端确认生效后返回。 */
  remove<A extends OperationArgs<C, 'analytical-delete'>>(...args: A): Promise<OperationResult<C, A>>;
}
