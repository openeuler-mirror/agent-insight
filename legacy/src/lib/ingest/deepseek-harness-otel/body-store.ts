import { splitNativeContextBody } from '../../../../scripts/agent-trace-collectors/deepseek-harness/dsh-context-details.mjs';
import { acquireProcessLock } from '../../../../scripts/agent-trace-collectors/deepseek-harness/process-lock.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getExistingInsightDir } from '@/lib/agent-insight-paths';
import { validateDshContext, validateDshDetails } from './context-membership';
import { redactAgentTrajectoryPromptValue } from '@/lib/engine/evaluation/agent-trajectory-facts';

const UUID = /^[a-f0-9-]{36}$/i;
const TTL = 7 * 86400000;
const sessionKey = (owner: string, session: string) => createHash('sha256').update(JSON.stringify([owner, session])).digest('hex');
const temporaryFile = (file: string) => /^[a-f0-9-]{36}\.tmp$/i.test(file);
export const harnessBodyDirectory = () => process.env.AGENT_INSIGHT_HARNESS_BODY_DIR || path.join(getExistingInsightDir(), 'harness-context-bodies');

function files(directory: string) {
  return existsSync(directory) ? readdirSync(directory).filter(file => /^\d{13}-[a-f0-9]{64}-[a-f0-9-]{36}\.json$/i.test(file)) : [];
}

