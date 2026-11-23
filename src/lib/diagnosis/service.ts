import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { requireCoreExperimentContext } from '@/lib/storage-core/experiments';
import { buildCoreDiagnosisSnapshot, coreDiagnosisSnapshotHash, submitCoreDiagnosis, readCoreDiagnosis, freezeCoreTraceReport, verifyCoreDiagnosisSource } from '@/lib/storage-core/diagnosis-consumer';
import { prismaRaw as prisma } from '@/lib/storage/prisma';
import { resolveAgentDebugExecution } from '@/lib/engine/agent-debug/execution-resolver';
import { parseReportPayload } from '@/lib/engine/agent-debug/report-store';
import type { AgentDebugExecutionRecord } from '@/lib/engine/agent-debug/execution-resolver';
import { hashInteractions, buildDebugTurns } from '@/lib/engine/agent-debug/trace-adapter';
import { AGENT_DEBUG_GENERATOR } from '@/lib/engine/agent-debug/types';
import { createDiagnosisProgress, readDiagnosisProgress } from '@/lib/engine/agent-debug/progress-store';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { loadSkillVersionSnapshot } from '@/lib/engine/skill-opt/version-snapshot';
import type { AgentDebugReportPayload } from '@/lib/engine/agent-debug/types';
import { contentHash, DiagnosisError, parseStored, selectedFindings, optimizationEligibility, type DiagnosisSnapshot, type DiagnosisSkill } from './contracts';

const GENERATOR = `${AGENT_DEBUG_GENERATOR}:evaluation-input-v1`;
const LEASE_MS = 90_000;

export async function skillSnapshot(user: string, name: string, version: number) {
  const skill = await prisma.skill.findFirst({ where: { name, user } });
  if (!skill) throw new DiagnosisError('目标 Skill 不存在或不属于当前用户', 404);
  const row = await prisma.skillVersion.findUnique({ where: { skillId_version: { skillId: skill.id, version } } });
  if (!row) throw new DiagnosisError('Skill 基线版本不存在', 404);
  const files = loadSkillVersionSnapshot({ skillId: skill.id, version, row });
  const declared = row.files ? parseStored<unknown>(row.files, null) : [];
  if (!Array.isArray(declared) || declared.some(path => typeof path !== 'string')) throw new DiagnosisError('Skill 文件清单无法解析');
  if (declared.some(file => !(file in files) && file.toLowerCase() !== 'skill.md')) throw new DiagnosisError('Skill 文件不完整或超出读取限制，不能建立可靠基线');
  return { skill, files, contentHash: contentHash(files) };
}

async function invokedSkills(user: string, execution: AgentDebugExecutionRecord) {
  const recorded = parseStored<unknown>(execution.invokedSkills ?? null, null);
  // An explicit empty invocation list takes precedence over configured Skill names.
  const names = Array.isArray(recorded) ? recorded : [];
  const skills: DiagnosisSkill[] = [];
  for (const item of names) {
    if (!item || typeof item.name !== 'string' || skills.some(skill => skill.name === item.name)) continue;
    const version = Number.isInteger(item.version) ? item.version : null;
    const baseline = version == null ? null : await skillSnapshot(user, item.name, version).catch(error => {
      if (error instanceof DiagnosisError) return null;
      throw error;
    });
    skills.push({ name: item.name, version, contentHash: baseline?.contentHash ?? null, files: baseline?.files ?? null });
  }
  return skills;
}

function executionFields(row: AgentDebugExecutionRecord & { model?: string | null }) {
  return { id: row.id, taskId: row.taskId, user: row.user, framework: row.framework, query: row.query, agentName: row.agentName, model: row.model };
}

export async function freezeTraceReport(user: string, executionId: string, generatedAt: string) {
  return freezeCoreTraceReport(executionId, generatedAt);
}

export async function buildSnapshot(user: string, experimentId: string, caseId: string, resultIds: string[]): Promise<DiagnosisSnapshot> {
  return buildCoreDiagnosisSnapshot(experimentId, caseId, resultIds);
}

export async function submitDiagnosis(user: string, snapshot: DiagnosisSnapshot, input: { requestKey: string; expectedInputHash: string; force?: boolean; retryOfRunId?: string }) {
  return submitCoreDiagnosis(snapshot, input);
}

