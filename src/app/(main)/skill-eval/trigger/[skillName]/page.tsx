'use client';

/**
 * Skill 触发评价集 (TriggerTestSet) 编辑器。
 *
 * 路由：/skill-eval/trigger/<skillName>
 * 来源：skill 分析页"触发分析"卡的"前往配置 TriggerTestSet"按钮。
 *
 * UI 形态借鉴 DatasetItemsPage，但 case 形态是 {query, shouldTrigger}，不是 ideal_output。
 * 复测对话框走 opencode-live 模式——见 design.md 「评测变量空间」章节。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { safeUUID } from '@/lib/safe-uuid';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { FindingsGrouped, SectionShell } from '@/components/evaluation';
import type { FindingItem, FindingGroup } from '@/components/evaluation';
import '../../skill-analysis.css';
import '../../debug.css';
import '@/components/evaluation/evaluation-content.css';
import './trigger-overview.css';

// 复用 server 的类型；为避免拉 server 依赖到 client，这里手写一份对齐结构。
type TriggerItemSource = 'llm-draft' | 'user-added' | 'user-edited' | 'trace-mined';
interface TriggerItem {
  id: string;
  query: string;
  shouldTrigger: boolean;
  rationale?: string;
  source: TriggerItemSource;
}
type TriggerSetVersionSource = 'llm-draft' | 'user-upload' | 'manual';
interface TriggerSet {
  id: string;
  skillName: string;
  /** 数据集版本号；最大值即「latest / 可编辑版本」 */
  version: number;
  /** 这个版本怎么来 */
  versionSource: TriggerSetVersionSource;
  /** 可选备注（上传文件名 / 起草模型） */
  versionNote: string | null;
  description: string;
  items: TriggerItem[];
  status: 'drafting' | 'ready';
  createdAt: string;
  updatedAt: string;
}
interface RunResultItem {
  itemId: string;
  query: string;
  shouldTrigger: boolean;
  runsTriggered: number;
  runsTotal: number;
  triggerRate: number;
  pass: boolean;
  latencyMsAvg: number;
  competingSkill?: string;
}
interface RunRecord {
  id: string;
  skillName: string;
  skillVersion: number;
  results: RunResultItem[];
  passRate: number;
  truePositiveRate: number;
  falsePositiveRate: number;
  runsPerQuery: number;
  triggerThreshold: number;
  durationMs: number | null;
  modelId: string | null;
  status: 'running' | 'done' | 'failed';
  errorMessage: string | null;
  createdAt: string;
}

function uuid() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return safeUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SOURCE_LABEL: Record<TriggerItemSource, { label: string; tone: string }> = {
  'llm-draft': { label: 'AI 起草', tone: '#6366f1' },
  'user-added': { label: '手填', tone: '#10b981' },
  'user-edited': { label: '编辑过', tone: '#0891b2' },
  'trace-mined': { label: '采自轨迹', tone: '#a16207' },
};

const VERSION_SOURCE_LABEL: Record<TriggerSetVersionSource, string> = {
  'llm-draft': 'AI 起草',
  'user-upload': '上传',
  manual: '手编',
};

