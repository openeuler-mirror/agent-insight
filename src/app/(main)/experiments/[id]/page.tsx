'use client';

// TODO(M6): 实验详情页最小壳 —— 执行引擎与结果呈现（ExperimentEvalResult）
// 落地后本页会重做为「按评估器 × case 的结果矩阵 + 类目均分」形态。
import { use, useCallback, useEffect, useState } from 'react';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';

interface ExperimentDetail {
  id: string;
  name: string;
  type: string;
  agentName: string;
  status: string;
  evaluatorIds: string[];
  createdAt: string;
  cases: Array<{
    id: string;
    executionId: string | null;
    taskId: string | null;
    input: string;
    actualOutput: string;
    referenceOutput: string | null;
  }>;
  results: unknown[];
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  draft: { label: '草稿', bg: 'var(--background-secondary)', fg: 'var(--foreground-secondary)' },
  running: { label: '运行中', bg: 'var(--tag-amber-bg)', fg: 'var(--tag-amber-fg)' },
  done: { label: '已完成', bg: 'var(--tag-green-bg)', fg: 'var(--tag-green-fg)' },
  failed: { label: '失败', bg: 'var(--tag-red-bg)', fg: 'var(--tag-red-fg)' },
};

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '9px 12px', fontSize: 12, color: 'var(--foreground)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'top',
};

function truncate(text: string | null | undefined, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export default function ExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuth();
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/experiments/${encodeURIComponent(id)}?user=${encodeURIComponent(user)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '加载实验失败'));
      setDetail(data);
      setError('');
    } catch (e: any) {
      setError(e?.message || '加载实验失败');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [user, id]);

  useEffect(() => { load(); }, [load]);

  const status = STATUS_META[detail?.status ?? 'draft'] ?? STATUS_META.draft;

  return (
    <>
      <AppTopBar title={detail ? detail.name : '实验详情'} />
      <PageContainer>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>加载中…</div>
        ) : error || !detail ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--error)' }}>{error || '实验不存在'}</div>
        ) : (
          <>
            <div style={{
              background: 'var(--card-bg)', border: '1px solid var(--card-border)',
              borderRadius: 10, padding: 16, marginBottom: 14,
              display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', fontSize: 12,
            }}>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 500,
                background: status.bg, color: status.fg,
              }}>
                {status.label}
              </span>
              <span><span style={{ color: 'var(--foreground-muted)' }}>待评测 Agent：</span>{detail.agentName || '—'}</span>
              <span><span style={{ color: 'var(--foreground-muted)' }}>Case：</span>{detail.cases.length}</span>
              <span><span style={{ color: 'var(--foreground-muted)' }}>评估器：</span>{detail.evaluatorIds.length}</span>
              <span style={{ color: 'var(--foreground-muted)' }}>
                创建于 {new Date(detail.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
            </div>

            <div style={{
              background: 'var(--card-bg)', border: '1px solid var(--card-border)',
              borderRadius: 10, overflow: 'hidden',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>任务输入</th>
                    <th style={TH}>参考输出</th>
                    <th style={TH}>实际输出</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.cases.map((c) => (
                    <tr key={c.id}>
                      <td style={{ ...TD, maxWidth: 320 }}>{truncate(c.input, 90)}</td>
                      <td style={TD}>
                        <span style={{
                          fontSize: 11, padding: '1px 7px', borderRadius: 8, fontWeight: 500,
                          background: c.referenceOutput ? 'var(--tag-green-bg)' : 'var(--background-secondary)',
                          color: c.referenceOutput ? 'var(--tag-green-fg)' : 'var(--foreground-muted)',
                        }}>
                          {c.referenceOutput ? '已标注' : '未标注'}
                        </span>
                      </td>
                      <td style={{ ...TD, maxWidth: 380, color: 'var(--foreground-secondary)' }}>
                        {truncate(c.actualOutput, 110)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </PageContainer>
    </>
  );
}
