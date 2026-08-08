'use client';

// 证据渲染小组件：默认折叠单行预览，点击展开后按内容格式自动渲染
// （{md} → 轻量 Markdown：**粗体** / `code` / - 列表；{json} → 缩进代码块）。
// 界面不展示格式徽章——格式由字段自识别（与 eval-output.ts 的 Evidence 契约一致）。
import { useState, type ReactNode } from 'react';

interface EvidenceLike {
  md?: string;
  json?: unknown;
}

function coerce(evidence: unknown): EvidenceLike | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const r = evidence as Record<string, unknown>;
  if (typeof r.md === 'string' && r.md.trim()) return { md: r.md };
  if ('json' in r && r.json !== undefined && r.json !== null) return { json: r.json };
  return null;
}

const SPECIALIZED_EVALUATOR_IDS = new Set([
  'preset-depth-result',
  'preset-agent-tool-utilization',
  'preset-agent-tool-selection',
]);

const SPECIALIZED_LABELS: Record<string, string> = {
  causal_depth: '因果分析深度',
  structured_reasoning: '结构化推理',
  multi_perspective_tradeoff: '多视角权衡',
  context_provision: '背景语境补充',
  insight_synthesis: '洞察综合',
  required_capability_coverage: '必要能力覆盖率',
  call_match_rate: '调用匹配率',
  call_restraint_rate: '调用节制率',
  tool_coverage: '工具覆盖',
  tool_frequency_distribution: '调用频次分布',
  tool_task_match_utilization: '工具与任务匹配',
  idle_tool_analysis: '闲置工具分析',
  tool_necessity: '工具必要性',
  tool_match: '工具-任务匹配度',
  parameter_validity: '参数合理性',
  result_utilization: '工具结果利用率',
  call_order: '调用顺序合理性',
  met: '达成', partial: '部分达成', missing: '未达成', not_applicable: '不适用',
  none: '不适用', light: '轻度展开', full: '充分展开',
  required: '必要', optional: '可选', useful: '有用', irrelevant: '无关',
  missing_required_tool: '遗漏必要 Tool/Skill',
  hallucinated_critical_argument: '关键参数缺少依据',
  wrong_core_tool: '核心 Tool/Skill 选择错误',
  ignored_key_result: '忽略关键调用结果',
  dependency_order_violation: '依赖调用顺序错误',
  irrelevant_call: '无关调用', redundant_call: '重复调用', invalid_argument: '参数不符合约束',
  out_of_catalog: '目录外调用', redundant: '冗余调用', ineffective: '无效调用',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function valueText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function labelFor(value: unknown): string {
  const text = valueText(value);
  return SPECIALIZED_LABELS[text] ?? text;
}

function specializedEvidenceMarkdown(value: unknown): string {
  const record = asRecord(value);
  if (!record) return '未提供可展示的专项评估依据。';
  const lines: string[] = [];
  const unscoredReason = valueText(record.unscoredReason);
  const verdict = labelFor(record.verdict);
  const reason = valueText(record.reason);
  const requiredDepth = labelFor(record.requiredDepth);
  const requiredDepthReason = valueText(record.requiredDepthReason);
  if (unscoredReason) lines.push(unscoredReason);
  if (requiredDepth) lines.push(`所需深度：${requiredDepth}`);
  if (requiredDepthReason) lines.push(`任务要求：${requiredDepthReason}`);
  if (verdict) lines.push(`判断：**${verdict}**`);
  if (reason) lines.push(`依据：${reason}`);

  const dimensions = Array.isArray(record.dimensions)
    ? record.dimensions.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  if (dimensions.length) {
    lines.push('维度判断：');
    for (const dimension of dimensions) {
      const label = labelFor(dimension.key) || '评分维度';
      const verdictText = labelFor(dimension.verdict);
      const score = typeof dimension.score === 'number' ? `${dimension.score} 分` : '';
      const assessment = [verdictText, score].filter(Boolean).join(' / ');
      const dimensionReason = valueText(dimension.reason);
      lines.push(`- **${label}${assessment ? ` · ${assessment}` : ''}**：${dimensionReason || '未提供说明'}`);
    }
  }

  const capabilityClassifications = Array.isArray(record.capabilityClassifications)
    ? record.capabilityClassifications.map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== null)
    : [];
  if (capabilityClassifications.length) {
    lines.push('能力分类：');
    for (const group of [
      { relevance: 'required', label: '必要能力' },
      { relevance: 'optional', label: '可选能力' },
      { relevance: 'irrelevant', label: '无关能力' },
    ]) {
      const members = capabilityClassifications.filter(
        (capability) => capability.relevance === group.relevance,
      );
      lines.push(`**${group.label}（${members.length} 项）**：`);
      if (!members.length) {
        lines.push('- 无');
        continue;
      }
      for (const capability of members) {
        const kind = valueText(capability.kind);
        const name = valueText(capability.name);
        const called = capability.called === true ? '已调用' : '未调用';
        const detail = capability.called === true
          ? valueText(capability.reason)
          : valueText(capability.idleReason) || valueText(capability.reason);
        lines.push(`- **${kind}:${name} · ${called}**：${detail || '未提供说明'}`);
      }
    }
  }

  const statistics = asRecord(record.statistics);
  if (statistics) {
    const entries = [
      ['必要能力', statistics.requiredCapabilityCount, ' 项'],
      ['已覆盖必要能力', statistics.calledRequiredCapabilityCount, ' 项'],
      ['必要能力覆盖率', statistics.requiredCapabilityCoverage, '%'],
      ['调用匹配率', statistics.callMatchRate, '%'],
      ['调用节制率', statistics.callRestraintRate, '%'],
      ['有效相关调用', statistics.effectiveRelatedCallCount, ' 次'],
      ['任务相关能力', statistics.relatedCapabilityCount, ' 项'],
      ['已调用相关能力', statistics.calledRelatedCapabilityCount, ' 项'],
      ['有效覆盖率', statistics.effectiveCoverage, '%'],
      ['原始覆盖率', statistics.rawCoverage, '%'],
      ['调用次数', statistics.capabilityCallCount, ' 次'],
      ['重复调用', statistics.repeatedCallCount, ' 次'],
      ['失败调用', statistics.failedCallCount, ' 次'],
    ].filter(([, value]) => typeof value === 'number')
      .map(([label, value, suffix]) => `${label} ${value}${suffix}`);
    if (entries.length) lines.push(`调用统计：${entries.join('；')}`);

    const unused = Array.isArray(statistics.unusedCapabilities)
      ? statistics.unusedCapabilities.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
      : [];
    if (unused.length) {
      lines.push(`未调用能力：${unused.map((item) => `${valueText(item.name)}（${labelFor(item.relevance)}）`).join('、')}`);
    }
  }

  const issues = Array.isArray(record.issues)
    ? record.issues.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  if (issues.length) {
    lines.push('发现的问题：');
    for (const issue of issues) {
      const title = labelFor(issue.code) || labelFor(issue.dimension) || '评估问题';
      const location = [valueText(issue.toolName), typeof issue.stepIndex === 'number' ? `step-${issue.stepIndex}` : '']
        .filter(Boolean).join('，');
      lines.push(`- **${title}${location ? ` · ${location}` : ''}**：${valueText(issue.reason) || '未提供说明'}`);
    }
  }

  const appliedCap = asRecord(record.appliedCap);
  if (appliedCap) lines.push(`总分上限：${valueText(appliedCap.summary) || valueText(appliedCap.reason) || `${valueText(appliedCap.value)} 分`}`);
  const suggestions = Array.isArray(record.suggestions) ? record.suggestions.map(valueText).filter(Boolean) : [];
  if (suggestions.length) {
    lines.push('改进建议：');
    suggestions.forEach((suggestion) => lines.push(`- ${suggestion}`));
  }
  return lines.length ? lines.join('\n') : '未提供可展示的专项评估依据。';
}

