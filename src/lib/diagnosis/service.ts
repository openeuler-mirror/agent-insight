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
  const resolved = await resolveAgentDebugExecution(executionId);
  if (!resolved || resolved.execution.user !== user) throw new DiagnosisError('执行不可访问', 404);
  const row = await prisma.agentDebugReport.findFirst({ where: { executionId: resolved.execution.id, status: 'done', OR: [{ user }, { user: null }] } });
  const report = parseReportPayload(row ? { ...row, status: 'done' } : null);
  if (!row || !report || report.generatedAt !== generatedAt || row.interactionsHash !== hashInteractions(resolved.interactions)) {
    throw new DiagnosisError('报告或 Trace 已变化，请刷新并重新核验', 409);
  }
  const skills = await invokedSkills(user, resolved.execution);
  if (!skills.length || !report.findings?.length) throw new DiagnosisError('没有可用于优化的 Skill 调用或诊断发现');
  // Historical reports did not capture Skill files at diagnosis time.
  const snapshot: DiagnosisSnapshot = {
    source: 'trace-report', schemaVersion: 1, experiment: { id: '', name: '', config: null, evaluatorConfigs: null },
    case: { id: '', input: resolved.execution.query ?? '', referenceOutput: null, actualOutput: resolved.execution.finalResult ?? '' },
    execution: executionFields(resolved.execution), attempt: null, results: [],
    skills: skills.map(skill => ({ ...skill, contentHash: null, files: null })), interactions: resolved.interactions, traceHash: row.interactionsHash,
  };
  const inputHash = contentHash({ snapshot, report });
  const run = await prisma.diagnosisRun.upsert({ where: { user_requestKey: { user, requestKey: inputHash } }, update: {},
    create: { user, executionId: resolved.execution.id, requestKey: inputHash, inputHash, inputSnapshotJson: JSON.stringify(snapshot), generatorVersion: row.generator, status: 'done', reportJson: JSON.stringify(report), completedAt: new Date() } });
  return { runId: run.id };
}

export async function buildSnapshot(user: string, experimentId: string, caseId: string, resultIds: string[]): Promise<DiagnosisSnapshot> {
  const experiment = await prisma.experiment.findFirst({ where: { id: experimentId, user, deletedAt: null } });
  const caseRow = await prisma.experimentCase.findFirst({ where: { id: caseId, experimentId, deletedAt: null } });
  if (!experiment || !caseRow) throw new DiagnosisError('评测 Case 不存在', 404);
  const ids = [...new Set(resultIds)].sort();
  const results = await prisma.experimentEvalResult.findMany({ where: { id: { in: ids }, experimentId, caseId }, orderBy: { id: 'asc' } });
  if (results.length !== ids.length || results.some(result => result.status !== 'done')) throw new DiagnosisError('只能选择本 Case 已完成的评测结果');
  const executionRef = caseRow.executionId || caseRow.taskId;
  if (!executionRef) throw new DiagnosisError('缺少被测执行 Trace');
  const resolved = await resolveAgentDebugExecution(executionRef);
  if (!resolved || resolved.execution.user !== user || !buildDebugTurns(resolved.interactions).length) throw new DiagnosisError('被测执行不可访问或没有可诊断的轨迹');
  const attempts = await prisma.experimentTraceAttempt.findMany({ where: { experimentId, caseId }, orderBy: { attemptNo: 'desc' } });
  const attempt = attempts.find(item => item.traceId === executionRef || item.traceId === resolved.execution.id || item.traceId === resolved.execution.taskId) || null;
  if (attempts.length && (!attempt || attempt.status !== 'ready' || attempt.id !== attempts[0].id)) throw new DiagnosisError('当前 Case 与可用执行轮次不一致', 409);
  if (attempt?.finishedAt && results.some(result => result.updatedAt < attempt.finishedAt!)) throw new DiagnosisError('评测早于当前执行，请先重新评测', 409);
  const skills = await invokedSkills(user, resolved.execution);
  const snapshot: DiagnosisSnapshot = {
    schemaVersion: 1,
    experiment: { id: experiment.id, name: experiment.name, config: parseStored(experiment.configSnapshotJson, {}), evaluatorConfigs: parseStored(experiment.evaluatorConfigsJson, {}), evaluatorIds: parseStored<string[]>(experiment.evaluatorIdsJson, []) },
    case: { id: caseRow.id, input: caseRow.input, referenceOutput: caseRow.referenceOutput, actualOutput: caseRow.actualOutput },
    execution: executionFields(resolved.execution),
    attempt: attempt ? { id: attempt.id, attemptNo: attempt.attemptNo, traceId: attempt.traceId } : null,
    results: results.map(r => ({ id: r.id, evaluatorId: r.evaluatorId, status: r.status, verdict: r.verdict, score: r.score, summary: r.summary, points: parseStored<unknown>(r.pointsJson, r.pointsJson), evidence: parseStored<unknown>(r.evidenceJson, r.evidenceJson), humanScore: r.humanScore, humanReason: r.humanReason, humanBy: r.humanBy, humanAt: r.humanAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString() })),
    skills, interactions: resolved.interactions, traceHash: hashInteractions(resolved.interactions),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 16 * 1024 * 1024) throw new DiagnosisError('诊断证据超过 16 MB，请先缩小资料范围；本次未截断或提交');
  const current = await prisma.$transaction([
    prisma.experiment.findFirst({ where: { id: experimentId, user, deletedAt: null } }),
    prisma.experimentCase.findFirst({ where: { id: caseId, experimentId, deletedAt: null } }),
    prisma.experimentEvalResult.findMany({ where: { id: { in: ids }, experimentId, caseId }, orderBy: { id: 'asc' } }),
    prisma.experimentTraceAttempt.findMany({ where: { experimentId, caseId }, orderBy: { attemptNo: 'desc' } }),
  ]);
  if (JSON.stringify(current) !== JSON.stringify([experiment, caseRow, results, attempts])) throw new DiagnosisError('读取期间评测或执行轮次已变化，请重试', 409);
  return snapshot;
}

