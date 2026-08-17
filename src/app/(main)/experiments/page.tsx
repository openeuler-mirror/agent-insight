'use client';

// 实验列表 —— 评测「实验化」第一切片（本期仅单组实验）。
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical, Plus } from 'lucide-react';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';

interface ExperimentRow {
  id: string;
  name: string;
  type: string;
  agentName: string;
  status: string;
  watchMode?: boolean;
  caseCount: number;
  evaluatorCount: number;
  overallScore: number | null;
  createdAt: string;
}

const PAGE_SIZE_OPTIONS = [20, 50, 100];

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  draft: { label: '启动中', bg: 'var(--background-secondary)', fg: 'var(--foreground-secondary)' },
  running: { label: '运行中', bg: 'var(--tag-amber-bg)', fg: 'var(--tag-amber-fg)' },
  done: { label: '已完成', bg: 'var(--tag-green-bg)', fg: 'var(--tag-green-fg)' },
  failed: { label: '失败', bg: 'var(--tag-red-bg)', fg: 'var(--tag-red-fg)' },
};

function StatusChip({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 500,
      background: meta.bg, color: meta.fg, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  );
}

function WatchChip() {
  return (
    <span
      title="监听模式：该 Agent 新上报的 trace 会自动进本实验评测"
      style={{
        fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 500,
        background: 'var(--tag-green-bg)', color: 'var(--tag-green-fg)', whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: 'var(--tag-green-fg)',
        display: 'inline-block',
      }} />
      监听中
    </span>
  );
}

function TypeChip() {
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 500,
      background: 'var(--primary-subtle)', color: 'var(--primary)', whiteSpace: 'nowrap',
    }}>
      单组实验
    </span>
  );
}

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '9px 12px', fontSize: 12, color: 'var(--foreground)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'middle',
};

export default function ExperimentsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [rows, setRows] = useState<ExperimentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const offset = (page - 1) * pageSize;
      const res = await apiFetch(
        `/api/experiments?user=${encodeURIComponent(user)}&limit=${pageSize}&offset=${offset}`,
      );
      const data = await res.json();
      setRows(Array.isArray(data?.items) ? data.items : []);
      setTotal(typeof data?.total === 'number' ? data.total : 0);
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [user, page, pageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // 页码/每页条数变化后若越界（如切大页码后减小 pageSize），回夹到末页
  useEffect(() => {
    if (page <= totalPages) return;
    const timer = window.setTimeout(() => setPage(totalPages), 0);
    return () => window.clearTimeout(timer);
  }, [page, totalPages]);

  return (
    <>
      <AppTopBar
        title="实验"
        actions={
          <Button size="sm" onClick={() => router.push('/experiments/new')}>
            <Plus className="size-3.5" />
            新建实验
          </Button>
        }
      />
      <PageContainer>
        <div style={{
          background: 'var(--card-bg)', border: '1px solid var(--card-border)',
          borderRadius: 10, overflow: 'hidden',
        }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>
              加载中…
            </div>
          ) : total === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title="还没有实验"
              description="实验 = 一批 case × 一组评估器。从「新建实验」开始：选 Agent → 圈选 Trace →（可选）标注预期答案 → 挑评估器。"
              action={
                <Button size="sm" onClick={() => router.push('/experiments/new')}>
                  <Plus className="size-3.5" />
                  新建实验
                </Button>
              }
            />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>实验</th>
                  <th style={TH}>待评测 Agent</th>
                  <th style={TH}>实验类型</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Case</th>
                  <th style={{ ...TH, textAlign: 'right' }}>评估器</th>
                  <th style={{ ...TH, textAlign: 'right' }}>综合分</th>
                  <th style={TH}>状态</th>
                  <th style={TH}>创建</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/experiments/${r.id}`)}
                    style={{ cursor: 'pointer', transition: 'background 0.12s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--background-secondary)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ ...TD, fontWeight: 500 }}>{r.name}</td>
                    <td style={{ ...TD, color: 'var(--foreground-secondary)' }}>{r.agentName || '—'}</td>
                    <td style={TD}><TypeChip /></td>
                    <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.caseCount}</td>
                    <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.evaluatorCount}</td>
                    <td style={{
                      ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      fontWeight: 700, color: typeof r.overallScore === 'number' ? 'var(--primary)' : 'var(--foreground-muted)',
                    }}>
                      {typeof r.overallScore === 'number' ? r.overallScore.toFixed(1).replace(/\.0$/, '') : '—'}
                    </td>
                    <td style={TD}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <StatusChip status={r.status} />
                        {r.watchMode && <WatchChip />}
                      </span>
                    </td>
                    <td style={{ ...TD, color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>
                      {new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!loading && total > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 12, fontSize: 12, color: 'var(--foreground-muted)' }}>
            <span>共 {total} 个实验</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              每页
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                style={{
                  fontSize: 12, padding: '3px 6px', borderRadius: 6,
                  border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground)',
                }}
              >
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              条
            </label>
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              上一页
            </Button>
            <span>{page} / {totalPages}</span>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              下一页
            </Button>
          </div>
        )}
      </PageContainer>
    </>
  );
}
