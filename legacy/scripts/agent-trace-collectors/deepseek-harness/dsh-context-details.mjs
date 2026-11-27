import { createHash } from 'node:crypto';

const seq = value => Number.isSafeInteger(value) && value >= 0;
export function normalizeDshContextEvent(event) {
  if (!seq(event?.seq) || !['compaction','prune','model','inject','mode'].includes(event.kind)) return null;
  return { seq:event.seq, kind:event.kind,
    ...Object.fromEntries(['time','tokens','grossTokens','count','turn','step','fromTurn','fromStep'].filter(k=>typeof event[k]==='number'&&Number.isFinite(event[k])&&event[k]>=0).map(k=>[k,event[k]])),
    ...Object.fromEntries(['from','to','name','form','sub'].filter(k=>typeof event[k]==='string').map(k=>[k,event[k].slice(0,160)])) };
}

export function normalizeExistingContextDetails(sessionId, event, revision, current, nodesEnvelope, now = Date.now()) {
  if (current?.ok !== true || !Array.isArray(current.value?.viewNodes)) return { status:'request-view-unavailable' };
  const window=nodesEnvelope?.ok===true ? nodesEnvelope.value?.parts?.nodes : undefined;
  const rows=[...current.value.viewNodes.map(n=>({...n,group:'request'})),...(Array.isArray(window?.archive)?window.archive.map(n=>({...n,group:'archive'})):[])];
  const categories={user:'user',inject:'runtime-context',skill:'skill-injection',assistant:'assistant',tool:'tool'};
  const items=rows.filter(n=>seq(n?.seq)&&categories[n.cat]&&n.seq<event.seq).slice(0,256).map((n,index)=>({
    itemId:`${n.group}:${n.seq}:${index}`,group:n.group,category:categories[n.cat],sourceEventSeq:n.seq,
    ...(seq(n.gone)?{gone:n.gone}:{}),...(typeof n.tokens==='number'&&Number.isFinite(n.tokens)&&n.tokens>=0?{estimatedTokens:n.tokens}:{}),
    ...Object.fromEntries(['name','tool','form'].filter(k=>typeof n[k]==='string').map(k=>[k,n[k].slice(0,160)])),
    bodyStatus:typeof n.text==='string'?'source-preview':'source-body-unavailable',
    ...(typeof n.text==='string'?{text:n.text.slice(0,80)}:{}),
  }));
  const digest=createHash('sha256').update(JSON.stringify([sessionId,event.seq,revision,'dsh-existing-preview-v1'])).digest('hex');
  const attemptId=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
  return {status:'available',schemaVersion:1,source:'dsh-context-existing-projection',representation:'approximate-projected-preview',
    sourceSessionId:sessionId,response:{sourceSessionId:sessionId,eventSequence:event.seq,turn:event.data.turn,step:event.data.step},
    attemptId,exportedAt:new Date(now).toISOString(),expiresAt:new Date(now+7*86400000).toISOString(),items,
    nodesLimited:rows.length>256,archiveLimited:!window||window.archiveFloor!==undefined||window.droppedNodes>0,
    sourcePreviewMaxChars:80,fullRequestBodyAvailable:false,
    header: {seq:seq(current.value.viewHeader?.seq)?current.value.viewHeader.seq:null,
      systemTokens:typeof current.value.viewSystem?.tokens==='number'?current.value.viewSystem.tokens:null,
      tools:(Array.isArray(current.value.viewHeader?.tools)?current.value.viewHeader.tools:[]).slice(0,128).filter(t=>typeof t?.name==='string').map(t=>({name:t.name.slice(0,160),...(typeof t.tokens==='number'?{estimatedTokens:t.tokens}:{}),...(typeof t.plugin==='string'?{plugin:t.plugin.slice(0,160)}:{})}))},
  };
}

const nativeBodyId = (session, sequence, kind) => {
  const hex = createHash('sha256').update(JSON.stringify(['native-context-v1',session,sequence,kind])).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
};

export function splitNativeContextBody(type, body, session, sequence, timestamp) {
  body = body && typeof body === 'object' ? body : {};
  const summary = type === 'compaction/summary';
  const checkpoint = type === 'user/message' && body?.source?.kind === 'compact-checkpoint';
  if (!summary && !checkpoint) return null;
  const clean = {...body};
  delete clean.contextBody;
  const content = summary ? body.summary : body.content;
  if (summary) { delete clean.summary; delete clean.rawOutput; delete clean.llmStreamCall; }
  else delete clean.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : null;
  const kind = summary ? 'compaction-summary' : 'checkpoint';
  const compactionId = summary ? body.compactionId : body.source.compactionId;
  const expires = Number(timestamp) + 7 * 86400000;
  const meta = {schemaVersion:1, source:'harness-native',sourceSessionId:session,sourceEventSeq:sequence,kind,
    ...(typeof compactionId === 'string' ? {compactionId:compactionId.slice(0,160)} : {}),
    attemptId:nativeBodyId(session,sequence,kind),expiresAt:Number.isFinite(expires)?new Date(expires).toISOString():null};
  return {body:clean,attachment:typeof text === 'string'?{...meta,items:[{itemId:kind,sourceEventSeq:sequence,text,bodyStatus:/\[truncated chars=/.test(text)?'truncated':'available'}]}:null};
}
