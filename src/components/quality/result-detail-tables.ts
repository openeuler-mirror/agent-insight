export interface DetailTableSpec {
  title: string;
  headers: string[];
  rows: string[][];
}

type RecordLike = Record<string, unknown>;

export type InstructionLineDisplay =
  | { kind: 'not-applicable'; reason: string; showDetail: false }
  | { kind: 'scored'; scoreLabel: string; constraintLabel: string; showDetail: true };

export function buildInstructionLineDisplay(input: {
  score?: number | null;
  reason?: string;
  detail?: RecordLike;
}): InstructionLineDisplay {
  const detail = asRecord(input.detail);
  const constraints = asArray(detail.constraints);
  const verdicts = asArray(detail.verdicts).map(asRecord);
  const hasNoExplicitConstraints = input.score == null && constraints.length === 0 && verdicts.length === 0;
  if (hasNoExplicitConstraints) {
    const reason = String(detail.reason || input.reason || '本任务没有明确的输出约束');
    return { kind: 'not-applicable', reason: `不适用：${reason}`, showDetail: false };
  }
  const summary = asRecord(detail.summary);
  const met = numberOr(summary.met, verdicts.filter((v) => v.status === 'met').length);
  const notMet = numberOr(summary.notMet, verdicts.filter((v) => v.status === 'not_met').length);
  const total = met + notMet;
  return {
    kind: 'scored',
    scoreLabel: `得分 ${formatNullableScore(input.score)}`,
    constraintLabel: total > 0 ? `约束 ${met}/${total} 满足` : '约束 N/A',
    showDetail: true,
  };
}

export function buildInstructionDetailTables(detail: RecordLike): DetailTableSpec[] {
  const constraintById = new Map(asArray(detail.constraints).map(asRecord).map((item) => [String(item.id || ''), item]));
  const rows = asArray(detail.verdicts).map(asRecord).map((verdict) => {
    const constraintId = String(verdict.constraintId || '');
    const constraint = constraintById.get(constraintId) ?? {};
    return [
      constraintId,
      String(constraint.text || ''),
      instructionStatusLabel(String(verdict.status || '')),
      String(verdict.reason || ''),
    ];
  });
  return [{
    title: '约束裁决表',
    headers: ['约束ID', '约束内容', '裁决结果', '裁决原因'],
    rows,
  }];
}

export function buildAnswerQualityDetailTables(detail: RecordLike): DetailTableSpec[] {
  const relevance = asRecord(detail.relevance);
  const completeness = asRecord(detail.completeness);
  const coherence = asRecord(detail.coherence);
  return [
    buildRelevanceTable(relevance),
    buildCompletenessTable(completeness),
    buildCoherenceTable(coherence, asRecord(detail.subScores)),
  ];
}

export function buildAnswerQualitySummary(detail: RecordLike): string {
  const relevance = asRecord(detail.relevance);
  const completeness = asRecord(detail.completeness);
  const coherence = asRecord(detail.coherence);
  return [
    buildRelevanceSummary(relevance),
    buildCompletenessSummary(completeness),
    buildCoherenceSummary(coherence),
  ].filter(Boolean).join('；');
}

export function buildFaithfulnessDetailTables(detail: RecordLike): DetailTableSpec[] {
  const rows = asArray(detail.claims).map(asRecord).map((claim) => [
    String(claim.claimId || ''),
    String(claim.claim || ''),
    faithfulnessStatusLabel(String(claim.status || '')),
    String(claim.reason || ''),
    formatFaithfulnessCitations(claim.citations),
  ]);
  return [{
    title: '主张裁决表',
    headers: ['主张ID', '主张内容', '裁决结果', '裁决原因', '证据与来源'],
    rows,
  }];
}

export function buildAccuracyDetailTables(detail: RecordLike): DetailTableSpec[] {
  const keyPointRows = asArray(detail.keyPointFindings).map(asRecord).map((finding) => [
    String(finding.keyPointId || ''),
    String(finding.content || ''),
    accuracyStatusLabel(String(finding.status || '')),
    String(finding.reason || ''),
    String(finding.actualEvidence || ''),
  ]);
  const additionalErrorRows = asArray(detail.additionalErrors).map(asRecord).map((error) => [
    accuracyErrorKindLabel(String(error.kind || '')),
    severityLabel(String(error.severity || '')),
    String(error.actual_evidence || ''),
    String(error.reason || ''),
  ]);
  return [
    {
      title: '关键观点裁决表',
      headers: ['观点ID', '标准关键观点', '判定结果', '裁决原因', '实际答案证据'],
      rows: keyPointRows,
    },
    {
      title: '额外错误表',
      headers: ['错误类型', '严重度', '实际答案证据', '错误原因'],
      rows: additionalErrorRows,
    },
  ];
}

