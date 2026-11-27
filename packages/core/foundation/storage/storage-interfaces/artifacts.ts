import type { WorkspaceContext } from '../../common/context/call-context';
import type { ArtifactRef } from '../../common/shared-interfaces/artifact-ref';

export interface ArtifactStore {
  /** 成功返回的引用可从同一部署的其他实例读取。 */
  put(context: WorkspaceContext, content: AsyncIterable<Uint8Array>): Promise<ArtifactRef>;
  read(context: WorkspaceContext, ref: ArtifactRef): Promise<AsyncIterable<Uint8Array>>;
  remove(context: WorkspaceContext, ref: ArtifactRef): Promise<void>;
}
