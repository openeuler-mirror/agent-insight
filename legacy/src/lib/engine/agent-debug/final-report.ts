import fs from 'node:fs';
import { z } from 'zod';

const moduleName = z.enum(['memory', 'reflection', 'planning', 'action', 'system', 'others']);
const text = z.string().refine(value => value.trim().length > 0, 'must not be blank');
const step = z.number().int().positive();
const moduleOutput = z.object({ content: z.string() }).passthrough();
const reportSchema = z.object({
  triage: z.object({
    category: z.enum(['normal', 'infra', 'tool_systemic', 'early_fatal']),
    shortCircuited: z.boolean(),
    fatalDiagnosis: z.object({ summary: text }).passthrough().nullable(),
  }).passthrough(),
  stepRecords: z.array(z.object({
    step,
    modules: z.object({ memory: moduleOutput, reflection: moduleOutput, planning: moduleOutput, action: moduleOutput, system: moduleOutput }).passthrough(),
  }).passthrough()),
  phase1Grid: z.array(z.object({ step, module: moduleName, errorDetected: z.boolean() }).passthrough()),
  issues: z.array(z.object({ id: text, module: moduleName, evidence: z.string() }).passthrough()),
  findings: z.array(z.object({
    id: text, summary: text, evidence: z.string(), correctionGuidance: z.string(),
    issueRefs: z.array(z.object({ issueId: text, role: z.enum(['root', 'contributing', 'downstream']) }).passthrough()),
  }).passthrough()),
  rootCause: z.object({ summary: text }).passthrough().nullable(),
  detectorFindings: z.array(z.object({ id: text, summary: text, relatedFindingId: text.optional() }).passthrough()).optional(),
}).passthrough().superRefine((report, ctx) => {
  function fail(path: (string | number)[], message: string) {
    ctx.addIssue({ code: 'custom', path, message });
  }
  function unique(items: { id: string }[], field: string) {
    const ids = new Set<string>();
    items.forEach((item, index) => {
      if (ids.has(item.id)) fail([field, index, 'id'], 'duplicate id');
      ids.add(item.id);
    });
    return ids;
  }
  const issues = unique(report.issues, 'issues');
  const findings = unique(report.findings, 'findings');
  unique(report.detectorFindings || [], 'detectorFindings');
  const roots = new Set<string>();
  report.findings.forEach((finding, index) => {
    const rootRefs = finding.issueRefs.filter(ref => ref.role === 'root');
    if (rootRefs.length !== 1) fail(['findings', index, 'issueRefs'], 'exactly one root issue is required');
    for (const ref of rootRefs) {
      if (roots.has(ref.issueId)) fail(['findings', index, 'issueRefs'], 'root issue already belongs to another finding');
      roots.add(ref.issueId);
    }
    finding.issueRefs.forEach((ref, refIndex) => {
      if (!issues.has(ref.issueId)) fail(['findings', index, 'issueRefs', refIndex, 'issueId'], 'referenced issue does not exist');
    });
  });
  report.detectorFindings?.forEach((finding, index) => {
    if (finding.relatedFindingId && !findings.has(finding.relatedFindingId)) fail(['detectorFindings', index, 'relatedFindingId'], 'referenced finding does not exist');
  });
  if (report.triage.shortCircuited && !report.triage.fatalDiagnosis) fail(['triage', 'fatalDiagnosis'], 'short circuit requires an explanation');
});

export function parseFinalDiagnosisReport(raw: string) {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('诊断报告解析失败：最终报告文件不是完整、有效的 JSON。'); }
  const result = reportSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'report'}: ${issue.message}`).join('; ');
    throw new Error(`诊断报告校验失败：${details}`);
  }
  return result.data;
}

export function readFinalDiagnosisReport(filePath: string) {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { throw new Error('诊断报告读取失败：最终报告文件不存在或无法读取。'); }
  return parseFinalDiagnosisReport(raw);
}
