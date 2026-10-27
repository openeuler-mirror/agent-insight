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

import { transaction } from './transaction';
import { parentPort, workerData } from 'node:worker_threads';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, LEGACY_POLICY, lexicalSteps, signatureSteps, type Candidate, type LexicalFeatures, type Policy } from '../../lib/trace-datasets/sampling';
import { PRODUCTION_POLICY, productionSampleSteps, supportedProductionPolicy } from '../../lib/trace-datasets/sampling/production';
import { normalizeTraceCases, receiptExpiry, type GenerationSummary } from '../../lib/trace-datasets/contracts';
import { atomicJson, captureSources, lines, type FrozenConfig } from './source-reader';

const db = new PrismaClient({ datasources: { db: { url: workerData.databaseUrl } } });
const port = parentPort!;
let busy = false;
let cancelled = false;
let acknowledge: ((message: { jobId: string; epoch: number; sequence?: number }) => void) | undefined;
let sequence = 0;
port.on('message', async (message: { type?: string; jobId: string; epoch: number; incarnationId: string; dir: string; sequence?: number }) => {
  if (message.type === 'summary_ack') { acknowledge?.(message); return; }
  if (message.type === 'cancel') { cancelled = true; return; }
  if (busy) return;
  busy = true; cancelled = false;
  const { jobId, epoch, incarnationId, dir } = message;
  const send = (type: string) => port.postMessage({ type, jobId, epoch, incarnationId });
  const valid = { id: jobId, leaseEpoch: epoch, status: 'running', cancelRequested: false };
  const check = async () => { if (cancelled || !await db.traceDatasetGenerationJob.findFirst({ where: valid, select: { id: true } })) throw new Error('CANCELLED'); };
  const stage = async (value: string, index: number) => { const result = await db.traceDatasetGenerationJob.updateMany({ where: valid, data: { stage: value, stageIndex: index } }); if (!result.count) throw new Error('CANCELLED'); send('progress'); };
  const compute = async <T>(steps: Generator<void, T>): Promise<T> => {
    let lastCheck = Date.now();
    for (;;) { const next = steps.next(); if (next.done) return next.value; await new Promise<void>(resolve => setImmediate(resolve)); if (Date.now() - lastCheck > 100) { await check(); lastCheck = Date.now(); } }
  };
  const heartbeat = setInterval(() => send('heartbeat'), 5000);
  const publishSummary = async (summary: GenerationSummary) => {
    await check();
    const current = ++sequence;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { acknowledge = undefined; reject(new Error('SUMMARY_UNAVAILABLE')); }, 5000);
      acknowledge = reply => { if (reply.jobId === jobId && reply.epoch === epoch && reply.sequence === current) { clearTimeout(timeout); acknowledge = undefined; resolve(); } };
      port.postMessage({ type: 'summary', jobId, epoch, incarnationId, sequence: current, summary });
    });
  };
  try {
    const job = await db.traceDatasetGenerationJob.findFirst({ where: valid });
    if (!job) throw new Error('CANCELLED');
    const config = JSON.parse(job.configJson) as FrozenConfig & { limit: number; policy: Policy & { signatureProtocol: string } };
    if (!supportedProductionPolicy(config.policy)) throw new Error('SOURCE_CORRUPT');
    await stage('read', 0);
    await captureSources(db, job.owner, config, dir, check);
    await db.traceDatasetGenerationJob.updateMany({ where: valid, data: { captureState: 'sealed' } });
    await stage('dedup', 1);
    const pairs = new Map<string, Candidate>();
    const answers = new Map<string, string>();
    const inputs = new Map<string, { signature: Uint32Array; lexical?: LexicalFeatures }>();
    const files = new Map<string, { file: string; index: number }>();
    const summary: GenerationSummary = { version: 1, sourceTraces: 0, retainedTraces: 0, candidateCount: 0, duplicateCount: 0, sampledOutCount: null, exclusions: [] };
    const readUnit = async (location: { file: string; index: number }) => {
      const raw = JSON.parse(await fs.readFile(location.file, 'utf8'));
      const { checksum, ...body } = raw;
      if (hash(body) !== checksum) throw new Error('SOURCE_CORRUPT');
      return (body.units || [body.unit])[location.index];
    };
    for await (const member of lines(path.join(dir, 'members.jsonl'))) {
      await check();
      const file = path.join(dir, 'sources', `${hash(member.id)}.json`);
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      const { checksum, ...body } = raw;
      if (hash(body) !== checksum) throw new Error('SOURCE_CORRUPT');
      summary.sourceTraces++;
      const units = body.units || (body.unit ? [body.unit] : []);
      if (units.length) summary.retainedTraces++;
      summary.candidateCount += units.length;
      const reasons = new Map<string, number>();
      for (const exclusion of body.exclusions || (body.reason ? [{ code: body.reason, turnCount: 0 }] : [])) {
        const code = exclusion.code === 'MULTI_TURN' ? 'CONTEXT_UNCONFIRMED' : exclusion.code;
        reasons.set(code, (reasons.get(code) || 0) + exclusion.turnCount);
      }
      for (const [code, turnCount] of reasons) {
        let counter = summary.exclusions.find(e => e.code === code);
        if (!counter) { counter = { code, traceCount: 0, turnCount: 0 }; summary.exclusions.push(counter); }
        counter.traceCount++; counter.turnCount += turnCount;
      }
      for (const [index, u] of units.entries()) {
        const key = hash([u.input, u.reference_output]), inputKey = hash([u.input]);
        let features = inputs.get(inputKey);
        if (!features) {
          features = { signature: await compute(signatureSteps(u.input, config.policy.seed)), lexical: config.policy.version !== LEGACY_POLICY.version ? await compute(lexicalSteps(u.input)) : undefined };
          inputs.set(inputKey, features);
        }
        const p = { key: hash(body.units ? [body.sourceId, body.revision, index] : [body.sourceId, body.revision]), cells: u.cells, knownDimensions: u.knownDimensions };
        const existing = pairs.get(key);
        if (existing) {
          const previous = await readUnit(files.get(key)!);
          summary.duplicateCount++;
          if (previous.input !== u.input || previous.reference_output !== u.reference_output) throw new Error('SOURCE_CORRUPT');
          existing.paths.push(p);
        } else {
          pairs.set(key, { key, inputKey, task: u.task, ...features, paths: [p] }); files.set(key, { file, index });
          if (config.policy.version === PRODUCTION_POLICY.version) answers.set(key, u.reference_output);
        }
      }
    }
    summary.exclusions.sort((a, b) => a.code.localeCompare(b.code));
    await publishSummary(summary);
    await stage('stratify', 2);
    await stage('sample', 3);
    const result = await compute(productionSampleSteps([...pairs.values()], answers, config.limit, config.policy));
    summary.sampledOutCount = pairs.size - result.selected.length;
    await publishSummary(summary);
    await check();
    await stage('convert', 4);
    const items = [];
    for (const selected of result.selected) {
      const unit = await readUnit(files.get(selected.key)!);
      items.push({ id: selected.key, values: { input: unit.input, reference_output: unit.reference_output } });
    }
    const cases = normalizeTraceCases(items);
    const reference = cases.map(({ id, input, expectedOutput, evaluationFocus, tags }) => ({ id, input, expectedOutput, evaluationFocus, tags }));
    await atomicJson(path.join(dir, 'result.json'), cases);
    await stage('save', 5);
    await transaction(db, async tx => {
      const claimed = await tx.traceDatasetGenerationJob.updateMany({ where: valid, data: { status: 'succeeded', stage: 'complete', stageIndex: 6, generatedCount: cases.length, cleanupPending: true, leaseUntil: null } });
      if (!claimed.count) throw new Error('CANCELLED');
      await tx.agentEvalDataset.update({ where: { id: job.datasetId }, data: { casesJson: JSON.stringify(cases), referenceCasesJson: JSON.stringify(reference), caseCount: cases.length, projectionReady: true, generationStatus: 'published' } });
      await tx.traceDatasetOperationReceipt.updateMany({ where: { jobId, kind: 'create', expiresAt: { lt: receiptExpiry(job.requestId, Date.now()) } }, data: { expiresAt: receiptExpiry(job.requestId, Date.now()) } });
    }, { timeout: 30000, maxWait: 30000 });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code !== 'CANCELLED') {
      const errorCode = ['NO_VALID_SAMPLES', 'SOURCE_CORRUPT'].includes(code) ? code : 'RESOURCE_UNAVAILABLE';
      const errorMessage = errorCode === 'NO_VALID_SAMPLES' ? '所选 Trace 中没有可完整配对的问答，请调整 Agent 或时间范围' : errorCode === 'SOURCE_CORRUPT' ? '冻结来源缺失或损坏，请重新生成' : '读取或保存来源失败，请检查存储可用性后重新生成';
      try {
        await transaction(db, async tx => {
          const job = await tx.traceDatasetGenerationJob.findFirst({ where: valid });
          if (!job) return;
          await tx.traceDatasetGenerationJob.update({ where: { id: jobId }, data: { status: 'failed', stage: 'failed', errorCode, errorMessage, cleanupPending: true, leaseUntil: null } });
          await tx.agentEvalDataset.update({ where: { id: job.datasetId }, data: { generationStatus: 'failed' } });
          await tx.traceDatasetOperationReceipt.updateMany({ where: { jobId, kind: 'create', expiresAt: { lt: receiptExpiry(job.requestId, Date.now()) } }, data: { expiresAt: receiptExpiry(job.requestId, Date.now()) } });
        });
      } catch { send('storage_error'); }
    }
  } finally { clearInterval(heartbeat); if (cancelled) await db.$disconnect(); busy = false; send('done'); }
});
port.postMessage({ type: 'ready', incarnationId: workerData.incarnationId });
