'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Download, HelpCircle, Loader2, Tag } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer, PageHeader, PageToolbar } from '@/components/shell/PageContainer';
import { Button } from '@/components/ui/button';
import { Select, type SelectOption } from '@/components/ui/select';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';
import { cn } from '@/lib/utils';
import type { VersionAnalysisTrace, VersionCompareResponse, VersionMetric, VersionTracesResponse } from '@/lib/version-analysis';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

type MetricKey = 'taskCompletion' | 'tokens' | 'latency' | 'cost';
type WindowKey = '1h' | '1d' | '7d' | '30d' | 'all';
type AnalysisView = 'compare' | 'detail';

type AgentInfo = { name: string; traceCount?: number };
type FacetValue = { value: string; count: number };

function strings(locale: string) {
  const zh = locale.toLowerCase().startsWith('zh');
  if (zh) {
    return {
      title: '版本分析',
      subtitle: '按版本标签聚合 root Trace，对比质量、成本和性能指标',
      manageTags: '版本管理',
      exportData: '导出数据',
      exportEmpty: '没有可导出的版本分析数据',
      agent: 'Agent',
      framework: '框架',
      window: '时间窗口',
      question: '问题',
      metric: '指标',
      all: '全部',
      allQuestions: '全部问题（聚合）',
      allAgents: '全部 Agent',
      allFrameworks: '全部框架',
      last1h: '近 1 时',
      last1d: '近 1 天',
      last7d: '近 7 天',
      last30d: '近 30 天',
      allTime: '全部时间',
      taskCompletion: '平均任务完成度',
      traceTaskCompletion: '任务完成度',
      taskCompletionHelp: '满分 100 分。取每条 Trace 最新一次成功的「Agent 任务完成度」实验评测结果；存在人工修正时优先使用人工评分。',
      taskCompletionCoverageHelp: '有任务完成度评分的 Trace 数占全部 Trace 的比例。',
      tokens: '平均 Token',
      latency: 'p95 时延',
      cost: '单次成本',
      overview: '版本总览',
      versionTagCount: '版本标签',
      traceTotal: 'Trace 总数',
      availableTags: '可用标签',
      currentWindow: '当前时间窗口',
      compareChartAll: '跨版本指标演进 · 全部问题',
      compareChartQuestion: '跨版本指标演进 · 单问题',
      compareTableAll: '版本对比明细 · 全部问题',
      compareTableQuestion: '版本对比明细 · 单问题',
      compareTableHint: '按版本名排序',
      detailOverview: '单版本指标概览',
      detailChartTitle: '版本内 Trace 指标趋势',
      detailChartHint: '每个点=一条 Trace；点击可进入 Trace 详情；警告色=未完成 Trace。',
      openTraceHint: '点击节点可在新页面打开 Trace 详情',
      compare: '版本对比',
      detail: '版本详情',
      compareObject: '对比对象',
      compareHint: '全部聚合 / 下钻单问题',
      questions: '问题覆盖',
      traces: 'Trace 明细',
      traceCount: 'Trace 数',
      scoreCoverage: '任务完成度评测覆盖率',
      runSuccessRate: '运行成功率',
      noTagsTitle: '还没有版本标签',
      noTagsDesc: '先在版本管理中新建版本标签，再从链路追踪给 Trace 打标。',
      noTraceTitle: '当前筛选下没有已打版本标签的 Trace',
      noTraceDesc: '调整筛选条件，或先在链路追踪中给 Trace 绑定版本标签。',
      loadFailed: '加载版本分析失败',
      detailFailed: '加载版本详情失败',
      derivedHint: '口径：只统计 root Trace；任务完成度取该 Trace 在实验中最新一次成功的「Agent 任务完成度」评测生效分（人工修正分优先）；运行成功率由 Trace 完成状态派生。版本分析暂不支持业务标签二次过滤。',
      selected: '版本标签',
      description: '说明',
      noDesc: '无说明',
      created: '创建时间',
      query: '任务',
      time: '时间',
      status: '状态',
      viewTrace: '查看 Trace',
      running: '运行中',
      success: '成功',
      loading: '加载中...',
      chartHint: '曲线节点可点击；版本对比节点进入版本详情，版本详情节点进入 Trace 详情。',
    };
  }
  return {
    title: 'Version Analysis',
    subtitle: 'Compare root traces grouped by version tags across quality and cost metrics',
    manageTags: 'Manage tags',
    exportData: 'Export data',
    exportEmpty: 'No version analysis data to export',
    agent: 'Agent',
    framework: 'Framework',
    window: 'Window',
    question: 'Question',
    metric: 'Metric',
    all: 'All',
    allQuestions: 'All questions',
    allAgents: 'All agents',
    allFrameworks: 'All frameworks',
    last1h: 'Last 1h',
    last1d: 'Last 1d',
    last7d: 'Last 7d',
    last30d: 'Last 30d',
    allTime: 'All time',
    taskCompletion: 'Avg task completion',
    traceTaskCompletion: 'Task completion',
    taskCompletionHelp: 'Scored out of 100 using the latest successful Agent Task Completion experiment result for each trace. Human overrides take precedence.',
    taskCompletionCoverageHelp: 'The percentage of traces that have a task completion score.',
    tokens: 'Avg tokens',
    latency: 'P95 latency',
    cost: 'Avg cost',
    overview: 'Version overview',
    versionTagCount: 'Version tags',
    traceTotal: 'Total traces',
    availableTags: 'Available tags',
    currentWindow: 'Current window',
    compareChartAll: 'Cross-version metric trend · All questions',
    compareChartQuestion: 'Cross-version metric trend · Single question',
    compareTableAll: 'Version comparison details · All questions',
    compareTableQuestion: 'Version comparison details · Single question',
    compareTableHint: 'Sorted by version name',
    detailOverview: 'Single-version metric overview',
    detailChartTitle: 'In-version trace metric trend',
    detailChartHint: 'Each point is one Trace; click to open Trace detail; warning color marks unfinished Trace.',
    openTraceHint: 'Click a node to open Trace detail in a new page',
    compare: 'Version comparison',
    detail: 'Version detail',
    compareObject: 'Compare object',
    compareHint: 'Aggregate / drill into one question',
    questions: 'Question coverage',
    traces: 'Trace details',
    traceCount: 'Traces',
    scoreCoverage: 'Task completion coverage',
    runSuccessRate: 'Run success rate',
    noTagsTitle: 'No version tags yet',
    noTagsDesc: 'Create version tags, then attach them to traces from Trace.',
    noTraceTitle: 'No tagged traces match the current filters',
    noTraceDesc: 'Adjust filters or attach version tags from Trace first.',
    loadFailed: 'Failed to load version analysis',
    detailFailed: 'Failed to load version detail',
    derivedHint: 'Root traces only. Task completion uses the latest successful Agent Task Completion result from experiments, with human overrides taking precedence. Run success rate is derived from trace completion state.',
    selected: 'Version tag',
    description: 'Description',
    noDesc: 'No description',
    created: 'Created',
    query: 'Task',
    time: 'Time',
    status: 'Status',
    viewTrace: 'View trace',
    running: 'Running',
    success: 'Success',
    loading: 'Loading...',
    chartHint: 'Chart nodes are clickable: comparison nodes open version detail, detail nodes open Trace.',
  };
}

