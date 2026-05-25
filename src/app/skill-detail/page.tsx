'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/client/api';
import { useThemeColors } from '@/lib/client/theme-context';

interface SkillData {
  id: string;
  name: string;
  description?: string;
  category?: string;
  activeVersion: number;
}

interface SkillVersionData {
  version: number;
  content: string;
  changeLog?: string;
  createdAt: string;
}

interface GeneratedConfigItem {
  id: string;
  query?: string | null;
  routing_intent?: string;
  standard_answer: string;
}

interface BenchmarkGenerationResult {
  generator_skills: string[];
  skill: {
    id: string;
    name: string;
    version: number;
  };
  created: {
    routing: GeneratedConfigItem[];
    outcome: GeneratedConfigItem[];
  };
  skipped: {
    routingDuplicates: string[];
    outcomeAlreadyExists: boolean;
  };
  inventory: {
    routingCount: number;
    outcomeCount: number;
  };
}

interface InvokedSkill {
  name: string;
  version: number | null;
}

interface RoutingSkillBreakdown {
  skill: string;
  expected: boolean;
  invoked: boolean;
  matched: boolean;
  status: 'matched' | 'missed' | 'unexpected' | 'not_applicable';
  expected_version: number | null;
  invoked_version: number | null;
}

interface OutcomeSkillBreakdown {
  skill: string;
  version: number | null;
  role: 'primary' | 'invoked' | 'expected_only' | 'context_only';
  is_primary: boolean;
  is_invoked: boolean;
  is_expected: boolean;
  routing_status: RoutingSkillBreakdown['status'] | 'missing_dataset';
  shares_execution_outcome: true;
  score: number | null;
  is_correct: boolean | null;
}

interface RoutingEvaluation {
  status: 'available' | 'missing';
  matched_query?: string;
  matched_intent?: string;
  matched_anchors?: string[];
  trigger_rate: number | null;
  expected_count: number;
  matched_count: number;
  skill_breakdown: RoutingSkillBreakdown[];
}

interface OutcomeEvaluation {
  status: 'available' | 'missing' | 'pending';
  matched_query?: string;
  matched_skill?: string;
  matched_skill_version?: number | null;
  score: number | null;
  reason?: string;
  root_cause_count: number;
  key_action_count: number;
  skill_breakdown: OutcomeSkillBreakdown[];
}

interface SkillLogEntry {
  task_id?: string;
  upload_id?: string;
  timestamp?: string;
  query?: string;
  final_result?: string;
  answer_score?: number | null;
  judgment_reason?: string;
  failures?: {
    failure_type: string;
    description: string;
    context: string;
    recovery: string;
  }[];
  skill_issues?: {
    content?: string;
    improvement_suggestion?: string;
  }[];
  label?: string | null;
  skill_version?: number | null;
  invoked_skills?: InvokedSkill[];
  routing_evaluation?: RoutingEvaluation | null;
  outcome_evaluation?: OutcomeEvaluation | null;
  focused_routing?: RoutingSkillBreakdown | null;
  focused_outcome?: OutcomeSkillBreakdown | null;
}

const cardStyle: React.CSSProperties = {
  background: '#111827',
  border: '1px solid #1f2937',
  borderRadius: '14px',
  padding: '1rem',
};