export async function submitDiagnosis(user: string, snapshot: DiagnosisSnapshot, input: { requestKey: string; expectedInputHash: string; force?: boolean; retryOfRunId?: string }) {
  const inputHash = contentHash({ snapshot, generator: GENERATOR });
  if (input.expectedInputHash !== inputHash) throw new DiagnosisError('评测或执行已变化，请重新确认输入', 409);
  const existing = await prisma.diagnosisRun.findUnique({ where: { user_requestKey: { user, requestKey: input.requestKey } } });
  if (existing && existing.status !== 'pending') {
    if (existing.inputHash !== inputHash) throw new DiagnosisError('请求标识已用于其他输入', 409);
    return existing;
  }
  if (input.retryOfRunId && !await prisma.diagnosisRun.findFirst({ where: { id: input.retryOfRunId, user, experimentId: snapshot.experiment.id, caseId: snapshot.case.id } })) throw new DiagnosisError('重试来源不存在', 404);
  if (!input.force) {
    const cached = await prisma.diagnosisRun.findFirst({ where: { user, inputHash, generatorVersion: GENERATOR, status: { in: ['running', 'done'] }, OR: [{ status: 'done' }, { leaseUntil: { gt: new Date() } }] }, orderBy: { createdAt: 'desc' } });
    if (cached) return cached;
  }
  const run = await prisma.diagnosisRun.upsert({
    where: { user_requestKey: { user, requestKey: input.requestKey } }, update: {},
    create: { user, requestKey: input.requestKey, experimentId: snapshot.experiment.id, caseId: snapshot.case.id, executionId: snapshot.execution.id, attemptId: snapshot.attempt?.id, inputHash, inputSnapshotJson: JSON.stringify(snapshot), generatorVersion: GENERATOR, retryOfRunId: input.retryOfRunId },
  });
  if (run.inputHash !== inputHash) throw new DiagnosisError('请求标识冲突', 409);
  const claimed = await prisma.diagnosisRun.updateMany({ where: { id: run.id, status: 'pending' }, data: { status: 'running', leaseUntil: new Date(Date.now() + LEASE_MS) } });
  if (claimed.count) void execute(run.id, user, snapshot).catch(error => console.error('[diagnosis-run] persistence failure', error));
  return { ...run, status: claimed.count ? 'running' : run.status };
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
  return { inputHash: contentHash({ snapshot, generator: GENERATOR }), snapshot: { ...snapshot, interactions: undefined, interactionCount: snapshot.interactions.length } };
}

