"""Private collector snapshots with durable source receipts and current entity provenance."""
import copy
import datetime
import hashlib
import json
import uuid

from .contracts import canonical_json, identifier
from .control import Conflict, StorageError
from .iam import IAMStore, Forbidden
from .observations import EVENT_TYPE, _json, _payload_revision, _normalize, _source_projection, _merge_projection
from .trace_transfer import LegacyTraceTransfer, _attribute

NAMESPACE='collector.source.v1'
ENCODING='collector-source-plan/v1'
MAX_INPUT_BYTES=16*1024*1024
MAX_PLAN_BYTES=64*1024*1024
MAX_ENTITIES=100000
MAX_PACKET_SPANS=256
MAX_OPERATIONS=4096


class CollectorSourcePending(StorageError):
    status=503


class CollectorSourceLimit(ValueError):
    status=413


def _hash(value):return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _bounded(value,limit=MAX_INPUT_BYTES):
    size=0
    try:
        for part in json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).iterencode(value):
            size+=len(part.encode('utf-8'))
            if size>limit:raise CollectorSourceLimit('Collector source exceeds snapshot budget')
    except (TypeError,OverflowError,RecursionError,UnicodeError) as exc:raise ValueError('Collector source requires bounded finite JSON') from exc
    return size


def _ms(value):
    try:
        if type(value) in (int,float):number=int(value)
        elif isinstance(value,str):
            stamp=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
            if stamp.tzinfo is None:stamp=stamp.replace(tzinfo=datetime.timezone.utc)
            number=int(stamp.timestamp()*1000)
        else:raise ValueError()
        if not 0<=number<=9007199254740991:raise ValueError()
        return number
    except (ValueError,TypeError,OverflowError):raise ValueError('Invalid collector timestamp') from None


def _iso(value):return datetime.datetime.fromtimestamp(value/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def _bucket(value):return datetime.datetime.fromtimestamp(value/1000,datetime.timezone.utc).date().isoformat()


def _source_state(route,annotation,owner):
    from .trace_evidence import EvidenceUnavailable
    try:state=json.loads(annotation['extra_json']).get('collector_source_v1') if annotation else None
    except (TypeError,ValueError):raise EvidenceUnavailable('Collector provenance is unavailable') from None
    if (not isinstance(state,dict) or state.get('version')!=1 or state.get('trace_id')!=route['trace_id']
            or state.get('actor_id')!=owner or state.get('native_trace_id')!=route['native_trace_id']
            or state.get('trace_bucket')!=route['trace_bucket'] or not isinstance(state.get('entities'),dict)):
        raise EvidenceUnavailable('Collector provenance differs from route')
    return state


def active_heads(control,begin,load):
    """Keep the complete capture fence; only attested retired entities leave current reads."""
    heads=[head for head in begin['heads'] if head['entity_kind']=='span']
    if begin['route']['source_namespace']!=NAMESPACE:return heads
    from .trace_evidence import EvidenceUnavailable
    state=_source_state(begin['route'],begin['annotation'],begin['owner']['owner_principal_id'])
    entities={entity['span_id']:entity for entity in state['entities'].values()}
    if len(entities)!=len(state['entities']) or set(entities)!={head['entity_id'] for head in heads}:raise EvidenceUnavailable('Collector current source vector is not indexed')
    current=[]
    for head in heads:
        entity=entities[head['entity_id']]
        if str(entity.get('source_revision'))!=str(head['source_revision']) or entity.get('content_hash')!=head['content_hash']:raise EvidenceUnavailable('Collector current source revision is not indexed')
        if entity.get('active') is True:current.append(head);continue
        if entity.get('active') is not False:raise EvidenceUnavailable('Collector entity lifecycle is invalid')
        source=load(head)
        if (_hash(source)!=head['content_hash'] or source.get('row',{}).get('is_deleted')!=1
                or str(source.get('source_revision'))!=str(head['source_revision'])
                or source['row'].get('span_id')!=head['entity_id'] or source['row'].get('trace_id')!=begin['route']['trace_id']
                or source['row'].get('source_namespace')!=NAMESPACE):raise EvidenceUnavailable('Collector retirement is not its immutable source')
    return current


def order_rows(begin,rows):
    if begin['route']['source_namespace']!=NAMESPACE:return rows
    from .trace_evidence import EvidenceUnavailable
    state=_source_state(begin['route'],begin['annotation'],begin['owner']['owner_principal_id'])
    entities={value['span_id']:value for value in state['entities'].values() if value.get('active') is True}
    if {row['span_id'] for row in rows}!=set(entities):raise EvidenceUnavailable('Collector current facts are incomplete')
    positions=[]
    for row in rows:
        entity=entities[row['span_id']];attrs=json.loads(row['attributes_json'])
        if entity.get('primary_index') is not None:
            if attrs.get('legacy.transfer_index')!=entity['primary_index'] or attrs.get('legacy.transfer_kind')!=state['primary_kind']:raise EvidenceUnavailable('Collector current ordering differs')
            positions.append(entity['primary_index'])
        elif attrs.get('legacy.transfer_kind')!='carrier':raise EvidenceUnavailable('Collector tool carrier differs')
    if sorted(positions)!=list(range(state['primary_count'] if state['primary_kind']!='carrier' else 1)):raise EvidenceUnavailable('Collector primary ordering is incomplete')
    return sorted(rows,key=lambda row:(entities[row['span_id']].get('primary_index') is None,entities[row['span_id']].get('primary_index',0) or 0,row['span_id']))


def indexed_boundary(control,workspace,candidates):
    selected=[candidate for candidate in candidates if candidate.get('source_namespace')==NAMESPACE]
    if not selected:return {}
    result={}
    with control.read_transaction() as con:
        for candidate in selected:
            trace=candidate['trace_id'];route=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
            if route is None or route['state']!='active':raise Conflict('Collector source route changed')
            owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace,trace)).fetchone()
            annotation=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
            state=_source_state(dict(route),annotation,owner[0] if owner else None);pending=state.get('pending')
            if pending:
                op=state.get('operations',{}).get(pending)
                if not isinstance(op,dict):raise CollectorSourcePending('Collector source receipt is unavailable')
                if op['stage']=='committed':
                    for ref in op['batch_refs']:
                        row=con.execute('SELECT state,principal_id,packet_hash,trace_ids_json FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(workspace,ref['batch_id'])).fetchone()
                        if (row is None or row['state']!='indexed' or row['principal_id']!=state['actor_id'] or row['packet_hash']!=ref['packet_hash'] or json.loads(row['trace_ids_json'])!=[trace]):raise CollectorSourcePending('Collector snapshot is not fully indexed')
            head=con.execute("SELECT revision,content_hash FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='trace' AND entity_id=?",(workspace,trace,trace)).fetchone()
            result[trace]={'revision':str(head['revision']) if head else None,'hash':head['content_hash'] if head else None,'bucket':route['trace_bucket']}
    return result


def current_boundary(control,token,workspace,route):
    iam=IAMStore(control)
    with control.read_transaction() as con:
        iam._authorize(con,token,workspace,'read','trace',route['trace_id'])
        actual=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,route['trace_id'])).fetchone()
        if actual is None or dict(actual)!=route:raise Conflict('Collector read route changed')
        owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace,route['trace_id'])).fetchone()
        annotation=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,route['trace_id'])).fetchone()
        heads=[dict(row) for row in con.execute('SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? ORDER BY entity_kind,entity_id',(workspace,route['trace_id']))]
        return {'route':dict(actual),'annotation':dict(annotation) if annotation else None,'owner':{'owner_principal_id':owner[0]},'heads':heads}


