import type { CallContext } from '../../common/context/call-context';

/** 键按项目隔离。未命中时调用者应能重建数据。 */
export interface CacheStore {
  get(context: CallContext, key: string): Promise<Uint8Array | undefined>;
  set(context: CallContext, key: string, value: Uint8Array, ttlSeconds: number): Promise<void>;
  delete(context: CallContext, key: string): Promise<void>;
}
