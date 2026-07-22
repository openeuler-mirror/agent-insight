import fs from 'node:fs';
import path from 'node:path';

import { runSkillDetectors } from './detector-runtime';
import { enrichDetectorFindings } from './finding-enricher';
import { buildDebugTurns } from './trace-adapter';
import type { AgentDebugDetectorFinding } from './types';

export async function runTargetedDiagnosis(args: {
  workspaceDir: string;
  interactions: unknown[];
  query: string;
  user: string;
}): Promise<AgentDebugDetectorFinding[]> {
  const turns = buildDebugTurns(args.interactions);
  if (!turns.length) return [];
  const inputPath = path.join(args.workspaceDir, '.agent-insight', 'interactive-diagnosis-input.json');
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, `${JSON.stringify({ schemaVersion: 1, turns }, null, 2)}\n`, 'utf8');
  try {
    const findings = await runSkillDetectors({ inputPath, mode: 'targeted', query: args.query });
    return await enrichDetectorFindings(findings, turns, args.user);
  } catch {
    return [];
  }
}