function metricOptions(copy: ReturnType<typeof strings>): SelectOption<MetricKey>[] {
  return [
    { value: 'taskCompletion', label: copy.taskCompletion },
    { value: 'tokens', label: copy.tokens },
    { value: 'latency', label: copy.latency },
    { value: 'cost', label: copy.cost },
  ];
}

function windowOptions(copy: ReturnType<typeof strings>): SelectOption<WindowKey>[] {
  return [
    { value: '1h', label: copy.last1h },
    { value: '1d', label: copy.last1d },
    { value: '7d', label: copy.last7d },
    { value: '30d', label: copy.last30d },
    { value: 'all', label: copy.allTime },
  ];
}

function getWindowRange(windowKey: WindowKey): { from?: string; to?: string } {
  if (windowKey === 'all') return {};
  const hours = windowKey === '1h' ? 1 : windowKey === '1d' ? 24 : windowKey === '7d' ? 24 * 7 : 24 * 30;
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function metricValue(version: VersionMetric, metric: MetricKey): number | null {
  switch (metric) {
    case 'taskCompletion': return version.taskCompletionScoreAvg;
    case 'tokens': return version.avgTokens;
    case 'latency': return version.p95LatencySec;
    case 'cost': return version.avgCost;
  }
}

function traceMetricValue(trace: VersionAnalysisTrace, metric: MetricKey): number | null {
  switch (metric) {
    case 'taskCompletion': return trace.taskCompletionScore;
    case 'tokens': return trace.tokens;
    case 'latency': return trace.latencySec;
    case 'cost': return trace.cost;
  }
}

function metricColor(metric: MetricKey): string {
  if (metric === 'taskCompletion') return 'var(--success)';
  if (metric === 'tokens') return 'var(--warning)';
  if (metric === 'latency') return '#0ea5e9';
  return '#14b8a6';
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  const trim = (text: string) => text.endsWith('.0') ? text.slice(0, -2) : text;
  if (abs >= 1000000) return trim((value / 1000000).toFixed(abs >= 10000000 ? 0 : 1)) + 'M';
  if (abs >= 1000) return trim((value / 1000).toFixed(abs >= 100000 ? 0 : 1)) + 'k';
  return Math.round(value).toLocaleString();
}

function formatLatency(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value < 1) return Math.round(value * 1000).toLocaleString() + 'ms';
  if (value < 60) return value.toFixed(value < 10 ? 1 : 0) + 's';
  return (value / 60).toFixed(value < 600 ? 1 : 0) + 'm';
}

