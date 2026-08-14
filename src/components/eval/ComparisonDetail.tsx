'use client';

// 对比实验详情页：结论横幅 + 组汇总卡 + 评估器分解双色条形 + 逐 case 配对表 + case 详情抽屉。
// 单组渲染路径（[id]/page.tsx type='single'）不动；type='llm' 渲染本组件（IF-M03）。
// 所有样式用共享令牌（--group-a/--group-b/--primary/--success/--warning/--foreground*），
// 不新建 --cmp-* 局部色板（AGENTS.md §6）。抽屉用自定义 aside（仿 TraceDrawer，G5 不覆写 Sheet）。
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useEvaluatorLookup } from '@/components/eval/useEvaluatorLookup';
import type { ComparisonDetailData, PairingEntry, GroupSummary } from '@/lib/engine/experiment/comparison-runner';

type Verdict = 'A胜' | 'B胜' | '平' | 'N/A';
type Filter = 'all' | 'A胜' | 'B胜' | '平';

const CARD: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10,
  padding: 16,
};
const TH: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, color: 'var(--foreground)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'top',
  wordBreak: 'break-word', overflowWrap: 'anywhere',
};
const SCORE_CELL: React.CSSProperties = { ...TD, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, textAlign: 'right' };

function fmtScore(v: number | null | undefined): string {
  return typeof v === 'number' ? v.toFixed(1) : '—';
}

function verdictBadge(v: Verdict): { label: string; bg: string; fg: string } {
  if (v === 'A胜') return { label: 'A 胜', bg: 'var(--group-a-subtle)', fg: 'var(--group-a)' };
  if (v === 'B胜') return { label: 'B 胜', bg: 'var(--group-b-subtle)', fg: 'var(--group-b)' };
  if (v === '平') return { label: '平', bg: 'var(--background-secondary)', fg: 'var(--foreground-muted)' };
  return { label: 'N/A', bg: 'var(--background-secondary)', fg: 'var(--foreground-muted)' };
}

// ─── 结论横幅 ────────────────────────────────────────────────────────────────

function Banner({ detail }: { detail: ComparisonDetailData }) {
  const { pairing, groups } = detail;
  const aOverall = groups[0]?.overall ?? null;
  const bOverall = groups[1]?.overall ?? null;
  const diff = (typeof aOverall === 'number' && typeof bOverall === 'number') ? aOverall - bOverall : null;

  let text: string;
  let level: 'info' | 'warning';
  if (pairing.degraded) {
    level = 'warning';
    const pct = (pairing.comparableRate * 100).toFixed(0);
    text = `对比可信度有限（可比率 ${pct}%，低于阈值）`;
  } else {
    level = 'info';
    if (diff !== null) {
      const winner = diff > 0 ? groups[0]?.key : diff < 0 ? groups[1]?.key : '平';
      text = diff === 0
        ? `两组综合得分持平（${aOverall!.toFixed(1)}）`
        : `${winner} 组综合分领先 ${Math.abs(diff).toFixed(1)}（${(diff > 0 ? aOverall : bOverall)!.toFixed(1)} vs ${(diff > 0 ? bOverall : aOverall)!.toFixed(1)}）`;
    } else {
      text = '尚无可比配对——完成评测后显示结论';
    }
  }

  const bg = level === 'warning' ? 'var(--warning-subtle)' : 'var(--primary-subtle)';
  const border = level === 'warning' ? 'var(--warning-subtle-border)' : 'var(--primary-subtle-border)';
  const fg = level === 'warning' ? 'var(--warning)' : 'var(--primary)';

  return (
    <div style={{ ...CARD, background: bg, borderColor: border, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 16 }}>{level === 'warning' ? '⚠️' : '📊'}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: fg }}>{text}</span>
      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--foreground-muted)' }}>
        可比 {pairing.comparableCount}/{pairing.total}
      </span>
    </div>
  );
}

// ─── 组汇总卡 ────────────────────────────────────────────────────────────────

function MetricRow({ label, aVal, bVal, higherIsBetter }: { label: string; aVal: number | null; bVal: number | null; higherIsBetter: boolean }) {
  const aNum = typeof aVal === 'number';
  const bNum = typeof bVal === 'number';
  const aWins = aNum && bNum && higherIsBetter ? aVal! > bVal! : aNum && !bNum;
  const bWins = bNum && aNum && higherIsBetter ? bVal! > aVal! : bNum && !aNum;
  const fmt = (v: number | null) => typeof v === 'number' ? v.toFixed(1) : '—';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--foreground-muted)', minWidth: 60 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono, monospace)', color: aWins ? 'var(--success)' : 'var(--foreground)', fontWeight: aWins ? 600 : 400 }}>
        {aWins ? '▲ ' : ''}{fmt(aVal)}
      </span>
      <span style={{ fontFamily: 'var(--font-mono, monospace)', color: bWins ? 'var(--success)' : 'var(--foreground)', fontWeight: bWins ? 600 : 400 }}>
        {bWins ? '▲ ' : ''}{fmt(bVal)}
      </span>
    </div>
  );
}

