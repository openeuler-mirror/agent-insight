import type { AnalyticalStore } from './storage-interfaces/analytical';
import type { ArtifactStore } from './storage-interfaces/artifacts';
import type { CacheStore } from './storage-interfaces/cache';
import type { OperationCatalog } from './storage-interfaces/operations';
import type { TransactionalStore } from './storage-interfaces/transactional';

export type { AnalyticalStore, ArtifactStore, CacheStore, TransactionalStore };
export type { StorageOperation, StorageScopes } from './storage-interfaces/operations';

export interface Storage<C extends OperationCatalog<C>> {
  readonly transactional: TransactionalStore<C>;
  readonly analytical: AnalyticalStore<C>;
  readonly artifacts: ArtifactStore;
  readonly cache: CacheStore;
}

/** 配置由 bootstrap 注入。连接和驱动的生命周期归宿主。 */
export interface StorageProvider<C extends OperationCatalog<C>, Config> {
  createStorage(config: Config): Promise<Storage<C>>;
  close(): Promise<void>;
}
