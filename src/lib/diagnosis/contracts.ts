import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentDebugReportPayload, AgentDebugFinding } from '@/lib/engine/agent-debug/types';

export class DiagnosisError extends Error {
  constructor(message: string, public status = 422) { super(message); }
}
export const diagnosisRequest = z.object({
  resultIds: z.array(z.string().min(1)).min(1).max(30),
  preview: z.boolean().optional(),
  requestKey: z.string().min(1).max(100).optional(),
  expectedInputHash: z.string().length(64).optional(),
  force: z.boolean().optional(),
  retryOfRunId: z.string().optional(),
});
export const optimizationInputRequest = z.object({
  runId: z.string().min(1), findingIds: z.array(z.string().min(1)).min(1).max(30),
  baseVersion: z.number().int().nonnegative(), expectedContentHash: z.string().length(64),
  skillRelevanceConfirmed: z.literal(true), baselineVerified: z.boolean().optional(),
  constraints: z.string().max(8000).default(''),
});
export function contentHash(value: unknown): string {
  function sort(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
export interface DiagnosisSkill {
  name: string; version: number | null; contentHash: string | null; files: Record<string, string> | null;
}
export interface DiagnosisSnapshot {
  source?: 'trace-report';
  schemaVersion: 1;
  experiment: { id: string; name: string; config: unknown; evaluatorConfigs: unknown; evaluatorIds?: string[] };
  case: { id: string; input: string; referenceOutput: string | null; actualOutput: string };
  execution: { id: string; taskId?: string | null; user?: string | null; framework?: string | null; query?: string | null; model?: string | null; agentName?: string | null };
  attempt: { id: string; attemptNo: number; traceId: string | null } | null;
  results: Array<{ id: string; evaluatorId: string; status: string; verdict: string | null; score: number | null; summary: string | null; points: unknown; evidence: unknown; humanScore: number | null; humanReason: string | null; humanBy?: string | null; humanAt?: string | null; updatedAt: string }>;
  skills: DiagnosisSkill[];
  interactions: unknown[];
  traceHash: string;
}
export function parseStored<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
export function optimizationEligibility(report: AgentDebugReportPayload, finding: AgentDebugFinding) {
  const roots = finding.issueRefs.filter(ref => ref.role === 'root').map(ref => report.issues.find(issue => issue.id === ref.issueId));
  if (!finding.evidence.trim() || !finding.correctionGuidance.trim()) return '缺少证据或改进建议';
  if (!roots.length || roots.some(issue => !issue)) return '缺少可追溯的根因证据';
  if (roots.some(issue => issue?.module === 'system')) return '系统或环境问题不直接进入 Skill 修改';
  return null;
}
export function selectedFindings(report: AgentDebugReportPayload, ids: string[]) {
  if (report.skippedReason) throw new DiagnosisError('诊断未形成有效报告');
  return [...new Set(ids)].map(id => {
    const finding = report.findings?.find(item => item.id === id);
    if (!finding) throw new DiagnosisError('所选发现不属于该诊断报告');
    const reason = optimizationEligibility(report, finding);
    if (reason) throw new DiagnosisError(reason);
    return finding;
  });
}
