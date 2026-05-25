'use client';

import { useCallback, useMemo, useState, useEffect, useRef, startTransition, type CSSProperties, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardList, Pencil, PlayCircle, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/client/api';
import { type DatasetKind, type AgentDataset, type DatasetCase, schemaColumnTags, defaultFieldsForKind, type DatasetDefaultFieldDef } from '@/lib/agent-dataset-model';
import { parseBatchFromFileContent, readFileAsText } from '@/lib/dataset-batch-import';
import { useAuth } from '@/lib/auth/auth-context';

interface DatasetDraft {
  id?: string;
  name: string;
  description: string;
  targetAgent: string;
  tagsText: string;
  datasetKind: DatasetKind;
  cases: DatasetCase[];
}

const emptyDraft: DatasetDraft = {
  name: '',
  description: '',
  targetAgent: '',
  tagsText: '',
  datasetKind: 'ideal_output',
  cases: [],
};

function toDraft(dataset: AgentDataset): DatasetDraft {
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description || '',
    targetAgent: dataset.targetAgent || '',
    tagsText: (dataset.tags || []).join(', '),
    datasetKind: dataset.datasetKind === 'trajectory' ? 'trajectory' : 'ideal_output',
    cases: (dataset.cases || []).map(item => ({
      ...item,
      tags: item.tags || [],
      trajectory: item.trajectory ?? '',
    })),
  };
}

