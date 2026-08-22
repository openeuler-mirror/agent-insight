'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/client/api';
import {
  type AgentDataset,
  type DatasetCase,
  type DatasetField,
  type DatasetFieldType,
  coerceDatasetKind,
  createEvaluatorCatalogField,
  createEmptyCase,
  evaluatorCatalogFieldKeyFromLabel,
  nextDatasetFieldKey,
  parseDatasetNumberValue,
  TRAJECTORY_PLACEHOLDER,
  withEvaluatorCatalogFields,
} from '@/lib/agent-dataset-model';
import {
  parseBatchAuto,
  parseBatchFromFileContent,
  readFileAsText,
} from '@/lib/dataset-batch-import';
import { useAuth } from '@/lib/auth/auth-context';
import { reportClientUsage } from '@/lib/usage-analytics/client-events';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import styles from '@/components/DatasetItemsPage.module.css';
import { formatReliabilityFaultTypeFromCaseValues } from '@/lib/reliability/fault-type-display';

function IconRefresh({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 9h6V3M14 21v-6h6M18.364 18.364A9 9 0 005.636 5.636M5.636 18.364A9 9 0 0018.364 5.636"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconUploadTray({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 16V8m0 0l3 3m-3-3l-3 3M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5-5 5 5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPlusSm({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path d="M9 4v10M4 9h10" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
    </svg>
  );
}

function TooltipCell({
  shortText,
  fullText,
  tdStyle,
  onClick,
}: {
  shortText: string;
  fullText: string;
  tdStyle?: React.CSSProperties;
  onClick?: () => void;
}) {
  const [show, setShow] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const tdRef = useRef<HTMLTableCellElement>(null);

  return (
    <td
      ref={tdRef}
      style={tdStyle}
      onMouseEnter={() => {
        setRect(tdRef.current?.getBoundingClientRect() ?? null);
        setShow(true);
      }}
      onMouseLeave={() => setShow(false)}
      onClick={onClick}
    >
      {shortText}
      {show && rect && fullText && (
        <div
          style={{
            position: 'fixed',
            top: rect.bottom + 6,
            left: Math.min(rect.left, window.innerWidth - 440),
            zIndex: 9999,
            background: 'var(--card-bg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: 14,
            lineHeight: 1.6,
            maxWidth: 440,
            maxHeight: 320,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            color: 'var(--foreground)',
            pointerEvents: 'none',
          }}
        >
          {fullText}
        </div>
      )}
    </td>
  );
}

function isDatasetPublished(d: AgentDataset): boolean {
  const n = d.cases?.length ?? 0;
  return n >= 1;
}

const BATCH_JSON_PLACEHOLDER = `请粘贴 JSON 数组，例如：
[
  {"input": "问题1", "expected_output": "答案1"},
  {
    "input": "读取配置并汇总关键项",
    "available_tools": [{"name": "read_file", "description": "读取文件"}],
    "available_skills": [{"name": "config-review", "description": "检查配置"}]
  }
]

若以逗号分隔且无表头，也可直接粘贴 CSV（前两列为输入、预期输出）。`;

