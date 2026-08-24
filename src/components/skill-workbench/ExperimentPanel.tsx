'use client';

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, GitCompareArrows, Loader2, MousePointerClick, Rows3 } from 'lucide-react';

import {
  ExperimentWizard,
  type SkillExperimentPreset,
} from '@/app/(main)/experiments/new/page';
import { apiFetch } from '@/lib/client/api';
import { SkillExperimentResult } from './SkillExperimentResult';

interface ExperimentRow {
  id: string;
  name: string;
  preset: SkillExperimentPreset | 'retest' | null;
  status: string;
  caseCount: number;
  createdAt: string;
  updatedAt: string;
}

const PRESETS: Array<{
  id: SkillExperimentPreset;
  label: string;
  action: string;
  description: string;
  icon: typeof FlaskConical;
}> = [
  { id: 'trigger', label: '触发分析', action: '新建触发实验 →', description: '验证该使用时是否选择、不该使用时是否误选。', icon: MousePointerClick },
  { id: 'use-case', label: '用例分析', action: '新建用例实验 →', description: '从通用实验配置开始验证任务效果。', icon: Rows3 },
  { id: 'skill-ab', label: 'A/B 测试', action: '新建版本实验 →', description: '默认对比两个 Skill 版本的实际效果。', icon: GitCompareArrows },
];

const PRESET_LABELS: Record<string, string> = {
  trigger: '触发分析',
  'use-case': '用例分析',
  'skill-ab': 'A/B 测试',
  retest: '候选复测',
};

const STATUS_LABELS: Record<string, string> = {
  draft: '运行中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
};

export function ExperimentPanel({
  user,
  skillName,
  version,
  optimizationRecordId,
  onError,
}: {
  user: string;
  skillName: string;
  version: number;
  optimizationRecordId?: string;
  onError: (message: string) => void;
}) {
  const [versions, setVersions] = useState<Array<{ id: string; version: number }>>([]);
  const [rows, setRows] = useState<ExperimentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<SkillExperimentPreset | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const contextResponse = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(skillName)}/experiments?user=${encodeURIComponent(user)}&version=${version}`,
        { cache: 'no-store' },
      );
      const context = await contextResponse.json();
      if (!contextResponse.ok) throw new Error(context.error || '加载 Skill 版本失败');
      setVersions(Array.isArray(context.versions) ? context.versions : []);
      setRows(Array.isArray(context.experiments) ? context.experiments : []);
    } catch (error) {
      onError(error instanceof Error ? error.message : '加载实验失败');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [onError, skillName, user, version]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (detailId) {
    return <SkillExperimentResult user={user} skillName={skillName} version={version} experimentId={detailId} onBack={() => { setDetailId(null); void load(); }} />;
  }

  if (preset) {
    return (
      <ExperimentWizard
        embedded
        skillContext={{ skillName, skillVersion: version, preset, versions, optimizationRecordId }}
        onBack={() => { setPreset(null); void load(); }}
        onCreated={(experimentId) => { setPreset(null); setDetailId(experimentId); }}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
      <div className="w-full space-y-4">
        <div className="flex items-start gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Skill 实验</h2>
            <p className="mt-1 text-xs text-foreground-muted">三种入口共用同一套实验流程，仅预填不同配置。</p>
          </div>
          <span className="ml-auto rounded-md bg-primary-subtle px-2 py-1 text-[10px] font-medium text-primary">{rows.length} 条记录</span>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {PRESETS.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" onClick={() => setPreset(item.id)} className="rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary-subtle text-primary"><Icon className="size-4" /></span>
                <b className="mt-3 block text-sm text-foreground">{item.label}</b>
                <p className="mt-1 text-[11px] leading-5 text-foreground-muted">{item.description}</p>
                <span className="mt-3 block text-[11px] font-medium text-primary">{item.action}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-primary-subtle-border bg-primary-subtle px-3 py-2 text-[11px] text-foreground-secondary">
          <span className="rounded border border-primary px-1.5 py-0.5 font-medium text-primary">统一实验</span>
          三个入口创建的都是标准 Skill 实验，只是数据集、对比方式和评估器默认值不同。
        </div>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center border-b border-border px-4 py-3">
            <FlaskConical className="mr-2 size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">实验记录</h3>
            <span className="ml-auto text-[10px] text-foreground-muted">仅展示当前 Skill · v{version} 的实验记录</span>
          </div>
          {loading ? (
            <div className="flex h-28 items-center justify-center text-xs text-foreground-muted"><Loader2 className="mr-2 size-4 animate-spin" />加载实验记录</div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-xs text-foreground-muted">当前 Skill · v{version} 还没有实验记录</div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead className="bg-background-secondary text-[10px] text-foreground-muted">
                <tr><th className="px-4 py-2 font-medium">实验</th><th className="px-4 py-2 font-medium">模板</th><th className="px-4 py-2 font-medium">数据来源</th><th className="px-4 py-2 font-medium">状态</th><th className="px-4 py-2 font-medium">更新时间</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} onClick={() => setDetailId(row.id)} className="cursor-pointer border-t border-border text-xs hover:bg-background-secondary">
                    <td className="px-4 py-3"><b className="font-medium text-foreground">{row.name}</b><br /><span className="text-[10px] text-foreground-muted">{row.id}</span></td>
                    <td className="px-4 py-3 text-foreground-secondary">{PRESET_LABELS[row.preset || ''] || '标准实验'}</td>
                    <td className="px-4 py-3 text-foreground-secondary">{row.caseCount ? `${row.caseCount} Cases` : '平台运行'}</td>
                    <td className="px-4 py-3"><span className="rounded bg-background-secondary px-2 py-1 text-[10px] text-foreground-secondary">{STATUS_LABELS[row.status] || row.status}</span></td>
                    <td className="px-4 py-3 text-foreground-muted">{new Date(row.updatedAt || row.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
