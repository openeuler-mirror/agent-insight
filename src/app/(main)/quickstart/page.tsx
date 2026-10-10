'use client';

import Link from 'next/link';
import { useState, type ComponentType } from 'react';
import {
  ArrowRight,
  Bot,
  Database,
  Download,
  Eye,
  FlaskConical,
  Gauge,
  Globe2,
  LayoutGrid,
  Map,
  Network,
  Rocket,
  Route,
  Ruler,
  ScanSearch,
  Settings2,
  Sparkles,
} from 'lucide-react';

import { PageHeader } from '@/components/shell/PageHeader';
import { PageContainer } from '@/components/shell/PageContainer';
import { useLocale } from '@/lib/client/locale-context';
import { cn } from '@/lib/utils';

type Icon = ComponentType<{ className?: string }>;
type StageKey = 'access' | 'observe' | 'evaluate' | 'diagnose' | 'optimize';

interface Capability {
  name: string;
  description: string;
  href: string;
  icon: Icon;
  action?: string;
}

interface QuickstartStage {
  key: StageKey;
  label: string;
  hint: string;
  description: string;
  advice: string;
  icon: Icon;
  capabilities: Capability[];
}

const copy = {
  zh: {
    title: '快速开始',
    kicker: '推荐使用路径',
    description: '沿着平台推荐流程，从 Agent 接入开始，逐步完成运行观测、评估验证、诊断分析与持续优化。',
    scope: '5 个阶段 · 11 个能力',
    stage: '阶段',
    advice: '推荐动作',
    capabilities: '本阶段能力',
    entries: '个入口',
    enter: '进入',
    start: '开始接入',
  },
  en: {
    title: 'Quick Start',
    kicker: 'Recommended journey',
    description: 'Follow the recommended journey from Agent onboarding through observability, evaluation, diagnosis, and continuous optimization.',
    scope: '5 stages · 11 capabilities',
    stage: 'Stage',
    advice: 'Recommended action',
    capabilities: 'Capabilities',
    entries: 'entries',
    enter: 'Open',
    start: 'Get started',
  },
} as const;