def relations(control,token,workspace,route):
    indexed_boundary(control,workspace,[route])
    begin=current_boundary(control,token,workspace,route)
    state=_source_state(route,begin['annotation'],begin['owner']['owner_principal_id'])
    value=state.get('relations')
    if not isinstance(value,dict) or type(value.get('isSubagent')) is not bool:raise CollectorSourcePending('Collector execution graph is unavailable')
    return copy.deepcopy(value)


def current_rows(control,token,workspace,route,rows):
    begin=current_boundary(control,token,workspace,route)
    from .observations import ObservationIngest
    ingest=ObservationIngest(control,None)
    def load(head):
        value=ingest._load(head['artifact_ref'])
        if _hash(value)!=head['content_hash']:raise CollectorSourcePending('Collector source artifact differs')
        return value
    expected={head['entity_id']:head for head in active_heads(control,begin,load)}
    if set(expected)!={row['span_id'] for row in rows} or any(str(row.get('revision'))!=str(expected[row['span_id']]['revision']) for row in rows):raise CollectorSourcePending('Collector facts are not fully indexed')
    ordered=order_rows(begin,rows)
    end=current_boundary(control,token,workspace,route)
    if end!=begin:raise Conflict('Collector source changed while reading')
    return ordered


def primary_kind(control,token,workspace,route):
    begin=current_boundary(control,token,workspace,route)
    return _source_state(route,begin['annotation'],begin['owner']['owner_principal_id']).get('primary_kind')


