import type { WorkspaceContext } from '../../common/context/call-context';

/** 键按授权工作区隔离。未命中时调用者应能重建数据。 */
export interface CacheStore {
  get(context: WorkspaceContext, key: string): Promise<Uint8Array | undefined>;
  set(context: WorkspaceContext, key: string, value: Uint8Array, ttlSeconds: number): Promise<void>;
  delete(context: WorkspaceContext, key: string): Promise<void>;
}