const quickstartStages: Record<'zh' | 'en', QuickstartStage[]> = {
  zh: [
    {
      key: 'access',
      label: '快速接入',
      hint: '准备平台能力',
      description: '先让 Agent 客户端接入平台，再准备模型和外部信息能力，为后续观测、评估和优化建立基础。',
      advice: '选择 Agent 框架完成客户端安装，确认首条 Trace 已上报；随后注册平台分析所需模型，并按需配置联网搜索。',
      icon: Rocket,
      capabilities: [
        { name: '客户端安装', description: '选择 Agent 框架，生成对应安装命令，完成采集端安装、鉴权与数据接入。', href: '/accessconfig/install', icon: Download, action: '开始接入' },
        { name: '模型注册', description: '接入诊断、评估和优化所需模型，配置供应商、凭据与默认模型。', href: '/modelconfig/registry', icon: Settings2 },
        { name: '联网搜索', description: '为需要外部资料的 Agent 任务与分析流程配置联网检索能力。', href: '/modelconfig/web-search', icon: Globe2 },
      ],
    },
    {
      key: 'observe',
      label: '运行观测',
      hint: '看见执行过程',
      description: '先掌握 Agent 资产与活跃状态，再从调用链、工具调用到推理资源状态逐层理解真实执行过程。',
      advice: '从 Agent 概览选择目标 Agent，再查看其链路追踪；需要判断容量或性能问题时，结合推理基础设施继续排查。',
      icon: Eye,
      capabilities: [
        { name: 'Agent 概览', description: '统一查看 Agent 的框架、运行状态与 Trace 概况，并从目标 Agent 下钻链路。', href: '/agents', icon: Bot },
        { name: '链路追踪', description: '查看执行状态与是否异常；进入详情后再查看异常事实和具体执行过程。', href: '/trace', icon: Network },
        { name: '推理基础设施', description: '观测推理服务、模型调用和资源状态，识别容量与性能问题。', href: '/infra', icon: Gauge },
      ],
    },
    {
      key: 'evaluate',
      label: '评估与实验',
      hint: '量化验证结果',
      description: '用稳定的数据和衡量标准验证 Agent 表现，让已有 Trace 和生成 Trace 进入一致的评估流程。',
      advice: '准备评测数据集与评估器，选择带框架信息的 Agent，再选择已有 Trace 或按数据集 Case 生成 Trace。',
      icon: FlaskConical,
      capabilities: [
        { name: '实验', description: '选择数据集、评估器和 Agent，并通过选择 Trace 或生成 Trace 开始评估。', href: '/experiments', icon: FlaskConical },
        { name: '评测数据集', description: '维护普通与可靠性评测 Case，为可重复验证提供一致基准。', href: '/dataset', icon: Database },
        { name: '评估器', description: '管理可靠性与非可靠性评估器，定义执行结果如何被衡量。', href: '/metrics', icon: Ruler },
      ],
    },
    {
      key: 'diagnose',
      label: '诊断分析',
      hint: '定位异常根因',
      description: '围绕异常 Trace 统一查看故障现象、根因结论和处理建议，缩短问题定位时间。',
      advice: '从异常或评估失败样本进入诊断，先确认根因证据，再决定调整客户端、Agent 还是 Skill。',
      icon: ScanSearch,
      capabilities: [
        { name: '诊断分析', description: '沿用现有智能诊断能力，分析故障链路并查看根因结论与处理建议。', href: '/fault', icon: ScanSearch },
      ],
    },
    {
      key: 'optimize',
      label: '持续优化',
      hint: '形成改进闭环',
      description: '围绕 Skill 汇总版本、生成、评测与优化能力，形成可版本化、可复评的持续改进闭环。',
      advice: '从 SkillHub 选择或创建 Skill，完成生成与评测，再依据问题样本进入优化并重新验证。',
      icon: Sparkles,
      capabilities: [
        { name: 'Skill', description: '在一个对话工作台中完成 Skill 生成、评估、实验、优化、复测与发布。', href: '/skills', icon: LayoutGrid },
      ],
    },
  ],
  en: [
    {
      key: 'access', label: 'Onboarding', hint: 'Prepare the platform', icon: Rocket,
      description: 'Connect an Agent client first, then prepare models and external information capabilities.',
      advice: 'Install the client for your Agent framework and verify the first Trace, then register models and web search as needed.',
      capabilities: [
        { name: 'Client Installation', description: 'Choose an Agent framework and generate the matching installation command.', href: '/accessconfig/install', icon: Download, action: 'Get started' },
        { name: 'Model Registry', description: 'Configure providers, credentials, and default models for analysis.', href: '/modelconfig/registry', icon: Settings2 },
        { name: 'Web Search', description: 'Configure external retrieval for Agent tasks and analysis.', href: '/modelconfig/web-search', icon: Globe2 },
      ],
    },
    {
      key: 'observe', label: 'Observability', hint: 'See every execution', icon: Eye,
      description: 'Understand Agent assets and activity, then inspect traces, tool calls, and inference resources.',
      advice: 'Select an Agent from the overview, inspect its traces, and use infrastructure signals for capacity or performance issues.',
      capabilities: [
        { name: 'Agent Overview', description: 'Review Agent frameworks, status, and Trace summaries.', href: '/agents', icon: Bot },
        { name: 'Trace Analysis', description: 'Separate execution status from anomalies and open details when needed.', href: '/trace', icon: Network },
        { name: 'Inference Infrastructure', description: 'Inspect inference services, model calls, and resource status.', href: '/infra', icon: Gauge },
      ],
    },
    {
      key: 'evaluate', label: 'Evaluation & Experiments', hint: 'Measure outcomes', icon: FlaskConical,
      description: 'Validate Agent quality with stable datasets and evaluators across existing or generated Traces.',
      advice: 'Prepare a dataset and evaluators, select one Agent, then choose existing Traces or generate new ones from Cases.',
      capabilities: [
        { name: 'Experiments', description: 'Select a dataset, evaluators, Agent, and Trace source.', href: '/experiments', icon: FlaskConical },
        { name: 'Datasets', description: 'Maintain standard and reliability evaluation Cases.', href: '/dataset', icon: Database },
        { name: 'Evaluators', description: 'Manage reliability and general-purpose evaluators.', href: '/metrics', icon: Ruler },
      ],
    },
    {
      key: 'diagnose', label: 'Diagnosis', hint: 'Find root causes', icon: ScanSearch,
      description: 'Inspect abnormal Traces, root-cause conclusions, and remediation guidance in one place.',
      advice: 'Start from an abnormal or failed sample, verify the evidence, then decide whether to adjust the client, Agent, or Skill.',
      capabilities: [
        { name: 'Diagnosis', description: 'Use the existing intelligent diagnosis page for root causes and guidance.', href: '/fault', icon: ScanSearch },
      ],
    },
    {
      key: 'optimize', label: 'Continuous Optimization', hint: 'Close the loop', icon: Sparkles,
      description: 'Bring SkillHub, generation, evaluation, and optimization into a versioned improvement loop.',
      advice: 'Choose or create a Skill in SkillHub, evaluate it, optimize against problem samples, and verify again.',
      capabilities: [
        { name: 'Skill', description: 'Generate, evaluate, experiment, optimize, retest, and publish in one conversational workbench.', href: '/skills', icon: LayoutGrid },
      ],
    },
  ],
};