function buildRelevanceTable(relevance: RecordLike): DetailTableSpec {
  const statementById = new Map(asArray(relevance.statements).map(asRecord).map((item) => [String(item.id || ''), item]));
  const rows = asArray(relevance.verdicts).map(asRecord).map((verdict) => {
    const statementId = String(verdict.statementId || '');
    const statement = statementById.get(statementId) ?? {};
    return [
      statementId,
      String(statement.text || ''),
      String(statement.sourceQuote || ''),
      relevanceLabel(String(verdict.verdict || '')),
      String(verdict.reason || ''),
    ];
  });
  return {
    title: '相关性评测表',
    headers: ['陈述ID', '陈述内容', '原文引用', '相关性判定', '判定原因'],
    rows,
  };
}

function buildCompletenessTable(completeness: RecordLike): DetailTableSpec {
  const requirementById = new Map(asArray(completeness.requirements).map(asRecord).map((item) => [String(item.id || ''), item]));
  const rows = asArray(completeness.verdicts).map(asRecord).map((verdict) => {
    const requirementId = String(verdict.requirementId || '');
    const requirement = requirementById.get(requirementId) ?? {};
    return [
      requirementId,
      String(requirement.text || ''),
      completenessLabel(String(verdict.status || '')),
      String(verdict.reason || ''),
      String(verdict.evidenceQuote || ''),
    ];
  });
  return {
    title: '完整性评测表',
    headers: ['要点ID', '任务要点', '覆盖状态', '裁决原因', '结果证据'],
    rows,
  };
}

function buildCoherenceTable(coherence: RecordLike, subScores: RecordLike): DetailTableSpec {
  const checks = asRecord(coherence.checks);
  const rating = numberOrNull(coherence.rating);
  const coherenceScore = numberOrNull(subScores.coherence) ?? (rating == null ? null : rating * 25);
  return {
    title: '连贯性评测表',
    headers: ['检查项', '结果', '说明'],
    rows: [
      ['连贯性评级', rating == null ? '' : String(rating), '0 到 4 的整数 rubric 分'],
      ['连贯性子分', formatScore(coherenceScore), 'rating * 25'],
      ['主结论是否清晰', boolLabel(checks.mainConclusionClear), ''],
      ['结构顺序是否合理', boolLabel(checks.logicalOrder), ''],
      ['指代是否一致', boolLabel(checks.referenceConsistency), ''],
      ['矛盾问题', formatIssues(checks.contradictions), ''],
      ['重复问题', formatIssues(checks.repetitions), ''],
      ['跳跃问题', formatIssues(checks.abruptTransitions), ''],
      ['总体原因', String(coherence.reason || ''), ''],
      ['置信度', formatConfidence(coherence.confidence), ''],
    ],
  };
}

function buildRelevanceSummary(relevance: RecordLike): string {
  const verdicts = asArray(relevance.verdicts).map(asRecord);
  const total = verdicts.length;
  if (!total) return '';
  const relevant = verdicts.filter((item) => item.verdict === 'relevant').length;
  const supporting = verdicts.filter((item) => item.verdict === 'supporting').length;
  const irrelevant = verdicts.filter((item) => item.verdict === 'irrelevant').length;
  if (irrelevant > 0) {
    return `相关性有偏离，${total} 条陈述中 ${irrelevant} 条不相关${supporting > 0 ? `、${supporting} 条为支撑性内容` : ''}`;
  }
  if (supporting > 0) {
    return `相关性较好，${total} 条陈述中 ${relevant} 条直接相关、${supporting} 条为支撑性内容`;
  }
  return `相关性较好，${total} 条陈述均直接相关`;
}

function buildCompletenessSummary(completeness: RecordLike): string {
  const verdicts = asArray(completeness.verdicts).map(asRecord);
  const total = verdicts.length;
  if (!total) return '';
  const covered = verdicts.filter((item) => item.status === 'covered').length;
  const partial = verdicts.filter((item) => item.status === 'partial').length;
  const missing = verdicts.filter((item) => item.status === 'missing').length;
  if (missing > 0 || partial > 0) {
    return `完整性仍有缺口，${total} 个要点中 ${covered} 个已覆盖${partial > 0 ? `、${partial} 个部分覆盖` : ''}${missing > 0 ? `、${missing} 个缺失` : ''}`;
  }
  return `完整性充分，${total} 个任务要点全部覆盖`;
}

