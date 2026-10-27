import { transaction } from './transaction';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db } from '@/lib/storage/prisma';
import { resolveAgentInsightDataPath } from '@/lib/env';
import { GenerationError, TRACE_FIELDS, receiptExpiry, requestTime, validateConfig, type GenerationProgress, type GenerationSummary } from '@/lib/trace-datasets/contracts';
import { hash } from '@/lib/trace-datasets/sampling';
import { PRODUCTION_POLICY as POLICY } from '@/lib/trace-datasets/sampling/production';
import { sourceScope } from './catalog';

type Slot = { worker: Worker; incarnationId: string; ready: boolean; stopping: boolean; jobId?: string; epoch?: number; heartbeat: number };
export class TraceDatasetManager {
  private slots: Slot[] = [];
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private cleaning = new Set<string>();
  private instanceId = randomUUID();
  private startPromise?: Promise<void>;
  private closed = false;
  private summaries = new Map<string, { epoch: number; expiresAt: number; datasetId: string; value: GenerationSummary | null }>();
  private pruneSummaries() {
    for (const [id, entry] of this.summaries) if (entry.expiresAt <= Date.now()) this.summaries.delete(id);
  }
  constructor(readonly client: PrismaClient, readonly root: string, readonly databaseUrl: string, readonly workerFile: string) {}
  dir(owner: string, jobId: string) { if (!/^[a-f0-9-]+$/i.test(jobId)) throw new Error('INVALID_JOB'); return path.join(this.root, hash(owner), 'jobs', jobId); }
  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initialize().catch(async error => { await this.close(); this.startPromise = undefined; throw error; });
    return this.startPromise;
  }
  private async initialize() {
    await fs.access(this.workerFile);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.access(this.root, fs.constants.W_OK);
    const lockPath = path.join(this.root, 'manager.lock');
    try {
      const lock = await fs.open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, instanceId: this.instanceId })); await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('GENERATOR_ALREADY_RUNNING');
      await fs.unlink(lockPath);
      const lock = await fs.open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, instanceId: this.instanceId })); await lock.close();
    }
    await this.client.traceDatasetGenerationJob.count();
    await this.client.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await this.client.traceDatasetGenerationJob.updateMany({ where: { status: 'running' }, data: { status: 'queued', leaseEpoch: { increment: 1 }, leaseOwner: null, leaseUntil: null } });
    await this.cleanupOrphans();
    for (let i = 0; i < 4; i++) this.spawnSlot(i);
    const deadline = Date.now() + 30000;
    while (this.slots.filter(s => s.ready).length !== 4) {
      if (Date.now() > deadline) { await this.close(); throw new Error('WORKER_UNAVAILABLE'); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000);
    this.timer.unref();
    await this.tick();
  }
  private spawnSlot(index: number) {
    if (this.closed) return;
    const incarnationId = randomUUID();
    const worker = new Worker(this.workerFile, { workerData: { databaseUrl: this.databaseUrl, incarnationId } });
    const slot: Slot = { worker, incarnationId, ready: false, stopping: false, heartbeat: Date.now() };
    this.slots[index] = slot;
    worker.unref();
    worker.on('message', message => {
      if (this.slots[index] !== slot || message.incarnationId !== slot.incarnationId) return;
      if (message.type === 'ready') { slot.ready = true; void this.tick().catch(() => {}); return; }
      if (message.jobId !== slot.jobId || message.epoch !== slot.epoch) return;
      slot.heartbeat = Date.now();
      if (message.type === 'summary') {
        this.pruneSummaries();
        const viewer = this.summaries.get(message.jobId);
        if (viewer) { viewer.epoch = message.epoch; viewer.value = message.summary; }
        worker.postMessage({ type: 'summary_ack', jobId: message.jobId, epoch: message.epoch, incarnationId: message.incarnationId, sequence: message.sequence });
        return;
      }
      if (message.type === 'done') {
        const jobId = slot.jobId!, epoch = slot.epoch!;
        slot.jobId = undefined; slot.epoch = undefined;
        void this.recover(jobId, epoch).then(() => this.tick()).catch(() => {});
      }
    });
    worker.on('error', () => {});
    worker.on('exit', () => {
      if (this.slots[index] !== slot) return;
      const jobId = slot.jobId, epoch = slot.epoch;
      slot.stopping = true;
      void (async () => {
        try { if (jobId) await this.recover(jobId, epoch!); }
        finally { if (!this.closed) this.spawnSlot(index); }
      })().catch(() => {});
    });
  }
  private async cleanupOrphans() {
    for (const owner of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!owner.isDirectory() || !/^[a-f0-9]{64}$/.test(owner.name)) continue;
      const jobsPath = path.join(this.root, owner.name, 'jobs');
      const stat = await fs.lstat(jobsPath).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
      for (const entry of await fs.readdir(jobsPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const job = await this.client.traceDatasetGenerationJob.findUnique({ where: { id: entry.name }, select: { id: true } });
        if (!job) await fs.rm(path.join(jobsPath, entry.name), { recursive: true, force: true });
      }
    }
  }
  private async recover(id: string, epoch: number) {
    await transaction(this.client, async tx => {
      const job = await tx.traceDatasetGenerationJob.findFirst({ where: { id, leaseEpoch: epoch, status: 'running' } });
      if (!job) return;
      if (job.attemptCount >= 2) {
        await tx.traceDatasetGenerationJob.update({ where: { id }, data: { status: 'failed', stage: 'failed', errorCode: 'WORKER_RECOVERY_EXHAUSTED', errorMessage: '后台任务多次中断，请重新生成', cleanupPending: true } });
        await tx.agentEvalDataset.update({ where: { id: job.datasetId }, data: { generationStatus: 'failed' } });
      } else {
        await tx.traceDatasetGenerationJob.update({ where: { id }, data: { status: 'queued', stage: 'queued', leaseEpoch: { increment: 1 }, attemptCount: { increment: 1 }, nextEligibleAt: new Date(Date.now() + (job.attemptCount ? 5000 : 1000)), leaseUntil: null, leaseOwner: null } });
      }
    });
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.pruneSummaries();
    this.ticking = true;
    try {
      const expired = await this.client.traceDatasetGenerationJob.findMany({ where: { status: 'running', leaseUntil: { lt: new Date() } }, select: { id: true, leaseEpoch: true } });
      for (const job of expired) if (!this.slots.some(s => s.jobId === job.id && !s.stopping)) await this.recover(job.id, job.leaseEpoch);
      const pending = await this.client.traceDatasetGenerationJob.findMany({ where: { OR: [{ status: { in: ['deleting', 'succeeded'] } }, { cleanupPending: true }] } });
      for (const job of pending) if (!this.slots.some(s => s.jobId === job.id)) await this.cleanup(job.id);
      for (const slot of this.slots) {
        if (this.closed) break;
        if (!slot.ready || slot.stopping) continue;
        if (slot.jobId) {
          if (Date.now() - slot.heartbeat > 30000) { slot.stopping = true; await slot.worker.terminate(); continue; }
          await this.client.traceDatasetGenerationJob.updateMany({ where: { id: slot.jobId, leaseEpoch: slot.epoch, status: 'running' }, data: { leaseUntil: new Date(Date.now() + 30000) } });
          continue;
        }
        const job = await this.client.traceDatasetGenerationJob.findFirst({ where: { status: 'queued', OR: [{ nextEligibleAt: null }, { nextEligibleAt: { lte: new Date() } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        if (!job) break;
        slot.jobId = job.id; slot.epoch = job.leaseEpoch + 1; slot.heartbeat = Date.now();
        const claim = await this.client.traceDatasetGenerationJob.updateMany({ where: { id: job.id, status: 'queued', leaseEpoch: job.leaseEpoch }, data: { status: 'running', leaseEpoch: slot.epoch, leaseOwner: `${this.instanceId}/${this.slots.indexOf(slot)}/${slot.incarnationId}`, leaseUntil: new Date(Date.now() + 30000) } });
        if (!claim.count) { slot.jobId = undefined; slot.epoch = undefined; continue; }
        const viewer = this.summaries.get(job.id);
        if (viewer) { viewer.epoch = slot.epoch; viewer.value = null; }
        slot.worker.postMessage({ jobId: job.id, epoch: slot.epoch, incarnationId: slot.incarnationId, dir: this.dir(job.owner, job.id) });
      }
      await this.expireReceipts();
    } finally { this.ticking = false; }
  }
  private async now(tx: Prisma.TransactionClient) {
    const key = { ownerKey: '__system__', kind: 'clock', operationKey: 'clock-high-water' };
    const row = await tx.traceDatasetOperationReceipt.findUnique({ where: { ownerKey_kind_operationKey: key } });
    const now = Math.max(Date.now(), Number(row?.clockHighWaterMs || 0));
    await tx.traceDatasetOperationReceipt.upsert({ where: { ownerKey_kind_operationKey: key }, create: { id: randomUUID(), ...key, outcome: 'clock', clockHighWaterMs: BigInt(now) }, update: { clockHighWaterMs: BigInt(now) } });
    return now;
  }
  private async expireReceipts() {
    await transaction(this.client, async tx => {
      const now = await this.now(tx);
      const expired = await tx.traceDatasetOperationReceipt.findMany({ where: { kind: { in: ['create', 'delete'] }, expiresAt: { lte: new Date(now) } }, take: 100 });
      for (const receipt of expired) {
        if (receipt.jobId && await tx.traceDatasetGenerationJob.findUnique({ where: { id: receipt.jobId }, select: { id: true } })) continue;
        await tx.traceDatasetOperationReceipt.delete({ where: { id: receipt.id } });
      }
    });
  }
  private async replay(tx: Prisma.TransactionClient, owner: string, requestId: string, requestHash: string) {
    const job = await tx.traceDatasetGenerationJob.findUnique({ where: { owner_requestId: { owner, requestId } } });
    if (job) {
      if (job.requestHash !== requestHash) throw new GenerationError('IDEMPOTENCY_CONFLICT', '请求标识已用于不同配置', 409);
      if (job.status === 'deleting') throw new GenerationError('REQUEST_EXPIRED', '该任务正在删除', 410);
      return { datasetId: job.datasetId, jobId: job.id };
    }
    const receipt = await tx.traceDatasetOperationReceipt.findUnique({ where: { ownerKey_kind_operationKey: { ownerKey: hash(owner), kind: 'create', operationKey: requestId } } });
    if (!receipt) return null;
    if (receipt.requestHash !== requestHash) throw new GenerationError('IDEMPOTENCY_CONFLICT', '请求标识已用于不同配置', 409);
    const now = await this.now(tx);
    if (receipt.outcome === 'succeeded' && receipt.expiresAt && receipt.expiresAt.getTime() > now && receipt.datasetId && receipt.jobId) {
      const dataset = await tx.agentEvalDataset.findFirst({ where: { id: receipt.datasetId, user: owner, generationSource: 'trace', generationStatus: 'published' }, select: { id: true } });
      if (dataset) return { datasetId: dataset.id, jobId: receipt.jobId };
    }
    throw new GenerationError('REQUEST_EXPIRED', '该请求已结束，请重新提交配置', 410);
  }
  async create(owner: string, raw: Record<string, unknown>) {
    await this.start();
    const config = validateConfig(raw), { requestId, ...request } = config;
    const requestHash = hash(request), ownerKey = hash(owner);
    const replay = await transaction(this.client, async tx => {
      const existing = await this.replay(tx, owner, requestId, requestHash);
      if (existing) return existing;
      const now = await this.now(tx);
      if (now >= requestTime(requestId) + 86400000 || requestTime(requestId) > now + 300000) throw new GenerationError('REQUEST_EXPIRED', '请求已过期，请重新提交配置', 410);
      return null;
    });
    if (replay) return replay;
    const scope = await sourceScope(this.client, owner, config);
    const ids = { datasetId: randomUUID(), jobId: randomUUID() };
    const result = await transaction(this.client, async tx => {
      const now = await this.now(tx);
      const existing = await this.replay(tx, owner, requestId, requestHash);
      if (existing) return existing;
      if (now >= requestTime(requestId) + 86400000 || requestTime(requestId) > now + 300000) throw new GenerationError('REQUEST_EXPIRED', '请求已过期，请重新提交配置', 410);
      if (await tx.traceDatasetGenerationJob.count({ where: { status: { in: ['queued', 'running', 'deleting'] } } }) >= 20) throw new GenerationError('QUEUE_LIMIT', '后台任务已满，请稍后重试', 429);
      await tx.agentEvalDataset.create({ data: { id: ids.datasetId, user: owner, name: config.name, description: config.description, targetAgent: scope.agentName, fieldsJson: JSON.stringify(TRACE_FIELDS), generationSource: 'trace', generationStatus: 'generating' } });
      await tx.traceDatasetGenerationJob.create({ data: { id: ids.jobId, datasetId: ids.datasetId, owner, requestId, requestHash, configJson: JSON.stringify({ ...config, ...scope, policy: POLICY, processorVersion: 'identity-v1', mappingVersion: 'stored-interactions-v4', purpose: 'coverage_regression' }) } });
      await tx.traceDatasetOperationReceipt.create({ data: { id: randomUUID(), ownerKey, kind: 'create', operationKey: requestId, requestHash, ...ids, outcome: 'accepted', expiresAt: receiptExpiry(requestId, now) } });
      return ids;
    }, { maxWait: 30000, timeout: 30000 });
    if (result.jobId === ids.jobId) this.summaries.set(result.jobId, { epoch: 0, expiresAt: Date.now() + 60000, datasetId: result.datasetId, value: null });
    void this.tick().catch(() => {});
    return result;
  }
  async progress(owner: string, datasetId: string): Promise<GenerationProgress> {
    const job = await this.client.traceDatasetGenerationJob.findFirst({ where: { owner, datasetId } });
    if (!job) {
      const dataset = await this.client.agentEvalDataset.findFirst({ where: { id: datasetId, user: owner, generationSource: 'trace', generationStatus: 'published' }, select: { caseCount: true } });
      if (!dataset) throw new GenerationError('NOT_FOUND', '未找到生成任务', 404);
      const receipt = await this.client.traceDatasetOperationReceipt.findFirst({ where: { ownerKey: hash(owner), kind: 'create', datasetId, outcome: 'succeeded', expiresAt: { gt: new Date() } }, select: { jobId: true } });
      this.pruneSummaries();
      const viewer = [...this.summaries.entries()].find(([, entry]) => entry.datasetId === datasetId);
      if (viewer) viewer[1].expiresAt = Date.now() + 60000;
      return { datasetId, jobId: receipt?.jobId || viewer?.[0] || null, status: 'published', stage: 'complete', stageIndex: 6, totalStages: 6, generatedCount: dataset.caseCount, summary: viewer?.[1].value || null, error: null, generationConfig: null, canCancel: false, canFinish: true, canReturn: false };
    }
    if (job.status === 'deleting') throw new GenerationError('DATASET_DELETING', '正在删除', 409, { deletionId: job.deletionId! });
    const status = job.status === 'succeeded' ? 'published' : job.status === 'failed' ? 'failed' : 'generating';
    const config = JSON.parse(job.configJson);
    const { name, description, platform, agentKey, from, to, limit, requestId } = config;
    this.pruneSummaries();
    const cached = this.summaries.get(job.id);
    if (cached) cached.expiresAt = Date.now() + 60000;
    return { datasetId, jobId: job.id, status, stage: job.stage, stageIndex: job.stageIndex, totalStages: 6, generatedCount: job.generatedCount, summary: cached?.epoch === job.leaseEpoch ? cached.value : null, error: status === 'failed' ? { code: job.errorCode!, message: job.errorMessage! } : null, generationConfig: status === 'failed' ? { name, description, platform, agentKey, from, to, limit, requestId } : null, canCancel: status !== 'published', canFinish: status === 'published', canReturn: status === 'failed' };
  }
  async releaseSummary(owner: string, datasetId: string) {
    const dataset = await this.client.agentEvalDataset.findFirst({ where: { id: datasetId, user: owner, generationSource: 'trace' }, select: { id: true } });
    if (!dataset) throw new GenerationError('NOT_FOUND', '未找到生成任务', 404);
    for (const [id, entry] of this.summaries) if (entry.datasetId === datasetId) this.summaries.delete(id);
  }

  async remove(owner: string, datasetId: string, cancelOnly = false) {
    await this.start();
    const job = await transaction(this.client, async tx => {
      const current = await tx.traceDatasetGenerationJob.findFirst({ where: { owner, datasetId } });
      if (!current) {
        const dataset = await tx.agentEvalDataset.findFirst({ where: { id: datasetId, user: owner, generationSource: 'trace', generationStatus: 'published' }, select: { id: true } });
        if (dataset) {
          if (cancelOnly) throw new GenerationError('ALREADY_COMPLETED', '数据集已生成完成', 409);
          const ownerKey = hash(owner), deletionId = randomUUID();
          const receipts = await tx.traceDatasetOperationReceipt.findMany({ where: { ownerKey, kind: 'create', datasetId } });
          const expiresAt = new Date(Math.max(await this.now(tx) + 86400000, ...receipts.map(r => r.expiresAt?.getTime() || 0)));
          await tx.traceDatasetOperationReceipt.updateMany({ where: { ownerKey, kind: 'create', datasetId }, data: { outcome: 'deleted', expiresAt } });
          await tx.traceDatasetOperationReceipt.upsert({ where: { ownerKey_kind_operationKey: { ownerKey, kind: 'delete', operationKey: datasetId } }, create: { id: randomUUID(), ownerKey, kind: 'delete', operationKey: datasetId, datasetId, deletionId, outcome: 'deleted', expiresAt }, update: { deletionId, outcome: 'deleted', expiresAt } });
          await tx.agentEvalDataset.delete({ where: { id: datasetId } });
          return { publishedDeletionId: deletionId };
        }
        const receipt = await tx.traceDatasetOperationReceipt.findFirst({ where: { ownerKey: hash(owner), kind: 'delete', datasetId, outcome: 'deleted' } });
        if (receipt) return null;
        throw new GenerationError('NOT_FOUND', '未找到数据集', 404);
      }
      if (cancelOnly && current.status === 'succeeded') throw new GenerationError('ALREADY_COMPLETED', '数据集已生成完成', 409);
      if (current.status === 'deleting') return current;
      return tx.traceDatasetGenerationJob.update({ where: { id: current.id }, data: { status: 'deleting', leaseEpoch: { increment: 1 }, cancelRequested: true, cleanupPending: true, deletionId: randomUUID(), errorCode: null, errorMessage: null } });
    });
    if (!job) return null;
    if ('publishedDeletionId' in job) {
      for (const [id, entry] of this.summaries) if (entry.datasetId === datasetId) this.summaries.delete(id);
      return { deletionId: job.publishedDeletionId, status: 'deleted' as const };
    }
    this.summaries.delete(job.id);
    const slot = this.slots.find(s => s.jobId === job.id);
    if (slot) {
      slot.worker.postMessage({ type: 'cancel', jobId: job.id, epoch: slot.epoch, incarnationId: slot.incarnationId });
      const deadline = Date.now() + 5000;
      while (slot.jobId === job.id && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (slot.jobId === job.id) { slot.stopping = true; await slot.worker.terminate(); }
    }
    await this.cleanup(job.id);
    return { deletionId: job.deletionId!, status: 'deleting' as const };
  }
  async deletion(owner: string, deletionId: string) {
    const job = await this.client.traceDatasetGenerationJob.findFirst({ where: { owner, deletionId, status: 'deleting' } });
    if (job) return { deletionId, status: job.errorCode === 'CLEANUP_FAILED' ? 'cleanup_failed' : 'deleting', error: job.errorCode === 'CLEANUP_FAILED' ? { code: 'CLEANUP_FAILED', message: '清理失败，请重试或检查存储权限' } : null };
    const receipt = await this.client.traceDatasetOperationReceipt.findFirst({ where: { ownerKey: hash(owner), kind: 'delete', deletionId, outcome: 'deleted' } });
    if (!receipt) throw new GenerationError('NOT_FOUND', '未找到清理记录', 404);
    return { deletionId, status: 'deleted', error: null };
  }
  private async cleanup(id: string) {
    if (this.cleaning.has(id)) return;
    this.cleaning.add(id);
    try {
      const job = await this.client.traceDatasetGenerationJob.findUnique({ where: { id } });
      if (!job || (!job.cleanupPending && job.status !== 'succeeded') || this.slots.some(s => s.jobId === id && !s.stopping)) return;
      const dir = this.dir(job.owner, id);
      const stat = await fs.lstat(dir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink()) throw new Error('UNSAFE_PATH');
      await fs.rm(dir, { recursive: true, force: true });
      await transaction(this.client, async tx => {
        const current = await tx.traceDatasetGenerationJob.findFirst({ where: { id, leaseEpoch: job.leaseEpoch, status: job.status } });
        if (!current) return;
        if (job.status === 'succeeded') {
          const dataset = await tx.agentEvalDataset.findFirst({ where: { id: job.datasetId, user: job.owner, generationSource: 'trace', generationStatus: 'published' }, select: { id: true } });
          if (!dataset) throw new Error('PUBLISHED_DATASET_MISSING');
          const data = { requestHash: job.requestHash, datasetId: job.datasetId, jobId: job.id, outcome: 'succeeded', expiresAt: receiptExpiry(job.requestId, await this.now(tx)) };
          await tx.traceDatasetOperationReceipt.upsert({ where: { ownerKey_kind_operationKey: { ownerKey: hash(job.owner), kind: 'create', operationKey: job.requestId } }, create: { id: randomUUID(), ownerKey: hash(job.owner), kind: 'create', operationKey: job.requestId, ...data }, update: data });
          await tx.traceDatasetGenerationJob.delete({ where: { id } });
          return;
        }
        if (job.status !== 'deleting') { await tx.traceDatasetGenerationJob.update({ where: { id }, data: { cleanupPending: false } }); return; }
        const expiresAt = receiptExpiry(job.requestId, await this.now(tx));
        const ownerKey = hash(job.owner);
        await tx.traceDatasetOperationReceipt.updateMany({ where: { ownerKey, kind: 'create', operationKey: job.requestId }, data: { outcome: 'deleted', expiresAt } });
        await tx.traceDatasetOperationReceipt.upsert({ where: { ownerKey_kind_operationKey: { ownerKey, kind: 'delete', operationKey: job.datasetId } }, create: { id: randomUUID(), ownerKey, kind: 'delete', operationKey: job.datasetId, datasetId: job.datasetId, jobId: id, deletionId: job.deletionId, outcome: 'deleted', expiresAt }, update: { outcome: 'deleted', expiresAt } });
        await tx.traceDatasetGenerationJob.delete({ where: { id } });
        await tx.agentEvalDataset.delete({ where: { id: job.datasetId } });
      });
      if (job.status === 'deleting') this.summaries.delete(job.id);
    } catch {
      await this.client.traceDatasetGenerationJob.updateMany({ where: { id, status: 'deleting' }, data: { errorCode: 'CLEANUP_FAILED', errorMessage: '清理失败，请重试' } }).catch(() => {});
    } finally { this.cleaning.delete(id); }
  }
  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const s of this.slots) if (s.jobId) s.worker.postMessage({ type: 'cancel', jobId: s.jobId, epoch: s.epoch, incarnationId: s.incarnationId });
    const deadline = Date.now() + 5000;
    while (this.slots.some(s => s.jobId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    await Promise.all(this.slots.map(s => s.worker.terminate()));
    this.summaries.clear();
    const lockPath = path.join(this.root, 'manager.lock');
    const lock = await fs.readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
    if (lock?.instanceId === this.instanceId) await fs.unlink(lockPath);
  }
}
type Startup = { ready: boolean; pending?: Promise<void>; error?: GenerationError; retryAt: number };
const globalManager = globalThis as typeof globalThis & { traceDatasetManager?: TraceDatasetManager; traceDatasetStartup?: Startup };
export function startTraceDatasetManager() {
  const state = globalManager.traceDatasetStartup ??= { ready: false, retryAt: 0 };
  if (state.ready || state.pending || Date.now() < state.retryAt) return;
  state.error = undefined;
  state.pending = Promise.resolve().then(async () => {
    const client = db.getClient();
    if (!(client instanceof PrismaClient) || !process.env.DATABASE_URL?.startsWith('file:')) throw new GenerationError('FEATURE_UNAVAILABLE', '基于 Trace 生成需要 SQLite 与常驻 Node Worker', 503);
    if (!globalManager.traceDatasetManager) {
      globalManager.traceDatasetManager = new TraceDatasetManager(client, path.join(resolveAgentInsightDataPath(), 'trace-datasets'), process.env.DATABASE_URL, path.join(process.cwd(), 'generated/trace-datasets/worker.cjs'));
    }
    const manager = globalManager.traceDatasetManager;
    const close = () => { void manager.close().catch(() => {}); };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
    try { await manager.start(); }
    catch (error) { process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close); throw error; }
    state.ready = true;
  }).catch(error => {
    globalManager.traceDatasetManager = undefined;
    state.error = error instanceof GenerationError ? error : new GenerationError('FEATURE_UNAVAILABLE', '后台生成服务初始化失败，请稍后重试；若持续失败，请联系管理员检查数据库、Worker 与任务目录', 503);
    state.retryAt = Date.now() + 30000;
    console.warn('[trace-datasets] initialization failed:', error instanceof Error ? error.message : 'unknown error');
  }).finally(() => { state.pending = undefined; });
}
export async function getTraceDatasetManager() {
  startTraceDatasetManager();
  const state = globalManager.traceDatasetStartup!;
  if (state.ready && globalManager.traceDatasetManager) return globalManager.traceDatasetManager;
  if (state.error) throw state.error;
  throw new GenerationError('FEATURE_INITIALIZING', '评测集生成服务正在初始化，请稍候', 503);
}
