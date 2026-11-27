const normalizeDshContextEvent = (event:any) => ({seq:event.seq,kind:event.kind,
  ...Object.fromEntries(['time','tokens','grossTokens','count','turn','step','fromTurn','fromStep'].filter(k=>typeof event[k]==='number'&&Number.isFinite(event[k])&&event[k]>=0).map(k=>[k,event[k]])),
  ...Object.fromEntries(['from','to','name','form','sub'].filter(k=>typeof event[k]==='string').map(k=>[k,event[k].slice(0,160)]))});

export function validateDshDetails(value: any, source: string, seq: number, turn: number, step: number): any {
  if(value?.status!=='available') return {status:'request-view-unavailable'};
  if(value.schemaVersion!==1||value.source!=='dsh-context-existing-projection'||value.representation!=='approximate-projected-preview'
    ||value.sourceSessionId!==source||value.response?.sourceSessionId!==source||value.response?.eventSequence!==seq
    ||value.response?.turn!==turn||value.response?.step!==step||!Array.isArray(value.items)||value.items.length>256) return;
  const categories=['user','runtime-context','skill-injection','assistant','tool'];
  const items=value.items.filter((n:any)=>n&&/^(request|archive):\d+:\d+$/.test(n.itemId)&&['request','archive'].includes(n.group)
    &&categories.includes(n.category)&&Number.isSafeInteger(n.sourceEventSeq)&&n.sourceEventSeq>=0&&n.sourceEventSeq<seq).map((n:any)=>({
      itemId:n.itemId,group:n.group,category:n.category,sourceEventSeq:n.sourceEventSeq,
      ...(Number.isSafeInteger(n.gone)&&n.gone>n.sourceEventSeq?{gone:n.gone}:{}),
      ...(typeof n.estimatedTokens==='number'&&Number.isFinite(n.estimatedTokens)&&n.estimatedTokens>=0?{estimatedTokens:n.estimatedTokens}:{}),
      ...Object.fromEntries(['name','tool','form'].filter(k=>typeof n[k]==='string').map(k=>[k,n[k].slice(0,160)])),
      bodyStatus:typeof n.bodyStatus==='string'?n.bodyStatus.slice(0,64):'source-body-unavailable',
    }));
  if(items.length!==value.items.length||new Set(items.map((n:any)=>n.itemId)).size!==items.length)return;
  const number=(n:any)=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
  return {status:'available',schemaVersion:1,source:value.source,representation:value.representation,sourceSessionId:source,
    response:{sourceSessionId:source,eventSequence:seq,turn,step},items,sourcePreviewMaxChars:80,fullRequestBodyAvailable:false,
    archiveLimited:value.archiveLimited===true,nodesLimited:value.nodesLimited===true,
    ...(typeof value.bodyRef==='string'&&/^[a-f0-9-]{36}$/i.test(value.bodyRef)?{bodyRef:value.bodyRef}:{}),
    expiresAt:typeof value.expiresAt==='string'?value.expiresAt:null,
    bodyStorageStatus:typeof value.bodyStorageStatus==='string'?value.bodyStorageStatus.slice(0,64):'not-uploaded',
    header:{seq:number(value.header?.seq),systemTokens:number(value.header?.systemTokens),
      tools:Array.isArray(value.header?.tools)?value.header.tools.slice(0,128).filter((t:any)=>typeof t?.name==='string').map((t:any)=>({name:t.name.slice(0,160),estimatedTokens:number(t.estimatedTokens),...(typeof t.plugin==='string'?{plugin:t.plugin.slice(0,160)}:{})})):[]}};
}