function formatDateFull(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function shorten(s: string, n: number) {
  const t = (s || '').trim();
  if (!t) return '—';
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function fieldValue(row: DatasetCase, key: string): unknown {
  if (row.values && Object.hasOwn(row.values, key)) return row.values[key];
  if (key === 'input') return row.input;
  if (key === 'reference_output') return row.expectedOutput;
  if (key === 'trajectory' || key === 'trace') return row.trajectory;
  return '';
}

function fieldText(row: DatasetCase, key: string): string {
  const value = fieldValue(row, key);
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export default function DatasetItemsPage() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { user } = useAuth();

  const [dataset, setDataset] = useState<AgentDataset | null>(null);
  const fullDatasetRef = useRef<AgentDataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // ?case=<caseId> 入参支持: 别处(如 grayscale 执行记录 modal 的 Case ID 链接)
  // 跳过来时滚动到对应行并短暂高亮, 让用户一眼定位。
  const searchParams = useSearchParams();
  const highlightCaseId = searchParams?.get('case') || '';
  const [highlightActive, setHighlightActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowEditor, setRowEditor] = useState<{ mode: 'add' | 'edit'; row: DatasetCase } | null>(null);
  const [fieldEditorOpen, setFieldEditorOpen] = useState(false);
  const [fieldDraft, setFieldDraft] = useState<{ label: string; type: DatasetFieldType }>({
    label: '',
    type: 'text',
  });
  const [fieldError, setFieldError] = useState('');
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchImportMethod, setBatchImportMethod] = useState<'paste' | 'file'>('paste');
  const [batchPasteText, setBatchPasteText] = useState('');
  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [batchModalError, setBatchModalError] = useState('');
  const [batchDropActive, setBatchDropActive] = useState(false);
  const batchFileInputRef = useRef<HTMLInputElement>(null);
  const [faultModeOptions, setFaultModeOptions] = useState<Array<{
    id: string;
    name: string;
    injectionMethodLabel?: string;
    parameters?: Array<{ key: string; label: string }>;
  }>>([]);

  const faultModeById = useMemo(() => {
    const map = new Map<string, {
      id: string;
      name: string;
      injectionMethodLabel?: string;
      parameters?: Array<{ key: string; label: string }>;
    }>();
    for (const option of faultModeOptions) map.set(option.id, option);
    return map;
  }, [faultModeOptions]);

  const formatFaultInjectionType = useCallback((row: DatasetCase, raw: string): string => {
    const id = raw.trim();
    const fromApi = id ? faultModeById.get(id) : undefined;
    const submodeId = String(row.values?.submode || '').trim();
    const apiSubmodeLabel = submodeId
      ? (fromApi?.parameters || []).find((p) => p.key === submodeId)?.label
      : undefined;
    return formatReliabilityFaultTypeFromCaseValues(row.values, {
      faultId: id,
      apiFaultName: fromApi?.name,
      apiInjectionMethodLabel: fromApi?.injectionMethodLabel,
      apiSubmodeLabel,
    });
  }, [faultModeById]);

  const load = useCallback(async () => {
    if (!user || !id) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/agent-datasets/${id}?user=${encodeURIComponent(user)}&view=items`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || '加载失败');
      }
      const d = data as AgentDataset & { user?: string };
      setDataset({
        id: d.id,
        name: d.name,
        description: d.description || '',
        targetAgent: d.targetAgent || '',
        targetSkill: d.targetSkill || '',
        tags: d.tags || [],
        datasetKind: coerceDatasetKind(d.datasetKind),
        fields: Array.isArray(d.fields) ? d.fields : [],
        cases: Array.isArray(d.cases) ? d.cases : [],
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });
      fullDatasetRef.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
      setDataset(null);
    } finally {
      setLoading(false);
    }
  }, [user, id]);

  useEffect(() => {
    if (!dataset || dataset.datasetKind !== 'reliability') {
      setFaultModeOptions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/reliability/fault-modes');
        const data = await res.json();
        if (!res.ok || cancelled) return;
        const items = Array.isArray(data?.items) ? data.items : [];
        setFaultModeOptions(
          items
            .map((item: {
              id?: string;
              name?: string;
              injectionMethodLabel?: string;
              injection_method_label?: string;
              parameters?: Array<{ key?: string; label?: string }>;
            }) => ({
              id: String(item?.id || '').trim(),
              name: String(item?.name || item?.id || '').trim(),
              injectionMethodLabel: String(
                item?.injectionMethodLabel || item?.injection_method_label || '',
              ).trim() || undefined,
              parameters: Array.isArray(item?.parameters)
                ? item.parameters
                  .map((p) => ({
                    key: String(p?.key || '').trim(),
                    label: String(p?.label || p?.key || '').trim(),
                  }))
                  .filter((p) => p.key)
                : undefined,
            }))
            .filter((item: { id: string }) => item.id),
        );
      } catch {
        if (!cancelled) setFaultModeOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  const loadFullDataset = async (): Promise<AgentDataset> => {
    if (!user || !id) throw new Error('缺少数据集信息');
    if (fullDatasetRef.current) return fullDatasetRef.current;
    const res = await apiFetch(`/api/agent-datasets/${id}?user=${encodeURIComponent(user)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || '完整数据加载失败');
    const full = data as AgentDataset;
    fullDatasetRef.current = full;
    return full;
  };

  const loadFullCase = async (caseId: string): Promise<DatasetCase> => {
    if (!user || !id) throw new Error('缺少数据集信息');
    const res = await apiFetch(
      `/api/agent-datasets/${id}?user=${encodeURIComponent(user)}&view=case&caseId=${encodeURIComponent(caseId)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || '完整数据项加载失败');
    return data as DatasetCase;
  };

  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);

  // ?case=<id> 处理: dataset 加载完后滚到目标行 + 短暂高亮 (1.8s)
  useEffect(() => {
    if (!highlightCaseId || !dataset || dataset.cases.length === 0) return;
    const exists = dataset.cases.some(c => c.id === highlightCaseId);
    if (!exists) return;
    // 用 rAF 让 DOM 渲染完再 query, 避免拿不到 node
    const tid = setTimeout(() => {
      const el = document.getElementById(`case-${highlightCaseId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightActive(true);
        setTimeout(() => setHighlightActive(false), 1800);
      }
    }, 100);
    return () => clearTimeout(tid);
  }, [highlightCaseId, dataset]);

  const persistCases = async (cases: DatasetCase[]): Promise<boolean> => {
    if (!user || !dataset) return false;
    setSaving(true);
    setError('');
    try {
      const payload = {
        user,
        id: dataset.id,
        fields: withEvaluatorCatalogFields(dataset.fields, cases),
        cases: cases.map(item => ({
          id: item.id,
          input: fieldText(item, 'input').trim(),
          expectedOutput: fieldText(item, 'reference_output').trim(),
          evaluationFocus: item.evaluationFocus?.trim() || '',
          tags: item.tags || [],
          trajectory: dataset.datasetKind === 'trajectory'
            ? (dataset.fields.some(field => field.key === 'trace') ? fieldText(item, 'trace') : fieldText(item, 'trajectory')).trim()
            : '',
          values: Object.fromEntries(
            Object.entries(item.values || {}).map(([key, value]) => [
              key,
              typeof value === 'string' ? value.trim() : value,
            ]),
          ),
          source: item.source,
          traceSource: item.traceSource,
        })),
      };
      const res = await apiFetch('/api/agent-datasets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok || !result?.success) {
        throw new Error(result?.error || '保存失败');
      }
      await load();
      setRowEditor(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const openAdd = () => {
    setRowEditor({ mode: 'add', row: createEmptyCase() });
  };

  const openEdit = async (row: DatasetCase) => {
    setSaving(true);
    setError('');
    try {
      const fullRow = await loadFullCase(row.id);
      setRowEditor({ mode: 'edit', row: { ...fullRow, values: { ...(fullRow.values || {}) } } });
    } catch (e) {
      setError(e instanceof Error ? e.message : '完整数据加载失败');
    } finally {
      setSaving(false);
    }
  };

  const persistFields = async (fields: DatasetField[]) => {
    if (!user || !dataset) return false;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/agent-datasets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, id: dataset.id, fields }),
      });
      const result = await res.json();
      if (!res.ok || !result?.success) throw new Error(result?.error || '字段保存失败');
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '字段保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addField = async () => {
    if (!dataset) return;
    const label = fieldDraft.label.trim();
    if (!label) {
      setFieldError('请输入字段名称');
      return;
    }
    if (dataset.fields.some(field => field.label.trim().toLocaleLowerCase() === label.toLocaleLowerCase())) {
      setFieldError('字段名称已存在');
      return;
    }
    const catalogKey = evaluatorCatalogFieldKeyFromLabel(label);
    if (catalogKey && dataset.fields.some(field => field.key === catalogKey)) {
      setFieldError(`${catalogKey} 已存在`);
      return;
    }
    const key = catalogKey ?? nextDatasetFieldKey(dataset.fields.map(field => field.key));
    const ok = await persistFields([
      ...dataset.fields,
      catalogKey
        ? createEvaluatorCatalogField(catalogKey, label)
        : { id: crypto.randomUUID(), key, label, type: fieldDraft.type },
    ]);
    if (ok) {
      setFieldEditorOpen(false);
      setFieldDraft({ label: '', type: 'text' });
      setFieldError('');
    }
  };

  const setEditorFieldValue = (field: DatasetField, value: unknown) => {
    if (!rowEditor) return;
    const values = { ...(rowEditor.row.values || {}), [field.key]: value };
    setRowEditor({ ...rowEditor, row: { ...rowEditor.row, values } });
  };

  const removeRow = async (rowId: string) => {
    if (!dataset) return;
    try {
      const full = await loadFullDataset();
      await persistCases(full.cases.filter(c => c.id !== rowId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '完整数据加载失败');
    }
  };

  const saveRowFromModal = async () => {
    if (!rowEditor || !dataset) return;
    const { mode } = rowEditor;
    const values = { ...(rowEditor.row.values || {}) };
    for (const field of dataset.fields) {
      const value = values[field.key];
      if (field.type === 'number') {
        try {
          values[field.key] = parseDatasetNumberValue(value);
        } catch {
          toast.error(`${field.label} 不是有效的数字`);
          return;
        }
        continue;
      }
      if (field.type !== 'json' || typeof value !== 'string' || !value.trim()) continue;
      try {
        values[field.key] = JSON.parse(value);
      } catch {
        toast.error(`${field.label} 不是有效的 JSON`);
        return;
      }
    }
    const row = { ...rowEditor.row, values };
    let full: AgentDataset;
    try {
      full = await loadFullDataset();
    } catch (e) {
      setError(e instanceof Error ? e.message : '完整数据加载失败');
      return;
    }
    const next =
      mode === 'add'
        ? [...full.cases, row]
        : full.cases.map(c => (c.id === row.id ? row : c));
    await persistCases(next);
  };

  const closeBatchModal = () => {
    setBatchModalOpen(false);
    setBatchModalError('');
    setBatchPasteText('');
    setBatchFile(null);
    setBatchImportMethod('paste');
    setBatchDropActive(false);
    if (batchFileInputRef.current) batchFileInputRef.current.value = '';
  };

  const runBatchImport = async () => {
    if (!dataset || !user) return;
    setBatchModalError('');
    try {
      let text = '';
      if (batchImportMethod === 'paste') {
        text = batchPasteText;
        if (!text.trim()) {
          setBatchModalError('请先粘贴 JSON 或 CSV 内容');
          return;
        }
        const result = parseBatchAuto(text, dataset.datasetKind);
        if (result.cases.length === 0) {
          setBatchModalError(result.message || '未能解析出有效数据');
          return;
        }
        const full = await loadFullDataset();
        const merged = [...full.cases, ...result.cases];
        const ok = await persistCases(merged);
        if (!ok) {
          setBatchModalError('保存失败，请查看上方错误提示');
          return;
        }
        closeBatchModal();
        return;
      }

      if (!batchFile) {
        setBatchModalError('请选择要上传的文件');
        return;
      }
      text = await readFileAsText(batchFile);
      const result = parseBatchFromFileContent(text, batchFile.name, dataset.datasetKind);
      if (result.cases.length === 0) {
        setBatchModalError(result.message || '未能解析出有效数据');
        return;
      }
      const full = await loadFullDataset();
      const merged = [...full.cases, ...result.cases];
      const ok = await persistCases(merged);
      if (!ok) {
        setBatchModalError('保存失败，请查看上方错误提示');
        return;
      }
      // 一次导入记 1 次，不按样本数重复；与编辑样本共用 PATCH 接口，
      // 服务端无从区分，因此在这个只有导入会走到的分支上报。
      reportClientUsage('dataset', 'dataset.import');
      closeBatchModal();
    } catch (e) {
      setBatchModalError(e instanceof Error ? e.message : '导入失败');
    }
  };

  if (!user) {
    return <div className="loading">请先登录</div>;
  }

  if (loading) {
    return <div className="loading">加载数据项...</div>;
  }

  if (error && !dataset) {
    return (
      <div style={{ padding: 22 }}>
        <p style={{ color: 'var(--error)' }}>{error}</p>
        <Link href="/dataset" className="ai-btn-s" style={{ display: 'inline-block', marginTop: 12 }}>
          返回评测集列表
        </Link>
      </div>
    );
  }

  if (!dataset) return null;

  const isTraj = dataset.datasetKind === 'trajectory';
  const isReliability = dataset.datasetKind === 'reliability';
  const catalogDraftKey = evaluatorCatalogFieldKeyFromLabel(fieldDraft.label);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{
          padding: '14px 22px 10px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--background)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <button type="button" className="ai-btn-s" onClick={() => router.push('/dataset')}>
            ← 返回
          </button>
          <span style={{ color: 'var(--foreground-muted)' }}>/</span>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--foreground)' }}>{dataset.name}</h1>
          {isDatasetPublished(dataset) ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 10px',
                borderRadius: 999,
                background: 'rgba(34, 197, 94, 0.14)',
                color: '#15803d',
              }}
            >
              已发布
            </span>
          ) : (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 10px',
                borderRadius: 999,
                background: 'rgba(245, 158, 11, 0.18)',
                color: '#c2410c',
              }}
            >
              迭代中
            </span>
          )}
          <span className="ai-badge ai-badge-gr">
            {isTraj ? '轨迹评测集' : isReliability ? '可靠性评测集' : '理想输出评测集'}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>
          更新于 {formatDateFull(dataset.updatedAt)} · 共 {dataset.cases.length} 条数据项
        </div>
      </div>

      <div style={{ padding: '12px 22px', flex: 1, overflow: 'auto' }}>
        {error && (
          <div
            style={{
              border: '1px solid var(--error-subtle-border)',
              background: 'var(--error-subtle)',
              color: 'var(--error)',
              padding: 10,
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        <div className={styles.tableShell}>
          <div className={styles.tableToolbar}>
            <div className={styles.toolbarLeft}>
              <span className={styles.sectionTitle}>数据项</span>
              <span className={styles.toolbarMeta}>{dataset.cases.length} 条</span>
            </div>
            <div className={styles.toolbarRight}>
              <button
                type="button"
                className={styles.refreshGhost}
                onClick={() => setFieldEditorOpen(true)}
                disabled={saving}
              >
                <Plus size={15} aria-hidden />
                新增字段
              </button>
              <button type="button" className={styles.refreshGhost} onClick={() => void load()} disabled={saving}>
                <IconRefresh />
                刷新
              </button>
              <div className={styles.addSplit} role="group" aria-label="添加数据">
                <button
                  type="button"
                  className={styles.addSplitSecondary}
                  disabled={saving}
                  onClick={() => {
                    setBatchModalError('');
                    setBatchModalOpen(true);
                  }}
                >
                  <IconUploadTray />
                  批量导入
                </button>
                <button type="button" className={styles.addSplitPrimary} onClick={openAdd} disabled={saving}>
                  <IconPlusSm />
                  单个添加
                </button>
              </div>
            </div>
          </div>

          <div className={styles.tableScroll}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>ID</th>
                  {dataset.fields.map(field => <th key={field.id}>{field.label}</th>)}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {dataset.cases.length === 0 ? (
                  <tr>
                    <td colSpan={dataset.fields.length + 2} style={{ padding: 36, textAlign: 'center', color: 'var(--foreground-muted)' }}>
                      暂无数据，使用右侧「批量导入」或「单个添加」录入。
                    </td>
                  </tr>
                ) : (
                  dataset.cases.map(row => {
                    const isHighlighted = highlightActive && row.id === highlightCaseId;
                    return (
                    <tr
                      key={row.id}
                      id={`case-${row.id}`}
                      data-case-row={row.id}
                      style={isHighlighted ? {
                        background: 'rgba(37,99,235,0.12)',
                        transition: 'background 0.4s ease',
                      } : { transition: 'background 0.4s ease' }}
                    >
                      <td title={row.id}>
                        <span className={styles.idTag}>{shorten(row.id, 10)}</span>
                      </td>
                      {dataset.fields.map(field => {
                        const fullText = fieldText(row, field.key);
                        const displayText = field.key === 'fault_injection_type' && isReliability
                          ? formatFaultInjectionType(row, fullText)
                          : fullText;
                        const isTrajectoryField = ['trace', 'trajectory'].includes(field.key.trim().toLocaleLowerCase());
                        return (
                        <TooltipCell
                          key={field.id}
                          shortText={shorten(displayText, field.type === 'json' ? 40 : 80)}
                          fullText={displayText}
                          tdStyle={{
                            maxWidth: field.type === 'json' ? 220 : 260,
                            ...(field.type === 'json' ? { fontFamily: 'ui-monospace, monospace', fontSize: 12 } : {}),
                            ...(isTrajectoryField ? { cursor: 'pointer', color: 'var(--primary)' } : {}),
                          }}
                          onClick={isTrajectoryField ? () => void openEdit(row) : undefined}
                        />
                        );
                      })}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className={styles.linkBtn} onClick={() => void openEdit(row)} disabled={saving}>
                          编辑
                        </button>
                        <button type="button" className={styles.linkBtnDanger} onClick={() => void removeRow(row.id)}>
                          删除
                        </button>
                      </td>
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {batchModalOpen && (
        <div
          role="presentation"
          className={styles.modalBackdrop}
          onClick={() => !saving && closeBatchModal()}
        >
          <div
            role="dialog"
            aria-modal
            aria-labelledby="batch-import-title"
            className={styles.modalPanel}
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div className={styles.modalTitleWrap}>
                <div id="batch-import-title" className={styles.modalTitle}>
                  批量导入测试用例
                </div>
                <p className={styles.modalSubtitle}>JSON 数组或 CSV，一键合并进当前数据集</p>
              </div>
              <button
                type="button"
                className={styles.modalClose}
                aria-label="关闭"
                disabled={saving}
                onClick={() => closeBatchModal()}
              >
                ×
              </button>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.segmented} role="tablist" aria-label="导入方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={batchImportMethod === 'paste'}
                  className={`${styles.segmentedBtn} ${batchImportMethod === 'paste' ? styles.segmentedBtnActive : ''}`}
                  disabled={saving}
                  onClick={() => {
                    setBatchImportMethod('paste');
                    setBatchModalError('');
                  }}
                >
                  JSON / CSV 文本
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={batchImportMethod === 'file'}
                  className={`${styles.segmentedBtn} ${batchImportMethod === 'file' ? styles.segmentedBtnActive : ''}`}
                  disabled={saving}
                  onClick={() => {
                    setBatchImportMethod('file');
                    setBatchModalError('');
                  }}
                >
                  文件上传
                </button>
              </div>

              {batchImportMethod === 'paste' ? (
                <textarea
                  className={styles.batchTextarea}
                  value={batchPasteText}
                  onChange={e => setBatchPasteText(e.target.value)}
                  placeholder={BATCH_JSON_PLACEHOLDER}
                  spellCheck={false}
                  disabled={saving}
                />
              ) : (
                <div>
                  <input
                    ref={batchFileInputRef}
                    type="file"
                    accept=".json,.csv,.txt,text/csv,application/json"
                    disabled={saving}
                    style={{ display: 'none' }}
                    onChange={e => setBatchFile(e.target.files?.[0] ?? null)}
                  />
                  <div
                    role="button"
                    tabIndex={0}
                    className={`${styles.dropZone} ${batchDropActive ? styles.dropZoneActive : ''} ${saving ? styles.dropZoneDisabled : ''}`}
                    onClick={() => !saving && batchFileInputRef.current?.click()}
                    onKeyDown={e => {
                      if (!saving && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        batchFileInputRef.current?.click();
                      }
                    }}
                    onDragEnter={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!saving) setBatchDropActive(true);
                    }}
                    onDragOver={e => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDragLeave={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setBatchDropActive(false);
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setBatchDropActive(false);
                      if (saving) return;
                      const f = e.dataTransfer.files?.[0];
                      if (f) setBatchFile(f);
                    }}
                  >
                    <div className={styles.dropZoneIcon} aria-hidden>
                      <IconUploadTray size={22} />
                    </div>
                    <p className={styles.dropZoneTitle}>点击选择或拖拽文件到此处</p>
                    <p className={styles.dropZoneHint}>支持 .json、.csv、.txt · 单行表头可选</p>
                    {batchFile ? <div className={styles.dropZoneFileName}>{batchFile.name}</div> : null}
                  </div>
                </div>
              )}

              <div className={styles.hintCard}>
                自动识别字段：<strong>input</strong> 与 <strong>expected_output</strong>（兼容 <strong>output</strong>、
                reference_output 等）。内容以 <strong>[</strong> 开头按 JSON，否则按 CSV。轨迹集可含{' '}
                <strong>trajectory</strong> 或 CSV 第三列。JSON 中的 <strong>available_tools</strong> 与{' '}
                <strong>available_skills</strong> 会自动新增为目录字段。
              </div>

              {batchModalError ? <div className={styles.modalError}>{batchModalError}</div> : null}
            </div>

            <div className={styles.modalFooter}>
              <button type="button" className={styles.btnGhost} disabled={saving} onClick={() => closeBatchModal()}>
                取消
              </button>
              <button type="button" className={styles.btnPrimary} disabled={saving} onClick={() => void runBatchImport()}>
                {saving ? '导入中…' : '开始导入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {fieldEditorOpen && (
        <div role="presentation" className={styles.modalBackdrop} onClick={() => !saving && setFieldEditorOpen(false)}>
          <div role="dialog" aria-modal aria-labelledby="add-field-title" className={styles.modalPanel} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div id="add-field-title" className={styles.modalTitle}>新增字段</div>
            </div>
            <div className={styles.modalBody} style={{ display: 'grid', gap: 14 }}>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>字段名称</span>
                <Input
                  value={fieldDraft.label}
                  onChange={e => {
                    const label = e.target.value;
                    setFieldDraft({
                      label,
                      type: evaluatorCatalogFieldKeyFromLabel(label) ? 'json' : fieldDraft.type,
                    });
                  }}
                  placeholder="如 available_tools 或 可用 Tool"
                />
              </label>
              <div style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>字段类型</span>
                <Select
                  value={catalogDraftKey ? 'json' : fieldDraft.type}
                  onChange={type => {
                    if (!catalogDraftKey) setFieldDraft({ ...fieldDraft, type });
                  }}
                  options={[
                    { value: 'text', label: '文本' },
                    { value: 'number', label: '数字' },
                    { value: 'boolean', label: '布尔值' },
                    { value: 'json', label: 'JSON' },
                  ]}
                  size="md"
                  className="w-full justify-between"
                  contentClassName="z-[1200]"
                  aria-label="字段类型"
                />
              </div>
              {catalogDraftKey && (
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--foreground-secondary)' }}>
                  将识别为 <code>{catalogDraftKey}</code>，并固定使用 JSON 类型，供工具类评估器读取。
                </div>
              )}
              {fieldError && <div className={styles.modalError}>{fieldError}</div>}
            </div>
            <div className={styles.modalFooter}>
              <button type="button" className={styles.btnGhost} onClick={() => setFieldEditorOpen(false)} disabled={saving}>取消</button>
              <button type="button" className={styles.btnPrimary} onClick={() => void addField()} disabled={saving}>{saving ? '保存中…' : '新增'}</button>
            </div>
          </div>
        </div>
      )}

      {rowEditor && (
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
          onClick={() => setRowEditor(null)}
        >
          <div className="ai-card" style={{ width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>{rowEditor.mode === 'add' ? '添加数据' : '编辑数据'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {dataset.fields.map(field => (
                <label key={field.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>{field.label} · {field.key}</span>
                  {field.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(fieldValue(rowEditor.row, field.key))}
                      onChange={e => setEditorFieldValue(field, e.target.checked)}
                      style={{ width: 18, height: 18 }}
                    />
                  ) : field.key === 'fault_injection_type' && isReliability ? (
                    <Select
                      value={fieldText(rowEditor.row, field.key)}
                      onChange={value => setEditorFieldValue(field, value)}
                      options={[
                        { value: '', label: '选择故障模式…' },
                        ...faultModeOptions.map(option => ({
                          value: option.id,
                          label: option.injectionMethodLabel
                            ? `${option.name} · ${option.injectionMethodLabel}`
                            : option.name,
                        })),
                      ]}
                      aria-label="故障注入类型"
                    />
                  ) : (
                    <textarea
                      value={fieldText(rowEditor.row, field.key)}
                      onChange={e => setEditorFieldValue(field, e.target.value)}
                      rows={field.type === 'json' ? 6 : 3}
                      spellCheck={field.type !== 'json'}
                      placeholder={field.key === 'trajectory' ? TRAJECTORY_PLACEHOLDER : undefined}
                      style={{
                        fontFamily: field.type === 'json' ? 'ui-monospace, monospace' : undefined,
                        borderRadius: 7,
                        border: '1px solid var(--input-border)',
                        padding: 8,
                        fontSize: field.type === 'json' ? 12 : 14,
                      }}
                    />
                  )}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" className="ai-btn-s" onClick={() => setRowEditor(null)}>
                取消
              </button>
              <button type="button" className="ai-btn-p" onClick={() => void saveRowFromModal()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
