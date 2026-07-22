import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AgentDebugDetectorFinding, AgentDebugSeverity } from './types';

const execFileAsync = promisify(execFile);

export type DetectorRunMode = 'one_click' | 'targeted';

export async function runSkillDetectors(args: {
  inputPath: string;
  mode: DetectorRunMode;
  query?: string;
}): Promise<AgentDebugDetectorFinding[]> {
  const skillsRoot = process.env.SYSTEM_SKILLS_ROOT || path.join(process.cwd(), 'skills');
  const runnerPath = path.join(skillsRoot, 'agent-debug-diagnosis', 'scripts', 'detector_runner.py');
  const commandArgs = [runnerPath, 'run-all', '--mode', args.mode, '--input', args.inputPath];
  if (args.query) commandArgs.push('--query', args.query);
  const { stdout } = await execFileAsync('python3', commandArgs, {
    timeout: Number(process.env.AGENT_DEBUG_DETECTOR_TIMEOUT_MS || 60_000),
    maxBuffer: 8 * 1024 * 1024,
  });
  const payload = JSON.parse(stdout) as { findings?: unknown };
  if (!Array.isArray(payload.findings)) return [];
  return payload.findings.map(normalizeDetectorFinding).filter((finding): finding is AgentDebugDetectorFinding => Boolean(finding));
}

export function normalizeDetectorFinding(value: unknown): AgentDebugDetectorFinding | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = text(item.id);
  const summary = text(item.summary);
  if (!id || !summary) return null;
  return {
    id,
    kind: text(item.kind) || 'specialized',
    pattern: text(item.pattern) || undefined,
    severity: severity(item.severity),
    summary,
    facts: stringList(item.facts),
    mechanism: text(item.mechanism),
    faultChain: stringList(item.faultChain),
    anchors: Array.isArray(item.anchors)
      ? item.anchors
          .map(anchor => anchor && typeof anchor === 'object' ? anchor as Record<string, unknown> : null)
          .filter((anchor): anchor is Record<string, unknown> => Boolean(anchor))
          .map(anchor => ({
            traceStepIndex: numeric(anchor.traceStepIndex),
            traceNodeLabel: text(anchor.traceNodeLabel) || undefined,
            anchorId: text(anchor.anchorId) || undefined,
            sourceInteractionIndex: numeric(anchor.sourceInteractionIndex),
            note: text(anchor.note) || undefined,
          }))
      : [],
    correctionGuidance: text(item.correctionGuidance),
    confidence: clamp(typeof item.confidence === 'number' ? item.confidence : Number(item.confidence || 0)),
    details: item.details && typeof item.details === 'object' ? item.details as Record<string, unknown> : {},
    detector: text(item.detector) || undefined,
    llmEnriched: Boolean(item.llmEnriched),
  };
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.map(text).filter(Boolean) : []; }
function numeric(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function severity(value: unknown): AgentDebugSeverity { return value === 'high' || value === 'low' ? value : 'medium'; }
function clamp(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
