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

import { acquireProcessLock } from './process-lock.mjs';
import { createDshContextSource } from './dsh-context-source.mjs';
import { splitNativeContextBody } from './dsh-context-details.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, readFileSync, openSync, closeSync, ftruncateSync, fstatSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'agent-insight-deepseek-harness-observability';

const INTEGRATION_VERSION = '0.1.0';
const REDACTION_POLICY = 'v1';
const DEFAULT_MAX_STRING_CHARS = 32768;

const SENSITIVE_KEY = /(?:^|[._-])(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|credential)$/i;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const SECRET_TOKEN = /\bsk-[A-Za-z0-9._-]+\b/g;
const SECRET_ENV_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)=([^\s&]+)/gi;
const SECRET_QUERY_PARAM = /([?&](?:access_token|refresh_token|api_key|token|secret|password)=)[^&#\s]+/gi;

function redactString(value) {
  return value
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(SECRET_ENV_ASSIGNMENT, '$1=[REDACTED]')
    .replace(SECRET_QUERY_PARAM, '$1[REDACTED]')
    .replace(SECRET_TOKEN, '[REDACTED]');
}

function truncateString(value, maxStringChars) {
  const characters = Array.from(value);
  if (characters.length <= maxStringChars) return value;

  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${characters.slice(0, maxStringChars).join('')}…[truncated chars=${characters.length} sha256=${digest}]`;
}

function transform(value, options, key) {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return truncateString(redactString(value), options.maxStringChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => transform(item, options));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        transform(childValue, options, childKey),
      ]),
    );
  }
  return value;
}

export function redactTelemetryRecord(record, config = {}) {
  const configuredMax = Number(config.maxStringChars);
  const maxStringChars = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_STRING_CHARS;
  const transformed = transform(record, { maxStringChars });

  transformed.attributes = {
    ...(transformed.attributes || {}),
    'agent.insight.integration.name': 'deepseek-harness',
    'agent.insight.integration.version': INTEGRATION_VERSION,
    'agent.insight.redaction.policy': REDACTION_POLICY,
  };
  return transformed;
}

export function apply(ctx, config = {}) {
  if (config.live) {
    registerLiveExporter(ctx, config);
    return;
  }
  ctx.on('session-telemetry/record', (_record, next) => {
    return redactTelemetryRecord(next(), config);
  });
}

function otlpValue(value) {
  if (typeof value === 'number') return { doubleValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } };
  if (value && typeof value === 'object') {
    return { kvlistValue: { values: Object.entries(value).filter(([, item]) => item != null)
      .map(([key, item]) => ({ key, value: otlpValue(item) })) } };
  }
  return { stringValue: String(value ?? '') };
}

export function queueLimits(config = {}) {
  const bound = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
  return { bytes: bound(config.queueMaxBytes, 67108864), files: bound(config.queueMaxFiles, 4096),
    deadBytes: bound(config.deadMaxBytes, 8388608), deadFiles: bound(config.deadMaxFiles, 256), ttl: 7 * 86400000 };
}

function replaceQueueFile(target, data) {
  const temporary = path.join(path.dirname(target), Date.now() + '-' + randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export function admitTelemetry(directory, payload, config = {}, now = Date.now()) {
  const lock = path.join(directory, '.admission.lock');
  const release = acquireProcessLock(lock);
  if (!release) return 'busy';
  try {
    const limits = queueLimits(config);
    const files = readdirSync(directory).filter(file => /\.(json|tmp)$/.test(file));
    const bytes = files.reduce((sum, file) => { try { return sum + statSync(path.join(directory, file)).size + 1024; } catch (error) { if (error.code === 'ENOENT') return sum; throw error; } }, 0);
    const data = JSON.stringify(payload);
    if (files.length >= limits.files || bytes + Buffer.byteLength(data) + 1024 > limits.bytes) return 'quota';
    replaceQueueFile(path.join(directory, now + '-' + randomUUID() + '.json'), data);
    return 'stored';
  } finally { release(); }
}

export function maintainTelemetryQueue(directory, config = {}, now = Date.now()) {
  const limits = queueLimits(config);
  const dead = path.join(directory, 'dead-letter');
  mkdirSync(dead, { recursive: true, mode: 0o700 });
  for (const root of [directory, dead]) for (const file of readdirSync(root)) {
    if (!/\.(json|tmp)$/.test(file)) continue;
    const created = Number(file.split('-')[0]);
    if (Number.isFinite(created) && created + limits.ttl <= now) { try { unlinkSync(path.join(root, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  scrubExpiredOutboxBodies(directory, now);
  scrubExpiredOutboxBodies(dead, now);
}

export function quarantineTelemetry(directory, file, reason, config = {}) {
  const lock = path.join(directory, '.admission.lock');
  const release = acquireProcessLock(lock);
  if (!release) return false;
  try {
  const dead = path.join(directory, 'dead-letter');
  mkdirSync(dead, { recursive: true, mode: 0o700 });
  const limits = queueLimits(config), source = path.join(directory, file);
  const files = readdirSync(dead).filter(name => name.endsWith('.json'));
  const bytes = files.reduce((sum, name) => sum + statSync(path.join(dead, name)).size, 0);
  if (files.length >= limits.deadFiles || bytes + statSync(source).size > limits.deadBytes) return false;
  renameSync(source, path.join(dead, file));
  return true;
  } finally { release(); }
}

export function retryTelemetry(payload, status, retryAfter, now = Date.now()) {
  const attempts = (payload.agentInsightDelivery?.attempts ?? 0) + 1;
  const seconds = Number(retryAfter);
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
  const wait = Math.min(60000, Math.max(1000 * 2 ** Math.min(attempts - 1, 6), Number.isFinite(requested) ? requested : 0));
  payload.agentInsightDelivery = { attempts, status, nextAttemptAt: now + wait };
  return payload;
}

export function registerLiveExporter(ctx, config) {
  const baseUrl = process.env.AGENT_INSIGHT_BASE_URL?.replace(/\/+$/, '');
  const apiKey = process.env.AGENT_INSIGHT_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('Agent Insight endpoint and API key are required');
  const scope = createHash('sha256').update(baseUrl + '\0' + apiKey).digest('hex');
  const directory = path.join(config.telemetryDirectory ?? path.join(homedir(), '.agent-insight', 'harness-outbox'), scope);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let running;
  let closed = false;
  const controller = new AbortController();
  const scrubBodies = () => {
    try { maintainTelemetryQueue(directory, config); }
    catch { ctx.logger.warn('Agent Insight expired outbox body cleanup failed'); }
  };
  scrubBodies();
  const drain = () => {
    if (running || closed) return running ?? Promise.resolve();
    running = (async () => {
      const files = readdirSync(directory).filter(file => file.endsWith('.json')).sort().slice(0, 512);
      for (const file of files) {
        if (closed) break;
        const target = path.join(directory, file);
        try {
          let payload;
          try { payload = JSON.parse(readFileSync(target, 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') continue; if (!quarantineTelemetry(directory, file, 'invalid-json', config)) { ctx.logger.warn('Agent Insight dead-letter full or busy; invalid event retained'); break; } ctx.logger.warn('Agent Insight invalid queue event quarantined'); continue; }
          if (payload.agentInsightDelivery?.nextAttemptAt > Date.now()) continue;
          const { agentInsightDelivery, ...wire } = payload;
          const response = await fetch(baseUrl + '/api/ingest/otel/v1/logs', {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-witty-api-key': apiKey },
            body: JSON.stringify(wire),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          });
          if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && ![401, 403, 408, 429].includes(response.status)) {
              if (!quarantineTelemetry(directory, file, 'http-' + response.status, config)) { ctx.logger.warn('Agent Insight dead-letter full or busy; failed event retained'); break; }
              ctx.logger.warn('Agent Insight permanent HTTP failure quarantined: ' + response.status);
              continue;
            }
            replaceQueueFile(target, JSON.stringify(retryTelemetry(payload, response.status, response.headers.get('retry-after'))));
            break;
          }
          try { unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } catch (error) {
          try { const payload = JSON.parse(readFileSync(target, 'utf8')); replaceQueueFile(target, JSON.stringify(retryTelemetry(payload, 'network'))); } catch {}
          break;
        }
      }
    })().catch(() => ctx.logger.warn('Agent Insight outbox read failed'))
      .finally(() => { running = undefined; });
    return running;
  };
  const contextSource = config.contextSource ?? createDshContextSource(ctx);
  const pendingContext = new Set();
  const previousResponse = new Map();
  const persistEvent = (session, event) => {
    try {
      const attributes = {
        'session.id': String(session.id), 'event.type': event.type,
        ...(Number.isSafeInteger(event.seq) ? { 'event.seq': event.seq } : {}),
      };
      if (session.header?.parentSession != null) attributes['session.parent_id'] = String(session.header.parentSession);
      if (session.header?.cwd != null) attributes['session.cwd'] = session.header.cwd;
      if (session.header?.isSeeded) attributes['session.seed_length'] = session.inheritedEventCount;
      const membership = undefined;
      const record = redactTelemetryRecord({ attributes, body: membership
        ? { ...event.data, contextMembership: membership } : event.data }, config);
      const native = splitNativeContextBody(event.type, record.body, session.id, event.seq, event.time);
      if (native?.attachment) {
        const item=native.attachment.items[0];let text='',bytes=0;
        for(const char of item.text){const size=Buffer.byteLength(char);if(bytes+size>8192)break;text+=char;bytes+=size;}
        if(text!==item.text)item.bodyStatus='truncated';
        item.text=text;
      }
      if (native) record.body = {...native.body, ...(native.attachment ? {contextBody:native.attachment} : {})};
      const payload = { resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'deepseek-harness' } }] },
        scopeLogs: [{ scope: { name }, logRecords: [{
          timeUnixNano: String(BigInt(event.time) * 1000000n),
          attributes: Object.entries(record.attributes).map(([key, value]) => ({ key, value: otlpValue(value) })),
          body: otlpValue(record.body),
        }] }],
      }] };
      if (record.body?.contextBody) payload.agentInsightBodyExpiresAt=record.body.contextBody.expiresAt;
      if (membership?.items?.some(item => typeof item.text === 'string')) payload.agentInsightBodyExpiresAt = membership.expiresAt;
      const previews=record.body?.dshContext?.details;
      if(previews?.items?.some(item=>typeof item.text==='string')) payload.agentInsightBodyExpiresAt=previews.expiresAt;
      // Persist before attempting delivery. Endpoint and credential scope prevents cross-account replay.
      const admission = admitTelemetry(directory, payload, config);
      if (admission !== 'stored') ctx.logger.warn('Agent Insight telemetry queue admission rejected: ' + admission);
      void drain();
    } catch {
      ctx.logger.warn('Agent Insight telemetry persistence failed');
    }
  };
  ctx.on('session/event', (session, event) => {
    if (!session.id || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.time)) return;
    persistEvent(session, event);
    if (event.type !== 'assistant/message') return;
    const baseSeq = previousResponse.get(session.id);
    previousResponse.set(session.id,event.seq);
    if (previousResponse.size > 256) previousResponse.delete(previousResponse.keys().next().value);
    if (pendingContext.size >= 32) { ctx.logger.warn('Agent Insight dsh-context enrichment queue full; core event retained'); return; }
    const work = Promise.resolve().then(()=>contextSource(session,event,baseSeq)).then(dshContext=>{
      persistEvent(session,{type:'agent-insight/context',time:event.time,data:{responseEventSequence:event.seq,turn:event.data.turn,step:event.data.step,dshContext}});
    }).catch(()=>ctx.logger.warn('Agent Insight dsh-context enrichment unavailable; core event retained')).finally(()=>pendingContext.delete(work));
    pendingContext.add(work);
  });
  const timer = setInterval(() => { scrubBodies(); void drain(); }, 5000);
  timer.unref();
  void drain();
  ctx.effect(() => async () => {
    clearInterval(timer);
    const timeout = setTimeout(() => { closed = true; controller.abort(); }, 3000);
    try { await Promise.allSettled([...pendingContext]); await drain(); await drain(); } finally { clearTimeout(timeout); closed = true; controller.abort(); }
  });
}

function removeOldCorruptFile(target, now) {
  try {
    const info = statSync(target);
    const firstKnown = Math.min(info.mtimeMs, info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs);
    if (firstKnown + 7 * 86400000 > now) return false;
    unlinkSync(target);
    return true;
  } catch { return false; }
}

export function scrubExpiredOutboxBodies(directory, now = Date.now(), onError = () => {}) {
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) continue;
    const target = path.join(directory, file);
    try {
      const payload = JSON.parse(readFileSync(target, 'utf8'));
      if (!(Date.parse(payload.agentInsightBodyExpiresAt) <= now)) continue;
      for (const resource of payload.resourceLogs ?? []) for (const scope of resource.scopeLogs ?? []) for (const record of scope.logRecords ?? []) {
        const membership = record.body?.kvlistValue?.values?.find(entry => entry.key === 'contextMembership')?.value;
        const projection=record.body?.kvlistValue?.values?.find(entry=>entry.key==='dshContext')?.value;
        const details=projection?.kvlistValue?.values?.find(entry=>entry.key==='details')?.value;
        const native=record.body?.kvlistValue?.values?.find(entry=>entry.key==='contextBody')?.value;
        const items = [membership,details,native].flatMap(value=>value?.kvlistValue?.values?.find(entry => entry.key === 'items')?.value?.arrayValue?.values ?? []);
        for (const item of items) if (item.kvlistValue) {
          item.kvlistValue.values = item.kvlistValue.values.filter(entry => entry.key !== 'text');
          for (const entry of item.kvlistValue.values) {
            if (entry.key === 'bodyStatus') entry.value = { stringValue: 'expired' };
            if (entry.key === 'storedBytes') entry.value = { doubleValue: 0 };
          }
        }
      }
      delete payload.agentInsightBodyExpiresAt;
      const fd = openSync(target, 'r+');
      try {
        const serialized = JSON.stringify(payload);
        writeFileSync(fd, serialized); ftruncateSync(fd, Buffer.byteLength(serialized));
      } finally { closeSync(fd); }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        onError();
        if (error instanceof SyntaxError) removeOldCorruptFile(target, now);
      }
    }
  }
}

export function buildRequestMembership(options, config = {}) {
  const maxItemBytes = 8192;
  const maxRequestBytes = 262144;
  let used = 0;
  const items = [];
  const estimatedCategories = {};
  let estimatesAvailable = Boolean(config.estimates);
  const toolNames = new Map();
  for (const message of options.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'tool-call' && typeof block.id === 'string') toolNames.set(block.id, block.name);
  }
  const add = (id, category, input, sourceEventSeq) => {
    const text = JSON.stringify(transform(input, { maxStringChars: Number.MAX_SAFE_INTEGER }));
    const bytes = Buffer.byteLength(JSON.stringify(input));
    const remaining = Math.max(0, Math.min(maxItemBytes, maxRequestBytes - used));
    let stored = '';
    let storedBytes = 0;
    for (const character of text) {
      const size = Buffer.byteLength(character);
      if (storedBytes + size > remaining) break;
      stored += character;
      storedBytes += size;
    }
    used += Buffer.byteLength(stored);
    items.push({
      itemId: id, position: items.length, category,
      sourceEventSeq: Number.isSafeInteger(sourceEventSeq) ? sourceEventSeq : null,
      sourceType: Number.isSafeInteger(sourceEventSeq) ? 'session-event' : 'request-field',
      ...(typeof input?.source?.kind === 'string' ? { sourceKind: input.source.kind } : {}),
      ...(typeof input?.source?.callId === 'string' ? { sourceCallId: input.source.callId } : {}),
      contentFingerprint: createHash('sha256').update(text).digest('hex'),
      fingerprintScope: 'redacted-content',
      bodyStatus: !config.captureBodies ? 'not-collected' : stored === text ? 'available' : 'truncated',
      originalBytes: bytes, redactedBytes: Buffer.byteLength(text), storedBytes: config.captureBodies ? Buffer.byteLength(stored) : 0,
      ...(config.captureBodies ? { text: stored } : {}),
    });
  };
  if (options.system !== undefined) add('system', 'system', options.system);
  for (const [index, tool] of (options.tools ?? []).entries()) add(typeof tool.name === 'string' ? 'tool-definition:'+tool.name : 'position:tool:'+index, 'tool-definition', tool);
  for (const [index, message] of (options.messages ?? []).entries()) {
    const sourceSeq = message.seq;
    const id = typeof message.id === 'string' ? 'message:'+message.id : 'position:'+index;
    const toolName = toolNames.get(message.toolCallId ?? message.source?.callId);
    const category = message.role === 'tool' && toolName === 'skill' ? 'skill-injection'
      : message.source?.kind === 'runtime-context' ? 'runtime-context'
        : message.source?.kind === 'skill-catalog' ? 'skill-catalog' : message.role ?? 'unknown';
    add(id, category, message, sourceSeq);
    if (config.estimates) {
      try { estimatedCategories[category] = (estimatedCategories[category] ?? 0) + config.estimates.estimateMessage(message); }
      catch { estimatesAvailable = false; }
    }
  }
  if (config.estimates) {
    try {
      estimatedCategories['tool-definition'] = config.estimates.estimateToolsTokens(options);
      if (options.system !== undefined) estimatedCategories.system = (estimatedCategories.system ?? 0)
        + config.estimates.estimateMessage({ role: 'system', content: [{ type: 'text', text: String(options.system) }] });
    } catch { estimatesAvailable = false; }
  }
  return {
    schemaVersion: 1, sourceSessionId: options.sessionId,
    attemptId: randomUUID(), capturedAt: new Date().toISOString(),
    captureBoundary: 'harness-llm-stream',
    representation: 'captured-canonical-request',
    providerWireCaptured: false,
    tokenEstimate: estimatesAvailable ? {
      method: '@deepseek-ai/dsh-token-meter/estimate',
      basis: 'canonical-request-before-provider-adaptation',
      approximate: true,
      categories: estimatedCategories,
      total: Object.values(estimatedCategories).reduce((sum, value) => sum + value, 0),
    } : null,
    membershipCoverage: Array.isArray(options.messages) ? 'complete-at-capture-boundary' : 'unknown',
    identityCoverage: items.some(item => item.itemId.startsWith('position:'))
      || new Set(items.map(item => item.itemId)).size !== items.length ? 'partial' : 'stable',
    provider: options.provider, model: options.model, purpose: options.purpose,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    items,
  };
}

export function cleanRequestMembers(directory, now = Date.now(), onError = () => {}) {
  let removed = 0;
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) continue;
    const target = path.join(directory, file);
    try {
      const prior = JSON.parse(readFileSync(target, 'utf8'));
      if (!Number.isFinite(Date.parse(prior.expiresAt))) {
        onError();
        if (removeOldCorruptFile(target, now)) removed++;
        continue;
      }
      if (Number.isFinite(Date.parse(prior.expiresAt)) && Date.parse(prior.expiresAt) <= now) {
        unlinkSync(target);
        removed++;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        onError();
        if (error instanceof SyntaxError && removeOldCorruptFile(target, now)) removed++;
      }
    }
  }
  return removed;
}

export function persistRequestMember(directory, manifest) {
  const lock = path.join(directory, createHash('sha256').update(manifest.sourceSessionId).digest('hex') + '.lock');
  const release = acquireProcessLock(lock);
  if (!release) return 'busy';
  try {
    let sessionBytes = 0;
    for (const file of readdirSync(directory)) {
      if (!file.endsWith('.json')) continue;
      const target = path.join(directory, file);
      try {
        const prior = JSON.parse(readFileSync(target, 'utf8'));
        if (prior.sourceSessionId === manifest.sourceSessionId) sessionBytes += statSync(target).size;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const serialized = JSON.stringify(manifest);
    if (sessionBytes + Buffer.byteLength(serialized) > 1048576) return 'quota';
    writeFileSync(path.join(directory, manifest.attemptId + '.json'), serialized, { flag: 'wx', mode: 0o600 });
    return 'stored';
  } finally {
    release();
  }
}

export function registerRequestMembers(ctx, config) {
  const directory = config.membersDirectory ?? path.join(homedir(), '.agent-insight', 'harness-request-members');
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch { ctx.logger.warn('Agent Insight member directory unavailable'); return; }
  const clean = () => {
    try {
      cleanRequestMembers(directory, Date.now(), () => ctx.logger.warn('Agent Insight invalid member file skipped'));
    } catch { ctx.logger.warn('Agent Insight member directory scan failed'); }
  };
  const timer = setInterval(clean, 60000);
  timer.unref();
  clean();
  ctx.effect(() => () => clearInterval(timer));
  const positions = new WeakMap();
  const pending = new Map();
  const bound = new Map();
  ctx.on('agent/request', (request, next) => {
    if (request.signal && request.agent?.session?.id) positions.set(request.signal, {
      sourceSessionId: request.agent.session.id, turn: request.turn, step: request.step,
    });
    return next();
  });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return;
    const key = JSON.stringify([session.id, event.data?.turn, event.data?.step]);
    const candidates = pending.get(key);
    pending.delete(key);
    if (candidates?.length !== 1) return;
    const manifest = candidates[0];
    manifest.response = { sourceSessionId: session.id, eventSequence: event.seq,
      turn: event.data.turn, step: event.data.step, eventType: event.type };
    manifest.bindingBasis = 'native-agent-request-signal-and-step';
    manifest.bindingStatus = 'bound';
    delete manifest.bindingReserve;
    let fd;
    try {
      if (manifest.localPersistenceStatus !== 'stored') return;
      const target = path.join(directory, manifest.attemptId + '.json');
      const serialized = JSON.stringify(manifest);
      fd = openSync(target, 'r+');
      if (Buffer.byteLength(serialized) > fstatSync(fd).size) throw new Error('Binding reservation exceeded');
      writeFileSync(fd, serialized);
      ftruncateSync(fd, Buffer.byteLength(serialized));
    } catch { ctx.logger.warn('Agent Insight request response binding persistence failed'); }
    finally {
      if (fd !== undefined) closeSync(fd);
      const { items, ...metadata } = manifest;
      bound.set(JSON.stringify([session.id, event.seq]), { ...metadata,
        items: config.uploadBodies ? items : items.map(({ text, ...item }) => ({ ...item, bodyStatus: 'not-uploaded', storedBytes: 0 })) });
    }
  });
  ctx.on('llm/stream', (options, next) => {
    if (!options.sessionId) return next();
    try {
      const manifest = buildRequestMembership(options, config);
      const position = options.signal && positions.get(options.signal);
      const exactMainRequest = config.isAgentLoopRequest?.(options) === true
        && position?.sourceSessionId === options.sessionId;
      manifest.bindingStatus = exactMainRequest ? 'pending' : 'unbound';
      manifest.response = null;
      manifest.bindingReserve = ' '.repeat(512);
      let status = persistRequestMember(directory, manifest);
      if (status === 'quota' && manifest.items.some(item => typeof item.text === 'string')) {
        manifest.items = manifest.items.map(({ text, ...item }) => ({ ...item, bodyStatus: 'quota-omitted', storedBytes: 0 }));
        manifest.bodyCaptureStatus = 'quota-omitted';
        status = persistRequestMember(directory, manifest);
      }
      manifest.localPersistenceStatus = status;
      if (exactMainRequest) {
        const key = JSON.stringify([position.sourceSessionId, position.turn, position.step]);
        const candidates = pending.get(key) ?? [];
        candidates.push(manifest);
        pending.set(key, candidates);
      }
      if (status !== 'stored') ctx.logger.warn('Agent Insight member capture skipped: ' + status);
    } catch {
      ctx.logger.warn('Agent Insight request membership capture unavailable');
    }
    return next();
  });
  return (sessionId, seq) => {
    const key = JSON.stringify([sessionId, seq]);
    const manifest = bound.get(key);
    bound.delete(key);
    return manifest;
  };
}
