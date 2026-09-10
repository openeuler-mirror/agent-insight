'use client';

import Link from 'next/link';
import { Fragment, type CSSProperties } from 'react';
import type { CaseScore } from '@/lib/engine/experiment/detail-agg';

export interface ComparisonTableCase {
  id: string;
  input: string;
  referenceOutput: string | null;
  actualOutput: string;
  caseValues?: { name?: string } | null;
  comparisonStatus?: string;
  comparisonReason?: string;
  traceStatus: 'pending' | 'ready' | 'failed' | null;
  traceError: string | null;
  traceAttemptNo: number | null;
  scores: CaseScore;
}

const CELL: CSSProperties = {
  padding: '9px 10px', fontSize: 12, borderBottom: '1px solid var(--border)',
  verticalAlign: 'top', overflowWrap: 'anywhere',
};
const HEAD: CSSProperties = {
  ...CELL, padding: '7px 10px', textAlign: 'center', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', background: 'var(--card-bg)', whiteSpace: 'nowrap',
};
const DIVIDER: CSSProperties = { borderLeft: '1px solid var(--border)' };
const ACTION: CSSProperties = {
  fontSize: 11.5, padding: '3px 8px', borderRadius: 6, lineHeight: 1.5,
  border: '1px solid var(--accent)', background: 'var(--card-bg)', color: 'var(--accent)',
  cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap', display: 'inline-flex',
};

function excerpt(value: string | null | undefined, limit = 72) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text || '—';
}

function Output({ item, emptyLabel = '无此 Case' }: { item?: ComparisonTableCase; emptyLabel?: string }) {
  if (!item) return <span className="text-foreground-muted">{emptyLabel}</span>;
  if (item.traceStatus === 'failed') return <span title={item.traceError || undefined} style={{ color: 'var(--error)' }}>Trace 生成失败{item.traceAttemptNo ? `（已尝试 ${item.traceAttemptNo} 次）` : ''}</span>;
  if (item.traceStatus === 'pending') return <span style={{ color: 'var(--warning)' }}>正在生成 Trace…</span>;
  if (item.traceStatus === 'ready' && !item.actualOutput) return <span className="text-foreground-muted">Trace 已生成（无最终输出）</span>;
  return <span title={item.actualOutput}>{excerpt(item.actualOutput)}</span>;
}

function CaseText({ label, a, b }: { label: string; a?: string | null; b?: string | null }) {
  const text = (value: string | null | undefined) => value ? excerpt(value, 50) : label === '预期' ? '未标注' : '—';
  return <div style={{ marginTop: 5, fontSize: 11.5 }}>
    <span className="text-foreground-muted">{label}：</span>
    {a !== undefined && b !== undefined && (a || '') !== (b || '') ? <>
      <div title={a || undefined}>A：{text(a)}</div>
      <div title={b || undefined}>B：{text(b)}</div>
    </> : <span title={a || b || undefined}>{text(a ?? b)}</span>}
  </div>;
}