export default function SkillEvalTriggerPage() {
  const params = useParams<{ skillName: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const skillName = decodeURIComponent(params.skillName);
  // 外侧 SkillAnalysisHeader 选中的版本通过 ?version= 透进来；
  // 初始化时优先用它，对齐 StaticCompliancePanel 用 prop 直传 version 的语义。
  const initialVersionFromQuery = (() => {
    const raw = searchParams?.get('version');
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  })();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [set, setSet] = useState<TriggerSet | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [running, setRunning] = useState(false);
  // 历次评测 run，最新在前。latestRun = runs[0]（filter done），其余进「历史评测」面板。
  const [runs, setRuns] = useState<RunRecord[]>([]);
  // 当前在「执行概览」+ 行内评分里展示的 run id；null 表示跟随最新。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // 数据集版本列表（version desc）+ 当前编辑器在看哪个版本的 id。
  // null 表示跟随 latest（versions[0]）。
  const [versions, setVersions] = useState<TriggerSet[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [datasetVersionsOpen, setDatasetVersionsOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // 三段式 section 折叠态。固定默认：① ② 折叠 / ③ 展开——不再根据数据状态自动改写
  // （用户明确要求：永远是 ③ 默认展开，不论有没有评测过；空状态由 ③ block 内部空态承担）。
  const [configSecOpen, setConfigSecOpen] = useState(false);
  const [execSecOpen, setExecSecOpen] = useState(false);
  const [resultSecOpen, setResultSecOpen] = useState(true);

  // 用户在 /modelconfig 注册的所有模型 + 当前选用哪个起草
  const [modelConfigs, setModelConfigs] = useState<Array<{ id: string; name: string; model?: string }>>([]);
  const [activeConfigId, setActiveConfigId] = useState<string>('');
  const [draftConfigId, setDraftConfigId] = useState<string>('');

  // 该用户的所有 skill —— 顶部 Skill 切换器的数据源 + 当前 skill 的 versions
  interface SkillEntry {
    id: string;
    name: string;
    activeVersion?: number;
    versions?: Array<{ version: number; createdAt?: string }>;
  }
  const [skillsList, setSkillsList] = useState<SkillEntry[]>([]);
  useEffect(() => {
    if (!user) return;
    apiFetch(`/api/skills?user=${encodeURIComponent(user)}`)
      .then(r => (r.ok ? r.json() : []))
      .then(data => {
        if (!Array.isArray(data)) return;
        setSkillsList(
          data.map((s: SkillEntry) => ({
            id: s.id,
            name: s.name,
            activeVersion: s.activeVersion,
            versions: Array.isArray(s.versions) ? s.versions : [],
          })),
        );
      })
      .catch(() => setSkillsList([]));
  }, [user]);

  // 当前 skill 选哪个版本展示 latest run（数据集本身跨版本共享，但 run 是按版本归档的）
  const [selectedVersion, setSelectedVersion] = useState<number | null>(initialVersionFromQuery);
  useEffect(() => {
    // skill 切换 or 列表加载完成时：
    //   1) 优先尊重 URL 上 ?version=（外侧分析页带进来的版本），只要它在该 skill 的版本里存在
    //   2) 否则保留用户在子页里手动切过的当前值（如果还合法）
    //   3) 否则落到 active version
    const current = skillsList.find(s => s.name === skillName);
    if (current) {
      const fallback = current.activeVersion ?? current.versions?.[0]?.version ?? null;
      const queryVersion =
        initialVersionFromQuery != null && current.versions?.some(v => v.version === initialVersionFromQuery)
          ? initialVersionFromQuery
          : null;
      setSelectedVersion(prev => {
        if (queryVersion != null) return queryVersion;
        if (prev != null && current.versions?.some(v => v.version === prev)) return prev;
        return fallback;
      });
    }
  }, [skillsList, skillName, initialVersionFromQuery]);

  // 拉触发集（+ 全部版本）+ run 历史 + 用户注册的模型配置；run 按选中 skill 版本过滤
  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const runParams = new URLSearchParams({ user, limit: '50' });
      if (selectedVersion != null) runParams.set('skillVersion', String(selectedVersion));
      const setUrl = new URLSearchParams({ user });
      if (selectedSetId) setUrl.set('versionId', selectedSetId);
      const [setRes, runRes, settingsRes] = await Promise.all([
        apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skillName)}?${setUrl.toString()}`),
        apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skillName)}/runs?${runParams.toString()}`),
        apiFetch(`/api/eval/settings?user=${encodeURIComponent(user)}`),
      ]);
      const setData = await setRes.json();
      const runData = await runRes.json();
      const settings = await settingsRes.json().catch(() => ({}));
      setSet(setData.set ?? null);
      const vList: TriggerSet[] = Array.isArray(setData.versions) ? setData.versions : [];
      setVersions(vList);
      // selectedSetId 已不在新列表里就清掉，避免悬空选择
      if (selectedSetId && !vList.some(v => v.id === selectedSetId)) {
        setSelectedSetId(null);
      }
      const runList: RunRecord[] = Array.isArray(runData.runs) ? runData.runs : [];
      setRuns(runList);
      // 重新加载（切版本 / 复测完成）时把视图拉回最新，避免指着一个不在新列表里的旧 id。
      setSelectedRunId(null);
      const configs = Array.isArray(settings?.configs) ? settings.configs : [];
      setModelConfigs(
        configs.map((c: { id: string; name?: string; model?: string }) => ({
          id: c.id,
          name: c.name ?? c.id,
          model: c.model,
        })),
      );
      const active = String(settings?.activeConfigId ?? '');
      setActiveConfigId(active);
      // draft 默认选 active；用户切换后不被后续 reload 覆盖
      setDraftConfigId(prev => prev || active);
    } catch (err) {
      setErrorMsg((err as Error)?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [user, skillName, selectedVersion, selectedSetId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 编辑：单项更新
  const updateItem = useCallback((id: string, patch: Partial<TriggerItem>) => {
    setSet(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map(item =>
          item.id === id
            ? {
                ...item,
                ...patch,
                // 用户编辑过 → 标 source 为 user-edited（除非本来就是 user-added）
                source:
                  item.source === 'user-added' ? 'user-added' : (patch.source ?? 'user-edited'),
              }
            : item,
        ),
      };
    });
  }, []);

  const addItem = useCallback((shouldTrigger: boolean) => {
    setSet(prev => {
      const base: TriggerSet = prev ?? {
        id: '',
        skillName,
        version: 1,
        versionSource: 'manual',
        versionNote: null,
        description: '',
        items: [],
        status: 'ready',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        ...base,
        items: [
          ...base.items,
          {
            id: uuid(),
            query: '',
            shouldTrigger,
            source: 'user-added',
          },
        ],
      };
    });
  }, [skillName]);

  const deleteItem = useCallback((id: string) => {
    setSet(prev => (prev ? { ...prev, items: prev.items.filter(item => item.id !== id) } : prev));
  }, []);

  // latest = versions desc 的第一个；编辑器只允许在 latest 上保存。
  const latestSet = useMemo<TriggerSet | null>(() => versions[0] ?? null, [versions]);
  const isViewingLatestSet = !set || !latestSet || set.id === latestSet.id;
  const readOnly = !isViewingLatestSet;

  const saveAll = useCallback(async () => {
    if (!set || !user) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skillName)}`, {
        method: 'POST',
        body: JSON.stringify({
          user,
          // 后端会再校验「必须等于 latest 的 id」，前端 disable 已经挡住非 latest 的保存
          versionId: set.id || undefined,
          description: set.description,
          items: set.items,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `save failed: ${res.status}`);
      }
      const data = await res.json();
      setSet(data.set);
      // 保存后刷新版本列表（latest 的 updatedAt 会变；新建空集场景下也需要把 id 灌回来）
      void reload();
    } catch (err) {
      setErrorMsg((err as Error)?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  }, [set, user, skillName, reload]);

  // 历史里取最新的 done run 作为"最新一次评测"（其它状态如 running/failed 不进概览）
  const latestRun = useMemo(() => runs.find(r => r.status === 'done') ?? null, [runs]);
  // 「执行概览」+ 行内评分实际展示的 run：用户选中的优先；没选就跟随最新。
  const displayedRun = useMemo(
    () => (selectedRunId ? runs.find(r => r.id === selectedRunId) ?? null : latestRun),
    [runs, selectedRunId, latestRun],
  );
  const viewingHistory = selectedRunId != null && displayedRun?.id !== latestRun?.id;

  // 是否已经有过任意数据集版本 —— 用于按钮文案
  const hasAnyVersion = versions.length > 0;
  // 是否跑过评测 —— 决定"立即复测"还是"立即评测"
  const hasRun = latestRun != null;

  const draftRedo = useCallback(async () => {
    if (!user) return;
    // 新语义：起草 = 新建一个版本。不再覆盖旧数据，所以只有当已经存在版本时才二次确认。
    if (hasAnyVersion && !confirm('将基于当前 SKILL.md 生成一个新的 AI 起草版本，旧版本会保留为历史。确认？')) return;
    setDrafting(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skillName)}/draft`, {
        method: 'POST',
        body: JSON.stringify({
          user,
          modelConfigId: draftConfigId || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `draft failed: ${res.status}`);
      }
      const data = await res.json();
      // 切回 latest（新版本就是 latest），让用户立刻看到新建的版本
      setSelectedSetId(null);
      setSet(data.set);
      void reload();
    } catch (err) {
      setErrorMsg((err as Error)?.message ?? '起草失败');
    } finally {
      setDrafting(false);
    }
  }, [user, skillName, draftConfigId, hasAnyVersion, reload]);

  // 上传数据集 —— 选 JSON 文件 → 解析 → POST → 新建版本
  const onUploadFile = useCallback(async (file: File) => {
    if (!user) return;
    setUploading(true);
    setErrorMsg(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('JSON 解析失败：请确认文件是合法的 JSON 数组');
      }
      // 支持两种顶层结构：直接是数组，或 { items: [...] }
      const itemsRaw = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { items?: unknown })?.items)
        ? (parsed as { items: unknown[] }).items
        : null;
      if (!itemsRaw) {
        throw new Error('格式不符：顶层应是数组，或 { items: [...] }');
      }
      const res = await apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skillName)}/upload`, {
        method: 'POST',
        body: JSON.stringify({ user, items: itemsRaw, note: file.name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `upload failed: ${res.status}`);
      }
      const data = await res.json();
      setSelectedSetId(null);
      setSet(data.set);
      void reload();
    } catch (err) {
      setErrorMsg((err as Error)?.message ?? '上传失败');
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  }, [user, skillName, reload]);

  // 拆成正例 / 反例两列
  const positiveItems = useMemo(() => set?.items.filter(i => i.shouldTrigger) ?? [], [set]);
  const negativeItems = useMemo(() => set?.items.filter(i => !i.shouldTrigger) ?? [], [set]);

  // 命中结果 by itemId（用于行内显示分数）—— 跟随「执行概览」里展示的 run
  const resultByItemId = useMemo(() => {
    if (!displayedRun) return new Map<string, RunResultItem>();
    return new Map(displayedRun.results.map(r => [r.itemId, r]));
  }, [displayedRun]);

  const currentSkill = skillsList.find(s => s.name === skillName);

  // 版本下拉项：按 version desc 排序
  const sortedVersions = useMemo(() => {
    const list = currentSkill?.versions ?? [];
    return [...list].sort((a, b) => b.version - a.version);
  }, [currentSkill]);

  // 触发评价集是跨版本共享的；只有 latest-run 跟版本绑定 —— 用户选别的版本，看到的是
  // 那个版本最近一次跑过的结果（不存在则为空）。"立即复测" 仍然跑后端定义的 active 版本。
  return (
    <div className="sa-root">
      <AppTopBar
        title={
          <span className="sa-top-title">
            <button onClick={() => {
              // 把当前选中的 skill+version 带回父页，父页 mount 时会读 ?skill=&version=
              // 重新初始化它自己的 selectedSkillId / selectedVersion——实现「里改→外同步」。
              const qs = new URLSearchParams();
              qs.set('skill', skillName);
              if (selectedVersion != null) qs.set('version', String(selectedVersion));
              router.push(`/skill-eval?${qs.toString()}`);
            }}>
              Skills 分析
            </button>
            <span>/</span>
            <b>触发分析</b>
            <span className="sa-top-dot">·</span>
            <select
              className="sa-top-select"
              value={skillName}
              onChange={e => {
                const nextName = e.target.value;
                if (nextName && nextName !== skillName) {
                  router.push(`/skill-eval/trigger/${encodeURIComponent(nextName)}`);
                }
              }}
              aria-label="切换 Skill"
            >
              {!currentSkill && <option value={skillName}>{skillName}（当前）</option>}
              {skillsList.map(s => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              className="sa-top-select sa-top-select-version"
              value={selectedVersion ?? ''}
              onChange={e => {
                const next = Number(e.target.value);
                setSelectedVersion(next);
                // 把版本同步进 URL，浏览器后退 / 刷新能落回同一版本；
                // 同时也是「返回父页时把当前版本带回」那一步的真相源——
                // 父页 onClick 回跳时直接读 selectedVersion 的最新值。
                const params = new URLSearchParams(Array.from(searchParams?.entries() ?? []));
                if (Number.isFinite(next)) params.set('version', String(next));
                else params.delete('version');
                const qs = params.toString();
                router.replace(qs ? `?${qs}` : '?', { scroll: false });
              }}
              disabled={!currentSkill || sortedVersions.length === 0}
              aria-label="切换版本"
            >
              {sortedVersions.length === 0 && selectedVersion != null && (
                <option value={selectedVersion}>v{selectedVersion}</option>
              )}
              {sortedVersions.map(v => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                  {v.version === currentSkill?.activeVersion ? '（当前）' : ''}
                </option>
              ))}
            </select>
          </span>
        }
        showDefaultActions={false}
      />

      <main className="sa-main">
        {/* 触发分析的 hero 卡 —— 跟静态合规分析的 DetailHeader 一一对应：标题 + badge + 元信息 +
           所有当前分析相关的操作按钮（模型选择 / 重新起草 / 保存 / 立即复测）。 */}
        <header className="sa-detail-head">
          <div className="sa-detail-hero">
            <div>
              <h1>
                触发分析 <span className="sa-pill primary">opencode-live</span>
              </h1>
              <p>
                {skillName}
                {selectedVersion != null ? ` · v${selectedVersion}` : ''}
                {' · 触发评价集 + opencode-live 路由评测'}
              </p>
              <div className="sa-detail-meta">
                {set ? (
                  <>
                    <span>
                      数据集 v{set.version}（{VERSION_SOURCE_LABEL[set.versionSource] ?? set.versionSource}
                      {set.versionNote ? ` · ${set.versionNote}` : ''}）
                    </span>
                    <span>
                      {set.items.length} 条 query · 正例{' '}
                      {set.items.filter(i => i.shouldTrigger).length} · 反例{' '}
                      {set.items.filter(i => !i.shouldTrigger).length}
                    </span>
                    {!isViewingLatestSet && (
                      <span style={{ color: '#a16207' }}>
                        正在查看历史版本（只读）
                      </span>
                    )}
                    {!latestRun && (
                      <span style={{ color: 'var(--sa-muted, #71717a)' }}>
                        {selectedVersion != null ? `skill v${selectedVersion} 还没跑过评测` : '还没跑过评测'}
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{ color: 'var(--sa-muted, #71717a)' }}>
                    {loading ? '加载中...' : '尚未配置数据集'}
                  </span>
                )}
              </div>
            </div>
            <div className="sa-detail-actions">
              <select
                value={draftConfigId}
                onChange={e => setDraftConfigId(e.target.value)}
                title="起草用的模型 (来自 /modelconfig)"
                aria-label="起草模型"
                style={{ maxWidth: 200 }}
              >
                {modelConfigs.length === 0 ? (
                  <option value="">（未注册模型，将用 env 兜底）</option>
                ) : (
                  modelConfigs.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.id === activeConfigId ? ' · 默认' : ''}
                    </option>
                  ))
                )}
              </select>
              <button className="sa-btn" onClick={draftRedo} disabled={drafting}>
                {drafting ? '起草中...' : hasAnyVersion ? 'AI 起草新版本' : 'AI 起草'}
              </button>
              <button
                className="sa-btn"
                onClick={() => uploadInputRef.current?.click()}
                disabled={uploading}
                title="上传 JSON 文件：[{ query, shouldTrigger, rationale? }, ...]"
              >
                {uploading ? '上传中...' : '上传数据集'}
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) void onUploadFile(f);
                }}
              />
              <button
                className="sa-btn"
                onClick={saveAll}
                disabled={saving || !set || readOnly}
                title={readOnly ? '只能编辑最新版本——切回 latest 再保存' : undefined}
              >
                {saving ? '保存中...' : '保存'}
              </button>
              <button
                className="sa-btn sa-btn-primary"
                onClick={() => setRunDialogOpen(true)}
                disabled={!set || set.items.length === 0}
              >
                {hasRun ? '立即复测' : '立即评测'}
              </button>
            </div>
          </div>
        </header>

        {errorMsg && (
          <div
            style={{
              padding: '10px 14px',
              marginBottom: 12,
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* ─────────── ① 配置 · 数据集构建 ─────────── */}
        <SectionShell
          num={1}
          variant="config"
          title="配置 · 数据集构建"
          desc='触发评价集：哪些 query 该 / 不该命中本 Skill'
          summary={
            <ConfigSummary
              set={set}
              isViewingLatestSet={isViewingLatestSet}
              versionsCount={versions.length}
            />
          }
          open={configSecOpen}
          onToggle={() => setConfigSecOpen(o => !o)}
        >
          {versions.length > 0 && (
            <TriggerDatasetVersionsPanel
              versions={versions}
              latestId={latestSet?.id ?? null}
              selectedId={set?.id ?? null}
              open={datasetVersionsOpen}
              onToggle={() => setDatasetVersionsOpen(o => !o)}
              onSelect={id => setSelectedSetId(id)}
              onResetLatest={() => setSelectedSetId(null)}
            />
          )}
          {!loading && (
            <div className="recall-editor-grid">
              <TriggerColumn
                kind="positive"
                items={positiveItems}
                resultByItemId={resultByItemId}
                readOnly={readOnly}
                onAdd={() => addItem(true)}
                onUpdate={updateItem}
                onDelete={deleteItem}
                onMove={id => updateItem(id, { shouldTrigger: false })}
              />
              <TriggerColumn
                kind="negative"
                items={negativeItems}
                resultByItemId={resultByItemId}
                readOnly={readOnly}
                onAdd={() => addItem(false)}
                onUpdate={updateItem}
                onDelete={deleteItem}
                onMove={id => updateItem(id, { shouldTrigger: true })}
              />
            </div>
          )}
        </SectionShell>

        {/* ─────────── ② 执行 · 评测运行 ─────────── */}
        <SectionShell
          num={2}
          variant="exec"
          title="执行 · 评测运行"
          desc="按当前数据集跑批，得出触发命中率 / 误触发率"
          summary={
            <ExecSummary
              runs={runs}
              latestRun={latestRun}
              modelLabelOf={(id: string | null) => (id ? modelConfigs.find(c => c.id === id)?.name ?? id : null)}
            />
          }
          open={execSecOpen}
          onToggle={() => setExecSecOpen(o => !o)}
        >
          <div className="recall-exec-actions">
            <button
              className="sa-btn sa-btn-primary"
              onClick={() => setRunDialogOpen(true)}
              disabled={!set || set.items.length === 0}
            >
              {hasRun ? '立即复测' : '立即评测'}
            </button>
            <span className="recall-exec-hint">
              点击会打开评测配置对话框（模型 / 每条 query 跑几次 / 阈值 / 并发 / 数据集版本）
            </span>
          </div>
          {runs.length > 0 && (
            <TriggerRunHistoryPanel
              runs={runs}
              latestRunId={latestRun?.id ?? null}
              selectedRunId={displayedRun?.id ?? null}
              open={historyOpen}
              onToggle={() => setHistoryOpen(o => !o)}
              onSelect={id => {
                setSelectedRunId(id);
                // 点击 row 自动展开结果块，保证用户看到切换效果
                setResultSecOpen(true);
              }}
              onResetLatest={() => setSelectedRunId(null)}
              modelLabelOf={id => (id ? modelConfigs.find(c => c.id === id)?.name ?? id : null)}
            />
          )}
        </SectionShell>

        {/* ─────────── ③ 结果 · 触发分析 ─────────── */}
        <SectionShell
          num={3}
          variant="result"
          title="结果 · 触发分析"
          desc={
            displayedRun
              ? `${new Date(displayedRun.createdAt).toLocaleString()} · v${displayedRun.skillVersion}${
                  displayedRun.modelId
                    ? ` · ${modelConfigs.find(c => c.id === displayedRun.modelId)?.name ?? displayedRun.modelId}`
                    : ''
                }${viewingHistory ? ' · 历史 run' : ''}`
              : '尚未评测'
          }
          summary={<ResultSummary run={displayedRun} />}
          open={resultSecOpen}
          onToggle={() => setResultSecOpen(o => !o)}
        >
          {displayedRun ? (
            <RecallResultBlock
              run={displayedRun}
              triggerSet={set}
              viewingHistory={viewingHistory}
              onBackToLatest={() => setSelectedRunId(null)}
            />
          ) : (
            <div className="recall-empty">
              <b>尚未跑过评测。</b>
              <div style={{ marginTop: 6 }}>
                先在 <b>① 配置</b> 里准备好用例，再到 <b>② 执行</b> 点击「立即评测」开始。
              </div>
            </div>
          )}
        </SectionShell>
      </main>

      {runDialogOpen && (
        <RunDialog
          skillName={skillName}
          skillVersion={selectedVersion}
          user={user}
          modelConfigs={modelConfigs}
          activeConfigId={activeConfigId}
          versions={versions}
          latestSetId={latestSet?.id ?? null}
          currentSetId={set?.id ?? null}
          onClose={() => setRunDialogOpen(false)}
          running={running}
          setRunning={setRunning}
          onCompleted={() => {
            setRunDialogOpen(false);
            void reload();
          }}
          onError={msg => setErrorMsg(msg)}
        />
      )}
    </div>
  );
}

// =========================================================================
// 触发评价集列（应触发 / 不该触发）
// =========================================================================
function TriggerColumn({
  kind,
  items,
  resultByItemId,
  readOnly,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
}: {
  kind: 'positive' | 'negative';
  items: TriggerItem[];
  resultByItemId: Map<string, RunResultItem>;
  /** 非 latest 版本时为 true：disable textarea + 隐藏 加/移/删 按钮 */
  readOnly?: boolean;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<TriggerItem>) => void;
  onDelete: (id: string) => void;
  /** 把该条目挪到对侧（正↔反），用于用户改错时快速纠正 */
  onMove: (id: string) => void;
}) {
  const isPositive = kind === 'positive';
  const accent = isPositive ? '#10b981' : '#ef4444';
  const tintBg = isPositive ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)';
  const moveLabel = isPositive ? '挪到反例 →' : '← 挪到正例';
  return (
    <section
      style={{
        background: 'var(--bg-card, #fff)',
        border: '1px solid var(--line, #e3e3e3)',
        borderRadius: 8,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          padding: '10px 14px',
          background: tintBg,
          borderBottom: `2px solid ${accent}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: accent,
          }}
        />
        <strong style={{ fontSize: 13, color: 'var(--fg, #333)' }}>
          {isPositive ? '应触发' : '不该触发'}
        </strong>
        <span style={{ fontSize: 12, color: '#888' }}>· {items.length} 条</span>
      </header>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {items.length === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: '#aaa', fontSize: 12 }}>
            {isPositive ? '还没有"应触发"用例' : '还没有"不该触发"用例'}
          </div>
        ) : (
          items.map(item => {
            const result = resultByItemId.get(item.id);
            return (
              <div
                key={item.id}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--line-soft, #f0f0f0)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <textarea
                  value={item.query}
                  onChange={e => onUpdate(item.id, { query: e.target.value })}
                  placeholder="用户的真实输入..."
                  readOnly={readOnly}
                  style={{
                    width: '100%',
                    minHeight: 48,
                    border: '1px solid var(--line, #e3e3e3)',
                    borderRadius: 4,
                    padding: '6px 8px',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    resize: 'vertical',
                    background: readOnly ? 'rgba(0,0,0,0.03)' : 'var(--bg-card, #fff)',
                    color: 'var(--fg, #333)',
                  }}
                />
                {item.rationale && (
                  <div style={{ fontSize: 11, color: '#888' }}>ℹ {item.rationale}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      fontSize: 11,
                      borderRadius: 3,
                      background: SOURCE_LABEL[item.source].tone + '22',
                      color: SOURCE_LABEL[item.source].tone,
                    }}
                  >
                    {SOURCE_LABEL[item.source].label}
                  </span>
                  {result ? (
                    <span style={{ fontSize: 12, fontFamily: 'monospace', display: 'inline-flex', gap: 6 }}>
                      <span style={{ color: result.pass ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                        {result.pass ? '✓ pass' : '✗ fail'}
                      </span>
                      <span style={{ color: '#888' }}>
                        触发 {result.runsTriggered}/{result.runsTotal}
                      </span>
                      {result.competingSkill && (
                        <span style={{ color: '#a16207' }}>↳ 被 {result.competingSkill} 抢路由</span>
                      )}
                    </span>
                  ) : null}
                  <div style={{ flex: 1 }} />
                  {!readOnly && (
                    <>
                      <button
                        onClick={() => onMove(item.id)}
                        title="放错列了？一键挪到对侧"
                        style={{
                          padding: '3px 8px',
                          background: 'transparent',
                          color: '#888',
                          border: '1px solid var(--line, #e3e3e3)',
                          borderRadius: 3,
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        {moveLabel}
                      </button>
                      <button onClick={() => onDelete(item.id)} style={btnDanger}>删</button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
        {!readOnly && (
          <button
            onClick={onAdd}
            style={{
              margin: 12,
              padding: '8px 12px',
              background: 'transparent',
              color: accent,
              border: `1px dashed ${accent}`,
              borderRadius: 5,
              fontSize: 13,
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            + 加{isPositive ? '正例' : '反例'}
          </button>
        )}
      </div>
    </section>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: '7px 14px',
  background: '#3b65e8',
  color: '#fff',
  border: 'none',
  borderRadius: 5,
  fontSize: 13,
  cursor: 'pointer',
  fontWeight: 500,
};
const btnSecondary: React.CSSProperties = {
  padding: '7px 12px',
  background: 'var(--bg-card, #fff)',
  color: 'var(--fg, #333)',
  border: '1px solid var(--line, #e3e3e3)',
  borderRadius: 5,
  fontSize: 12,
  cursor: 'pointer',
};
const btnDanger: React.CSSProperties = {
  padding: '4px 9px',
  background: '#fef2f2',
  color: '#ef4444',
  border: '1px solid #fecaca',
  borderRadius: 4,
  fontSize: 11,
  cursor: 'pointer',
};

// =========================================================================
// 复测对话框
// =========================================================================
function RunDialog({
  skillName,
  skillVersion,
  user,
  modelConfigs,
  activeConfigId,
  versions,
  latestSetId,
  currentSetId,
  onClose,
  running,
  setRunning,
  onCompleted,
  onError,
}: {
  skillName: string;
  /**
   * 在哪个 skill 版本上跑评测。null = 让后端用 latest。
   * 必须传：否则 v2 上点评测会被后端打到 latest 上，分数显示就漂到错的版本去了。
   */
  skillVersion: number | null;
  user: string | null;
  modelConfigs: Array<{ id: string; name: string; model?: string }>;
  activeConfigId: string;
  /** 全部数据集版本（version desc） */
  versions: TriggerSet[];
  /** latest 版本 id —— 默认就是这个 */
  latestSetId: string | null;
  /** 编辑器当前看的版本 id —— 若用户已经在看某个历史版本，对话框默认就跑那个 */
  currentSetId: string | null;
  onClose: () => void;
  running: boolean;
  setRunning: (v: boolean) => void;
  onCompleted: () => void;
  onError: (msg: string) => void;
}) {
  const [runsPerQuery, setRunsPerQuery] = useState(1);
  const [triggerThreshold, setTriggerThreshold] = useState(0.5);
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [concurrency, setConcurrency] = useState(5);
  const [modelConfigId, setModelConfigId] = useState<string>(activeConfigId);
  // 默认跑「用户当前在看的版本」；没有就 latest
  const [triggerSetId, setTriggerSetId] = useState<string>(currentSetId ?? latestSetId ?? '');
  // 模态框内部的错误状态——之前只往 parent 抛 onError，banner 被遮挡看不到，
  // 用户以为"35ms 就结束了什么也没发生"。在模态框里就地展示。
  const [dialogError, setDialogError] = useState<string | null>(null);

  const startRun = async () => {
    if (!user) return;
    setRunning(true);
    setDialogError(null);
    try {
      const res = await apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skillName)}/run`, {
        method: 'POST',
        body: JSON.stringify({
          user,
          // 把当前选中的 skill 版本传给后端，让 run 落到正确版本下、
          // 且 opencode 实测的是该版本的 SKILL.md 内容（不传则后端用 latest）。
          skillVersion: skillVersion ?? undefined,
          triggerSetId: triggerSetId || undefined,
          modelConfigId: modelConfigId || undefined,
          runsPerQuery,
          triggerThreshold,
          timeoutMs,
          concurrency,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `run failed: ${res.status}`);
      }
      onCompleted();
    } catch (err) {
      const msg = (err as Error)?.message ?? '评测失败';
      setDialogError(msg);
      onError(msg); // 仍然往 parent 同步一份，关掉模态框后还能看到
      setRunning(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={() => !running && onClose()}
    >
      <div
        style={{
          background: 'var(--bg, #fff)',
          padding: 24,
          borderRadius: 8,
          minWidth: 480,
          maxWidth: 560,
        }}
        onClick={e => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>跑触发评测</h3>
        <div
          style={{
            margin: '0 0 16px',
            padding: '10px 12px',
            background: '#eef2ff',
            border: '1px solid #c7d2fe',
            borderRadius: 6,
            fontSize: 12,
            color: '#3730a3',
          }}
        >
          opencode-live 模式 · 评测会在你 opencode 实际项目配置下跑（包括兄弟 skill 竞争）
        </div>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: '#666' }}>数据集版本</span>
          <select
            value={triggerSetId}
            onChange={e => setTriggerSetId(e.target.value)}
            disabled={versions.length === 0}
            style={{
              width: '100%',
              padding: '6px 10px',
              border: '1px solid var(--line, #e3e3e3)',
              borderRadius: 4,
              fontSize: 13,
              marginTop: 4,
              background: 'var(--bg-card, #fff)',
            }}
          >
            {versions.length === 0 ? (
              <option value="">（暂无数据集版本）</option>
            ) : (
              versions.map(v => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                  {v.id === latestSetId ? '（latest）' : ''}
                  {' · '}
                  {VERSION_SOURCE_LABEL[v.versionSource] ?? v.versionSource}
                  {' · '}
                  {v.items.length} 条
                  {v.versionNote ? ` · ${v.versionNote}` : ''}
                </option>
              ))
            )}
          </select>
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: '#666' }}>评测用的模型（来自 /modelconfig）</span>
          <select
            value={modelConfigId}
            onChange={e => setModelConfigId(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 10px',
              border: '1px solid var(--line, #e3e3e3)',
              borderRadius: 4,
              fontSize: 13,
              marginTop: 4,
              background: 'var(--bg-card, #fff)',
            }}
          >
            {modelConfigs.length === 0 ? (
              <option value="">（未注册模型，将用 env 兜底）</option>
            ) : (
              modelConfigs.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.id === activeConfigId ? ' · 默认' : ''}
                </option>
              ))
            )}
          </select>
        </label>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#666' }}>高级选项</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
            <label>
              <div style={{ fontSize: 11, color: '#888' }}>每条 query 跑几次</div>
              <input
                type="number"
                min={1}
                max={10}
                value={runsPerQuery}
                onChange={e => setRunsPerQuery(Number(e.target.value))}
                style={inputStyle}
              />
            </label>
            <label>
              <div style={{ fontSize: 11, color: '#888' }}>触发阈值（0-1）</div>
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={triggerThreshold}
                onChange={e => setTriggerThreshold(Number(e.target.value))}
                style={inputStyle}
              />
            </label>
            <label>
              <div style={{ fontSize: 11, color: '#888' }}>单条超时（ms）</div>
              <input
                type="number"
                min={5000}
                max={120000}
                step={1000}
                value={timeoutMs}
                onChange={e => setTimeoutMs(Number(e.target.value))}
                style={inputStyle}
              />
            </label>
            <label>
              <div style={{ fontSize: 11, color: '#888' }}>并发数</div>
              <input
                type="number"
                min={1}
                max={10}
                value={concurrency}
                onChange={e => setConcurrency(Number(e.target.value))}
                style={inputStyle}
              />
            </label>
          </div>
        </details>

        {dialogError && (
          <div
            style={{
              marginTop: 16,
              padding: '10px 12px',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              borderRadius: 6,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>评测失败</div>
            {dialogError}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button onClick={onClose} disabled={running} style={btnSecondary}>
            取消
          </button>
          <button onClick={startRun} disabled={running} style={btnPrimary}>
            {running ? '评测中...' : dialogError ? '重试' : '开始评测'}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '5px 8px',
  border: '1px solid var(--line, #e3e3e3)',
  borderRadius: 4,
  fontSize: 13,
  marginTop: 3,
};

// =========================================================================
// ③ 结果块的核心渲染——Hero（总评分 + 4 个 mini 指标）+ FindingsGrouped
// （应触发 / 应不触发 两组折叠卡）。和静态合规分析的 EvaluationContent 视觉同源。
//
// 注意：
// - 主分用「X 分」表达（passRate × 100 取整），不再用百分号；与静态合规对齐。
// - TPR / FPR 仍保留百分号——这是诊断率而不是评分。
// - 每个 case 的 rationale 当 evidence；触发观察当 reasoning；改进建议放 suggestion。
//   通过的 case 走 passed: true（轻量绿色样式，不显 severity / suggestion）。
// =========================================================================
function RecallResultBlock({
  run,
  triggerSet,
  viewingHistory,
  onBackToLatest,
}: {
  run: RunRecord;
  /** 触发评价集——用来取每条 case 的 rationale 作 evidence */
  triggerSet: TriggerSet | null;
  viewingHistory?: boolean;
  onBackToLatest?: () => void;
}) {
  const score = Math.round(run.passRate * 100);
  const tprPct = Math.round(run.truePositiveRate * 100);
  const fprPct = Math.round(run.falsePositiveRate * 100);
  const total = run.results.length;
  const passed = run.results.filter(r => r.pass).length;
  const positives = run.results.filter(r => r.shouldTrigger);
  const negatives = run.results.filter(r => !r.shouldTrigger);
  const latencies = run.results
    .map(r => r.latencyMsAvg)
    .filter(n => Number.isFinite(n) && n > 0);
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, n) => a + n, 0) / latencies.length)
    : null;

  // itemId → rationale 索引：rationale 是 trigger set 起草时填的"这条 case 测什么"，
  // 当作"原因"（reasoning）展示——缺失就不展示，避免「都长一样」的占位填充。
  const rationaleMap = new Map<string, string | undefined>(
    (triggerSet?.items || []).map(it => [it.id, it.rationale]),
  );

  const toItem = (r: typeof run.results[number]): FindingItem => {
    // 证据 = 本次跑的实测数据。每条 case 的触发率 / runs 数 / 抢路由情况都不同，
    // 自然就是 per-case 真证据，绝对不会"全长一样"。
    const triggerObs = `实际触发率 ${Math.round(r.triggerRate * 100)}%（命中 ${r.runsTriggered}/${r.runsTotal} 次${
      r.latencyMsAvg > 0 ? ` · 平均 ${Math.round(r.latencyMsAvg)}ms` : ''
    }）${r.competingSkill ? ` · 被「${r.competingSkill}」抢路由` : ''}`;
    // 原因 = 当初这条 case 想测什么（rationale）。没有就不展示，让它退化为空——
    // 比硬塞「触发评价集标记为应该命中本 Skill」的占位句子干净。
    const rationale = rationaleMap.get(r.itemId)?.trim() || null;

    if (r.pass) {
      return {
        id: r.itemId,
        summary: r.query,
        severity: 'low',
        evidence: triggerObs,
        reasoning: rationale,
        passed: true,
      };
    }
    return {
      id: r.itemId,
      summary: r.query,
      severity: r.shouldTrigger ? 'high' : 'medium',
      evidence: triggerObs,
      reasoning: rationale,
      suggestedFix: r.shouldTrigger
        ? '在 SKILL.md 加该类 query 的触发关键词或更明确的触发场景说明'
        : '在 SKILL.md 加排除条件 / 边界说明，避免被无关 query 命中',
    };
  };

  const posItems = positives.map(toItem);
  const negItems = negatives.map(toItem);
  const posPass = posItems.filter(i => i.passed).length;
  const negPass = negItems.filter(i => i.passed).length;

  const groups: FindingGroup[] = [
    {
      key: 'positive',
      title: '应触发场景',
      desc: '触发评价集中标记为"应该命中本 Skill"的 case；未通过的是漏触发。',
      status: positives.length === 0 ? 'notEvaluated' : posPass === positives.length ? 'passed' : 'failed',
      scoreLabel: positives.length > 0 ? `命中 ${posPass} / ${positives.length}` : undefined,
      items: posItems,
    },
    {
      key: 'negative',
      title: '应不触发场景',
      desc: '触发评价集中标记为"不应该命中本 Skill"的 case；命中的属于误触发。',
      status: negatives.length === 0 ? 'notEvaluated' : negPass === negatives.length ? 'passed' : 'failed',
      scoreLabel: negatives.length > 0 ? `正确忽略 ${negPass} / ${negatives.length}` : undefined,
      items: negItems,
    },
  ];

  return (
    <div className="ev-content">
      {viewingHistory && onBackToLatest && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="trigger-overview-history-badge">查看历史 run</span>
          <button
            type="button"
            className="trigger-overview-back-btn"
            onClick={onBackToLatest}
            title="切回最新一次评测"
          >
            ← 回到最新
          </button>
        </div>
      )}

      {/* Hero —— 主分用「X 分」 */}
      <div className="ev-hero">
        <div className="ev-hero-main">
          <div className={`ev-hero-num ${scoreColorClass(score)}`}>
            {score}
            <span className="ev-hero-unit">分</span>
          </div>
          <div className="ev-hero-label">
            总评分 · 命中 {passed} / {total}
          </div>
        </div>
        <div className="ev-hero-sub">
          <HeroMini
            value={`${tprPct}%`}
            label="TPR · 真阳率"
            hint="应触发的命中比例"
            tone={tprPct >= 70 ? 'good' : tprPct >= 50 ? null : 'bad'}
          />
          <HeroMini
            value={`${fprPct}%`}
            label="FPR · 假阳率"
            hint="不该触发却命中"
            tone={fprPct <= 15 ? 'good' : fprPct <= 30 ? null : 'bad'}
          />
          <HeroMini
            value={avgLatency != null ? `${(avgLatency / 1000).toFixed(1)}s` : '--'}
            label="平均延迟"
            hint="单次决策耗时"
          />
          <HeroMini
            value={String(total)}
            label="评测规模"
            hint={`${positives.length} 应触发 + ${negatives.length} 不该`}
          />
        </div>
      </div>

      {run.errorMessage && (
        <div className="trigger-overview-error">错误：{run.errorMessage}</div>
      )}

      <FindingsGrouped
        groups={groups}
        title="分场景结果"
        hint="展开查看每个 case 的具体表现"
        emptyMessage="本次评测没有用例 ✓"
      />
    </div>
  );
}

function HeroMini({
  value,
  label,
  hint,
  tone,
}: {
  value: string;
  label: string;
  hint: string;
  tone?: 'good' | 'bad' | null;
}) {
  return (
    <div className="ev-hero-sub-item">
      <div className={`ev-hero-sub-num ${tone ?? ''}`}>{value}</div>
      <div className="ev-hero-sub-label">{label}</div>
      <div className="ev-hero-sub-hint">{hint}</div>
    </div>
  );
}

// 总评分阈值：80+ good / 60-79 warn / <60 bad
function scoreColorClass(score: number): 'good' | 'warn' | 'bad' {
  if (score >= 80) return 'good';
  if (score >= 60) return 'warn';
  return 'bad';
}

// ① 配置 section 的 summary 行
function ConfigSummary({
  set,
  isViewingLatestSet,
  versionsCount,
}: {
  set: TriggerSet | null;
  isViewingLatestSet: boolean;
  versionsCount: number;
}) {
  if (!set) {
    return <span style={{ color: 'var(--ev-muted)' }}>尚未配置数据集</span>;
  }
  const positives = set.items.filter(i => i.shouldTrigger).length;
  const negatives = set.items.length - positives;
  return (
    <>
      <span>当前</span>
      <code>v{set.version}</code>
      {isViewingLatestSet ? (
        <span style={{ color: 'var(--ev-success)', fontWeight: 600 }}>latest</span>
      ) : (
        <span style={{ color: '#a16207' }}>历史 · 只读</span>
      )}
      <span>·</span>
      <span>
        <b>{set.items.length}</b> 条
      </span>
      <span>
        · <span style={{ color: 'var(--ev-success)' }}>{positives} 应触发</span> /{' '}
        <span style={{ color: 'var(--ev-error)' }}>{negatives} 应不触发</span>
      </span>
      {versionsCount > 1 && (
        <span style={{ color: 'var(--ev-muted)', fontSize: 11 }}>· 共 {versionsCount} 个版本</span>
      )}
    </>
  );
}

// ② 执行 section 的 summary 行
function ExecSummary({
  runs,
  latestRun,
  modelLabelOf,
}: {
  runs: RunRecord[];
  latestRun: RunRecord | null;
  modelLabelOf: (id: string | null) => string | null;
}) {
  if (runs.length === 0) {
    return <span style={{ color: 'var(--ev-muted)' }}>尚未评测</span>;
  }
  if (!latestRun) {
    return <span style={{ color: 'var(--ev-muted)' }}>共 {runs.length} 次（无成功 run）</span>;
  }
  const score = Math.round(latestRun.passRate * 100);
  const klass = scoreColorClass(score);
  const modelName = modelLabelOf(latestRun.modelId);
  return (
    <>
      <span>已执行</span>
      <code>{runs.length} 次</code>
      <span>· 最近 {new Date(latestRun.createdAt).toLocaleString()}</span>
      {modelName && <span>· {modelName}</span>}
      <span>· 最近评分</span>
      <code className={`score-${klass}`}>{score} 分</code>
    </>
  );
}

// ③ 结果 section 的 summary 行
function ResultSummary({ run }: { run: RunRecord | null }) {
  if (!run) {
    return <span style={{ color: 'var(--ev-muted)' }}>未评测</span>;
  }
  const score = Math.round(run.passRate * 100);
  const klass = scoreColorClass(score);
  const passed = run.results.filter(r => r.pass).length;
  return (
    <>
      <span>总评分</span>
      <code className={`score-${klass}`}>{score} 分</code>
      <span>
        · 命中 {passed} / {run.results.length}
      </span>
    </>
  );
}

// =========================================================================
// 「历史数据集」面板 —— 默认折叠；展开后列出该 (user, skillName) 下所有数据集版本。
// 点击任意一行把编辑器切到那个版本（非 latest 只读）。这里复用历史评测面板的
// CSS class，外观保持一致；差异点是「latest 标」+ source/note 列。
// =========================================================================
function TriggerDatasetVersionsPanel({
  versions,
  latestId,
  selectedId,
  open,
  onToggle,
  onSelect,
  onResetLatest,
}: {
  versions: TriggerSet[];
  latestId: string | null;
  /** 当前编辑器在看哪个版本（null 等同 latest） */
  selectedId: string | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onResetLatest: () => void;
}) {
  const total = versions.length;
  const viewingHistory = selectedId != null && selectedId !== latestId;
  return (
    <div className="trigger-history-wrap">
      <button
        type="button"
        className="trigger-history-toggle"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className={`trigger-history-chevron ${open ? 'open' : ''}`}>▸</span>
        <span className="trigger-history-title">历史数据集</span>
        <span className="trigger-history-count">共 {total} 个版本</span>
        {viewingHistory && (
          <span className="trigger-history-viewing">正在查看历史版本（只读）</span>
        )}
        <span className="trigger-history-spacer" />
        {viewingHistory && (
          <span
            role="button"
            tabIndex={0}
            className="trigger-history-reset"
            onClick={e => {
              e.stopPropagation();
              onResetLatest();
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onResetLatest();
              }
            }}
          >
            回到 latest
          </span>
        )}
      </button>
      {open && (
        <div className="trigger-history-body">
          {total === 0 ? (
            <div className="trigger-history-empty">还没有数据集版本</div>
          ) : (
            <ul className="trigger-history-list">
              {versions.map(v => {
                const isLatest = v.id === latestId;
                const isSelected = v.id === selectedId || (selectedId == null && isLatest);
                const positives = v.items.filter(it => it.shouldTrigger).length;
                const negatives = v.items.length - positives;
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      className={`trigger-history-row ${isSelected ? 'selected' : ''}`}
                      onClick={() => onSelect(v.id)}
                    >
                      <span className="trigger-history-time">
                        v{v.version} · {new Date(v.createdAt).toLocaleString()}
                      </span>
                      <span className="trigger-history-tags">
                        <span className="trigger-history-tag muted">
                          {VERSION_SOURCE_LABEL[v.versionSource] ?? v.versionSource}
                        </span>
                        {v.versionNote && (
                          <span className="trigger-history-tag muted">{v.versionNote}</span>
                        )}
                        {isLatest && <span className="trigger-history-tag latest">latest</span>}
                        {isSelected && !isLatest && (
                          <span className="trigger-history-tag viewing">查看中</span>
                        )}
                      </span>
                      <span className="trigger-history-metrics">
                        <span className="trigger-history-metric">
                          <em>{v.items.length}</em>
                          <span>条</span>
                        </span>
                        <span className="trigger-history-metric">
                          <em>{positives}</em>
                          <span>正例</span>
                        </span>
                        <span className="trigger-history-metric">
                          <em>{negatives}</em>
                          <span>反例</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// 「历史评测」面板 —— 默认折叠；展开后展示该 skill 下历次评测 run 的紧凑列表。
// 点击任意一行将「执行概览」+ 行内评分切到那一次；当前展示的那条高亮，
// 「最新」一次额外打 latest 标。设计上 history ≠ archive：用户可以随时切回。
// =========================================================================
function TriggerRunHistoryPanel({
  runs,
  latestRunId,
  selectedRunId,
  open,
  onToggle,
  onSelect,
  onResetLatest,
  modelLabelOf,
}: {
  runs: RunRecord[];
  latestRunId: string | null;
  selectedRunId: string | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onResetLatest: () => void;
  modelLabelOf: (id: string | null) => string | null;
}) {
  const total = runs.length;
  const viewingHistory = selectedRunId != null && selectedRunId !== latestRunId;
  return (
    <div className="trigger-history-wrap">
      <button
        type="button"
        className="trigger-history-toggle"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className={`trigger-history-chevron ${open ? 'open' : ''}`}>▸</span>
        <span className="trigger-history-title">历史评测</span>
        <span className="trigger-history-count">共 {total} 次评测</span>
        {viewingHistory && (
          <span className="trigger-history-viewing">正在查看历史 · 点「回到最新」可恢复</span>
        )}
        <span className="trigger-history-spacer" />
        {viewingHistory && (
          <span
            role="button"
            tabIndex={0}
            className="trigger-history-reset"
            onClick={e => {
              e.stopPropagation();
              onResetLatest();
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onResetLatest();
              }
            }}
          >
            回到最新
          </span>
        )}
      </button>
      {open && (
        <div className="trigger-history-body">
          {total === 0 ? (
            <div className="trigger-history-empty">该版本下还没有历史评测</div>
          ) : (
            <ul className="trigger-history-list">
              {runs.map(r => {
                const isLatest = r.id === latestRunId;
                const isSelected = r.id === selectedRunId || (selectedRunId == null && isLatest);
                const modelName = modelLabelOf(r.modelId);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={`trigger-history-row ${isSelected ? 'selected' : ''} ${r.status === 'failed' ? 'failed' : ''}`}
                      onClick={() => onSelect(r.id)}
                    >
                      <span className="trigger-history-time">
                        {new Date(r.createdAt).toLocaleString()}
                      </span>
                      <span className="trigger-history-tags">
                        <span className="trigger-history-tag">v{r.skillVersion}</span>
                        {modelName && <span className="trigger-history-tag muted">{modelName}</span>}
                        {isLatest && <span className="trigger-history-tag latest">latest</span>}
                        {isSelected && !isLatest && (
                          <span className="trigger-history-tag viewing">查看中</span>
                        )}
                      </span>
                      <span className="trigger-history-metrics">
                        {r.status === 'done' ? (
                          <>
                            <span className="trigger-history-metric">
                              <em>{Math.round(r.passRate * 100)}%</em>
                              <span>通过</span>
                            </span>
                            <span className="trigger-history-metric">
                              <em>{Math.round(r.truePositiveRate * 100)}%</em>
                              <span>TPR</span>
                            </span>
                            <span className="trigger-history-metric">
                              <em>{Math.round(r.falsePositiveRate * 100)}%</em>
                              <span>FPR</span>
                            </span>
                            <span className="trigger-history-metric">
                              <em>{r.results.length}</em>
                              <span>条</span>
                            </span>
                          </>
                        ) : (
                          <span className={`trigger-history-status status-${r.status}`}>
                            {r.status === 'running' ? '执行中' : '失败'}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

