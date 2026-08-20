'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileUp,
  FlaskConical,
  FolderSearch,
  History,
  MessageSquareText,
  Plus,
  Sparkles,
  WandSparkles,
  Loader2,
} from 'lucide-react';

import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import type { SkillWorkbenchActiveView } from '@/lib/skill-workbench/domain';
import { cn } from '@/lib/utils';
import { SkillDetailWorkspace } from './SkillDetailWorkspace';
import { SkillManagementPicker } from './SkillManagementPicker';
import { OptimizationRecordsPanel, type OptimizationRecordView } from './OptimizationRecordsPanel';
import { StaticEvaluationPanel, type StaticEvaluationOverview } from './StaticEvaluationPanel';
import { GenerationConversation } from './GenerationConversation';
import { OptimizationConversation } from './OptimizationConversation';
import { ExperimentPanel } from './ExperimentPanel';

interface SessionListItem {
  id: string;
  title: string;
  skillName: string | null;
  workVersion: number | null;
  source: string | null;
  activeView: SkillWorkbenchActiveView;
  stage: string;
  updatedAt: string;
}

interface SessionDetail extends SessionListItem {
  files: Record<string, string>;
  generatorSessionId: string | null;
  optSessionId: string | null;
  messages: Array<{ id: string; role: string; content: string }>;
  tasks: Array<{ id: string; type: string; status: string }>;
  optimizations: OptimizationRecordView[];
}

const VIEWS: Array<{ key: SkillWorkbenchActiveView; label: string }> = [
  { key: 'detail', label: 'Skill 详情' },
  { key: 'evaluation', label: 'Skill 评估' },
  { key: 'experiment', label: 'Skill 实验' },
  { key: 'optimization', label: '优化记录' },
];

const EMPTY_COPY: Record<SkillWorkbenchActiveView, { title: string; description: string }> = {
  detail: { title: '先添加一个 Skill', description: '从左侧生成、上传，或从 Skill 管理中心选择。' },
  evaluation: { title: '还没有可评估的 Skill', description: '准备好 Skill 后，可以显式启动静态质量评估。' },
  experiment: { title: '还没有可运行的 Skill 实验', description: 'Skill 准备好后，可选择触发分析、用例分析或 A/B 测试。' },
  optimization: { title: '还没有优化记录', description: '所有候选、复测、失败和放弃记录都会保留在这里。' },
};

function isStaticQualityError(message: string) {
  return /静态质量评估|静态质量门禁|工作快照.*评估|当前文件.*重新运行/.test(message);
}

