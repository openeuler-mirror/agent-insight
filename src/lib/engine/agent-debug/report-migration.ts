import type { AgentDebugDetectorFinding, AgentDebugReportPayload, AgentDebugTrajectoryFinding } from './types';

export function migrateAgentDebugReport(report: AgentDebugReportPayload): AgentDebugReportPayload {
  if (Array.isArray(report.detectorFindings)) return report;
  if (!Array.isArray(report.trajectoryFindings)) return report;
  return {
    ...report,
    detectorFindings: report.trajectoryFindings.map(migrateTrajectoryFinding),
  };
}

function migrateTrajectoryFinding(finding: AgentDebugTrajectoryFinding): AgentDebugDetectorFinding {
  return {
    id: finding.id,
    kind: finding.kind,
    pattern: finding.pattern,
    severity: finding.severity,
    summary: finding.summary,
    facts: [finding.noProgressEvidence],
    mechanism: finding.mechanism,
    faultChain: finding.faultChain,
    anchors: finding.anchors,
    correctionGuidance: finding.correctionGuidance,
    confidence: finding.confidence,
    detector: finding.detector,
    llmEnriched: finding.llmEnriched,
    details: {
      span: finding.span,
      cycleCount: finding.cycleCount,
      signature: finding.signature,
      noProgressEvidence: finding.noProgressEvidence,
    },
  };
}
