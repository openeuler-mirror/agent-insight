'use client';

// 新建实验 —— 四步向导（单组形态）：
// ① 实验设计 → ② 关联 Trace（圈选 case）→ ③ 预期答案（可选标注）→ ④ 评估器（硬门控）
// 对照仓库根目录「评测实验-高保真.html」的单组流程。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Search, X } from 'lucide-react';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch, getApiUrl } from '@/lib/client/api';
import { matchDatasetCases, describeMatchResult, toDatasetCases } from '@/lib/engine/experiment/dataset-match';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { deriveEvaluatorTags, gateEvaluator, getEvaluatorMeta } from '@/lib/evaluators/registry';
import type { EvaluatorCaseContext } from '@/lib/evaluators/evaluator-case-context';
import { formatReliabilityFaultTypeFromCaseValues } from '@/lib/reliability/fault-type-display';

interface AgentOption { name: string; traces: number }
interface PlatformOption { id: string; label: string }

function defaultExperimentName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `可靠性评测 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

interface TraceItem {
  id: string;
  taskId: string | null;
  query: string | null;
  finalResult: string | null;
  latency: number | null;
  tokens: number | null;
  timestamp: string;
  ok: boolean;
}

interface TraceTagOption {
  id: string;
  name: string;
  kind: 'version' | 'business';
  color: string;
  usageCount: number;
}

interface SelectedCase {
  executionId: string;
  taskId: string | null;
  input: string;
  actualOutput: string;
  referenceOutput: string | null;
  evaluatorContext: EvaluatorCaseContext | null;
  faultInjectionType?: string | null;
  values?: Record<string, unknown>;
}

interface DatasetOption {
  id: string;
  name: string;
  datasetKind?: string;
  targetAgent?: string;
  caseCount?: number;
  cases?: Array<{
    id?: string;
    input?: string;
    expectedOutput?: string;
    values?: Record<string, unknown>;
  }>;
}

const STEPS = ['实验设计', '关联 Trace', '预期答案', '评估器'];
const NEXT_LABELS = ['下一步：关联 Trace →', '下一步：预期答案 →', '下一步：评估器 →', '🚀 开始实验'];
const PAGE_SIZE = 10;
/** 跨页全选安全上限：避免一次圈选过多 case 拖垮后续评测 */
const SELECT_ALL_CAP = 500;
const MAX_TRACE_TAG_FILTERS = 20;
const TIME_PRESETS = [
  { value: '30m', label: '过去 30 分钟', ms: 30 * 60 * 1000 },
  { value: '1h', label: '过去 1 小时', ms: 60 * 60 * 1000 },
  { value: '6h', label: '过去 6 小时', ms: 6 * 60 * 60 * 1000 },
  { value: '1d', label: '过去 1 天', ms: 24 * 60 * 60 * 1000 },
  { value: '3d', label: '过去 3 天', ms: 3 * 24 * 60 * 60 * 1000 },
  { value: '7d', label: '过去 7 天', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '14d', label: '过去 14 天', ms: 14 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '过去 30 天', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '过去 90 天', ms: 90 * 24 * 60 * 60 * 1000 },
] as const;
type TimePreset = typeof TIME_PRESETS[number]['value'] | 'all' | 'custom';

// ── 高保真样式常量（对照 评测实验-高保真.html） ──
const PANEL: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--card-border)',
  borderRadius: 12, marginBottom: 14, overflow: 'hidden',
};
const PANEL_H: React.CSSProperties = {
  padding: '11px 16px', borderBottom: '1px solid var(--border)',
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
};
const PANEL_B: React.CSSProperties = { padding: '13px 15px' };
const FIELDLBL: React.CSSProperties = {
  display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--foreground-muted)',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 7,
};
const INPUT: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', fontSize: 13, borderRadius: 8,
  border: '1px solid var(--input-border)', background: 'var(--input-bg)',
  color: 'var(--foreground)', outline: 'none',
};
const TH: React.CSSProperties = {
  textAlign: 'left', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: '0.045em', color: 'var(--foreground-muted)', padding: '9px 12px',
  borderBottom: '1px solid var(--border)', background: 'var(--background-secondary)', whiteSpace: 'nowrap',
};
const STICKY_TH: React.CSSProperties = {
  ...TH, position: 'sticky', top: 0, zIndex: 1,
};
const TD: React.CSSProperties = {
  padding: '9px 12px', fontSize: 12.5, color: 'var(--foreground-secondary)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'middle',
};
const BTN: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  height: 30, padding: '0 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
  cursor: 'pointer', border: '1px solid transparent', whiteSpace: 'nowrap',
};
const BTN_PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--primary)', color: '#fff' };
const MODAL_OV: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 220,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
};
const MODAL: React.CSSProperties = {
  width: 560, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto',
  background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 14,
  padding: '18px 20px', boxShadow: '0 24px 80px rgba(0,0,0,.35)',
};
const BTN_GHOST: React.CSSProperties = {
  ...BTN, background: 'none', color: 'var(--foreground-secondary)', border: 'none',
};
const BTN_OUTLINE_SM: React.CSSProperties = {
  ...BTN, height: 26, padding: '0 9px', fontSize: 11.5,
  background: 'var(--card-bg)', color: 'var(--foreground)', border: '1px solid var(--border-dark)',
};
const CHIP: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 8px',
  borderRadius: 6, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
};
const CHIP_MUT: React.CSSProperties = {
  ...CHIP, background: 'var(--background-secondary)', color: 'var(--foreground-secondary)',
};
const PAGER_BTN: React.CSSProperties = {
  minWidth: 24, height: 24, padding: '0 7px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--card-bg)',
  color: 'var(--foreground-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
};
const FCHIP: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px',
  borderRadius: 20, fontSize: 11.5, fontWeight: 600,
  border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground-secondary)',
};

function truncate(text: string | null | undefined, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function toLocalDateTimeInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = new Set([1, total, current - 1, current, current + 1]);
  const nums = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
}

function CheckMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} style={{ width: size, height: size }}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function Stepper({ step, maxVisited, summaries, onJump }: {
  step: number;
  maxVisited: number;
  summaries: string[];
  onJump: (s: number) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      background: 'var(--card-bg)', border: '1px solid var(--card-border)',
      borderRadius: 12, padding: '9px 14px', marginBottom: 16,
    }}>
      {STEPS.map((label, i) => {
        const idx = i + 1;
        const active = idx === step;
        const done = idx < step;
        const reachable = idx <= maxVisited;
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <button
              onClick={() => reachable && onJump(idx)}
              disabled={!reachable}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
                padding: '4px 8px', borderRadius: 8, border: 'none', textAlign: 'left',
                background: active ? 'var(--primary-subtle)' : 'none',
                cursor: reachable ? 'pointer' : 'default',
              }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                display: 'inline-grid', placeItems: 'center', fontSize: 11, fontWeight: 800,
                background: active ? 'var(--primary)' : done ? 'transparent' : 'var(--background-secondary)',
                border: done ? '1.5px solid var(--primary)' : '1.5px solid transparent',
                color: active ? '#fff' : done ? 'var(--primary)' : 'var(--foreground-muted)',
              }}>
                {done ? <CheckMark size={11} /> : idx}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                <span style={{
                  fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
                  color: active ? 'var(--primary)' : reachable ? 'var(--foreground)' : 'var(--foreground-muted)',
                }}>
                  {label}
                  {idx === 3 && (
                    <span style={{
                      fontSize: 8.5, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                      background: 'var(--background-secondary)', color: 'var(--foreground-muted)',
                      marginLeft: 4, verticalAlign: 1,
                    }}>
                      可选
                    </span>
                  )}
                </span>
                <span style={{
                  fontSize: 10, color: 'var(--foreground-muted)', whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
                }}>
                  {summaries[i]}
                </span>
              </span>
            </button>
            {idx < STEPS.length && (
              <span style={{ width: 20, height: 1, flexShrink: 0, background: 'var(--border-dark)' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function NewExperimentPage() {
  const router = useRouter();
  const { user } = useAuth();

  const [step, setStep] = useState(1);
  const [maxVisited, setMaxVisited] = useState(1);

  // ① 实验设计
  const [name, setName] = useState(() => defaultExperimentName());
  const [agentName, setAgentName] = useState('');
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [wizardDatasets, setWizardDatasets] = useState<DatasetOption[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [genPlatform, setGenPlatform] = useState('opencode');
  const [genModel, setGenModel] = useState('');
  const [fiPlatforms, setFiPlatforms] = useState<PlatformOption[]>([]);
  const [fiAgents, setFiAgents] = useState<PlatformOption[]>([]);
  const [fiModels, setFiModels] = useState<PlatformOption[]>([]);
  const [fiInventoryHint, setFiInventoryHint] = useState('');
  const [reliabilityCases, setReliabilityCases] = useState<SelectedCase[]>([]);
  const [workerStatus, setWorkerStatus] = useState<'checking' | 'ok' | 'missing'>('checking');
  const workerOk = workerStatus === 'ok';
  const [fiSetupCmd, setFiSetupCmd] = useState('');
  const [fiSetupCopied, setFiSetupCopied] = useState(false);
  const [faultModeLabels, setFaultModeLabels] = useState<Map<string, string>>(() => new Map());

  // ② 关联 Trace
  // 监听模式：开启后本实验绑定该 Agent，其新上报的 trace 自动进来评测（圈选已有 trace 变可选）
  const [watchMode, setWatchMode] = useState(false);
  const [traces, setTraces] = useState<TraceItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [tracesLoading, setTracesLoading] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [selected, setSelected] = useState<Map<string, SelectedCase>>(new Map());
  const [traceSearchDraft, setTraceSearchDraft] = useState('');
  const [traceSearch, setTraceSearch] = useState('');
  const [timePreset, setTimePreset] = useState<TimePreset>('7d');
  const [timePresetAppliedAt, setTimePresetAppliedAt] = useState(() => Date.now());
  const [customTimeOpen, setCustomTimeOpen] = useState(false);
  const [customFromDraft, setCustomFromDraft] = useState(() => toLocalDateTimeInput(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [customToDraft, setCustomToDraft] = useState(() => toLocalDateTimeInput(new Date()));
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);
  const [traceTags, setTraceTags] = useState<TraceTagOption[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const traceRequestIdRef = useRef(0);

  // ③ 预期答案
  const [expandedCase, setExpandedCase] = useState<string | null>(null);
  const [draftRef, setDraftRef] = useState('');
  // ③ 与数据集互通：导入（按输入精确匹配回填）/ 存为数据集（标注成果沉淀）
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [datasetBusy, setDatasetBusy] = useState(false);
  const [datasetHint, setDatasetHint] = useState('');

  // ④ 评估器
  const [customEvaluators, setCustomEvaluators] = useState<EvaluatorCard[]>([]);
  const [selectedEvaluators, setSelectedEvaluators] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (!user) return;
    apiFetch(`/api/experiments/agents?user=${encodeURIComponent(user)}`)
      .then((r) => r.json())
      .then((d) => setAgents(Array.isArray(d?.agents) ? d.agents : []))
      .catch(() => setAgents([]));
    apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`)
      .then((r) => r.json())
      .then((d) => setCustomEvaluators(Array.isArray(d) ? d : []))
      .catch(() => setCustomEvaluators([]));
    apiFetch(`/api/tags?user=${encodeURIComponent(user)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setTraceTags(Array.isArray(d) ? d : []))
      .catch(() => setTraceTags([]));
    apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setWizardDatasets(Array.isArray(d) ? d : []))
      .catch(() => setWizardDatasets([]));
    apiFetch('/api/fault-injection/platforms', {
      headers: (() => {
        const apiKey = typeof window !== 'undefined' ? localStorage.getItem('api_key') || '' : '';
        return apiKey ? { 'x-witty-api-key': apiKey } : undefined;
      })(),
    })
      .then((r) => r.json())
      .then((d) => {
        const rows = Array.isArray(d?.platforms) ? d.platforms : [];
        setFiPlatforms(
          rows
            .map((p: { id?: string; label?: string }) => ({
              id: String(p.id || '').trim(),
              label: String(p.label || p.id || '').trim(),
            }))
            .filter((p: PlatformOption) => p.id),
        );
      })
      .catch(() => setFiPlatforms([]));
    apiFetch('/api/reliability/fault-modes')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => {
        const items = Array.isArray(d?.items) ? d.items : [];
        const next = new Map<string, string>();
        for (const item of items) {
          const id = String(item?.id || '').trim();
          if (!id) continue;
          const name = String(item?.name || id).trim() || id;
          const method = String(item?.injectionMethodLabel || item?.injection_method_label || '').trim();
          next.set(id, method ? `${name} · ${method}` : name);
        }
        setFaultModeLabels(next);
      })
      .catch(() => setFaultModeLabels(new Map()));
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => setTraceSearch(traceSearchDraft.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [traceSearchDraft]);

  const appendTraceFilters = useCallback((params: URLSearchParams) => {
    if (traceSearch) params.set('search', traceSearch);
    if (timePreset === 'custom' && customRange) {
      params.set('from', customRange.from);
      params.set('to', customRange.to);
    } else {
      const preset = TIME_PRESETS.find((item) => item.value === timePreset);
      if (preset) params.set('from', new Date(timePresetAppliedAt - preset.ms).toISOString());
    }
    if (selectedTagIds.size > 0) params.set('tagIds', Array.from(selectedTagIds).join(','));
  }, [customRange, selectedTagIds, timePreset, timePresetAppliedAt, traceSearch]);

  const traceQuery = useCallback((p: number, pageSize: number) => {
    const params = new URLSearchParams({
      user: user || '',
      agent: agentName,
      page: String(p),
      pageSize: String(pageSize),
    });
    appendTraceFilters(params);
    return `/api/experiments/traces?${params.toString()}`;
  }, [agentName, appendTraceFilters, user]);

  const loadTraces = useCallback(async (p: number) => {
    if (!user || !agentName) return;
    const requestId = ++traceRequestIdRef.current;
    setTracesLoading(true);
    try {
      const res = await apiFetch(traceQuery(p, PAGE_SIZE));
      const data = await res.json();
      if (traceRequestIdRef.current !== requestId) return;
      setTraces(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
      setPage(p);
    } catch {
      if (traceRequestIdRef.current !== requestId) return;
      setTraces([]);
      setTotal(0);
    } finally {
      if (traceRequestIdRef.current === requestId) setTracesLoading(false);
    }
  }, [agentName, traceQuery, user]);

  useEffect(() => {
    if (step !== 2) return;
    const timer = window.setTimeout(() => void loadTraces(1), 0);
    return () => window.clearTimeout(timer);
  }, [loadTraces, step]);

  const goTo = (s: number) => {
    setStep(s);
    setMaxVisited((m) => Math.max(m, s));
  };

  // 全选：表头复选框控当前页；总数超过一页时另给「选择全部 N 条」跨页入口
  const toSelectedCase = (t: TraceItem): SelectedCase => ({
    executionId: t.id,
    taskId: t.taskId,
    input: t.query || '',
    actualOutput: t.finalResult || '',
    referenceOutput: null,
    evaluatorContext: null,
  });

  const pageAllSelected = traces.length > 0 && traces.every((t) => selected.has(t.id));
  const pageSomeSelected = traces.some((t) => selected.has(t.id));
  const timeLabel = timePreset === 'custom'
    ? '自定义时间'
    : timePreset === 'all'
      ? '全部时间'
      : TIME_PRESETS.find((item) => item.value === timePreset)?.label || '时间';
  const hasActiveTraceFilters = !!traceSearch || timePreset !== 'all' || selectedTagIds.size > 0;
  const versionTags = traceTags.filter((tag) => tag.kind === 'version');
  const businessTags = traceTags.filter((tag) => tag.kind === 'business');
  const selectedTraceTags = traceTags.filter((tag) => selectedTagIds.has(tag.id));
  const tagFilterLabel = selectedTraceTags.length > 0
    ? `用户标签：${selectedTraceTags[0].name}${selectedTraceTags.length > 1 ? ` +${selectedTraceTags.length - 1}` : ''}`
    : '用户标签';
  const customFromDate = new Date(customFromDraft);
  const customToDate = new Date(customToDraft);
  const customRangeValid = !Number.isNaN(customFromDate.getTime())
    && !Number.isNaN(customToDate.getTime())
    && customFromDate <= customToDate;

  const toggleTagFilter = (tagId: string) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else if (next.size < MAX_TRACE_TAG_FILTERS) next.add(tagId);
      return next;
    });
  };

  const resetTraceFilters = () => {
    setTraceSearchDraft('');
    setTraceSearch('');
    setTimePreset('all');
    setTimePresetAppliedAt(Date.now());
    setCustomRange(null);
    setSelectedTagIds(new Set());
  };

  const applyCustomRange = () => {
    if (!customRangeValid) return;
    setCustomRange({ from: customFromDate.toISOString(), to: customToDate.toISOString() });
    setTimePreset('custom');
    setCustomTimeOpen(false);
  };

  const togglePageAll = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      // 当前页已全选 → 取消当前页；否则补齐当前页（不动其它页已选项）
      if (pageAllSelected) traces.forEach((t) => next.delete(t.id));
      else traces.forEach((t) => { if (!next.has(t.id)) next.set(t.id, toSelectedCase(t)); });
      return next;
    });
  };

  const selectAllPages = async () => {
    if (!user || !agentName) return;
    setSelectingAll(true);
    try {
      // API 单页上限 100（服务端保护），分批拉到 SELECT_ALL_CAP 为止
      const target = Math.min(total, SELECT_ALL_CAP);
      const batch = 100;
      const all: TraceItem[] = [];
      for (let p = 1; all.length < target; p++) {
        const res = await apiFetch(traceQuery(p, batch));
        if (!res.ok) break;
        const data = await res.json();
        const items: TraceItem[] = Array.isArray(data.items) ? data.items : [];
        if (!items.length) break;
        all.push(...items);
        if (items.length < batch) break;
      }
      setSelected((prev) => {
        const next = new Map(prev);
        all.slice(0, target).forEach((t) => { if (!next.has(t.id)) next.set(t.id, toSelectedCase(t)); });
        return next;
      });
    } finally {
      setSelectingAll(false);
    }
  };

  const toggleTrace = (t: TraceItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(t.id)) {
        next.delete(t.id);
      } else {
        next.set(t.id, {
          executionId: t.id,
          taskId: t.taskId,
          input: t.query || '',
          actualOutput: t.finalResult || '',
          referenceOutput: null,
          evaluatorContext: null,
        });
      }
      return next;
    });
  };

  const removeSelectedTrace = (executionId: string) => {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(executionId);
      return next;
    });
  };

  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);
  const annotated = selectedList.filter((c) => !!c.referenceOutput).length;
  const capabilityCatalogAnnotated = selectedList.filter((c) => c.evaluatorContext !== null).length;
  const persistable = selectedList.filter((c) => c.referenceOutput || c.evaluatorContext).length;

  const setReference = (executionId: string, value: string | null) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const c = next.get(executionId);
      if (c) next.set(executionId, { ...c, referenceOutput: value && value.trim() ? value : null });
      return next;
    });
  };

  // ③ 从数据集导入：按输入精确匹配回填参考输出，已标注的默认跳过（保护人工标注）
  const openImport = () => {
    setDatasetHint('');
    setImportOpen(true);
    if (!user) return;
    apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}&view=reference`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setDatasets(Array.isArray(d) ? d : []))
      .catch(() => setDatasets([]));
  };

  const importFromDataset = (ds: DatasetOption) => {
    try {
      const result = matchDatasetCases(
        selectedList.map((c) => ({
          key: c.executionId,
          input: c.input,
          referenceOutput: c.referenceOutput,
          evaluatorContext: c.evaluatorContext,
        })),
        (ds.cases ?? []).map((x) => ({
          input: String(x.input ?? ''),
          expectedOutput: String(x.expectedOutput ?? ''),
          values: x.values,
        })),
      );
      setSelected((prev) => {
        const next = new Map(prev);
        for (const [key, ref] of Object.entries(result.updates)) {
          const c = next.get(key);
          if (c) next.set(key, { ...c, referenceOutput: ref });
        }
        for (const [key, evaluatorContext] of Object.entries(result.contextUpdates)) {
          const c = next.get(key);
          if (c) next.set(key, { ...c, evaluatorContext });
        }
        return next;
      });
      setDatasetHint(describeMatchResult(result));
      if (result.matched > 0 || result.contextMatched > 0) {
        setTimeout(() => setImportOpen(false), 900);
      }
    } catch (error) {
      setDatasetHint(`导入失败：${error instanceof Error ? error.message : 'Tool/Skill 目录无法解析'}`);
    }
  };

  // ③ 存为数据集：已标注的 case 沉淀为评测数据集（数据集是实验副产品）
  const saveAsDataset = async () => {
    const cases = toDatasetCases(selectedList);
    if (!cases.length || !user) return;
    setDatasetBusy(true);
    setDatasetHint('');
    try {
      const res = await apiFetch('/api/agent-datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user,
          name: datasetName.trim() || `${name.trim() || '实验'}-预期答案`,
          description: `由实验「${name.trim() || '未命名'}」的预期答案标注沉淀`,
          targetAgent: agentName,
          datasetKind: 'ideal_output',
          fields: [
            { id: 'input', key: 'input', label: '输入', type: 'text', system: true },
            { id: 'reference_output', key: 'reference_output', label: '预期输出', type: 'text', system: true },
            { id: 'available_tools', key: 'available_tools', label: '可用 Tool', type: 'json' },
            { id: 'available_skills', key: 'available_skills', label: '可用 Skill', type: 'json' },
          ],
          cases,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setDatasetHint(`保存失败：${err.error || res.status}`);
        return;
      }
      setDatasetHint(`已存为数据集，共 ${cases.length} 条——可在「评测数据集」页管理`);
      setTimeout(() => setSaveOpen(false), 1200);
    } catch (e) {
      setDatasetHint(`保存失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setDatasetBusy(false);
    }
  };

  // ④ 门控输入：每条已选 case 的参考标注和 Tool/Skill 目录情况
  const gateCases = useMemo(
    () => selectedList.map((c) => ({
      hasReference: !!c.referenceOutput,
      hasToolCatalog: c.evaluatorContext !== null,
    })),
    [selectedList],
  );

  const allEvaluators = useMemo(
    () => [...presetEvaluators, ...customEvaluators],
    [customEvaluators],
  );

  const toggleEvaluator = (id: string) => {
    setSelectedEvaluators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // 监听 trace 不携带逐条参考答案或 Tool/Skill 目录，移除带前置条件的评估器。
  useEffect(() => {
    if (!watchMode) return;
    const timer = window.setTimeout(() => {
      setSelectedEvaluators((prev) => {
        const next = new Set(prev);
        for (const card of allEvaluators) {
          if (getEvaluatorMeta(card).requires.length > 0) next.delete(card.id);
        }
        return next.size === prev.size ? prev : next;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [watchMode, allEvaluators]);

  const selectedDataset = useMemo(
    () => wizardDatasets.find((d) => d.id === selectedDatasetId) || null,
    [wizardDatasets, selectedDatasetId],
  );
  const isReliabilityDataset = selectedDataset?.datasetKind === 'reliability';

  useEffect(() => {
    const apiKey = typeof window !== 'undefined' ? localStorage.getItem('api_key') || '' : '';
    if (typeof window !== 'undefined') {
      const base = `${window.location.protocol}//${window.location.host}`;
      const setupPath = getApiUrl('/api/fault-injection/setup');
      const q = apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
      setFiSetupCmd(`curl -fsSL "${base}${setupPath}${q}" | bash`);
    }
    let cancelled = false;
    const headers = apiKey ? { 'x-witty-api-key': apiKey } : undefined;
    const poll = async () => {
      try {
        const res = await apiFetch('/api/fault-injection/health', { headers });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const ok = Boolean(data?.ok) && !Boolean(data?.needsWorker);
        setWorkerStatus(ok ? 'ok' : 'missing');
        if (!ok) {
          setFiInventoryHint(String(data?.error || '本机尚未纳管：请在「客户端安装」页安装常驻客户端'));
        }
      } catch {
        if (!cancelled) {
          setWorkerStatus('missing');
          setFiInventoryHint('无法检查本机纳管状态');
        }
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [user]);

  useEffect(() => {
    if (!user || !genPlatform || !workerOk) {
      if (!workerOk) {
        setFiAgents([]);
        setFiModels([{ id: '', label: '平台默认' }]);
      }
      return;
    }
    let cancelled = false;
    setFiInventoryHint('');
    const apiKey = typeof window !== 'undefined' ? localStorage.getItem('api_key') || '' : '';
    const fiHeaders = apiKey ? { 'x-witty-api-key': apiKey } : undefined;
    Promise.all([
      apiFetch(`/api/fault-injection/platforms/${encodeURIComponent(genPlatform)}/agents`, {
        headers: fiHeaders,
      }),
      apiFetch(`/api/fault-injection/platforms/${encodeURIComponent(genPlatform)}/models`, {
        headers: fiHeaders,
      }),
    ])
      .then(async ([agentsRes, modelsRes]) => {
        const agentsJson = await agentsRes.json().catch(() => ({}));
        const modelsJson = await modelsRes.json().catch(() => ({}));
        if (cancelled) return;
        const nextAgents: PlatformOption[] = Array.isArray(agentsJson?.agents)
          ? agentsJson.agents
              .map((a: { id?: string; label?: string }) => ({
                id: String(a.id || '').trim(),
                label: String(a.label || a.id || '').trim(),
              }))
              .filter((a: PlatformOption) => a.id)
              .filter((a: PlatformOption) => a.id !== 'ras-judge')
          : [];
        const nextModels: PlatformOption[] = Array.isArray(modelsJson?.models)
          ? modelsJson.models
              .map((m: { id?: string; label?: string }) => ({
                id: String(m.id || '').trim(),
                label: String(m.label || m.id || '平台默认').trim(),
              }))
          : [{ id: '', label: '平台默认' }];
        setFiAgents(nextAgents);
        setFiModels(nextModels.length ? nextModels : [{ id: '', label: '平台默认' }]);
        if (!agentsRes.ok) {
          setFiInventoryHint(String(agentsJson?.error || '无法从 FI Worker 获取 Agent 列表'));
          setWorkerStatus('missing');
        }
        setAgentName((prev) => {
          if (prev && nextAgents.some((a) => a.id === prev)) return prev;
          if (prev && !isReliabilityDataset && agents.some((a) => a.name === prev)) return prev;
          return nextAgents[0]?.id || prev || '';
        });
        setGenModel((prev) => {
          if (nextModels.some((m) => m.id === prev)) return prev;
          return '';
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFiAgents([]);
        setFiModels([{ id: '', label: '平台默认' }]);
        setFiInventoryHint('无法从 FI Worker 获取平台 inventory');
      });
    return () => {
      cancelled = true;
    };
  }, [genPlatform, user, workerOk, isReliabilityDataset, agents]);

  useEffect(() => {
    if (!isReliabilityDataset) {
      setReliabilityCases([]);
      return;
    }
    setWatchMode(false);
    setSelectedEvaluators(new Set(['preset-ras-reliability']));
    const cases = selectedDataset?.cases || [];
    const pool: SelectedCase[] = cases.map((item) => {
      const fault = String(item.values?.fault_injection_type || '').trim();
      const key = String(item.id || `${fault}:${item.input || ''}`);
      return {
        executionId: key,
        taskId: null,
        input: String(item.input || ''),
        actualOutput: '',
        referenceOutput: item.expectedOutput != null ? String(item.expectedOutput) : null,
        evaluatorContext: null,
        faultInjectionType: fault || null,
        values: {
          ...(item.values || {}),
          ...(fault ? { fault_injection_type: fault } : {}),
        },
      };
    });
    setReliabilityCases(pool);
    const next = new Map<string, SelectedCase>();
    for (const item of pool) next.set(item.executionId, item);
    setSelected(next);
  }, [isReliabilityDataset, selectedDatasetId, selectedDataset]);

  const submit = async () => {

    if (!user || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const casesPayload = selectedList.map((c) => ({
        executionId: isReliabilityDataset ? undefined : c.executionId,
        taskId: c.taskId || undefined,
        input: c.input,
        actualOutput: c.actualOutput,
        referenceOutput: c.referenceOutput,
        evaluatorContext: c.evaluatorContext,
        faultInjectionType: c.faultInjectionType || undefined,
        values: c.values,
      }));
      const res = await apiFetch('/api/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user,
          name,
          agentName,
          watchMode: isReliabilityDataset ? false : watchMode,
          cases: casesPayload,
          evaluatorIds: Array.from(selectedEvaluators),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '创建实验失败'));
      // 「开始实验」= 创建后立即真跑评估器；详情页落地即 running 状态并自动轮询进度。
      // run 触发失败不阻塞跳转——详情页仍可手动「开始执行」兜底。
      const runBody = isReliabilityDataset
        ? {
            fiOrchestrate: true,
            traceSource: 'generate',
            generateTrace: {
              platform: genPlatform,
              agent: agentName,
              model: genModel || null,
              timeoutSeconds: 180,
            },
          }
        : {};
      const runRes = await apiFetch(`/api/experiments/${encodeURIComponent(data.id)}/run?user=${encodeURIComponent(user)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runBody),
      }).catch(() => null);
      if (runRes && !runRes.ok) {
        const err = await runRes.json().catch(() => ({}));
        throw new Error(String(err?.error || err?.code || '启动实验失败'));
      }
      router.push(`/experiments/${data.id}`);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : '创建实验失败');
      setSubmitting(false);
    }
  };

  const step1Ok = isReliabilityDataset
    ? name.trim() !== '' && !!selectedDatasetId && workerOk && agentName !== ''
    : name.trim() !== '' && agentName !== '' && !!selectedDatasetId;
  // 监听模式允许 0 条已选 trace 起步（纯监听后续新 trace）
  const step2Valid = isReliabilityDataset
    ? selected.size >= 1
    : (watchMode || selected.size >= 1);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const stepSummaries = [
    `${name.trim() || '未命名'} · ${selectedDataset?.name || '未选数据集'}`,
    isReliabilityDataset ? `生成 Trace · ${selected.size} case` : `已选 ${selected.size} 条 trace`,
    isReliabilityDataset ? '可靠性 case 预期已从数据集带入' : `参考 ${annotated}/${selectedList.length} · Tool/Skill 目录 ${capabilityCatalogAnnotated}/${selectedList.length}`,
    `已选 ${selectedEvaluators.size} 个`,
  ];

  // 各步 panel 内底部 footer：分隔线 + 右对齐 上一步/下一步
  const footer = (opts: { nextDisabled?: boolean; nextLabel?: string; onNext?: () => void }) => (
    <div style={{
      display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8,
      marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)',
    }}>
      {step > 1 && (
        <button style={BTN_GHOST} onClick={() => goTo(step - 1)}>← 上一步</button>
      )}
      <button
        disabled={opts.nextDisabled}
        onClick={opts.onNext ?? (() => goTo(step + 1))}
        style={{
          ...BTN_PRIMARY,
          opacity: opts.nextDisabled ? 0.5 : 1,
          cursor: opts.nextDisabled ? 'not-allowed' : 'pointer',
        }}
      >
        {opts.nextLabel ?? NEXT_LABELS[step - 1]}
      </button>
    </div>
  );

  return (
    <>
      <AppTopBar title="新建实验" />
      <PageContainer className="[&>*]:shrink-0">
        {/* 页头 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0 12px' }}>
          <button
            style={{ ...BTN_GHOST, height: 26, padding: '0 9px', fontSize: 11.5 }}
            onClick={() => router.push('/experiments')}
          >
            ‹ 返回
          </button>
          <h1 style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }}>新建实验</h1>
        </div>

        <Stepper step={step} maxVisited={maxVisited} summaries={stepSummaries} onJump={goTo} />

        {step === 1 && (
          <div style={PANEL}>
            <div style={PANEL_B}>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: 14, marginBottom: 16,
              }}>
                <div>
                  <label style={FIELDLBL}>实验名称</label>
                  <input
                    style={INPUT}
                    value={name}
                    placeholder="如：客服 Agent 回答质量基线"
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div>
                  <label style={FIELDLBL}>评测数据集</label>
                  <select
                    style={{ ...INPUT, cursor: 'pointer' }}
                    value={selectedDatasetId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setSelectedDatasetId(nextId);
                      setSelected(new Map());
                    }}
                  >
                    <option value="">请选择数据集…</option>
                    {wizardDatasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}{d.datasetKind === 'reliability' ? ' · 可靠性' : ''}（{d.cases?.length ?? d.caseCount ?? 0}）
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginTop: 5 }}>
                    可靠性数据集将仅支持「生成 Trace」，并锁定可靠性评估器
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                  {workerStatus === 'missing' && (
                    <div style={{
                      border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 12,
                      background: 'var(--background-secondary)',
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>本机尚未纳管</div>
                      <div style={{ fontSize: 12, color: 'var(--foreground-secondary)', marginBottom: 10, lineHeight: 1.6 }}>
                        推荐在「客户端安装」页生成一条命令，一次装完常驻客户端与故障注入组件 ——
                        装完后本机会同时出现在「客户端配置」与本页。安装完成后本页每 2 秒自动刷新。
                        <br />
                        可靠性评测需要本机纳管；普通实验也可先用历史 Agent。
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <a
                          href="/accessconfig/install"
                          style={{
                            ...BTN_GHOST,
                            textDecoration: 'none',
                            display: 'inline-flex',
                            alignItems: 'center',
                          }}
                        >
                          前往客户端安装 →
                        </a>
                        <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
                          每 2 秒自动检测…
                        </span>
                      </div>
                      <details style={{ marginTop: 10 }}>
                        <summary style={{ fontSize: 11, color: 'var(--foreground-muted)', cursor: 'pointer' }}>
                          仅安装 FI Worker（旧方式，兼容保留）
                        </summary>
                        <div style={{
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontSize: 11, padding: '10px 12px', borderRadius: 8,
                          border: '1px solid var(--border)', background: 'var(--card-bg)',
                          wordBreak: 'break-all', margin: '8px 0',
                        }}>
                          {fiSetupCmd || '正在生成安装命令…'}
                        </div>
                        <button
                          type="button"
                          style={BTN_GHOST}
                          disabled={!fiSetupCmd}
                          onClick={async () => {
                            if (!fiSetupCmd) return;
                            try {
                              await navigator.clipboard.writeText(fiSetupCmd);
                              setFiSetupCopied(true);
                              window.setTimeout(() => setFiSetupCopied(false), 1500);
                            } catch {
                              /* ignore */
                            }
                          }}
                        >
                          {fiSetupCopied ? '已复制' : '复制命令'}
                        </button>
                      </details>
                      {fiInventoryHint && (
                        <div style={{ fontSize: 11, color: 'var(--color-danger, #b91c1c)', marginTop: 8 }}>
                          {fiInventoryHint}
                        </div>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={FIELDLBL}>平台</label>
                      <select
                        style={{ ...INPUT, cursor: workerOk ? 'pointer' : 'not-allowed', opacity: workerOk ? 1 : 0.6 }}
                        value={genPlatform}
                        disabled={!workerOk}
                        onChange={(e) => {
                          setGenPlatform(e.target.value);
                          setAgentName('');
                          setGenModel('');
                        }}
                      >
                        {(fiPlatforms.length ? fiPlatforms : [
                          { id: 'opencode', label: 'opencode' },
                          { id: 'xiaoo', label: 'xiaoo' },
                          { id: 'openjiuwen', label: 'openjiuwen' },
                        ]).map((p) => (
                          <option key={p.id} value={p.id}>{p.label || p.id}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label style={FIELDLBL}>待评测 Agent</label>
                      {workerOk || isReliabilityDataset ? (
                        <select
                          style={{ ...INPUT, cursor: workerOk ? 'pointer' : 'not-allowed', opacity: workerOk ? 1 : 0.6 }}
                          value={agentName}
                          disabled={!workerOk}
                          onChange={(e) => {
                            setAgentName(e.target.value);
                            setSelected(new Map());
                            setPage(1);
                          }}
                        >
                          <option value="">{fiAgents.length ? '请选择 Agent…' : '暂无可用 Agent'}</option>
                          {fiAgents.map((a) => (
                            <option key={a.id} value={a.id}>{a.label || a.id}</option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <select
                            style={{ ...INPUT, cursor: 'pointer' }}
                            value={agents.some((a) => a.name === agentName) || agentName === '' ? agentName : '__custom__'}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === '__custom__') {
                                setAgentName('build');
                              } else {
                                setAgentName(v);
                              }
                              setSelected(new Map());
                              setPage(1);
                            }}
                          >
                            <option value="">请选择 Agent…</option>
                            {agents.map((a) => (
                              <option key={a.name} value={a.name}>{a.name}（{a.traces} 条 trace）</option>
                            ))}
                            <option value="__custom__">自定义 / FI Agent（如 build）</option>
                          </select>
                          {(!agents.some((a) => a.name === agentName) && agentName !== '') && (
                            <input
                              style={{ ...INPUT, marginTop: 8 }}
                              value={agentName}
                              placeholder="Agent 名，如 build"
                              onChange={(e) => setAgentName(e.target.value)}
                            />
                          )}
                        </>
                      )}
                    </div>
                    <div>
                      <label style={FIELDLBL}>模型</label>
                      <select
                        style={{ ...INPUT, cursor: workerOk ? 'pointer' : 'not-allowed', opacity: workerOk ? 1 : 0.6 }}
                        value={genModel}
                        disabled={!workerOk}
                        onChange={(e) => setGenModel(e.target.value)}
                      >
                        {fiModels.map((m) => (
                          <option key={m.id || '__default__'} value={m.id}>{m.label || m.id || '平台默认'}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginTop: 6 }}>
                    Agent / 模型来自目标平台 FI Worker inventory；未选可靠性数据集时平台/模型不参与普通实验执行
                  </div>
                </div>

              <label style={FIELDLBL}>实验类型</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{
                  ...FCHIP,
                  background: 'var(--primary-subtle)', border: '1px solid var(--primary-subtle-border)',
                  color: 'var(--primary)', cursor: 'default',
                }}>
                  🎯 无变量 · 单组
                </span>
                {['LLM 对比', 'Agent 框架对比', 'Skill 版本对比'].map((t) => (
                  <span
                    key={t}
                    title="即将支持"
                    style={{
                      ...FCHIP,
                      background: 'var(--background-secondary)', color: 'var(--foreground-muted)',
                      cursor: 'not-allowed', border: '1px dashed var(--border)',
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
              {footer({ nextDisabled: !step1Ok })}
            </div>
          </div>
        )}

        {step === 2 && isReliabilityDataset && (
          <div style={PANEL}>
            <div style={PANEL_B}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>生成 Trace（可靠性）</div>
              <div style={{ fontSize: 12, color: 'var(--foreground-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
                已禁用「选择 Trace」。将通过 FI Worker（{genPlatform} / {agentName || '—'}
                {genModel ? ` / ${genModel}` : ''}）按所选 case 生成 Trace。
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>数据集 Case（{selected.size}/{reliabilityCases.length}）</div>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  style={BTN_GHOST}
                  onClick={() => {
                    const next = new Map<string, SelectedCase>();
                    for (const item of reliabilityCases) next.set(item.executionId, item);
                    setSelected(next);
                  }}
                >
                  全选
                </button>
                <button
                  type="button"
                  style={BTN_GHOST}
                  onClick={() => setSelected(new Map())}
                >
                  取消全选
                </button>
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', maxHeight: 360, overflowY: 'auto' }}>
                {reliabilityCases.length === 0 ? (
                  <div style={{ padding: 16, fontSize: 12, color: 'var(--foreground-muted)' }}>数据集暂无 case</div>
                ) : (
                  reliabilityCases.map((c) => (
                    <label
                      key={c.executionId}
                      style={{
                        display: 'flex',
                        gap: 10,
                        padding: '10px 12px',
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer',
                        background: selected.has(c.executionId) ? 'var(--primary-subtle)' : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(c.executionId)}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Map(prev);
                            if (next.has(c.executionId)) next.delete(c.executionId);
                            else next.set(c.executionId, c);
                            return next;
                          });
                        }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700 }}>
                          {formatReliabilityFaultTypeFromCaseValues(c.values, {
                            faultId: c.faultInjectionType,
                          })
                            || (c.faultInjectionType && faultModeLabels.get(c.faultInjectionType))
                            || c.faultInjectionType
                            || '未指定故障'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--foreground-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.input || '（无输入）'}
                        </div>
                      </span>
                    </label>
                  ))
                )}
              </div>
              {footer({ nextDisabled: !step2Valid, nextLabel: '下一步：预期答案 →' })}
            </div>
          </div>
        )}

        {step === 2 && !isReliabilityDataset && (
          <div style={PANEL}>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', marginBottom: 12,
              borderRadius: 10, border: `1px solid ${watchMode ? 'var(--primary)' : 'var(--border)'}`,
              background: watchMode ? 'var(--primary-subtle)' : 'var(--card-bg)', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={watchMode} onChange={(e) => setWatchMode(e.target.checked)} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--foreground)' }}>监听模式</span>
              <span style={{ fontSize: 12, color: 'var(--foreground-secondary)', lineHeight: 1.5 }}>
                开启后本实验绑定「{agentName || '该 Agent'}」——其新上报的 trace 自动进来评测；下方圈选已有 trace 变为可选，可 0 条起步。
                <span style={{ color: 'var(--foreground-muted)' }}>（监听 trace 无参考答案，第 ④ 步依赖参考数据的评估器不可选）</span>
              </span>
            </label>
            <div style={PANEL_H}>
              <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>Agent：</span>
              <span style={{ ...CHIP_MUT, color: 'var(--foreground)', fontWeight: 700 }}>{agentName}</span>
              <span style={{ flex: 1 }} />
              {total > traces.length && (
                <button
                  style={{ ...BTN_OUTLINE_SM, opacity: selectingAll ? 0.6 : 1 }}
                  disabled={selectingAll}
                  onClick={selectAllPages}
                  title={total > SELECT_ALL_CAP ? `跨页全选，最多 ${SELECT_ALL_CAP} 条（共 ${total} 条）` : '选中全部页的 trace'}
                >
                  {selectingAll ? '选择中…' : `选择全部 ${Math.min(total, SELECT_ALL_CAP)} 条`}
                </button>
              )}
            </div>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              padding: '10px 14px', borderBottom: '1px solid var(--border)',
              background: 'var(--background-secondary)',
            }}>
              <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: 440 }}>
                <Search
                  size={15}
                  style={{ position: 'absolute', left: 10, top: 9, color: 'var(--foreground-muted)', pointerEvents: 'none' }}
                />
                <input
                  style={{ ...INPUT, height: 32, paddingLeft: 32, paddingRight: traceSearchDraft ? 32 : 10 }}
                  value={traceSearchDraft}
                  maxLength={200}
                  placeholder="模糊搜索 Trace ID 或任务输入…"
                  onChange={(e) => setTraceSearchDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setTraceSearch(traceSearchDraft.trim());
                  }}
                />
                {traceSearchDraft && (
                  <button
                    type="button"
                    aria-label="清空搜索"
                    onClick={() => {
                      setTraceSearchDraft('');
                      setTraceSearch('');
                    }}
                    style={{
                      position: 'absolute', right: 7, top: 6, width: 20, height: 20,
                      display: 'grid', placeItems: 'center', border: 'none', background: 'none',
                      color: 'var(--foreground-muted)', cursor: 'pointer',
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <Popover open={customTimeOpen} onOpenChange={setCustomTimeOpen}>
                <PopoverTrigger asChild>
                  <button type="button" style={{ ...BTN_OUTLINE_SM, height: 32, gap: 7 }}>
                    {timeLabel}
                    <ChevronDown size={13} />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80" style={{ padding: 8 }}>
                  <div style={{ maxHeight: 230, overflowY: 'auto' }}>
                    {[{ value: 'all' as const, label: '全部时间' }, ...TIME_PRESETS].map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => {
                          setTimePreset(item.value);
                          setTimePresetAppliedAt(Date.now());
                          setCustomTimeOpen(false);
                        }}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                          padding: '7px 9px', border: 'none', borderRadius: 6, cursor: 'pointer',
                          background: timePreset === item.value ? 'var(--primary-subtle)' : 'transparent',
                          color: timePreset === item.value ? 'var(--primary)' : 'var(--foreground)',
                          textAlign: 'left', fontSize: 12,
                        }}
                      >
                        <span style={{ width: 31, color: 'var(--foreground-muted)', fontSize: 10.5 }}>
                          {item.value === 'all' ? '∞' : item.value}
                        </span>
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ height: 1, background: 'var(--border)', margin: '7px 0 10px' }} />
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--foreground)', marginBottom: 7 }}>自定义时间</div>
                  <label style={{ ...FIELDLBL, marginBottom: 4 }}>开始时间</label>
                  <input
                    type="datetime-local"
                    style={{ ...INPUT, height: 30, marginBottom: 8, fontSize: 11.5 }}
                    value={customFromDraft}
                    onChange={(e) => setCustomFromDraft(e.target.value)}
                  />
                  <label style={{ ...FIELDLBL, marginBottom: 4 }}>结束时间</label>
                  <input
                    type="datetime-local"
                    style={{ ...INPUT, height: 30, marginBottom: 10, fontSize: 11.5 }}
                    value={customToDraft}
                    onChange={(e) => setCustomToDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={!customRangeValid}
                    style={{ ...BTN_PRIMARY, width: '100%', height: 30, opacity: customRangeValid ? 1 : 0.45 }}
                    onClick={applyCustomRange}
                  >
                    应用自定义时间
                  </button>
                </PopoverContent>
              </Popover>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" style={{ ...BTN_OUTLINE_SM, height: 32, gap: 7, maxWidth: 220 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tagFilterLabel}</span>
                    <ChevronDown size={13} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72 max-h-80 overflow-y-auto">
                  <DropdownMenuLabel>同时包含全部所选标签（AND，最多 {MAX_TRACE_TAG_FILTERS} 个）</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>版本标签</DropdownMenuLabel>
                  {versionTags.length === 0
                    ? <DropdownMenuLabel>暂无版本标签</DropdownMenuLabel>
                    : versionTags.map((tag) => (
                        <DropdownMenuCheckboxItem
                          key={tag.id}
                          checked={selectedTagIds.has(tag.id)}
                          disabled={!selectedTagIds.has(tag.id) && selectedTagIds.size >= MAX_TRACE_TAG_FILTERS}
                          onCheckedChange={() => toggleTagFilter(tag.id)}
                          onSelect={(event) => event.preventDefault()}
                        >
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: tag.color, flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tag.name}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>业务标签</DropdownMenuLabel>
                  {businessTags.length === 0
                    ? <DropdownMenuLabel>暂无业务标签</DropdownMenuLabel>
                    : businessTags.map((tag) => (
                        <DropdownMenuCheckboxItem
                          key={tag.id}
                          checked={selectedTagIds.has(tag.id)}
                          disabled={!selectedTagIds.has(tag.id) && selectedTagIds.size >= MAX_TRACE_TAG_FILTERS}
                          onCheckedChange={() => toggleTagFilter(tag.id)}
                          onSelect={(event) => event.preventDefault()}
                        >
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: tag.color, flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tag.name}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                  {selectedTagIds.size > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <button
                        type="button"
                        onClick={() => setSelectedTagIds(new Set())}
                        style={{
                          width: '100%', border: 'none', borderRadius: 5, padding: '6px 8px',
                          background: 'transparent', color: 'var(--foreground-secondary)',
                          fontSize: 11.5, textAlign: 'left', cursor: 'pointer',
                        }}
                      >
                        清除标签筛选
                      </button>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {hasActiveTraceFilters && (
                <button type="button" style={{ ...BTN_GHOST, height: 32, padding: '0 8px' }} onClick={resetTraceFilters}>
                  重置筛选
                </button>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                找到 {total} 条{watchMode ? ' · 筛选仅影响已有 Trace' : ''}
              </span>
            </div>

            {selected.size > 0 && (
              <div style={{
                margin: '10px 14px', border: '1px solid var(--border)', borderRadius: 10,
                background: 'var(--card-bg)', overflow: 'hidden',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  padding: '8px 10px', borderBottom: '1px solid var(--border)',
                  background: 'var(--background-secondary)',
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--foreground)' }}>已选 Trace</span>
                  <span style={{ ...CHIP_MUT, color: 'var(--primary)' }}>{selected.size} 条</span>
                  <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>跨搜索、跨分页持续保留</span>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    style={{ ...BTN_GHOST, height: 26, padding: '0 8px' }}
                    onClick={() => setSelected(new Map())}
                  >
                    清空已选
                  </button>
                </div>
                <div style={{ maxHeight: 112, overflowY: 'auto' }}>
                  {selectedList.map((item, index) => (
                    <div
                      key={item.executionId}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 10px',
                        borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                      }}
                    >
                      <span
                        title={item.taskId || item.executionId}
                        style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          flex: '0 1 190px',
                          fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11,
                          color: 'var(--foreground-secondary)',
                        }}
                      >
                        {item.taskId || item.executionId}
                      </span>
                      <span
                        title={item.input || '无任务输入'}
                        style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          flex: '1 1 220px',
                          fontSize: 11.5, color: item.input ? 'var(--foreground)' : 'var(--foreground-muted)',
                        }}
                      >
                        {item.input || '无任务输入'}
                      </span>
                      <button
                        type="button"
                        aria-label={`移除 Trace ${item.taskId || item.executionId}`}
                        title="从已选 Trace 中移除"
                        style={{ ...BTN_GHOST, height: 24, padding: '0 6px', marginLeft: 'auto', color: 'var(--foreground-muted)' }}
                        onClick={() => removeSelectedTrace(item.executionId)}
                      >
                        <X size={13} />
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ maxHeight: 'min(42vh, 420px)', overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1080 }}>
                <thead>
                  <tr>
                    <th style={{ ...STICKY_TH, width: 36 }}>
                      <input
                        type="checkbox"
                        checked={pageAllSelected}
                        ref={(el) => { if (el) el.indeterminate = !pageAllSelected && pageSomeSelected; }}
                        onChange={togglePageAll}
                        disabled={traces.length === 0}
                        title={pageAllSelected ? '取消选择本页' : '全选本页'}
                        style={{ cursor: traces.length ? 'pointer' : 'not-allowed' }}
                      />
                    </th>
                    <th style={STICKY_TH}>Trace ID</th>
                    <th style={STICKY_TH}>任务输入</th>
                    <th style={STICKY_TH}>状态</th>
                    <th style={{ ...STICKY_TH, textAlign: 'right' }}>耗时</th>
                    <th style={{ ...STICKY_TH, textAlign: 'right' }}>Token</th>
                    <th style={STICKY_TH}>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {tracesLoading ? (
                    <tr><td colSpan={7} style={{ ...TD, borderBottom: 'none', textAlign: 'center', color: 'var(--foreground-muted)' }}>加载中…</td></tr>
                  ) : traces.length === 0 ? (
                    <tr><td colSpan={7} style={{ ...TD, borderBottom: 'none', textAlign: 'center', color: 'var(--foreground-muted)' }}>
                      {hasActiveTraceFilters ? '没有符合当前筛选条件的 Trace' : '该 Agent 暂无 Trace'}
                    </td></tr>
                  ) : traces.map((t, i) => {
                    const last = i === traces.length - 1;
                    const td: React.CSSProperties = last ? { ...TD, borderBottom: 'none' } : TD;
                    return (
                      <tr
                        key={t.id}
                        onClick={() => toggleTrace(t)}
                        style={{ cursor: 'pointer', background: selected.has(t.id) ? 'var(--primary-subtle)' : 'transparent' }}
                      >
                        <td style={td}>
                          <input type="checkbox" readOnly checked={selected.has(t.id)} style={{ cursor: 'pointer' }} />
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11, whiteSpace: 'nowrap' }}>
                          {truncate(t.taskId || t.id, 18)}
                        </td>
                        <td style={{ ...td, maxWidth: 320, color: 'var(--foreground)' }}>{truncate(t.query, 60)}</td>
                        <td style={td}>
                          <span style={{
                            ...CHIP,
                            background: t.ok ? 'var(--tag-green-bg)' : 'var(--tag-red-bg)',
                            color: t.ok ? 'var(--tag-green-fg)' : 'var(--tag-red-fg)',
                          }}>
                            {t.ok ? '成功' : '异常'}
                          </span>
                        </td>
                        <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                          {t.latency != null ? `${t.latency.toFixed(1)}s` : '—'}
                        </td>
                        <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {t.tokens != null ? t.tokens.toLocaleString() : '—'}
                        </td>
                        <td style={{ ...td, color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>
                          {new Date(t.timestamp).toLocaleString('zh-CN', { hour12: false })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 分页条 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '9px 14px',
              borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--foreground-muted)', flexWrap: 'wrap',
            }}>
              共 {total} 条 · 每页 {PAGE_SIZE}
              <span style={{ flex: 1 }} />
              <button
                style={{ ...PAGER_BTN, opacity: page <= 1 || tracesLoading ? 0.4 : 1, cursor: page <= 1 || tracesLoading ? 'not-allowed' : 'pointer' }}
                disabled={page <= 1 || tracesLoading}
                onClick={() => loadTraces(page - 1)}
              >
                ‹
              </button>
              {pageNumbers(page, totalPages).map((p, i) => p === '…' ? (
                <span key={`d${i}`} style={{ padding: '0 2px' }}>…</span>
              ) : (
                <button
                  key={p}
                  disabled={tracesLoading}
                  onClick={() => p !== page && loadTraces(p)}
                  style={p === page
                    ? { ...PAGER_BTN, background: 'var(--primary)', border: '1px solid var(--primary)', color: '#fff' }
                    : PAGER_BTN}
                >
                  {p}
                </button>
              ))}
              <button
                style={{ ...PAGER_BTN, opacity: page >= totalPages || tracesLoading ? 0.4 : 1, cursor: page >= totalPages || tracesLoading ? 'not-allowed' : 'pointer' }}
                disabled={page >= totalPages || tracesLoading}
                onClick={() => loadTraces(page + 1)}
              >
                ›
              </button>
            </div>

            <div style={{ ...PANEL_B, paddingTop: 0 }}>
              {footer({ nextDisabled: !step2Valid })}
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={PANEL}>
            <div style={PANEL_H}>
              <span style={{ fontSize: 12, color: 'var(--foreground-secondary)', flex: 1, minWidth: 260, lineHeight: 1.6 }}>
                参考答案和 Tool/Skill 目录可从数据集按输入精确导入；目录不会从 trace 的已调用集合反推。依赖相应数据的评估器会在第 ④ 步门控。
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 200 }}>
                <span style={{ flex: 1, height: 7, borderRadius: 4, background: 'var(--background-secondary)', overflow: 'hidden' }}>
                  <span style={{
                    display: 'block', height: '100%', borderRadius: 4, background: 'var(--primary)',
                    width: `${selectedList.length > 0 ? Math.round((annotated / selectedList.length) * 100) : 0}%`,
                    transition: 'width 0.2s',
                  }} />
                </span>
                <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>
                  参考 <b style={{ color: 'var(--primary)' }}>{annotated}</b> · Tool/Skill 目录 <b style={{ color: 'var(--primary)' }}>{capabilityCatalogAnnotated}</b>/{selectedList.length}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button style={BTN_OUTLINE_SM} onClick={openImport} title="按任务输入精确匹配，回填参考输出；已标注的条目跳过">
                  📥 从数据集导入匹配
                </button>
                <button
                  style={{ ...BTN_OUTLINE_SM, opacity: persistable > 0 ? 1 : 0.5, cursor: persistable > 0 ? 'pointer' : 'not-allowed' }}
                  disabled={persistable === 0}
                  onClick={() => { setDatasetHint(''); setDatasetName(''); setSaveOpen(true); }}
                  title={persistable > 0 ? '把参考答案和 Tool/Skill 目录沉淀为评测数据集' : '尚无可保存的 case 上下文'}
                >
                  💾 存为数据集
                </button>
              </span>
            </div>

            <div style={PANEL_B}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {selectedList.map((c) => {
                  const open = expandedCase === c.executionId;
                  return (
                    <div key={c.executionId} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 2, color: 'var(--foreground)' }}>
                            {truncate(c.input, 70)}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--foreground-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            实际输出：{truncate(c.actualOutput, 90)}
                          </div>
                          {c.referenceOutput && !open && (
                            <div style={{ fontSize: 11, color: 'var(--success)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
                              参考答案：{truncate(c.referenceOutput, 90)}
                            </div>
                          )}
                        </div>
                        <span style={c.referenceOutput
                          ? { ...CHIP, background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid var(--success-subtle-border)' }
                          : CHIP_MUT}>
                          {c.referenceOutput ? '已标注' : '未标注'}
                        </span>
                        <span style={c.evaluatorContext
                          ? { ...CHIP, background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid var(--success-subtle-border)' }
                          : CHIP_MUT}>
                          {c.evaluatorContext
                            ? `Tool ${c.evaluatorContext.availableTools.length} · Skill ${c.evaluatorContext.availableSkills?.length ?? 0}`
                            : '无 Tool/Skill 目录'}
                        </span>
                        <button
                          style={BTN_OUTLINE_SM}
                          onClick={() => {
                            if (open) {
                              setExpandedCase(null);
                            } else {
                              setExpandedCase(c.executionId);
                              // 预填：已有参考输出 > 实际输出
                              setDraftRef(c.referenceOutput ?? c.actualOutput);
                            }
                          }}
                        >
                          {open ? '收起' : '✏️ 标注'}
                        </button>
                      </div>
                      {open && (
                        <div style={{ padding: '0 13px 12px', borderTop: '1px solid var(--border)', background: 'var(--background-secondary)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 7px' }}>
                            <label style={{ ...FIELDLBL, marginBottom: 0 }}>参考输出（预期答案）</label>
                            <span style={{ flex: 1 }} />
                            <button
                              style={{ ...BTN_OUTLINE_SM, height: 22, fontSize: 10.5 }}
                              onClick={() => setDraftRef(c.actualOutput)}
                            >
                              预填实际输出
                            </button>
                          </div>
                          <textarea
                            style={{ ...INPUT, height: 'auto', minHeight: 96, padding: '8px 10px', fontSize: 12.5, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
                            value={draftRef}
                            onChange={(e) => setDraftRef(e.target.value)}
                          />
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button
                              style={{ ...BTN_PRIMARY, height: 26, padding: '0 11px', fontSize: 11.5 }}
                              onClick={() => {
                                setReference(c.executionId, draftRef);
                                setExpandedCase(null);
                              }}
                            >
                              保存
                            </button>
                            <button
                              style={BTN_OUTLINE_SM}
                              onClick={() => {
                                setReference(c.executionId, null);
                                setExpandedCase(null);
                              }}
                            >
                              清除标注
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {footer({})}
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={PANEL}>
            <div style={PANEL_B}>
              <div style={{ fontSize: 12, color: 'var(--foreground-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
                为本次实验挑选评估器（可多选）。依赖参考数据或 Tool/Skill 目录的评估器要求所有已选 case 满足对应前置条件。
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 10 }}>
                {allEvaluators
                  .filter((card) => !isReliabilityDataset || card.id === 'preset-ras-reliability')
                  .map((card) => {
                  const meta = getEvaluatorMeta(card);
                  // 监听模式的新 trace 没有逐条参考答案或 Tool/Skill 目录，带前置条件的评估器不可用。
                  const gate = isReliabilityDataset
                    ? { usable: true, reason: '' }
                    : watchMode && meta.requires.length > 0
                    ? { usable: false, reason: '监听模式下新 trace 不携带评估器所需的逐条上下文' }
                    : gateEvaluator(meta, gateCases);
                  const checked = selectedEvaluators.has(card.id);
                  return (
                    <div
                      key={card.id}
                      title={gate.usable ? undefined : gate.reason}
                      onClick={() => gate.usable && toggleEvaluator(card.id)}
                      style={{
                        border: `1px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
                        borderRadius: 11, padding: '13px 15px',
                        background: checked ? 'var(--primary-subtle)' : 'var(--card-bg)',
                        boxShadow: checked ? '0 8px 24px var(--shadow-primary)' : 'none',
                        opacity: gate.usable ? 1 : 0.55,
                        cursor: gate.usable ? 'pointer' : 'not-allowed',
                        transition: 'all 0.12s',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          fontSize: 13, fontWeight: 800, flex: 1, minWidth: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: checked ? 'var(--primary)' : 'var(--foreground)',
                        }}>
                          {card.name}
                        </span>
                        <span style={{
                          width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                          display: 'inline-grid', placeItems: 'center',
                          border: `1.5px solid ${checked ? 'var(--primary)' : 'var(--border-dark)'}`,
                          background: checked ? 'var(--primary)' : 'transparent',
                          color: '#fff',
                        }}>
                          {checked && <CheckMark size={10} />}
                        </span>
                      </div>
                      <div style={{
                        fontSize: 11, color: 'var(--foreground-muted)', marginTop: 5, lineHeight: 1.5,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden', minHeight: 33,
                      }}>
                        {card.description}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                        {deriveEvaluatorTags(card).map((tag) => (
                          <span key={tag} style={CHIP_MUT}>{tag}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {submitError && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--error)' }}>{submitError}</div>
              )}

              {footer({
                nextDisabled: selectedEvaluators.size < 1 || submitting,
                nextLabel: submitting ? '创建中…' : '🚀 开始实验',
                onNext: submit,
              })}
            </div>
          </div>
        )}

        {/* ③ 从数据集导入：选一个数据集，按输入精确匹配回填 */}
        {importOpen && (
          <div style={MODAL_OV} onClick={(e) => { if (e.target === e.currentTarget) setImportOpen(false); }}>
            <div style={MODAL}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <b style={{ fontSize: 14.5 }}>从数据集导入匹配</b>
                <span style={{ flex: 1 }} />
                <button style={BTN_GHOST} onClick={() => setImportOpen(false)}>✕ 关闭</button>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', marginBottom: 12, lineHeight: 1.6 }}>
                按<b style={{ color: 'var(--foreground-secondary)' }}>任务输入精确匹配</b>回填参考输出；已标注的 case 会跳过，不覆盖人工标注。
              </div>
              {datasets.length === 0 ? (
                <div style={{ padding: 22, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)', border: '1px dashed var(--border-dark)', borderRadius: 10 }}>
                  暂无可用数据集
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                  {datasets.map((ds) => (
                    <button
                      key={ds.id}
                      onClick={() => importFromDataset(ds)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', cursor: 'pointer',
                        border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px',
                        background: 'var(--card-bg)', color: 'var(--foreground)', fontFamily: 'inherit',
                      }}
                    >
                      <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{ds.name}</span>
                      {ds.targetAgent && <span style={CHIP_MUT}>{ds.targetAgent}</span>}
                      <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>{ds.caseCount ?? (ds.cases ?? []).length} 条</span>
                    </button>
                  ))}
                </div>
              )}
              {datasetHint && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--primary)' }}>{datasetHint}</div>
              )}
            </div>
          </div>
        )}

        {/* ③ 存为数据集：已标注成果沉淀 */}
        {saveOpen && (
          <div style={MODAL_OV} onClick={(e) => { if (e.target === e.currentTarget) setSaveOpen(false); }}>
            <div style={MODAL}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <b style={{ fontSize: 14.5 }}>存为数据集</b>
                <span style={{ flex: 1 }} />
                <button style={BTN_GHOST} onClick={() => setSaveOpen(false)}>✕ 关闭</button>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', marginBottom: 12, lineHeight: 1.6 }}>
                将 <b style={{ color: 'var(--primary)' }}>{persistable}</b> 条参考答案或 Tool/Skill 目录存为评测数据集，后续实验可直接导入复用。
              </div>
              <label style={FIELDLBL}>数据集名称</label>
              <input
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
                placeholder={`${name.trim() || '实验'}-预期答案`}
                style={{
                  width: '100%', height: 34, borderRadius: 8, border: '1px solid var(--input-border)',
                  background: 'var(--input-bg)', color: 'var(--foreground)', padding: '0 11px', fontSize: 13, outline: 'none',
                }}
              />
              {datasetHint && (
                <div style={{ marginTop: 12, fontSize: 12, color: datasetHint.startsWith('保存失败') ? 'var(--error)' : 'var(--primary)' }}>
                  {datasetHint}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 16 }}>
                <button style={BTN_GHOST} onClick={() => setSaveOpen(false)}>取消</button>
                <button style={{ ...BTN_PRIMARY, opacity: datasetBusy ? 0.6 : 1 }} disabled={datasetBusy} onClick={saveAsDataset}>
                  {datasetBusy ? '保存中…' : '保存数据集'}
                </button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    </>
  );
}