def rebuild_summary(ingest,con,workspace,trace,route):
    state=dict.fromkeys(('span_count','error_count','running_count','llm_call_count','tool_call_count','input_known_sum','output_known_sum','input_missing_count','output_missing_count'),0)
    state.update(tool_error_count=0,legacy_projection_complete=True)
    starts=[];ends=[];sources=[]
    for head in con.execute("SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='span' ORDER BY entity_id",(workspace,trace)):
        source=ingest._load(head['artifact_ref'])
        if source['row'].get('is_deleted'):continue
        sources.append(source);ingest._delta(state,source['row'],1);starts.append(source['row']['started_at_ms']);ends.append(source['row']['ended_at_ms'])
    if not sources:raise Conflict('Collector current snapshot has no metadata carrier')
    for source in sources:
        _,fields=_source_projection(source);_merge_projection(state,source,fields)
    chosen=next((source for source in sources if 'legacy_trace' in source['sections']),sources[0])
    state.update(started_at_ms=min(starts),ended_at_ms=max(ends),agent_name=chosen['agent_name'],framework=chosen['framework'],display_is_root=True)
    capsule=json.loads(chosen['sections']['legacy_trace']) if 'legacy_trace' in chosen['sections'] else None
    if capsule:
        session=capsule.get('session');state['collector_session_running']=isinstance(session,dict) and session.get('endTime') is None
    return state


class _PacketBuilder(LegacyTraceTransfer):
    def __init__(self,route):self.route=route
    def _trace_id(self,*_):return NAMESPACE,self.route['native_trace_id'],self.route['trace_id']


