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

// 文本指标评估器：落库仍是机器可读 JSON，展示层统一转成中文自然语言描述。
const TEXT_METRIC_EVALUATOR_IDS = new Set([
  'preset-text-rouge',
  'preset-text-exact-match',
  'preset-text-entity-f1',
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

function pctText(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  // 评分点证据是 0~1 比值，卡级证据已折算为百分制，按量级自适应。
  const normalized = Math.abs(value) <= 1 ? value * 100 : value;
  return `${Math.round(normalized * 10) / 10}%`;
}

function rougeTokenizerLabel(tokenizer: unknown): string {
  const text = valueText(tokenizer);
  if (text.includes('unicode-char(cjk)')) return '中文按 Unicode 字符级计算';
  if (text.includes('Intl.Segmenter')) return '词级分词（Intl.Segmenter）';
  if (text.includes('fallback')) return '字符/词级混合兜底分词';
  return text || '默认分词';
}

function textEvalConfigSummary(config: unknown): string {
  const record = asRecord(config);
  if (!record) return '';
  const parts: string[] = [];
  const mode = valueText(record.matchMode);
  if (mode === 'exact') parts.push('完全一致匹配');
  if (mode === 'fuzzy') parts.push(`模糊匹配（编辑距离 ≤ ${valueText(record.fuzzyThreshold)}）`);
  if (mode === 'substring') parts.push('子串匹配');
  if (typeof record.caseSensitive === 'boolean') parts.push(record.caseSensitive ? '区分大小写' : '忽略大小写');
  if (record.punctuationInsensitive === true) parts.push('忽略标点');
  if (record.whitespaceNormalization === true) parts.push('归一化空白');
  if (record.widthNormalization === true) parts.push('全半角归一');
  const scoring = valueText(record.multiCandidateScoring);
  if (scoring === 'any') parts.push('任一候选命中即满分');
  if (scoring === 'fraction') parts.push('按候选命中比例计分');
  return parts.join('；');
}

function textMetricEvidenceMarkdown(value: unknown): string {
  const record = asRecord(value);
  if (!record) return '未提供可展示的评估依据。';
  const unscoredReason = valueText(record.unscoredReason);
  if (unscoredReason) return unscoredReason;
  const parseError = valueText(record.parseError);
  if (parseError) return `输出无法解析为实体列表，记 0 分：${parseError}`;

  const lines: string[] = [];

  if (valueText(record.metric) === 'ROUGE') {
    lines.push(`综合公式：${valueText(record.formula) || '总分 = [ROUGE-1（单词重叠） + ROUGE-2（连续两词重叠） + ROUGE-L（最长公共子序列）] 三项 F1（精确率与召回率的调和平均）的平均值'}`);
    lines.push(`分词方式：${rougeTokenizerLabel(record.tokenizer)}`);
    const stats = [
      typeof record.generatedTokenCount === 'number' ? `生成文本 ${record.generatedTokenCount} 个分词单元（token）` : '',
      typeof record.referenceTokenCount === 'number' ? `参考文本 ${record.referenceTokenCount} 个分词单元（token）` : '',
    ].filter(Boolean);
    if (stats.length) lines.push(`分词统计：${stats.join('，')}`);
    return lines.join('\n');
  }

  if (typeof record.lcsLength === 'number' || typeof record.overlapCount === 'number') {
    if (typeof record.lcsLength === 'number') {
      lines.push(`最长公共子序列（LCS）长度 ${record.lcsLength}（生成侧 ${valueText(record.generatedTokenCount) || 0} 个、参考侧 ${valueText(record.referenceTokenCount) || 0} 个）`);
    } else {
      lines.push(`重叠 n-gram（连续词组）${record.overlapCount} 个（生成侧 ${valueText(record.generatedNgramCount) || 0} 个、参考侧 ${valueText(record.referenceNgramCount) || 0} 个）`);
    }
    lines.push(`精确率 ${pctText(record.precision)}，召回率 ${pctText(record.recall)}，F1（精确率与召回率的调和平均）${pctText(record.f1)}`);
    return lines.join('\n');
  }

  if (Array.isArray(record.candidates)) {
    lines.push(`原始输出："${valueText(record.rawOutput)}"`);
    lines.push(`标准化后："${valueText(record.normalizedOutput)}"`);
    const candidates = record.candidates.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
    if (candidates.length) lines.push(`参考答案：${candidates.map((c) => `"${valueText(c.raw)}"`).join('、')}`);
    const indices = Array.isArray(record.matchedCandidateIndices)
      ? record.matchedCandidateIndices.filter((i): i is number => typeof i === 'number')
      : [];
    const candidateCount = typeof record.candidateCount === 'number' ? record.candidateCount : candidates.length;
    lines.push(indices.length
      ? `匹配结果：命中第 ${indices.map((i) => i + 1).join('、')} 个候选（共 ${candidateCount} 个）`
      : `匹配结果：标准化后未命中任何候选（共 ${candidateCount} 个）`);
    const configSummary = textEvalConfigSummary(record.config);
    if (configSummary) lines.push(`生效配置：${configSummary}`);
    return lines.join('\n');
  }

  if (Array.isArray(record.matched)) {
    lines.push(`正确识别 ${valueText(record.truePositiveCount) || '0'} 个，误报 ${valueText(record.falsePositiveCount) || '0'} 个，遗漏 ${valueText(record.falseNegativeCount) || '0'} 个`);
    lines.push(`精确率 ${pctText(record.precision)}，召回率 ${pctText(record.recall)}，F1（精确率与召回率的调和平均）${pctText(record.f1)}`);
    const pairs = record.matched.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
    if (pairs.length) {
      lines.push('匹配明细：');
      for (const pair of pairs) {
        const distance = typeof pair.distance === 'number' ? `（编辑距离 ${pair.distance}）` : '';
        lines.push(`- 「${valueText(pair.predicted)}」↔「${valueText(pair.reference)}」${distance}`);
      }
    }
    const falsePositives = Array.isArray(record.falsePositives) ? record.falsePositives.map(valueText).filter(Boolean) : [];
    if (falsePositives.length) lines.push(`误报实体：${falsePositives.join('、')}`);
    const falseNegatives = Array.isArray(record.falseNegatives) ? record.falseNegatives.map(valueText).filter(Boolean) : [];
    if (falseNegatives.length) lines.push(`遗漏实体：${falseNegatives.join('、')}`);
    const discarded = (typeof record.discardedEmptyPredictions === 'number' ? record.discardedEmptyPredictions : 0)
      + (typeof record.discardedEmptyReferences === 'number' ? record.discardedEmptyReferences : 0);
    if (discarded > 0) lines.push(`已忽略空实体 ${discarded} 个`);
    const configSummary = textEvalConfigSummary(record.config);
    if (configSummary) lines.push(`生效配置：${configSummary}`);
    return lines.join('\n');
  }

  if (typeof record.predictedCount === 'number' && typeof record.truePositiveCount === 'number') {
    return `共提取 ${record.predictedCount} 个实体，其中 ${record.truePositiveCount} 个与标准实体匹配`;
  }
  if (typeof record.referenceCount === 'number' && typeof record.truePositiveCount === 'number') {
    return `标准实体共 ${record.referenceCount} 个，其中 ${record.truePositiveCount} 个被成功提取`;
  }

  return '未提供可展示的评估依据。';
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
            borderRadius: 4, padding: '0 4px', whiteSpace: 'pre-wrap',
            wordBreak: 'break-all', overflowWrap: 'anywhere',
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
      <ul key={`ul-${blocks.length}`} style={{ margin: '4px 0', minWidth: 0, paddingLeft: 17, overflowWrap: 'anywhere' }}>
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
      blocks.push(<p key={`p-${blocks.length}`} style={{ margin: '3px 0', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return (
    <div style={{ minWidth: 0, maxWidth: '100%', fontSize: 11.5, lineHeight: 1.65, color: 'var(--foreground-secondary)', overflowWrap: 'anywhere' }}>
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
  if (evaluatorId && TEXT_METRIC_EVALUATOR_IDS.has(evaluatorId)) {
    return textMetricEvidenceMarkdown(ev.json).replace(/[*`#]/g, '').split('\n')
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
        minWidth: 0, maxWidth: '100%', background: 'var(--background-secondary)', overflow: 'hidden',
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
        <div style={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', padding: '7px 10px 9px', borderTop: '1px solid var(--border)', background: 'var(--card-bg)' }}>
          {ev.md ? renderMd(ev.md) : evaluatorId && SPECIALIZED_EVALUATOR_IDS.has(evaluatorId) ? (
            renderMd(specializedEvidenceMarkdown(ev.json))
          ) : evaluatorId && TEXT_METRIC_EVALUATOR_IDS.has(evaluatorId) ? (
            renderMd(textMetricEvidenceMarkdown(ev.json))
          ) : (
            <pre
              style={{
                margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
                lineHeight: 1.55, color: 'var(--foreground-secondary)',
                maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
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
