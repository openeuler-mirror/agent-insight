'use client';
import { DeleteExperimentButton, PendingExperimentCancellations } from '@/components/eval/DeleteExperimentButton';

// 实验列表 —— 评测「实验化」第一切片（本期仅单组实验）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical, Plus } from 'lucide-react';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { Button } from '@/components/ui/button';
import { ExperimentRenameButton } from '@/components/eval/ExperimentRenameButton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { displayedExperimentName } from '@/lib/engine/experiment/experiment-name';

interface ExperimentRow {
  id: string;
  name: string;
  type: string;
  agentName: string;
  status: string;
  scope?: string;
  watchMode?: boolean;
  caseCount: number;
  evaluatorCount: number;
  overallScore: number | null;
  createdAt: string;
}

const PAGE_SIZE_OPTIONS = [20, 50, 100];
const LIST_REFRESH_MS = 5_000;

function responseError(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const error = (value as { error?: unknown; code?: unknown }).error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return String((error as { message: string }).message);
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : fallback;
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  draft: { label: '启动中', bg: 'var(--background-secondary)', fg: 'var(--foreground-secondary)' },
  running: { label: '运行中', bg: 'var(--tag-amber-bg)', fg: 'var(--tag-amber-fg)' },
  done: { label: '已完成', bg: 'var(--tag-green-bg)', fg: 'var(--tag-green-fg)' },
  partial: { label: '部分完成', bg: 'var(--tag-amber-bg)', fg: 'var(--tag-amber-fg)' },
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

function TypeChip({ scope }: { scope?: string }) {
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 500,
      background: 'var(--primary-subtle)', color: 'var(--primary)', whiteSpace: 'nowrap',
    }}>
      {scope === 'benchmark' ? 'Benchmark' : '单组实验'}
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
  const [actionId, setActionId] = useState('');
  const [actionError, setActionError] = useState('');
  const loadSequence = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (!user) return;
    const sequence = ++loadSequence.current;
    if (!silent) setLoading(true);
    try {
      const offset = (page - 1) * pageSize;
      const res = await apiFetch(
        `/api/experiments?user=${encodeURIComponent(user)}&limit=${pageSize}&offset=${offset}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(responseError(data, '加载实验失败'));
      if (sequence !== loadSequence.current) return;
      setRows(Array.isArray(data?.items) ? data.items : []);
      setTotal(typeof data?.total === 'number' ? data.total : 0);
    } catch {
      if (!silent && sequence === loadSequence.current) {
        setRows([]);
        setTotal(0);
      }
    } finally {
      if (!silent && sequence === loadSequence.current) setLoading(false);
    }
  }, [user, page, pageSize]);

  useEffect(() => () => { loadSequence.current += 1; }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // 非终态实验完成后服务端状态会变化；串行静默轮询，避免旧响应覆盖新分页快照。
  useEffect(() => {
    if (!rows.some((row) => row.status === 'running' || row.status === 'draft')) return;
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await load(true);
        if (!cancelled) schedule();
      }, LIST_REFRESH_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rows, load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // 页码/每页条数变化后若越界（如切大页码后减小 pageSize），回夹到末页
  useEffect(() => {
    if (page <= totalPages) return;
    const timer = window.setTimeout(() => setPage(totalPages), 0);
    return () => window.clearTimeout(timer);
  }, [page, totalPages]);

  const createSameConfigExperiment = async (sourceExperimentId: string) => {
    if (!user || actionId) return;
    setActionId(sourceExperimentId);
    setActionError('');
    try {
      const createResponse = await apiFetch('/api/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, createMode: 'same-config', sourceExperimentId }),
      });
      const created = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok) throw new Error(responseError(created, '复制实验配置失败'));
      const experimentId = String(created?.id || '');
      if (!experimentId) throw new Error('复制实验后未返回实验 ID');
      const runResponse = await apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}/run?user=${encodeURIComponent(user)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const started = await runResponse.json().catch(() => ({}));
      if (!runResponse.ok) {
        await apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}?user=${encodeURIComponent(user)}`, {
          method: 'DELETE',
        }).catch(() => undefined);
        throw new Error(responseError(started, '启动实验失败'));
      }
      router.push(`/experiments/${experimentId}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '同配置实验创建失败');
      setActionId('');
    }
  };

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
        {user && <PendingExperimentCancellations user={user} />}
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
                  <th style={TH}>操作</th>
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
                    <td style={{ ...TD, fontWeight: 500 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {displayedExperimentName(r.name, r.createdAt)}
                        {user && <ExperimentRenameButton
                          experimentId={r.id}
                          user={user}
                          name={r.name}
                          createdAt={r.createdAt}
                          onRenamed={(name) => {
                            setRows((current) => current.map((item) => item.id === r.id ? { ...item, name } : item));
                            void load(true);
                          }}
                        />}
                      </span>
                    </td>
                    <td style={{ ...TD, color: 'var(--foreground-secondary)' }}>{r.agentName || '—'}</td>
                    <td style={TD}><TypeChip scope={r.scope} /></td>
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
                    <td style={{ ...TD, whiteSpace: 'nowrap' }} onClick={(event) => event.stopPropagation()}>
                      <span style={{ display: 'inline-flex', gap: 8 }}>
                        <button
                          type="button"
                          disabled={Boolean(actionId)}
                          onClick={() => void createSameConfigExperiment(r.id)}
                          style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--primary)', fontSize: 11, cursor: actionId ? 'not-allowed' : 'pointer' }}
                        >
                          {actionId === r.id ? '创建中…' : '同配置实验'}
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(actionId)}
                          onClick={() => router.push(`/experiments/new?reuseFrom=${encodeURIComponent(r.id)}`)}
                          style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--primary)', fontSize: 11, cursor: actionId ? 'not-allowed' : 'pointer' }}
                        >复用评测配置</button>
                        {user && <DeleteExperimentButton user={user} experimentId={r.id} completed={['done', 'partial', 'failed', 'cancelled'].includes(r.status)} onDeleted={() => load(true)} />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {actionError && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--error)' }}>{actionError}</div>}

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