/** Membership is supplied by the request capture, never inferred from timestamp proximity. */
export function validateDshContext(value: any, source: string, seq: number, turn: number, step: number): Record<string, any> | undefined {
  if (!value || typeof value !== 'object') return;
  if (value.status !== 'available') {
    if (['source-busy','not-enabled','missing-requests','unmatched-request','incomplete-categories','unsupported-version','not-installed','connection-unavailable','timeout','source-unavailable'].includes(value.status))
      return {status:value.status,version:typeof value.version === 'string' ? value.version.slice(0,64) : null};
    return;
  }
  const fields = ['system','tools','user','inject','skill','assistant','tool'];
  const numeric = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (value.schemaVersion !== 1 || value.version !== '0.85.1' || value.source !== 'dsh-context'
    || value.sourceSessionId !== source || value.responseEventSequence !== seq || value.turn !== turn || value.step !== step
    || value.approximate !== true || !numeric(value.total) || fields.some(k=>!numeric(value.categories?.[k]))) return;
  const counts = (v: any) => Object.fromEntries(fields.filter(k=>numeric(v?.[k])).map(k=>[k,v[k]]));
  const result: Record<string,any> = {schemaVersion:1,status:'available',source:'dsh-context',version:value.version,
    sourceSessionId:source,responseEventSequence:seq,turn,step,approximate:true,basis:'dsh-context-session-projection',
    total:value.total,categories:counts(value.categories),revision:numeric(value.revision)?value.revision:null,
    asOfSeq:Number.isSafeInteger(value.asOfSeq)?value.asOfSeq:null,eventsLimited:value.eventsLimited===true,
    events:Array.isArray(value.events)?value.events.filter((e:any)=>Number.isSafeInteger(e?.seq)&&e.seq>=0&&e.seq<=seq
      &&['compaction','prune','model','inject','mode'].includes(e.kind)).slice(-256).map(normalizeDshContextEvent).filter(Boolean):[],
    delta:{status:'unavailable'}};
  const d=value.delta;
  if (d?.status === 'no-previous-request') result.delta = {status:'no-previous-request'};
  if (d?.status==='available' && Number.isSafeInteger(d.baseSeq) && d.baseSeq>=0 && d.baseSeq<seq
    && ['addedCounts','removedCounts','tokenUp','tokenDown'].every(k=>fields.every(f=>numeric(d[k]?.[f]))))
    result.delta={status:'available',baseSeq:d.baseSeq,addedCounts:counts(d.addedCounts),removedCounts:counts(d.removedCounts),tokenUp:counts(d.tokenUp),tokenDown:counts(d.tokenDown),basis:'dsh-context-projected-nodes'};
  if(value.details) result.details=validateDshDetails(value.details,source,seq,turn,step);
  return result;
}

export function dshContextTokens(request: any): Record<string,number> | null {
  const d=validateDshContext(request.dshContext,request.sourceSessionId,request.eventSequence,request.turn,request.step);
  if (d?.status !== 'available') return null;
  const map: Record<string,string>={system:'system',tools:'tool-definition',user:'user',inject:'runtime-context',skill:'skill-injection',assistant:'assistant',tool:'tool'};
  return Object.fromEntries(Object.entries(map).map(([source,category])=>[category,d.categories[source]]));
}

export interface HarnessContextItem {
  id: string;
  category: string;
  fingerprint?: string;
}

export interface HarnessRequestMembership {
  complete: boolean;
  items: readonly HarnessContextItem[];
}

export function summarizeHarnessContext(manifest: any) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.items)
    || manifest.items.some((item: any) => !item || typeof item !== 'object')) return null;
  const categories: Record<string, { members: number; bytes: number; estimatedTokens: number | null }> = {};
  for (const item of manifest.items) {
    const category = typeof item.category === 'string' ? item.category : 'unknown';
    const bucket = categories[category] ??= { members: 0, bytes: 0, estimatedTokens: null };
    bucket.members++;
    if (Number.isFinite(item.originalBytes) && item.originalBytes >= 0) bucket.bytes += item.originalBytes;
  }
  const estimate = manifest.tokenEstimate;
  for (const [category, bucket] of Object.entries(categories)) {
    const tokens = estimate?.categories?.[category];
    if (estimate?.approximate === true && Number.isFinite(tokens) && tokens >= 0) bucket.estimatedTokens = tokens;
  }
  return { categories, estimationMethod: estimate?.method ?? null,
    totalBytes: Object.values(categories).reduce((sum, bucket) => sum + bucket.bytes, 0),
    totalEstimatedTokens: Object.values(categories).every(bucket => bucket.estimatedTokens !== null)
      ? Object.values(categories).reduce((sum, bucket) => sum + bucket.estimatedTokens!, 0) : null };
}

