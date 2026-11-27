import type { CallContext } from '../foundation/common/context/call-context';
import type { ArtifactRef } from '../foundation/common/shared-interfaces/artifact-ref';
import type { Page, PageRequest } from '../foundation/common/shared-interfaces/pagination';

export interface TraceBatch {
  readonly source: string;
  readonly batch: ArtifactRef;
}

export interface Receipt {
  readonly receiptId: string;
  readonly state: 'accepted' | 'indexed';
}

export interface TraceEvidence {
  readonly traceId: string;
  readonly revision: string;
  readonly artifact: ArtifactRef;
}

export type TraceStatus = 'running' | 'success' | 'failed' | 'timed_out';

export interface TraceFilter {
  readonly search?: string;
  readonly agent?: string;
  readonly status?: TraceStatus;
  readonly tagIds?: readonly string[];
  readonly timeFrom?: string;
  readonly timeTo?: string;
}

export interface TraceQuery extends PageRequest {
  readonly filter?: TraceFilter;
  readonly sortBy?: 'timestamp' | 'agent' | 'status' | 'latency' | 'tokens' | 'cost';
  readonly direction?: 'asc' | 'desc';
}

export interface TraceSummary {
  readonly id: string;
  readonly revision: string;
  readonly spanCount: number;
  readonly status: TraceStatus;
  readonly timestamp: string;
  readonly agentName?: string;
}

export interface TraceStatistics {
  readonly total: number;
  readonly failedCount: number;
  readonly avgLatencyMs: number;
  readonly toolErrorRate: number;
}

export interface InteractionSummary {
  readonly id: string;
  readonly name: string;
}

export interface TraceDetail {
  readonly trace: TraceSummary;
  readonly rootSpanId?: string;
  readonly interactions: Page<InteractionSummary>;
}

export interface TraceService {
  /** 原文已持久化。相同来源、幂等键和内容返回原回执，内容冲突则失败。 */
  accept(context: CallContext, input: TraceBatch, key: string): Promise<Receipt>;
  listTraces(context: CallContext, query?: TraceQuery): Promise<Page<TraceSummary>>;
  getStatistics(context: CallContext, filter?: TraceFilter): Promise<TraceStatistics>;
  getTraceDetail(context: CallContext, traceId: string, page?: PageRequest): Promise<TraceDetail>;
  getInteractionDetail(context: CallContext, traceId: string, interactionId: string): Promise<ArtifactRef>;
  /** 评测和诊断按不可变引用读取所选修订。 */
  freeze(context: CallContext, traceId: string, input: { readonly revision: string }, key: string): Promise<TraceEvidence>;
}

export interface TraceImportResult {
  readonly rootExecutionId: string;
  readonly executionCount: number;
  readonly subagentCount: number;
}

/** 文件导入与采集器上报分别受理。输入为导出文件的原始 JSON 字节。 */
export interface TraceTransferService {
  importTrace(context: CallContext, content: Uint8Array): Promise<TraceImportResult>;
  exportTrace(context: CallContext, traceId: string): Promise<Uint8Array>;
}

export interface TraceTagService {
  attachTag(context: CallContext, traceId: string, tagId: string): Promise<void>;
  removeTag(context: CallContext, traceId: string, tagId: string): Promise<void>;
}

/** 标准化后的单个 Span。时间是以字符串表示的 Unix 纳秒，避免数值精度损失。 */
export interface ObservationSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano?: string;
  readonly attributes: Readonly<Record<string, ObservationValue>>;
}

export type ObservationValue =
  | string | number | boolean | null
  | readonly ObservationValue[]
  | { readonly [key: string]: ObservationValue };

/** 宿主读取已授权的原始批次，将输入流交给扩展。 */
export interface ObservationAdapterInput extends TraceBatch {
  readonly mediaType: string;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface ObservationAdapter {
  readonly key: string;
  readonly version: string;
  normalize(context: CallContext, batch: ObservationAdapterInput): AsyncIterable<ObservationSpan>;
}

export interface ObservationProcessor {
  readonly key: string;
  readonly version: string;
  readonly stage: 'after-normalize';
  process(context: CallContext, spans: AsyncIterable<ObservationSpan>): AsyncIterable<ObservationSpan>;
}
