import type {
  CallContext, DeviceCommandService, ObservationAdapter, TraceService, TraceTransferService,
} from '../../../../design/platform/frontend-backend-separation/Agent-Insight平台SDK';
import type { ArtifactRef } from '../../../../packages/core/foundation/common/shared-interfaces/artifact-ref';
import type { DeviceTransport } from '../../../../packages/core/foundation/device-protocol';
import type { TraceBatch } from '../../../../packages/core/observation/trace-service';

/** 供 tsc 检查的调用示例，覆盖 SDK 导出、平台身份、版本化证据与设备收件确认。 */
export async function readEvidence(context: CallContext, service: TraceService): Promise<ArtifactRef | undefined> {
  const page = await service.listTraces(context, { filter: { status: 'failed' }, limit: 10 });
  const trace = page.items[0];
  if (!trace) return undefined;
  const evidence = await service.freeze(context, trace.id, { revision: trace.revision }, context.requestId);
  return evidence.artifact;
}

type Assert<T extends true> = T;
type Satisfies<T, U> = T extends U ? true : false;
export type ContractChecks = [
  Assert<Satisfies<Awaited<ReturnType<TraceTransferService['exportTrace']>>, Uint8Array>>,
  Assert<Satisfies<Parameters<ObservationAdapter['normalize']>[1], TraceBatch & { content: AsyncIterable<Uint8Array> }>>,
  Assert<Satisfies<Awaited<ReturnType<DeviceTransport['ack']>>, { messageId: string; receivedDigest: string }>>,
  Assert<Satisfies<Awaited<ReturnType<DeviceCommandService['getReceipt']>>['state'], 'queued' | 'received' | 'processed' | 'failed'>>,
];