export function harnessDiffLimitation(diff: any, zh = true): string {
  if (!diff) return zh ? '首个请求或前次成员记录缺失，无法精确比较。' : 'First request or missing previous membership; exact comparison unavailable.';
  if (diff.status === 'ambiguous') return zh ? '成员标识重复，无法确定条目归属；不展示精确增删数量。' : 'Duplicate member identities; exact additions and removals unavailable.';
  if (diff.status === 'incomparable') return zh ? '会话不同、记录格式不兼容或请求未绑定，无法比较。' : 'Different sessions, incompatible records or unbound requests cannot be compared.';
  if (diff.status === 'partial') return zh ? '成员覆盖不完整；问号表示未知，不能视为零变化。' : 'Incomplete membership; question marks mean unknown, not zero changes.';
  return zh ? '比较采集边界的成员与脱敏指纹；不代表服务商最终请求报文或逐行正文差异。' : 'Compares captured members and redacted fingerprints, not provider wire payloads or line-by-line text.';
}

export function capturedHarnessMembership(value: any): HarnessRequestMembership | null {
  if (value?.schemaVersion !== 1 || value.bindingStatus !== 'bound' || !Array.isArray(value.items)) return null;
  if (value.items.some((item: any) => typeof item.itemId !== 'string'
    || typeof item.category !== 'string' || typeof item.contentFingerprint !== 'string')) return null;
  return {
    complete: value.membershipCoverage === 'complete-at-capture-boundary' && value.identityCoverage === 'stable',
    items: value.items.map((item: any) => ({ id: item.itemId, category: item.category, fingerprint: item.contentFingerprint })),
  };
}

export function diffCapturedHarnessRequests(previous: any, current: any) {
  if (!previous?.sourceSessionId || previous.sourceSessionId !== current?.sourceSessionId) return { status: 'incomparable' as const };
  const before = capturedHarnessMembership(previous);
  const after = capturedHarnessMembership(current);
  if (!before || !after) return { status: 'incomparable' as const };
  const difference = diffHarnessRequestMembership(before, after);
  return { ...difference, previousEventSequence: previous.response?.eventSequence,
    sourceSessionId: previous.sourceSessionId,
    contentChanges: 'changed' in difference ? (difference.changed ?? []).map(item => ({ id: item.id,
      before: before.items.find(prior => prior.id === item.id)?.fingerprint, after: item.fingerprint })) : [] };
}

export function diffHarnessRequestMembership(
  previous: HarnessRequestMembership,
  current: HarnessRequestMembership,
) {
  const before = new Map(previous.items.map(item => [item.id, item]));
  const after = new Map(current.items.map(item => [item.id, item]));
  if (before.size !== previous.items.length || after.size !== current.items.length) {
    return { status: 'ambiguous' as const };
  }
  return {
    status: previous.complete && current.complete ? 'complete' as const : 'partial' as const,
    added: previous.complete ? current.items.filter(item => !before.has(item.id)) : null,
    removed: current.complete ? previous.items.filter(item => !after.has(item.id)) : null,
    changed: current.items.filter(item => {
      const prior = before.get(item.id);
      return prior?.fingerprint !== undefined && item.fingerprint !== undefined
        && (prior.fingerprint !== item.fingerprint || prior.category !== item.category);
    }),
    unknownChanges: current.items.filter(item => {
      const prior = before.get(item.id);
      return prior !== undefined && (prior.fingerprint === undefined || item.fingerprint === undefined);
    }).length,
  };
}