async function execute(id: string, user: string, snapshot: DiagnosisSnapshot) {
  const progress = createDiagnosisProgress({ user, executionId: snapshot.execution.id, runId: id });
  progress.emit({ key: 'accepted', kind: 'task', state: 'started', title: '诊断输入已冻结', summary: `${snapshot.results.length} 项评测结果，等待诊断资源。` });
  const timer = setInterval(() => {
    void prisma.diagnosisRun.updateMany({ where: { id, status: 'running' }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(() => {});
  }, 15_000);
  timer.unref();
  try {
    const { runAgentDebugDiagnosis } = await import('@/lib/engine/agent-debug/runner');
    const report = await withBackgroundOpencodeSlot(() => runAgentDebugDiagnosis({ execution: snapshot.execution, interactions: snapshot.interactions, user, progress, evaluationContext: { ...snapshot, interactions: undefined } }), { user, taskType: 'agent-debug', label: `evaluation-diagnosis: ${id}` });
    await prisma.diagnosisRun.updateMany({ where: { id, status: 'running' }, data: { status: 'done', reportJson: JSON.stringify(report), completedAt: new Date(), leaseUntil: null } });
    progress.emit({ key: 'done', kind: 'task', state: 'completed', title: '诊断完成', summary: '报告与输入快照已保存。' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '诊断失败';
    await prisma.diagnosisRun.updateMany({ where: { id, status: 'running' }, data: { status: 'failed', errorMessage: message, completedAt: new Date(), leaseUntil: null } });
    progress.emit({ key: 'failed', kind: 'task', state: 'failed', title: '诊断失败', summary: message });
  } finally { clearInterval(timer); }
}

export function previewSnapshot(snapshot: DiagnosisSnapshot) {
  return { inputHash: coreDiagnosisSnapshotHash(snapshot) || contentHash({ snapshot, generator: GENERATOR }), snapshot: { ...snapshot, interactions: undefined, interactionCount: snapshot.interactions.length } };
}

export async function getDiagnosis(user: string, id: string) {
  {
    const run = await readCoreDiagnosis(id);
    if (!run.snapshot) throw new DiagnosisError('诊断输入仅原创建者可访问', 403);
    const report = run.report;
    return { id: run.id, status: run.status, errorMessage: run.errorMessage, createdAt: run.createdAt, ...previewSnapshot(run.snapshot), inputHash: run.input_hash, report, eligibility: Object.fromEntries((report?.findings || []).map(f => [f.id, optimizationEligibility(report!, f)])), progress: run.progress };
  }
}

export async function importDiagnosis(user: string, name: string, input: { runId: string; findingIds: string[]; baseVersion: number; expectedContentHash: string; baselineVerified?: boolean; constraints: string }) {
  const core = isStorageCoreEnabled();
  user = requireCoreExperimentContext().actor.username;
  const stored = (await readCoreDiagnosis(input.runId));
  const run = (stored?.status === 'done' ? { id: stored.id, reportJson: stored.report ? JSON.stringify(stored.report) : null, inputSnapshotJson: JSON.stringify(stored.snapshot), inputHash: stored.input_hash, experimentId: stored.experiment_id, caseId: stored.case_id } : null);
  if (!run?.reportJson) throw new DiagnosisError('诊断尚未完成或不可访问', 404);
  await verifyCoreDiagnosisSource(run.id);
  const snapshot = JSON.parse(run.inputSnapshotJson) as DiagnosisSnapshot;
  const invoked = snapshot.skills.find(item => item.name === name);
  if (!invoked) throw new DiagnosisError('本次执行未记录调用此 Skill，不能直接优化');
  if (invoked.version == null) throw new DiagnosisError('执行版本未记录，无法确定优化基线', 409);
  if (invoked.version !== input.baseVersion) throw new DiagnosisError('必须使用执行时 Skill 版本', 409);
  if (!invoked.contentHash) throw new DiagnosisError('执行快照缺少内容校验信息，无法可靠核验基线', 409);
  const base = await skillSnapshot(user, name, input.baseVersion);
  if (base.contentHash !== input.expectedContentHash || (invoked.contentHash && base.contentHash !== invoked.contentHash)) throw new DiagnosisError('Skill 基线已变化，请重新核验', 409);
  const findings = selectedFindings(JSON.parse(run.reportJson), input.findingIds);
  const key = contentHash({ user, runId: run.id, name, version: input.baseVersion, hash: base.contentHash, ids: findings.map(f => f.id).sort(), constraints: input.constraints });
  const id = `diagnosis-${key}`;
  const refs = [{ type: 'diagnosis', id: run.id, inputHash: run.inputHash, findingIds: findings.map(f => f.id), experimentId: run.experimentId, caseId: run.caseId, baseContentHash: base.contentHash, baselineVerified: Boolean(input.baselineVerified), constraints: input.constraints }];
  const existing = await prisma.skillWorkbenchSession.findFirst({ where: { id, user } });
  if (existing) { await verifyCoreDiagnosisSource(run.id); return { sessionId: existing.id }; }
  try {
    return await prisma.$transaction(async tx => {
      const opt = await tx.skillOptSession.create({ data: { id, user, skillName: name, baseVersion: input.baseVersion, title: '诊断优化计划', files: JSON.stringify(base.files) } });
      await tx.skillOptPlan.create({ data: {
        sessionId: opt.id, skillId: base.skill.id, baseVersion: input.baseVersion, status: 'draft', operatorMeta: JSON.stringify({ source: 'diagnosis', sourceRefs: refs }),
        items: { create: findings.map((finding, rank) => ({ rank, route: 'core', status: 'pending', title: finding.summary, rationale: `${finding.evidence}\n用户确认与 ${name} 有关。\n${input.constraints}`, severity: finding.severity, proposedEdit: finding.correctionGuidance, sourceIssueIds: '[]', sourceRefsJson: JSON.stringify([{ ...refs[0], findingIds: [finding.id], finding }]), sourcesBreakdown: JSON.stringify({ diagnosis: 1 }) })) },
      } });
      await verifyCoreDiagnosisSource(run.id);
      const workbench = await tx.skillWorkbenchSession.create({ data: { id, user, title: `${name} · 诊断优化`, skillName: name, workVersion: input.baseVersion, source: 'management', activeView: 'optimization', stage: 'ready', filesJson: JSON.stringify(base.files), optSessionId: opt.id } });
      await verifyCoreDiagnosisSource(run.id);
      return { sessionId: workbench.id };
    });
  } catch (error) {
    if (await prisma.skillWorkbenchSession.findFirst({ where: { id, user } })) { await verifyCoreDiagnosisSource(run.id); return { sessionId: id }; }
    throw error;
  }
}
