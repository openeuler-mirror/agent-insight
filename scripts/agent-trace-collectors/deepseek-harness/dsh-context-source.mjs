import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeDshContextEvent, normalizeExistingContextDetails } from './dsh-context-details.mjs';

const fields = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'];
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const counts = value => Object.fromEntries(fields.filter(key => numeric(value?.[key])).map(key => [key, value[key]]));
const sequence = value => Number.isSafeInteger(value) && value >= 0;

export function dshContextProfile(argv = process.argv) {
  const explicit = argv.indexOf('--profile');
  const inline = argv.slice(2).find(value => value.startsWith('--profile='));
  const profile = explicit >= 2 ? argv[explicit + 1] : inline ? inline.slice(10)
    : ['headless', 'web'].includes(argv[2]) ? argv[2] : null;
  return typeof profile === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(profile) ? profile : null;
}

export function normalizeContextFacts(envelope, sessionId, event, baseSeq, delta) {
  const value = envelope?.ok === true ? envelope.value : null;
  const rows = value?.parts?.requests;
  if (!Array.isArray(rows)) return { status: 'missing-requests' };
  const matching = rows.filter(row => row?.seq === event.seq);
  if (matching.length !== 1 || matching[0].turn !== event.data.turn || matching[0].step !== event.data.step)
    return { status: 'unmatched-request' };
  const row = matching[0];
  if (!numeric(row.total) || fields.some(key => !numeric(row[key]))) return { status: 'incomplete-categories' };
  const events = Array.isArray(value.parts.events) ? value.parts.events : [];
  const result = {
    schemaVersion: 1, status: 'available', source: 'dsh-context', version: '0.85.1',
    sourceSessionId: sessionId, responseEventSequence: event.seq, turn: row.turn, step: row.step,
    revision: numeric(value.rev) ? value.rev : null, asOfSeq: sequence(value.asOfSeq) ? value.asOfSeq : null,
    approximate: true, basis: 'dsh-context-session-projection', total: row.total, categories: counts(row),
    events: events.filter(e => sequence(e?.seq) && e.seq <= row.seq
      && ['compaction', 'prune', 'model', 'inject', 'mode'].includes(e.kind)).slice(-256)
      .map(normalizeDshContextEvent).filter(Boolean),
    eventsLimited: value.missing?.includes('events') === true || events.length >= 256,
    delta: { status: baseSeq === undefined ? 'no-previous-request' : 'unavailable' },
  };
  if (sequence(baseSeq) && delta?.ok === true && delta.value && typeof delta.value === 'object') {
    const d = delta.value;
    if ([d.counts,d.removedCounts,d.tokenUp,d.tokenDown].every(v => v && fields.every(k => numeric(v[k]))))
      result.delta = { status: 'available', baseSeq, addedCounts: counts(d.counts), removedCounts: counts(d.removedCounts),
        tokenUp: counts(d.tokenUp), tokenDown: counts(d.tokenDown), basis: 'dsh-context-projected-nodes',
        limitation: 'Projected node counts and token deltas; not captured request membership or body diff.' };
  }
  return result;
}

export function createDshContextSource(ctx, options = {}) {
  let carrier, connection, version;
  let inFlight;
  const pendingReads = new Set();
  try {
    const root = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    const activeProfile = dshContextProfile();
    for (const profile of activeProfile ? [activeProfile] : []) {
      try {
        const resolve = createRequire(path.join(root, 'profiles', profile, 'package.json'));
        version = JSON.parse(readFileSync(resolve.resolve('dsh-context/package.json'), 'utf8')).version;
        break;
      } catch {}
    }
  } catch {}
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], c => {
    connection = c.get('connection');
    if (typeof connection?.createSharedFetchHandler !== 'function' || typeof connection?.createPeer !== 'function') return;
    carrier = connection.createSharedFetchHandler('/api');
    return () => { carrier = undefined; connection = undefined; inFlight?.abort(); };
  });
  return async (session, event, baseSeq) => {
    if (options.version) version = options.version;
    if (version !== '0.85.1') return { status: version ? 'unsupported-version' : 'not-installed', version:version ?? null };
    if (!carrier) return { status:'connection-unavailable', version };
    if (inFlight || pendingReads.size >= 2) return {status:'source-busy',version};
    const controller = new AbortController();
    const activeCarrier = carrier;
    const peer = connection.createPeer({ principal: { kind:'owner' }, interactions:'none' });
    inFlight = controller;
    const invoke = async (endpoint, body) => {
      controller.signal.throwIfAborted();
      const work = (async () => {
        const response = await activeCarrier.fetch(new Request('http://localhost/api/dsh-context/' + endpoint, {
          method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:controller.signal,
        }), peer);
        controller.signal.throwIfAborted();
        return response.ok ? response.json() : null;
      })();
      pendingReads.add(work);
      try { return await work; } finally { pendingReads.delete(work); }
    };
    let timer;
    try {
      return await Promise.race([(async()=>{
        // Let the native event fold settle; never hold the model request path.
        await new Promise(resolve => setImmediate(resolve));
        const facts = await invoke('facts', {sessionId:session.id, parts:['requests','events'], window:{requestsTail:256,eventsTail:256}});
        if (facts?.ok !== true || !Array.isArray(facts.value?.parts?.requests)) return {status:'missing-requests'};
        const prior = Array.isArray(facts?.value?.parts?.requests) ? facts.value.parts.requests.filter(r=>sequence(r?.seq)&&r.seq<event.seq).sort((a,b)=>b.seq-a.seq)[0]?.seq : undefined;
        const effectiveBase = sequence(baseSeq) ? baseSeq : prior;
        const delta = sequence(effectiveBase) ? await invoke('delta',{sessionId:session.id,seq:event.seq,baseSeq:effectiveBase}) : null;
        const current = await invoke('delta',{sessionId:session.id,seq:event.seq,baseSeq:null});
        const nodes = await invoke('facts',{sessionId:session.id,parts:['nodes'],window:{nodesTail:256}});
        const result=normalizeContextFacts(facts,session.id,event,effectiveBase,delta);
        if(result.status==='available') result.details=normalizeExistingContextDetails(session.id,event,result.revision,current,nodes);
        return result;
      })(),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:'timeout',version});},options.timeoutMs ?? 1500);})]);
    } catch { return {status:'source-unavailable',version}; }
    finally {
      clearTimeout(timer);
      controller.abort();
      if (inFlight === controller) inFlight = undefined;
      try { Promise.resolve(peer.dispose()).catch(() => {}); } catch {}
    }
  };
}
