'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/client/api';
import {
  type AgentDataset,
  type DatasetCase,
  createEmptyCase,
  TRAJECTORY_PLACEHOLDER,
} from '@/lib/agent-dataset-model';
import {
  parseBatchAuto,
  parseBatchFromFileContent,
  readFileAsText,
} from '@/lib/dataset-batch-import';
import { useAuth } from '@/lib/auth/auth-context';
import styles from '@/components/DatasetItemsPage.module.css';

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
}: {
  shortText: string;
  fullText: string;
  tdStyle?: React.CSSProperties;
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
  {"input": "问题2", "output": "答案2"}
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

export default function DatasetItemsPage() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { user } = useAuth();

  const [dataset, setDataset] = useState<AgentDataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // ?case=<caseId> 入参支持: 别处(如 grayscale 执行记录 modal 的 Case ID 链接)
  // 跳过来时滚动到对应行并短暂高亮, 让用户一眼定位。
  const searchParams = useSearchParams();
  const highlightCaseId = searchParams?.get('case') || '';
  const [highlightActive, setHighlightActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowEditor, setRowEditor] = useState<{ mode: 'add' | 'edit'; row: DatasetCase } | null>(null);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchImportMethod, setBatchImportMethod] = useState<'paste' | 'file'>('paste');
  const [batchPasteText, setBatchPasteText] = useState('');
  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [batchModalError, setBatchModalError] = useState('');
  const [batchDropActive, setBatchDropActive] = useState(false);
  const batchFileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!user || !id) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/agent-datasets/${id}?user=${encodeURIComponent(user)}`);
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
        datasetKind: d.datasetKind === 'trajectory' ? 'trajectory' : 'ideal_output',
        cases: Array.isArray(d.cases) ? d.cases : [],
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
      setDataset(null);
    } finally {
      setLoading(false);
    }
  }, [user, id]);

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
        cases: cases.map(item => ({
          id: item.id,
          input: item.input.trim(),
          expectedOutput: item.expectedOutput.trim(),
          evaluationFocus: item.evaluationFocus?.trim() || '',
          tags: item.tags || [],
          trajectory: dataset.datasetKind === 'trajectory' ? item.trajectory.trim() : '',
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

  const openEdit = (row: DatasetCase) => {
    setRowEditor({ mode: 'edit', row: { ...row } });
  };

  const removeRow = async (rowId: string) => {
    if (!dataset) return;
    const next = dataset.cases.filter(c => c.id !== rowId);
    await persistCases(next);
  };

  const saveRowFromModal = async () => {
    if (!rowEditor || !dataset) return;
    const { mode, row } = rowEditor;
    const next =
      mode === 'add'
        ? [...dataset.cases, row]
        : dataset.cases.map(c => (c.id === row.id ? row : c));
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
        const merged = [...dataset.cases, ...result.cases];
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
      const merged = [...dataset.cases, ...result.cases];
      const ok = await persistCases(merged);
      if (!ok) {
        setBatchModalError('保存失败，请查看上方错误提示');
        return;
      }
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
            {isTraj ? '轨迹评测集' : '理想输出评测集'}
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
                  {['ID', '输入', '预期输出', ...(isTraj ? ['轨迹 trajectory'] : []), '操作'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataset.cases.length === 0 ? (
                  <tr>
                    <td colSpan={isTraj ? 5 : 4} style={{ padding: 36, textAlign: 'center', color: 'var(--foreground-muted)' }}>
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
                      <TooltipCell
                        shortText={shorten(row.input, 80)}
                        fullText={row.input}
                        tdStyle={{ maxWidth: 260 }}
                      />
                      <TooltipCell
                        shortText={shorten(row.expectedOutput, 80)}
                        fullText={row.expectedOutput}
                        tdStyle={{ maxWidth: 260 }}
                      />
                      {isTraj && (
                        <TooltipCell
                          shortText={shorten(row.trajectory, 40)}
                          fullText={row.trajectory}
                          tdStyle={{ maxWidth: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                        />
                      )}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className={styles.linkBtn} onClick={() => openEdit(row)}>
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
                <strong>trajectory</strong> 或 CSV 第三列。
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
          <div className="ai-card" style={{ width: '100%', maxWidth: 560, padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>{rowEditor.mode === 'add' ? '添加数据' : '编辑数据'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>input</span>
                <textarea
                  value={rowEditor.row.input}
                  onChange={e => setRowEditor({ ...rowEditor, row: { ...rowEditor.row, input: e.target.value } })}
                  rows={3}
                  style={{ borderRadius: 7, border: '1px solid var(--input-border)', padding: 8, fontSize: 14, width: '100%', boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>reference_output</span>
                <textarea
                  value={rowEditor.row.expectedOutput}
                  onChange={e =>
                    setRowEditor({ ...rowEditor, row: { ...rowEditor.row, expectedOutput: e.target.value } })
                  }
                  rows={4}
                  style={{ borderRadius: 7, border: '1px solid var(--input-border)', padding: 8, fontSize: 14, width: '100%', boxSizing: 'border-box' }}
                />
              </label>
              {isTraj && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>trajectory（可留空）</span>
                  <textarea
                    value={rowEditor.row.trajectory}
                    onChange={e =>
                      setRowEditor({ ...rowEditor, row: { ...rowEditor.row, trajectory: e.target.value } })
                    }
                    rows={6}
                    spellCheck={false}
                    placeholder={TRAJECTORY_PLACEHOLDER}
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      borderRadius: 7,
                      border: '1px solid var(--input-border)',
                      padding: 8,
                      fontSize: 12,
                    }}
                  />
                </label>
              )}
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