export function ExperimentCaseComparisonTable({ rows, experimentId, onOpenCase }: {
  rows: Array<{ key: string; a?: ComparisonTableCase; b?: ComparisonTableCase; unassigned?: ComparisonTableCase }>;
  experimentId: string;
  onOpenCase?: (caseId: string) => void;
}) {
  return <table aria-label="Case 明细 A/B 对比" style={{ width: '100%', minWidth: 1140, tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0 }}>
    <colgroup>
      <col style={{ width: 250 }} />
      <col style={{ width: 180 }} /><col style={{ width: 180 }} />
      {Array.from({ length: 6 }, (_, index) => <col key={index} style={{ width: 62 }} />)}
      <col style={{ width: 148 }} />
    </colgroup>
    <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
      <tr>
        <th rowSpan={2} scope="col" style={{ ...HEAD, textAlign: 'left' }}>Case · 输入与预期输出</th>
        {['实际输出', '综合得分', '结果得分', '轨迹得分'].map((label) => <th key={label} scope="colgroup" colSpan={2} style={{ ...HEAD, ...DIVIDER }}>{label}</th>)}
        <th rowSpan={2} scope="col" style={{ ...HEAD, ...DIVIDER, position: 'sticky', right: 0 }}>操作</th>
      </tr>
      <tr>{['output', 'overall', 'res', 'traj'].map((metric) => <Fragment key={metric}>
        <th scope="col" style={{ ...HEAD, ...DIVIDER }}>A 组</th>
        <th scope="col" style={HEAD}>B 组</th>
      </Fragment>)}</tr>
    </thead>
    <tbody>
      {rows.map(({ key, a, b, unassigned }) => {
        if (unassigned) return <tr key={key} data-comparison-key={key}>
          <td style={CELL}><div style={{ fontWeight: 600 }}>{unassigned.caseValues?.name || '未命名 Case'}</div><CaseText label="输入" a={unassigned.input} /><CaseText label="预期" a={unassigned.referenceOutput} /></td>
          <td colSpan={8} style={{ ...CELL, ...DIVIDER }}>分组未记录，无法进行 A/B 对比。<div style={{ marginTop: 5 }}><Output item={unassigned} /></div></td>
          <td style={{ ...CELL, ...DIVIDER }}>{onOpenCase ? <button type="button" onClick={() => onOpenCase(unassigned.id)} style={ACTION}>详情</button> : <Link href={`/experiments/${encodeURIComponent(experimentId)}/cases/${encodeURIComponent(unassigned.id)}`} style={ACTION}>详情</Link>}</td>
        </tr>;
        const item = a || b!;
        return <tr key={key} data-comparison-key={key}>
          <td style={CELL}>
            <div style={{ fontWeight: 600 }}>{item.caseValues?.name || '未命名 Case'}</div>
            {a?.caseValues?.name && b?.caseValues?.name && a.caseValues.name !== b.caseValues.name && <div style={{ marginTop: 3, fontSize: 11 }}>B：{b.caseValues.name}</div>}
            <CaseText label="输入" a={a?.input} b={b?.input} />
            <CaseText label="预期" a={a?.referenceOutput} b={b?.referenceOutput} />
            {(item.comparisonStatus === 'changed' || !a || !b) && <div title={item.comparisonReason} style={{ marginTop: 5, fontSize: 11, color: 'var(--foreground-muted)' }}>{item.comparisonStatus === 'unmatched' ? '无法配对' : !a ? '仅 B 组' : !b ? '仅 A 组' : '用例定义已变化'}</div>}
            {a && b && a.id === b.id && <div style={{ marginTop: 5, fontSize: 11, color: 'var(--foreground-muted)' }}>共用执行，按两组评估器分别评分</div>}
          </td>
          <td style={{ ...CELL, ...DIVIDER, color: 'var(--foreground-secondary)' }}><Output item={a} emptyLabel={item.comparisonStatus === 'unmatched' ? '未配对' : undefined} /></td>
          <td style={{ ...CELL, color: 'var(--foreground-secondary)' }}><Output item={b} emptyLabel={item.comparisonStatus === 'unmatched' ? '未配对' : undefined} /></td>
          {(['overall', 'res', 'traj'] as const).map((metric) => <Fragment key={metric}>
            {[a, b].map((side, index) => <td key={index} style={{ ...CELL, ...(index === 0 ? DIVIDER : {}), textAlign: 'center', fontWeight: metric === 'overall' ? 700 : 400 }}>
              {side?.scores[metric] ?? '—'}
              {metric === 'overall' && Boolean(side?.scores.adjusted) && <div title={`${side!.scores.adjusted} 项评估被人工修正，该分数按人工分算`} style={{ fontSize: 10, color: 'var(--warning)' }}>人工</div>}
            </td>)}
          </Fragment>)}
          <td style={{ ...CELL, ...DIVIDER, position: 'sticky', right: 0, background: 'var(--card-bg)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 6 }}>
              {[a, b].map((side, index) => side ? onOpenCase ? <button key={index} type="button" onClick={() => onOpenCase(side.id)} style={ACTION}>{index ? 'B' : 'A'} 详情</button> : <Link key={index} href={`/experiments/${encodeURIComponent(experimentId)}/cases/${encodeURIComponent(side.id)}`} style={ACTION}>{index ? 'B' : 'A'} 详情</Link> : <span key={index} style={{ width: 55, textAlign: 'center', color: 'var(--foreground-muted)' }}>—</span>)}
            </div>
          </td>
        </tr>;
      })}
      {rows.length === 0 && <tr><td colSpan={10} style={{ ...CELL, textAlign: 'center', color: 'var(--foreground-muted)' }}>暂无 Case</td></tr>}
    </tbody>
  </table>;
}
