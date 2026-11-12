import datetime
import hashlib
import json
import re
import uuid
from pathlib import Path

from .clickhouse import ClickHouseStore
from .contracts import canonical_json, content_hash, identifier, revision
from .control import Conflict, StorageError
from .iam import IAMStore, Forbidden
from .projects import resolve_project


EVENT_TYPE = 'observability.otlp.accepted.v1'
MAX_PACKET_BYTES = 4 * 1024 * 1024
MAX_SPANS = 4096
MAX_NORMALIZED_BYTES = 64 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53-1


class IngestConflict(Conflict):
    pass


class _RouteRetired(IngestConflict):
    pass


class _LeaseLost(StorageError):
    pass


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _integer(value, minimum=0, maximum=2**64-1):
    if isinstance(value,str) and re.fullmatch(r'-?[0-9]+',value): value=int(value)
    if type(value) is not int or not minimum<=value<=maximum: raise ValueError('invalid OTLP integer')
    return value


def _value(value):
    if not isinstance(value,dict) or len(value)!=1: raise ValueError('invalid OTLP attribute value')
    kind,item=next(iter(value.items()))
    if kind=='stringValue' and isinstance(item,str): return item
    if kind=='boolValue' and type(item) is bool: return item
    if kind=='intValue': return _integer(item,-(2**63),2**63-1)
    if kind=='doubleValue' and type(item) in (float,int): return item
    if kind=='bytesValue' and isinstance(item,str): return item
    if kind=='arrayValue' and isinstance(item,dict) and isinstance(item.get('values',[]),list): return [_value(v) for v in item.get('values',[])]
    if kind=='kvlistValue' and isinstance(item,dict): return _attributes(item.get('values',[]))
    raise ValueError('invalid OTLP attribute value')


def _attributes(attributes):
    if not isinstance(attributes,list) or len(attributes)>4096: raise ValueError('invalid OTLP attributes')
    result={}
    for attribute in attributes:
        if not isinstance(attribute,dict) or not isinstance(attribute.get('key'),str) or not attribute['key']: raise ValueError('invalid OTLP attribute key')
        key=attribute['key']
        if key in result: raise ValueError('duplicate OTLP attribute key')
        result[key]=_value(attribute.get('value'))
    return result


def _text(value, limit=512):
    if not isinstance(value,str) or len(value)>limit: raise ValueError('invalid OTLP text')
    value.encode('utf-8')
    return value


def _hex(value,length,*,optional=False):
    if optional and value in (None,''): return ''
    if not isinstance(value,str) or not re.fullmatch('[0-9a-fA-F]{'+str(length)+'}',value) or int(value,16)==0: raise ValueError('invalid OTLP identifier')
    return value.lower()


def _payload_revision(sections):
    metadata={}
    for name,text in sections.items():
        data=text.encode('utf-8');chunks=list(ClickHouseStore._chunks(data))
        metadata[name]={'content_hash':hashlib.sha256(data).hexdigest(),'uncompressed_bytes':len(data),
                        'chunk_count':len(chunks),'chunk_hashes':[hashlib.sha256(c).hexdigest() for c in chunks]}
    return content_hash({'schema_version':1,'sections':metadata})


