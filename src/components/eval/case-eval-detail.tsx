'use client';

// 评分点 / 证据展示共享组件（从 cases/[caseId]/page.tsx 抽取，纯重构无行为变化）。
// 对比详情抽屉（ComparisonDetail）与 case 详情页共用同一套解析与渲染。
import { EvidenceBlock } from '@/components/eval/EvidenceBlock';
import type { EvaluatorCategory } from '@/lib/evaluators/registry';

export interface PointRow {
  label: string;
  score?: number;
  evidence?: unknown;
  status?: 'covered' | 'partial' | 'missing';
  skillAttributable?: boolean;
  suggestion?: string;
  anchors?: string[];
}

/** 解析单个评分点；非法（无 label）返回 null。 */
export function parseOnePoint(p: unknown): PointRow | null {
  if (!p || typeof p !== 'object') return null;
  const r = p as Record<string, unknown>;
  if (typeof r.label !== 'string' || !r.label.trim()) return null;
  const row: PointRow = {
    label: r.label,
    score: typeof r.score === 'number' ? r.score : undefined,
    evidence: r.evidence,
  };
  if (r.status === 'covered' || r.status === 'partial' || r.status === 'missing') row.status = r.status;
  if (typeof r.skillAttributable === 'boolean') row.skillAttributable = r.skillAttributable;
  if (typeof r.suggestion === 'string' && r.suggestion.trim()) row.suggestion = r.suggestion.trim();
  if (Array.isArray(r.anchors)) {
    const a = r.anchors.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (a.length) row.anchors = a;
  }
  return row;
}

/** 宽容解析结果行的 points（脏数据逐条丢弃）。归因字段全可选。 */
export function parsePoints(raw: unknown): PointRow[] {
  if (!Array.isArray(raw)) return [];
  const out: PointRow[] = [];
  for (const p of raw) {
    const row = parseOnePoint(p);
    if (row) out.push(row);
  }
  return out;
}

export const STATUS_CHIP: Record<'covered' | 'partial' | 'missing', { label: string; bg: string; fg: string }> = {
  covered: { label: '已覆盖', bg: 'var(--tag-green-bg, var(--success-subtle))', fg: 'var(--tag-green-fg, var(--success))' },
  partial: { label: '部分覆盖', bg: 'var(--tag-amber-bg, var(--warning-subtle))', fg: 'var(--tag-amber-fg, var(--warning))' },
  missing: { label: '未覆盖', bg: 'var(--background-secondary)', fg: 'var(--foreground-muted)' },
};

export const CARD: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10,
};
export const TH: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
export const TD: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, color: 'var(--foreground)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'top',
  wordBreak: 'break-word', overflowWrap: 'anywhere',
};

export const CATEGORY_LABEL: Record<EvaluatorCategory, string> = {
  res: '结果评测',
  traj: '轨迹评测',
};

/** 评分点的「状态 / 可归因 skill」标签组（评分点与子项复用）。 */
export function PointBadges({ point }: { point: PointRow }) {
  if (!point.status && !point.skillAttributable) return null;
  return (
    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {point.status && (
        <span style={{
          fontSize: 10, padding: '1px 7px', borderRadius: 6, fontWeight: 500,
          background: STATUS_CHIP[point.status].bg, color: STATUS_CHIP[point.status].fg,
        }}>{STATUS_CHIP[point.status].label}</span>
      )}
      {point.skillAttributable && (
        <span style={{
          fontSize: 10, padding: '1px 7px', borderRadius: 6, fontWeight: 500,
          background: 'var(--primary-subtle)', color: 'var(--primary)',
        }}>可归因 skill</span>
      )}
    </div>
  );
}

/** 评分点「证据」列内容：证据块 + 建议 + 相关步骤锚点（评分点与子项复用）。 */
export function PointEvidence({ point, taskId }: { point: PointRow; taskId: string | null }) {
  return (
    <>
      {point.evidence ? <EvidenceBlock evidence={point.evidence} /> : null}
      {point.suggestion && (
        <div style={{ marginTop: point.evidence ? 6 : 0, fontSize: 11, color: 'var(--primary)' }}>
          ↗ 建议：{point.suggestion}
        </div>
      )}
      {point.anchors && point.anchors.length > 0 && (
        <div style={{ marginTop: 5, fontSize: 10.5, color: 'var(--foreground-muted)' }}>
          相关步骤：{point.anchors.map((a) => (
            <a
              key={a}
              href={taskId ? `/trace?taskId=${encodeURIComponent(taskId)}` : undefined}
              style={{
                fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5,
                background: 'var(--background-secondary)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '0 5px', marginRight: 5,
                color: 'var(--foreground-secondary)', textDecoration: 'none',
                cursor: taskId ? 'pointer' : 'default',
              }}
            >{a}</a>
          ))}
        </div>
      )}
    </>
  );
}

export function TagChip({ text }: { text: string }) {
  return (
    <span style={{
      fontSize: 10.5, padding: '1px 7px', borderRadius: 8,
      background: 'var(--background-secondary)', color: 'var(--foreground-muted)',
    }}>
      {text}
    </span>
  );
}