export default function QuickstartPage() {
  const { locale } = useLocale();
  const language = locale === 'en' ? 'en' : 'zh';
  const text = copy[language];
  const stages = quickstartStages[language];
  const [activeKey, setActiveKey] = useState<StageKey>('access');
  const activeIndex = Math.max(0, stages.findIndex(stage => stage.key === activeKey));
  const activeStage = stages[activeIndex];
  const StageIcon = activeStage.icon;

  return (
    <>
      <PageHeader variant="management" moduleLabel={text.title} title={text.title} />
      <PageContainer variant="wide" className="gap-5 bg-background">
        <section className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary-border bg-primary-subtle px-2.5 py-1 text-xs font-medium text-primary">
              <Route className="size-3.5" />
              {text.kicker}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">{text.title}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-foreground-secondary">{text.description}</p>
          </div>
          <div className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground-secondary shadow-sm">
            <Map className="size-4 text-primary" />
            {text.scope}
          </div>
        </section>

        <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-border bg-card shadow-sm sm:grid-cols-5" role="tablist" aria-label={text.kicker}>
          {stages.map((stage, index) => {
            const selected = stage.key === activeKey;
            return (
              <button
                key={stage.key}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`quickstart-panel-${stage.key}`}
                onClick={() => setActiveKey(stage.key)}
                className={cn(
                  'group relative flex min-w-0 items-center gap-3 border-b border-border px-4 py-4 text-left transition-colors last:border-b-0 sm:block sm:border-b-0 sm:border-r sm:last:border-r-0',
                  selected ? 'bg-primary-subtle' : 'hover:bg-background-secondary',
                )}
              >
                <span className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors sm:mb-3',
                  selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border-dark bg-card text-foreground-secondary',
                )}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0">
                  <span className={cn('block truncate text-sm font-semibold', selected ? 'text-primary' : 'text-foreground')}>{stage.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-foreground-muted">{stage.hint}</span>
                </span>
                {selected && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
              </button>
            );
          })}
        </div>

        <section
          id={`quickstart-panel-${activeStage.key}`}
          role="tabpanel"
          className="grid min-h-[360px] grid-cols-1 overflow-hidden rounded-xl border border-border bg-card shadow-sm lg:grid-cols-[minmax(260px,0.8fr)_minmax(420px,1.6fr)]"
        >
          <div className="border-b border-border bg-background-secondary p-6 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-lg border border-primary-border bg-primary-subtle text-primary">
                <StageIcon className="size-5" />
              </span>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground-muted">{text.stage} {String(activeIndex + 1).padStart(2, '0')}</div>
                <h3 className="mt-0.5 text-lg font-semibold text-foreground">{activeStage.label}</h3>
              </div>
            </div>
            <p className="mt-5 text-sm leading-6 text-foreground-secondary">{activeStage.description}</p>
            <div className="mt-6 rounded-lg border border-primary-border bg-primary-subtle p-4">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-primary">
                <Sparkles className="size-3.5" />
                {text.advice}
              </div>
              <p className="text-xs leading-5 text-foreground-secondary">{activeStage.advice}</p>
            </div>
          </div>

          <div className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">{text.capabilities}</h3>
              <span className="rounded-full bg-background-secondary px-2.5 py-1 text-[11px] font-medium text-foreground-muted">
                {activeStage.capabilities.length} {text.entries}
              </span>
            </div>
            <div className="space-y-2.5">
              {activeStage.capabilities.map(capability => {
                const CapabilityIcon = capability.icon;
                return (
                  <Link
                    key={capability.href}
                    href={capability.href}
                    className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 transition-all hover:border-primary-border hover:bg-primary-subtle hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background-secondary text-foreground-secondary transition-colors group-hover:border-primary-border group-hover:bg-card group-hover:text-primary">
                      <CapabilityIcon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">{capability.name}</span>
                      <span className="mt-1 block text-xs leading-5 text-foreground-secondary">{capability.description}</span>
                    </span>
                    <span className="hidden shrink-0 items-center gap-1 text-xs font-medium text-primary sm:inline-flex">
                      {capability.action ?? text.enter}
                      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      </PageContainer>
    </>
  );
}