def _normalize(body, workspace_id):
    if not isinstance(body,dict) or not isinstance(body.get('resourceSpans'),list): raise ValueError('resourceSpans required')
    result=[];seen=set();normalized_bytes=0
    for resource_span in body['resourceSpans']:
        if not isinstance(resource_span,dict): raise ValueError('invalid resource span')
        resource=resource_span.get('resource',{})
        if not isinstance(resource,dict): raise ValueError('invalid resource')
        resource_attrs=_attributes(resource.get('attributes',[]))
        source=resource_attrs.get('agent_insight.source_namespace','otlp')
        identifier(source)
        agent=_text(resource_attrs.get('agent.name',resource_attrs.get('service.name','')))
        framework=_text(resource_attrs.get('telemetry.sdk.name',''))
        scopes=resource_span.get('scopeSpans',[])
        if not isinstance(scopes,list): raise ValueError('invalid scope spans')
        for scope in scopes:
            if not isinstance(scope,dict) or not isinstance(scope.get('spans',[]),list): raise ValueError('invalid scope')
            for span in scope.get('spans',[]):
                if not isinstance(span,dict): raise ValueError('invalid span')
                native_trace=_hex(span.get('traceId'),32);native_span=_hex(span.get('spanId'),16)
                trace_id=str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json([workspace_id,source,native_trace,1])))
                identity=(trace_id,native_span)
                if identity in seen: raise ValueError('duplicate span in packet')
                seen.add(identity)
                attrs=_attributes(span.get('attributes',[]))
                source_rev=revision(_integer(attrs.get('agent_insight.revision',1),1,2**63-1))
                start=_integer(span.get('startTimeUnixNano'),1)
                end=_integer(span.get('endTimeUnixNano'),start)
                start_ms=start//1000000;end_ms=end//1000000
                bucket_date=datetime.datetime.fromtimestamp(start_ms/1000,datetime.timezone.utc).date()
                epoch=datetime.date(1970,1,1)
                if not epoch<=bucket_date<=epoch+datetime.timedelta(days=65535): raise ValueError('Trace bucket exceeds ClickHouse Date range')
                bucket=bucket_date.isoformat()
                status=span.get('status',{})
                if not isinstance(status,dict): raise ValueError('invalid span status')
                code=status.get('code',0)
                if code not in (0,1,2,'STATUS_CODE_UNSET','STATUS_CODE_OK','STATUS_CODE_ERROR'): raise ValueError('invalid span status')
                state='failed' if code in (2,'STATUS_CODE_ERROR') else 'done'
                kind=span.get('kind',0)
                if kind not in (0,1,2,3,4,5,'SPAN_KIND_UNSPECIFIED','SPAN_KIND_INTERNAL','SPAN_KIND_SERVER','SPAN_KIND_CLIENT','SPAN_KIND_PRODUCER','SPAN_KIND_CONSUMER'): raise ValueError('invalid span kind')
                model=_text(attrs.get('gen_ai.response.model',attrs.get('gen_ai.request.model',attrs.get('llm.model_name',''))))
                tool=_text(attrs.get('gen_ai.tool.name',attrs.get('tool.name','')))
                normalized_kind='tool' if tool else ('llm' if model or any(k.startswith('gen_ai.') for k in attrs) else str(kind))
                def token(*keys):
                    for key in keys:
                        if key in attrs: return _integer(attrs[key],0,MAX_SAFE_INTEGER)
                    return None
                sections={'attributes':_json({'resource':resource_attrs,'span':attrs}), 'otlp_span':_json(span)}
                for name,keys in [('input',('gen_ai.input','gen_ai.input.messages','llm.input_messages','input.value')),('output',('gen_ai.output','gen_ai.output.messages','llm.output_messages','output.value'))]:
                    for key in keys:
                        if key in attrs:
                            sections[name]=attrs[key] if isinstance(attrs[key],str) else _json(attrs[key]);break
                row={'workspace_id':workspace_id,'trace_bucket':bucket,'trace_id':trace_id,'span_id':native_span,
                     'parent_span_id':_hex(span.get('parentSpanId'),16,optional=True),'source_namespace':source,'native_span_id':native_span,
                     'kind':normalized_kind,'name':_text(span.get('name',''),2048),'started_at_ms':start_ms,'ended_at_ms':end_ms,
                     'duration_us':(end-start)//1000,'model':model,'tool_name':tool,'execution_status':state,
                     'error_type':_text(attrs.get('error.type','')),'input_tokens':token('gen_ai.usage.input_tokens','llm.token_count.prompt'),
                     'output_tokens':token('gen_ai.usage.output_tokens','llm.token_count.completion'),
                     'payload_revision':_payload_revision(sections),'attributes_json':'{}','schema_version':1,'is_deleted':0}
                normalized_bytes+=sum(len(text.encode('utf-8')) for text in sections.values())+len(_json(row).encode('utf-8'))
                if normalized_bytes>MAX_NORMALIZED_BYTES: raise ValueError('normalized packet exceeds 64MiB; split shared resource attributes')
                source_snapshot={'row':row,'sections':sections,'source_revision':str(source_rev),'native_trace_id':native_trace,'agent_name':agent,'framework':framework}
                result.append(source_snapshot)
                if len(result)>MAX_SPANS: raise ValueError('packet exceeds 4096 spans')
    if not result: raise ValueError('packet has no spans')
    return result


