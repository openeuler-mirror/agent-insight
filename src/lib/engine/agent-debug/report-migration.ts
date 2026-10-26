/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