export function saveHarnessBody(owner: string, manifest: any, directory = harnessBodyDirectory(), now = Date.now()) {
  if (!owner || !UUID.test(manifest.attemptId) || typeof manifest.sourceSessionId !== 'string'
    || !Array.isArray(manifest.items) || manifest.items.length > 4096) throw new Error('Invalid context body manifest');
  let textBytes = 0;
  for (const item of manifest.items) {
    if (item.text === undefined) continue;
    if (typeof item.text !== 'string' || Buffer.byteLength(item.text) > 8192) throw new Error('Context item body exceeds limit');
    textBytes += Buffer.byteLength(item.text);
  }
  if (textBytes > 262144) throw new Error('Context request body exceeds limit');
  const expires = Math.min(Date.parse(manifest.expiresAt), now + TTL);
  if (!Number.isFinite(expires) || expires <= now) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = sessionKey(owner, manifest.sourceSessionId);
  const suffix = `-${key}-${manifest.attemptId}.json`;
  const lock = path.join(directory, '.write.lock');
  const release = acquireProcessLock(lock);
  if (!release) throw Object.assign(new Error('Context body storage busy'), { code: 'EEXIST' });
  let temporary: string | undefined;
  try {
    const all = files(directory);
    const existing = all.find(file => file.endsWith(suffix));
    if (existing) {
      const prior = JSON.parse(readFileSync(path.join(directory, existing), 'utf8'));
      if (JSON.stringify([prior.items, prior.response]) !== JSON.stringify([manifest.items, manifest.response])) throw new Error('Conflicting context attempt');
      return manifest.attemptId;
    }
    const serialized = JSON.stringify({ ...manifest, expiresAt: new Date(expires).toISOString() });
    const bytes = Buffer.byteLength(serialized);
    let total = 0, session = 0;
    for (const file of [...all, ...readdirSync(directory).filter(temporaryFile)]) {
      try {
        const size = statSync(path.join(directory, file)).size;
        total += size;
        if (file.includes(`-${key}-`)) session += size;
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    if (session + bytes > 1048576 || total + bytes > 268435456
      || all.length + readdirSync(directory).filter(temporaryFile).length >= 4096) throw new Error('Context body quota reached');
    temporary = path.join(directory, randomUUID() + '.tmp');
    writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path.join(directory, expires + suffix));
    return manifest.attemptId;
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    release();
  }
}

export function readHarnessBody(owner: string, session: string, attempt: string, directory = harnessBodyDirectory(), now = Date.now()) {
  if (!UUID.test(attempt)) return null;
  const suffix = `-${sessionKey(owner, session)}-${attempt}.json`;
  const file = files(directory).find(name => name.endsWith(suffix));
  if (!file || Number(file.slice(0, 13)) <= now) return null;
  try { return JSON.parse(readFileSync(path.join(directory, file), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

export function* cleanupHarnessBodies(directory = harnessBodyDirectory(), now = Date.now(), dryRun = false) {
  const temporary = existsSync(directory) ? readdirSync(directory).filter(temporaryFile) : [];
  for (const file of [...files(directory), ...temporary]) {
    let bytes = 0;
    try {
      const info = statSync(path.join(directory, file));
      if (temporaryFile(file) ? info.mtimeMs + TTL > now : Number(file.slice(0, 13)) > now) continue;
      bytes = info.size;
      if (!dryRun) unlinkSync(path.join(directory, file));
    }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    yield { kind: dryRun ? 'skipped' as const : 'deleted' as const, bytes: dryRun ? 0 : bytes, reason: dryRun ? 'harness-body-expired-dry-run' : 'harness-body-expired-removed' };
  }
}

export function separateHarnessBodies(events: any[], directory = harnessBodyDirectory()) {
  for (const event of events) {
    const native = splitNativeContextBody(event.eventType,event.body,event.sourceSessionId,event.sequence,Date.parse(event.eventTimestamp));
    if (native) {
      const supplied = event.body.contextBody ?? native.attachment;
      let meta:any = {source:'harness-native',sourceSessionId:event.sourceSessionId,sourceEventSeq:event.sequence,
        kind:event.eventType==='compaction/summary'?'compaction-summary':'checkpoint',bodyStorageStatus:'not-collected'};
      if (Number.isSafeInteger(event.sequence) && supplied?.schemaVersion===1 && supplied.source==='harness-native'
        && supplied.sourceSessionId===event.sourceSessionId && supplied.sourceEventSeq===event.sequence
        && supplied.kind===meta.kind && Number.isFinite(Date.parse(supplied.expiresAt)) && Number.isFinite(Date.parse(event.eventTimestamp)) && UUID.test(supplied.attemptId) && Array.isArray(supplied.items) && supplied.items.length===1
        && supplied.items[0]?.itemId===meta.kind && typeof supplied.items[0]?.text==='string') {
        const redacted=String(redactAgentTrajectoryPromptValue(supplied.items[0].text));
        const chars=Array.from(redacted);let text='',bytes=0;
        for(const char of chars){const size=Buffer.byteLength(char);if(bytes+size>8192)break;text+=char;bytes+=size;}
        const truncated=text!==redacted || supplied.items[0].bodyStatus==='truncated';
        const expiresAt=new Date(Math.min(Date.parse(supplied.expiresAt),Date.parse(event.eventTimestamp)+TTL)).toISOString();
        const item={itemId:meta.kind,sourceEventSeq:event.sequence,text,bodyStatus:truncated?'truncated':'available'};
        meta={...meta,...(native.body.compactionId||native.body.source?.compactionId?{compactionId:native.body.compactionId??native.body.source.compactionId}:{}),expiresAt,truncated};
        try {
          const bodyRef=saveHarnessBody(event.user,{schemaVersion:1,sourceSessionId:event.sourceSessionId,attemptId:supplied.attemptId,
            response:{sourceSessionId:event.sourceSessionId,eventSequence:event.sequence},expiresAt,items:[item]},directory);
          meta={...meta,bodyRef,bodyStorageStatus:bodyRef?'stored':'expired'};
        } catch(error:any) {meta.bodyStorageStatus=error.code==='EEXIST'?'busy':/quota|limit/.test(error.message)?'quota-rejected':'storage-error';}
      }
      event.body={...native.body,contextBody:meta};
    }
    const projection=event.body?.dshContext;
    if(projection?.details) {
      const raw=projection.details;
      const valid=validateDshContext(projection,event.sourceSessionId,event.body.responseEventSequence,event.body.turn,event.body.step);
      const detail=valid?.details;
      if(detail?.status==='available'&&event.eventType==='agent-insight/context'&&event.sequence===undefined) {
        let bodyRef:string|null=null,status='not-uploaded';
        const items=detail.items.map((item:any)=>{
          const source=raw.items.find((n:any)=>n.itemId===item.itemId);
          return {...item,...(typeof source?.text==='string'?{text:String(redactAgentTrajectoryPromptValue(source.text.slice(0,80)))}:{})};
        });
        if(items.some((n:any)=>typeof n.text==='string'))try {
          bodyRef=saveHarnessBody(event.user,{...detail,attemptId:raw.attemptId,items,expiresAt:raw.expiresAt},directory);
          status=bodyRef?'stored':'expired';
        }catch(error:any){status=error.code==='EEXIST'?'busy':/quota|limit/.test(error.message)?'quota-rejected':'storage-error';}
        event.body={...event.body,dshContext:{...projection,details:{...detail,bodyRef,bodyStorageStatus:status}}};
      } else event.body={...event.body,dshContext:{...projection,details:{status:'incompatible-or-unbound'}}};
    }
    const manifest = event.body?.contextMembership;
    if (!manifest) continue;
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.items)
      || manifest.items.some((item: any) => !item || typeof item !== 'object')) {
      event.body = { ...event.body, contextMembership: { schemaVersion: manifest.schemaVersion,
        bindingStatus: 'unavailable', bodyStorageStatus: 'incompatible-schema', items: [] } };
      continue;
    }
    const suppliedText = manifest.items.some((item: any) => typeof item.text === 'string');
    let bodyRef: string | null = null;
    let bodyStorageStatus = manifest.bodyCaptureStatus === 'quota-omitted' ? 'quota-omitted' : 'not-uploaded';
    if (suppliedText && manifest.bindingStatus === 'bound'
      && manifest.sourceSessionId === event.sourceSessionId
      && manifest.response?.sourceSessionId === event.sourceSessionId
      && manifest.response?.eventSequence === event.sequence) {
      try {
        bodyRef = saveHarnessBody(event.user, manifest, directory);
        bodyStorageStatus = bodyRef ? 'stored' : 'expired';
      } catch (error: any) {
        bodyStorageStatus = error.code === 'EEXIST' ? 'busy' : /quota|limit/.test(error.message) ? 'quota-rejected' : 'storage-error';
        console.warn('[Harness context] optional body admission failed', { status: bodyStorageStatus });
      }
    }
    event.body = { ...event.body, contextMembership: { ...manifest, bodyRef, bodyStorageStatus,
      items: manifest.items.map(({ text, ...item }: any) => ({ ...item,
        bodyStatus: bodyRef ? item.bodyStatus : bodyStorageStatus, storedBytes: bodyRef ? item.storedBytes : 0 })) } };
  }
}