class ObservationIngest:
    def __init__(self,control,facts):
        self.control=control;self.facts=facts;self.iam=IAMStore(control)

    def _load(self,ref):
        try:
            self.control._verify_artifact(Path(ref).name,ref)
        except Conflict:
            raise IngestConflict('durable observation artifact is missing or corrupt') from None
        value=json.loads(Path(ref).read_text(encoding='utf-8'))
        if isinstance(value,dict) and value.get('encoding')=='observation-json/v1':
            return json.loads(value['json'])
        return value

    def _persist(self,value):
        return self.control.persist_artifact({'encoding':'observation-json/v1','json':_json(value)})

    def accept(self,credential,workspace_id,body,receipt_key=None):
        identifier(workspace_id)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential);self.iam._workspace(scope,workspace_id,'write');resolve_project(con,workspace_id)
        if isinstance(body,(str,bytes,bytearray)):
            if len(body if not isinstance(body,str) else body.encode('utf-8'))>MAX_PACKET_BYTES: raise ValueError('packet exceeds 4MiB')
            try: body=json.loads(body,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
            except (UnicodeError,RecursionError) as exc: raise ValueError('invalid OTLP JSON') from exc
        try:
            raw=_json(body);data=raw.encode('utf-8')
            if len(data)>MAX_PACKET_BYTES: raise ValueError('packet exceeds 4MiB')
            spans=_normalize(body,workspace_id)
        except (TypeError,OverflowError,UnicodeError,RecursionError) as exc: raise ValueError('invalid bounded OTLP JSON') from exc
        packet_hash=hashlib.sha256(data).hexdigest()
        receipt_key=packet_hash if receipt_key is None else identifier(receipt_key)
        _,packet_ref=self.control.persist_artifact({'encoding':'otlp-json/v1','json':raw})
        now=self.control.clock();trace_ids=sorted({span['row']['trace_id'] for span in spans})
        with self.control.transaction() as con:
            scope=self.iam._scope(con,credential);self.iam._workspace(scope,workspace_id,'write');resolve_project(con,workspace_id)
            old=con.execute('SELECT * FROM ingest_batches WHERE workspace_id=? AND principal_id=? AND receipt_key=?',(workspace_id,scope.principal_id,receipt_key)).fetchone()
            if old:
                if old['packet_hash']!=packet_hash: raise Conflict('receipt key has different content')
                return {'batch_id':old['batch_id'],'state':old['state'],'trace_ids':json.loads(old['trace_ids_json']),'duplicate':True}
            for trace_id in trace_ids:
                span=next(s for s in spans if s['row']['trace_id']==trace_id);row=span['row']
                locator=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace_id,trace_id)).fetchone()
                if locator:
                    if locator['state']!='active': raise Forbidden('Trace is not active')
                    self.iam._authorize(con,credential,workspace_id,'write','trace',trace_id)
                else:
                    con.execute('INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)',
                        (workspace_id,trace_id,row['source_namespace'],span['native_trace_id'],row['trace_bucket'],now,now))
                    self.iam._record_resource(con,workspace_id,'trace',trace_id,scope.principal_id,'private',invalidate_policy=False)
            batch_id=str(uuid.uuid4());event_id=str(uuid.uuid4())
            con.execute('INSERT INTO ingest_batches(workspace_id,batch_id,principal_id,receipt_key,packet_hash,packet_ref,trace_ids_json,accepted_at_ms) VALUES(?,?,?,?,?,?,?,?)',
                (workspace_id,batch_id,scope.principal_id,receipt_key,packet_hash,packet_ref,canonical_json(trace_ids),now))
            # The shared writer lock makes this durable queue order stable even when clock values tie or regress.
            previous=con.execute('SELECT MAX(created_at_ms) FROM outbox_events WHERE event_type=?',(EVENT_TYPE,)).fetchone()[0]
            queue_time=max(now,(previous+1) if previous is not None else now)
            con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?)',
                (workspace_id,event_id,batch_id,EVENT_TYPE,canonical_json({'batch_id':batch_id}),queue_time,now))
        return {'batch_id':batch_id,'state':'accepted','trace_ids':trace_ids,'duplicate':False}

    def batch_status(self,credential,workspace_id,batch_id):
        identifier(workspace_id);identifier(batch_id)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential);resolve_project(con,workspace_id)
            row=con.execute('SELECT * FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(workspace_id,batch_id)).fetchone()
            if row is None: raise Forbidden('batch is not accessible')
            capability='write' if row['principal_id']==scope.principal_id and 'read' not in scope.capabilities else 'read'
            grant=self.iam._workspace(scope,workspace_id,capability)
            if row['principal_id']!=scope.principal_id and grant.role not in ('owner','admin','personal'): raise Forbidden('batch is not accessible')
            trace_ids=json.loads(row['trace_ids_json'])
            for trace_id in trace_ids:
                self.iam._authorize(con,credential,workspace_id,capability,'trace',trace_id)
            return {'batch_id':batch_id,'state':row['state'],'trace_ids':trace_ids,'accepted_at_ms':row['accepted_at_ms'],
                    'indexed_at_ms':row['indexed_at_ms'],'error_code':row['error_code']}

    def _claim(self,worker_id,lease_ms):
        now=self.control.clock()
        with self.control.transaction() as con:
            row=con.execute("SELECT * FROM outbox_events WHERE event_type=? AND state IN ('pending','dispatching') ORDER BY created_at_ms,event_id LIMIT 1",(EVENT_TYPE,)).fetchone()
            if row is None or row['next_attempt_at_ms']>now or (row['state']=='dispatching' and row['lease_until_ms'] is not None and row['lease_until_ms']>now): return None
            attempt=revision(row['attempts']+1)
            con.execute("UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",
                (attempt,worker_id,now+lease_ms,now,row['workspace_id'],row['event_id']))
            result=dict(row);result.update(attempts=attempt,lease_owner=worker_id,lease_until_ms=now+lease_ms)
            return result

    def _owned(self,con,event):
        row=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=?',(event['workspace_id'],event['event_id'])).fetchone()
        if not row or row['state']!='dispatching' or row['attempts']!=event['attempts'] or row['lease_owner']!=event['lease_owner'] or row['lease_until_ms']<=self.control.clock(): raise _LeaseLost('worker lease lost')
        return row

    def _renew(self,event,lease_ms,trace_ids=()):
        with self.control.transaction() as con:
            self._owned(con,event)
            for trace_id in trace_ids:
                if con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(event['workspace_id'],trace_id)).fetchone() is None:
                    raise _RouteRetired('Trace route no longer active')
            now=self.control.clock()
            con.execute('UPDATE outbox_events SET lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=? AND attempts=? AND lease_owner=?',
                (now+lease_ms,now,event['workspace_id'],event['event_id'],event['attempts'],event['lease_owner']))

    def _put_head(self,con,ws,trace,kind,entity,version,source_version,snapshot,old,now):
        digest=hashlib.sha256(_json(snapshot).encode('utf-8')).hexdigest()
        _,ref=self._persist(snapshot)
        if old:
            con.execute('UPDATE obs_entity_heads SET revision=?,source_revision=?,content_hash=?,artifact_ref=?,updated_at_ms=? WHERE workspace_id=? AND trace_id=? AND entity_kind=? AND entity_id=?',
                (version,source_version,digest,ref,max(now,old['updated_at_ms']),ws,trace,kind,entity))
        else:
            con.execute('INSERT INTO obs_entity_heads VALUES(?,?,?,?,?,?,?,?,?,?)',(ws,trace,kind,entity,version,source_version,digest,ref,now,now))

    @staticmethod
    def _delta(summary,row,direction):
        summary['span_count']+=direction
        summary['error_count']+=direction*(row['execution_status']=='failed')
        summary['running_count']+=direction*(row['execution_status']=='running')
        summary['llm_call_count']+=direction*(row['kind']=='llm')
        summary['tool_call_count']+=direction*(row['kind']=='tool')
        for token in ('input','output'):
            value=row[token+'_tokens']
            summary[token+'_missing_count']+=direction*(value is None)
            summary[token+'_known_sum']+=direction*(value or 0)

    def _prepare(self,event,lease_ms=30000):
        ws=event['workspace_id'];now=self.control.clock()
        with self.control.transaction() as con:
            self._owned(con,event)
            batch=con.execute('SELECT * FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(ws,event['aggregate_id'])).fetchone()
            if batch is None: raise IngestConflict('missing batch')
            for trace_id in json.loads(batch['trace_ids_json']):
                if con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(ws,trace_id)).fetchone() is None:
                    raise _RouteRetired('Trace route no longer active')
            if batch['plan_ref']: return self._load(batch['plan_ref'])
            packet=self._load(batch['packet_ref'])
            if packet.get('encoding')!='otlp-json/v1': raise IngestConflict('invalid packet encoding')
            if hashlib.sha256(packet['json'].encode('utf-8')).hexdigest()!=batch['packet_hash']: raise IngestConflict('packet checksum mismatch')
            spans=_normalize(json.loads(packet['json']),ws)
            plan={'spans':[],'payloads':[],'summaries':[]};traces={}
            for source in spans:
                row=source['row'];trace=row['trace_id'];span=row['span_id']
                locator=con.execute("SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(ws,trace)).fetchone()
                if not locator: raise IngestConflict('Trace route no longer active')
                row['trace_bucket']=locator['trace_bucket']
                head=con.execute("SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='span' AND entity_id=?",(ws,trace,span)).fetchone()
                source_version=int(source['source_revision']);digest=hashlib.sha256(_json(source).encode('utf-8')).hexdigest()
                if head and source_version<head['source_revision']: continue
                if head and source_version==head['source_revision']:
                    if digest!=head['content_hash']: raise IngestConflict('source revision content conflict')
                    continue
                if trace not in traces:
                    trace_head=con.execute("SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='trace' AND entity_id=?",(ws,trace,trace)).fetchone()
                    state=self._load(trace_head['artifact_ref']) if trace_head else dict.fromkeys(('span_count','error_count','running_count','llm_call_count','tool_call_count','input_known_sum','output_known_sum','input_missing_count','output_missing_count'),0)
                    traces[trace]=[trace_head,state,source,locator]
                state=traces[trace][1]
                is_root=not row['parent_span_id']
                if not state.get('agent_name') or (is_root and not state.get('display_is_root')):
                    state['agent_name']=source['agent_name'];state['framework']=source['framework'];state['display_is_root']=is_root
                if head:
                    previous=self._load(head['artifact_ref'])['row']
                    if ((previous['started_at_ms']==state['started_at_ms'] and row['started_at_ms']>previous['started_at_ms']) or
                            (previous['ended_at_ms']==state['ended_at_ms'] and row['ended_at_ms']<previous['ended_at_ms'])):
                        state['_recompute_bounds']=True
                    self._delta(state,previous,-1)
                self._delta(state,row,1)
                state['started_at_ms']=min(state.get('started_at_ms',row['started_at_ms']),row['started_at_ms'])
                state['ended_at_ms']=max(state.get('ended_at_ms',row['ended_at_ms']),row['ended_at_ms'])
                version=revision(head['revision']+1 if head else 1)
                self._put_head(con,ws,trace,'span',span,version,source_version,source,head,now)
                plan['payloads'].append({'workspace_id':ws,'trace_bucket':row['trace_bucket'],'trace_id':trace,'span_id':span,'sections':source['sections'],'payload_revision':row['payload_revision']})
                plan['spans'].append(dict(row,revision=version))
            for trace,(head,state,source,locator) in traces.items():
                if state.pop('_recompute_bounds',False):
                    starts=[];ends=[]
                    for current in con.execute("SELECT artifact_ref FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='span'",(ws,trace)):
                        current_row=self._load(current[0])['row'];starts.append(current_row['started_at_ms']);ends.append(current_row['ended_at_ms'])
                    state['started_at_ms']=min(starts);state['ended_at_ms']=max(ends)
                version=revision(head['revision']+1 if head else 1)
                owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(ws,trace)).fetchone()[0]
                summary={'workspace_id':ws,'trace_bucket':locator['trace_bucket'],'trace_id':trace,'source_namespace':source['row']['source_namespace'],
                    'native_trace_id':source['native_trace_id'],'agent_name':state['agent_name'],'framework':state['framework'],
                    'started_at_ms':state['started_at_ms'],'ended_at_ms':state['ended_at_ms'],'last_activity_at_ms':state['ended_at_ms'],
                    'execution_status':'failed' if state['error_count'] else ('running' if state['running_count'] else 'done'),
                    'span_count':state['span_count'],'llm_call_count':state['llm_call_count'],'tool_call_count':state['tool_call_count'],
                    'input_tokens':None if state['input_missing_count'] else state['input_known_sum'],
                    'output_tokens':None if state['output_missing_count'] else state['output_known_sum'],
                    'attributes_json':canonical_json({'owner_principal_id':owner,'source':'otlp','error_count':state['error_count'],'running_count':state['running_count'],
                        'input_missing_count':state['input_missing_count'],'output_missing_count':state['output_missing_count']}),
                    'schema_version':1,'revision':version,'is_deleted':0}
                self._put_head(con,ws,trace,'trace',trace,version,1,state,head,now)
                plan['summaries'].append(summary)
            _,ref=self._persist(plan)
            con.execute("UPDATE ingest_batches SET state='prepared',plan_ref=? WHERE workspace_id=? AND batch_id=?",(ref,ws,batch['batch_id']))
            # The shared transaction lock prevents reclaim during preparation; renew after its final fsync.
            renewed=self.control.clock()
            con.execute('UPDATE outbox_events SET lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=? AND attempts=? AND lease_owner=?',
                (renewed+lease_ms,renewed,ws,event['event_id'],event['attempts'],event['lease_owner']))
            return plan

    def work_once(self,worker_id,lease_ms=30000):
        identifier(worker_id)
        if type(lease_ms) is not int or not 1000<=lease_ms<=300000: raise ValueError('lease must be 1000..300000ms')
        event=self._claim(worker_id,lease_ms)
        if event is None: return False
        prepared=False
        try:
            plan=self._prepare(event,lease_ms);prepared=True
            bulk=getattr(self.facts,'write_payload_bundles',None)
            for offset in range(0,len(plan['payloads']),128):
                payloads=plan['payloads'][offset:offset+128]
                self._renew(event,lease_ms,{p['trace_id'] for p in payloads})
                if callable(bulk):
                    results=bulk(payloads)
                    if not isinstance(results,list) or len(results)!=len(payloads): raise IngestConflict('payload batch receipt mismatch')
                else:
                    results=[]
                    for payload in payloads:
                        self._renew(event,lease_ms,[payload['trace_id']])
                        results.append(self.facts.write_payload_bundle(payload['workspace_id'],payload['trace_bucket'],payload['trace_id'],payload['span_id'],payload['sections']))
                for payload,result in zip(payloads,results):
                    actual=result.get('payload_revision') if callable(bulk) else result.get('payload_revision',payload['payload_revision'])
                    if actual!=payload['payload_revision']: raise IngestConflict('payload revision mismatch')
            for rows,method in [(plan['spans'],self.facts.write_spans),(plan['summaries'],lambda rows:self.facts._insert('obs_trace_current',rows))]:
                for offset in range(0,len(rows),128):
                    selected=rows[offset:offset+128]
                    self._renew(event,lease_ms,{row['trace_id'] for row in selected});method(selected)
            with self.control.transaction() as con:
                self._owned(con,event);now=self.control.clock()
                con.execute("UPDATE ingest_batches SET state='indexed',indexed_at_ms=CASE WHEN accepted_at_ms>? THEN accepted_at_ms ELSE ? END,error_code=NULL WHERE workspace_id=? AND batch_id=?",(now,now,event['workspace_id'],event['aggregate_id']))
                con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(now,event['workspace_id'],event['event_id']))
        except _LeaseLost:
            return True
        except Exception as exc:
            permanent=isinstance(exc,_RouteRetired) or (not prepared and isinstance(exc,(IngestConflict,ValueError,FileNotFoundError)))
            try:
                with self.control.transaction() as con:
                    self._owned(con,event);now=self.control.clock()
                    if permanent:
                        con.execute("UPDATE ingest_batches SET state='failed',error_code='invalid_source_revision_or_artifact' WHERE workspace_id=? AND batch_id=?",(event['workspace_id'],event['aggregate_id']))
                    con.execute('UPDATE outbox_events SET state=?,lease_owner=NULL,lease_until_ms=NULL,next_attempt_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?',
                        ('dead' if permanent else 'pending',now+min(60000,1000*2**min(event['attempts'],6)),now,event['workspace_id'],event['event_id']))
            except _LeaseLost: pass
        return True
