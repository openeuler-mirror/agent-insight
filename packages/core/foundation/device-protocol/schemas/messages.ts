import type { ApiError } from '../../common/errors/safe-error';
import type { ArtifactRef } from '../../common/shared-interfaces/artifact-ref';

export interface Envelope {
  readonly messageId: string;
  readonly type: string;
  readonly version: string;
  readonly correlationId: string;
  readonly payload: ArtifactRef;
  readonly attempt?: number;
  readonly sequence?: number;
}

/** 设备已持久保存消息，最终执行结果通过独立消息回传。 */
export interface Ack {
  readonly messageId: string;
  readonly receivedDigest: string;
}

export interface Messages {
  readonly items: readonly Envelope[];
}

export type HandlerResult =
  | { readonly messageId: string; readonly outcome: 'processed'; readonly result?: ArtifactRef }
  | { readonly messageId: string; readonly outcome: 'failed'; readonly error: ApiError };