function parseTags(text: string): string[] {
  return text
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function truncateText(text: string, max: number) {
  const t = (text || '').trim();
  if (!t) return '—';
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function formatRelativeZh(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const dayMs = 86400000;
  const diff = now.getTime() - d.getTime();
  if (diff < 0) return '刚刚';
  if (now.toDateString() === d.toDateString()) return '今日';
  const days = Math.floor(diff / dayMs);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function datasetPrimaryStatLine(item: AgentDataset): { label: string; value: string } {
  const n = item.cases?.length ?? 0;
  if (item.datasetKind === 'trajectory') {
    return { label: '轨迹样例', value: String(n) };
  }
  return { label: '评测数据', value: String(n) };
}

function datasetCardStatus(item: AgentDataset): { label: string; tone: 'published' | 'iterating' } {
  const n = item.cases?.length ?? 0;
  if (n >= 1) return { label: '已发布', tone: 'published' };
  return { label: '迭代中', tone: 'iterating' };
}

const datasetActionBaseStyle: CSSProperties = {
  minHeight: 28,
  padding: '0 10px',
  borderRadius: 7,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1,
  cursor: 'pointer',
  transition: 'background 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease',
};

const datasetActionGhostStyle: CSSProperties = {
  ...datasetActionBaseStyle,
  border: '1px solid var(--border)',
  background: 'var(--card-bg)',
  color: 'var(--foreground-secondary)',
};

const datasetActionDangerStyle: CSSProperties = {
  ...datasetActionBaseStyle,
  border: '1px solid var(--error-subtle-border)',
  background: 'var(--error-subtle)',
  color: 'var(--error)',
};

const datasetActionPrimaryStyle: CSSProperties = {
  ...datasetActionBaseStyle,
  border: '1px solid var(--primary)',
  background: 'var(--primary)',
  color: 'var(--primary-foreground)',
  boxShadow: '0 2px 8px rgba(79, 70, 229, 0.16)',
};

function IconPlus({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M9 4v10M4 9h10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconChevronDown({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconUpload({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M9 12.5V4.5M6 7l3-2.5 3 2.5M4 14.5h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DefaultFieldsTable({ fields }: { fields: DatasetDefaultFieldDef[] }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '160px 72px 48px 1fr',
          gap: 12,
          padding: '7px 14px',
          background: 'var(--background-secondary)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {['字段名', '类型', '必填', '描述'].map(h => (
          <span
            key={h}
            style={{ fontSize: 11, fontWeight: 600, color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}
          >
            {h}
          </span>
        ))}
      </div>
      {fields.map((field, i) => (
        <div
          key={field.key}
          style={{
            display: 'grid',
            gridTemplateColumns: '160px 72px 48px 1fr',
            gap: 12,
            padding: '9px 14px',
            borderTop: i > 0 ? '1px solid var(--border)' : undefined,
            alignItems: 'baseline',
            background: 'var(--card-bg, var(--background))',
          }}
        >
          <code style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>{field.key}</code>
          <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>{field.dataType}</span>
          <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>{field.required}</span>
          <span style={{ fontSize: 12, color: 'var(--foreground-muted)', lineHeight: 1.45 }}>{field.description}</span>
        </div>
      ))}
    </div>
  );
}

export default function AgentDatasetCenter() {
  const router = useRouter();
  const { user } = useAuth();
  const [datasets, setDatasets] = useState<AgentDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<DatasetDraft>(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [tableActionError, setTableActionError] = useState('');

  const loadDatasets = useCallback(
    async (opts?: { isRefresh?: boolean }): Promise<AgentDataset[]> => {
      if (!user) return [];
      if (opts?.isRefresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      let list: AgentDataset[] = [];
      try {
        const res = await apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}`);
        const data = await res.json();
        list = Array.isArray(data) ? data : [];
        setDatasets(list);
        if (!opts?.isRefresh) {
          if (list.length > 0) {
            setCreating(false);
          } else {
            setCreating(false);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '评测集加载失败');
      } finally {
        if (opts?.isRefresh) setRefreshing(false);
        else setLoading(false);
      }
      return list;
    },
    [user],
  );

  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 首次进入拉取评测集列表
    void loadDatasets();
  }, [user, loadDatasets]);

  useEffect(() => {
    if (!createMenuOpen) return;
    // 文件 import 了 React，MouseEvent 会被解析成 React.MouseEvent，
    // 而 document.addEventListener('mousedown', ...) 期望的是 DOM 原生的，
    // 用 globalThis.MouseEvent 避免歧义。
    const onDoc = (e: globalThis.MouseEvent) => {
      if (createMenuRef.current?.contains(e.target as Node)) return;
      setCreateMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [createMenuOpen]);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setError('');
  }, []);

  useEffect(() => {
    if (!editorOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEditor();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorOpen, closeEditor]);

  const filteredDatasets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return datasets;
    return datasets.filter(
      d =>
        d.name.toLowerCase().includes(q) ||
        (d.description || '').toLowerCase().includes(q) ||
        (d.targetAgent || '').toLowerCase().includes(q),
    );
  }, [datasets, searchQuery]);

  const openEditorForDataset = (dataset: AgentDataset) => {
    startTransition(() => {
      setCreating(false);
      setDraft(toDraft(dataset));
      setError('');
      setEditorOpen(true);
    });
  };

  const openCreate = () => {
    startTransition(() => {
      setCreating(true);
      setDraft({ ...emptyDraft, datasetKind: 'ideal_output', cases: [] });
      setError('');
      setEditorOpen(true);
    });
  };

  const openImport = () => {
    setCreateMenuOpen(false);
    setTableActionError('');
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (file: File | null) => {
    if (!file) return;
    setTableActionError('');
    try {
      const text = await readFileAsText(file);
      // 先按理想输出试解析；若任意 case 含 trajectory 字段则切到 trajectory 集
      const tryIdeal = parseBatchFromFileContent(text, file.name, 'ideal_output');
      if (tryIdeal.cases.length === 0) {
        setTableActionError(tryIdeal.message || '未能解析出有效数据；JSON 需是数组，每行需有 input 与 expected_output');
        return;
      }
      const tryTraj = parseBatchFromFileContent(text, file.name, 'trajectory');
      const hasTraj = tryTraj.cases.some(c => (c.trajectory || '').trim().length > 0);
      const cases = hasTraj ? tryTraj.cases : tryIdeal.cases;
      const datasetKind: DatasetKind = hasTraj ? 'trajectory' : 'ideal_output';

      const baseName = file.name.replace(/\.(json|csv|jsonl|txt)$/i, '').trim() || '导入的评测集';
      startTransition(() => {
        setCreating(true);
        setDraft({
          ...emptyDraft,
          name: baseName.slice(0, 50),
          datasetKind,
          cases,
        });
        setError(
          tryIdeal.skippedEmpty > 0
            ? `已解析 ${cases.length} 条，跳过 ${tryIdeal.skippedEmpty} 条空行；请确认后保存`
            : '',
        );
        setEditorOpen(true);
      });
    } catch (e) {
      setTableActionError(e instanceof Error ? e.message : '文件读取失败');
    }
  };

  const selectDatasetKind = (kind: DatasetKind) => {
    setDraft(prev => ({ ...prev, datasetKind: kind }));
    setError('');
  };

  const handleDeleteDataset = async (item: AgentDataset) => {
    if (!user) return;
    if (!globalThis.confirm(`确定删除评测集「${item.name}」？删除后不可恢复。`)) return;
    setTableActionError('');
    try {
      const res = await apiFetch(
        `/api/agent-datasets/${encodeURIComponent(item.id)}?user=${encodeURIComponent(user)}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || '删除失败');
      if (editorOpen && draft.id === item.id) closeEditor();
      await loadDatasets({ isRefresh: true });
    } catch (e) {
      setTableActionError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const handleSave = async () => {
    if (!user) return;
    if (!draft.name.trim()) {
      setError('请先填写评测集名称');
      return;
    }

    setSaving(true);
    setError('');

    const payload = {
      user,
      id: draft.id,
      name: draft.name.slice(0, 50).trim(),
      description: draft.description.slice(0, 200).trim(),
      tags: parseTags(draft.tagsText),
      datasetKind: draft.datasetKind,
      cases: draft.cases.map(item => ({
        id: item.id,
        input: item.input.trim(),
        expectedOutput: item.expectedOutput.trim(),
        evaluationFocus: '',
        tags: [] as string[],
        trajectory: draft.datasetKind === 'trajectory' ? item.trajectory.trim() : '',
      })),
    };

    try {
      const res = await apiFetch('/api/agent-datasets', {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok || !result?.success) {
        throw new Error(result?.error || '保存失败');
      }

      const newId = result.dataset?.id as string | undefined;

      const datasetsNext = await loadDatasets({ isRefresh: true });
      if (creating && newId) {
        setCreating(false);
        closeEditor();
        router.push(`/dataset/${newId}`);
        return;
      }

      const saved =
        datasetsNext.find(item => item.id === result.dataset?.id) || datasetsNext[0] || null;
      if (saved) {
        setCreating(false);
        setDraft(toDraft(saved));
        closeEditor();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="loading">正在加载评测集...</div>;
  }

  return (
    <div style={{ padding: '18px 22px 28px', maxWidth: 1680, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 4px', color: 'var(--foreground)', fontSize: 20, fontWeight: 600 }}>数据集</h1>
        <p style={{ margin: 0, color: 'var(--foreground-muted)', fontSize: 12 }}>
          卡片视图管理评测集；查看样例请点「查看」，修改定义请点「编辑」，评测流水线请在指标页发起。
        </p>
      </div>

      {tableActionError ? (
        <div
          style={{
            marginBottom: 12,
            padding: 10,
            borderRadius: 8,
            border: '1px solid var(--error-subtle-border)',
            background: 'var(--error-subtle)',
            color: 'var(--error)',
            fontSize: 13,
          }}
        >
          {tableActionError}
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <input
          type="search"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="搜索名称"
          aria-label="搜索评测集名称"
          style={{
            flex: '1 1 220px',
            minWidth: 180,
            maxWidth: 320,
            height: 30,
            borderRadius: 7,
            border: '1px solid var(--input-border)',
            background: 'var(--input-bg)',
            color: 'var(--foreground)',
            padding: '0 12px',
            fontSize: 13,
          }}
        />
        <div style={{ flex: '1 1 auto' }} />
        <button
          type="button"
          className="ai-btn-s"
          onClick={() => void loadDatasets({ isRefresh: true })}
          disabled={refreshing}
          title={refreshing ? '刷新列表' : `刷新列表（共 ${datasets.length} 个评测集）`}
        >
          {refreshing ? '刷新中…' : '刷新'}
        </button>
        <div ref={createMenuRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <div className="ai-dataset-create-split">
            <button
              type="button"
              className="ai-dataset-create-split__main"
              onClick={() => setCreateMenuOpen(v => !v)}
              aria-expanded={createMenuOpen}
              aria-haspopup="menu"
            >
              <IconPlus size={13} />
              新建评测集
            </button>
            <button
              type="button"
              className="ai-dataset-create-split__chev"
              onClick={() => setCreateMenuOpen(v => !v)}
              aria-label="展开新建方式"
            >
              <IconChevronDown size={10} />
            </button>
          </div>
          {createMenuOpen && (
            <div className="ai-dataset-menu" role="menu" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 8 }}>
              <button
                type="button"
                role="menuitem"
                className="ai-dataset-menu-item"
                onClick={() => {
                  setCreateMenuOpen(false);
                  openCreate();
                }}
              >
                <span className="ai-dataset-menu-item__icon">
                  <IconPlus size={14} />
                </span>
                新建评测集
              </button>
              <button
                type="button"
                role="menuitem"
                className="ai-dataset-menu-item"
                onClick={openImport}
                title="从 JSON / CSV 文件导入"
              >
                <span className="ai-dataset-menu-item__icon">
                  <IconUpload size={14} />
                </span>
                导入本地文件
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.csv,application/json,text/csv"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.target.files?.[0] ?? null;
                  void handleFileChosen(f);
                  // 同一文件二次选择也能触发 change
                  e.target.value = '';
                }}
              />
            </div>
          )}
        </div>
      </div>

      {datasets.length === 0 ? (
        <div
          className="ai-card"
          style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--foreground-muted)',
            border: '1px solid var(--border)',
          }}
        >
          还没有评测集，点击「新建评测集」开始。
        </div>
      ) : filteredDatasets.length === 0 ? (
        <div
          className="ai-card"
          style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--foreground-muted)',
            border: '1px solid var(--border)',
          }}
        >
          无匹配结果，请调整搜索关键词。
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
            gap: 14,
          }}
        >
          {filteredDatasets.map(item => {
            const stat = datasetPrimaryStatLine(item);
            const status = datasetCardStatus(item);
            const badgeBg =
              status.tone === 'published'
                ? 'rgba(34, 197, 94, 0.14)'
                : 'rgba(245, 158, 11, 0.18)';
            const badgeColor = status.tone === 'published' ? '#15803d' : '#c2410c';
            const evalHint =
              item.cases?.length && status.tone === 'published' ? '评测：待同步' : '评测：待发起';
            const openDataset = () => router.push(`/dataset/${item.id}`);
            const stopActionPropagation = (event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
            };

            return (
              <div
                key={item.id}
                className="ai-card ai-dataset-card"
                role="link"
                tabIndex={0}
                aria-label={`查看数据集 ${item.name}`}
                onClick={openDataset}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openDataset();
                  }
                }}
                style={{
                  padding: 0,
                  border: '2px solid var(--primary-subtle-border)',
                  borderRadius: 12,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  background: 'var(--card-bg, var(--background))',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    padding: '14px 16px 10px',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <h2
                      style={{
                        margin: 0,
                        fontSize: 15,
                        fontWeight: 600,
                        color: 'var(--foreground)',
                        lineHeight: 1.35,
                      }}
                      title={item.name}
                    >
                      {truncateText(item.name, 42)}
                    </h2>
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {schemaColumnTags(item).map(field => (
                        <span
                          key={field}
                          style={{
                            fontSize: 10,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'var(--background-secondary)',
                            color: 'var(--foreground-muted)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          {field}
                        </span>
                      ))}
                      {(item.tags || []).slice(0, 3).map(tag => (
                        <span
                          key={tag}
                          style={{
                            fontSize: 10,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'var(--background-tertiary, var(--background-secondary))',
                            color: 'var(--foreground-muted)',
                            border: '1px dashed var(--border)',
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '4px 10px',
                      borderRadius: 999,
                      background: badgeBg,
                      color: badgeColor,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {status.label}
                  </span>
                </div>

                <div style={{ padding: '12px 16px', flex: 1, fontSize: 12.5, color: 'var(--foreground-secondary)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                    <span style={{ color: 'var(--foreground-muted)' }}>
                      {stat.label}：<strong style={{ color: 'var(--foreground)' }}>{stat.value}</strong>
                    </span>
                    <span style={{ color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>{evalHint}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--foreground-muted)' }}>
                      最新通过率：<strong style={{ color: 'var(--foreground)' }}>—</strong>
                      <span style={{ fontSize: 11, marginLeft: 6, opacity: 0.85 }}>（与执行记录对齐后展示）</span>
                    </span>
                    <span style={{ color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>
                      更新 {formatRelativeZh(item.updatedAt)}
                    </span>
                  </div>
                  {item.description?.trim() ? (
                    <p
                      style={{
                        margin: '10px 0 0',
                        fontSize: 11.5,
                        color: 'var(--foreground-muted)',
                        lineHeight: 1.45,
                      }}
                    >
                      {truncateText(item.description, 120)}
                    </p>
                  ) : null}
                </div>

                <div
                  style={{
                    padding: '10px 14px 14px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '8px 10px',
                    borderTop: '1px solid var(--border)',
                    background: 'var(--background-secondary)',
                  }}
                >
                  <button
                    type="button"
                    className="ai-dataset-action ai-dataset-action--ghost"
                    style={datasetActionGhostStyle}
                    onClick={event => {
                      stopActionPropagation(event);
                      openEditorForDataset(item);
                    }}
                    title="编辑数据集信息"
                  >
                    <Pencil size={14} aria-hidden />
                    编辑信息
                  </button>
                  <button
                    type="button"
                    className="ai-dataset-action ai-dataset-action--danger"
                    style={datasetActionDangerStyle}
                    onClick={event => {
                      stopActionPropagation(event);
                      void handleDeleteDataset(item);
                    }}
                    title="删除数据集"
                  >
                    <Trash2 size={14} aria-hidden />
                    删除
                  </button>
                  <div style={{ flex: 1, minWidth: 8 }} />
                  <button
                    type="button"
                    className="ai-dataset-action ai-dataset-action--primary"
                    style={datasetActionPrimaryStyle}
                    onClick={event => {
                      stopActionPropagation(event);
                      if (item.datasetKind === 'trajectory') {
                        router.push(`/eval/trajectory?datasetId=${encodeURIComponent(item.id)}`);
                      } else {
                        // 非轨迹评测集暂时仍引导到评估器目录页选评估器
                        router.push('/metrics');
                      }
                    }}
                    title={
                      item.datasetKind === 'trajectory'
                        ? '使用轨迹评估器（opencode）发起评测'
                        : '前往评估器目录选择评估器'
                    }
                  >
                    {item.datasetKind === 'trajectory' ? (
                      <PlayCircle size={14} aria-hidden />
                    ) : (
                      <ClipboardList size={14} aria-hidden />
                    )}
                    发起评测
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editorOpen && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
          onClick={() => closeEditor()}
          onKeyDown={e => e.key === 'Escape' && closeEditor()}
        >
          <div
            role="dialog"
            aria-modal
            aria-labelledby="dataset-editor-title"
            className="ai-card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              maxWidth: 920,
              width: '100%',
              maxHeight: 'min(92vh, 900px)',
              overflow: 'hidden',
              border: '1px solid var(--border)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ flex: 1, overflow: 'auto', padding: '20px 20px 8px' }}>
            <div style={{ marginBottom: 16 }}>
              <div className="ai-section-title" id="dataset-editor-title">
                {creating ? '新建评测集' : '编辑评测集'}
              </div>
              <div className="ai-section-hint">
                仅填写评测集定义（名称、描述、场景）。保存新建后将进入「数据项」页录入样例。
              </div>
            </div>

            {creating && draft.cases.length > 0 && (
              <div
                style={{
                  border: '1px solid var(--accent-subtle-border, rgba(59,130,246,0.32))',
                  background: 'var(--accent-subtle, rgba(59,130,246,0.10))',
                  color: 'var(--accent, #1d4ed8)',
                  padding: 10,
                  borderRadius: 8,
                  marginBottom: 10,
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                已从文件解析 <strong>{draft.cases.length}</strong> 条数据项，保存后将一并写入。
              </div>
            )}

            {error && (
              <div
                style={{
                  border: '1px solid var(--error-subtle-border)',
                  background: 'var(--error-subtle)',
                  color: 'var(--error)',
                  padding: 10,
                  borderRadius: 8,
                  marginBottom: 10,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <div
                className="ai-section-title"
                style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                基本信息
              </div>
              <div style={{ marginBottom: 10 }}>
                <InputField
                  label="名称 *"
                  value={draft.name}
                  onChange={value => setDraft(prev => ({ ...prev, name: value }))}
                  placeholder="请输入评测集名称"
                  maxLength={50}
                />
              </div>
              <TextAreaField
                label="描述"
                value={draft.description}
                onChange={value => setDraft(prev => ({ ...prev, description: value }))}
                placeholder="请输入评测集描述"
                maxLength={200}
                rows={3}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div className="ai-section-title" style={{ marginBottom: 4 }}>
                配置列
              </div>
              <div className="ai-section-hint" style={{ marginBottom: 10 }}>
                选择场景一键快速配置默认列（当前不含工作流类评测集）。
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 10,
                }}
              >
                <button
                  type="button"
                  onClick={() => selectDatasetKind('ideal_output')}
                  style={{
                    textAlign: 'left',
                    padding: '12px 14px',
                    borderRadius: 10,
                    border:
                      draft.datasetKind === 'ideal_output'
                        ? '2px solid var(--primary)'
                        : '1px solid var(--border)',
                    background: 'var(--background-secondary)',
                    cursor: 'pointer',
                    color: 'var(--foreground)',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>理想输出评测集</div>
                  <div style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>包含输入和理想输出</div>
                </button>
                <button
                  type="button"
                  onClick={() => selectDatasetKind('trajectory')}
                  style={{
                    textAlign: 'left',
                    padding: '12px 14px',
                    borderRadius: 10,
                    border:
                      draft.datasetKind === 'trajectory'
                        ? '2px solid var(--primary)'
                        : '1px solid var(--border)',
                    background: 'var(--background-secondary)',
                    cursor: 'pointer',
                    color: 'var(--foreground)',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>轨迹评测集</div>
                  <div style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>Agent 运行轨迹评测</div>
                </button>
              </div>
            </div>

            <div style={{ marginTop: 4, marginBottom: 10 }}>
              <div className="ai-section-title" style={{ marginBottom: 6 }}>
                默认数据项
              </div>
              <div className="ai-section-hint" style={{ marginBottom: 10 }}>
                配置列说明：理想输出场景默认 input、reference_output；轨迹场景额外增加 trajectory 文本字段。
              </div>
              <DefaultFieldsTable fields={defaultFieldsForKind(draft.datasetKind)} />
            </div>

            <p className="ai-section-hint" style={{ margin: '12px 0 16px' }}>
              样例数据请在保存评测集后，通过跳转页或列表「录入数据」维护。
            </p>
            </div>

            <div
              style={{
                flexShrink: 0,
                borderTop: '1px solid var(--border)',
                padding: '12px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 8,
                background: 'var(--card-bg, var(--background))',
                borderRadius: '0 0 10px 10px',
              }}
            >
              <button type="button" className="ai-btn-s" onClick={() => closeEditor()}>
                取消
              </button>
              <button type="button" className="ai-btn-p" onClick={() => void handleSave()} disabled={saving}>
                {saving ? '保存中...' : '保存评测集'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--foreground-muted)', textTransform: 'uppercase' }}>{label}</span>
        {maxLength != null ? (
          <span
            style={{
              fontSize: 10,
              color: 'var(--foreground-muted)',
              fontVariantNumeric: 'tabular-nums',
              textTransform: 'none',
            }}
          >
            {value.length}/{maxLength}
          </span>
        ) : null}
      </span>
      <input
        value={value}
        maxLength={maxLength}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        style={{
          height: 34,
          borderRadius: 7,
          border: '1px solid var(--input-border)',
          background: 'var(--input-bg)',
          color: 'var(--foreground)',
          padding: '0 10px',
          fontSize: 12,
        }}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--foreground-muted)', textTransform: 'uppercase' }}>{label}</span>
        {maxLength != null ? (
          <span
            style={{
              fontSize: 10,
              color: 'var(--foreground-muted)',
              fontVariantNumeric: 'tabular-nums',
              textTransform: 'none',
            }}
          >
            {value.length}/{maxLength}
          </span>
        ) : null}
      </span>
      <textarea
        value={value}
        maxLength={maxLength}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{
          borderRadius: 7,
          border: '1px solid var(--input-border)',
          background: 'var(--input-bg)',
          color: 'var(--foreground)',
          padding: '8px 10px',
          fontSize: 12,
          resize: 'vertical',
        }}
      />
    </label>
  );
}
