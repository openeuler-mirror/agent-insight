'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Info } from 'lucide-react';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { deriveEvaluatorTags } from '@/lib/evaluators/registry';
import EvaluatorDetailModal from '@/components/eval/EvaluatorDetailModal';
import {
  type EvaluatorCard,
  type EvaluatorType,
  type LlmEvaluatorConfig,
  findUnsupportedCustomEvaluatorVariables,
  isValidCustomEvaluatorName,
} from '@/lib/evaluators/custom-evaluator-model';

type TabKey = 'custom' | 'preset';

interface FilterState {
  query: string;
  evaluatorTypes: EvaluatorType[];
  targetTypes: string[];
  objectives: string[];
  /** 按派生标签多选筛选（AND 语义：卡片须同时具备所有选中标签） */
  tags: string[];
}

interface CustomToolbarState {
  nameQuery: string;
  creator: '' | 'all' | 'mine';
}

interface LlmEvaluatorDraft {
  name: string;
  description: string;
  /** 类目（注册时元数据）：res=看结果 / traj=看轨迹 */
  category: 'res' | 'traj';
  systemPrompt: string;
  /** 评分点清单（可选）：保存时收集非空行存入 card.pointsDef */
  points: Array<{ label: string; note: string }>;
}

// 类型筛选：当前预置与自建评估器均为 LLM（judge 形态）；Code / Custom RPC 模板未上线，
// 不放进选项避免用户点了发现没结果。
const evaluatorTypes: EvaluatorType[] = ['LLM'];
// 标签筛选选项（与 deriveEvaluatorTags 派生值对齐；「预置/自建」由 tab 承担，不进筛选）
const tagFilterOptions = ['LLM Judge', '看结果', '看轨迹', '依赖参考数据'];
// 场景：评估对象——"结果" 指评估 agent 最终答复的质量，"轨迹" 指评估 agent 内部执行链路。
// 老词是 'Agent'，含义模糊（agent 既可指评估主体也可指被评估面），统一改成"结果"避免歧义。
const targetTypes = Array.from(new Set(presetEvaluators.flatMap(card => card.targetTypes)));
const objectives = Array.from(new Set(presetEvaluators.flatMap(card => card.objectives)));

/** System Prompt 占位符插入按钮（与 CUSTOM_EVALUATOR_ALLOWED_VARIABLES 对齐） */
const placeholderButtons = [
  { token: '{{input}}', label: '任务输入' },
  { token: '{{output}}', label: '实际输出' },
  { token: '{{reference_output}}', label: '参考输出' },
  { token: '{{trajectory}}', label: '执行轨迹' },
];

const systemPromptPlaceholder = `请编写评估器的 system prompt。可引用以下字段：
{{input}}：任务输入
{{output}}：任务输出
{{reference_output}}：预期输出
{{trajectory}}：trace 轨迹

这些字段都不是必填；目前仅支持以上四个变量。评估器最终需要输出 0～100 的 score 和 reason。`;

const blankLlmDraft = (): LlmEvaluatorDraft => ({
  name: '',
  description: '',
  category: 'res',
  systemPrompt: '',
  points: [],
});

function emptyFilters(): FilterState {
  return {
    query: '',
    evaluatorTypes: [],
    targetTypes: [],
    objectives: [],
    tags: [],
  };
}

function emptyCustomToolbar(): CustomToolbarState {
  return { nameQuery: '', creator: 'all' };
}

function matchesFilter(card: EvaluatorCard, filters: FilterState) {
  const query = filters.query.trim().toLowerCase();
  const haystack = `${card.name} ${card.description} ${card.mappedMetrics.join(' ')}`.toLowerCase();
  if (query && !haystack.includes(query)) return false;
  if (filters.evaluatorTypes.length > 0 && !filters.evaluatorTypes.includes(card.evaluatorType)) return false;
  if (filters.targetTypes.length > 0 && !filters.targetTypes.some(item => card.targetTypes.includes(item))) return false;
  if (filters.objectives.length > 0 && !filters.objectives.some(item => card.objectives.includes(item))) return false;
  if (filters.tags.length > 0) {
    const cardTags = deriveEvaluatorTags(card);
    if (!filters.tags.every(tag => cardTags.includes(tag))) return false;
  }
  return true;
}

