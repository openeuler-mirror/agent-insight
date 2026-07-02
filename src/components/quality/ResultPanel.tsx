'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, FileText, Target } from 'lucide-react';
import { Term } from '@/components/text/Term';
import { useLocale } from '@/lib/client/locale-context';
import type { MetricScore, QualityReport } from '@/lib/engine/quality-monitoring/types';
import {
  buildAccuracyDetailTables,
  buildAnswerQualityDetailTables,
  buildAnswerQualitySummary,
  buildFaithfulnessDetailTables,
  buildInstructionDetailTables,
  buildInstructionLineDisplay,
  type DetailTableSpec,
} from './result-detail-tables';
import { fmtNum, scoreColor } from './quality-ui';

type EvidenceItem = NonNullable<MetricScore['evidence']>[number];
type RecordLike = Record<string, unknown>;

const RESULT_METRIC_TERM_IDS: Record<string, string> = {
  faithfulness: 'quality-result-faithfulness',
  instructionAdherence: 'quality-result-instruction-adherence',
  answerQuality: 'quality-result-answer-quality',
  accuracy: 'quality-result-accuracy',
};

const DETAIL_FIELD_TERM_IDS: Record<string, string> = {
  约束ID: 'quality-result-detail-constraint-id',
  约束内容: 'quality-result-detail-constraint-text',
  裁决结果: 'quality-result-detail-verdict-status',
  裁决原因: 'quality-result-detail-verdict-reason',
  主张ID: 'quality-result-detail-claim-id',
  主张内容: 'quality-result-detail-claim-text',
  证据与来源: 'quality-result-detail-evidence-source',
  观点ID: 'quality-result-detail-key-point-id',
  标准关键观点: 'quality-result-detail-key-point-content',
  判定结果: 'quality-result-detail-judgement-status',
  实际答案证据: 'quality-result-detail-actual-evidence',
  错误类型: 'quality-result-detail-error-kind',
  严重度: 'quality-result-detail-severity',
  错误原因: 'quality-result-detail-error-reason',
  陈述ID: 'quality-result-detail-statement-id',
  陈述内容: 'quality-result-detail-statement-text',
  原文引用: 'quality-result-detail-source-quote',
  相关性判定: 'quality-result-detail-relevance-status',
  判定原因: 'quality-result-detail-judgement-reason',
  要点ID: 'quality-result-detail-requirement-id',
  任务要点: 'quality-result-detail-requirement-text',
  覆盖状态: 'quality-result-detail-coverage-status',
  结果证据: 'quality-result-detail-result-evidence',
  检查项: 'quality-result-detail-check-item',
  结果: 'quality-result-detail-check-result',
  说明: 'quality-result-detail-check-note',
};

export function ResultPanel({ report }: { report: QualityReport }) {
  const { t } = useLocale();
  const metrics = report.dimensions.result.metrics ?? [];
  return (
    <section id="result" style={panel}>
      <div style={panelHeader}>
        <span style={icon}><Target size={13} /></span>
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>{t('quality.result.title')}</span>
        <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>· {t('quality.result.hint')}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>
          {t('quality.result.coverage')} {Math.round(report.dimensions.result.coverage * 100)}%
        </span>
      </div>
      <div style={{ padding: '6px 18px 12px' }}>
        {metrics.map((metric) => <ResultMetricRow key={metric.key} metric={metric} t={t} />)}
      </div>
    </section>
  );
}

