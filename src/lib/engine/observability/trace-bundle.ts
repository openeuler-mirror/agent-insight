import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildFaultPathSteps, type FaultPathStep } from './fault-path';

const TRACE_BUNDLE_REL_DIR = path.join('.agent-insight', 'trace');
const SCHEMA_VERSION = 1;
const INLINE_LIMIT = 4_000;
const PREVIEW_LIMIT = 700;

export interface TraceBundleResult {
  bundleRelDir: string;
  manifestRelPath: string;
  indexRelPath: string;
  bundleDir: string;
  sourceHash: string;
  nodeCount: number;
  artifactCount: number;
  reused: boolean;
}

interface TraceManifest {
  schemaVersion: number;
  executionId: string;
  taskId: string;
  sourceHash: string;
  interactionCount: number;
  nodeCount: number;
  artifactCount: number;
  generatedAt: string;
  indexFile: string;
  nodesDir: string;
  artifactsDir: string;
}

export function ensureTraceBundle(args: {
  workspaceDir: string;
  executionId: string;
  interactions: unknown[];
}): TraceBundleResult {
  const workspaceDir = args.workspaceDir;
  const interactions = Array.isArray(args.interactions) ? args.interactions : [];
  const sourceHash = hashJson(interactions);
  const bundleDir = path.join(workspaceDir, TRACE_BUNDLE_REL_DIR);
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const indexPath = path.join(bundleDir, 'trace-index.json');

  const existing = readManifest(manifestPath);
  if (
    existing &&
    existing.schemaVersion === SCHEMA_VERSION &&
    existing.executionId === args.executionId &&
    existing.sourceHash === sourceHash &&
    fs.existsSync(indexPath)
  ) {
    return {
      bundleRelDir: toPosixRel(TRACE_BUNDLE_REL_DIR),
      manifestRelPath: toPosixRel(path.join(TRACE_BUNDLE_REL_DIR, 'manifest.json')),
      indexRelPath: toPosixRel(path.join(TRACE_BUNDLE_REL_DIR, 'trace-index.json')),
      bundleDir,
      sourceHash,
      nodeCount: existing.nodeCount,
      artifactCount: existing.artifactCount,
      reused: true,
    };
  }

  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(bundleDir, 'nodes'), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, 'artifacts'), { recursive: true });

  const steps = buildFaultPathSteps(interactions, 'zh');
  let artifactCount = 0;
  const indexNodes = steps.map((step) => {
    const nodeFileName = `${safeFileName(step.id)}.json`;
    const nodeRelPath = toPosixRel(path.join(TRACE_BUNDLE_REL_DIR, 'nodes', nodeFileName));
    const nodeFilePath = path.join(bundleDir, 'nodes', nodeFileName);
    const input = materializeTextField({
      bundleDir,
      step,
      field: 'input',
      value: step.rawInput,
      artifactCounter: () => ++artifactCount,
    });
    const output = materializeTextField({
      bundleDir,
      step,
      field: 'output',
      value: step.rawOutput,
      artifactCounter: () => ++artifactCount,
    });

    const nodeDoc = {
      id: step.id,
      stepIndex: step.stepIndex,
      name: step.name,
      kind: step.kind,
      status: step.status,
      depth: step.depth,
      meta: step.meta,
      interactionIndex: step.interactionIndex,
      eventIndex: step.eventIndex,
      toolCallId: step.toolCallId,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      rawTextPreview: preview(step.rawText, PREVIEW_LIMIT),
      input,
      output,
    };
    writeJson(nodeFilePath, nodeDoc);

    return {
      id: step.id,
      stepIndex: step.stepIndex,
      name: step.name,
      kind: step.kind,
      status: step.status,
      depth: step.depth,
      meta: step.meta,
      interactionIndex: step.interactionIndex,
      eventIndex: step.eventIndex,
      toolCallId: step.toolCallId,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      nodeFile: nodeRelPath,
      hasInput: Boolean(input),
      hasOutput: Boolean(output),
      inputArtifact: input?.artifactPath,
      outputArtifact: output?.artifactPath,
    };
  });

  const index = {
    schemaVersion: SCHEMA_VERSION,
    executionId: args.executionId,
    sourceHash,
    interactionCount: interactions.length,
    nodeCount: steps.length,
    nodes: indexNodes,
  };
  writeJson(indexPath, index);

  const manifest: TraceManifest = {
    schemaVersion: SCHEMA_VERSION,
    executionId: args.executionId,
    taskId: args.executionId,
    sourceHash,
    interactionCount: interactions.length,
    nodeCount: steps.length,
    artifactCount,
    generatedAt: new Date().toISOString(),
    indexFile: 'trace-index.json',
    nodesDir: 'nodes',
    artifactsDir: 'artifacts',
  };
  writeJson(manifestPath, manifest);

  return {
    bundleRelDir: toPosixRel(TRACE_BUNDLE_REL_DIR),
    manifestRelPath: toPosixRel(path.join(TRACE_BUNDLE_REL_DIR, 'manifest.json')),
    indexRelPath: toPosixRel(path.join(TRACE_BUNDLE_REL_DIR, 'trace-index.json')),
    bundleDir,
    sourceHash,
    nodeCount: steps.length,
    artifactCount,
    reused: false,
  };
}

function materializeTextField(args: {
  bundleDir: string;
  step: FaultPathStep;
  field: 'input' | 'output';
  value?: string;
  artifactCounter: () => number;
}) {
  const value = args.value || '';
  if (!value) return undefined;
  if (value.length <= INLINE_LIMIT) {
    return {
      length: value.length,
      content: value,
    };
  }

  const artifactIndex = args.artifactCounter();
  const fileName = `${safeFileName(args.step.id)}-${args.field}-${String(artifactIndex).padStart(4, '0')}.txt`;
  const artifactPath = path.join(args.bundleDir, 'artifacts', fileName);
  fs.writeFileSync(artifactPath, value, 'utf8');
  return {
    length: value.length,
    preview: preview(value, PREVIEW_LIMIT),
    artifactPath: toPosixRel(path.join(TRACE_BUNDLE_REL_DIR, 'artifacts', fileName)),
  };
}

function hashJson(value: unknown): string {
  let text = '';
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    text = String(value ?? '');
  }
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readManifest(filePath: string): TraceManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TraceManifest;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeFileName(value: string): string {
  const safe = String(value || 'node').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return safe || 'node';
}

function preview(value: string | undefined, max: number): string {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}...<truncated>` : text;
}

function toPosixRel(value: string): string {
  return value.split(path.sep).join('/');
}