class CollectorSources:
    def __init__(self,control,ingest):self.control=control;self.ingest=ingest;self.iam=ingest.iam

    def _input(self,value):
        fields={'task_id','execution_id','framework','legacy_username','operation_key','operation','operation_request','started_at_ms','completion_at_ms','verified_client_id'}
        if not isinstance(value,dict) or set(value)-fields or not isinstance(value.get('operation_request'),dict):raise ValueError('Collector source reservation required')
        operation=value.get('operation')
        if operation not in ('snapshot','complete'):raise ValueError('Collector source operation required')
        key=identifier(value.get('operation_key'));username=identifier(value.get('legacy_username'));task=value.get('task_id');execution=value.get('execution_id')
        if value.get('verified_client_id') is not None:identifier(value['verified_client_id'])
        if task is not None:identifier(task)
        if execution is not None:identifier(execution)
        framework=value.get('framework')
        if framework is not None and (not isinstance(framework,str) or len(framework)>512):raise ValueError('Collector framework required')
        started=_ms(value['started_at_ms']) if value.get('started_at_ms') is not None else None
        completed=_ms(value['completion_at_ms']) if value.get('completion_at_ms') is not None else None
        body=copy.deepcopy(value);body.update(operation_key=key,legacy_username=username,operation=operation)
        _bounded(body)
        return body,task,execution,framework or None,started,completed

    def _scope(self,con,token,workspace):
        if not isinstance(token,str) or not token.startswith('api_'):raise Forbidden('Collector API credential required')
        scope=self.iam._scope(con,token);self.iam._workspace(scope,workspace,'write');return scope

    def _state(self,con,workspace,trace):
        row=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
        extra=json.loads(row['extra_json']) if row else {};return row,extra,copy.deepcopy(extra.get('collector_source_v1'))

    def _write(self,con,workspace,trace,state):
        row,extra,_=self._state(con,workspace,trace);extra['collector_source_v1']=state;_bounded(extra)
        now=self.control.clock()
        if row:con.execute('UPDATE trace_annotations SET extra_json=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND trace_id=?',(_json(extra),max(now,row['updated_at_ms']),workspace,trace))
        else:con.execute('INSERT INTO trace_annotations(workspace_id,trace_id,extra_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?)',(workspace,trace,_json(extra),now,now))

    def _owned(self,con,token,workspace,trace):
        scope=self._scope(con,token,workspace);route=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
        if route is None:raise Conflict('Collector route is missing')
        self.iam._authorize(con,token,workspace,'write','trace',trace)
        owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace,trace)).fetchone()
        if owner is None or owner[0]!=scope.principal_id:raise Forbidden('Collector source must belong to its actual actor')
        if route['state']!='active' or con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?",(workspace,trace,route['incarnation'])).fetchone():raise Conflict('Collector route was retired')
        row,extra,state=self._state(con,workspace,trace)
        if route['source_namespace']!=NAMESPACE or not isinstance(state,dict) or state.get('actor_id')!=scope.principal_id or state.get('trace_id')!=trace or state.get('native_trace_id')!=route['native_trace_id'] or state.get('trace_bucket')!=route['trace_bucket']:raise Conflict('Alias is not an attested public collector source')
        return dict(route),scope,state

    def _find(self,con,workspace,task):
        row=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='task' AND alias_id=?",(workspace,identifier(task))).fetchone()
        if row is None:raise Conflict('Collector task source is missing')
        return row[0]

    def _load(self,ref):return self.ingest._load(ref) if ref is not None else None

    def _op_state(self,con,workspace,trace,op):
        if op['stage']=='reserved':return 'reserved'
        if op['stage']=='failed':return 'failed'
        states=[]
        for ref in op['batch_refs']:
            row=con.execute('SELECT * FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(workspace,ref['batch_id'])).fetchone()
            if row is None or row['principal_id']!=op['actor_id'] or json.loads(row['trace_ids_json'])!=[trace] or row['packet_hash']!=ref['packet_hash']:raise CollectorSourcePending('Collector receipt batch differs')
            states.append(row['state'])
        if any(state=='failed' for state in states):return 'failed'
        if all(state=='indexed' for state in states):return 'indexed'
        return 'prepared' if any(state=='prepared' for state in states) else 'accepted'

    def _view(self,con,workspace,trace,state,op,*,duplicate=False,resume=False):
        status=self._op_state(con,workspace,trace,op)
        return {'trace_id':trace,'task_id':state['task_id'],'execution_id':state['execution_id'],'operation_key':op['operation_key'],'operation':op['operation'],
            'state':status,'input_hash':op['input_hash'],'error_code':op.get('error_code'),'base_revision':str(op['base_revision']),'source_revision':str(op.get('source_revision',op['base_revision'])),
            'received_at_ms':op['received_at_ms'],'completed_at_ms':op.get('completed_at_ms'),
            'operation_request':self._load(op['request_ref']),'provenance':{'legacy_username':state['legacy_username'],'verified_client_id':op.get('verified_client_id'),'framework':op.get('framework')},'snapshot':self._load(op['prior_snapshot_ref']),
            'batch_refs':[{'workspace_id':workspace,'batch_id':ref['batch_id'],'trace_ids':[trace]} for ref in op.get('batch_refs',[])],
            'duplicate':duplicate,'resume_pending':resume}

    def reserve(self,token,workspace,value):
        with self.control.transaction() as con:return self._reserve(con,token,workspace,value)

    def _reserve(self,con,token,workspace,value):
        identifier(workspace);body,task,execution,framework,started,completed=self._input(value);digest=_hash({key:item for key,item in body.items() if key!='verified_client_id'});slot=_hash(body['operation_key'])
        scope=self._scope(con,token,workspace);task=task or execution or str(uuid.uuid5(uuid.NAMESPACE_URL,_json([workspace,scope.principal_id,slot,'missing-task'])))
        alias=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='task' AND alias_id=?",(workspace,task)).fetchone()
        if alias:trace=alias[0];route,scope,state=self._owned(con,token,workspace,trace)
        else:
            execution=execution or task
            prior=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?",(workspace,execution)).fetchone()
            if prior:
                route,scope,state=self._owned(con,token,workspace,prior[0])
                if state['task_id']!=task:raise Conflict('Collector task and execution aliases differ')
                trace=route['trace_id']
            else:
                native=_hash(['collector-source',scope.principal_id,task])[:32];trace=str(uuid.uuid5(uuid.NAMESPACE_URL,canonical_json([workspace,NAMESPACE,native,1])))
                if con.execute('SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone():raise Conflict('Collector native route has no attested alias')
                for identity in (task,execution):
                    collision=con.execute('SELECT trace_id FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,identity)).fetchone()
                    if collision and collision[0]!=trace:raise Conflict('Collector alias collides with an internal Trace identity')
                now=self.control.clock();stamp=started if started is not None else completed if completed is not None else now;bucket=_bucket(stamp)
                con.execute('INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)',(workspace,trace,NAMESPACE,native,bucket,now,now))
                self.iam._record_resource(con,workspace,'trace',trace,scope.principal_id,'private',invalidate_policy=False)
                for kind,identity in [('task',task),('execution',execution)]:con.execute('INSERT INTO trace_legacy_ids VALUES(?,?,?,?,?)',(workspace,kind,identity,trace,now))
                route={'trace_id':trace,'native_trace_id':native,'trace_bucket':bucket,'source_namespace':NAMESPACE}
                state={'version':1,'actor_id':scope.principal_id,'legacy_username':body['legacy_username'],'trace_id':trace,'native_trace_id':native,'trace_bucket':bucket,
                    'task_id':task,'execution_id':execution,'framework':None,'source_revision':0,'snapshot_ref':None,'completion_at_ms':None,'pending':None,'operations':{},'entities':{},'next_id':1}
        op=state['operations'].get(slot)
        if op:
            if op['input_hash']!=digest:raise Conflict('Collector operation key has different content')
            return self._view(con,workspace,trace,state,op,duplicate=True)
        if state['framework'] and framework and state['framework']!=framework:raise Conflict('Collector source framework differs')
        if state['legacy_username']!=body['legacy_username']:raise Conflict('Collector source legacy owner differs')
        pending=state.get('pending')
        if pending:
            previous=state['operations'][pending]
            if self._op_state(con,workspace,trace,previous)!='indexed':return self._view(con,workspace,trace,state,previous,resume=True)
            state['pending']=None
        if len(state['operations'])>=MAX_OPERATIONS:raise CollectorSourceLimit('Collector source receipt budget reached')
        _,request_ref=self.ingest._persist(body['operation_request']);now=self.control.clock()
        op={'operation_key':body['operation_key'],'input_hash':digest,'request_ref':request_ref,'actor_id':scope.principal_id,'operation':body['operation'],
            'received_at_ms':now,'started_at_ms':started,'completed_at_ms':completed if completed is not None else now if body['operation']=='complete' else state.get('completion_at_ms'),
            'framework':framework,'verified_client_id':body.get('verified_client_id'),'base_revision':state['source_revision'],'prior_snapshot_ref':state['snapshot_ref'],'prior_session_ref':state.get('session_ref'),'stage':'reserved','batch_refs':[]}
        state['operations'][slot]=op;state['pending']=slot;self._write(con,workspace,trace,state)
        return self._view(con,workspace,trace,state,op)

    def _snapshot(self,state,op,value):
        if not isinstance(value,dict) or set(value)!={'execution','session'} or not isinstance(value['execution'],dict):raise ValueError('Collector execution and Session snapshot required')
        snapshot=copy.deepcopy(value);execution=snapshot['execution'];session=snapshot['session']
        if execution.get('id')!=state['execution_id'] or execution.get('taskId')!=state['task_id']:raise Conflict('Collector snapshot identity differs')
        reserved={'recorderContext','experiment_id','experiment_attempt_id','experiment_fence','experiment_lease_owner','experiment_recording_kind','diagnosis_run_id','diagnosis_attempt_id','diagnosis_fence','diagnosis_lease_owner','diagnosis_session_id','report_run_id','report_lease_token','turn_fence','lease_owner','request_key'}
        for metadata in (execution,session):
            if isinstance(metadata,dict) and reserved.intersection(metadata):raise ValueError('Collector snapshot cannot claim internal work context')
        if execution.get('sourceKind') in ('internal-agent','diagnosis','experiment','benchmark','trigger','evaluator'):raise ValueError('Collector snapshot cannot claim an internal origin')
        execution['user']=state['legacy_username'];execution['agentOwnership']='user'
        previous=self._load(op['prior_snapshot_ref']);existing_client=previous.get('execution',{}).get('clientId') if previous else None
        expected_client=existing_client or op.get('verified_client_id')
        if not existing_client and expected_client and execution.get('clientId') not in (None,expected_client):raise ValueError('Collector snapshot device differs from attestation')
        execution['clientId']=expected_client
        captured=execution.get('framework')
        if captured is not None and (not isinstance(captured,str) or len(captured)>512):raise ValueError('Collector snapshot framework must be nullable text')
        framework=captured or op.get('framework')
        if state.get('framework') and framework and framework!=state['framework'] or op.get('framework') and captured and captured!=op['framework']:raise Conflict('Collector snapshot framework differs')
        framework=state.get('framework') or framework
        if type(execution.get('isSubagent')) is not bool or any(not isinstance(execution.get(key),list) for key in ('skills','invokedSkills','observedAgents')):raise ValueError('Collector portable execution metadata required')
        _ms(execution.get('timestamp'))
        if session is not None:
            if not isinstance(session,dict) or session.get('taskId')!=state['task_id'] or not isinstance(session.get('interactions'),list):raise ValueError('Collector Session snapshot required')
            _ms(session.get('startTime'))
            if session.get('endTime') is not None:_ms(session['endTime'])
            if session.get('langfuseTraceNodes') is not None and not isinstance(session['langfuseTraceNodes'],list):raise ValueError('Collector Langfuse node array required')
            session['user']=state['legacy_username']
            if state.get('completion_at_ms') is not None:session['endTime']=_iso(state['completion_at_ms'])
        _bounded(snapshot);return snapshot,framework

    def _sources(self,workspace,route,snapshot,state):
        bundle={'executions':[snapshot]};packets,_=_PacketBuilder(route)._packets(workspace,bundle,'public',timestamp_ms=_ms,normalizer=lambda body,ws:_normalize(body,ws,timestamp_minimum=0))
        raw=[span for packet in packets for resource in packet['resourceSpans'] for scope in resource['scopeSpans'] for span in scope['spans']]
        previous=state['entities'];entities=copy.deepcopy(previous);mapping={};keys=[];primary=snapshot['session'] or {}
        kind='langfuse_node' if primary.get('langfuseTraceNodes') else 'interaction' if primary.get('interactions') else 'carrier'
        source_items=primary.get('langfuseTraceNodes') if kind=='langfuse_node' else primary.get('interactions',[])
        for index,span in enumerate(raw):
            item=source_items[index] if index<len(source_items) else {}
            identity=next((item.get(name) for name in ('_providerMessageId','spanId') if isinstance(item.get(name),str) and item[name]),None) if isinstance(item,dict) else None
            key=('provider:'+identity) if identity is not None else 'position:'+str(index) if kind!='carrier' else 'empty-carrier'
            if key in keys:raise Conflict('Collector source contains duplicate message identity')
            keys.append(key);entity=previous.get(key);sid=entity['span_id'] if entity else f"{state['next_id']:016x}"
            if entity is None:state['next_id']+=1
            mapping[span['spanId']]=sid
        for index,span in enumerate(raw):
            parent=span.get('parentSpanId');span['spanId']=mapping[span['spanId']]
            if parent:span['parentSpanId']=mapping[parent]
        all_spans=[(keys[index],span,index) for index,span in enumerate(raw)]
        if kind=='interaction':
            for index,span in enumerate(raw):
                item=source_items[index];calls=item.get('tool_calls') if isinstance(item,dict) else None
                if not isinstance(calls,list):continue
                for offset,call in enumerate(calls):
                    if not isinstance(call,dict):raise ValueError('Collector tool call must be an object')
                    fn=call.get('function') if isinstance(call.get('function'),dict) else {};name=fn.get('name') or call.get('name') or ''
                    if not isinstance(name,str):raise ValueError('Collector tool name must be text')
                    key='tool:'+keys[index]+':'+str(call.get('id') or offset);entity=previous.get(key);sid=entity['span_id'] if entity else f"{state['next_id']:016x}"
                    if entity is None:state['next_id']+=1
                    timing=call.get('timing') if isinstance(call.get('timing'),dict) else {};tool_state=call.get('state');status=tool_state.get('status') if isinstance(tool_state,dict) else tool_state
                    failed=bool(call.get('error')) or status in ('error','failed') or call.get('status') in ('error','failed')
                    attrs={'legacy.role':'tool','legacy.transfer_kind':'carrier','legacy.transfer_has_session':True,'gen_ai.tool.name':name}
                    if failed:attrs['error.type']='tool-error'
                    tool={'traceId':route['native_trace_id'],'spanId':sid,'parentSpanId':span['spanId'],'name':name or 'tool','kind':1,
                        'startTimeUnixNano':str(_ms(timing['started_at'])*1000000) if timing.get('started_at') is not None else span['startTimeUnixNano'],
                        'endTimeUnixNano':str(_ms(timing['completed_at'])*1000000) if timing.get('completed_at') is not None else span['endTimeUnixNano'],
                        'attributes':[_attribute(k,v) for k,v in attrs.items()],'status':{'code':2 if failed else 1},
                        'agent_insight_legacy_interaction':{'format':'agent-insight.trace-item','version':1,'kind':'carrier','value':copy.deepcopy(call)}}
                    all_spans.append((key,tool,None))
        changed=[];seen=set()
        resource={'attributes':[_attribute('agent_insight.source_namespace',NAMESPACE),_attribute('service.name',snapshot['execution'].get('agentName') or 'collector'),_attribute('telemetry.sdk.name',snapshot['execution'].get('framework') or state.get('framework') or 'legacy')]}
        for key,span,index in all_spans:
            if key in seen:raise Conflict('Collector source entity identity differs')
            seen.add(key);body={'resourceSpans':[{'resource':resource,'scopeSpans':[{'spans':[span]}]}]};source=_normalize(body,workspace,timestamp_minimum=0)[0];source['row']['trace_bucket']=route['trace_bucket'];semantic=_hash(source);old=previous.get(key)
            version=old['source_revision'] if old and old.get('semantic_hash')==semantic and old['active'] else old['source_revision']+1 if old else 1
            source['source_revision']=str(version);digest=_hash(source)
            entities[key]={'span_id':source['row']['span_id'],'source_revision':version,'semantic_hash':semantic,'content_hash':digest,'active':True,'primary_index':index}
            if old is None or old.get('content_hash')!=digest:changed.append(source)
        for key,old in previous.items():
            if key in seen or old['active'] is False:continue
            row=self.control_artifact_head(workspace,route['trace_id'],old['span_id']);source=self._load(row['artifact_ref'])
            if row['content_hash']!=old['content_hash'] or _hash(source)!=row['content_hash'] or str(source['source_revision'])!=str(old['source_revision']):raise CollectorSourcePending('Previous collector entity provenance differs')
            source['row']['is_deleted']=1;source['source_revision']=str(old['source_revision']+1)
            entities[key]={**old,'source_revision':old['source_revision']+1,'content_hash':_hash(source),'active':False};changed.append(source)
        if len(entities)>MAX_ENTITIES:raise CollectorSourceLimit('Collector source entity budget reached')
        state.update(entities=entities,primary_kind=kind,primary_count=len(source_items))
        return changed

    def control_artifact_head(self,workspace,trace,span):
        with self.control.read_transaction() as con:
            row=con.execute("SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? AND entity_kind='span' AND entity_id=?",(workspace,trace,span)).fetchone()
            if row is None:raise CollectorSourcePending('Previous collector entity is not indexed')
            return dict(row)

    def _enqueue(self,con,workspace,trace,state,op,sources):
        refs=[]
        for index,offset in enumerate(range(0,len(sources),MAX_PACKET_SPANS)):
            packet={'encoding':ENCODING,'trace_id':trace,'operation_slot':_hash(op['operation_key']),'input_hash':op['input_hash'],'packet_index':index,'sources':sources[offset:offset+MAX_PACKET_SPANS]};_bounded(packet,MAX_PLAN_BYTES)
            packet_hash=_hash(packet);_,ref=self.ingest._persist(packet);receipt='collector-source:'+_hash([trace,op['operation_key'],index]);batch=str(uuid.uuid5(uuid.NAMESPACE_URL,_json([workspace,receipt])));now=self.control.clock()
            con.execute('INSERT INTO ingest_batches(workspace_id,batch_id,principal_id,receipt_key,packet_hash,packet_ref,trace_ids_json,accepted_at_ms) VALUES(?,?,?,?,?,?,?,?)',(workspace,batch,op['actor_id'],receipt,packet_hash,ref,canonical_json([trace]),now))
            prior=con.execute('SELECT MAX(created_at_ms) FROM outbox_events WHERE event_type=?',(EVENT_TYPE,)).fetchone()[0];queued=max(now,prior+1 if prior is not None else now)
            con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?)',(workspace,str(uuid.uuid4()),batch,EVENT_TYPE,canonical_json({'batch_id':batch}),queued,now))
            refs.append({'batch_id':batch,'packet_hash':packet_hash,'packet_index':index})
        return refs

    def commit(self,token,workspace,value):
        if not isinstance(value,dict) or set(value)!={'task_id','operation_key','expected_revision','snapshot'}:raise ValueError('Collector snapshot commit required')
        identifier(workspace);identifier(value['operation_key']);expected=value['expected_revision']
        if not isinstance(expected,str) or not expected.isascii() or not expected.isdigit() or str(int(expected))!=expected:raise ValueError('Exact source revision required')
        _bounded(value['snapshot']);commit_hash=_hash(value['snapshot'])
        with self.control.transaction() as con:
            trace=self._find(con,workspace,value['task_id']);route,scope,state=self._owned(con,token,workspace,trace);slot=_hash(value['operation_key']);op=state['operations'].get(slot)
            if op is None or op['operation']!='snapshot' or op['stage']=='failed':raise Conflict('Collector snapshot reservation unavailable')
            if op.get('preparation_required'):raise Conflict('Collector operation requires its sealed preparation')
            if op['stage']!='reserved':
                if op.get('commit_request_hash')!=commit_hash:raise Conflict('Collector committed snapshot differs')
                return self._view(con,workspace,trace,state,op,duplicate=True)
            snapshot,framework=self._snapshot(state,op,value['snapshot']);snapshot_hash=_hash(snapshot)
            if state['pending']!=slot or state['source_revision']!=int(expected) or op['base_revision']!=int(expected):raise Conflict('Collector source revision changed')
            sources=self._sources(workspace,route,snapshot,state);_,snapshot_ref=self.ingest._persist(snapshot)
            state['source_revision']+=1;state['snapshot_ref']=snapshot_ref;state['framework']=framework
            state['relations']={key:copy.deepcopy(snapshot['execution'].get(key)) for key in ('isSubagent','parentExecutionId','rootExecutionId')}
            op.update(stage='committed',source_revision=state['source_revision'],snapshot_hash=snapshot_hash,snapshot_ref=snapshot_ref,commit_request_hash=commit_hash)
            op['batch_refs']=self._enqueue(con,workspace,trace,state,op,sources)
            if not op['batch_refs']:state['pending']=None
            self._write(con,workspace,trace,state);return self._view(con,workspace,trace,state,op)

    def complete(self,token,workspace,value):
        if value.get('operation')!='complete':raise ValueError('Collector completion operation required')
        reservation=self.reserve(token,workspace,value)
        if reservation.get('resume_pending') or reservation['state']!='reserved':return reservation
        with self.control.transaction() as con:
            trace=self._find(con,workspace,reservation['task_id']);route,scope,state=self._owned(con,token,workspace,trace);slot=_hash(reservation['operation_key']);op=state['operations'][slot]
            if op['stage']!='reserved':return self._view(con,workspace,trace,state,op,duplicate=True)
            if op.get('preparation_required'):raise Conflict('Collector operation requires its sealed preparation')
            snapshot=self._load(state['snapshot_ref']);sources=[];state['completion_at_ms']=op['completed_at_ms'];state['source_revision']+=1
            if snapshot is not None:
                if snapshot.get('session') is not None:snapshot['session']['endTime']=_iso(op['completed_at_ms'])
                sources=self._sources(workspace,route,snapshot,state);_,ref=self.ingest._persist(snapshot);state['snapshot_ref']=ref
            op.update(stage='committed',source_revision=state['source_revision']);op['batch_refs']=self._enqueue(con,workspace,trace,state,op,sources)
            if not op['batch_refs']:state['pending']=None
            self._write(con,workspace,trace,state);return self._view(con,workspace,trace,state,op)

    def reject_preparation(self,token,workspace,value):
        if not isinstance(value,dict) or set(value)!={'task_id','operation_key','input_hash','error_code'} or value['error_code'] not in ('INVALID_SOURCE_INPUT','SOURCE_BUDGET_EXCEEDED'):raise ValueError('Deterministic collector preparation rejection required')
        identifier(value['operation_key'])
        with self.control.transaction() as con:
            trace=self._find(con,workspace,value['task_id']);route,scope,state=self._owned(con,token,workspace,trace);slot=_hash(value['operation_key']);op=state['operations'].get(slot)
            if op is None or op['input_hash']!=value['input_hash']:raise Conflict('Collector rejected source receipt differs')
            if op['stage']=='failed':
                if op.get('error_code')!=value['error_code']:raise Conflict('Collector rejection differs')
                return self._view(con,workspace,trace,state,op,duplicate=True)
            if op['stage']!='reserved' or op['batch_refs'] or state['pending']!=slot:raise Conflict('Committed collector source cannot be rejected')
            op.update(stage='failed',error_code=value['error_code']);state['pending']=None;self._write(con,workspace,trace,state)
            return self._view(con,workspace,trace,state,op)

    def status(self,token,workspace,value):
        if not isinstance(value,dict) or set(value)!={'task_id','operation_key'}:raise ValueError('Collector receipt identity required')
        identifier(value['operation_key'])
        with self.control.transaction() as con:
            trace=self._find(con,workspace,value['task_id']);route,scope,state=self._owned(con,token,workspace,trace);slot=_hash(value['operation_key']);op=state['operations'].get(slot)
            if op is None:raise Conflict('Collector operation unavailable')
            return self._view(con,workspace,trace,state,op)

    def verified_packet(self,con,event,batch,packet):
        if not isinstance(packet,dict) or set(packet)!={'encoding','trace_id','operation_slot','input_hash','packet_index','sources'}:raise Conflict('Collector packet shape differs')
        trace=packet['trace_id'];route=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(event['workspace_id'],trace)).fetchone()
        if route is None or route['source_namespace']!=NAMESPACE or route['state']!='active':raise Conflict('Collector packet route differs')
        if con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?",(event['workspace_id'],trace,route['incarnation'])).fetchone():raise Conflict('Collector packet route was retired')
        owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(event['workspace_id'],trace)).fetchone()
        if owner is None or owner[0]!=batch['principal_id']:raise Conflict('Collector packet source owner changed')
        _,_,state=self._state(con,event['workspace_id'],trace);op=state.get('operations',{}).get(packet['operation_slot']) if isinstance(state,dict) else None
        if not op or op['stage']!='committed' or op['input_hash']!=packet['input_hash'] or op['actor_id']!=batch['principal_id'] or state.get('pending')!=packet['operation_slot']:raise Conflict('Collector packet has no committed source operation')
        ref=next((ref for ref in op['batch_refs'] if ref['batch_id']==batch['batch_id'] and ref['packet_index']==packet['packet_index']),None)
        if ref is None or ref['packet_hash']!=batch['packet_hash'] or _hash(packet)!=batch['packet_hash']:raise Conflict('Collector packet receipt differs')
        if not isinstance(packet['sources'],list) or not 1<=len(packet['sources'])<=MAX_PACKET_SPANS:raise ValueError('Collector packet entity budget differs')
        entities={entity['span_id']:entity for entity in state['entities'].values()}
        for source in packet['sources']:
            row=source['row'];entity=entities.get(row['span_id'])
            if (not entity or entity['content_hash']!=_hash(source) or str(entity['source_revision'])!=str(source['source_revision'])
                    or row['trace_id']!=trace or row['workspace_id']!=event['workspace_id'] or row['source_namespace']!=NAMESPACE or row['trace_bucket']!=route['trace_bucket']
                    or row['is_deleted']!=int(not entity['active'])):raise Conflict('Collector packet is not its committed immutable source')
        return copy.deepcopy(packet['sources'])