function ResultMetricRow({ metric, t }: { metric: MetricScore; t: (key: string) => string }) {
  const [open, setOpen] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const na = metric.score == null;
  const color = na ? 'var(--foreground-muted)' : scoreColor(metric.score as number);
  const description = t(`quality.result.metric.${metric.key}`);
  const details = metric.evidence ?? [];
  const termId = RESULT_METRIC_TERM_IDS[metric.key];
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button onClick={() => setOpen((value) => !value)} style={rowButton}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <div style={{ minWidth: 190 }}>
          <div style={metricTitle}>
            <span>{metric.label}</span>
            {termId && (
              <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <Term id={termId} render="compact" />
              </span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--foreground-secondary)', marginTop: 3 }}>{description}</div>
        </div>
        <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
          {t('quality.result.coverage')} {Math.round(metric.coverage * 100)}%
          {metric.confidence != null ? ` · ${t('quality.result.confidence')} ${Math.round(metric.confidence * 100)}%` : ''}
        </span>
        {metric.key === 'accuracy' && <span style={tag}>GT</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 15, fontWeight: 800, color }}>{na ? 'N/A' : `${fmtNum(metric.score)}分`}</span>
      </button>
      {open && (
        <div style={detailList}>
          {metric.key !== 'instructionAdherence' && metric.note && <div style={detailNotice}>{metric.note}</div>}
          {metric.key !== 'instructionAdherence' && metric.naReason && <div style={detailNotice}>{metric.naReason}</div>}
          {details.map((item) => {
            const key = `${metric.key}:${item.executionId}`;
            const detailOpen = detailKey === key;
            return (
              <div key={`${item.executionId}:${item.reason}`} style={traceBlock}>
                {metric.key === 'answerQuality' ? (
                  <AnswerQualityLine item={item} open={detailOpen} onToggle={() => setDetailKey(detailOpen ? null : key)} />
                ) : metric.key === 'instructionAdherence' ? (
                  <InstructionLine item={item} open={detailOpen} onToggle={() => setDetailKey(detailOpen ? null : key)} />
                ) : metric.key === 'faithfulness' ? (
                  <StructuredMetricLine item={item} open={detailOpen} onToggle={() => setDetailKey(detailOpen ? null : key)} buildTables={buildFaithfulnessDetailTables} />
                ) : metric.key === 'accuracy' ? (
                  <StructuredMetricLine item={item} open={detailOpen} onToggle={() => setDetailKey(detailOpen ? null : key)} buildTables={buildAccuracyDetailTables} />
                ) : (
                  <DefaultEvidenceLine item={item} />
                )}
              </div>
            );
          })}
          {!metric.note && !metric.naReason && details.length === 0 && <div>{t('quality.result.noEvidence')}</div>}
        </div>
      )}
    </div>
  );
}

function DefaultEvidenceLine({ item }: { item: EvidenceItem }) {
  return (
    <div style={traceLine}>
      <TraceId id={item.executionId} />
      <span style={traceReason}>{item.reason}</span>
    </div>
  );
}

function InstructionLine({ item, open, onToggle }: { item: EvidenceItem; open: boolean; onToggle: () => void }) {
  const detail = asRecord(item.detail);
  const display = buildInstructionLineDisplay({ score: item.score, reason: item.reason, detail });
  if (display.kind === 'not-applicable') {
    return (
      <div style={traceLine}>
        <TraceId id={item.executionId} />
        <span style={traceReason}>{display.reason}</span>
      </div>
    );
  }
  return (
    <>
      <div style={traceLine}>
        <TraceId id={item.executionId} />
        <span style={metricChip}>{display.scoreLabel}</span>
        <span style={metricChip}>{display.constraintLabel}</span>
        <DetailButton open={open} onClick={onToggle} />
      </div>
      {open && <InstructionDetail detail={detail} />}
    </>
  );
}

function AnswerQualityLine({ item, open, onToggle }: { item: EvidenceItem; open: boolean; onToggle: () => void }) {
  const detail = asRecord(item.detail);
  const subScores = asRecord(detail.subScores);
  const summary = buildAnswerQualitySummary(detail) || item.reason;
  return (
    <>
      <div style={traceLine}>
        <TraceId id={item.executionId} />
        <span style={metricChip}>总分 {formatScore(item.score)}</span>
        <span style={metricChip}>相关性 {formatScore(subScores.relevance)}</span>
        <span style={metricChip}>完整性 {formatScore(subScores.completeness)}</span>
        <span style={metricChip}>连贯性 {formatScore(subScores.coherence)}</span>
        {summary && <span style={traceReason}>{summary}</span>}
        <DetailButton open={open} onClick={onToggle} />
      </div>
      {open && <AnswerQualityDetail detail={detail} />}
    </>
  );
}

function StructuredMetricLine({
  item,
  open,
  onToggle,
  buildTables,
}: {
  item: EvidenceItem;
  open: boolean;
  onToggle: () => void;
  buildTables: (detail: RecordLike) => DetailTableSpec[];
}) {
  const detail = asRecord(item.detail);
  if (item.score == null) {
    return (
      <div style={traceLine}>
        <TraceId id={item.executionId} />
        <span style={traceReason}>不适用：{item.reason}</span>
      </div>
    );
  }
  return (
    <>
      <div style={traceLine}>
        <TraceId id={item.executionId} />
        <span style={metricChip}>得分 {formatScore(item.score)}</span>
        <span style={traceReason}>{item.reason}</span>
        <DetailButton open={open} onClick={onToggle} />
      </div>
      {open && <DetailTables tables={buildTables(detail)} />}
    </>
  );
}

function DetailButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={detailButton} title="查看评测详情">
      <FileText size={10} />
      {open ? '收起详情' : '评测详情'}
    </button>
  );
}

function InstructionDetail({ detail }: { detail: RecordLike }) {
  return (
    <DetailTables tables={buildInstructionDetailTables(detail)} />
  );
}

function AnswerQualityDetail({ detail }: { detail: RecordLike }) {
  return <DetailTables tables={buildAnswerQualityDetailTables(detail)} />;
}