function matchesCustomToolbar(card: EvaluatorCard, bar: CustomToolbarState, user?: string | null) {
  const q = bar.nameQuery.trim().toLowerCase();
  const haystack = `${card.name} ${card.description} ${card.mappedMetrics.join(' ')}`.toLowerCase();
  if (q && !haystack.includes(q)) return false;
  if (bar.creator === 'mine' && user && card.creator !== user) return false;
  return true;
}

function toggleFilter<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

export default function EvaluatorsCenter() {
  const { user } = useAuth();
  const router = useRouter();
  const [customEvaluators, setCustomEvaluators] = useState<EvaluatorCard[]>([]);
  const [evaluatorsHydrated, setEvaluatorsHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('custom');
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [customToolbar, setCustomToolbar] = useState<CustomToolbarState>(emptyCustomToolbar);
  const [llmDraft, setLlmDraft] = useState<LlmEvaluatorDraft>(blankLlmDraft);
  const [customCreate, setCustomCreate] = useState<null | 'llm'>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 详情弹窗当前查看的卡片（预置 / 自建通用） */
  const [inspectCard, setInspectCard] = useState<EvaluatorCard | null>(null);
  /** 用户当前激活的评测模型，所有可执行评估器（含轨迹评估器）的运行模型 */
  const [activeModel, setActiveModel] = useState<{ id: string; name: string; model: string } | null>(null);

  useEffect(() => {
    if (!user) {
      setCustomEvaluators([]);
      setEvaluatorsHydrated(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    void (async () => {
      try {
        // 并行拉自建评估器 + 当前激活模型
        let list: EvaluatorCard[] = [];
        const [evalResMaybe, settingsResMaybe] = await Promise.allSettled([
          apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`),
          apiFetch(`/api/eval/settings?user=${encodeURIComponent(user)}`),
        ]);

        if (evalResMaybe.status === 'fulfilled' && evalResMaybe.value.ok) {
          try {
            const j = await evalResMaybe.value.json();
            if (Array.isArray(j)) list = j as EvaluatorCard[];
          } catch {
            /* 自建评估器解析失败 → 用空列表 */
          }
        }

        if (settingsResMaybe.status === 'fulfilled' && settingsResMaybe.value.ok) {
          try {
            const data = await settingsResMaybe.value.json();
            const activeId = data?.activeConfigId;
            const cfgs: any[] = Array.isArray(data?.configs) ? data.configs : [];
            const active = activeId ? cfgs.find(c => c.id === activeId) : null;
            if (!cancelled) {
              setActiveModel(active ? {
                id: active.id,
                name: active.name || '(unnamed)',
                model: active.model || '(unknown)',
              } : null);
            }
          } catch {
            /* settings 解析失败 → activeModel 留 null */
          }
        }

        if (!cancelled && list.length === 0 && typeof window !== 'undefined') {
          try {
            const raw = window.localStorage.getItem('agent-insight-custom-evaluators');
            const parsed = raw ? JSON.parse(raw) : [];
            if (Array.isArray(parsed) && parsed.length > 0) {
              list = parsed as EvaluatorCard[];
              await apiFetch('/api/user-evaluators', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, evaluators: list }),
              });
              window.localStorage.removeItem('agent-insight-custom-evaluators');
            }
          } catch {
            /* ignore corrupt localStorage */
          }
        }

        if (!cancelled) {
          setCustomEvaluators(list);
          setEvaluatorsHydrated(true);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '评估器数据加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user || !evaluatorsHydrated) return;
    const timer = window.setTimeout(() => {
      apiFetch('/api/user-evaluators', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, evaluators: customEvaluators }),
      }).catch(() => {
        /* 持久化失败不阻塞界面；可后续加 toast */
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [user, evaluatorsHydrated, customEvaluators]);

  const visibleCards = useMemo(() => {
    if (activeTab === 'preset') return presetEvaluators.filter(card => matchesFilter(card, filters));
    return customEvaluators.filter(card => matchesCustomToolbar(card, customToolbar, user));
  }, [activeTab, customEvaluators, filters, customToolbar, user]);

  const openLlmCreateFlow = () => {
    setLlmDraft(blankLlmDraft());
    setCustomCreate('llm');
    setError('');
  };

  const finalizeLlmEvaluator = () => {
    const name = llmDraft.name.trim();
    if (!name) {
      setError('请填写评估器名称');
      return;
    }
    if (!isValidCustomEvaluatorName(name)) {
      setError('名称会作为链路追踪中的 agent 名称：必须以英文字母开头，仅支持字母、数字、下划线、连字符');
      return;
    }
    if (!llmDraft.systemPrompt.trim()) {
      setError('请填写 System Prompt');
      return;
    }
    const unsupportedVars = findUnsupportedCustomEvaluatorVariables(llmDraft.systemPrompt);
    if (unsupportedVars.length > 0) {
      setError(`System Prompt 仅支持 {{input}}、{{output}}、{{reference_output}}、{{trajectory}}，不支持：${unsupportedVars.map(v => `{{${v}}}`).join('、')}`);
      return;
    }

    // 评分点：收集非空行（判定说明可选）
    const pointsDef = llmDraft.points
      .map(p => ({ label: p.label.trim(), note: p.note.trim() }))
      .filter(p => p.label)
      .map(p => (p.note ? { label: p.label, note: p.note } : { label: p.label }));

    // 模型：用平台当前激活的评测模型（用户在 settings/eval 那边切换）；评估器自身不绑定具体模型，
    // 只承载 prompt 配置。activeModel 还没就绪时存空字符串占位，运行时由 trajectory-eval 后端
    // fallback 到默认模型。
    // 新建评估器只保留单一提示词（systemPrompt）——判官场景 System/User 边界无语义意义；
    // userPrompt 字段仅为兼容旧执行路径/编辑页而保留在类型里，新建不再写入（omit → 编辑页也不显示该块）。
    const llmConfig: LlmEvaluatorConfig = {
      model: activeModel?.model || '',
      systemPrompt: llmDraft.systemPrompt.trim(),
    };

    const item: EvaluatorCard = {
      id: `custom-${Date.now()}`,
      name,
      description: llmDraft.description.trim() || '自建 LLM 评估器。',
      evaluatorType: 'LLM',
      source: 'custom',
      category: llmDraft.category,
      targetTypes: [llmDraft.category === 'traj' ? '轨迹' : '结果'],
      objectives: ['任务完成', '内容质量'],
      scenarios: ['Agent通用评测'],
      runMode: 'LLM Judge',
      scoreRange: '0-100',
      popularity: 0,
      mappedMetrics: llmConfig.model ? ['LLM 评测', llmConfig.model] : ['LLM 评测'],
      status: 'draft',
      creator: user || undefined,
      pointsDef: pointsDef.length > 0 ? pointsDef : undefined,
      llmConfig,
    };

    setCustomEvaluators(prev => [item, ...prev]);
    setCustomCreate(null);
    setLlmDraft(blankLlmDraft());
    setActiveTab('custom');
    setError('');
  };

  const onTabChange = (tab: TabKey) => {
    setActiveTab(tab);
    setCustomCreate(null);
    setInspectCard(null);
  };

  const deleteCustomEvaluator = async (card: EvaluatorCard) => {
    if (!user || card.source !== 'custom') return;
    if (!globalThis.confirm(`确定删除评估器「${card.name}」？`)) return;
    setError('');
    const prev = customEvaluators;
    const next = prev.filter(item => item.id !== card.id);
    setCustomEvaluators(next);
    try {
      const res = await apiFetch('/api/user-evaluators', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, evaluators: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error('删除失败');
    } catch (e) {
      setCustomEvaluators(prev);
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  if (loading) {
    return <div className="loading">正在整理评估器视图...</div>;
  }

  return (
    <div style={{ padding: '18px 22px 28px', maxWidth: 1500, margin: '0 auto' }}>

      {error && (
        <div className="ai-card" style={{ padding: 12, color: 'var(--error)', marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 280, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className="ai-badge ai-badge-b">Evaluators</span>
            {activeTab === 'preset' && (
              <span style={{ color: 'var(--foreground-muted)', fontSize: 11 }}>预置模板库</span>
            )}
            {activeTab === 'custom' && customCreate === null && (
              <span style={{ color: 'var(--foreground-muted)', fontSize: 11 }}>自建评估方案</span>
            )}
          </div>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: 1.2, fontWeight: 600, color: 'var(--foreground)' }}>评估器</h1>
          {customCreate === null && (
            <p style={{ margin: '6px 0 0', color: 'var(--foreground-secondary)', fontSize: 12.5, maxWidth: 820 }}>
              {activeTab === 'custom'
                ? '管理自建 LLM 评估器，配置会保存到服务端。点击卡片查看详情，详情内可进入编辑。'
                : '预置评估器模板库：按类型与场景筛选，点击可查看详情与执行入口。'}
            </p>
          )}
        </div>
        {activeTab === 'preset' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="ai-btn-s" onClick={() => window.location.reload()}>
              刷新
            </button>
          </div>
        )}
      </div>

      {customCreate === null && (
        <div style={{ borderBottom: '1px solid var(--border)', marginBottom: 0, display: 'flex', gap: 2 }}>
          <TabButton active={activeTab === 'custom'} onClick={() => onTabChange('custom')}>
            自建评估器
          </TabButton>
          <TabButton active={activeTab === 'preset'} onClick={() => onTabChange('preset')}>
            预置评估器
          </TabButton>
        </div>
      )}

      {activeTab === 'custom' && customCreate === 'llm' ? (
        <LlmEvaluatorCreatePanel
          draft={llmDraft}
          onChange={setLlmDraft}
          onBack={() => { setCustomCreate(null); setLlmDraft(blankLlmDraft()); setError(''); }}
          onSubmit={finalizeLlmEvaluator}
        />
      ) : activeTab === 'custom' ? (
        <div style={{ paddingTop: 16 }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 10,
              marginBottom: 16,
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, flex: 1, minWidth: 280 }}>
              <input
                value={customToolbar.nameQuery}
                onChange={e => setCustomToolbar(prev => ({ ...prev, nameQuery: e.target.value }))}
                placeholder="搜索名称"
                style={{
                  minWidth: 160,
                  flex: '1 1 160px',
                  maxWidth: 280,
                  height: 34,
                  borderRadius: 8,
                  border: '1px solid var(--input-border)',
                  background: 'var(--input-bg)',
                  color: 'var(--foreground)',
                  padding: '0 12px',
                  fontSize: 12.5,
                }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" className="ai-btn-s" title="刷新" onClick={() => window.location.reload()}>
                ↻
              </button>
              <button
                type="button"
                className="ai-btn-s"
                title={viewMode === 'grid' ? '切换列表' : '切换网格'}
                onClick={() => setViewMode(v => (v === 'grid' ? 'list' : 'grid'))}
              >
                {viewMode === 'grid' ? '≡' : '⊞'}
              </button>
              <button
                type="button"
                className="ai-btn-p"
                onClick={openLlmCreateFlow}
              >
                + 新建自定义评估器
              </button>
            </div>
          </div>

          {visibleCards.length === 0 ? (
            <CustomEmptyState onCreateLlm={openLlmCreateFlow} />
          ) : viewMode === 'grid' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(320px, 1fr))', gap: 12 }}>
              {visibleCards.map(card => (
                <EvaluatorCardView
                  key={card.id}
                  card={card}
                  activeTab={activeTab}
                  onInspect={setInspectCard}
                  activeModel={activeModel}
                  onModelConfigClick={() => router.push('/modelconfig/defaults')}
                  onDeleteCustom={deleteCustomEvaluator}
                />
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visibleCards.map(card => (
                <EvaluatorListRow
                  key={card.id}
                  card={card}
                  onOpen={() => setInspectCard(card)}
                  onDeleteCustom={deleteCustomEvaluator}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', minHeight: 620 }}>
          <aside style={{ borderRight: '1px solid var(--border)', padding: '16px 18px 16px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div className="ai-section-title">评估器筛选</div>
              <button type="button" className="ai-btn-s" onClick={() => setFilters(emptyFilters())}>
                清空
              </button>
            </div>
            <FilterGroup
              title="类型"
              options={evaluatorTypes}
              values={filters.evaluatorTypes}
              onToggle={value => setFilters(prev => ({ ...prev, evaluatorTypes: toggleFilter(prev.evaluatorTypes, value) }))}
            />
            <FilterGroup
              title="场景"
              options={targetTypes}
              values={filters.targetTypes}
              onToggle={value => setFilters(prev => ({ ...prev, targetTypes: toggleFilter(prev.targetTypes, value) }))}
            />
            <FilterGroup
              title="评估目标"
              options={objectives}
              values={filters.objectives}
              onToggle={value => setFilters(prev => ({ ...prev, objectives: toggleFilter(prev.objectives, value) }))}
            />
            <FilterGroup
              title="标签"
              options={tagFilterOptions}
              values={filters.tags}
              onToggle={value => setFilters(prev => ({ ...prev, tags: toggleFilter(prev.tags, value) }))}
            />
          </aside>

          <main style={{ padding: 16 }}>
            <div style={{ marginBottom: 14 }}>
              <input
                value={filters.query}
                onChange={event => setFilters(prev => ({ ...prev, query: event.target.value }))}
                placeholder="搜索评估器名称、说明或指标"
                style={{
                  width: '100%',
                  height: 34,
                  borderRadius: 8,
                  border: '1px solid var(--input-border)',
                  background: 'var(--input-bg)',
                  color: 'var(--foreground)',
                  padding: '0 12px',
                  fontSize: 12.5,
                }}
              />
            </div>

            {visibleCards.length === 0 ? (
              <EmptyState />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(320px, 1fr))', gap: 12 }}>
                {visibleCards.map(card => (
                  <EvaluatorCardView
                    key={card.id}
                    card={card}
                    activeTab={activeTab}
                    onInspect={setInspectCard}
                    activeModel={activeModel}
                    onModelConfigClick={() => router.push('/modelconfig/defaults')}
                    onDeleteCustom={deleteCustomEvaluator}
                  />
                ))}
              </div>
            )}
          </main>
        </div>
      )}

      {inspectCard ? (
        <EvaluatorDetailModal card={inspectCard} onClose={() => setInspectCard(null)} />
      ) : null}
    </div>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 36,
        padding: '0 16px',
        border: '1px solid var(--border)',
        borderBottom: active ? '2px solid var(--primary)' : '1px solid var(--border)',
        background: active ? 'var(--background)' : 'var(--background-secondary)',
        color: active ? 'var(--primary)' : 'var(--foreground)',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        borderRadius: '7px 7px 0 0',
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

function FilterGroup<T extends string>({
  title,
  options,
  values,
  onToggle,
}: {
  title: string;
  options: T[];
  values: T[];
  onToggle: (value: T) => void;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ color: 'var(--foreground-secondary)', fontSize: 12, marginBottom: 9 }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {options.map(option => {
          const selected = values.includes(option);
          return (
            <button
              key={option}
              type="button"
              onClick={() => onToggle(option)}
              style={{
                minHeight: 34,
                padding: '0 16px',
                borderRadius: 8,
                border: `1px solid ${selected ? 'var(--primary-subtle-border)' : 'var(--border)'}`,
                background: selected ? 'var(--primary-subtle)' : 'var(--background)',
                color: selected ? 'var(--primary)' : 'var(--foreground-secondary)',
                cursor: 'pointer',
                fontSize: 12.5,
              }}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EvaluatorCardView({
  card,
  activeTab,
  onInspect,
  activeModel,
  onModelConfigClick,
  onDeleteCustom,
}: {
  card: EvaluatorCard;
  activeTab: TabKey;
  onInspect?: (card: EvaluatorCard) => void;
  activeModel?: { id: string; name: string; model: string } | null;
  onModelConfigClick?: () => void;
  onDeleteCustom?: (card: EvaluatorCard) => void;
}) {
  const openInspect = () => onInspect?.(card);

  return (
    <article
      className="ai-card"
      role="button"
      tabIndex={0}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button')) return;
        openInspect();
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openInspect();
        }
      }}
      style={{
        padding: 16,
        minHeight: 176,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, color: 'var(--foreground)', fontSize: 15.5, fontWeight: 600 }}>{card.name}</h3>
          <p style={{ margin: '8px 0 0', color: 'var(--foreground-secondary)', fontSize: 12.5, lineHeight: 1.6 }}>{card.description}</p>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--foreground-muted)' }}>点击查看详情</p>
        </div>
        <span className={`ai-badge ${card.evaluatorType === 'Code' ? 'ai-badge-b' : card.evaluatorType === 'Custom RPC' ? 'ai-badge-g' : 'ai-badge-gr'}`} style={{ height: 22, whiteSpace: 'nowrap' }}>
          {card.evaluatorType}
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {deriveEvaluatorTags(card).map(tag => (
          <span
            key={tag}
            style={{
              background: 'var(--primary-subtle)',
              border: '1px solid var(--primary-subtle-border)',
              color: 'var(--primary)',
              borderRadius: 4,
              padding: '3px 7px',
              fontSize: 11,
            }}
          >
            {tag}
          </span>
        ))}
        {[...card.objectives, ...card.scenarios.slice(0, 2)].map(tag => (
          <span key={tag} style={{ background: 'var(--background-tertiary)', color: 'var(--foreground-secondary)', borderRadius: 4, padding: '3px 7px', fontSize: 11 }}>
            {tag}
          </span>
        ))}
      </div>

      <div style={{ marginTop: 'auto' }}>
        <MiniMeta label="评分" value={card.source === 'custom' ? '0-100' : card.scoreRange} />
      </div>

      {/* 可执行评估器：单独一行显示当前会用什么模型，带「修改」链接 */}
      {card.runtimeHref ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 8px',
            background: 'var(--background-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 11,
          }}
          onClick={e => e.stopPropagation()}
        >
          <span style={{ color: 'var(--foreground-muted)' }}>运行模型：</span>
          {activeModel ? (
            <>
              <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{activeModel.name}</span>
              <span style={{ color: 'var(--foreground-muted)', fontFamily: 'monospace' }}>· {activeModel.model}</span>
              <span style={{ color: 'var(--foreground-muted)' }}>（来自全局默认）</span>
            </>
          ) : (
            <span style={{ color: 'var(--error)', fontWeight: 500 }}>未配置</span>
          )}
          <span style={{ flex: 1 }} />
          {onModelConfigClick ? (
            <button
              type="button"
              className="ai-btn-s"
              style={{ fontSize: 10.5, padding: '2px 8px' }}
              onClick={e => {
                e.stopPropagation();
                onModelConfigClick();
              }}
            >
              {activeModel ? '修改' : '去配置'}
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className={`ai-badge ${card.status === 'ready' ? 'ai-badge-g' : card.status === 'draft' ? 'ai-badge-gr' : 'ai-badge-b'}`}>
            {card.status === 'ready' ? '已就绪' : card.status === 'draft' ? '草稿' : '预置'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {activeTab === 'custom' && onDeleteCustom ? (
            <button
              type="button"
              className="ai-btn-s"
              style={{ color: 'var(--error)' }}
              onClick={e => {
                e.stopPropagation();
                void onDeleteCustom(card);
              }}
            >
              删除
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function EvaluatorListRow({
  card,
  onOpen,
  onDeleteCustom,
}: {
  card: EvaluatorCard;
  onOpen: () => void;
  onDeleteCustom?: (card: EvaluatorCard) => void;
}) {
  return (
    <div
      className="ai-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 14px',
        flexWrap: 'wrap',
        cursor: 'pointer',
      }}
    >
      <div style={{ minWidth: 200, flex: 1 }}>
        <div style={{ fontWeight: 600, color: 'var(--foreground)' }}>{card.name}</div>
        <div style={{ fontSize: 12, color: 'var(--foreground-muted)', marginTop: 4 }}>{card.description}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {deriveEvaluatorTags(card).map(tag => (
            <span
              key={tag}
              style={{
                background: 'var(--primary-subtle)',
                border: '1px solid var(--primary-subtle-border)',
                color: 'var(--primary)',
                borderRadius: 4,
                padding: '2px 7px',
                fontSize: 11,
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
      <span className={`ai-badge ${card.evaluatorType === 'Code' ? 'ai-badge-b' : card.evaluatorType === 'Custom RPC' ? 'ai-badge-g' : 'ai-badge-gr'}`}>
        {card.evaluatorType}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`ai-badge ${card.status === 'ready' ? 'ai-badge-g' : card.status === 'draft' ? 'ai-badge-gr' : 'ai-badge-b'}`}>
          {card.status === 'ready' ? '已就绪' : card.status === 'draft' ? '草稿' : '预置'}
        </span>
        {card.source === 'custom' && onDeleteCustom ? (
          <button
            type="button"
            className="ai-btn-s"
            style={{ color: 'var(--error)' }}
            onClick={e => {
              e.stopPropagation();
              void onDeleteCustom(card);
            }}
          >
            删除
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MiniMeta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--background-secondary)', borderRadius: 7, padding: 8 }}>
      <div style={{ color: 'var(--foreground-muted)', fontSize: 11, marginBottom: 3 }}>{label}</div>
      <div style={{ color: 'var(--foreground)', fontSize: 12.5, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function LlmEvaluatorCreatePanel({
  draft,
  onChange,
  onBack,
  onSubmit,
}: {
  draft: LlmEvaluatorDraft;
  onChange: (d: LlmEvaluatorDraft) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const systemPromptRef = useRef<HTMLTextAreaElement | null>(null);

  /** 在 systemPrompt 光标处插入占位符，并把光标移到插入内容之后 */
  const insertPlaceholder = (token: string) => {
    const el = systemPromptRef.current;
    const value = draft.systemPrompt;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    onChange({ ...draft, systemPrompt: value.slice(0, start) + token + value.slice(end) });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const promptText = draft.systemPrompt;
  const usedPlaceholders = placeholderButtons.filter(p => promptText.includes(p.token));
  const usesReference = promptText.includes('{{reference_output}}');

  return (
    <div style={{ paddingTop: 20, maxWidth: 800 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          type="button"
          className="ai-btn-s"
          onClick={onBack}
          aria-label="返回"
          style={{ minWidth: 36, padding: '6px 10px' }}
        >
          ←
        </button>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--foreground)' }}>新建自定义评估器</h2>
      </div>

      <section style={{ marginBottom: 28 }}>
        <div className="ai-section-title" style={{ marginBottom: 14 }}>基础信息</div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
            <span style={{ color: 'var(--error)' }}>* </span>
            名称
          </span>
          <input
            value={draft.name}
            maxLength={50}
            onChange={e => onChange({ ...draft, name: e.target.value })}
            placeholder="例如 custom_eval_agent"
            style={{
              height: 36,
              borderRadius: 8,
              border: '1px solid var(--input-border)',
              background: 'var(--input-bg)',
              color: 'var(--foreground)',
              padding: '0 12px',
              fontSize: 13,
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>名称会作为链路追踪中的 agent 名称，仅支持英文、数字、下划线、连字符，且必须以英文字母开头。</span>
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)', textAlign: 'right' }}>{draft.name.length}/50</span>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
            <span style={{ color: 'var(--error)' }}>* </span>
            类目
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {([
              { value: 'res', label: '看结果' },
              { value: 'traj', label: '看轨迹' },
            ] as const).map(opt => {
              const selected = draft.category === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ ...draft, category: opt.value })}
                  style={{
                    minHeight: 34,
                    padding: '0 18px',
                    borderRadius: 8,
                    border: `1px solid ${selected ? 'var(--primary-subtle-border)' : 'var(--border)'}`,
                    background: selected ? 'var(--primary-subtle)' : 'var(--background)',
                    color: selected ? 'var(--primary)' : 'var(--foreground-secondary)',
                    fontWeight: selected ? 600 : 400,
                    cursor: 'pointer',
                    fontSize: 12.5,
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>类目为注册时元数据，决定结果呈现在「结果评测」还是「轨迹评测」板块，运行时不可变更。</span>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>描述</span>
          <textarea
            value={draft.description}
            maxLength={200}
            onChange={e => onChange({ ...draft, description: e.target.value })}
            placeholder="请输入描述"
            rows={3}
            style={{
              borderRadius: 8,
              border: '1px solid var(--input-border)',
              background: 'var(--input-bg)',
              color: 'var(--foreground)',
              padding: '10px 12px',
              fontSize: 13,
              resize: 'vertical',
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)', textAlign: 'right' }}>{draft.description.length}/200</span>
        </label>
      </section>

      <section style={{ marginBottom: 28 }}>
        <div className="ai-section-title" style={{ marginBottom: 14 }}>配置信息</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
            <span style={{ color: 'var(--error)' }}>* </span>
            评估提示词
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {placeholderButtons.map(p => (
              <button
                key={p.token}
                type="button"
                className="ai-btn-s"
                title={`插入 ${p.token}`}
                onClick={() => insertPlaceholder(p.token)}
                style={{ fontSize: 11, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
              >
                {p.token} {p.label}
              </button>
            ))}
          </div>
          <textarea
            ref={systemPromptRef}
            value={draft.systemPrompt}
            onChange={e => onChange({ ...draft, systemPrompt: e.target.value })}
            placeholder={systemPromptPlaceholder}
            rows={12}
            style={{
              borderRadius: 8,
              border: '1px solid var(--input-border)',
              background: 'var(--input-bg)',
              color: 'var(--foreground)',
              padding: '12px',
              fontSize: 12.5,
              lineHeight: 1.55,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minHeight: 18 }}>
            <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
              已使用占位符：
              {usedPlaceholders.length > 0
                ? usedPlaceholders.map(p => p.token).join('、')
                : '无'}
            </span>
            {usesReference ? (
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--primary)',
                  background: 'var(--primary-subtle)',
                  border: '1px solid var(--primary-subtle-border)',
                  borderRadius: 4,
                  padding: '1px 7px',
                }}
              >
                将自动打标 依赖参考数据
              </span>
            ) : null}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>评分点（可选）</span>
          {draft.points.map((point, index) => (
            <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={point.label}
                maxLength={50}
                onChange={e => {
                  const points = draft.points.slice();
                  points[index] = { ...points[index], label: e.target.value };
                  onChange({ ...draft, points });
                }}
                placeholder="评分点名称"
                style={{
                  flex: '0 0 200px',
                  height: 32,
                  borderRadius: 8,
                  border: '1px solid var(--input-border)',
                  background: 'var(--input-bg)',
                  color: 'var(--foreground)',
                  padding: '0 10px',
                  fontSize: 12.5,
                }}
              />
              <input
                value={point.note}
                maxLength={200}
                onChange={e => {
                  const points = draft.points.slice();
                  points[index] = { ...points[index], note: e.target.value };
                  onChange({ ...draft, points });
                }}
                placeholder="判定说明（可选）"
                style={{
                  flex: 1,
                  height: 32,
                  borderRadius: 8,
                  border: '1px solid var(--input-border)',
                  background: 'var(--input-bg)',
                  color: 'var(--foreground)',
                  padding: '0 10px',
                  fontSize: 12.5,
                }}
              />
              <button
                type="button"
                className="ai-btn-s"
                aria-label="删除评分点"
                style={{ color: 'var(--error)', minWidth: 30, padding: '4px 8px' }}
                onClick={() => onChange({ ...draft, points: draft.points.filter((_, i) => i !== index) })}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ai-btn-s"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => onChange({ ...draft, points: [...draft.points, { label: '', note: '' }] })}
          >
            ＋ 添加评分点
          </button>
        </div>
      </section>

      <section style={{ marginBottom: 28, padding: 14, borderRadius: 8, background: 'var(--background-secondary)', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span className="ai-section-title" style={{ margin: 0 }}>输出</span>
          <span
            title="评测模型须遵守的输出约定"
            aria-label="评测模型须遵守的输出约定"
            style={{ cursor: 'help', color: 'var(--foreground-muted)', display: 'inline-flex', alignItems: 'center' }}
          >
            <Info style={{ width: 16, height: 16 }} aria-hidden />
          </span>
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.65 }}>
          <strong style={{ color: 'var(--foreground)' }}>得分：</strong>
          最终须给出 0～100 的数值型分数：100 表示完全符合标准，0 表示完全不符合。
        </p>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.65 }}>
          <strong style={{ color: 'var(--foreground)' }}>原因：</strong>
          须提供可读的中文说明，并以固定收束句式结尾：<code style={{ fontSize: 12 }}>因此，应该给出[分数]是合理的评分</code>。
        </p>
      </section>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="ai-btn-s" onClick={onBack}>取消</button>
        <button type="button" className="ai-btn-p" onClick={onSubmit}>创建</button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ border: '1px dashed var(--border-dark)', borderRadius: 8, padding: 28, textAlign: 'center', background: 'var(--background-secondary)' }}>
      <div style={{ color: 'var(--foreground)', fontWeight: 500, marginBottom: 6 }}>没有匹配的评估器</div>
      <div style={{ color: 'var(--foreground-muted)', fontSize: 12 }}>调整筛选条件，或在「自建评估器」中新建。</div>
    </div>
  );
}

function CustomEmptyState({ onCreateLlm }: { onCreateLlm: () => void }) {
  return (
    <div style={{ border: '1px dashed var(--border-dark)', borderRadius: 8, padding: '48px 28px', textAlign: 'center', background: 'var(--background-secondary)' }}>
      <div style={{ color: 'var(--foreground)', fontWeight: 500, marginBottom: 8, fontSize: 15 }}>暂无自建评估器</div>
      <div style={{ color: 'var(--foreground-muted)', fontSize: 12.5, marginBottom: 18 }}>
        点击右上角「+ 新建自定义评估器」开始配置 LLM 评估器。
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="ai-btn-p" onClick={onCreateLlm}>新建自定义评估器</button>
      </div>
    </div>
  );
}