function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return String.fromCharCode(36) + value.toFixed(value < 0.01 ? 5 : 4);
}

function formatChartTick(value: number, metric: MetricKey, locale: string): string {
  if (!Number.isFinite(value)) return '';
  switch (metric) {
    case 'taskCompletion': return locale.toLowerCase().startsWith('zh') ? `${Math.round(value)}分` : `${Math.round(value)} pts`;
    case 'tokens': return formatCompactNumber(value);
    case 'latency': return formatLatency(value);
    case 'cost': return formatCurrency(value);
  }
}

function formatMetric(value: number | null | undefined, metric: MetricKey, locale: string): string {
  if (value == null || !Number.isFinite(value)) return '-';
  switch (metric) {
    case 'taskCompletion': return locale.toLowerCase().startsWith('zh') ? `${value.toFixed(1)} 分` : `${value.toFixed(1)} pts`;
    case 'tokens': return formatCompactNumber(value);
    case 'latency': return formatLatency(value);
    case 'cost': return formatCurrency(value);
  }
}
function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(0)}%`;
}

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

async function readApiError(res: Response, fallback: string) {
  try {
    const data = await res.json();
    return String(data?.error || fallback);
  } catch {
    return fallback;
  }
}

export default function VersionAnalysisPage() {
  const { user } = useAuth();
  const { locale } = useLocale();
  const copy = strings(locale);

  const [activeView, setActiveView] = useState<AnalysisView>('compare');
  const [agent, setAgent] = useState('all');
  const [framework, setFramework] = useState('all');
  const [windowKey, setWindowKey] = useState<WindowKey>('7d');
  const [questionKey, setQuestionKey] = useState('all');
  const [metric, setMetric] = useState<MetricKey>('tokens');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [frameworks, setFrameworks] = useState<FacetValue[]>([]);
  const [data, setData] = useState<VersionCompareResponse | null>(null);
  const [details, setDetails] = useState<VersionTracesResponse | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const buildParams = useCallback((includeQuestion = true) => {
    const params = new URLSearchParams();
    if (user) params.set('user', user);
    if (agent !== 'all') params.set('agent', agent);
    if (framework !== 'all') params.set('framework', framework);
    const range = getWindowRange(windowKey);
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    if (includeQuestion && questionKey !== 'all') params.set('questionKey', questionKey);
    return params;
  }, [agent, framework, questionKey, user, windowKey]);

  useEffect(() => {
    if (!user) return;
    apiFetch(`/api/quality/agents?user=${encodeURIComponent(user)}`)
      .then(res => res.ok ? res.json() : Promise.reject(res))
      .then(json => setAgents(Array.isArray(json?.agents) ? json.agents : []))
      .catch(() => setAgents([]));
    apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&facet=values&column=framework`)
      .then(res => res.ok ? res.json() : Promise.reject(res))
      .then(json => setFrameworks(Array.isArray(json) ? json : []))
      .catch(() => setFrameworks([]));
  }, [user]);

  const loadCompare = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/observe/version-analysis/compare?${buildParams().toString()}`);
      if (!res.ok) throw new Error(await readApiError(res, copy.loadFailed));
      const json = await res.json();
      setData(json);
    } catch (error: any) {
      toast.error(error?.message || copy.loadFailed);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [buildParams, copy.loadFailed, user]);

  useEffect(() => {
    loadCompare();
  }, [loadCompare]);

  useEffect(() => {
    if (!data?.versions.length) {
      setSelectedVersionId(null);
      return;
    }
    if (selectedVersionId && data.versions.some(version => version.tag.id === selectedVersionId)) return;
    const firstWithTrace = data.versions.find(version => version.traceCount > 0) ?? data.versions[0];
    setSelectedVersionId(firstWithTrace.tag.id);
  }, [data, selectedVersionId]);

  useEffect(() => {
    if (!user || !selectedVersionId) {
      setDetails(null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    const params = buildParams(false);
    params.set('limit', '100');
    apiFetch(`/api/observe/version-analysis/tags/${encodeURIComponent(selectedVersionId)}/traces?${params.toString()}`)
      .then(async res => {
        if (!res.ok) throw new Error(await readApiError(res, copy.detailFailed));
        return res.json();
      })
      .then(json => { if (alive) setDetails(json); })
      .catch((error: any) => { if (alive) { toast.error(error?.message || copy.detailFailed); setDetails(null); } })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [buildParams, copy.detailFailed, selectedVersionId, user]);

  const agentOptions: SelectOption[] = useMemo(() => [
    { value: 'all', label: copy.allAgents },
    ...agents.map(item => ({ value: item.name, label: `${item.name}${item.traceCount ? ` (${item.traceCount})` : ''}` })),
  ], [agents, copy.allAgents]);

  const frameworkOptions: SelectOption[] = useMemo(() => [
    { value: 'all', label: copy.allFrameworks },
    ...frameworks.map(item => ({ value: item.value, label: `${item.value} (${item.count})` })),
  ], [copy.allFrameworks, frameworks]);

  const questionOptions: SelectOption[] = useMemo(() => [
    { value: 'all', label: copy.allQuestions },
    ...((data?.questions ?? []).slice(0, 80).map(item => ({ value: item.key, label: `${item.label} (${item.traceCount})` }))),
  ], [copy.allQuestions, data?.questions]);

  const versions = data?.versions ?? [];
  const summary = data?.summary ?? null;
  const activeWindowLabel = windowOptions(copy).find(option => option.value === windowKey)?.label ?? copy.allTime;
  const summaryCards = summary ? [
    { label: copy.versionTagCount, value: summary.versionTagCount.toLocaleString(), detail: copy.availableTags, tone: 'var(--foreground)' },
    { label: copy.traceTotal, value: summary.traceCount.toLocaleString(), detail: activeWindowLabel, tone: 'var(--foreground)' },
    { label: copy.taskCompletion, help: copy.taskCompletionHelp, value: formatMetric(summary.taskCompletionScoreAvg, 'taskCompletion', locale), detail: copy.currentWindow, tone: 'var(--success)' },
    { label: copy.tokens, value: formatMetric(summary.avgTokens, 'tokens', locale), detail: copy.currentWindow, tone: 'var(--warning)' },
    { label: copy.latency, value: formatMetric(summary.p95LatencySec, 'latency', locale), detail: copy.currentWindow, tone: '#0ea5e9' },
    { label: copy.cost, value: formatMetric(summary.avgCost, 'cost', locale), detail: copy.currentWindow, tone: '#14b8a6' },
  ] : [];
  const versionOptions: SelectOption[] = useMemo(() => versions.map(version => ({
    value: version.tag.id,
    label: version.tag.name + (version.traceCount ? ' (' + version.traceCount.toLocaleString() + ')' : ''),
  })), [versions]);
  const hasVersionTags = versions.length > 0;
  const hasTraceData = versions.some(version => version.traceCount > 0);
  const selectedVersion = versions.find(version => version.tag.id === selectedVersionId) ?? null;
  const chartData = versions.map(version => ({
    id: version.tag.id,
    name: version.tag.name,
    color: version.tag.color,
    value: metricValue(version, metric),
    traceCount: version.traceCount,
  }));
  const detailChartData = (details?.traces ?? [])
    .slice()
    .reverse()
    .map((trace, index) => ({
      index: index + 1,
      value: traceMetricValue(trace, metric),
      status: trace.traceStatus,
      label: formatDateTime(trace.timestamp),
      query: trace.query,
      taskCompletionScore: trace.taskCompletionScore,
      tokens: trace.tokens,
      latencySec: trace.latencySec,
      cost: trace.cost,
      traceHref: basePath + '/trace?taskId=' + encodeURIComponent(trace.taskId || trace.id),
    }));

  const handleExport = useCallback(() => {
    if (!data) {
      toast.error(copy.exportEmpty);
      return;
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      filters: {
        agent,
        framework,
        window: windowKey,
        questionKey,
        metric,
      },
      versions: data.versions,
      questions: data.questions,
      selectedVersion,
      selectedVersionDetails: details,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeTime = payload.exportedAt.replace(/[:.]/g, '-');
    link.href = url;
    link.download = 'version-analysis-' + safeTime + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [agent, copy.exportEmpty, data, details, framework, metric, questionKey, selectedVersion, windowKey]);

  return (
    <>
      <AppTopBar title={copy.title} showDefaultActions={false} />
      <PageContainer variant="wide" className="bg-background">
        <PageHeader
          title={copy.title}
          description={copy.subtitle}
          actions={(
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExport} disabled={!data || loading}>
                <Download className="size-4" />{copy.exportData}
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href={basePath + '/version-management'}><Tag className="size-4" />{copy.manageTags}</Link>
              </Button>
            </div>
          )}
        />

        <PageToolbar className="items-center">
          <Select value={agent} onChange={setAgent} options={agentOptions} label={copy.agent} active={agent !== 'all'} />
          <Select value={framework} onChange={setFramework} options={frameworkOptions} label={copy.framework} active={framework !== 'all'} />
          <Select value={windowKey} onChange={setWindowKey} options={windowOptions(copy)} label={copy.window} active={windowKey !== '7d'} />
        </PageToolbar>


        {summaryCards.length > 0 && (
          <section className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label={copy.overview}>
            {summaryCards.map(item => (
              <SummaryCard key={item.label} label={item.label} help={'help' in item ? item.help : undefined} value={item.value} detail={item.detail} tone={item.tone} />
            ))}
          </section>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-foreground-muted">
            <Loader2 className="size-4 animate-spin" />
            {copy.loading}
          </div>
        ) : !hasVersionTags ? (
          <EmptyState
            icon={Tag}
            title={copy.noTagsTitle}
            description={copy.noTagsDesc}
            action={<Button asChild><Link href={`${basePath}/version-management`}>{copy.manageTags}</Link></Button>}
          />
        ) : !hasTraceData ? (
          <EmptyState icon={Activity} title={copy.noTraceTitle} description={copy.noTraceDesc} />
        ) : (
          <div className="space-y-4">
            <div className="inline-flex rounded-md border border-border bg-background p-1 shadow-sm">
              <button type="button" onClick={() => setActiveView('compare')} className={cn('inline-flex h-8 items-center gap-2 rounded-sm px-3 text-sm font-medium text-foreground-muted hover:text-foreground', activeView === 'compare' && 'bg-primary text-primary-foreground shadow-sm hover:text-primary-foreground')}><BarChart3 className="size-4" />{copy.compare}</button>
              <button type="button" onClick={() => setActiveView('detail')} className={cn('inline-flex h-8 items-center gap-2 rounded-sm px-3 text-sm font-medium text-foreground-muted hover:text-foreground', activeView === 'detail' && 'bg-primary text-primary-foreground shadow-sm hover:text-primary-foreground')}><Activity className="size-4" />{copy.detail}</button>
            </div>
            <div className={cn('grid gap-4', activeView === 'compare' ? 'xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]' : 'xl:grid-cols-1')}>
              <section className={cn('rounded-md border border-border bg-card overflow-hidden', activeView !== 'compare' && 'hidden')}>
                <div className="border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground">{copy.compareObject}</h2>
                  <p className="mt-1 text-xs text-foreground-muted">{copy.compareHint}</p>
                </div>
                <div className="max-h-[520px] overflow-y-auto p-2">
                  <button type="button" onClick={() => setQuestionKey('all')} className={cn('mb-1 flex w-full items-start justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-background-secondary', questionKey === 'all' && 'bg-primary-subtle text-primary')}><span className="font-medium text-foreground-secondary">{copy.allQuestions}</span><span className="text-xs text-foreground-muted">{data?.questions.length ?? 0}</span></button>
                  <div className="my-2 h-px bg-border" />
                  {(data?.questions ?? []).slice(0, 80).map(question => (
                    <button key={question.key} type="button" onClick={() => setQuestionKey(question.key)} className={cn('mb-1 flex w-full items-start justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-background-secondary', questionKey === question.key && 'bg-primary-subtle text-primary')}><span className="line-clamp-2 min-w-0 text-foreground-secondary">{question.label}</span><span className="shrink-0 text-xs tabular-nums text-foreground-muted">{question.traceCount}</span></button>
                  ))}
                </div>
              </section>
            <div className={cn('space-y-4 min-w-0', activeView !== 'compare' && 'hidden')}>
              <section className="rounded-md border border-border bg-card p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-foreground">{questionKey === 'all' ? copy.compareChartAll : copy.compareChartQuestion}</h2>
                    <p className="mt-1 text-xs text-foreground-muted">{copy.traceCount}: {versions.reduce((sum, version) => sum + version.traceCount, 0).toLocaleString()}</p>
                  </div>
                  <MetricSelector value={metric} onChange={setMetric} copy={copy} />
                </div>
                <div className="h-72 min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 14, right: 18, bottom: 4, left: -4 }} onClick={(state: any) => {
                      const id = state?.activePayload?.[0]?.payload?.id;
                      if (id) { setSelectedVersionId(id); setActiveView('detail'); }
                    }}>
                      <defs>
                        <linearGradient id="versionCompareFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={metricColor(metric)} stopOpacity="0.18" />
                          <stop offset="100%" stopColor={metricColor(metric)} stopOpacity="0.02" />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} interval={0} minTickGap={8} />
                      <YAxis tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} tickFormatter={(value) => formatChartTick(Number(value), metric, locale)} width={64} />
                      <Tooltip
                        cursor={{ stroke: 'var(--border-dark)', strokeDasharray: '4 4' }}
                        formatter={(value: any) => [formatMetric(Number(value), metric, locale), copy[metric]]}
                        labelStyle={{ color: 'var(--foreground)' }}
                        contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--foreground)' }}
                      />
                        <Line type="monotone" dataKey="value" stroke={metricColor(metric)} strokeWidth={2.8} dot={{ r: 4, strokeWidth: 2, stroke: 'var(--card-bg)', fill: metricColor(metric) }} activeDot={{ r: 6 }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="rounded-md border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground">{questionKey === 'all' ? copy.compareTableAll : copy.compareTableQuestion}</h2>
                  <span className="text-xs text-foreground-muted">{copy.compareTableHint}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-background-secondary text-xs text-foreground-muted">
                      <tr>
                        <Th>{copy.selected}</Th>
                        <Th>{copy.description}</Th>
                        <Th>{copy.traceCount}</Th>
                        <Th><MetricHelpLabel label={copy.taskCompletion} help={copy.taskCompletionHelp} /></Th>
                        <Th><MetricHelpLabel label={copy.scoreCoverage} help={copy.taskCompletionCoverageHelp} /></Th>
                        <Th>{copy.runSuccessRate}</Th>
                        <Th>{copy.tokens}</Th>
                        <Th>{copy.latency}</Th>
                        <Th>{copy.cost}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {versions.map(version => (
                        <tr
                          key={version.tag.id}
                          onClick={() => setSelectedVersionId(version.tag.id)}
                          className={cn('cursor-pointer border-t border-border hover:bg-background-secondary', selectedVersionId === version.tag.id && 'bg-primary-subtle')}
                        >
                          <Td>
                            <span className="inline-flex max-w-[240px] items-center gap-2 truncate font-medium text-foreground">
                              <span className="size-2.5 rounded-full" style={{ backgroundColor: version.tag.color }} />
                              <span className="truncate">{version.tag.name}</span>
                            </span>
                          </Td>
                          <Td><span className="line-clamp-2 max-w-[260px]">{version.tag.description || copy.noDesc}</span></Td>
                          <Td>{version.traceCount.toLocaleString()}</Td>
                          <Td>{formatMetric(version.taskCompletionScoreAvg, 'taskCompletion', locale)}</Td>
                          <Td>{formatPercent(version.taskCompletionScoreCoverage)}</Td>
                          <Td>{formatPercent(version.runSuccessRate)}</Td>
                          <Td>{formatMetric(version.avgTokens, 'tokens', locale)}</Td>
                          <Td>{formatMetric(version.p95LatencySec, 'latency', locale)}</Td>
                          <Td>{formatMetric(version.avgCost, 'cost', locale)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <aside className={cn('space-y-4 min-w-0', activeView !== 'detail' && 'hidden')}>
              <section className='rounded-md border border-border bg-card px-4 py-3'>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-foreground">{copy.detailOverview}</h2>
                </div>
                <div className='flex flex-wrap items-center gap-3'>
                  <div className='inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1'>
                    <span className='shrink-0 text-xs font-medium text-foreground-muted'>{copy.selected}</span>
                    <Select
                      value={selectedVersionId ?? ''}
                      onChange={(value) => setSelectedVersionId(value || null)}
                      options={versionOptions}
                      aria-label={copy.selected}
                      className='h-7 max-w-[180px] border-0 bg-background-secondary px-2 text-sm font-medium text-foreground hover:bg-background-secondary'
                    />
                  </div>
                  {selectedVersion && (
                    <div className='grid min-w-[520px] flex-1 grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6'>
                      <CompactMetric label={copy.traceCount} value={selectedVersion.traceCount.toLocaleString()} />
                      <CompactMetric label={copy.taskCompletion} help={copy.taskCompletionHelp} value={formatMetric(selectedVersion.taskCompletionScoreAvg, 'taskCompletion', locale)} />
                      <CompactMetric label={copy.tokens} value={formatMetric(selectedVersion.avgTokens, 'tokens', locale)} />
                      <CompactMetric label={copy.latency} value={formatMetric(selectedVersion.p95LatencySec, 'latency', locale)} />
                      <CompactMetric label={copy.cost} value={formatMetric(selectedVersion.avgCost, 'cost', locale)} />
                      <CompactMetric label={copy.runSuccessRate} value={formatPercent(selectedVersion.runSuccessRate)} />
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-md border border-border bg-card p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-foreground">{selectedVersion ? selectedVersion.tag.name + ' · ' + copy.detailChartTitle : copy.detailChartTitle}</h2>
                    <p className="mt-1 text-xs text-foreground-muted">{copy.detailChartHint}</p>
                  </div>
                  <MetricSelector value={metric} onChange={setMetric} copy={copy} />
                </div>
                <div className="h-48">
                  {detailLoading ? (
                    <div className="flex h-full items-center justify-center gap-2 text-sm text-foreground-muted"><Loader2 className="size-4 animate-spin" />{copy.loading}</div>
                  ) : detailChartData.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={detailChartData} margin={{ top: 8, right: 12, bottom: 2, left: -4 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="index" tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} />
                        <YAxis tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} tickFormatter={(value) => formatChartTick(Number(value), metric, locale)} width={64} />
                        <Tooltip
                          content={<TraceMetricTooltip metric={metric} copy={copy} locale={locale} />}
                          cursor={{ stroke: 'var(--border-dark)', strokeDasharray: '4 4' }}
                        />
                        <Line type='monotone' dataKey='value' stroke={metricColor(metric)} strokeWidth={2.8} dot={<TraceDot metric={metric} />} activeDot={<TraceDot metric={metric} active />} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-foreground-muted">-</div>
                  )}
                </div>
              </section>

              <section className="rounded-md border border-border bg-card overflow-hidden">
                <div className="border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground">{copy.questions}</h2>
                </div>
                <div className="max-h-64 overflow-y-auto p-2">
                  {(data?.questions ?? []).slice(0, 20).map(question => (
                    <div
                      key={question.key}
                      className="flex w-full items-start justify-between gap-3 rounded-md px-2 py-2 text-sm"
                    >
                      <span className="line-clamp-2 min-w-0 text-foreground-secondary">{question.label}</span>
                      <span className="shrink-0 text-xs tabular-nums text-foreground-muted">{question.traceCount}</span>
                    </div>
                  ))}
                </div>
              </section>
            </aside>

            <section className={cn('rounded-md border border-border bg-card overflow-hidden', activeView !== 'detail' && 'hidden')}>
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">{copy.traces}</h2>
                <span className="text-xs text-foreground-muted">{details?.total ?? 0}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-background-secondary text-xs text-foreground-muted">
                    <tr>
                      <Th>{copy.time}</Th>
                      <Th>{copy.status}</Th>
                      <Th>{copy.query}</Th>
                      <Th><MetricHelpLabel label={copy.traceTaskCompletion} help={copy.taskCompletionHelp} /></Th>
                      <Th>{copy.tokens}</Th>
                      <Th>{copy.latency}</Th>
                      <Th>{copy.cost}</Th>
                      <Th>{copy.viewTrace}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(details?.traces ?? []).map(trace => (
                      <tr key={trace.id} className="border-t border-border hover:bg-background-secondary">
                        <Td>{formatDateTime(trace.timestamp)}</Td>
                        <Td><StatusChip status={trace.traceStatus} copy={copy} /></Td>
                        <Td><span className="line-clamp-2 max-w-[360px] text-foreground-secondary">{trace.query || '-'}</span></Td>
                        <Td>{formatMetric(trace.taskCompletionScore, 'taskCompletion', locale)}</Td>
                        <Td>{formatMetric(trace.tokens, 'tokens', locale)}</Td>
                        <Td>{formatMetric(trace.latencySec, 'latency', locale)}</Td>
                        <Td>{formatMetric(trace.cost, 'cost', locale)}</Td>
                        <Td>
                          <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs">
                            <Link href={`${basePath}/trace?taskId=${encodeURIComponent(trace.taskId || trace.id)}`}>{copy.viewTrace}</Link>
                          </Button>
                        </Td>
                      </tr>
                    ))}
                    {!detailLoading && !(details?.traces ?? []).length && (
                      <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-foreground-muted">{copy.noTraceTitle}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          </div>
        )}
      </PageContainer>
    </>
  );
}

function MetricHelpLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <UiTooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button type="button" className="inline-flex text-foreground-muted hover:text-foreground-secondary" aria-label={`${label}说明`}>
            <HelpCircle className="size-3 cursor-help" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          sideOffset={6}
          hideArrow
          style={{ textWrap: 'wrap' }}
          className="max-w-[260px] whitespace-normal border border-border bg-card p-3 text-left text-xs leading-5 text-foreground shadow-md"
        >
          {help}
        </TooltipContent>
      </UiTooltip>
    </span>
  );
}

function SummaryCard({ label, help, value, detail, tone }: { label: string; help?: string; value: string; detail: React.ReactNode; tone: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="text-[11px] text-foreground-muted">{help ? <MetricHelpLabel label={label} help={help} /> : label}</div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums" style={{ color: tone }}>{value}</div>
      <div className="mt-1 truncate text-[11px] text-foreground-muted">{detail}</div>
    </div>
  );
}

function MetricSelector({ value, onChange, copy }: { value: MetricKey; onChange: (value: MetricKey) => void; copy: ReturnType<typeof strings> }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-md border border-border bg-background p-1">
      {metricOptions(copy).map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-foreground-muted hover:bg-background-secondary hover:text-foreground', value === option.value && 'bg-primary-subtle text-primary')}
        >
          <span className="size-2 rounded-full" style={{ backgroundColor: metricColor(option.value) }} />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function CompactMetric({ label, help, value }: { label: string; help?: string; value: string }) {
  return (
    <div className='min-w-0 rounded-sm border border-border bg-background px-2 py-1.5'>
      <div className='truncate text-[10px] leading-none text-foreground-muted'>{help ? <MetricHelpLabel label={label} help={help} /> : label}</div>
      <div className='mt-1 truncate text-xs font-semibold tabular-nums text-foreground'>{value}</div>
    </div>
  );
}

function TraceMetricTooltip({ active, payload, label, metric, copy, locale }: {
  active?: boolean;
  payload?: Array<{ payload?: any }>;
  label?: string | number;
  metric: MetricKey;
  copy: ReturnType<typeof strings>;
  locale: string;
}) {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  const statusText = item.status === 'success' ? copy.success : copy.running;

  return (
    <div className="min-w-60 max-w-80 rounded-md border border-border bg-card p-3 text-xs text-foreground shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-foreground">Trace #{label}</div>
          <div className="mt-0.5 text-[11px] text-foreground-muted">{item.label}</div>
        </div>
        <span className={cn('shrink-0 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium', item.status === 'success' ? 'border-success-subtle bg-success-subtle text-success' : 'border-error-border bg-error-subtle text-error')}>
          {statusText}
        </span>
      </div>
      {item.query && <div className="mt-2 line-clamp-2 text-foreground-secondary">{item.query}</div>}
      <div className="mt-3 grid gap-1.5">
        <MetricTooltipRow color="var(--success)" label={copy.traceTaskCompletion} value={formatMetric(item.taskCompletionScore, 'taskCompletion', locale)} />
        <MetricTooltipRow color="var(--warning)" label={copy.tokens} value={formatMetric(item.tokens, 'tokens', locale)} />
        <MetricTooltipRow color="#0ea5e9" label={copy.latency} value={formatMetric(item.latencySec, 'latency', locale)} />
        <MetricTooltipRow color="#14b8a6" label={copy.cost} value={formatMetric(item.cost, 'cost', locale)} />
      </div>
      <div className="mt-2 border-t border-border pt-2 text-[11px] font-medium text-primary">{copy.openTraceHint}</div>
    </div>
  );
}

function MetricTooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-foreground-muted">
        <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function TraceDot(props: any) {
  const { cx, cy, payload, metric, active } = props;
  if (cx == null || cy == null) return null;
  const href = payload?.traceHref;
  const color = payload?.status === 'success' ? metricColor(metric) : 'var(--error)';
  const node = (
    <g style={{ cursor: href ? 'pointer' : 'default' }}>
      <circle cx={cx} cy={cy} r={active ? 13 : 11} fill="transparent" />
      <circle cx={cx} cy={cy} r={active ? 10 : 8} fill={color} opacity={active ? 0.18 : 0.12} />
      <circle
        cx={cx}
        cy={cy}
        r={active ? 5.8 : 4.8}
        fill={color}
        stroke={active ? color : 'var(--card-bg)'}
        strokeWidth={active ? 1.5 : 2}
      >
        <title>{payload?.label ?? 'Trace'}</title>
      </circle>
    </g>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" aria-label="Open trace">
      {node}
    </a>
  ) : node;
}

function StatusChip({ status, copy }: { status: VersionAnalysisTrace['traceStatus']; copy: ReturnType<typeof strings> }) {
  const success = status === 'success';
  return (
    <span className={cn('inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium', success ? 'border-success-subtle bg-success-subtle text-success' : 'border-warning-subtle bg-warning-subtle text-warning')}>
      {success ? copy.success : copy.running}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-top text-foreground-secondary">{children}</td>;
}