function buildCoherenceSummary(coherence: RecordLike): string {
  const rating = numberOrNull(coherence.rating);
  const checks = asRecord(coherence.checks);
  const issues = [
    checks.mainConclusionClear === false ? '主结论不清晰' : '',
    checks.logicalOrder === false ? '结构顺序问题' : '',
    checks.referenceConsistency === false ? '指代不一致' : '',
    asArray(checks.contradictions).length ? '矛盾' : '',
    asArray(checks.repetitions).length ? '重复' : '',
    asArray(checks.abruptTransitions).length ? '跳跃' : '',
  ].filter(Boolean);
  if (rating == null) {
    return issues.length ? `连贯性存在${issues.slice(0, 2).join('、')}` : '';
  }
  if (rating >= 4) return '连贯性良好，结构清晰、表达一致';
  if (rating >= 3) {
    return issues.length ? `连贯性尚可，存在${issues.slice(0, 2).join('、')}` : '连贯性尚可，整体表达清楚';
  }
  return issues.length ? `连贯性偏弱，存在${issues.slice(0, 2).join('、')}` : '连贯性偏弱，需要改善结构和表达';
}

function asRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordLike : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatNullableScore(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${formatScore(value)}分` : 'N/A';
}

function formatScore(value: unknown): string {
  const num = numberOrNull(value);
  if (num == null) return '';
  return Number.isInteger(num) ? String(num) : num.toFixed(1).replace(/\.0$/u, '');
}

function formatConfidence(value: unknown): string {
  const num = numberOrNull(value);
  if (num == null) return '';
  return `${Math.round(num * 100)}%`;
}

function boolLabel(value: unknown): string {
  return typeof value === 'boolean' ? (value ? '是' : '否') : '';
}

function formatIssues(value: unknown): string {
  const items = asArray(value).map(asRecord);
  if (!items.length) return '无';
  return items
    .map((item) => {
      const quote = String(item.quote || '').trim();
      const reason = String(item.reason || '').trim();
      return [quote, reason].filter(Boolean).join('：');
    })
    .filter(Boolean)
    .join('\n');
}

function formatFaithfulnessCitations(value: unknown): string {
  const citations = asArray(value).map(asRecord);
  if (!citations.length) return '无';
  return citations.map((citation) => {
    const contextId = String(citation.contextId || '').trim();
    const quote = String(citation.evidenceQuote || '').trim();
    const source = [
      String(citation.toolName || '').trim(),
      String(citation.toolCallId || '').trim(),
      citation.interactionIndex == null ? '' : `interactionIndex=${String(citation.interactionIndex)}`,
    ].filter(Boolean).join('；');
    const body = [contextId, quote].filter(Boolean).join('：');
    return source ? `${body}（${source}）` : body;
  }).filter(Boolean).join('\n');
}

function instructionStatusLabel(value: string): string {
  if (value === 'met') return '满足';
  if (value === 'not_met') return '未满足';
  if (value === 'not_applicable') return '不适用';
  return value || '';
}

function relevanceLabel(value: string): string {
  if (value === 'relevant') return '相关';
  if (value === 'supporting') return '支撑性内容';
  if (value === 'irrelevant') return '不相关';
  return value || '';
}

function completenessLabel(value: string): string {
  if (value === 'covered') return '已覆盖';
  if (value === 'partial') return '部分覆盖';
  if (value === 'missing') return '缺失';
  return value || '';
}

function faithfulnessStatusLabel(value: string): string {
  if (value === 'supported') return '有证据支持';
  if (value === 'contradicted') return '与证据矛盾';
  if (value === 'not_covered') return '证据未覆盖';
  return value || '';
}

function accuracyStatusLabel(value: string): string {
  if (value === 'correct') return '正确';
  if (value === 'partially_correct') return '部分正确';
  if (value === 'wrong') return '错误';
  if (value === 'not_mentioned') return '未提及';
  return value || '';
}

function accuracyErrorKindLabel(value: string): string {
  if (value === 'incorrect_fact') return '事实错误';
  if (value === 'extra_content') return '额外编造';
  return value || '';
}

function severityLabel(value: string): string {
  if (value === 'low') return '低';
  if (value === 'medium') return '中';
  if (value === 'high') return '高';
  return value || '';
}
