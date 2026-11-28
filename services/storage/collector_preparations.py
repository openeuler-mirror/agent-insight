"""First-writer collector preparation, separate from the source ingest ledger."""
import copy
import hashlib
import json

from .collector_sources import CollectorSources, CollectorSourcePending, CollectorSourceLimit, MAX_INPUT_BYTES, MAX_PLAN_BYTES, _bounded, _hash, _iso, _ms
from .contracts import identifier
from .control import Conflict, StorageError
from .iam import Forbidden
from .observations import _json


def _text(value,limit):
    if not isinstance(value,str):raise ValueError('Serialized collector JSON required')
    if len(value.encode('utf-8'))>limit:raise CollectorSourceLimit('Serialized collector JSON exceeds budget')
    try:parsed=json.loads(value,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Finite JSON required')))
    except (ValueError,RecursionError):raise ValueError('Finite collector JSON required') from None
    _bounded(parsed,limit)
    return parsed,hashlib.sha256(value.encode('utf-8')).hexdigest()


class CollectorPreparations:
    def __init__(self,control,ingest):self.control=control;self.ingest=ingest;self.sources=CollectorSources(control,ingest)

    def _persist_text(self,text):return self.ingest._persist({'text':text})[1]
    def _load_text(self,ref,digest):
        value=self.ingest._load(ref)
        if not isinstance(value,dict) or set(value)!={'text'} or not isinstance(value['text'],str) or hashlib.sha256(value['text'].encode('utf-8')).hexdigest()!=digest:raise Conflict('Collector preparation artifact differs')
        return value['text']

    def _identity(self,value):
        if not isinstance(value,dict):raise ValueError('Collector preparation identity required')
        kind=value.get('scope_kind');key=identifier(value.get('scope_key'));operation=identifier(value.get('operation_key'))
        if kind not in ('source','thread'):raise ValueError('Collector preparation scope required')
        return kind,key,operation

    def _require_schema(self,con):
        if not con.execute('SELECT 1 FROM schema_meta WHERE version=16').fetchone():raise StorageError('Explicit collector preparation migration 016 required')

    def _row(self,con,token,workspace,value):
        self._require_schema(con)
        kind,key,operation=self._identity(value);scope=self.sources._scope(con,token,workspace)
        row=con.execute('SELECT * FROM collector_preparation_receipts WHERE workspace_id=? AND scope_kind=? AND scope_key=? AND operation_key=?',(workspace,kind,key,operation)).fetchone()
        if row is None:raise Conflict('Collector preparation is unavailable')
        row=dict(row)
        if row['owner_principal_id']!=scope.principal_id:raise Forbidden('Collector preparation belongs to another actor')
        if kind=='source':self.sources._owned(con,token,workspace,key)
        return row

    def _prior_session(self,state):
        snapshot=self.sources._load(state.get('snapshot_ref'));session=snapshot.get('session') if snapshot else self.sources._load(state.get('session_ref'))
        marker=state.get('prepared_session')
        if isinstance(marker,dict) and marker.get('source_revision')==state['source_revision'] and marker.get('snapshot_ref')==state.get('snapshot_ref') and marker.get('session_hash')==_hash(session):
            if marker.get('text_ref'):
                text=self._load_text(marker['text_ref'],marker['text_hash'])
                if _hash(json.loads(text))==_hash(session):return text,'node'
            row=marker.get('receipt');plan=self.ingest._load(row['plan_ref']) if row else None
            if isinstance(plan,dict) and 'text' in plan:
                text=json.loads(plan['text']).get('serialized_session_json')
                if isinstance(text,str) and _hash(json.loads(text))==_hash(session):return text,'node'
        return _json(session),'legacy_canonical'

    def _context(self,con,workspace,reservation,state,op,origin):
        annotation=con.execute('SELECT revision FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,state['trace_id'])).fetchone()
        prior_text,prior_origin=self._prior_session(state)
        return {'version':1,'representation_origin':origin,'reservation':copy.deepcopy(reservation),'owner_principal_id':state['actor_id'],
            'source_revision':str(state['source_revision']),'annotation_revision':str(annotation[0]) if annotation else None,
            'prior_session_json':prior_text,'prior_session_origin':prior_origin}

    def _insert(self,con,workspace,kind,key,operation,owner,trace,operation_kind,digest,text,context):
        _,text_hash=_text(text,MAX_INPUT_BYTES);text_ref=self._persist_text(text);context_hash=_hash(context);_,context_ref=self.ingest._persist(context);now=self.control.clock()
        con.execute('INSERT INTO collector_preparation_receipts(workspace_id,scope_kind,scope_key,operation_key,owner_principal_id,trace_id,operation_kind,input_hash,input_text_hash,input_text_ref,context_hash,context_ref,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (workspace,kind,key,operation,owner,trace,operation_kind,digest,text_hash,text_ref,context_hash,context_ref,now,now))
        return {'scope_kind':kind,'scope_key':key,'operation_key':operation}

    def begin_preparation(self,token,workspace,value):
        if not isinstance(value,dict) or set(value)!={'reservation','operation_request_json'} or not isinstance(value['reservation'],dict):raise ValueError('Collector preparation begin required')
        raw,_=_text(value['operation_request_json'],MAX_INPUT_BYTES)
        if not isinstance(raw,dict):raise ValueError('Collector request object required')
        body=copy.deepcopy(value['reservation']);body['operation_request']=raw
        if body.get('operation')=='thread_only':return self._begin_thread(token,workspace,body,value['operation_request_json'])
        with self.control.transaction(('collector', workspace), ('trace', workspace), ('ingest', workspace)) as con:
            self._require_schema(con)
            reservation=self.sources._reserve(con,token,workspace,body);trace=reservation['trace_id'];_,scope,state=self.sources._owned(con,token,workspace,trace);op=state['operations'][_hash(reservation['operation_key'])]
            previous_request=self.sources._load(op['request_ref'])
            if reservation.get('resume_pending') and op['stage']=='reserved' and previous_request.get('_collector_job') and previous_request.get('_collector_job')!=raw.get('_collector_job'):
                op.update(stage='failed',error_code='SUPERSEDED_COLLECTOR_ANALYSIS');state['pending']=None;self.sources._write(con,workspace,trace,state)
                reservation=self.sources._reserve(con,token,workspace,body);trace=reservation['trace_id'];_,scope,state=self.sources._owned(con,token,workspace,trace);op=state['operations'][_hash(reservation['operation_key'])]
            if op.get('graph_parent_receipt') and op['graph_parent_receipt'].get('scope_key')!=trace:raise CollectorSourcePending('Derived child is reserved by its root graph')
            identity={'scope_kind':'source','scope_key':trace,'operation_key':op['operation_key']}
            existing=con.execute('SELECT 1 FROM collector_preparation_receipts WHERE workspace_id=? AND scope_kind=? AND scope_key=? AND operation_key=?',(workspace,'source',trace,op['operation_key'])).fetchone()
            if not existing:
                fresh=not reservation['duplicate'] and not reservation['resume_pending'];origin='node' if fresh else 'legacy_canonical'
                text=value['operation_request_json'] if fresh else _json(reservation['operation_request'])
                context=self._context(con,workspace,reservation,state,op,origin)
                self._insert(con,workspace,'source',trace,op['operation_key'],scope.principal_id,trace,op['operation'],op['input_hash'],text,context)
            if op['stage']=='reserved' and not op.get('preparation_required'):
                op['preparation_required']=True;self.sources._write(con,workspace,trace,state)
            return self._view(con,token,workspace,self._row(con,token,workspace,identity))

    def _begin_thread(self,token,workspace,body,text):
        if set(body)!={'operation','operation_key','source_thread_id','framework','legacy_username','operation_request'}:raise ValueError('Thread-only preparation identity required')
        operation=identifier(body['operation_key']);native=identifier(body['source_thread_id']);username=identifier(body['legacy_username']);framework=identifier(body['framework'])
        with self.control.transaction(('collector', workspace), ('trace', workspace), ('ingest', workspace)) as con:
            self._require_schema(con)
            scope=self.sources._scope(con,token,workspace);key=_hash([scope.principal_id,framework,native]);digest=_hash(body)
            identity={'scope_kind':'thread','scope_key':key,'operation_key':operation}
            row=con.execute('SELECT input_hash FROM collector_preparation_receipts WHERE workspace_id=? AND scope_kind=? AND scope_key=? AND operation_key=?',(workspace,'thread',key,operation)).fetchone()
            if row and row[0]!=digest:raise Conflict('Collector operation key has different content')
            if not row:
                now=self.control.clock();reservation={'trace_id':None,'task_id':None,'execution_id':None,'operation_key':operation,'operation':'thread_only','state':'reserved','input_hash':digest,'base_revision':'0','source_revision':'0','received_at_ms':now,'completed_at_ms':None,'operation_request':body['operation_request'],'provenance':{'legacy_username':username,'framework':framework,'verified_client_id':None},'snapshot':None,'batch_refs':[]}
                context={'version':1,'representation_origin':'node','reservation':reservation,'owner_principal_id':scope.principal_id,'prior_session_json':'null','prior_session_origin':'legacy_canonical'}
                self._insert(con,workspace,'thread',key,operation,scope.principal_id,None,'thread_only',digest,text,context)
            return self._view(con,token,workspace,self._row(con,token,workspace,identity))

    def _view(self,con,token,workspace,row):
        context=self.ingest._load(row['context_ref'])
        if _hash(context)!=row['context_hash']:raise Conflict('Collector preparation context differs')
        reservation=copy.deepcopy(context.get('reservation'));source_state='reserved';session=None
        if row['scope_kind']=='source':
            _,_,state=self.sources._owned(con,token,workspace,row['scope_key']);op=state['operations'].get(_hash(row['operation_key']))
            if not op or op['input_hash']!=row['input_hash']:raise Conflict('Collector preparation source differs')
            source_state=self.sources._op_state(con,workspace,row['scope_key'],op)
            current=self.sources._view(con,workspace,row['scope_key'],state,op)
            reservation.update({key:current[key] for key in ('state','source_revision','batch_refs','error_code')})
            snapshot=self.sources._load(state.get('snapshot_ref'));session=snapshot.get('session') if snapshot else self.sources._load(state.get('session_ref'))
        if row['scope_kind']=='thread' and con.execute('SELECT 1 FROM schema_meta WHERE version=17').fetchone():
            from .collector_graphs import CollectorGraphs
            if CollectorGraphs(self).applied(con,row):source_state='indexed';reservation['state']='indexed'
        result={key:row[key] for key in ('scope_kind','scope_key','operation_key','input_hash','context_hash','capture_hash','plan_hash','seal_revision')}
        result.update(reservation=reservation,source_state=source_state,public_ready=False,session=session,
            operation_request_json=self._load_text(row['input_text_ref'],row['input_text_hash']),representation_origin=context['representation_origin'],
            prior_session_json=context['prior_session_json'],prior_session_origin=context['prior_session_origin'],
            capture_json=self._load_text(row['capture_ref'],row['capture_hash']) if row['capture_ref'] else None,
            plan_json=self._load_text(row['plan_ref'],row['plan_hash']) if row['plan_ref'] else None)
        return result

    def _binding(self,row,context,value):
        binding=value.get('binding') if isinstance(value,dict) else None;reservation=context['reservation']
        if not isinstance(binding,dict) or any(binding.get(key)!=reservation[key] for key in ('trace_id','task_id','execution_id','operation_key','input_hash','base_revision')):raise Conflict('Collector preparation binding differs')

    def _seal(self,token,workspace,value,slot,expected):
        allowed={'scope_kind','scope_key','operation_key',expected,slot+'_json'}
        if not isinstance(value,dict) or set(value)!=allowed:raise ValueError('Collector preparation seal required')
        parsed,digest=_text(value[slot+'_json'],MAX_PLAN_BYTES if slot=='plan' else MAX_INPUT_BYTES)
        with self.control.transaction(('collector', workspace), ('trace', workspace), ('ingest', workspace)) as con:
            row=self._row(con,token,workspace,value)
            if value[expected]!=row[expected]:raise Conflict('Collector preparation prerequisite differs')
            if row[slot+'_ref'] is not None:return self._view(con,token,workspace,row)
            context=self.ingest._load(row['context_ref']);self._binding(row,context,parsed)
            if slot=='capture':
                if parsed.get('version')!=1 or parsed.get('actor')!={'principal':row['owner_principal_id'],'workspace':workspace,'username':context['reservation']['provenance']['legacy_username']}:raise Forbidden('Collector capture actor differs')
            else:
                if row['capture_ref'] is None:raise Conflict('Collector capture must be sealed first')
                capture=json.loads(self._load_text(row['capture_ref'],row['capture_hash']))
                if parsed['binding']!=capture['binding']:raise Conflict('Collector plan capture binding differs')
                selected=parsed.get('snapshot',{}).get('session') if isinstance(parsed.get('snapshot'),dict) else parsed.get('session')
                serialized,_=_text(parsed.get('serialized_session_json'),MAX_INPUT_BYTES)
                if _hash(serialized)!=_hash(selected):raise Conflict('Serialized collector Session differs')
            if slot=='capture' and parsed.get('graph_context') is not None:
                from .collector_graphs import CollectorGraphs
                CollectorGraphs(self).reserve_capture(con,token,row,parsed)
            ref=self._persist_text(value[slot+'_json']);now=max(self.control.clock(),row['updated_at_ms'])
            con.execute('UPDATE collector_preparation_receipts SET '+slot+'_hash=?,'+slot+'_ref=?,seal_revision=seal_revision+1,updated_at_ms=? WHERE workspace_id=? AND scope_kind=? AND scope_key=? AND operation_key=? AND '+slot+'_ref IS NULL',(digest,ref,now,workspace,row['scope_kind'],row['scope_key'],row['operation_key']))
            return self._view(con,token,workspace,self._row(con,token,workspace,value))

    def seal_capture(self,token,workspace,value):return self._seal(token,workspace,value,'capture','context_hash')
    def seal_plan(self,token,workspace,value):return self._seal(token,workspace,value,'plan','capture_hash')

    def preparation_status(self,token,workspace,value):
        if not isinstance(value,dict) or set(value)!={'scope_kind','scope_key','operation_key'}:raise ValueError('Collector preparation identity required')
        with self.control.read_transaction() as con:return self._view(con,token,workspace,self._row(con,token,workspace,value))

    def capture_graph_context(self,token,workspace,value):
        from .collector_graphs import CollectorGraphs
        with self.control.read_transaction() as con:
            row=self._row(con,token,workspace,value)
            return CollectorGraphs(self).context(con,token,row,value)

    def _apply_source(self,con,row,route,state,op,plan):
        workspace=row['workspace_id'];trace=route['trace_id'];slot=_hash(op['operation_key'])
        if op['stage']!='reserved' or state.get('pending')!=slot or state['source_revision']!=op['base_revision']:raise Conflict('Collector source revision changed')
        snapshot=plan.get('snapshot');session=plan.get('session') if snapshot is None else snapshot.get('session');framework=state['framework'];sources=[]
        completed=plan.get('collector_entry',{}).get('cli_completed_at_ms')
        if completed is not None:
            request=self.sources._load(op['request_ref']);raw=request.get('data',request)
            if raw.get('framework')!='opencode' or not raw.get('opencode_cli_completed') or completed!=op['received_at_ms']:raise Conflict('CLI completion differs from captured request')
            state['completion_at_ms']=completed
        if op['operation']=='complete':
            previous=self.sources._load(state.get('snapshot_ref'))
            if (previous is None)!=(snapshot is None) or previous is not None and snapshot.get('execution')!=previous['execution']:raise Conflict('Completion cannot replace the execution')
            if not isinstance(session,dict) or session.get('taskId')!=state['task_id'] or session.get('user')!=state['legacy_username'] or not isinstance(session.get('interactions'),list):raise ValueError('Completion Session required')
            _ms(session.get('startTime'))
            if session.get('endTime')!=_iso(op['completed_at_ms']):raise Conflict('Completion clock differs')
            state['completion_at_ms']=op['completed_at_ms']
        elif snapshot is None:raise CollectorSourcePending('Collector non-execution preparation is retained without a Trace commit')
        if snapshot is not None:
            snapshot,framework=self.sources._snapshot(state,op,snapshot);session=snapshot['session']
            if 'execution_skills' in plan:
                if not isinstance(plan['execution_skills'],list):raise ValueError('Prepared ExecutionSkill array required')
                state['execution_skills']=copy.deepcopy(plan['execution_skills'])
            sources=self.sources._sources(workspace,route,snapshot,state);_,state['snapshot_ref']=self.ingest._persist(snapshot)
            state['relations']={key:copy.deepcopy(snapshot['execution'].get(key)) for key in ('isSubagent','parentExecutionId','rootExecutionId')};state['execution_retired']=False
        text=plan['serialized_session_json'];serialized=json.loads(text)
        if _hash(serialized)!=_hash(session):raise Conflict('Applied Session differs from sealed representation')
        _,state['session_ref']=self.ingest._persist(session)
        state['source_revision']+=1;state['framework']=framework
        state['prepared_session']={'source_revision':state['source_revision'],'snapshot_ref':state.get('snapshot_ref'),'session_hash':_hash(session),'text_ref':self._persist_text(text),'text_hash':hashlib.sha256(text.encode('utf-8')).hexdigest()}
        op.update(stage='committed',source_revision=state['source_revision'],snapshot_hash=_hash(snapshot),snapshot_ref=state.get('snapshot_ref'),prepared_plan_hash=row['plan_hash'])
        op['batch_refs']=self.sources._enqueue(con,workspace,trace,state,op,sources)
        if not op['batch_refs']:state['pending']=None

    def commit_prepared(self,token,workspace,value):
        if not isinstance(value,dict) or set(value)-{'scope_kind','scope_key','operation_key','plan_hash','job_handle'} or not {'scope_kind','scope_key','operation_key','plan_hash'}<=set(value):raise ValueError('Sealed collector plan required')
        with self.control.transaction(('collector', workspace), ('trace', workspace), ('ingest', workspace)) as con:
            row=self._row(con,token,workspace,value)
            if row['plan_hash'] is None or row['plan_hash']!=value['plan_hash']:raise Conflict('Collector sealed plan differs')
            plan=json.loads(self._load_text(row['plan_ref'],row['plan_hash']))
            capture=json.loads(self._load_text(row['capture_ref'],row['capture_hash']))
            from .collector_public import CollectorPublic
            from .collector_jobs import CollectorJobs
            jobs=CollectorJobs(CollectorPublic(self.control,self.ingest));job=jobs.before_commit(con,token,workspace,row,plan,value.get('job_handle'))
            if capture.get('graph_context') is not None:
                from .collector_graphs import CollectorGraphs
                CollectorGraphs(self).apply(con,token,row,plan,capture)
                jobs.after_commit(con,workspace,row,job);jobs.schedule(con,row,plan)
                return self._view(con,token,workspace,row)
            if plan.get('children') or plan.get('thread') or plan.get('retire_missing_children'):raise CollectorSourcePending('Collector graph preparation awaits atomic graph support')
            if row['scope_kind']=='thread':return self._view(con,token,workspace,row)
            trace=row['scope_key'];route,_,state=self.sources._owned(con,token,workspace,trace);op=state['operations'][_hash(row['operation_key'])]
            if op['stage']!='reserved':return self._view(con,token,workspace,row)
            self._apply_source(con,row,route,state,op,plan);self.sources._write(con,workspace,trace,state)
            jobs.after_commit(con,workspace,row,job);jobs.schedule(con,row,plan)
            return self._view(con,token,workspace,row)