/** 行内轻量 Markdown：**粗体** 与 `code`。 */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
      return <b key={i}>{p.slice(2, -2)}</b>;
    }
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      return (
        <code
          key={i}
          style={{
            fontFamily: 'var(--font-mono, monospace)', fontSize: '0.92em',
            background: 'var(--background-secondary)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '0 4px',
          }}
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return p;
  });
}

/** 轻量 Markdown 块级渲染：段落 + - 列表（参考高保真 mdRender，不引第三方库）。 */
function renderMd(md: string): ReactNode {
  const lines = md.split('\n');
  const blocks: ReactNode[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (!listBuf.length) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={{ margin: '4px 0', paddingLeft: 17 }}>
        {listBuf.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
      </ul>,
    );
    listBuf = [];
  };
  for (const line of lines) {
    if (line.startsWith('- ')) {
      listBuf.push(line.slice(2));
      continue;
    }
    flushList();
    if (line.trim()) {
      blocks.push(<p key={`p-${blocks.length}`} style={{ margin: '3px 0' }}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return (
    <div style={{ fontSize: 11.5, lineHeight: 1.65, color: 'var(--foreground-secondary)' }}>
      {blocks}
    </div>
  );
}

function preview(ev: EvidenceLike, evaluatorId?: string): string {
  if (ev.md) {
    return ev.md.replace(/[*`#]/g, '').split('\n')
      .map((x) => x.trim().replace(/^-\s*/, '')).filter(Boolean).join('；');
  }
  if (evaluatorId && SPECIALIZED_EVALUATOR_IDS.has(evaluatorId)) {
    return specializedEvidenceMarkdown(ev.json).replace(/[*`#]/g, '').split('\n')
      .map((line) => line.trim().replace(/^-\s*/, '')).filter(Boolean).join('；');
  }
  const j = ev.json;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    return `{ ${Object.keys(j as object).join(' · ')} }`;
  }
  try { return JSON.stringify(j); } catch { return String(j); }
}

export function EvidenceBlock({ evidence, evaluatorId }: { evidence: unknown; evaluatorId?: string }) {
  const [open, setOpen] = useState(false);
  const ev = coerce(evidence);
  if (!ev) return null;
  return (
    <div
      style={{
        border: '1px solid var(--border)', borderRadius: 7,
        background: 'var(--background-secondary)', overflow: 'hidden',
      }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 9px',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span
          style={{
            fontSize: 11, color: 'var(--foreground-muted)', lineHeight: 1,
            display: 'inline-block', transition: 'transform .15s',
            transform: open ? 'rotate(90deg)' : 'none',
          }}
        >
          ›
        </span>
        <span
          style={{
            flex: 1, minWidth: 0, fontSize: 11, color: 'var(--foreground-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {preview(ev, evaluatorId)}
        </span>
      </div>
      {open && (
        <div style={{ padding: '7px 10px 9px', borderTop: '1px solid var(--border)', background: 'var(--card-bg)' }}>
          {ev.md ? renderMd(ev.md) : evaluatorId && SPECIALIZED_EVALUATOR_IDS.has(evaluatorId) ? (
            renderMd(specializedEvidenceMarkdown(ev.json))
          ) : (
            <pre
              style={{
                margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
                lineHeight: 1.55, color: 'var(--foreground-secondary)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(ev.json, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
