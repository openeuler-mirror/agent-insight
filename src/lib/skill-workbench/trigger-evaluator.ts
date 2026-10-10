import type { EvaluatorOutput } from '@/lib/evaluators/eval-output';

export const SKILL_TRIGGER_ANALYZER_EVALUATOR_ID = 'skill-trigger-analyzer';
export const SKILL_TRIGGER_ANALYZER_EVIDENCE = '当前 Skill 的实际触发结果与数据集标注一致，触发判断正确。';

export function isSkillTriggerAnalyzerId(id: string): boolean {
  return id === SKILL_TRIGGER_ANALYZER_EVALUATOR_ID;
}

function sentence(value: string): string {
  const text = value.trim();
  if (!text) return '';
  return /[.!?。！？]$/.test(text) ? text : `${text}。`;
}

function buildObservation(input: SkillTriggerAnalyzerInput): string {
  if (input.observation?.trim()) return sentence(input.observation);
  const total = Number(input.facts?.runsTotal);
  const triggered = Number(input.facts?.runsTriggered);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(triggered)) {
    const rateValue = Number(input.facts?.triggerRate);
    const rate = Number.isFinite(rateValue) ? Math.round(rateValue * 100) : Math.round((triggered / total) * 100);
    const latency = Number(input.facts?.latencyMsAvg);
    const competingSkill = typeof input.facts?.competingSkill === 'string' ? input.facts.competingSkill.trim() : '';
    const timedOut = Number(input.facts?.runsTimedOut);
    const errored = Number(input.facts?.runsErrored);
    const errorMessage = typeof input.facts?.errorMessage === 'string' ? input.facts.errorMessage.trim() : '';
    const incomplete = [
      Number.isFinite(timedOut) && timedOut > 0 ? `${timedOut} 次超时未跑完` : '',
      Number.isFinite(errored) && errored > 0 ? `${errored} 次出错${errorMessage ? `：${errorMessage}` : ''}` : '',
    ].filter(Boolean);
    return `实际触发率 ${rate}%（命中 ${triggered}/${total} 次${Number.isFinite(latency) && latency > 0 ? ` · 平均 ${Math.round(latency)}ms` : ''}）${competingSkill ? ` · 被「${competingSkill}」抢路由` : ''}${incomplete.length ? ` · ${incomplete.join(' · ')}` : ''}。`;
  }
  return `预期${input.shouldTrigger ? '应触发' : '不应触发'}当前 Skill，实际${input.skillTriggered ? '已触发' : '未触发'}当前 Skill。`;
}

function defaultReason(input: SkillTriggerAnalyzerInput): string {
  return input.shouldTrigger
    ? '该请求符合当前 Skill 的适用场景，但实际路由未命中当前 Skill。'
    : '该请求不属于当前 Skill 的适用范围，但实际路由错误命中当前 Skill。';
}

function defaultSuggestion(input: SkillTriggerAnalyzerInput): string {
  const runsTotal = Number(input.facts?.runsTotal);
  const notRun = Number(input.facts?.runsTimedOut || 0) + Number(input.facts?.runsErrored || 0);
  if (input.shouldTrigger && Number.isFinite(runsTotal) && runsTotal > 0 && notRun > 0 && notRun >= runsTotal - notRun) {
    return '本条多为超时或出错未跑完；请提高单条超时或降低并发后重测，再判断触发质量。';
  }
  return input.shouldTrigger
    ? '在 SKILL.md 中补充该类请求的触发关键词或更明确的适用场景说明。'
    : '在 SKILL.md 中补充排除条件和适用边界，避免无关请求触发当前 Skill。';
}

export interface SkillTriggerAnalyzerInput {
  shouldTrigger: boolean;
  skillTriggered: boolean;
  observation?: string | null;
  reason?: string | null;
  suggestion?: string | null;
  facts?: Record<string, unknown>;
}

export function evaluateSkillTriggerAnalysis(input: SkillTriggerAnalyzerInput): EvaluatorOutput {
  const passed = input.shouldTrigger === input.skillTriggered;
  const summary = passed
    ? '实际触发结果与预期标注一致。'
    : input.shouldTrigger ? '应触发但未触发当前 Skill。' : '不应触发但错误触发当前 Skill。';
  const evidence = passed
    ? SKILL_TRIGGER_ANALYZER_EVIDENCE
    : `触发观察：${buildObservation(input)}\n\n原因：${sentence(input.reason?.trim() || defaultReason(input))}`;
  return {
    score: passed ? 100 : 0,
    verdict: passed ? 'pass' : 'fail',
    summary,
    points: [{
      label: '触发准确率',
      score: passed ? 100 : 0,
      status: passed ? 'covered' : 'missing',
      skillAttributable: !passed,
      evidence: { md: evidence },
      ...(!passed ? { suggestion: sentence(input.suggestion?.trim() || defaultSuggestion(input)) } : {}),
    }],
  };
}

export function formatWorkbenchTriggerDatasetTimestamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
