"""agent-insight.trace-bundle v1 over authenticated core storage, without legacy DB access."""
import copy
import datetime
import hashlib
import json
import uuid

from .contracts import canonical_json
from .control import Conflict, StorageError
from .iam import Forbidden
from .compatibility import LegacyTraceReads, CompatibilityLimitError

MAX_BUNDLE_BYTES=50*1024*1024
MAX_BUNDLE_EXECUTIONS=500
MAX_PACKET_BYTES=60*1024*1024
MAX_PACKET_SPANS=256
FORMAT='agent-insight.trace-bundle'
ITEM_FORMAT='agent-insight.trace-item'
NODE_FORMAT='agent-insight.trace-bundle-node'
REFERENCE_KEYS={'session_id','sessionId','subagent_session_id','subagentSessionId','agent_session_id','agentSessionId','parent_session_id','parentSessionId','root_session_id','rootSessionId','execution_id','executionId','parent_execution_id','parentExecutionId','root_execution_id','rootExecutionId'}
JSON_KEYS={'arguments','args','input','output'}
EXECUTION_NULLS=('query','framework','tokens','cost','latency','toolCallCount','llmCallCount','inputTokens','outputTokens','toolCallErrorCount','cacheReadInputTokens','cacheCreationInputTokens','maxSingleCallTokens','reasoningTokens','model','endpoint','agentName','finalResult','skill','skillVersion','label','agentSessionId','subagentType','subagentName')


class TraceBundleValidationError(ValueError):
    status=400


class TraceBundleLimitError(TraceBundleValidationError):
    status=413


class TraceTransferPending(StorageError):
    status=503
    def __init__(self,batch_refs):
        super().__init__('Trace import is incomplete; replay the same receipt to resume')
        self.batch_refs=tuple(batch_refs)


class ImportTraceResult(dict):
    def __init__(self,result,batch_refs):
        super().__init__(result);self.batch_refs=tuple(copy.deepcopy(batch_refs))


