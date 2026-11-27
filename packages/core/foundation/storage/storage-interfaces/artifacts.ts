import type { CallContext } from '../../common/context/call-context';
import type { ArtifactRef } from '../../common/shared-interfaces/artifact-ref';

export interface ArtifactStore {
  /** 成功返回的引用可从同一部署的其他实例读取。 */
  put(context: CallContext, content: AsyncIterable<Uint8Array>): Promise<ArtifactRef>;
  read(context: CallContext, ref: ArtifactRef): Promise<AsyncIterable<Uint8Array>>;
  remove(context: CallContext, ref: ArtifactRef): Promise<void>;
}
