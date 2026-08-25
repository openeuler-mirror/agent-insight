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
  GripVertical,
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
import {
  clampCopilotWidth,
  COPILOT_DEFAULT_WIDTH,
  COPILOT_MIN_WIDTH,
  WORKBENCH_DIVIDER_WIDTH,
  WORKSPACE_MIN_WIDTH,
} from './workbench-layout';

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
  tasks: Array<{
    id: string;
    type: string;
    status: string;
    progress?: { stage?: string; activeStep?: number; percent?: number };
    errorMessage?: string | null;
    resultId?: string | null;
    resultType?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }>;
  optimizations: OptimizationRecordView[];
}

interface ManagedSkillAsset {
  id: string;
  name: string;
  activeVersion: number | null;
  versions: Array<{ version: number; semanticVersion: string | null; createdAt: string }>;
}

interface SelectedSkillAsset {
  kind: 'formal' | 'draft';
  id: string | null;
  skillName: string;
  version: number;
  files: Record<string, string>;
  source: string | null;
  sessionId: string | null;
}

type SkillPickerPurpose = 'bind' | 'browse';

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
  optimization: { title: '还没有优化记录', description: '所有候选、质量校验、失败和放弃记录都会保留在这里。' },
};

function isStaticQualityError(message: string) {
  return /静态质量评估|静态质量门禁|工作快照.*评估|当前文件.*重新运行/.test(message);
}

