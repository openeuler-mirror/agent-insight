"""Trusted Agent session snapshots through the same durable observation pipeline."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

from .contracts import canonical_json, identifier
from .control import Conflict, StorageError
from .iam import Forbidden
from .observations import normalize_import
from .trace_transfer import _attribute, _ms

MAX_RECORD_BYTES=16*1024*1024
MAX_PLAN_BYTES=32*1024*1024
MAX_PACKET_SPANS=256
MAX_ENTITIES=100000
NAMESPACE='agent.record.v1'
META_SPAN='f'*16
CONTEXT_FIELDS=('parent_trace_id','diagnosis_session_id','request_key','report_run_id')


class AgentTracePending(StorageError):
    status=503


class AgentTraceLimit(ValueError):
    status=413


def _json(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def _hash(value):return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _bounded(value,limit):
    size=0
    for text in json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).iterencode(value):
        size+=len(text.encode('utf-8'))
        if size>limit:raise AgentTraceLimit('Agent Trace exceeds bounded snapshot budget')
    return size


class AgentTraceRecorder:
    pending=AgentTracePending

    def __init__(self,control,ingest):
        self.control=control;self.ingest=ingest;self.iam=ingest.iam

    def _input(self,payload):
        if not isinstance(payload,dict) or not isinstance(payload.get('record'),dict) or not isinstance(payload.get('rawMessages'),list):raise ValueError('Standard Agent record and rawMessages required')
        record=copy.deepcopy(payload['record']);task=identifier(record.get('task_id'))
        if record.get('upload_id') not in (None,task):raise ValueError('Agent execution and provider session IDs differ')
        if not isinstance(record.get('interactions'),list) or not isinstance(record.get('agentName') or record.get('agent'),str):raise ValueError('Complete Agent interactions required')
        if not record['interactions']:raise ValueError('Agent Trace has no actual messages or failure evidence')
        context=payload.get('context',{})
        if not isinstance(context,dict):raise ValueError('Agent context must be an object')
        context={key:identifier(context[key]) for key in CONTEXT_FIELDS if key in context}
        body={'record':record,'rawMessages':copy.deepcopy(payload['rawMessages']),'context':context}
        _bounded(body,MAX_RECORD_BYTES)
        return task,body

    def _annotation(self,con,ws,trace):
        row=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
        extra=json.loads(row['extra_json']) if row else {}
        return row,extra,copy.deepcopy(extra.get('agent_record_v1',{}))

    def _write(self,con,ws,trace,state):
        row,extra,_=self._annotation(con,ws,trace);extra['agent_record_v1']=state;_bounded(extra,MAX_RECORD_BYTES)
        now=self.control.clock();text=_json(extra)
        if row:con.execute('UPDATE trace_annotations SET extra_json=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND trace_id=?',(text,max(now,row['updated_at_ms']),ws,trace))
        else:con.execute('INSERT INTO trace_annotations(workspace_id,trace_id,extra_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?)',(ws,trace,text,now,now))

    def _route(self,con,token,ws,task,body):
        scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'write')
        parent=body['context'].get('parent_trace_id')
        if parent:
            self.iam._authorize(con,token,ws,'read','trace',parent)
            if con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(ws,parent)).fetchone() is None:raise Forbidden('Agent source Trace is unavailable')
        aliases=[]
        for kind in ('task','execution'):
            row=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(ws,kind,task)).fetchone()
            if row:aliases.append(row[0])
        if len(set(aliases))>1:raise Conflict('Provider session aliases conflict')
        native=_hash(['agent-session',scope.principal_id,task])[:32]
        trace=aliases[0] if aliases else str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json([ws,NAMESPACE,native,1])))
        route=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
        if route:
            self.iam._authorize(con,token,ws,'write','trace',trace)
            if route['state']!='active':raise Conflict('Agent Trace was retired')
            if route['source_namespace']!=NAMESPACE:raise Conflict('Provider alias belongs to another Trace source')
            return dict(route),scope,False
        if aliases:raise Conflict('Provider alias route is missing')
        start=_ms(body['record'].get('trace_started_at') or body['record'].get('timestamp'))
        import datetime
        bucket=datetime.datetime.fromtimestamp(start/1000,datetime.timezone.utc).date().isoformat()
        return {'trace_id':trace,'native_trace_id':native,'trace_bucket':bucket,'source_namespace':NAMESPACE},scope,True

    def _messages(self,body):
        result=[];known=set()
        for index,item in enumerate(body['record']['interactions']):
            if not isinstance(item,dict):raise ValueError('Agent interaction must be an object')
            value=copy.deepcopy(item);provider=value.get('_providerMessageId')
            if provider is not None:identifier(provider);key='message:'+provider
            elif isinstance(value.get('error'),dict):key='failure:'+_hash([body['context'].get('request_key'),value.get('timestamp') or body['record'].get('trace_started_at')])
            elif body['record'].get('source_messages_unavailable'):key='attempt:'+_hash([body['context'].get('request_key'),body['record'].get('trace_started_at'),index])
            else:key='position:'+str(index)
            if key in known:raise Conflict('Duplicate Agent message identity')
            known.add(key);result.append((key,value))
        for index,raw in enumerate(body['rawMessages']):
            if not isinstance(raw,dict):raise ValueError('Provider message must be a JSON object')
            info=raw.get('info') if isinstance(raw.get('info'),dict) else {}
            identity=info.get('id')
            if isinstance(identity,str) and 'message:'+identity in known:
                value=next(value for key,value in result if key=='message:'+identity)
                if value.get('_providerMessage')!=raw:raise Conflict('Provider message copy differs from normalized record')
                continue
            if any(value.get('_providerMessage')==raw for _,value in result):continue
            key='message:'+identifier(identity) if isinstance(identity,str) else 'raw:'+str(index)
            if key in known:raise Conflict('Duplicate provider message identity')
            value={'role':info.get('role') if isinstance(info.get('role'),str) else 'trace','_providerMessage':copy.deepcopy(raw)}
            if identity:value['_providerMessageId']=identity
            known.add(key);result.append((key,value))
        return result

    def _plan(self,ws,route,body,state):
        record=body['record'];items=self._messages(body);old_order=state.get('message_order',[]);incoming=[key for key,_ in items]
        if not record.get('source_messages_unavailable'):
            provider_order=[key for key in old_order if not key.startswith(('failure:','attempt:'))]
            if [key for key in incoming if key in provider_order]!=provider_order:raise Conflict('Provider snapshot drops or reorders established history')
        entities=copy.deepcopy(state.get('entities',{}));next_id=state.get('next_id',1);spans=[]
        start=_ms(record.get('trace_started_at') or record.get('timestamp'));end=_ms(record.get('trace_completed_at') or record.get('timestamp'))
        if end<start:raise ValueError('Agent run ends before its start')
        session_start=min(state.get('started_at_ms',start),start)
        def put(key,value,role,*,name=None,parent=None,carrier=False,created=None,completed=None,extra=None):
            nonlocal next_id
            previous=entities.get(key)
            if previous:sid=previous['span_id']
            elif key=='meta':sid=META_SPAN
            else:sid=f'{next_id:016x}';next_id+=1
            attrs={'agent_insight.source_namespace':NAMESPACE,'legacy.role':role,'agent.name':record.get('agentName') or record.get('agent'),
                'legacy.transfer_kind':'carrier' if carrier else 'interaction','legacy.transfer_has_session':True}
            if role=='assistant':attrs['gen_ai.legacy.role']='assistant'
            if role=='tool' and name:attrs['gen_ai.tool.name']=name
            usage=value.get('usage') if isinstance(value.get('usage'),dict) and not carrier else {}
            for source,target in [('input','gen_ai.usage.input_tokens'),('output','gen_ai.usage.output_tokens')]:
                metric=usage.get(source)
                if type(metric) is int and 0<=metric<=2**53-1:attrs[target]=metric
            model=value.get('modelID') or value.get('model')
            if role=='assistant' and isinstance(model,str):attrs['gen_ai.response.model']=model
            if record.get('skill'):attrs['legacy.skills']=[record['skill']];attrs['legacy.invoked_skills']=[{'name':record['skill'],'version':record.get('skill_version')}]
            attrs['legacy.agent_ownership']='system';attrs['legacy.source_kind']='diagnosis' if body['context'] else 'internal-agent'
            if body['context'].get('parent_trace_id'):attrs['legacy.source_execution_id']=body['context']['parent_trace_id']
            failed=bool(value.get('error')) or value.get('status') in ('error','failed') or (role=='tool' and value.get('state') in ('error','failed'))
            if failed:
                error=value.get('error');attrs['error.type']=error.get('code','agent-error') if isinstance(error,dict) else 'agent-error'
            stamp=value.get('timeInfo') if isinstance(value.get('timeInfo'),dict) else {}
            created=_ms(created if created is not None else stamp.get('created') or value.get('timestamp') or session_start)
            completed=_ms(completed if completed is not None else stamp.get('completed') or created)
            if completed<created:raise ValueError('Agent message ends before start')
            span={'traceId':route['native_trace_id'],'spanId':sid,'name':name or role,'kind':1,
                'startTimeUnixNano':str(created*1000000),'endTimeUnixNano':str(completed*1000000),
                'attributes':[_attribute(k,v) for k,v in attrs.items()],'status':{'code':2 if failed else 1},
                'agent_insight_legacy_interaction':{'format':'agent-insight.trace-item','version':1,'kind':'carrier' if carrier else 'interaction','value':value}}
            if parent:span['parentSpanId']=parent
            if extra:span.update(extra)
            digest=_hash(span);version=previous['source_revision'] if previous and previous['content_hash']==digest else (previous['source_revision']+1 if previous else 1)
            entities[key]={'span_id':sid,'source_revision':version,'content_hash':digest}
            if previous is None or previous['content_hash']!=digest:
                span['attributes'].append(_attribute('agent_insight.revision',version));spans.append(span)
            return sid
        for key,value in items:
            role=value.get('role') if isinstance(value.get('role'),str) else 'trace'
            sid=put(key,value,role)
            calls=value.get('tool_calls')
            if isinstance(calls,list):
                for index,call in enumerate(calls):
                    if not isinstance(call,dict):raise ValueError('Tool call must be an object')
                    function=call.get('function') if isinstance(call.get('function'),dict) else {}
                    name=function.get('name') or call.get('name');name=name if isinstance(name,str) else None
                    identity=call.get('id') if isinstance(call.get('id'),str) and call['id'] else str(index)
                    tool_key='tool:'+key+':'+identity
                    timing=call.get('timing') if isinstance(call.get('timing'),dict) else {}
                    put(tool_key,copy.deepcopy(call),'tool',name=name,parent=sid,carrier=True,created=timing.get('started_at'),completed=timing.get('completed_at'))
        import datetime
        execution={key:copy.deepcopy(value) for key,value in record.items() if key!='interactions'}
        execution.update(id=record['task_id'],taskId=record['task_id'],query=record.get('query'),finalResult=record.get('final_result'),agentName=record.get('agentName') or record.get('agent'),
            framework=record.get('framework','opencode'),timestamp=datetime.datetime.fromtimestamp(session_start/1000,datetime.timezone.utc).isoformat(),agentOwnership='system',sourceKind='diagnosis' if body['context'] else 'internal-agent',
            agentSessionId=record['task_id'],sourceExecutionId=body['context'].get('parent_trace_id'),recorderContext=body['context'])
        session={'taskId':record['task_id'],'query':record.get('query'),'label':record.get('label'),
            'startTime':datetime.datetime.fromtimestamp(session_start/1000,datetime.timezone.utc).isoformat(),'endTime':datetime.datetime.fromtimestamp(end/1000,datetime.timezone.utc).isoformat()}
        capsule={'format':'agent-insight.trace-bundle-node','version':1,'node_index':0,'primary':'interaction','primary_count':len(list(dict.fromkeys(old_order+incoming))),'execution':execution,'session':session}
        put('meta',{'role':'trace'},'trace',carrier=True,created=session_start,completed=end,extra={'agent_insight_legacy_trace':capsule})
        if len(entities)>MAX_ENTITIES:raise AgentTraceLimit('Agent Trace exceeds entity budget')
        packets=[]
        for offset in range(0,len(spans),MAX_PACKET_SPANS):
            packet={'resourceSpans':[{'resource':{'attributes':[_attribute('service.name',record.get('agentName') or record['agent']),_attribute('telemetry.sdk.name',record.get('framework','opencode')),_attribute('agent_insight.source_namespace',NAMESPACE)]},'scopeSpans':[{'spans':spans[offset:offset+MAX_PACKET_SPANS]}]}]}
            normalized=normalize_import(packet,ws)
            if any(source['row']['trace_id']!=route['trace_id'] for source in normalized):raise Conflict('Agent snapshot changed its stable Trace identity')
            packets.append(packet)
        state.update(entities=entities,next_id=next_id,message_order=list(dict.fromkeys(old_order+incoming)),started_at_ms=session_start)
        return packets,state

    def _load_plan(self,digest):
        if not isinstance(digest,str) or not re.fullmatch('[0-9a-f]{64}',digest):raise AgentTracePending('Agent plan reference invalid')
        directory=self.control.artifact_directory;target=directory/digest;limit=MAX_PLAN_BYTES*2+4096
        if directory.is_symlink():raise AgentTracePending('Agent plan directory invalid')
        try:
            fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(fd,'rb') as source:
                info=os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise AgentTracePending('Agent plan exceeds bounded size')
                parts=[];size=0;hasher=hashlib.sha256()
                while True:
                    block=source.read(min(65536,limit+1-size))
                    if not block:break
                    size+=len(block)
                    if size>limit:raise AgentTracePending('Agent plan exceeds bounded size')
                    hasher.update(block);parts.append(block)
            if hasher.hexdigest()!=digest:raise AgentTracePending('Agent plan checksum mismatch')
            wrapper=json.loads(b''.join(parts))
            if wrapper.get('encoding')!='agent-record-plan/v1' or not isinstance(wrapper.get('json'),str) or len(wrapper['json'].encode())>MAX_PLAN_BYTES:raise AgentTracePending('Agent plan encoding invalid')
            return json.loads(wrapper['json'])
        except (OSError,ValueError,TypeError,KeyError,UnicodeError,RecursionError):raise AgentTracePending('Agent snapshot plan unavailable') from None

    def _submit(self,token,ws,trace,input_hash,plan_digest):
        plan=self._load_plan(plan_digest);refs=[]
        for index,packet in enumerate(plan['packets']):
            try:
                ack=self.ingest.accept_import(token,ws,packet,receipt_key='agent-record:'+_hash([trace,input_hash,index]))
                if ack['state'] not in ('accepted','prepared','indexed'):raise AgentTracePending('Agent batch failed')
                refs.append({'workspace_id':ws,'batch_id':ack['batch_id'],'trace_ids':ack['trace_ids']})
                with self.control.transaction() as con:
                    self.iam._authorize(con,token,ws,'write','trace',trace)
                    _,_,state=self._annotation(con,ws,trace);op=state['operations'][input_hash]
                    if op['plan_digest']!=plan_digest:raise Conflict('Agent submission plan changed')
                    existing=op.get('batch_refs',[]);overlap=min(len(existing),len(refs))
                    if existing[:overlap]!=refs[:overlap]:raise Conflict('Agent receipt prefix changed')
                    changed=False
                    if len(refs)>len(existing):op['batch_refs']=copy.deepcopy(refs);changed=True
                    if len(op['batch_refs'])==len(plan['packets']):
                        if not op.get('submitted'):op['submitted']=True;changed=True
                        if state.get('pending')==input_hash:state['pending']=None;changed=True
                    if changed:self._write(con,ws,trace,state)
            except (Forbidden,Conflict):raise
            except Exception as exc:raise AgentTracePending('Agent snapshot submission incomplete; retry identical input') from exc

    def _receipt(self,token,ws,trace,task,op,duplicate,input_hash):
        if not op.get('submitted') or not op.get('batch_refs') or len(op['batch_refs'])!=op.get('packet_count'):raise AgentTracePending('Agent receipt is incomplete')
        states=[self.ingest.batch_status(token,ws,ref['batch_id'])['state'] for ref in op['batch_refs']]
        state='indexed' if states and all(value=='indexed' for value in states) else 'failed' if 'failed' in states else 'prepared' if 'prepared' in states else 'accepted'
        return {'trace_id':trace,'task_id':task,'execution_id':task,'state':state,'batch_refs':copy.deepcopy(op['batch_refs']),'duplicate':duplicate,'input_hash':input_hash,'receipt_key':'agent-record:'+input_hash}

    def record(self,credential,workspace_id,payload):
        identifier(workspace_id);task,body=self._input(payload);digest=_hash(body);duplicate=False
        while True:
            with self.control.transaction() as con:
                route,scope,new=self._route(con,credential,workspace_id,task,body);trace=route['trace_id']
                _,_,state=self._annotation(con,workspace_id,trace)
                if not new and not state:raise Conflict('Agent source identity ledger missing')
                operations=state.setdefault('operations',{});pending=state.get('pending')
                if pending:
                    pending_hash=pending;plan_digest=operations[pending]['plan_digest'];duplicate=pending==digest
                elif digest in operations:
                    op=copy.deepcopy(operations[digest]);pending_hash=None;duplicate=True
                    if not op.get('submitted'):
                        pending_hash=digest;plan_digest=op['plan_digest'];state['pending']=digest;self._write(con,workspace_id,trace,state)
                else:
                    packets,state=self._plan(workspace_id,route,body,state)
                    if not packets:raise Conflict('Agent snapshot has no changed evidence')
                    plan={'packets':packets};_bounded(plan,MAX_PLAN_BYTES)
                    plan_digest,_=self.control.persist_artifact({'encoding':'agent-record-plan/v1','json':_json(plan)})
                    now=self.control.clock()
                    if new:
                        con.execute('INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)',(workspace_id,trace,NAMESPACE,route['native_trace_id'],route['trace_bucket'],now,now))
                        self.iam._record_resource(con,workspace_id,'trace',trace,scope.principal_id,'private',invalidate_policy=False)
                        for kind in ('task','execution'):con.execute('INSERT INTO trace_legacy_ids VALUES(?,?,?,?,?)',(workspace_id,kind,task,trace,now))
                    operations=state.setdefault('operations',{});operations[digest]={'plan_digest':plan_digest,'batch_refs':[],'submitted':False,'actor_id':scope.principal_id,'context':body['context'],'input_hash':digest,'packet_count':len(packets)}
                    state['pending']=digest;state['task_id']=task;self._write(con,workspace_id,trace,state);pending_hash=digest
            if pending_hash is None:return self._receipt(credential,workspace_id,trace,task,op,duplicate,digest)
            self._submit(credential,workspace_id,trace,pending_hash,plan_digest)
            if pending_hash==digest:
                with self.control.read_transaction() as con:
                    self.iam._authorize(con,credential,workspace_id,'read','trace',trace)
                    _,_,state=self._annotation(con,workspace_id,trace);op=state['operations'][digest]
                return self._receipt(credential,workspace_id,trace,task,op,duplicate,digest)

    def verify_receipt(self,credential,workspace_id,receipt,*,context,task_id):
        identifier(workspace_id);identifier(task_id)
        if not isinstance(context,dict) or not isinstance(receipt,dict):raise ValueError('Agent receipt and expected context required')
        expected={key:identifier(context[key]) for key in CONTEXT_FIELDS if key in context}
        if not expected.get('parent_trace_id'):raise ValueError('Canonical Agent source Trace required')
        digest=receipt.get('input_hash');trace=receipt.get('trace_id')
        if not isinstance(digest,str) or not re.fullmatch('[0-9a-f]{64}',digest) or receipt.get('receipt_key')!='agent-record:'+digest or receipt.get('task_id')!=task_id or receipt.get('execution_id')!=task_id:raise Conflict('Agent receipt identity differs')
        identifier(trace)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,credential);self.iam._workspace(scope,workspace_id,'write')
            self.iam._authorize(con,credential,workspace_id,'write','trace',trace)
            self.iam._authorize(con,credential,workspace_id,'write','trace',expected['parent_trace_id'])
            route=con.execute('SELECT state,source_namespace FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace_id,trace)).fetchone()
            parent=con.execute('SELECT state FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace_id,expected['parent_trace_id'])).fetchone()
            if route is None or route['state']!='active' or route['source_namespace']!=NAMESPACE or parent is None or parent['state']!='active':raise Conflict('Agent receipt route is unavailable')
            owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace_id,trace)).fetchone()
            if owner is None or owner[0]!=scope.principal_id:raise Forbidden('Agent receipt must belong to its actual recording actor')
            for kind in ('task','execution'):
                alias=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(workspace_id,kind,task_id)).fetchone()
                if alias is None or alias[0]!=trace:raise Conflict('Agent receipt provider alias differs')
            _,_,state=self._annotation(con,workspace_id,trace);op=state.get('operations',{}).get(digest)
            if not isinstance(op,dict) or op.get('actor_id')!=scope.principal_id or op.get('context')!=expected or op.get('input_hash')!=digest:raise Conflict('Agent receipt does not match this operation')
            refs=op.get('batch_refs')
            if not op.get('submitted') or not isinstance(refs,list) or not refs or len(refs)!=op.get('packet_count') or receipt.get('batch_refs')!=refs:raise Conflict('Agent receipt batches differ')
            for ref in refs:
                if ref.get('workspace_id')!=workspace_id or ref.get('trace_ids')!=[trace]:raise Conflict('Agent receipt batch scope differs')
                batch=con.execute('SELECT state,principal_id,trace_ids_json FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(workspace_id,ref['batch_id'])).fetchone()
                if batch is None or batch['principal_id']!=scope.principal_id or json.loads(batch['trace_ids_json'])!=[trace]:raise Conflict('Agent receipt batch is not its actual accepted source')
                if batch['state']!='indexed':raise AgentTracePending('Agent Trace is not fully indexed')
            return {'trace_id':trace,'task_id':task_id,'execution_id':task_id,'state':'indexed','batch_refs':copy.deepcopy(refs),'input_hash':digest,'receipt_key':'agent-record:'+digest,'duplicate':bool(receipt.get('duplicate'))}
