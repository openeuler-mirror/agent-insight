import fs from 'node:fs';
import path from 'node:path';

import { runGeneralAgent } from '@/lib/engine/general-agent';
import { parseJsonObject } from './json';
import type {
  AgentDebugDetectorFinding,
  AgentDebugDetectorMergeDecision,
  AgentDebugFinding,
  AgentDebugFindingImpact,
  AgentDebugSeverity,
} from './types';

const SKILL_NAME = 'agent-debug-diagnosis';
const AGENT_NAME = 'fault-diagnosis-agent';

export async function requestDetectorMergeDecisions(args: {
  user: string;
  sessionId?: string;
  workspaceTag: string;
  skillPrompt: string;
  coreFindings: AgentDebugFinding[];
  detectorFindings: AgentDebugDetectorFinding[];
}): Promise<AgentDebugDetectorMergeDecision[]> {
  if (!args.detectorFindings.length) return [];
  try {
    const result = await runGeneralAgent({
      user: args.user,
      sessionId: args.sessionId,
      query: buildQuery(args.coreFindings, args.detectorFindings),
      system: buildSystem(args.skillPrompt),
      workspaceTag: args.workspaceTag,
      sessionTitle: 'agent-debug · detector reconciliation',
      systemAgentName: AGENT_NAME,
      recordTraceAs: AGENT_NAME,
      tagSkill: SKILL_NAME,
      interactionPolicy: 'auto-deny',
      agent: 'build',
      timeoutMs: Number(process.env.AGENT_DEBUG_RECONCILIATION_TIMEOUT_MS || 80_000),
      modelOptions: { temperature: 0, maxTokens: 2400 },
    });
    return parseDecisions(result.output);
  } catch {
    return [];
  }
}

export function writeDetectorAudit(args: {
  workspaceDir: string;
  detectorFindings: AgentDebugDetectorFinding[];
  requestedDecisions: AgentDebugDetectorMergeDecision[];
  appliedDecisions: AgentDebugDetectorMergeDecision[];
}): void {
  const dir = path.join(args.workspaceDir, '.agent-insight');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'detector-findings.raw.json'),
      `${JSON.stringify({ findings: args.detectorFindings }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'detector-reconciliation.json'),
      `${JSON.stringify({ requestedDecisions: args.requestedDecisions, appliedDecisions: args.appliedDecisions }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // 审计文件失败不能阻断主诊断报告。
  }
}

function buildSystem(skillPrompt: string): string {
  return [
    '你仍是刚刚完成主诊断的同一个 AgentDebug Agent。当前只执行专项诊断结果的语义查重与关联判断。',
    '不得重新运行五模块，不得删除、合并或重写机制与修复方向不同的 core finding。',
    '只返回合并决策 JSON，不调用工具，不输出诊断报告或 Markdown。',
    '',
    skillPrompt,
  ].join('\n');
}

function buildQuery(coreFindings: AgentDebugFinding[], detectorFindings: AgentDebugDetectorFinding[]): string {
  return [
    '请比较冻结的 AgentDebug core findings 与已富化的专项诊断结果。',
    '',
    '重复判定必须同时满足：故障对象相同、故障机制相同、主要证据范围相同、修复方向相同。',
    '只有前后因果关系不算重复；修复方向不同必须 action=independent，可用 relatedFindingId 建立关联。',
    'merge 时只能选择一个已存在的 core finding，并可在 patch 中只提升该卡片的严重程度、影响和置信度。',
    '不得在 patch 中返回计数、区间、比例、锚点或 detector 来源；这些确定性字段由代码从原始结果无损合入。',
    '每条专项结果必须给出一条 decision。',
    '',
    '只输出 JSON：',
    '{"decisions":[{"detectorFindingId":"...","action":"merge|independent","targetFindingId":"merge 时必填","relatedFindingId":"可选","reason":"...","patch":{"severity":"high|medium|low","impact":"result_blocking|quality_degrading|recovered_cost|risk","confidence":0.8}}]}',
    '',
    '## 冻结的 core findings',
    JSON.stringify(coreFindings, null, 2),
    '',
    '## 专项诊断结果',
    JSON.stringify(detectorFindings, null, 2),
  ].join('\n');
}

function parseDecisions(output: string): AgentDebugDetectorMergeDecision[] {
  const parsed = parseJsonObject(output);
  const values = parsed && Array.isArray(parsed.decisions) ? parsed.decisions : [];
  return values
    .map(value => normalizeDecision(value))
    .filter((value): value is AgentDebugDetectorMergeDecision => Boolean(value));
}

function normalizeDecision(value: unknown): AgentDebugDetectorMergeDecision | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const detectorFindingId = stringValue(item.detectorFindingId);
  const action = item.action === 'merge' ? 'merge' : item.action === 'independent' ? 'independent' : null;
  if (!detectorFindingId || !action) return null;
  const rawPatch = item.patch && typeof item.patch === 'object' ? item.patch as Record<string, unknown> : null;
  return {
    detectorFindingId,
    action,
    targetFindingId: stringValue(item.targetFindingId) || undefined,
    relatedFindingId: stringValue(item.relatedFindingId) || undefined,
    reason: stringValue(item.reason) || undefined,
    patch: rawPatch ? {
      severity: severityValue(rawPatch.severity),
      impact: impactValue(rawPatch.impact),
      confidence: numberValue(rawPatch.confidence),
    } : undefined,
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function severityValue(value: unknown): AgentDebugSeverity | undefined {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined;
}

function impactValue(value: unknown): AgentDebugFindingImpact | undefined {
  return value === 'result_blocking' || value === 'quality_degrading' || value === 'recovered_cost' || value === 'risk'
    ? value
    : undefined;
}