export function SkillWorkbenchShell() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [active, setActive] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectingSkill, setSelectingSkill] = useState(false);
  const [abandoningId, setAbandoningId] = useState<string | null>(null);
  const [retestingId, setRetestingId] = useState<string | null>(null);
  const [publishingCandidateId, setPublishingCandidateId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [evaluationOverview, setEvaluationOverview] = useState<StaticEvaluationOverview | null>(null);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [evaluationRunning, setEvaluationRunning] = useState(false);
  const [startingGeneration, setStartingGeneration] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [startingOptimization, setStartingOptimization] = useState(false);
  const [autoStartOptimization, setAutoStartOptimization] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState('');
  const currentView = active?.activeView || 'detail';
  const reportError = useCallback((message: string) => setError(message), []);

  const loadSession = useCallback(async (id: string, username: string) => {
    const response = await apiFetch(
      `/api/skill-workbench/sessions/${encodeURIComponent(id)}?user=${encodeURIComponent(username)}`,
      { cache: 'no-store' },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载会话失败');
    setActive(data.session as SessionDetail);
  }, []);

  const loadSessions = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/skill-workbench/sessions?user=${encodeURIComponent(user)}`,
        { cache: 'no-store' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载历史会话失败');
      const next = (data.sessions || []) as SessionListItem[];
      setSessions(next);
      if (next[0]) await loadSession(next[0].id, user);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载历史会话失败');
    } finally {
      setLoading(false);
    }
  }, [loadSession, user]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const createSession = async () => {
    if (!user || creating) return;
    setCreating(true);
    setError('');
    try {
      const response = await apiFetch('/api/skill-workbench/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '创建会话失败');
      await loadSessions();
      await loadSession(data.session.id, user);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建会话失败');
    } finally {
      setCreating(false);
    }
  };

  const switchView = async (view: SkillWorkbenchActiveView) => {
    if (!user || !active || active.activeView === view) return;
    const previous = active;
    setActive({ ...active, activeView: view });
    try {
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(active.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, activeView: view }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存页签失败');
      setActive(data.session as SessionDetail);
    } catch (switchError) {
      setActive(previous);
      setError(switchError instanceof Error ? switchError.message : '保存页签失败');
    }
  };

  const selectManagedSkill = async (skillName: string, version: number) => {
    if (!user || !active || selectingSkill) return;
    setSelectingSkill(true);
    setError('');
    try {
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(active.id)}/context`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, skillName, version }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '选择 Skill 失败');
      const next = data.session as SessionDetail;
      setActive(next);
      setSessions((current) => current.map((session) => (
        session.id === next.id ? { ...session, ...next } : session
      )));
      setPickerOpen(false);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : '选择 Skill 失败');
    } finally {
      setSelectingSkill(false);
    }
  };

  const abandonOptimization = async (record: OptimizationRecordView) => {
    if (!user || !active?.skillName || abandoningId) return;
    if (!window.confirm(`确认放弃 ${record.candidateVersionLabel}？候选快照会保留在历史记录中。`)) return;
    setAbandoningId(record.id);
    setError('');
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(active.skillName)}/optimizations/${encodeURIComponent(record.id)}/abandon`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '放弃候选失败');
      await loadSession(active.id, user);
    } catch (abandonError) {
      setError(abandonError instanceof Error ? abandonError.message : '放弃候选失败');
    } finally {
      setAbandoningId(null);
    }
  };

  const retestOptimization = async (record: OptimizationRecordView) => {
    if (!user || !active?.skillName || retestingId) return;
    setRetestingId(record.id);
    setError('');
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(active.skillName)}/optimizations/${encodeURIComponent(record.id)}/retest`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user }) },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '候选复测失败');
      await loadSession(active.id, user);
    } catch (retestError) {
      setError(retestError instanceof Error ? retestError.message : '候选复测失败');
      await loadSession(active.id, user);
    } finally {
      setRetestingId(null);
    }
  };

  const publishOptimization = async (record: OptimizationRecordView) => {
    if (!user || !active?.skillName || publishingCandidateId) return;
    if (!window.confirm(`确认将 ${record.candidateVersionLabel} 发布为正式版本？发布后会成为激活版本。`)) return;
    setPublishingCandidateId(record.id);
    setError('');
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(active.skillName)}/optimizations/${encodeURIComponent(record.id)}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user, confirmed: true }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '发布优化候选失败');
      const next = data.session as SessionDetail;
      setActive(next);
      setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : '发布优化候选失败');
    } finally {
      setPublishingCandidateId(null);
    }
  };

  const uploadSnapshot = async (files: FileList | null) => {
    if (!user || !active || !files?.length || uploading) return;
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.set('user', user);
      for (const file of Array.from(files)) {
        formData.append('files', file);
        formData.append('paths', file.webkitRelativePath || file.name);
      }
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(active.id)}/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '上传 Skill 失败');
      const next = data.session as SessionDetail;
      setActive(next);
      setSessions((current) => current.map((session) => (
        session.id === next.id ? { ...session, ...next } : session
      )));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传 Skill 失败');
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  const loadEvaluation = useCallback(async (session: SessionDetail, username: string) => {
    if (!session.skillName || session.workVersion === null) {
      setEvaluationOverview(null);
      return;
    }
    setEvaluationLoading(true);
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(session.skillName)}/versions/${session.workVersion}/evaluations?user=${encodeURIComponent(username)}&sessionId=${encodeURIComponent(session.id)}`,
        { cache: 'no-store' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载静态评估失败');
      setEvaluationOverview(data as StaticEvaluationOverview);
      setError((current) => isStaticQualityError(current) ? '' : current);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载静态评估失败');
    } finally {
      setEvaluationLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (active?.skillName && active.workVersion !== null && user) void loadEvaluation(active, user);
      else setEvaluationOverview(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, loadEvaluation, user]);

  useEffect(() => {
    if (evaluationOverview?.gate.state !== 'running' || !active || !user) return;
    const timer = window.setInterval(() => void loadEvaluation(active, user), 2_000);
    return () => window.clearInterval(timer);
  }, [active, evaluationOverview?.gate.state, loadEvaluation, user]);

  const runEvaluation = async () => {
    if (!user || !active?.skillName || active.workVersion === null || evaluationRunning) return;
    setEvaluationRunning(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(active.skillName)}/versions/${active.workVersion}/evaluations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user, sessionId: active.id, force: Boolean(evaluationOverview?.evaluation) }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.task?.errorMessage || '静态评估失败');
      if (data.overview) setEvaluationOverview(data.overview as StaticEvaluationOverview);
      await Promise.all([loadSession(active.id, user), loadEvaluation(active, user)]);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : '静态评估失败');
    } finally {
      setEvaluationRunning(false);
    }
  };

  const startGeneration = async () => {
    if (!user || !active || startingGeneration) return;
    setStartingGeneration(true);
    setError('');
    try {
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(active.id)}/generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '启动生成会话失败');
      const next = data.session as SessionDetail;
      setActive(next);
      setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : '启动生成会话失败');
    } finally {
      setStartingGeneration(false);
    }
  };

  const acceptGeneratedSession = useCallback((value: unknown) => {
    const next = value as SessionDetail;
    setActive(next);
    setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
    setError((current) => isStaticQualityError(current) ? '' : current);
    if (user && next.skillName && next.workVersion !== null) void loadEvaluation(next, user);
  }, [loadEvaluation, user]);

  const publishSnapshot = async () => {
    if (!user || !active || publishing) return;
    if (!window.confirm(`确认将当前工作快照发布为 ${active.skillName} v${active.workVersion}？发布后会成为激活版本。`)) return;
    setPublishing(true);
    setError('');
    try {
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(active.id)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, confirmed: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '发布失败');
      const next = data.session as SessionDetail;
      setActive(next);
      setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const startOptimization = async ({ autoRun = false }: { autoRun?: boolean } = {}) => {
    if (!user || !active?.skillName || startingOptimization) return;
    setStartingOptimization(true);
    setAutoStartOptimization(autoRun);
    setError('');
    try {
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(active.id)}/optimization`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '启动优化会话失败');
      const next = data.session as SessionDetail;
      setActive(next);
      setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
    } catch (optimizationError) {
      setAutoStartOptimization(false);
      setError(optimizationError instanceof Error ? optimizationError.message : '启动优化会话失败');
    } finally {
      setStartingOptimization(false);
    }
  };

  const emptyCopy = EMPTY_COPY[currentView];
  const contextLabel = active?.skillName
    ? `${active.skillName} · v${active.workVersion ?? 0}`
    : '尚未选择 Skill';

  const sessionSubtitle = useMemo(() => {
    if (!active) return '创建新对话开始工作';
    if (!active.skillName) return '版本 —';
    return `工作版本 v${active.workVersion ?? 0}`;
  }, [active]);
  const displayedQualityGate = evaluationRunning
    ? { state: 'running' as const, highIssueCount: 0, message: '正在评估当前工作快照，完成前暂不能发布。' }
    : evaluationOverview?.gate || null;

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-[390px] min-w-[340px] flex-col border-r border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-primary" />
            <h1 className="text-sm font-semibold text-foreground">Skill Copilot</h1>
            <span className="size-1.5 rounded-full bg-success" />
            <span className="flex-1" />
            <button
              type="button"
              title="新对话"
              aria-label="新对话"
              disabled={!user || creating}
              onClick={createSession}
              className="inline-flex size-8 items-center justify-center rounded-md border border-border text-foreground-secondary hover:bg-background-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-background-secondary px-3 py-2.5">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary-subtle text-primary">◇</span>
            <span className="min-w-0">
              <b className="block truncate text-xs text-foreground">{contextLabel}</b>
              <small className="text-[11px] text-foreground-muted">{sessionSubtitle}</small>
            </span>
          </div>
        </div>

        <div className="border-b border-border px-3 py-2">
          <div className="mb-1 flex items-center gap-2 px-1 text-[11px] font-medium text-foreground-muted">
            <History className="size-3.5" />
            历史会话
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                onClick={() => user && void loadSession(session.id, user)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                  active?.id === session.id
                    ? 'bg-primary-subtle text-primary'
                    : 'text-foreground-secondary hover:bg-background-secondary',
                )}
              >
                <Clock3 className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <span className="text-[10px] text-foreground-muted">
                  {session.skillName ? `v${session.workVersion ?? 0}` : '空闲'}
                </span>
              </button>
            ))}
            {!loading && sessions.length === 0 && (
              <div className="px-2 py-2 text-[11px] text-foreground-muted">暂无历史会话</div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
          {error && (
            <div className="mb-3 rounded-md border border-error-border bg-error-subtle px-3 py-2 text-xs text-error">
              {error}
            </div>
          )}
          {!active ? (
            <div className="m-auto max-w-[270px] text-center">
              <Sparkles className="mx-auto mb-3 size-6 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">创建一个工作台会话</h2>
              <p className="mt-1 text-xs leading-5 text-foreground-muted">会话会保存工作 Skill、版本、页签和后续任务状态。</p>
              <button
                type="button"
                onClick={createSession}
                disabled={!user || creating}
                className="mt-4 inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                <Plus className="size-3.5" />
                新建会话
              </button>
            </div>
          ) : active.optSessionId && active.skillName && active.workVersion !== null ? (
            <OptimizationConversation
              user={user || ''}
              workbenchSessionId={active.id}
              optSessionId={active.optSessionId}
              skillName={active.skillName}
              baseVersion={active.workVersion}
              baselineFiles={active.files || {}}
              issues={evaluationOverview?.evaluation?.issues || []}
              autoStart={autoStartOptimization}
              backgroundRunning={active.tasks.some((task) => task.type === 'optimization' && ['pending', 'running'].includes(task.status))}
              latestRecord={active.optimizations[0]}
              retesting={retestingId !== null}
              onViewRecords={() => void switchView('optimization')}
              onRetest={(record) => void retestOptimization(record)}
              onCreateRetest={() => void switchView('experiment')}
              onAutoStartConsumed={() => setAutoStartOptimization(false)}
              onSynced={acceptGeneratedSession}
              onError={reportError}
            />
          ) : active.generatorSessionId && active.source === 'generated' ? (
            <GenerationConversation
              user={user || ''}
              workbenchSessionId={active.id}
              generatorSessionId={active.generatorSessionId}
              backgroundRunning={active.tasks.some((task) => task.type === 'generation' && ['pending', 'running'].includes(task.status))}
              onSynced={acceptGeneratedSession}
              onError={reportError}
            />
          ) : !active.skillName ? (
            <div>
              <div className="rounded-lg bg-background-secondary px-3 py-3 text-xs leading-5 text-foreground-secondary">
                <b className="text-foreground">你好，我可以帮你创建、验证和改进 Skill。</b>
                <br />请选择一种开始方式，后续评估、实验、优化、复测和发布都在同一会话中完成。
              </div>
              <div className="mt-3 space-y-2">
                <StarterButton
                  icon={startingGeneration ? Loader2 : WandSparkles}
                  label={startingGeneration ? '正在准备生成会话…' : '生成一个 Skill'}
                  disabled={startingGeneration}
                  onClick={() => void startGeneration()}
                />
                <StarterButton
                  icon={uploading ? Loader2 : FileUp}
                  label={uploading ? '正在解析上传内容…' : '上传已有 Skill'}
                  disabled={uploading}
                  onClick={() => uploadInputRef.current?.click()}
                />
                <StarterButton icon={FolderSearch} label="从 Skill 管理中心选择" onClick={() => setPickerOpen(true)} />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <ActionButton icon={CheckCircle2} label="Skill 评估" onClick={() => void switchView('evaluation')} />
              <ActionButton icon={FlaskConical} label="Skill 实验" onClick={() => void switchView('experiment')} />
              <ActionButton
                icon={startingOptimization ? Loader2 : WandSparkles}
                label={startingOptimization ? '正在准备优化会话…' : 'Skill 优化'}
                onClick={() => void startOptimization()}
              />
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-border bg-card px-5">
          <span className="text-sm font-semibold text-foreground">{contextLabel}</span>
          <div className="ml-8 flex h-full items-end gap-1">
            {VIEWS.map((view) => (
              <button
                type="button"
                key={view.key}
                onClick={() => void switchView(view.key)}
                disabled={!active}
                className={cn(
                  'relative h-10 px-3 text-xs font-medium text-foreground-secondary disabled:cursor-not-allowed disabled:opacity-50',
                  currentView === view.key && 'text-primary after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary',
                )}
              >
                {view.label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <span className="rounded-md border border-border bg-background-secondary px-2 py-1 text-[10px] text-foreground-muted">
            会话内持续优化
          </span>
        </header>

        {currentView === 'detail' && active?.skillName ? (
          <SkillDetailWorkspace
            skillName={active.skillName}
            version={active.workVersion ?? 0}
            files={active.files || {}}
            candidate={active.source !== 'management'}
            publishing={publishing}
            optimizing={startingOptimization}
            qualityGate={displayedQualityGate}
            onOpenEvaluation={() => void switchView('evaluation')}
            onOptimize={() => void startOptimization({ autoRun: true })}
            onPublish={() => void publishSnapshot()}
          />
        ) : currentView === 'evaluation' && active?.skillName ? (
          <StaticEvaluationPanel
            source={active.source}
            overview={evaluationOverview}
            loading={evaluationLoading}
            running={evaluationRunning || evaluationOverview?.gate.state === 'running'}
            optimizing={startingOptimization}
            onRun={() => void runEvaluation()}
            onOptimize={() => void startOptimization({ autoRun: true })}
          />
        ) : currentView === 'experiment' && active?.skillName && active.workVersion !== null ? (
          <ExperimentPanel
            user={user || ''}
            sessionId={active.id}
            skillName={active.skillName}
            version={active.workVersion}
            optimizationRecordId={active.optimizations.find((record) => (
              !record.hasRetestableSource && ['pending_retest', 'retest_failed', 'retest_cancelled'].includes(record.status)
            ))?.id}
            onError={reportError}
          />
        ) : currentView === 'optimization' && active?.optimizations.length ? (
          <OptimizationRecordsPanel
            records={active.optimizations}
            abandoningId={abandoningId}
            retestingId={retestingId}
            publishingId={publishingCandidateId}
            onAbandon={(record) => void abandonOptimization(record)}
            onRetest={(record) => void retestOptimization(record)}
            onPublish={(record) => void publishOptimization(record)}
            onCreateRetest={() => void switchView('experiment')}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
            <div className="max-w-md text-center">
              <span className="mx-auto flex size-11 items-center justify-center rounded-xl border border-border bg-card text-primary shadow-sm">
                {currentView === 'evaluation' ? <CheckCircle2 className="size-5" />
                  : currentView === 'experiment' ? <FlaskConical className="size-5" />
                    : currentView === 'optimization' ? <WandSparkles className="size-5" />
                      : <FolderSearch className="size-5" />}
              </span>
              <h2 className="mt-4 text-base font-semibold text-foreground">{emptyCopy.title}</h2>
              <p className="mt-1 text-sm leading-6 text-foreground-muted">{emptyCopy.description}</p>
            </div>
          </div>
        )}
      </section>
      {user && (
        <SkillManagementPicker
          open={pickerOpen}
          user={user}
          selecting={selectingSkill}
          onClose={() => setPickerOpen(false)}
          onSelect={selectManagedSkill}
        />
      )}
      <input
        ref={(node) => {
          uploadInputRef.current = node;
          node?.setAttribute('webkitdirectory', '');
          node?.setAttribute('directory', '');
        }}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => void uploadSnapshot(event.target.files)}
      />
    </div>
  );
}

function StarterButton({
  icon: Icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: typeof Sparkles;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? '将在后续开发批次接入' : undefined}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left hover:border-primary hover:bg-primary-subtle disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="flex size-8 items-center justify-center rounded-md bg-primary-subtle text-primary"><Icon className="size-4" /></span>
      <span className="flex-1 text-xs font-medium text-foreground">{label}</span>
      <ChevronRight className="size-4 text-foreground-muted" />
    </button>
  );
}

function ActionButton({ icon: Icon, label, onClick }: { icon: typeof Sparkles; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left hover:border-primary hover:bg-primary-subtle"
    >
      <Icon className="size-4 text-primary" />
      <span className="flex-1 text-xs font-medium text-foreground">{label}</span>
      <ChevronRight className="size-4 text-foreground-muted" />
    </button>
  );
}