function GroupSummaryCard({ group, otherGroup, position }: { group: GroupSummary; otherGroup?: GroupSummary; position: 'A' | 'B' }) {
  const color = position === 'A' ? 'var(--group-a)' : 'var(--group-b)';
  const subtle = position === 'A' ? 'var(--group-a-subtle)' : 'var(--group-b-subtle)';
  return (
    <div style={{ ...CARD, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: subtle, color }}>{position} 组</span>
        <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>{group.variableValue}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--foreground-muted)' }}>{group.progress.done}/{group.progress.total} 行</span>
      </div>
      <MetricRow label="综合分" aVal={position === 'A' ? group.overall : otherGroup?.overall ?? null} bVal={position === 'A' ? otherGroup?.overall ?? null : group.overall} higherIsBetter />
      <MetricRow label="成功率" aVal={position === 'A' ? group.successRate : otherGroup?.successRate ?? null} bVal={position === 'A' ? otherGroup?.successRate ?? null : group.successRate} higherIsBetter />
      <MetricRow label="成本" aVal={position === 'A' ? group.avgCost : otherGroup?.avgCost ?? null} bVal={position === 'A' ? otherGroup?.avgCost ?? null : group.avgCost} higherIsBetter={false} />
      <MetricRow label="时长" aVal={position === 'A' ? group.avgLatency : otherGroup?.avgLatency ?? null} bVal={position === 'A' ? otherGroup?.avgLatency ?? null : group.avgLatency} higherIsBetter={false} />
      <MetricRow label="步数" aVal={position === 'A' ? group.avgSteps : otherGroup?.avgSteps ?? null} bVal={position === 'A' ? otherGroup?.avgSteps ?? null : group.avgSteps} higherIsBetter={false} />
    </div>
  );
}

// ─── 评估器分解双色条形 ──────────────────────────────────────────────────────

function EvaluatorBar({ evaluatorId, aAvg, bAvg, aCovered, bCovered, aTotal, bTotal }: {
  evaluatorId: string; aAvg: number | null; bAvg: number | null; aCovered: number; bCovered: number; aTotal: number; bTotal: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <span style={{ fontSize: 11, color: 'var(--foreground-secondary)', minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{evaluatorId}</span>
      <Bar value={aAvg} color="var(--group-a)" />
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)', color: 'var(--foreground-muted)', minWidth: 40, textAlign: 'right' }}>{fmtScore(aAvg)}</span>
      <span style={{ fontSize: 10, color: 'var(--foreground-muted)', minWidth: 30 }}>{aCovered}/{aTotal}</span>
      <Bar value={bAvg} color="var(--group-b)" />
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)', color: 'var(--foreground-muted)', minWidth: 40, textAlign: 'right' }}>{fmtScore(bAvg)}</span>
      <span style={{ fontSize: 10, color: 'var(--foreground-muted)', minWidth: 30 }}>{bCovered}/{bTotal}</span>
    </div>
  );
}

function Bar({ value, color }: { value: number | null; color: string }) {
  const pct = typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div style={{ flex: 1, height: 14, background: 'var(--background-secondary)', borderRadius: 4, overflow: 'hidden', minWidth: 60 }}>
      {typeof value === 'number' && (
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.2s ease' }} />
      )}
    </div>
  );
}