export async function getDiagnosis(user: string, id: string) {
  await prisma.diagnosisRun.updateMany({ where: { id, user, status: 'running', leaseUntil: { lt: new Date() } }, data: { status: 'failed', errorMessage: '后台任务已中断，请重新诊断。', completedAt: new Date(), leaseUntil: null } });
  await prisma.diagnosisRun.updateMany({ where: { id, user, status: 'pending', createdAt: { lt: new Date(Date.now() - LEASE_MS) } }, data: { status: 'failed', errorMessage: '任务未成功启动，请重新诊断。', completedAt: new Date() } });
  const run = await prisma.diagnosisRun.findFirst({ where: { id, user } });
  if (!run) throw new DiagnosisError('诊断记录不存在', 404);
  const snapshot = JSON.parse(run.inputSnapshotJson) as DiagnosisSnapshot;
  const report = parseStored<AgentDebugReportPayload | null>(run.reportJson, null);
  return { id: run.id, status: run.status, errorMessage: run.errorMessage, createdAt: run.createdAt, ...previewSnapshot(snapshot), inputHash: run.inputHash, report, eligibility: Object.fromEntries((report?.findings || []).map(f => [f.id, optimizationEligibility(report!, f)])), progress: readDiagnosisProgress({ user, executionId: run.executionId, runId: run.id }) };
}

export async function importDiagnosis(user: string, name: string, input: { runId: string; findingIds: string[]; baseVersion: number; expectedContentHash: string; baselineVerified?: boolean; constraints: string }) {
  const run = await prisma.diagnosisRun.findFirst({ where: { id: input.runId, user, status: 'done' } });
  if (!run?.reportJson) throw new DiagnosisError('诊断尚未完成或不可访问', 404);
  const snapshot = JSON.parse(run.inputSnapshotJson) as DiagnosisSnapshot;
  const invoked = snapshot.skills.find(item => item.name === name);
  if (!invoked) throw new DiagnosisError('本次执行未记录调用此 Skill，不能直接优化');
  if (invoked.version !== null && invoked.version !== input.baseVersion) throw new DiagnosisError('必须使用执行时 Skill 版本', 409);
  if ((invoked.version === null || !invoked.contentHash) && !input.baselineVerified) throw new DiagnosisError('执行时版本或文件快照缺失，请先核验基线');
  const base = await skillSnapshot(user, name, input.baseVersion);
  if (base.contentHash !== input.expectedContentHash || (invoked.contentHash && base.contentHash !== invoked.contentHash)) throw new DiagnosisError('Skill 基线已变化，请重新核验', 409);
  const findings = selectedFindings(JSON.parse(run.reportJson), input.findingIds);
  const key = contentHash({ user, runId: run.id, name, version: input.baseVersion, hash: base.contentHash, ids: findings.map(f => f.id).sort(), constraints: input.constraints });
  const id = `diagnosis-${key}`;
  const refs = [{ type: 'diagnosis', id: run.id, inputHash: run.inputHash, findingIds: findings.map(f => f.id), experimentId: run.experimentId, caseId: run.caseId, baseContentHash: base.contentHash, baselineVerified: Boolean(input.baselineVerified), constraints: input.constraints }];
  const existing = await prisma.skillWorkbenchSession.findFirst({ where: { id, user } });
  if (existing) return { sessionId: existing.id };
  try {
    return await prisma.$transaction(async tx => {
      const opt = await tx.skillOptSession.create({ data: { id, user, skillName: name, baseVersion: input.baseVersion, title: '诊断优化计划', files: JSON.stringify(base.files) } });
      await tx.skillOptPlan.create({ data: {
        sessionId: opt.id, skillId: base.skill.id, baseVersion: input.baseVersion, status: 'draft', operatorMeta: JSON.stringify({ source: 'diagnosis', sourceRefs: refs }),
        items: { create: findings.map((finding, rank) => ({ rank, route: 'core', status: 'pending', title: finding.summary, rationale: `${finding.evidence}\n用户确认与 ${name} 有关。\n${input.constraints}`, severity: finding.severity, proposedEdit: finding.correctionGuidance, sourceIssueIds: '[]', sourceRefsJson: JSON.stringify([{ ...refs[0], findingIds: [finding.id], finding }]), sourcesBreakdown: JSON.stringify({ diagnosis: 1 }) })) },
      } });
      const workbench = await tx.skillWorkbenchSession.create({ data: { id, user, title: `${name} · 诊断优化`, skillName: name, workVersion: input.baseVersion, source: 'management', activeView: 'optimization', stage: 'ready', filesJson: JSON.stringify(base.files), optSessionId: opt.id } });
      return { sessionId: workbench.id };
    });
  } catch (error) {
    if (await prisma.skillWorkbenchSession.findFirst({ where: { id, user } })) return { sessionId: id };
    throw error;
  }
}