function formatDateTime(value?: string) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function truncateText(value?: string, max = 180) {
  if (!value) return '--';
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function formatSkillVersion(value: number | null | undefined) {
  return value != null ? `v${value}` : '未限定版本';
}

function formatInvokedSkills(skills: InvokedSkill[] = []) {
  if (skills.length === 0) return '--';
  return skills
    .map(skill => `${skill.name}${skill.version != null ? ` v${skill.version}` : ''}`)
    .join(', ');
}

function getRoutingStatusMeta(status?: RoutingSkillBreakdown['status'] | 'missing_dataset') {
  switch (status) {
    case 'matched':
      return { label: '命中', color: '#4ade80', background: 'rgba(74, 222, 128, 0.12)', border: 'rgba(74, 222, 128, 0.35)' };
    case 'missed':
      return { label: '漏召回', color: '#f87171', background: 'rgba(248, 113, 113, 0.12)', border: 'rgba(248, 113, 113, 0.35)' };
    case 'unexpected':
      return { label: '误召回', color: '#fbbf24', background: 'rgba(251, 191, 36, 0.12)', border: 'rgba(251, 191, 36, 0.35)' };
    case 'missing_dataset':
      return { label: '未配置 Skill 召回率数据集', color: '#94a3b8', background: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.35)' };
    default:
      return { label: '仅执行上下文涉及', color: '#94a3b8', background: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.35)' };
  }
}

function getOutcomeStatusMeta(status?: OutcomeEvaluation['status']) {
  switch (status) {
    case 'available':
      return { label: '已完成', color: '#4ade80', background: 'rgba(74, 222, 128, 0.12)', border: 'rgba(74, 222, 128, 0.35)' };
    case 'pending':
      return { label: '评测中', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.12)', border: 'rgba(56, 189, 248, 0.35)' };
    default:
      return { label: '未配置 Skill 执行效果数据集', color: '#94a3b8', background: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.35)' };
  }
}

function formatOutcomeRole(role?: OutcomeSkillBreakdown['role']) {
  switch (role) {
    case 'primary':
      return '主 Skill';
    case 'invoked':
      return '被调用 Skill';
    case 'expected_only':
      return '仅基准预期';
    case 'context_only':
      return '仅执行上下文';
    default:
      return '--';
  }
}

function MetricCard({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <div style={{ ...cardStyle, minHeight: '122px' }}>
      <div style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{title}</div>
      <div style={{ color: '#f8fafc', fontWeight: 800, fontSize: '1.8rem', marginBottom: '0.35rem' }}>{value}</div>
      <div style={{ color: '#64748b', fontSize: '0.8rem', lineHeight: 1.6 }}>{hint}</div>
    </div>
  );
}

function SkillContent() {
  const searchParams = useSearchParams();
  const skillId = searchParams.get('id');
  const skillName = searchParams.get('name');
  const user = searchParams.get('user') || undefined;
  const version = searchParams.get('version');
  const c = useThemeColors();

  const [skill, setSkill] = useState<SkillData | null>(null);
  const [skillVersion, setSkillVersion] = useState<SkillVersionData | null>(null);
  const [logs, setLogs] = useState<SkillLogEntry[]>([]);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isGeneratingBenchmarks, setIsGeneratingBenchmarks] = useState(false);
  const [benchmarkGenerationResult, setBenchmarkGenerationResult] = useState<BenchmarkGenerationResult | null>(null);
  const [benchmarkGenerationError, setBenchmarkGenerationError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchSkill() {
      setLoading(true);
      setError(null);

      try {
        let skillData: SkillData | null = null;

        if (skillId) {
          const res = await apiFetch(`/api/skills/${skillId}`);
          if (res.ok) {
            skillData = await res.json();
          }
        } else if (skillName) {
          const params = new URLSearchParams({ name: skillName });
          if (user) params.set('user', user);
          const res = await apiFetch(`/api/skills/by-name?${params.toString()}`);
          if (res.ok) {
            skillData = await res.json();
          }
        }

        if (!skillData) {
          setError('未找到对应 Skill');
          setLoading(false);
          return;
        }

        setSkill(skillData);

        const versionNum = version ? parseInt(version, 10) : skillData.activeVersion;
        const versionRes = await apiFetch(`/api/skills/${skillData.id}/versions/${versionNum}`);
        if (versionRes.ok) {
          setSkillVersion(await versionRes.json());
        }
      } catch {
        setError('加载 Skill 失败');
      }

      setLoading(false);
    }

    fetchSkill();
  }, [skillId, skillName, user, version]);

  useEffect(() => {
    async function fetchLogs() {
      if (!skill?.name) return;

      setLogsLoading(true);
      try {
        const params = new URLSearchParams({
          skill: skill.name,
          limit: '50',
        });

        const res = await apiFetch(`/api/skills/logs?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setLogs(Array.isArray(data) ? data : []);
          if (Array.isArray(data) && data.length > 0) {
            setExpandedRecordId(data[0].task_id || data[0].upload_id || null);
          }
        } else {
          setLogs([]);
        }
      } catch {
        setLogs([]);
      }
      setLogsLoading(false);
    }

    fetchLogs();
  }, [skill, version]);

  const summary = useMemo(() => {
    const routingRelevant = logs.filter(log => log.focused_routing?.expected);
    const routingMatched = routingRelevant.filter(log => log.focused_routing?.status === 'matched').length;
    const routingMissed = routingRelevant.filter(log => log.focused_routing?.status === 'missed').length;
    const routingUnexpected = logs.filter(log => log.focused_routing?.status === 'unexpected').length;

    const outcomeAvailable = logs.filter(log => log.outcome_evaluation?.status === 'available' && log.focused_outcome?.score != null);
    const outcomePending = logs.filter(log => log.outcome_evaluation?.status === 'pending').length;
    const avgOutcomeScore = outcomeAvailable.length > 0
      ? outcomeAvailable.reduce((sum, log) => sum + (log.focused_outcome?.score || 0), 0) / outcomeAvailable.length
      : null;

    const primaryRuns = logs.filter(log => log.focused_outcome?.role === 'primary').length;
    const invokedRuns = logs.filter(log => log.focused_outcome?.is_invoked).length;

    return {
      totalRuns: logs.length,
      routingRelevantCount: routingRelevant.length,
      routingMatched,
      routingMissed,
      routingUnexpected,
      routingHitRate: routingRelevant.length > 0 ? routingMatched / routingRelevant.length : null,
      avgOutcomeScore,
      outcomeAvailableCount: outcomeAvailable.length,
      outcomePending,
      primaryRuns,
      invokedRuns,
    };
  }, [logs]);

  if (loading) {
    return (
      <div style={{ padding: '2rem', color: c.fgSecondary }}>
        <p>正在加载 Skill...</p>
      </div>
    );
  }

  if (error || !skill) {
    return (
      <div style={{ padding: '2rem', color: c.fg }}>
        <Link href="/" style={{ color: c.link, marginBottom: '1rem', display: 'inline-block' }}>
          ← 返回首页
        </Link>
        <h1 style={{ color: c.error }}>未找到 Skill</h1>
        <p style={{ color: c.fgMuted }}>
          {error || '当前请求的 Skill 不存在，可能已被删除或当前用户无权限访问。'}
        </p>
      </div>
    );
  }

  const selectedVersion = (() => {
    const parsed = version ? parseInt(version, 10) : skill.activeVersion;
    return Number.isInteger(parsed) ? parsed : skill.activeVersion;
  })();

  const handleGenerateBenchmarks = async () => {
    if (!skill?.id || !user) {
      setBenchmarkGenerationError('需要带用户作用域并配置评测模型后，才能生成基准数据。');
      return;
    }

    setIsGeneratingBenchmarks(true);
    setBenchmarkGenerationError(null);

    try {
      const res = await apiFetch(`/api/skills/${skill.id}/benchmark-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user,
          version: selectedVersion,
          includeRouting: true,
          includeOutcome: true,
          routingCount: 4,
        }),
      });

      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload?.error || '生成基准数据失败');
      }

      setBenchmarkGenerationResult(payload);
    } catch (e: any) {
      setBenchmarkGenerationError(e.message || '生成基准数据失败');
    } finally {
      setIsGeneratingBenchmarks(false);
    }
  };

  return (
    <div style={{ padding: '2rem', color: c.fg, maxWidth: '1280px', margin: '0 auto' }}>
      <Link href="/" style={{ color: c.link, marginBottom: '1rem', display: 'inline-block' }}>
        ← 返回首页
      </Link>

      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
          {skill.name}
        </h1>
        <p style={{ color: c.fgMuted, fontSize: '0.95rem', lineHeight: 1.7, margin: 0 }}>
          分类：{skill.category || '其他'} | 当前查看版本：v{version || skill.activeVersion}
        </p>
        <p style={{ color: c.fgSecondary, fontSize: '0.85rem', lineHeight: 1.7, marginTop: '0.45rem' }}>
          本页面围绕当前 Skill 展开查看两类数据：Skill 召回率评测关注“哪些问题应该命中这个 Skill”；Skill 执行效果评测关注“命中该 Skill 后最终结果是否达标”。关键动作来自 Skill 的流程约束，同一 Skill / 版本只保留一套；关键观点来自用户提供的业务文档或标准答案，可按业务场景分别配置，也可留空。
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <MetricCard
          title="关联运行次数"
          value={String(summary.totalRuns)}
          hint="当前 Skill 作为主 Skill 或被调用 Skill 出现过的执行次数。"
        />
        <MetricCard
          title="Skill 召回命中率"
          value={summary.routingHitRate != null ? `${(summary.routingHitRate * 100).toFixed(0)}%` : '--'}
          hint={summary.routingRelevantCount > 0
            ? `${summary.routingMatched}/${summary.routingRelevantCount} 条 Skill 召回率样本正确命中了当前 Skill。`
            : '当前还没有 Skill 召回率数据集将该 Skill 作为目标命中项。'}
        />
        <MetricCard
          title="平均执行效果分"
          value={summary.avgOutcomeScore != null ? summary.avgOutcomeScore.toFixed(2) : '--'}
          hint={summary.outcomeAvailableCount > 0
            ? `基于 ${summary.outcomeAvailableCount} 条已完成效果评测的执行记录计算。`
            : '当前还没有可用的 Skill 执行效果评测结果。'}
        />
        <MetricCard
          title="主 / 被调用次数"
          value={`${summary.primaryRuns}/${summary.invokedRuns}`}
          hint="主 Skill 运行次数 / 被实际调用的运行次数。"
        />
      </div>

      <div style={{ ...cardStyle, marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: '760px' }}>
            <h3 style={{ marginTop: 0, marginBottom: '0.45rem', color: '#f8fafc' }}>Skill 基准数据生成</h3>
            <p style={{ color: '#94a3b8', margin: 0, lineHeight: 1.7, fontSize: '0.9rem' }}>
              可以直接基于当前 Skill 定义生成两类基准数据：Skill 召回率数据集用于定义“哪些问题应该命中该 Skill”，Skill 执行效果数据集用于定义“命中该 Skill 后应该交付什么结果”。这条能力由 <code>skill-benchmark-generator</code> 编排，内部调用 <code>routing-benchmark-generator</code> 和 <code>outcome-benchmark-generator</code>。
            </p>
          </div>
          <button
            onClick={handleGenerateBenchmarks}
            disabled={isGeneratingBenchmarks || !user}
            style={{
              padding: '0.75rem 1rem',
              borderRadius: '10px',
              border: '1px solid #2563eb',
              background: isGeneratingBenchmarks || !user ? '#1e293b' : '#2563eb',
              color: isGeneratingBenchmarks || !user ? '#94a3b8' : '#eff6ff',
              cursor: isGeneratingBenchmarks || !user ? 'not-allowed' : 'pointer',
              fontWeight: 700,
              minWidth: '190px',
            }}
          >
            {isGeneratingBenchmarks ? '生成中...' : '生成 Skill 基准数据'}
          </button>
        </div>

        {!user && (
          <div style={{ marginTop: '0.85rem', color: '#fbbf24', fontSize: '0.88rem' }}>
            需要带用户作用域并配置有效评测模型后，才能生成 Skill 基准数据。
          </div>
        )}

        {benchmarkGenerationError && (
          <div style={{ marginTop: '0.85rem', color: '#fca5a5', fontSize: '0.88rem' }}>
            {benchmarkGenerationError}
          </div>
        )}

        {benchmarkGenerationResult && (
          <div style={{ marginTop: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.85rem' }}>
            <div style={{ ...cardStyle, background: '#0f172a', padding: '0.9rem' }}>
              <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>当前库存</div>
              <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.8 }}>
                <div><strong style={{ color: '#94a3b8' }}>Skill 召回率数据：</strong> {benchmarkGenerationResult.inventory.routingCount}</div>
                <div><strong style={{ color: '#94a3b8' }}>Skill 执行效果数据：</strong> {benchmarkGenerationResult.inventory.outcomeCount}</div>
                <div><strong style={{ color: '#94a3b8' }}>Skill 版本：</strong> v{benchmarkGenerationResult.skill.version}</div>
                <div><strong style={{ color: '#94a3b8' }}>生成链路：</strong> {benchmarkGenerationResult.generator_skills.join('、')}</div>
              </div>
            </div>

            <div style={{ ...cardStyle, background: '#0f172a', padding: '0.9rem' }}>
              <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>本次生成结果</div>
              <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.8 }}>
                <div><strong style={{ color: '#94a3b8' }}>新增 Skill 召回率数据：</strong> {benchmarkGenerationResult.created.routing.length}</div>
                <div><strong style={{ color: '#94a3b8' }}>新增 Skill 执行效果数据：</strong> {benchmarkGenerationResult.created.outcome.length}</div>
                <div><strong style={{ color: '#94a3b8' }}>跳过重复样本：</strong> {benchmarkGenerationResult.skipped.routingDuplicates.length}</div>
                <div><strong style={{ color: '#94a3b8' }}>执行效果数据已存在：</strong> {benchmarkGenerationResult.skipped.outcomeAlreadyExists ? '是' : '否'}</div>
              </div>
            </div>

            <div style={{ ...cardStyle, background: '#0f172a', padding: '0.9rem' }}>
              <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>本次生成的 Skill 召回率问题</div>
              <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.7 }}>
                {benchmarkGenerationResult.created.routing.length > 0 ? (
                  benchmarkGenerationResult.created.routing.map(item => (
                    <div key={item.id} style={{ marginBottom: '0.45rem' }}>
                      <strong style={{ color: '#94a3b8' }}>问题：</strong> {item.query || '--'}
                      {item.routing_intent ? (
                        <div style={{ color: '#64748b', marginTop: '0.2rem' }}>
                          语义意图：{item.routing_intent}
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div style={{ color: '#64748b' }}>本次没有新增 Skill 召回率数据。</div>
                )}
              </div>
            </div>

            <div style={{ ...cardStyle, background: '#0f172a', padding: '0.9rem' }}>
              <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>Skill 执行效果数据</div>
              <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.7 }}>
                {benchmarkGenerationResult.created.outcome.length > 0 ? (
                  benchmarkGenerationResult.created.outcome.map(item => (
                    <div key={item.id}>
                      <div><strong style={{ color: '#94a3b8' }}>业务场景：</strong> {item.query || '--'}</div>
                      <div style={{ color: '#64748b', marginTop: '0.35rem' }}>
                        已为该 Skill 版本生成并保存标准答案；关键动作将与同版本其它场景复用。
                      </div>
                    </div>
                  ))
                ) : benchmarkGenerationResult.skipped.outcomeAlreadyExists ? (
                  <div style={{ color: '#64748b' }}>当前 Skill 版本已存在执行效果数据，本次未重复生成。</div>
                ) : (
                  <div style={{ color: '#64748b' }}>本次没有新增 Skill 执行效果数据。</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, marginBottom: '0.75rem', color: '#f8fafc' }}>Skill 召回率视角</h3>
          <div style={{ color: '#cbd5e1', lineHeight: 1.8, fontSize: '0.9rem' }}>
            <div><strong style={{ color: '#94a3b8' }}>命中：</strong> {summary.routingMatched}</div>
            <div><strong style={{ color: '#94a3b8' }}>漏召回：</strong> {summary.routingMissed}</div>
            <div><strong style={{ color: '#94a3b8' }}>误召回：</strong> {summary.routingUnexpected}</div>
          </div>
        </div>

        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, marginBottom: '0.75rem', color: '#f8fafc' }}>Skill 执行效果视角</h3>
          <div style={{ color: '#cbd5e1', lineHeight: 1.8, fontSize: '0.9rem' }}>
            <div><strong style={{ color: '#94a3b8' }}>已完成：</strong> {summary.outcomeAvailableCount}</div>
            <div><strong style={{ color: '#94a3b8' }}>评测中：</strong> {summary.outcomePending}</div>
            <div><strong style={{ color: '#94a3b8' }}>说明：</strong> 执行效果分数属于整次执行结果，这里从当前 Skill 的参与上下文进行查看。</div>
          </div>
        </div>
      </div>

      {skill.description && (
        <div style={{ ...cardStyle, marginBottom: '1.5rem' }}>
          <h3 style={{ color: '#94a3b8', marginBottom: '0.5rem', marginTop: 0 }}>Skill 描述</h3>
          <p style={{ margin: 0, lineHeight: 1.7 }}>{skill.description}</p>
        </div>
      )}

      {skillVersion?.changeLog && (
        <div style={{ ...cardStyle, marginBottom: '1.5rem' }}>
          <h3 style={{ color: '#94a3b8', marginBottom: '0.5rem', marginTop: 0 }}>版本变更说明</h3>
          <p style={{ margin: 0, lineHeight: 1.7 }}>{skillVersion.changeLog}</p>
        </div>
      )}

      <div style={{ ...cardStyle, marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
          <h3 style={{ color: '#f8fafc', margin: 0 }}>Skill 视角执行记录</h3>
          <span style={{ color: '#64748b', fontSize: '0.82rem' }}>
            {logsLoading ? '加载中...' : `${logs.length} 条记录`}
          </span>
        </div>

        {logsLoading ? (
          <div style={{ color: '#94a3b8', padding: '1rem 0' }}>正在加载最近执行记录...</div>
        ) : logs.length === 0 ? (
          <div style={{ color: '#94a3b8', padding: '1rem 0' }}>
            当前 Skill 版本还没有关联的执行记录。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {logs.map(log => {
              const recordId = log.task_id || log.upload_id || `${log.timestamp}-${log.query}`;
              const isExpanded = expandedRecordId === recordId;
              const routingMeta = getRoutingStatusMeta(log.focused_routing?.status);
              const outcomeMeta = getOutcomeStatusMeta(log.outcome_evaluation?.status);

              return (
                <div
                  key={recordId}
                  style={{
                    border: '1px solid #1f2937',
                    borderRadius: '12px',
                    background: '#0f172a',
                    overflow: 'hidden',
                  }}
                >
                  <button
                    onClick={() => setExpandedRecordId(isExpanded ? null : recordId)}
                    style={{
                      width: '100%',
                      padding: '1rem',
                      background: 'transparent',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                      color: '#e2e8f0',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.35rem' }}>
                          {truncateText(log.query, 140)}
                        </div>
                        <div style={{ color: '#64748b', fontSize: '0.82rem' }}>
                          {formatDateTime(log.timestamp)} | {log.label || formatSkillVersion(log.skill_version)}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <span style={{ padding: '0.28rem 0.55rem', borderRadius: '999px', fontSize: '0.78rem', color: routingMeta.color, background: routingMeta.background, border: `1px solid ${routingMeta.border}` }}>
                          召回率：{routingMeta.label}
                        </span>
                        <span style={{ padding: '0.28rem 0.55rem', borderRadius: '999px', fontSize: '0.78rem', color: outcomeMeta.color, background: outcomeMeta.background, border: `1px solid ${outcomeMeta.border}` }}>
                          执行效果：{outcomeMeta.label}
                        </span>
                      </div>
                    </div>
                  </button>

                  {isExpanded && (
                    <div style={{ padding: '0 1rem 1rem 1rem', borderTop: '1px solid #1f2937' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.85rem', marginTop: '1rem' }}>
                        <div style={{ ...cardStyle, background: '#111827', padding: '0.9rem' }}>
                          <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>当前 Skill 的召回率结果</div>
                          <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.8 }}>
                            <div><strong style={{ color: '#94a3b8' }}>状态：</strong> {routingMeta.label}</div>
                            <div><strong style={{ color: '#94a3b8' }}>预期 Skill 版本：</strong> {formatSkillVersion(log.focused_routing?.expected_version)}</div>
                            <div><strong style={{ color: '#94a3b8' }}>实际 Skill 版本：</strong> {formatSkillVersion(log.focused_routing?.invoked_version)}</div>
                            <div><strong style={{ color: '#94a3b8' }}>命中问题：</strong> {log.routing_evaluation?.matched_query || '--'}</div>
                            {log.routing_evaluation?.matched_intent && <div><strong style={{ color: '#94a3b8' }}>命中语义意图：</strong> {log.routing_evaluation.matched_intent}</div>}
                            {log.routing_evaluation?.matched_anchors?.length ? <div><strong style={{ color: '#94a3b8' }}>命中语义锚点：</strong> {log.routing_evaluation.matched_anchors.join(', ')}</div> : null}
                          </div>
                        </div>

                        <div style={{ ...cardStyle, background: '#111827', padding: '0.9rem' }}>
                          <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>当前 Skill 的执行效果上下文</div>
                          <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.8 }}>
                            <div><strong style={{ color: '#94a3b8' }}>角色：</strong> {formatOutcomeRole(log.focused_outcome?.role)}</div>
                            <div><strong style={{ color: '#94a3b8' }}>共享执行效果分：</strong> {log.focused_outcome?.score != null ? log.focused_outcome.score.toFixed(2) : '--'}</div>
                            <div><strong style={{ color: '#94a3b8' }}>评测项数：</strong> {log.outcome_evaluation ? log.outcome_evaluation.root_cause_count + log.outcome_evaluation.key_action_count : '--'}</div>
                            <div><strong style={{ color: '#94a3b8' }}>匹配 Skill：</strong> {log.outcome_evaluation?.matched_skill ? `${log.outcome_evaluation.matched_skill}${log.outcome_evaluation.matched_skill_version != null ? ` v${log.outcome_evaluation.matched_skill_version}` : ''}` : '--'}</div>
                            {log.outcome_evaluation?.matched_query && <div><strong style={{ color: '#94a3b8' }}>业务场景：</strong> {log.outcome_evaluation.matched_query}</div>}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '0.85rem', marginTop: '0.85rem' }}>
                        <div style={{ ...cardStyle, background: '#111827', padding: '0.9rem' }}>
                          <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>执行效果判定说明</div>
                          <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                            {log.outcome_evaluation?.reason || log.judgment_reason || '--'}
                          </div>
                        </div>

                        <div style={{ ...cardStyle, background: '#111827', padding: '0.9rem' }}>
                          <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>执行上下文</div>
                          <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.8 }}>
                            <div><strong style={{ color: '#94a3b8' }}>调用到的 Skill：</strong> {formatInvokedSkills(log.invoked_skills)}</div>
                            <div><strong style={{ color: '#94a3b8' }}>中间故障数：</strong> {log.failures?.length || 0}</div>
                            <div><strong style={{ color: '#94a3b8' }}>Skill 问题数：</strong> {log.skill_issues?.length || 0}</div>
                          </div>
                          {recordId && (
                            <div style={{ marginTop: '0.75rem' }}>
                              <Link
                                href={`/details?expandTaskId=${encodeURIComponent(recordId)}`}
                                style={{ color: '#60a5fa', fontSize: '0.85rem', textDecoration: 'underline' }}
                              >
                                打开执行详情
                              </Link>
                            </div>
                          )}
                        </div>
                      </div>

                      {log.final_result && (
                        <div style={{ ...cardStyle, background: '#111827', padding: '0.9rem', marginTop: '0.85rem' }}>
                          <div style={{ color: '#f8fafc', fontWeight: 700, marginBottom: '0.55rem' }}>最终结果预览</div>
                          <div style={{ color: '#cbd5e1', fontSize: '0.88rem', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                            {truncateText(log.final_result, 600)}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {skillVersion?.content && (
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ color: c.fgSecondary, marginBottom: '0.5rem' }}>Skill 内容</h3>
          <pre style={{
            padding: '1rem',
            background: c.codeBlockBg,
            borderRadius: '8px',
            overflow: 'auto',
            fontSize: '0.85rem',
            whiteSpace: 'pre-wrap',
            border: `1px solid ${c.border}`
          }}>
            {skillVersion.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function LoadingFallback() {
  const c = useThemeColors();
  return (
    <div style={{ padding: '2rem', color: c.fgSecondary }}>
      <p>正在加载 Skill...</p>
    </div>
  );
}

export default function SkillDetailPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <SkillContent />
    </Suspense>
  );
}
