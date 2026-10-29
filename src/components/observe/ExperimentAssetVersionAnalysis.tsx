/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/components/shell/PageContainer';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import type { AnalysisVariable, ExperimentAssetAnalysis, ExperimentAnalysisGroup, ExperimentAnalysisRun } from '@/lib/evaluation-assets/experiment-analysis';

const VARIABLES: Array<{ key: AnalysisVariable; label: string }> = [
  { key: 'agent', label: 'Agent' }, { key: 'skill', label: 'Skill' },
  { key: 'evaluator', label: '评估器' }, { key: 'dataset', label: '评测集' },
];
type ResponseData = ExperimentAssetAnalysis & { meta: { limit: number; returned: number; truncated: boolean } };
const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';
const scoreText = (score: number | null) => score == null ? '未评分' : score.toFixed(1);
const dateText = (date: string) => new Date(date).toLocaleString();

export function ExperimentAssetVersionAnalysis() {
  const { user, apiKey, authReady } = useAuth();
  const [selected, setSelected] = useState<AnalysisVariable[]>(['agent']);
  const [data, setData] = useState<ResponseData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [groupLimit, setGroupLimit] = useState(12);
  const [rowLimit, setRowLimit] = useState(50);

  useEffect(() => {
    setData(null);
    if (!authReady) return;
    if (!apiKey || !user) { setError('请使用有效登录账号查看实验资产版本分析。'); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    apiFetch('/api/evaluation-assets/experiments', { headers: { 'x-witty-api-key': apiKey }, signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '读取实验资产分析失败');
        return body as ResponseData;
      })
      .then(body => { if (!controller.signal.aborted) setData(body); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [apiKey, user, authReady, refresh]);

  const runs = useMemo(() => new Map(data?.runs.map(run => [run.id, run]) || []), [data]);
  const groups = useMemo(() => (data?.groups || []).filter(group => selected.includes(group.variable))
    .sort((a, b) => b.versionCount - a.versionCount || VARIABLES.findIndex(item => item.key === a.variable) - VARIABLES.findIndex(item => item.key === b.variable)), [data, selected]);

  return <>
    <PageHeader title="实验资产版本分析" description="勾选要观察的变化项；每张图只比较一个变化项，其余条件保持相同。" actions={
      <Button size="sm" variant="outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw className="size-4" />刷新</Button>
    } />
    <div className="mb-3 flex flex-wrap items-center gap-5" aria-label="要观察的版本变化项">
      {VARIABLES.map(item => <label key={item.key} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={selected.includes(item.key)} className="size-4 accent-primary" onChange={event => {
          setSelected(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key)); setGroupLimit(12);
        }} />{item.label}
      </label>)}
    </div>
    <p className="mb-4 text-xs leading-5 text-foreground-muted">四项都勾选表示分别查看四类趋势。同一类存在不同的固定配置时，会分成多张图。固定条件依据实验保存的配置；未指定的默认模型仍需用户确认一致。Agent 版本来自用户登记，不代表平台已验证客户端加载内容。分数为已完成评估器结果的均分，优先采用人工修正分；未评分和失败结果不记为 0。</p>
    {loading && <div className="flex items-center gap-2 py-12 text-sm text-foreground-muted"><Loader2 className="size-4 animate-spin" />正在读取实验记录…</div>}
    {error && <div role="alert" className="mb-4 rounded-lg border border-border bg-card p-4 text-sm text-foreground">{error}</div>}
    {data && <>
      <p className="mb-4 text-xs text-foreground-muted">{data.meta.truncated ? `仅显示最近 ${data.meta.limit} 条实验，历史记录已截断，本页不代表全部实验。` : `当前账号共 ${data.meta.returned} 条实验记录。`} 每次运行分别保留，相同版本的重复实验不会合并。</p>
      {!selected.length ? <Notice>勾选上方至少一项，查看该项的版本变化。</Notice>
        : !groups.length ? <Notice>暂无符合条件的版本趋势。需要已完成实验记录，并记录 Agent、评测集、评估器版本；使用 Skill 时也需要记录其版本。旧实验仍可在下方列表查看。</Notice>
          : <div className="space-y-5">{groups.slice(0, groupLimit).map(group => <TrendCard key={group.id} group={group} runs={group.runIds.map(id => runs.get(id)!).filter(Boolean)} />)}
            {groups.length > groupLimit && <Button variant="outline" size="sm" onClick={() => setGroupLimit(value => value + 12)}>继续显示固定配置（还有 {groups.length - groupLimit} 组）</Button>}
          </div>}
      <section className="mt-6 rounded-lg border border-border bg-card">
        <div className="border-b border-border p-4"><h2 className="text-sm font-semibold text-foreground">实验记录</h2><p className="mt-1 text-xs text-foreground-muted">点击名称进入原实验详情。未记录资产版本的历史实验保留原样，不推断版本。</p></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead className="bg-muted/40 text-foreground-muted"><tr>{['实验 / 时间', 'Agent', 'Skill', '评估器', '评测集', '均分 / 覆盖率', '状态 / 说明'].map(text => <th className="px-4 py-3 font-medium" key={text}>{text}</th>)}</tr></thead>
          <tbody>{data.runs.slice(0, rowLimit).map(run => <tr key={run.id} className="border-t border-border text-foreground">
            <td className="px-4 py-3"><ExperimentLink run={run} /><div className="mt-1 whitespace-nowrap text-foreground-muted">{dateText(run.createdAt)}</div></td>
            {VARIABLES.map(item => <td key={item.key} className="max-w-64 px-4 py-3 break-words">{run.assets[item.key].label}</td>)}
            <td className="px-4 py-3 whitespace-nowrap">{scoreText(run.score)}<div className="mt-1 text-foreground-muted">{coverageText(run)}</div></td>
            <td className="max-w-64 px-4 py-3">{statusText(run.status)}{run.reason && <div className="mt-1 text-foreground-muted">{run.reason}</div>}</td>
          </tr>)}</tbody>
        </table>{!data.runs.length && <div className="p-6 text-center text-sm text-foreground-muted">当前账号还没有实验记录。创建并执行实验后可在这里查看。</div>}</div>
        {data.runs.length > rowLimit && <div className="p-4"><Button variant="outline" size="sm" onClick={() => setRowLimit(value => value + 50)}>显示更多实验</Button></div>}
      </section>
    </>}
  </>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-border bg-card p-6 text-sm text-foreground-muted">{children}</div>;
}
function statusText(status: string) {
  return ({ done: '已完成', partial: '部分完成', failed: '失败', draft: '草稿', running: '执行中' } as Record<string, string>)[status] || status;
}
function coverageText(run: ExperimentAnalysisRun) {
  return `${(run.coverage * 100).toFixed(0)}%（${run.scoredResults}/${run.expectedResults} 项有分）`;
}
function ExperimentLink({ run }: { run: ExperimentAnalysisRun }) {
  return <Link prefetch={false} className="text-primary hover:underline" href={`${basePath}/experiments/${encodeURIComponent(run.id)}`}>{run.name || run.id}</Link>;
}
function TrendCard({ group, runs }: { group: ExperimentAnalysisGroup; runs: ExperimentAnalysisRun[] }) {
  const variableName = VARIABLES.find(item => item.key === group.variable)!.label;
  const points = runs.map((run, index) => ({ sequence: index + 1, score: run.score, name: run.assets[group.variable].label, run }));
  return <section className="rounded-lg border border-border bg-card">
    <div className="border-b border-border p-4">
      <h2 className="text-sm font-semibold text-foreground">{variableName} 版本变化 · {group.versionCount} 种版本配置 · {runs.length} 次运行</h2>
      <p className="mt-1 text-xs text-foreground-muted">以下记录的固定条件一致时才归为本图。条件不同的实验会放入其他图。</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs md:grid-cols-2">{group.conditions.map(condition => <div key={condition.label} className="flex gap-2"><dt className="shrink-0 text-foreground-muted">{condition.label}：</dt><dd className="min-w-0 break-words text-foreground">{condition.value}</dd></div>)}</dl>
      {group.warning && <p className="mt-3 text-xs text-foreground-muted">{group.warning}</p>}
    </div>
    {group.versionCount > 1 ? <div className="p-4"><p className="mb-2 text-xs text-foreground-muted">横轴为运行顺序，每次运行一个点；悬浮查看对应版本，均分需结合覆盖率判断。</p>
      <div className="h-56 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{ left: 0, right: 20, top: 10, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="sequence" tick={{ fill: 'var(--foreground-muted)', fontSize: 11 }} /><YAxis domain={[0, 100]} tick={{ fill: 'var(--foreground-muted)', fontSize: 11 }} />
        <Tooltip content={({ active, payload }) => {
          const point = payload?.[0]?.payload as typeof points[number] | undefined;
          return active && point ? <div className="max-w-sm rounded-md border border-border bg-card p-3 text-xs shadow-md"><p>{point.name}</p><p className="mt-1">{point.run.name} · {scoreText(point.score)} 分</p><p>{coverageText(point.run)}</p><p>{dateText(point.run.createdAt)}</p></div> : null;
        }} /><Line type="linear" dataKey="score" stroke="var(--primary)" strokeWidth={2} dot={{ r: 4 }} connectNulls={false} />
      </LineChart></ResponsiveContainer></div>
    </div> : <p className="px-4 py-3 text-xs text-foreground-muted">当前固定条件下仅有一种版本配置，尚不能判断版本变化。后续使用相同固定条件运行其他版本即可对比。</p>}
    <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-muted/40 text-foreground-muted"><tr>{['运行顺序', '变化项版本', '实验', '时间', '均分', '评分覆盖率'].map(text => <th key={text} className="px-4 py-2 font-medium">{text}</th>)}</tr></thead>
      <tbody>{runs.map((run, index) => <tr className="border-t border-border text-foreground" key={run.id}><td className="px-4 py-2">{index + 1}</td><td className="px-4 py-2">{run.assets[group.variable].label}</td><td className="px-4 py-2"><ExperimentLink run={run} /></td><td className="px-4 py-2 whitespace-nowrap">{dateText(run.createdAt)}</td><td className="px-4 py-2">{scoreText(run.score)}</td><td className="px-4 py-2">{coverageText(run)}</td></tr>)}</tbody>
    </table></div>
  </section>;
}
