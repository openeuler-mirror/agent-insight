import type {
  AgentDebugDetectorFinding,
  AgentDebugDetectorMergeDecision,
  AgentDebugFinding,
  AgentDebugFindingImpact,
  AgentDebugSeverity,
} from './types';

export interface DetectorReconciliationResult {
  findings: AgentDebugFinding[];
  detectorFindings: AgentDebugDetectorFinding[];
  decisions: AgentDebugDetectorMergeDecision[];
}

export function reconcileDetectorFindings(args: {
  coreFindings: AgentDebugFinding[];
  detectorFindings: AgentDebugDetectorFinding[];
  decisions: AgentDebugDetectorMergeDecision[];
}): DetectorReconciliationResult {
  const findings = args.coreFindings.map(finding => ({
    ...finding,
    issueRefs: finding.issueRefs.map(ref => ({ ...ref })),
    supplementalEvidence: finding.supplementalEvidence?.map(evidence => ({ ...evidence })) || [],
  }));
  const findingById = new Map(findings.map(finding => [finding.id, finding]));
  const detectorById = new Map(args.detectorFindings.map(finding => [finding.id, finding]));
  const acceptedDecisions: AgentDebugDetectorMergeDecision[] = [];
  const independent: AgentDebugDetectorFinding[] = [];
  const handled = new Set<string>();

  for (const decision of args.decisions) {
    const detectorFinding = detectorById.get(decision.detectorFindingId);
    if (!detectorFinding || handled.has(detectorFinding.id)) continue;
    if (decision.action === 'merge' && decision.targetFindingId) {
      const target = findingById.get(decision.targetFindingId);
      if (target) {
        applyPatch(target, decision.patch);
        target.supplementalEvidence = [
          ...(target.supplementalEvidence || []),
          {
            summary: detectorFinding.summary,
            severity: detectorFinding.severity,
            facts: [...detectorFinding.facts],
            mechanism: detectorFinding.mechanism,
            faultChain: [...detectorFinding.faultChain],
            anchors: detectorFinding.anchors.map(anchor => ({ ...anchor })),
            correctionGuidance: detectorFinding.correctionGuidance,
            confidence: detectorFinding.confidence,
            details: structuredClone(detectorFinding.details),
          },
        ];
        handled.add(detectorFinding.id);
        acceptedDecisions.push(decision);
        continue;
      }
    }
    const relatedFindingId = decision.relatedFindingId && findingById.has(decision.relatedFindingId)
      ? decision.relatedFindingId
      : undefined;
    independent.push(cloneIndependentFinding(detectorFinding, relatedFindingId));
    handled.add(detectorFinding.id);
    acceptedDecisions.push({ ...decision, action: 'independent', targetFindingId: undefined, relatedFindingId });
  }

  for (const detectorFinding of args.detectorFindings) {
    if (handled.has(detectorFinding.id)) continue;
    independent.push(cloneIndependentFinding(detectorFinding));
    acceptedDecisions.push({
      detectorFindingId: detectorFinding.id,
      action: 'independent',
      reason: 'defaulted because no valid merge decision was returned',
    });
  }

  findings.sort(compareFindings);
  return { findings, detectorFindings: independent, decisions: acceptedDecisions };
}

function cloneIndependentFinding(finding: AgentDebugDetectorFinding, relatedFindingId?: string): AgentDebugDetectorFinding {
  return {
    ...finding,
    facts: [...finding.facts],
    faultChain: [...finding.faultChain],
    anchors: finding.anchors.map(anchor => ({ ...anchor })),
    details: structuredClone(finding.details),
    relatedFindingId,
  };
}

function applyPatch(finding: AgentDebugFinding, patch: AgentDebugDetectorMergeDecision['patch']): void {
  if (!patch) return;
  if (isSeverity(patch.severity) && severityRank(patch.severity) > severityRank(finding.severity)) {
    finding.severity = patch.severity;
  }
  if (isImpact(patch.impact) && impactRank(patch.impact) > impactRank(finding.impact)) {
    finding.impact = patch.impact;
  }
  if (typeof patch.confidence === 'number' && Number.isFinite(patch.confidence)) {
    finding.confidence = Math.max(finding.confidence, Math.max(0, Math.min(1, patch.confidence)));
  }
}

function compareFindings(a: AgentDebugFinding, b: AgentDebugFinding): number {
  const severityDelta = severityRank(b.severity) - severityRank(a.severity);
  if (severityDelta !== 0) return severityDelta;
  return impactRank(b.impact) - impactRank(a.impact);
}

function severityRank(value: AgentDebugSeverity): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function impactRank(value: AgentDebugFindingImpact): number {
  if (value === 'result_blocking') return 4;
  if (value === 'quality_degrading') return 3;
  if (value === 'recovered_cost') return 2;
  return 1;
}

function isSeverity(value: unknown): value is AgentDebugSeverity {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isImpact(value: unknown): value is AgentDebugFindingImpact {
  return value === 'result_blocking' || value === 'quality_degrading' || value === 'recovered_cost' || value === 'risk';
}