function EvaluatorBreakdown({ detail }: { detail: ComparisonDetailData }) {
  const lookup = useEvaluatorLookup(detail.id ? undefined : undefined); // 不需要 user（仅用 evaluator id 显示）
  // 合并 A/B 两组的 breakdown by evaluatorId
  const aBreakdown = detail.groups[0]?.breakdown ?? [];
  const bBreakdown = detail.groups[1]?.breakdown ?? [];
  const evaluatorIds = Array.from(new Set([...aBreakdown.map((b) => b.evaluatorId), ...bBreakdown.map((b) => b.evaluatorId)]));

  if (evaluatorIds.length === 0) return null;

  return (
    <div style={{ ...CARD, marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--foreground)' }}>评估器分解</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 10, color: 'var(--foreground-muted)' }}>
        <span style={{ minWidth: 120 }}>评估器</span>
        <span style={{ flex: 1, textAlign: 'center' }}>A 组</span>
        <span style={{ minWidth: 70 }} />
        <span style={{ flex: 1, textAlign: 'center' }}>B 组</span>
        <span style={{ minWidth: 30 }} />
      </div>
      {evaluatorIds.map((eid) => {
        const a = aBreakdown.find((b) => b.evaluatorId === eid);
        const b = bBreakdown.find((b) => b.evaluatorId === eid);
        return (
          <EvaluatorBar
            key={eid}
            evaluatorId={lookup.nameOf(eid)}
            aAvg={a?.avg ?? null}
            bAvg={b?.avg ?? null}
            aCovered={a?.scored ?? 0}
            bCovered={b?.scored ?? 0}
            aTotal={a?.total ?? 0}
            bTotal={b?.total ?? 0}
          />
        );
      })}
    </div>
  );
}

// ─── 逐 case 配对表 ──────────────────────────────────────────────────────────

function PairingTable({ items, page, pageSize, onPageChange, onRowClick }: {
  items: PairingEntry[]; page: number; pageSize: number; onPageChange: (p: number) => void; onRowClick: (p: PairingEntry) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const comparable = items.filter((p) => p.status === '可比');
  const filtered = filter === 'all' ? comparable : comparable.filter((p) => p.verdict === filter);

  const totalPages = Math.max(1, Math.ceil(comparable.length / pageSize));
  const cur = Math.min(page, totalPages);
  const start = (cur - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'A胜', label: 'A 胜' },
    { key: 'B胜', label: 'B 胜' },
    { key: '平', label: '平' },
  ];
  const countFor = (f: Filter) => f === 'all' ? comparable.length : comparable.filter((p) => p.verdict === f).length;

  return (
    <div style={{ ...CARD, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {filters.map((f) => (
          <button
            key={f.key}
            className="ai-filter-chip"
            data-active={filter === f.key || undefined}
            onClick={() => { setFilter(f.key); onPageChange(1); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', fontSize: 11, borderRadius: 999, cursor: 'pointer', border: '1px solid transparent', background: 'transparent' }}
          >
            <span>{f.label}</span>
            <span className="ai-filter-chip__count">{countFor(f.key)}</span>
          </button>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>任务输入</th>
              <th style={{ ...TH, color: 'var(--group-a)' }}>A 综合</th>
              <th style={{ ...TH, color: 'var(--group-a)' }}>A 结果</th>
              <th style={{ ...TH, color: 'var(--group-a)' }}>A 轨迹</th>
              <th style={{ ...TH, color: 'var(--group-b)' }}>B 综合</th>
              <th style={{ ...TH, color: 'var(--group-b)' }}>B 结果</th>
              <th style={{ ...TH, color: 'var(--group-b)' }}>B 轨迹</th>
              <th style={TH}>胜负</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((p, i) => {
              const vb = verdictBadge(p.verdict);
              return (
                <tr key={i} onClick={() => onRowClick(p)} style={{ cursor: 'pointer' }}>
                  <td style={{ ...TD, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.taskInput}</td>
                  <td style={SCORE_CELL}>{fmtScore(p.a?.scores.overall)}</td>
                  <td style={SCORE_CELL}>{fmtScore(p.a?.scores.res)}</td>
                  <td style={SCORE_CELL}>{fmtScore(p.a?.scores.traj)}</td>
                  <td style={SCORE_CELL}>{fmtScore(p.b?.scores.overall)}</td>
                  <td style={SCORE_CELL}>{fmtScore(p.b?.scores.res)}</td>
                  <td style={SCORE_CELL}>{fmtScore(p.b?.scores.traj)}</td>
                  <td style={TD}>
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, fontWeight: 500, background: vb.bg, color: vb.fg }}>{vb.label}</span>
                  </td>
                </tr>
              );
            })}
            {pageItems.length === 0 && (
              <tr><td colSpan={8} style={{ ...TD, textAlign: 'center', color: 'var(--foreground-muted)' }}>无可比配对</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button onClick={() => onPageChange(Math.max(1, cur - 1))} disabled={cur <= 1} style={{ fontSize: 11, padding: '2px 8px', cursor: cur <= 1 ? 'default' : 'pointer', opacity: cur <= 1 ? 0.4 : 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4 }}>‹</button>
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>{cur} / {totalPages}</span>
          <button onClick={() => onPageChange(Math.min(totalPages, cur + 1))} disabled={cur >= totalPages} style={{ fontSize: 11, padding: '2px 8px', cursor: cur >= totalPages ? 'default' : 'pointer', opacity: cur >= totalPages ? 0.4 : 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4 }}>›</button>
        </div>
      )}
    </div>
  );
}

// ─── case 详情抽屉（自定义 aside，仿 TraceDrawer，G5）─────────────────────────

function CaseDrawer({ pair, detail, onClose }: { pair: PairingEntry; detail: ComparisonDetailData; onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 100, transition: 'opacity 0.18s ease' }} />
      <aside style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 'min(60%, 960px)', minWidth: 480,
        background: 'var(--background)', borderLeft: '1px solid var(--border)',
        boxShadow: '-12px 0 32px -8px var(--shadow-color-lg)',
        zIndex: 101, display: 'flex', flexDirection: 'column',
        animation: 'aiDrawerSlideIn 0.22s cubic-bezier(0.32, 0.72, 0, 1)',
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>配对详情</span>
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pair.taskInput}</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', fontSize: 14, cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--foreground-muted)' }}>✕</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', gap: 0 }}>
          <DrawerSide pair={pair} side="A" caseId={pair.a?.caseId} detail={detail} />
          <div style={{ width: 1, background: 'var(--border)' }} />
          <DrawerSide pair={pair} side="B" caseId={pair.b?.caseId} detail={detail} />
        </div>
      </aside>
      <style>{`@keyframes aiDrawerSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
    </>
  );
}

function DrawerSide({ pair, side, caseId, detail }: { pair: PairingEntry; side: 'A' | 'B'; caseId?: string; detail: ComparisonDetailData }) {
  const s = side === 'A' ? pair.a : pair.b;
  const group = side === 'A' ? detail.groups[0] : detail.groups[1];
  const color = side === 'A' ? 'var(--group-a)' : 'var(--group-b)';
  const subtle = side === 'A' ? 'var(--group-a-subtle)' : 'var(--group-b-subtle)';

  return (
    <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: subtle, color }}>{side} 组</span>
        <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>{group?.variableValue}</span>
      </div>
      {!s ? (
        <div style={{ fontSize: 12, color: 'var(--foreground-muted)', padding: '20px 0', textAlign: 'center' }}>无 trace（{pair.status}）</div>
      ) : (
        <>
          <Section title="输出摘要">
            <div style={{ fontSize: 11.5, color: 'var(--foreground)', background: 'var(--background-secondary)', padding: 8, borderRadius: 6, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {s.actualOutput || '（无输出）'}
            </div>
          </Section>
          <Section title="结果评测">
            <ScoreLine label="综合" value={s.scores.overall} color={color} />
            <ScoreLine label="结果" value={s.scores.res} color={color} />
            <ScoreLine label="轨迹" value={s.scores.traj} color={color} />
          </Section>
          <Section title="跳转完整评测">
            {caseId && (
              <Link href={`/experiments/${detail.id}/cases/${caseId}`} style={{ fontSize: 11, color: 'var(--primary)', textDecoration: 'none' }}>
                → 打开完整 trace 评测详情
              </Link>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function ScoreLine({ label, value, color }: { label: string; value: number | null; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11.5 }}>
      <span style={{ color: 'var(--foreground-muted)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, color: typeof value === 'number' ? color : 'var(--foreground-muted)' }}>
        {fmtScore(value)}
      </span>
    </div>
  );
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export function ComparisonDetail({ detail }: { detail: ComparisonDetailData }) {
  const [drawerPair, setDrawerPair] = useState<PairingEntry | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 8;

  const nonComparable = useMemo(() => detail.pairing.items.filter((p) => p.status !== '可比'), [detail.pairing.items]);

  return (
    <div>
      <Banner detail={detail} />
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <GroupSummaryCard group={detail.groups[0]} otherGroup={detail.groups[1]} position="A" />
        <GroupSummaryCard group={detail.groups[1]} otherGroup={detail.groups[0]} position="B" />
      </div>
      <EvaluatorBreakdown detail={detail} />
      <PairingTable
        items={detail.pairing.items}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onRowClick={setDrawerPair}
      />
      {nonComparable.length > 0 && (
        <div style={{ ...CARD, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--foreground-muted)' }}>
            未配对 / 不可比（{nonComparable.length}）
          </div>
          <div style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
            {nonComparable.slice(0, 10).map((p, i) => (
              <div key={i} style={{ padding: '2px 0' }}>
                <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--foreground-secondary)' }}>{p.taskInput.slice(0, 40)}</span>
                <span style={{ marginLeft: 8, color: p.status === '不可比' ? 'var(--warning)' : 'var(--foreground-muted)' }}>
                  {p.status}{p.reason ? `（${p.reason}）` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {drawerPair && (
        <CaseDrawer pair={drawerPair} detail={detail} onClose={() => setDrawerPair(null)} />
      )}
    </div>
  );
}