def _json(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def _hash(value):return hashlib.sha256(_json(value).encode()).hexdigest()
def _now():return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


def _id(value):
    if not isinstance(value,str) or not value.strip() or '\x00' in value or len(value)>512:raise TraceBundleValidationError('Legacy identity must contain1..512 characters without NUL')
    value.encode('utf-8');return value


def _ms(value):
    try:
        if type(value) in (int,float):result=int(value)
        elif isinstance(value,str):
            parsed=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
            if parsed.tzinfo is None:parsed=parsed.replace(tzinfo=datetime.timezone.utc)
            result=int(parsed.timestamp()*1000)
        else:raise ValueError()
        if result<=0:raise ValueError()
        return result
    except (ValueError,TypeError,OverflowError):raise TraceBundleValidationError('Invalid or unsupported Trace timestamp') from None


def _validate(value):
    try:
        if len(_json(value).encode())>MAX_BUNDLE_BYTES:raise TraceBundleLimitError('Trace bundle exceeds50MiB')
        if not isinstance(value,dict) or value.get('format')!=FORMAT or type(value.get('version')) is not int or value['version']!=1:raise TraceBundleValidationError('Unsupported Trace bundle format/version')
        _ms(value.get('exportedAt'));root=_id(value.get('rootExecutionId'));nodes=value.get('executions')
        if not isinstance(nodes,list) or not 1<=len(nodes)<=MAX_BUNDLE_EXECUTIONS:raise TraceBundleValidationError('Trace bundle requires1..500 execution nodes')
        ids=set();tasks=set();parents={}
        for node in nodes:
            if not isinstance(node,dict) or not isinstance(node.get('execution'),dict):raise TraceBundleValidationError('Execution node required')
            execution=node['execution'];identity=_id(execution.get('id'));_ms(execution.get('timestamp'))
            if identity in ids:raise TraceBundleValidationError('Duplicate execution identity')
            ids.add(identity)
            if type(execution.get('isSubagent')) is not bool or not all(isinstance(execution.get(k),list) for k in ('skills','invokedSkills','observedAgents')):raise TraceBundleValidationError('Invalid portable execution fields')
            task=execution.get('taskId')
            if task is not None:
                _id(task)
                if task in tasks:raise TraceBundleValidationError('Duplicate task identity')
                tasks.add(task)
            session=node.get('session')
            if session is not None:
                if not isinstance(session,dict) or session.get('taskId')!=task or not isinstance(session.get('interactions'),list):raise TraceBundleValidationError('Invalid portable Session')
                _id(session['taskId']);_ms(session.get('startTime'))
                if session.get('endTime') is not None:_ms(session['endTime'])
                if session.get('langfuseTraceNodes') is not None and not isinstance(session['langfuseTraceNodes'],list):raise TraceBundleValidationError('Invalid Langfuse node array')
            parent=execution.get('parentExecutionId');parents[identity]=parent
            if identity==root:
                if execution['isSubagent'] or parent or execution.get('rootExecutionId') not in (None,root):raise TraceBundleValidationError('Invalid root execution')
            elif not execution['isSubagent'] or not parent or execution.get('rootExecutionId')!=root:raise TraceBundleValidationError('Invalid child execution')
        if root not in ids:raise TraceBundleValidationError('Missing root execution')
        for identity,parent in parents.items():
            if parent and parent not in ids:raise TraceBundleValidationError('Missing parent execution')
            seen=set();current=identity
            while current:
                if current in seen:raise TraceBundleValidationError('Execution parent cycle')
                seen.add(current);current=parents.get(current)
        return value
    except TraceBundleValidationError:raise
    except (ValueError,TypeError,KeyError,RecursionError,UnicodeError):raise TraceBundleValidationError('Invalid finite JSON Trace bundle') from None


def _rewrite(value,mapping,key=None):
    if isinstance(value,str):
        if key in REFERENCE_KEYS:return mapping.get(value,value)
        if key in JSON_KEYS and value.lstrip().startswith(('{','[')):
            try:return _json(_rewrite(json.loads(value),mapping))
            except ValueError:return value
        return value
    if isinstance(value,list):return [_rewrite(v,mapping) for v in value]
    if isinstance(value,dict):return {k:_rewrite(v,mapping,k) for k,v in value.items()}
    return value


def _remap(bundle,mapping):
    result=copy.deepcopy(bundle);result['rootExecutionId']=mapping[bundle['rootExecutionId']]
    for node in result['executions']:
        execution=node['execution']
        for key in ('id','taskId','parentExecutionId','rootExecutionId','agentSessionId'):
            if execution.get(key):execution[key]=mapping.get(execution[key],execution[key])
        session=node.get('session')
        if session:
            session['taskId']=mapping[session['taskId']]
            session['interactions']=_rewrite(session['interactions'],mapping)
            if 'langfuseTraceNodes' in session:session['langfuseTraceNodes']=_rewrite(session['langfuseTraceNodes'],mapping)
    return result


def _attribute(key,value):
    if type(value) is bool:encoded={'boolValue':value}
    elif type(value) is int:encoded={'intValue':str(value)}
    elif isinstance(value,str):encoded={'stringValue':value}
    else:encoded={'stringValue':_json(value)}
    return {'key':key,'value':encoded}


class LegacyTraceTransfer:
    def __init__(self,control,queries,authorized,metadata,ingest):
        self.control=control;self.queries=queries;self.authorized=authorized;self.metadata=metadata;self.ingest=ingest
        self.reads=LegacyTraceReads(queries,authorized)

    def _trace_id(self,workspace,operation,node):
        session=node.get('session');lf=bool(session and session.get('langfuseTraceNodes'))
        namespace='trace.bundle.'+operation+('.lf' if lf else '.raw')
        native=_hash(['execution',operation,node['execution']['id']])[:32]
        trace=str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json([workspace,namespace,native,1])))
        return namespace,native,trace

    def _packets(self,workspace,bundle,operation):
        resources=[];routes=[]
        for position,node in enumerate(bundle['executions']):
            execution=node['execution'];session=node.get('session');namespace,native,trace=self._trace_id(workspace,operation,node)
            lf=bool(session and session.get('langfuseTraceNodes'))
            primary=session['langfuseTraceNodes'] if lf else (session['interactions'] if session else [])
            items=primary if primary else [None];kind='langfuse_node' if lf else ('interaction' if primary else 'carrier')
            session_meta=copy.deepcopy(session)
            if session_meta is not None:session_meta.pop('langfuseTraceNodes' if lf else 'interactions',None)
            capsule={'format':NODE_FORMAT,'version':1,'node_index':position,'primary':kind,'primary_count':len(primary),
                     'execution':execution,'session':session_meta}
            spans=[];start_anchor=_ms(session['startTime'] if session else execution['timestamp'])
            source_ids={item.get('spanId'):f'{i+1:016x}' for i,item in enumerate(primary) if isinstance(item,dict) and isinstance(item.get('spanId'),str)}
            for index,item in enumerate(items):
                source=item if isinstance(item,dict) else {};time_info=source.get('timeInfo') if isinstance(source.get('timeInfo'),dict) else {}
                raw_start=source.get('startedAt') if lf else (time_info.get('created') or source.get('timestamp'))
                raw_end=source.get('completedAt') if lf else time_info.get('completed')
                start=_ms(raw_start) if raw_start is not None else start_anchor
                end=_ms(raw_end) if raw_end is not None else start
                if end<start:raise TraceBundleValidationError('Span ends before its start')
                role=source.get('role');attrs={}
                if isinstance(role,str):attrs['legacy.role']=role
                if role in ('assistant','subagent','opencode') or (lf and source.get('kind')=='llm'):attrs['gen_ai.legacy.role']=role or 'assistant'
                model=source.get('model') or (execution.get('model') if role in ('assistant','subagent','opencode') else None)
                if isinstance(model,str) and model:attrs['gen_ai.response.model']=model
                if role=='tool' or (lf and source.get('kind')=='tool'):
                    tool_name=source.get('name')
                    if not isinstance(tool_name,str) or not tool_name:
                        calls=source.get('tool_calls')
                        first=next((call for call in calls if isinstance(call,dict)),{}) if isinstance(calls,list) else {}
                        function=first.get('function') if isinstance(first.get('function'),dict) else {}
                        tool_name=function.get('name') or first.get('name')
                    if isinstance(tool_name,str) and tool_name:attrs['gen_ai.tool.name']=tool_name
                if isinstance(source.get('spanId'),str):attrs['legacy.original_span_id']=source['spanId']
                if isinstance(source.get('traceId'),str):attrs['legacy.original_trace_id']=source['traceId']
                attrs['legacy.transfer_kind']=kind;attrs['legacy.transfer_index']=index;attrs['legacy.transfer_has_session']=session is not None
                if raw_start is None or raw_end is None:attrs['legacy.timing']='unknown_duration' if raw_start is not None else 'session_anchor_unknown_duration'
                for key,value in [('legacy.source_record_id',execution['id']),('legacy.source_task_id',execution.get('taskId')),
                    ('legacy.is_subagent',execution['isSubagent']),('legacy.parent_execution_id',execution.get('parentExecutionId')),
                    ('legacy.root_execution_id',execution.get('rootExecutionId')),('legacy.agent_session_id',execution.get('agentSessionId')),
                    ('legacy.session_query',session.get('query') if session else execution.get('query')),('legacy.session_label',session.get('label') if session else execution.get('label'))]:
                    if value is not None and len(_json(value).encode())<=4096:attrs[key]=value
                for key,target in [('skills','legacy.skills'),('invokedSkills','legacy.invoked_skills'),('observedAgents','legacy.agents')]:
                    if len(_json(execution[key]).encode())<=4096:attrs[target]=execution[key]
                usage=source.get('usage') if isinstance(source.get('usage'),dict) else {}
                for names,target in [(('input','input_tokens','inputTokens'),'gen_ai.usage.input_tokens'),(('output','output_tokens','outputTokens'),'gen_ai.usage.output_tokens')]:
                    for name in names:
                        if type(usage.get(name)) is int and 0<=usage[name]<=2**53-1:attrs[target]=usage[name];break
                status=source.get('status');failed=status in ('error','failed') if isinstance(status,str) else bool(source.get('error'))
                span={'traceId':native,'spanId':f'{index+1:016x}','name':source.get('name') if isinstance(source.get('name'),str) else 'legacy.'+kind,
                    'kind':1,'startTimeUnixNano':str(start*1000000),'endTimeUnixNano':str(end*1000000),
                    'attributes':[_attribute(k,v) for k,v in attrs.items()],'status':{'code':2 if failed else 0},
                    'agent_insight_legacy_interaction':{'format':ITEM_FORMAT,'version':1,'kind':kind,'index':index,'value':item}}
                parent=source.get('parentSpanId')
                if isinstance(parent,str) and parent in source_ids:span['parentSpanId']=source_ids[parent]
                if index==0:span['agent_insight_legacy_trace']=capsule
                spans.append(span)
            bucket=datetime.datetime.fromtimestamp(min(int(s['startTimeUnixNano']) for s in spans)/1e9,datetime.timezone.utc).date().isoformat()
            routes.append({'trace_id':trace,'source_namespace':namespace,'native_trace_id':native,'trace_bucket':bucket,'node_index':position})
            resource={'attributes':[_attribute('agent_insight.source_namespace',namespace),_attribute('service.name',execution.get('agentName') or 'legacy-import'),_attribute('telemetry.sdk.name',execution.get('framework') or 'legacy')]}
            for offset in range(0,len(spans),MAX_PACKET_SPANS):resources.append({'resource':resource,'scopeSpans':[{'scope':{'name':'agent-insight.trace-bundle.v1'},'spans':spans[offset:offset+MAX_PACKET_SPANS]}]})
        packets=[];current=[];count=0
        for resource in resources:
            n=sum(len(s['spans']) for s in resource['scopeSpans']);candidate={'resourceSpans':current+[resource]}
            if current and (count+n>MAX_PACKET_SPANS or len(_json(candidate).encode())>MAX_PACKET_BYTES):packets.append({'resourceSpans':current});current=[];count=0
            current.append(resource);count+=n
            if len(_json({'resourceSpans':current}).encode())>128*1024*1024:raise TraceBundleLimitError('Imported packet exceeds128MiB')
        if current:packets.append({'resourceSpans':current})
        from .observations import normalize_import
        for packet in packets:normalize_import(packet,workspace)
        return packets,routes

    def _taken(self,con,workspace,value):
        return con.execute('SELECT 1 FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=?',(workspace,value)).fetchone() is not None or con.execute('SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,value)).fetchone() is not None

    def import_bundle(self,token,ws,bundle,receipt_key=None):
        original=_validate(bundle);bundle_hash=_hash(original)
        if receipt_key is not None and (not isinstance(receipt_key,str) or not 1<=len(receipt_key)<=512):raise TraceBundleValidationError('Invalid import receipt key')
        with self.control.transaction() as con:
            scope=self.metadata.iam._scope(con,token);self.metadata.iam._workspace(scope,ws,'write')
            pending=None
            if receipt_key is None:
                rows=con.execute("SELECT a.extra_json FROM trace_annotations a JOIN iam_resource_access r ON r.workspace_id=a.workspace_id AND r.resource_kind='trace' AND r.resource_id=a.trace_id WHERE a.workspace_id=? AND r.owner_principal_id=? ORDER BY a.created_at_ms,a.trace_id",(ws,scope.principal_id))
                pending=next((state for row in rows if (state:=json.loads(row[0]).get('transfer_v1',{})).get('root_manifest') and state.get('bundle_hash')==bundle_hash and not state.get('completed',False)),None)
            operation=pending['operation'] if pending else (str(uuid.uuid5(uuid.NAMESPACE_URL,_json([ws,scope.principal_id,receipt_key]))) if receipt_key is not None else str(uuid.uuid4()))
            candidate_root=next(n for n in original['executions'] if n['execution']['id']==original['rootExecutionId'])
            # Stable lookup uses original identity before any remapping.
            source_namespace,_,_=self._trace_id(ws,operation,candidate_root)
            old=con.execute('SELECT a.extra_json FROM trace_annotations a JOIN trace_locators t ON t.workspace_id=a.workspace_id AND t.trace_id=a.trace_id WHERE t.workspace_id=? AND t.source_namespace=?',(ws,source_namespace)).fetchall()
            replay=pending or next((json.loads(r[0]).get('transfer_v1') for r in old if json.loads(r[0]).get('transfer_v1',{}).get('root_manifest')),None)
            if replay:
                if replay['bundle_hash']!=bundle_hash:raise Conflict('Import receipt already has different content')
                mapping=replay['mapping'];mapped=_remap(original,mapping);packets,routes=self._packets(ws,mapped,operation)
                result=replay['result'];root_trace=replay['root_trace_id']
            else:
                originals=list(dict.fromkeys(v for n in original['executions'] for v in (n['execution']['id'],n['execution'].get('taskId')) if v is not None))
                mapping={};reserved=set(originals)
                for identity in originals:
                    target=identity
                    if self._taken(con,ws,target):
                        for _ in range(1000):
                            target='import_'+str(uuid.uuid4())
                            if target not in reserved and target not in mapping.values() and not self._taken(con,ws,target):break
                        else:raise Conflict('Could not reserve distinct imported identities')
                    mapping[identity]=target;reserved.add(target)
                mapped=_remap(original,mapping);_validate(mapped);packets,routes=self._packets(ws,mapped,operation)
                root_position=next(i for i,n in enumerate(mapped['executions']) if n['execution']['id']==mapped['rootExecutionId'])
                root_trace=routes[root_position]['trace_id']
                root_node=mapped['executions'][root_position]
                result={'originalRootExecutionId':original['rootExecutionId'],'rootExecutionId':mapped['rootExecutionId'],
                    'rootTaskId':root_node['execution'].get('taskId'),'executionCount':len(mapped['executions']),
                    'subagentCount':sum(n['execution']['isSubagent'] for n in mapped['executions']),
                    'remappedIds':[{'original':a,'imported':b} for a,b in mapping.items() if a!=b]}
                now=self.control.clock()
                for route,node in zip(routes,mapped['executions']):
                    con.execute('INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)',(ws,route['trace_id'],route['source_namespace'],route['native_trace_id'],route['trace_bucket'],now,now))
                    self.metadata.iam._record_resource(con,ws,'trace',route['trace_id'],scope.principal_id,'private',invalidate_policy=False)
                    aliases=[('execution',node['execution']['id']),('task',node['execution'].get('taskId') or 'import_task_'+str(uuid.uuid4()))]
                    for kind,alias in aliases:con.execute('INSERT INTO trace_legacy_ids VALUES(?,?,?,?,?)',(ws,kind,alias,route['trace_id'],now))
                    state={'operation':operation,'bundle_hash':bundle_hash,'root_trace_id':root_trace,'node_index':route['node_index'],'has_session':node.get('session') is not None}
                    if route['trace_id']==root_trace:state.update(root_manifest=True,mapping=mapping,result=result,batch_refs=[],actor_id=scope.principal_id,completed=False,packet_count=len(packets))
                    extra=_json({'transfer_v1':state})
                    con.execute('INSERT INTO trace_annotations(workspace_id,trace_id,extra_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?)',(ws,route['trace_id'],extra,now,now))
        batches=[]
        for index,packet in enumerate(packets):
            key='trace-bundle:'+_hash([operation,index,packet])
            try:
                ack=self.ingest.accept_import(token,ws,packet,receipt_key=key)
                if ack['state'] not in ('accepted','prepared','indexed'):raise StorageError('Import batch failed')
                batches.append({'workspace_id':ws,'batch_id':ack['batch_id'],'trace_ids':ack['trace_ids']})
            except Exception as exc:raise TraceTransferPending(batches) from exc
            with self.control.transaction() as con:
                self.metadata._trace(con,token,ws,root_trace,'write')
                row=con.execute('SELECT extra_json FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,root_trace)).fetchone()
                extra=json.loads(row[0]);extra['transfer_v1']['batch_refs']=batches
                con.execute('UPDATE trace_annotations SET extra_json=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND trace_id=?',(_json(extra),self.control.clock(),ws,root_trace))
        return ImportTraceResult(result,batches)

    def mark_completed(self,token,ws,result):
        identity=self.metadata.resolve(token,ws,result['rootExecutionId'],'execution')
        with self.control.transaction() as con:
            self.metadata._trace(con,token,ws,identity['trace_id'],'write')
            row=con.execute('SELECT extra_json,updated_at_ms FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,identity['trace_id'])).fetchone()
            extra=json.loads(row[0]);state=extra.get('transfer_v1',{})
            if not state.get('root_manifest') or state.get('result')!=dict(result):raise Conflict('Import completion manifest differs')
            refs=state.get('batch_refs',[])
            if len(refs)!=state.get('packet_count',len(refs)) or not refs:raise TraceTransferPending(refs)
            for ref in refs:
                batch=con.execute('SELECT state FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(ws,ref['batch_id'])).fetchone()
                if batch is None or batch[0]!='indexed':raise TraceTransferPending(refs)
            if not state.get('completed'):
                state['completed']=True
                con.execute('UPDATE trace_annotations SET extra_json=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND trace_id=?',(_json(extra),max(self.control.clock(),row['updated_at_ms']),ws,identity['trace_id']))
        return result

    def _capsules(self,token,ws,trace):
        route=self.queries.route(token,ws,trace);summary=self.queries.summary(token,ws,trace).get('trace')
        if summary is None:raise TraceTransferPending([])
        meta=None;items=[]
        for row in self.reads._spans(token,ws,route):
            text=self.reads._section(token,ws,route,row,'legacy_trace')
            if text is not None:
                candidate=json.loads(text)
                if not isinstance(candidate,dict) or candidate.get('format')!=NODE_FORMAT or candidate.get('version')!=1:raise TraceBundleValidationError('Invalid original Trace metadata capsule')
                if meta is not None:raise TraceBundleValidationError('Duplicate original Trace metadata capsule')
                meta=candidate
            text=self.reads._section(token,ws,route,row,'legacy_interaction')
            if text is None:raise TraceBundleValidationError('Original interaction capsule is missing')
            item=json.loads(text)
            if not isinstance(item,dict) or item.get('format')!=ITEM_FORMAT or item.get('version')!=1:raise TraceBundleValidationError('Invalid original interaction capsule')
            items.append(item)
        if meta is None:raise TraceBundleValidationError('Original Trace metadata capsule is missing')
        if meta['primary']=='carrier':
            if len(items)!=1 or items[0]['kind']!='carrier':raise TraceBundleValidationError('Invalid empty Trace capsule')
        elif len(items)!=meta['primary_count'] or any(item['index']!=i or item['kind']!=meta['primary'] for i,item in enumerate(items)):
            raise TraceBundleValidationError('Original Trace representation is incomplete')
        node={'execution':copy.deepcopy(meta['execution']),'session':copy.deepcopy(meta['session'])}
        if node['session'] is not None:
            if meta['primary']=='langfuse_node':node['session']['langfuseTraceNodes']=[item['value'] for item in items]
            else:node['session']['interactions']=[] if meta['primary']=='carrier' else [item['value'] for item in items]
        self.reads._postflight(token,ws,route)
        return meta['node_index'],node

    def _export_native(self,token,ws,selected):
        summary=self.queries.summary(token,ws,selected['trace_id']).get('trace')
        if summary is None:raise TraceTransferPending([])
        details=json.loads(summary.get('attributes_json') or '{}')
        if details.get('is_subagent'):
            reference=details.get('root_execution_id')
            if not reference:raise TraceBundleValidationError('Native child has no captured root identity')
            root=self.metadata.resolve(token,ws,reference,'execution')
        else:root=selected
        with self.control.read_transaction() as con:
            aliases={r[0] for r in con.execute('SELECT alias_id FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=?',(ws,root['trace_id']))}
        aliases.update((root['trace_id'],root['execution_id']))
        candidates={root['trace_id']:root};cursor=None;scanned=0
        while True:
            page=self.queries.list_traces(token,ws,limit=200,cursor=cursor)
            for row in page['items']:
                scanned+=1
                if scanned>10000:raise TraceBundleLimitError('Native execution tree lookup exceeds10000 authorized Traces')
                projection=json.loads(row.get('attributes_json') or '{}')
                if projection.get('is_subagent') and projection.get('root_execution_id') in aliases:
                    candidates[row['trace_id']]=self.metadata.resolve(token,ws,row['trace_id'],'execution')
            cursor=page['next_cursor']
            if not cursor:break
        if len(candidates)>MAX_BUNDLE_EXECUTIONS:raise TraceBundleLimitError('Trace tree exceeds500 executions')
        nodes=[]
        for trace,identity in candidates.items():
            current=self.queries.summary(token,ws,trace).get('trace')
            if current is None:raise TraceTransferPending([])
            projection=json.loads(current.get('attributes_json') or '{}')
            full=self.reads.session(token,ws,trace,view='full');properties=self.metadata.properties(token,ws,trace)
            def value(name,fallback=None):
                if name in properties.get('override_fields',[]):return properties.get(name)
                return projection.get(name,fallback)
            started=current.get('started_at_ms')
            if started is None:raise TraceBundleValidationError('Native Trace has no captured export timestamp')
            timestamp=datetime.datetime.fromtimestamp(int(started)/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
            execution=dict.fromkeys(EXECUTION_NULLS)
            parent=None
            if trace!=root['trace_id']:
                captured=projection.get('parent_execution_id')
                if not captured:raise TraceBundleValidationError('Native child has no captured parent identity')
                parent=self.metadata.resolve(token,ws,captured,'execution')['execution_id']
            execution.update(id=identity['execution_id'],taskId=identity['task_id'],timestamp=timestamp,
                skills=value('skills',[]),invokedSkills=value('invoked_skills',[]),observedAgents=value('agents',[]),
                parentExecutionId=parent,rootExecutionId=root['execution_id'],isSubagent=trace!=root['trace_id'])
            last=next((i.get('content') for i in reversed(full['interactions']) if i.get('role')=='assistant' and isinstance(i.get('content'),str)),None)
            execution.update(query=value('query',full.get('query')),label=value('label',full.get('label')),agentName=current.get('agent_name'),
                framework=current.get('framework'),model=value('model'),finalResult=value('final_result',last),
                agentSessionId=value('agent_session_id'),tokens=full['execution']['tokens'],latency=full['execution']['latency'],
                inputTokens=int(current['input_tokens']) if current.get('input_tokens') is not None else None,
                outputTokens=int(current['output_tokens']) if current.get('output_tokens') is not None else None,
                llmCallCount=int(current['llm_call_count']) if current.get('llm_call_count') is not None else None,
                toolCallCount=int(current['tool_call_count']) if current.get('tool_call_count') is not None else None,
                toolCallErrorCount=projection.get('tool_error_count') if projection.get('tool_error_count_known') else None)
            interactions=[{k:v for k,v in i.items() if k not in {'_interactionIndex','_payloadDeferred','_payloadVersion'}} for i in full['interactions']]
            ended=current.get('ended_at_ms')
            end=datetime.datetime.fromtimestamp(int(ended)/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z') if ended is not None and current.get('execution_status')!='running' else None
            session={'taskId':identity['task_id'],'label':execution['label'],'query':execution['query'],'startTime':timestamp,'endTime':end,'interactions':interactions,'model':execution['model']}
            nodes.append({'execution':execution,'session':session})
        by_id={n['execution']['id']:n for n in nodes};ordered=[];visited=set()
        def visit(identity):
            if identity in visited:return
            if identity not in by_id:raise TraceBundleValidationError('Native execution tree is incomplete or not authorized')
            parent=by_id[identity]['execution']['parentExecutionId']
            if parent:visit(parent)
            visited.add(identity);ordered.append(by_id[identity])
        for node in nodes:visit(node['execution']['id'])
        for trace in candidates:self.queries.route(token,ws,trace)
        return {'format':FORMAT,'version':1,'exportedAt':_now(),'rootExecutionId':root['execution_id'],'executions':ordered}

    def export(self,token,ws,execution_ref):
        resolved=self.metadata.resolve(token,ws,execution_ref,'execution');trace=resolved['trace_id']
        route=self.queries.route(token,ws,trace)
        if route['source_namespace'].startswith('trace.bundle.'):
            with self.control.read_transaction() as con:
                self.metadata._trace(con,token,ws,trace)
                annotation=con.execute('SELECT extra_json FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
                state=json.loads(annotation[0]).get('transfer_v1') if annotation else None
                if not state:raise TraceBundleValidationError('Import identity manifest is unavailable')
                root_trace=state['root_trace_id'];root=con.execute('SELECT extra_json FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,root_trace)).fetchone()
                manifest=json.loads(root[0])['transfer_v1']
                namespaces=['trace.bundle.'+manifest['operation']+'.raw','trace.bundle.'+manifest['operation']+'.lf']
                traces=[r[0] for r in con.execute("SELECT trace_id FROM trace_locators WHERE workspace_id=? AND source_namespace IN (?,?) AND state='active'",(ws,*namespaces))]
            nodes=sorted(self._capsules(token,ws,t) for t in traces)
            if len(nodes)!=manifest['result']['executionCount']:raise TraceBundleValidationError('Imported execution tree is incomplete')
            result={'format':FORMAT,'version':1,'exportedAt':_now(),'rootExecutionId':manifest['result']['rootExecutionId'],'executions':[node for _,node in nodes]}
            for t in traces:self.queries.route(token,ws,t)
        else:
            result=self._export_native(token,ws,resolved)
        if len(_json(result).encode())>MAX_BUNDLE_BYTES:raise TraceBundleLimitError('Exported Trace bundle exceeds50MiB')
        return _validate(result)