export function SkillWorkbenchShell() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [active, setActive] = useState<SessionDetail | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<SelectedSkillAsset | null>(null);
  const [assetCatalog, setAssetCatalog] = useState<ManagedSkillAsset[]>([]);
  const [assetLoading, setAssetLoading] = useState(false);
  const [optimizationRecords, setOptimizationRecords] = useState<OptimizationRecordView[]>([]);
  const [optimizationRecordsLoading, setOptimizationRecordsLoading] = useState(false);
  const [selectedOptimizationRecordId, setSelectedOptimizationRecordId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<SkillWorkbenchActiveView>('detail');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPurpose, setPickerPurpose] = useState<SkillPickerPurpose>('browse');
  const [selectingSkill, setSelectingSkill] = useState(false);
  const [abandoningId, setAbandoningId] = useState<string | null>(null);
  const [publishingCandidateId, setPublishingCandidateId] = useState<string | null>(null);
  const [publishCandidate, setPublishCandidate] = useState<OptimizationRecordView | null>(null);
  const [uploading, setUploading] = useState(false);
  const [evaluationOverview, setEvaluationOverview] = useState<StaticEvaluationOverview | null>(null);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [evaluationRunning, setEvaluationRunning] = useState(false);
  const [startingGeneration, setStartingGeneration] = useState(false);
  const [generationRunning, setGenerationRunning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [startingOptimization, setStartingOptimization] = useState(false);
  const [autoStartOptimization, setAutoStartOptimization] = useState(false);
  const [useOptimizationPlan, setUseOptimizationPlan] = useState(false);
  const [optimizationIssueOverride, setOptimizationIssueOverride] = useState<OptimizationRecordView['blockingIssues'] | null>(null);
  const [optimizationBaselineOverride, setOptimizationBaselineOverride] = useState<Record<string, string> | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const selectedAssetRef = useRef<SelectedSkillAsset | null>(null);
  const [error, setError] = useState('');
  const [copilotWidth, setCopilotWidth] = useState(COPILOT_DEFAULT_WIDTH);
  const [workbenchWidth, setWorkbenchWidth] = useState(
    COPILOT_DEFAULT_WIDTH + WORKSPACE_MIN_WIDTH + WORKBENCH_DIVIDER_WIDTH,
  );
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const reportError = useCallback((message: string) => setError(message), []);
  const clearAssetSelection = useCallback(() => {
    selectedAssetRef.current = null;
    setSelectedAsset(null);
  }, []);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem('skill-workbench-copilot-width'));
    if (Number.isFinite(stored) && stored >= COPILOT_MIN_WIDTH) {
      const availableWidth = workbenchRef.current?.clientWidth || window.innerWidth;
      setCopilotWidth(clampCopilotWidth(stored, availableWidth));
    }
  }, []);

  const resizeCopilot = useCallback((clientX: number) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const availableWidth = workbenchRef.current?.clientWidth || window.innerWidth;
    setCopilotWidth(clampCopilotWidth(start.width + clientX - start.x, availableWidth));
  }, []);

  const finishCopilotResize = useCallback(() => {
    resizeStartRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setCopilotWidth((current) => {
      window.localStorage.setItem('skill-workbench-copilot-width', String(Math.round(current)));
      return current;
    });
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => resizeCopilot(event.clientX);
    const finish = () => finishCopilotResize();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
  }, [finishCopilotResize, resizeCopilot]);

  useEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setWorkbenchWidth(entry.contentRect.width);
      setCopilotWidth((current) => clampCopilotWidth(current, entry.contentRect.width));
    });
    observer.observe(workbench);
    return () => observer.disconnect();
  }, []);

  const loadSession = useCallback(async (id: string, username: string) => {
    const response = await apiFetch(
      `/api/skill-workbench/sessions/${encodeURIComponent(id)}?user=${encodeURIComponent(username)}`,
      { cache: 'no-store' },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载会话失败');
    const session = data.session as SessionDetail;
    setActive(session);
    return session;
  }, []);

  const loadAssetCatalog = useCallback(async (username: string) => {
    setAssetLoading(true);
    try {
      const items: ManagedSkillAsset[] = [];
      let page = 1;
      let pages = 1;
      do {
        const response = await apiFetch(
          `/api/skill-management/skills?user=${encodeURIComponent(username)}&page=${page}&pageSize=36&source=all`,
          { cache: 'no-store' },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '加载 Skill 资产失败');
        items.push(...(Array.isArray(data.items) ? data.items : []));
        pages = Number(data.pages) || 1;
        page += 1;
      } while (page <= pages);
      setAssetCatalog(items);
      return items;
    } finally {
      setAssetLoading(false);
    }
  }, []);

  const selectFormalAsset = useCallback(async (skillName: string, version: number, username: string) => {
    setAssetLoading(true);
    try {
      const response = await apiFetch(
        `/api/skill-management/skills?user=${encodeURIComponent(username)}&name=${encodeURIComponent(skillName)}&version=${version}`,
        { cache: 'no-store' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载 Skill 版本失败');
      const next: SelectedSkillAsset = {
        kind: 'formal',
        id: data.asset.id,
        skillName: data.asset.name,
        version: data.asset.version,
        files: data.asset.files || {},
        source: 'management',
        sessionId: null,
      };
      selectedAssetRef.current = next;
      setSelectedAsset(next);
      return next;
    } finally {
      setAssetLoading(false);
    }
  }, []);

  const selectDraftAsset = useCallback((session: SessionDetail) => {
    if (!session.skillName || session.workVersion === null || session.source === 'management') return;
    const next: SelectedSkillAsset = {
      kind: 'draft',
      id: null,
      skillName: session.skillName,
      version: session.workVersion,
      files: session.files || {},
      source: session.source,
      sessionId: session.id,
    };
    selectedAssetRef.current = next;
    setSelectedAsset(next);
    setCurrentView('detail');
    return next;
  }, []);

  useEffect(() => {
    selectedAssetRef.current = selectedAsset;
  }, [selectedAsset]);

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
      if (next[0]) {
        const session = await loadSession(next[0].id, user);
        if (session.skillName && session.workVersion !== null) {
          if (session.source === 'management') await selectFormalAsset(session.skillName, session.workVersion, user);
          else selectDraftAsset(session);
        } else {
          clearAssetSelection();
        }
      } else {
        setActive(null);
        clearAssetSelection();
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载历史会话失败');
    } finally {
      setLoading(false);
    }
  }, [clearAssetSelection, loadSession, selectDraftAsset, selectFormalAsset, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSessions(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSessions]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      void loadAssetCatalog(user)
        .catch((loadError) => setError(loadError instanceof Error ? loadError.message : '加载 Skill 资产失败'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAssetCatalog, user]);

  const createSession = async () => {
    if (!user || creating) return null;
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
      const next = await loadSession(data.session.id, user);
      setSessions((current) => [next, ...current.filter((session) => session.id !== next.id)]);
      return next;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建会话失败');
      return null;
    } finally {
      setCreating(false);
    }
  };

  const createBlankSession = async () => {
    const next = await createSession();
    if (!next || next.skillName) return next;
    clearAssetSelection();
    setCurrentView('detail');
    return next;
  };

  const ensureManagementProcessSession = async (asset: SelectedSkillAsset) => {
    if (!user || asset.kind !== 'formal') return null;
    if (active?.source === 'management' && active.skillName === asset.skillName && active.workVersion === asset.version) {
      return active;
    }
    const existing = sessions.find((session) => (
      session.source === 'management' && session.skillName === asset.skillName && session.workVersion === asset.version
    ));
    if (existing) return loadSession(existing.id, user);
    const created = await createSession();
    if (!created) return null;
    const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(created.id)}/context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, skillName: asset.skillName, version: asset.version }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '准备 Skill 优化会话失败');
    const next = data.session as SessionDetail;
    setActive(next);
    setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
    return next;
  };

  const switchView = async (view: SkillWorkbenchActiveView) => {
    setCurrentView(view);
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
    if (!user || selectingSkill) return;
    setSelectingSkill(true);
    setError('');
    try {
      if (pickerPurpose === 'bind') {
        const targetSession = active?.skillName ? await createSession() : active || await createSession();
        if (!targetSession) throw new Error('无法准备当前会话');
        const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(targetSession.id)}/context`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user, skillName, version }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '绑定会话 Skill 失败');
        const next = data.session as SessionDetail;
        setActive(next);
        setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
      }
      await selectFormalAsset(skillName, version, user);
      setCurrentView('detail');
      setPickerOpen(false);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : '选择 Skill 失败');
    } finally {
      setSelectingSkill(false);
    }
  };

  const loadOptimizationRecords = useCallback(async (asset: SelectedSkillAsset, username: string) => {
    setOptimizationRecordsLoading(true);
    try {
      const scope = asset.kind === 'formal'
        ? `version=${encodeURIComponent(String(asset.version))}`
        : `sessionId=${encodeURIComponent(asset.sessionId || '')}`;
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(asset.skillName)}/optimizations?user=${encodeURIComponent(username)}${scope ? `&${scope}` : ''}`,
        { cache: 'no-store' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载优化记录失败');
      setOptimizationRecords(Array.isArray(data.records) ? data.records : []);
    } catch (loadError) {
      setOptimizationRecords([]);
      setError(loadError instanceof Error ? loadError.message : '加载优化记录失败');
    } finally {
      setOptimizationRecordsLoading(false);
    }
  }, []);

  const optimizationScopeKey = selectedAsset
    ? selectedAsset.kind === 'formal'
      ? `formal:${selectedAsset.skillName}:${selectedAsset.version}`
      : `draft:${selectedAsset.skillName}:${selectedAsset.sessionId || ''}`
    : '';

  const openOptimizationRecord = async (record: OptimizationRecordView) => {
    if (!user) return;
    setError('');
    setSelectedOptimizationRecordId(record.id);
    try {
      const targetAsset = await selectFormalAsset(record.skillName, record.baseVersion, user);
      await loadOptimizationRecords(targetAsset, user);
      await switchView('optimization');
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : '打开优化报告失败');
    }
  };

  useEffect(() => {
    const asset = selectedAssetRef.current;
    if (!asset || !user || !optimizationScopeKey) return;
    const timer = window.setTimeout(() => void loadOptimizationRecords(asset, user), 0);
    return () => window.clearTimeout(timer);
  }, [loadOptimizationRecords, optimizationScopeKey, user]);

  const abandonOptimization = async (record: OptimizationRecordView) => {
    if (!user || abandoningId) return;
    if (!window.confirm(`确认放弃 ${record.candidateVersionLabel}？候选快照会保留在历史记录中。`)) return;
    setAbandoningId(record.id);
    setError('');
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(record.skillName)}/optimizations/${encodeURIComponent(record.id)}/abandon`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '放弃候选失败');
      if (selectedAsset?.skillName === record.skillName) await loadOptimizationRecords(selectedAsset, user);
    } catch (abandonError) {
      setError(abandonError instanceof Error ? abandonError.message : '放弃候选失败');
    } finally {
      setAbandoningId(null);
    }
  };

  const publishOptimization = (record: OptimizationRecordView) => {
    if (publishingCandidateId) return;
    setPublishCandidate(record);
  };

  const confirmPublishOptimization = async () => {
    const record = publishCandidate;
    if (!user || !record || publishingCandidateId) return;
    setPublishingCandidateId(record.id);
    setError('');
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(record.skillName)}/optimizations/${encodeURIComponent(record.id)}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user, confirmed: true }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '发布优化候选失败');
      if (data.session) {
        const next = data.session as SessionDetail;
        setActive((current) => current?.id === next.id ? next : current);
        setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
      }
      await loadAssetCatalog(user);
      await selectFormalAsset(record.skillName, data.version.version, user);
      await loadOptimizationRecords({
        kind: 'formal',
        id: data.skill.id,
        skillName: record.skillName,
        version: data.version.version,
        files: data.session?.files || record.candidateFiles || {},
        source: 'management',
        sessionId: null,
      }, user);
      setPublishCandidate(null);
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
      selectDraftAsset(next);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传 Skill 失败');
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  const loadEvaluation = useCallback(async (asset: SelectedSkillAsset, username: string) => {
    if (!asset.skillName) {
      setEvaluationOverview(null);
      return;
    }
    setEvaluationLoading(true);
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(asset.skillName)}/versions/${asset.version}/evaluations?user=${encodeURIComponent(username)}${asset.kind === 'draft' ? `&sessionId=${encodeURIComponent(asset.sessionId || '')}` : ''}`,
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
      if (selectedAsset && user) void loadEvaluation(selectedAsset, user);
      else setEvaluationOverview(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadEvaluation, selectedAsset, user]);

  useEffect(() => {
    if (evaluationOverview?.gate.state !== 'running' || !selectedAsset || !user) return;
    const timer = window.setInterval(() => void loadEvaluation(selectedAsset, user), 2_000);
    return () => window.clearInterval(timer);
  }, [evaluationOverview?.gate.state, loadEvaluation, selectedAsset, user]);

  const runEvaluation = async () => {
    if (!user || !selectedAsset || evaluationRunning) return;
    const taskSession = selectedAsset.kind === 'draft'
      ? (selectedAsset.sessionId ? await loadSession(selectedAsset.sessionId, user) : null)
      : null;
    if (selectedAsset.kind === 'draft' && !taskSession) return;
    setEvaluationRunning(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/skill-workbench/skills/${encodeURIComponent(selectedAsset.skillName)}/versions/${selectedAsset.version}/evaluations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user,
            ...(taskSession ? { sessionId: taskSession.id } : {}),
            force: Boolean(evaluationOverview?.evaluation),
            formalAsset: selectedAsset.kind === 'formal',
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.task?.errorMessage || '静态评估失败');
      if (data.overview) setEvaluationOverview(data.overview as StaticEvaluationOverview);
      await Promise.all([
        taskSession ? loadSession(taskSession.id, user) : Promise.resolve(null),
        loadEvaluation(selectedAsset, user),
      ]);
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
    selectDraftAsset(next);
    if (user && next.skillName && next.workVersion !== null) {
      void loadEvaluation({
        kind: 'draft', id: null, skillName: next.skillName, version: next.workVersion,
        files: next.files || {}, source: next.source, sessionId: next.id,
      }, user);
    }
  }, [loadEvaluation, selectDraftAsset, user]);

  const acceptOptimizationSession = useCallback((value: unknown) => {
    const next = value as SessionDetail;
    setActive(next);
    setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
    setError((current) => isStaticQualityError(current) ? '' : current);
    const asset = selectedAssetRef.current;
    if (asset?.kind === 'draft') selectDraftAsset(next);
    if (asset && user) void loadOptimizationRecords(asset, user);
  }, [loadOptimizationRecords, selectDraftAsset, user]);

  const publishSnapshot = async () => {
    if (!user || !selectedAsset || selectedAsset.kind !== 'draft' || !selectedAsset.sessionId || publishing) return;
    const requiresConfirmation = selectedAsset.source !== 'generated';
    if (requiresConfirmation && !window.confirm(`确认将当前工作快照发布为 ${selectedAsset.skillName} v${selectedAsset.version}？发布后会成为激活版本。`)) return;
    setPublishing(true);
    setError('');
    try {
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(selectedAsset.sessionId)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, confirmed: requiresConfirmation }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '发布失败');
      const next = data.session as SessionDetail;
      setActive(next);
      setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
      await loadAssetCatalog(user);
      await selectFormalAsset(next.skillName as string, next.workVersion as number, user);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const startOptimization = async ({
    autoRun = true,
    record,
    targetAsset,
  }: {
    autoRun?: boolean;
    record?: OptimizationRecordView;
    targetAsset?: SelectedSkillAsset;
  } = {}) => {
    const optimizationAsset = targetAsset || selectedAsset;
    if (!user || !optimizationAsset || startingOptimization) return;
    setStartingOptimization(true);
    setAutoStartOptimization(autoRun);
    setUseOptimizationPlan(!record && optimizationAsset.kind === 'formal');
    setOptimizationIssueOverride(record?.blockingIssues || null);
    setOptimizationBaselineOverride(record?.candidateFiles || null);
    setError('');
    try {
      const sourceSession = record?.sourceSession?.id
        ? await loadSession(record.sourceSession.id, user)
        : null;
      const processSession = sourceSession || (optimizationAsset.kind === 'formal'
        ? await ensureManagementProcessSession(optimizationAsset)
        : optimizationAsset.sessionId ? await loadSession(optimizationAsset.sessionId, user) : null);
      if (!processSession) throw new Error('无法准备当前 Skill 的优化会话');
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(processSession.id)}/optimization`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '启动优化会话失败');
      const next = data.session as SessionDetail;
      setActive(next);
      setSessions((current) => current.map((session) => session.id === next.id ? { ...session, ...next } : session));
    } catch (optimizationError) {
      setAutoStartOptimization(false);
      setUseOptimizationPlan(false);
      setOptimizationIssueOverride(null);
      setOptimizationBaselineOverride(null);
      setError(optimizationError instanceof Error ? optimizationError.message : '启动优化会话失败');
    } finally {
      setStartingOptimization(false);
    }
  };

  const emptyCopy = EMPTY_COPY[currentView];
  const sessionSubtitle = useMemo(() => {
    if (!active) return '创建新对话开始工作';
    if (!active.skillName) return '版本 —';
    return `工作版本 v${active.workVersion ?? 0}`;
  }, [active]);
  const sessionContextLabel = active?.skillName
    ? `${active.skillName} · v${active.workVersion ?? 0}`
    : active?.title || '尚未创建会话';
  const displayedQualityGate = evaluationRunning
    ? { state: 'running' as const, highIssueCount: 0, message: '正在评估当前工作快照，完成前暂不能发布。' }
    : evaluationOverview?.gate || null;
  const selectedCatalogSkill = selectedAsset?.kind === 'formal'
    ? assetCatalog.find((skill) => skill.name === selectedAsset.skillName) || null
    : null;
  const assetSkillValue = selectedAsset?.kind === 'draft'
    ? `draft:${selectedAsset.sessionId}`
    : selectedAsset?.skillName || '';
  const viewingSessionAsset = Boolean(
    active?.skillName
    && active.workVersion !== null
    && selectedAsset
    && active.skillName === selectedAsset.skillName
    && active.workVersion === selectedAsset.version
    && (selectedAsset.kind === 'formal' || selectedAsset.sessionId === active.id),
  );

  const showSessionAsset = async (session: SessionDetail) => {
    if (!user || !session.skillName || session.workVersion === null) return null;
    if (session.source === 'management') {
      return selectFormalAsset(session.skillName, session.workVersion, user);
    }
    return selectDraftAsset(session) || null;
  };

  const changeAssetSkill = async (value: string) => {
    if (!user || value.startsWith('draft:')) return;
    const skill = assetCatalog.find((item) => item.name === value);
    if (!skill) return;
    const version = skill.versions.some((item) => item.version === skill.activeVersion)
      ? skill.activeVersion as number
      : skill.versions[0]?.version;
    if (version === undefined) return;
    try {
      await selectFormalAsset(skill.name, version, user);
      setCurrentView('detail');
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : '切换 Skill 失败');
    }
  };

  const changeAssetVersion = async (version: number) => {
    if (!user || !selectedCatalogSkill) return;
    try {
      await selectFormalAsset(selectedCatalogSkill.name, version, user);
      setCurrentView('detail');
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : '切换 Skill 版本失败');
    }
  };

  const openHistorySession = async (sessionId: string) => {
    if (!user) return;
    try {
      const session = await loadSession(sessionId, user);
      if (session.skillName && session.workVersion !== null) await showSessionAsset(session);
      else clearAssetSelection();
      setCurrentView('detail');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载会话失败');
    }
  };

  const openActiveSessionView = async (view: SkillWorkbenchActiveView) => {
    if (!active) return;
    await showSessionAsset(active);
    await switchView(view);
  };

  const startActiveSessionOptimization = async () => {
    if (!active) return;
    const targetAsset = await showSessionAsset(active);
    if (!targetAsset) return;
    await startOptimization({ autoRun: true, targetAsset });
  };

  const generationBusy = generationRunning || Boolean(active?.tasks.some((task) => (
    task.type === 'generation' && ['pending', 'running'].includes(task.status)
  )));
  const optimizationBusy = startingOptimization || Boolean(active?.tasks.some((task) => (
    task.type === 'optimization' && ['pending', 'running'].includes(task.status)
  )));
  const workflowActions = active?.skillName && active.workVersion !== null && !generationBusy
    ? (
      <ConversationQuickActions
        optimizationBusy={optimizationBusy}
        onEvaluation={() => void openActiveSessionView('evaluation')}
        onExperiment={() => void openActiveSessionView('experiment')}
        onOptimization={() => void startActiveSessionOptimization()}
      />
    )
    : null;

  return (
    <div ref={workbenchRef} className="flex h-full min-h-0 overflow-hidden bg-background">
      <aside
        className="flex min-w-[320px] shrink-0 flex-col bg-card"
        style={{ width: copilotWidth, flexBasis: copilotWidth }}
      >
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
              onClick={() => void createBlankSession()}
              className="inline-flex size-8 items-center justify-center rounded-md border border-border text-foreground-secondary hover:bg-background-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-background-secondary px-3 py-2.5">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary-subtle text-primary">◇</span>
            <span className="min-w-0">
              <b className="block truncate text-xs text-foreground">{sessionContextLabel}</b>
              <small className="text-[11px] text-foreground-muted">{sessionSubtitle}</small>
            </span>
          </div>
        </div>

        <div className="border-b border-border px-4 py-2">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-foreground-muted">
            <History className="size-3.5" />
            历史会话
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
            {sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                onClick={() => void openHistorySession(session.id)}
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

        <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
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
                onClick={() => void createBlankSession()}
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
              generatorSessionId={active.generatorSessionId}
              optSessionId={active.optSessionId}
              skillName={active.skillName}
              baseVersion={active.workVersion}
              baselineFiles={optimizationBaselineOverride || active.files || {}}
              issues={optimizationIssueOverride || evaluationOverview?.evaluation?.issues || []}
              autoStart={autoStartOptimization}
              useMergePlan={useOptimizationPlan}
              backgroundRunning={active.tasks.some((task) => task.type === 'optimization' && ['pending', 'running'].includes(task.status))}
              tasks={active.tasks.filter((task) => task.type === 'optimization')}
              records={active.optimizations}
              publishing={publishingCandidateId !== null}
              quickActions={workflowActions}
              onViewRecords={(record) => void openOptimizationRecord(record)}
              onPublish={(record) => void publishOptimization(record)}
              onRepair={(record) => void startOptimization({ autoRun: true, record })}
              onAutoStartConsumed={() => {
                setAutoStartOptimization(false);
                setUseOptimizationPlan(false);
                setOptimizationIssueOverride(null);
                setOptimizationBaselineOverride(null);
              }}
              onSynced={acceptOptimizationSession}
              onError={reportError}
            />
          ) : active.generatorSessionId ? (
            <GenerationConversation
              user={user || ''}
              workbenchSessionId={active.id}
              generatorSessionId={active.generatorSessionId}
              backgroundRunning={active.tasks.some((task) => task.type === 'generation' && ['pending', 'running'].includes(task.status))}
              quickActions={workflowActions}
              onRunningChange={setGenerationRunning}
              onSynced={acceptGeneratedSession}
              onError={reportError}
            />
          ) : !active.skillName ? (
            <div>
              <div className="rounded-lg bg-background-secondary px-3 py-3 text-xs leading-5 text-foreground-secondary">
                <b className="text-foreground">你好，我可以帮你创建、验证和改进 Skill。</b>
                <br />请选择一种开始方式，后续评估、实验、优化和发布都在同一会话中完成。
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
                <StarterButton
                  icon={FolderSearch}
                  label="从 Skill 管理中心选择"
                  onClick={() => {
                    setPickerPurpose('bind');
                    setPickerOpen(true);
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <ActionButton icon={CheckCircle2} label="Skill 评估" onClick={() => void switchView('evaluation')} />
              <ActionButton icon={FlaskConical} label="Skill 实验" onClick={() => void switchView('experiment')} />
              <ActionButton
                icon={startingOptimization ? Loader2 : WandSparkles}
                label={startingOptimization ? '正在准备优化会话…' : 'Skill 优化'}
                onClick={() => void startOptimization({ autoRun: true })}
              />
            </div>
          )}
        </div>
      </aside>
      <div
        role="separator"
        aria-label="调整 Skill Copilot 宽度"
        aria-orientation="vertical"
        aria-valuemin={COPILOT_MIN_WIDTH}
        aria-valuemax={Math.max(
          COPILOT_MIN_WIDTH,
          workbenchWidth - WORKSPACE_MIN_WIDTH - WORKBENCH_DIVIDER_WIDTH,
        )}
        aria-valuenow={Math.round(copilotWidth)}
        tabIndex={0}
        title="左右拖动调整 Skill Copilot 与工作区宽度"
        className="group relative z-10 w-2 shrink-0 touch-none cursor-col-resize bg-background outline-none"
        onPointerDown={(event) => {
          resizeStartRef.current = { x: event.clientX, width: copilotWidth };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const delta = event.key === 'ArrowLeft' ? -24 : 24;
          setCopilotWidth((current) => {
            const availableWidth = workbenchRef.current?.clientWidth || window.innerWidth;
            const next = clampCopilotWidth(current + delta, availableWidth);
            window.localStorage.setItem('skill-workbench-copilot-width', String(Math.round(next)));
            return next;
          });
        }}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary group-focus:bg-primary" />
        <span className="absolute left-1/2 top-1/2 flex h-9 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card text-foreground-muted shadow-sm transition-colors group-hover:border-primary group-hover:text-primary group-focus:border-primary group-focus:text-primary">
          <GripVertical className="size-3" />
        </span>
      </div>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 min-w-0 shrink-0 items-center overflow-hidden border-b border-border bg-card px-5">
          <select
            aria-label="选择 Skill"
            value={assetSkillValue}
            disabled={assetLoading || (!selectedAsset && assetCatalog.length === 0)}
            onChange={(event) => void changeAssetSkill(event.target.value)}
            className="h-8 min-w-0 max-w-64 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none focus:border-primary disabled:opacity-50"
          >
            {!selectedAsset && <option value="">选择 Skill</option>}
            {selectedAsset?.kind === 'draft' && (
              <option value={`draft:${selectedAsset.sessionId}`}>{selectedAsset.skillName}（未发布）</option>
            )}
            {assetCatalog.map((skill) => <option key={skill.id} value={skill.name}>{skill.name}</option>)}
          </select>
          <select
            aria-label="选择 Skill 版本"
            value={selectedAsset?.version ?? ''}
            disabled={assetLoading || !selectedAsset || selectedAsset.kind === 'draft'}
            onChange={(event) => void changeAssetVersion(Number(event.target.value))}
            className="ml-2 h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
          >
            {selectedAsset?.kind === 'draft' ? (
              <option value={selectedAsset.version}>v{selectedAsset.version}（未发布）</option>
            ) : selectedCatalogSkill?.versions.map((version) => (
              <option key={version.version} value={version.version}>
                v{version.version}{version.version === selectedCatalogSkill.activeVersion ? '（激活）' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setPickerPurpose('browse');
              setPickerOpen(true);
            }}
            className="ml-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-foreground-secondary hover:bg-background-secondary"
          >
            <FolderSearch className="size-3.5" />选择资产
          </button>
          <div className="ml-8 flex h-full items-end gap-1">
            {VIEWS.map((view) => (
              <button
                type="button"
                key={view.key}
                onClick={() => void switchView(view.key)}
                disabled={!selectedAsset}
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
          <span className="hidden rounded-md border border-border bg-background-secondary px-2 py-1 text-[10px] text-foreground-muted 2xl:inline-flex">
            {viewingSessionAsset ? '会话工作版本' : '独立资产版本'}
          </span>
        </header>

        {selectedAsset && !viewingSessionAsset && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-warning-border bg-warning-subtle px-5 text-[11px] text-warning">
            <span className="min-w-0 flex-1 truncate">
              {active?.skillName
                ? `右栏使用 ${selectedAsset.skillName} · v${selectedAsset.version}，不会改变当前会话 ${active.skillName} · v${active.workVersion ?? 0}`
                : `右栏使用 ${selectedAsset.skillName} · v${selectedAsset.version}，当前会话尚未绑定 Skill`}
            </span>
            {active?.skillName && (
              <button
                type="button"
                onClick={() => void showSessionAsset(active)}
                className="h-6 shrink-0 rounded-md border border-warning-border px-2 font-medium hover:bg-card"
              >
                回到会话版本
              </button>
            )}
          </div>
        )}

        {currentView === 'detail' && selectedAsset ? (
          <SkillDetailWorkspace
            skillName={selectedAsset.skillName}
            version={selectedAsset.version}
            files={selectedAsset.files}
            candidate={selectedAsset.kind === 'draft'}
            source={selectedAsset.source}
            generationRunning={generationRunning}
            publishing={publishing}
            optimizing={startingOptimization}
            qualityGate={displayedQualityGate}
            onOpenEvaluation={() => void switchView('evaluation')}
            onOptimize={() => void startOptimization({ autoRun: true })}
            onPublish={() => void publishSnapshot()}
          />
        ) : currentView === 'evaluation' && selectedAsset ? (
          <StaticEvaluationPanel
            source={selectedAsset.source}
            overview={evaluationOverview}
            loading={evaluationLoading}
            running={evaluationRunning || evaluationOverview?.gate.state === 'running'}
            optimizing={startingOptimization}
            onRun={() => void runEvaluation()}
            onOptimize={() => void startOptimization({ autoRun: true })}
          />
        ) : currentView === 'experiment' && selectedAsset?.kind === 'formal' ? (
          <ExperimentPanel
            user={user || ''}
            skillName={selectedAsset.skillName}
            version={selectedAsset.version}
            onError={reportError}
          />
        ) : currentView === 'optimization' && optimizationRecordsLoading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-foreground-muted"><Loader2 className="mr-2 size-4 animate-spin" />加载优化记录</div>
        ) : currentView === 'optimization' && optimizationRecords.length ? (
          <OptimizationRecordsPanel
            records={optimizationRecords}
            selectedRecordId={selectedOptimizationRecordId}
            abandoningId={abandoningId}
            publishingId={publishingCandidateId}
            onAbandon={(record) => void abandonOptimization(record)}
            onPublish={(record) => void publishOptimization(record)}
            onOpenSourceSession={(record) => record.sourceSession?.id && void openHistorySession(record.sourceSession.id)}
            onContinue={(record) => void startOptimization({ autoRun: true, record })}
            onSelectRecordId={setSelectedOptimizationRecordId}
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
          purpose={pickerPurpose}
          onClose={() => setPickerOpen(false)}
          onSelect={selectManagedSkill}
        />
      )}
      {publishCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label="发布优化候选">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">发布新版本</h2>
            <p className="mt-2 text-xs leading-5 text-foreground-secondary">确认将 {publishCandidate.candidateVersionLabel} 发布为正式版本。发布后会立即成为当前激活版本，原版本仍保留在版本历史中。</p>
            <div className="mt-4 grid grid-cols-2 gap-2 rounded-md bg-background-secondary p-3 text-xs"><span className="text-foreground-muted">当前版本</span><b className="text-right text-foreground">v{publishCandidate.baseVersion}</b><span className="text-foreground-muted">发布版本</span><b className="text-right text-primary">v{publishCandidate.baseVersion + 1}</b><span className="text-foreground-muted">修改文件</span><b className="text-right text-foreground">{publishCandidate.diff?.length || 0} 个</b></div>
            <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={publishingCandidateId !== null} onClick={() => setPublishCandidate(null)} className="h-8 rounded-md border border-border px-3 text-xs text-foreground-secondary">取消</button><button type="button" disabled={publishingCandidateId !== null} onClick={() => void confirmPublishOptimization()} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50">{publishingCandidateId ? <Loader2 className="size-3.5 animate-spin" /> : null}确认发布</button></div>
          </div>
        </div>
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

function ConversationQuickActions({
  optimizationBusy,
  onEvaluation,
  onExperiment,
  onOptimization,
}: {
  optimizationBusy: boolean;
  onEvaluation: () => void;
  onExperiment: () => void;
  onOptimization: () => void;
}) {
  return (
    <div className="mb-2 grid shrink-0 grid-cols-3 gap-2" aria-label="Skill 快捷操作">
      <button type="button" onClick={onEvaluation} className="inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground hover:border-primary hover:bg-primary-subtle">
        <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
        <span className="truncate">Skill 评估</span>
      </button>
      <button type="button" onClick={onExperiment} className="inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground hover:border-primary hover:bg-primary-subtle">
        <FlaskConical className="size-3.5 shrink-0 text-primary" />
        <span className="truncate">Skill 实验</span>
      </button>
      <button type="button" disabled={optimizationBusy} onClick={onOptimization} className="inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground hover:border-primary hover:bg-primary-subtle disabled:cursor-not-allowed disabled:opacity-60">
        {optimizationBusy ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" /> : <WandSparkles className="size-3.5 shrink-0 text-primary" />}
        <span className="truncate">{optimizationBusy ? '优化中' : 'Skill 优化'}</span>
      </button>
    </div>
  );
}