function DetailTables({ tables }: { tables: DetailTableSpec[] }) {
  return (
    <div style={detailWrap}>
      {tables.map((table) => (
        <DetailSection key={table.title} title={table.title}>
          <DetailTable headers={table.headers} rows={table.rows} />
        </DetailSection>
      ))}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={detailSection}>
      <div style={detailTitle}>{title}</div>
      {children}
    </div>
  );
}

function DetailTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div style={tableScroll}>
      <table style={detailTable}>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th key={header} style={th}>
                <DetailHeader label={header} align={index === headers.length - 1 ? 'end' : 'start'} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row, index) => (
            <tr key={index}>
              {headers.map((header, colIndex) => <td key={`${header}:${colIndex}`} style={td}>{row[colIndex] || '—'}</td>)}
            </tr>
          )) : (
            <tr><td colSpan={headers.length} style={td}>暂无明细</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DetailHeader({ label, align }: { label: string; align: 'start' | 'end' }) {
  const termId = DETAIL_FIELD_TERM_IDS[label];
  return (
    <span style={detailHeaderLabel}>
      <span>{label}</span>
      {termId && <Term id={termId} render="compact" align={align} />}
    </span>
  );
}

function TraceId({ id }: { id: string }) {
  return (
    <Link href={`/trace?taskId=${encodeURIComponent(id)}`} style={traceIdPill} title="查看链路追踪">
      {id.slice(0, 10)}
    </Link>
  );
}

function asRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordLike : {};
}

function formatScore(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${fmtNum(value)}分` : 'N/A';
}

const panel: React.CSSProperties = { background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, boxShadow: '0 1px 2px rgba(20,22,30,.04)', marginBottom: 14, scrollMarginTop: 56 };
const panelHeader: React.CSSProperties = { padding: '13px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 };
const icon: React.CSSProperties = { width: 22, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'var(--success-subtle)', color: 'var(--success)' };
const rowButton: React.CSSProperties = { width: '100%', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0', textAlign: 'left', font: 'inherit' };
const metricTitle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 13.5, fontWeight: 800 };
const tag: React.CSSProperties = { fontSize: 9, fontWeight: 750, padding: '2px 5px', borderRadius: 4, background: 'var(--primary-subtle)', color: 'var(--primary)' };
const detailList: React.CSSProperties = { padding: '0 28px 10px', fontSize: 12.5, color: 'var(--foreground)', lineHeight: 1.62 };
const detailNotice: React.CSSProperties = { margin: '2px 0 6px', color: 'var(--foreground-secondary)', fontSize: 12.5 };
const traceBlock: React.CSSProperties = { marginTop: 2 };
const traceLine: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  flexWrap: 'wrap',
  padding: '3px 6px',
  border: '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
  borderRadius: 6,
  background: 'color-mix(in srgb, var(--background-secondary) 35%, var(--card-bg))',
};
const traceIdPill: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)',
  color: 'var(--primary)',
  background: 'transparent',
  borderRadius: 0,
  padding: 0,
  fontSize: 12,
  fontWeight: 750,
  flex: '0 0 auto',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
  textDecorationThickness: '1px',
  display: 'inline-flex',
  alignItems: 'center',
};
const metricChip: React.CSSProperties = {
  color: 'var(--foreground)',
  background: 'transparent',
  border: 0,
  borderRadius: 0,
  padding: 0,
  fontSize: 12,
  fontWeight: 750,
  whiteSpace: 'nowrap',
};
const traceReason: React.CSSProperties = { color: 'var(--foreground)', fontSize: 12.5, fontWeight: 600, flex: '0 1 auto', minWidth: 0 };
const detailButton: React.CSSProperties = { border: '1px solid var(--primary)', background: 'var(--primary-subtle)', color: 'var(--primary)', borderRadius: 6, padding: '2px 6px', fontSize: 10.5, fontWeight: 750, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 2, flex: '0 0 auto' };
const detailWrap: React.CSSProperties = { display: 'grid', gap: 12, marginTop: 10 };
const detailSection: React.CSSProperties = { marginTop: 2 };
const detailTitle: React.CSSProperties = { fontSize: 12.5, fontWeight: 800, color: 'var(--foreground)', marginBottom: 6 };
const tableScroll: React.CSSProperties = { overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 };
const detailTable: React.CSSProperties = { width: '100%', minWidth: 720, borderCollapse: 'collapse', background: 'var(--card-bg)' };
const detailHeaderLabel: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 11.5, fontWeight: 800, color: 'var(--foreground-secondary)', background: 'var(--background-secondary)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', color: 'var(--foreground)', minWidth: 90, fontSize: 11.5, lineHeight: 1.55 };
