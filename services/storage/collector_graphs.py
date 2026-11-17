import copy
import json
import hashlib
import uuid

from .collector_sources import CollectorSourcePending, _hash, _ms, _iso, _bounded, MAX_PLAN_BYTES
from .contracts import identifier
from .control import Conflict, StorageError
from .observations import _json

INBOX_SOURCE='collector-preparation-effects/v1'


class CollectorGraphs:
    def __init__(self,preparations):
        self.preparations=preparations;self.control=preparations.control;self.ingest=preparations.ingest;self.sources=preparations.sources

    def require(self,con):
        if not con.execute('SELECT 1 FROM schema_meta WHERE version=17').fetchone():raise StorageError('Explicit collector graph migration 017 required')

    def _event(self,row):return _hash([row['scope_kind'],row['scope_key'],row['operation_key']])

    def applied(self,con,row):
        prior=con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',(row['workspace_id'],INBOX_SOURCE,self._event(row))).fetchone()
        if prior and prior[0]!=row['plan_hash']:raise Conflict('Collector graph applied a different sealed plan')
        return prior is not None

    def _record_applied(self,con,row):
        con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)',(row['workspace_id'],INBOX_SOURCE,self._event(row),row['plan_hash'],self.control.clock()))

    def _child(self,con,token,workspace,execution,task,root):
        identifier(execution);identifier(task)
        by_execution=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?",(workspace,execution)).fetchone()
        by_task=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='task' AND alias_id=?",(workspace,task)).fetchone()
        if not by_execution:
            if by_task:raise Conflict('Derived child task alias belongs to another source')
            return None
        if by_task is None or by_task[0]!=by_execution[0]:raise Conflict('Derived child aliases differ')
        route,_,state=self.sources._owned(con,token,workspace,by_execution[0])
        if state.get('derived_root_trace_id')!=root or state['execution_id']!=execution or state['task_id']!=task:raise Conflict('Child source is not derived from this root')
        return route,state

    def _member(self,route,state):
        session_json,origin=self.preparations._prior_session(state)
        snapshot=self.sources._load(state.get('snapshot_ref'))
        return {'trace_id':route['trace_id'],'execution_id':state['execution_id'],'task_id':state['task_id'],'source_revision':str(state['source_revision']),
            'snapshot_ref':state.get('snapshot_ref'),'snapshot':snapshot,'completion_at_ms':state.get('completion_at_ms'),'session_json':session_json,'session_origin':origin,'execution_skills':copy.deepcopy(state.get('execution_skills',[]))}

    def context(self,con,token,row,value):
        self.require(con)
        if set(value)!={'scope_kind','scope_key','operation_key','context_hash','children','thread','sweep'} or value['context_hash']!=row['context_hash']:raise Conflict('Collector graph context differs')
        children=value['children'];thread=value['thread'];sweep=value['sweep']
        if not isinstance(children,list) or type(sweep) is not bool:raise ValueError('Collector graph candidates required')
        context={'version':1,'children':[],'retire_candidates':[],'root_execution_skills':[],'thread_id':None,'sweep':sweep}
        workspace=row['workspace_id'];root=row['scope_key']
        state=None
        if row['scope_kind']=='source':
            _,_,state=self.sources._owned(con,token,workspace,root);context['root_execution_skills']=copy.deepcopy(state.get('execution_skills',[]))
        elif children or sweep:raise ValueError('Thread-only preparation cannot derive children')
        seen=set()
        for candidate in children:
            if not isinstance(candidate,dict) or set(candidate)-{'execution_id','task_id','started_at_ms'} or not {'execution_id','task_id'}<=set(candidate):raise ValueError('Derived child identity required')
            execution=identifier(candidate['execution_id']);task=identifier(candidate['task_id'])
            if execution in seen:raise Conflict('Duplicate derived child identity')
            seen.add(execution)
            prior=self._child(con,token,workspace,execution,task,root)
            if prior:
                route,child=prior
                pending=child.get('pending')
                if pending and self.sources._op_state(con,workspace,route['trace_id'],child['operations'][pending])!='indexed':raise CollectorSourcePending('Derived child has an unfinished operation')
                member=self._member(route,child)
            else:member={'trace_id':None,'execution_id':execution,'task_id':task,'source_revision':'0','snapshot_ref':None,'snapshot':None,'session_json':'null','session_origin':'legacy_canonical','execution_skills':[]}
            member['started_at_ms']=_ms(candidate['started_at_ms']) if candidate.get('started_at_ms') is not None else None;context['children'].append(member)
        if state and sweep:
            for execution,trace in sorted(state.get('derived_children',{}).items()):
                if execution in seen:continue
                route,_,child=self.sources._owned(con,token,workspace,trace)
                if child.get('derived_root_trace_id')!=root:raise Conflict('Derived retirement source differs')
                pending=child.get('pending')
                if pending and self.sources._op_state(con,workspace,trace,child['operations'][pending])!='indexed':raise CollectorSourcePending('Derived retirement has an unfinished operation')
                context['retire_candidates'].append(self._member(route,child))
        if thread is not None:
            if not isinstance(thread,dict) or set(thread)!={'framework','source_thread_id'}:raise ValueError('Collector Thread natural identity required')
            framework=identifier(thread['framework']);native=identifier(thread['source_thread_id'])
            prior=con.execute('SELECT thread_id FROM collector_trace_threads WHERE workspace_id=? AND owner_principal_id=? AND framework=? AND source_thread_id=?',(workspace,row['owner_principal_id'],framework,native)).fetchone()
            context['thread_id']=prior[0] if prior else None
        _bounded(context,MAX_PLAN_BYTES);return context

    def _key(self,row,execution,retire=False):return ('retire:' if retire else 'derived:')+_hash([row['scope_key'],row['operation_key'],execution])

    def _reserve_member(self,con,token,row,member,retire):
        workspace=row['workspace_id'];root=row['scope_key'];execution=member['execution_id'];task=member['task_id']
        prior=self._child(con,token,workspace,execution,task,root)
        if prior:
            route,state=prior
            if str(state['source_revision'])!=member['source_revision'] or state.get('snapshot_ref')!=member['snapshot_ref'] or route['trace_id']!=member['trace_id']:raise Conflict('Derived child changed before capture seal')
        elif member['trace_id'] is not None or retire:raise Conflict('Derived child disappeared before capture seal')
        context=self.ingest._load(row['context_ref']);reservation=context['reservation']
        body={'operation':'snapshot','operation_key':self._key(row,execution,retire),'task_id':task,'execution_id':execution,'legacy_username':reservation['provenance']['legacy_username'],
            'framework':reservation['provenance'].get('framework'),'operation_request':{'derived_from':root,'root_operation_key':row['operation_key'],'root_input_hash':row['input_hash'],'retire':retire},'verified_client_id':reservation['provenance'].get('verified_client_id')}
        if member.get('started_at_ms') is not None:body['started_at_ms']=member['started_at_ms']
        reserved=self.sources._reserve(con,token,workspace,body)
        if reserved.get('resume_pending') or reserved['execution_id']!=execution:raise CollectorSourcePending('Derived child operation is not available')
        route,_,state=self.sources._owned(con,token,workspace,reserved['trace_id']);op=state['operations'][_hash(body['operation_key'])]
        if op['stage']!='reserved' or op['base_revision']!=int(member['source_revision']) or op['prior_snapshot_ref']!=member['snapshot_ref']:raise Conflict('Derived capture reservation differs')
        state['derived_root_trace_id']=root;op['preparation_required']=True;op['graph_parent_receipt']={'scope_key':root,'operation_key':row['operation_key'],'input_hash':row['input_hash']}
        self.sources._write(con,workspace,route['trace_id'],state)

    def reserve_capture(self,con,token,row,capture):
        context=capture.get('graph_context')
        if context is None:return
        self.require(con)
        if not isinstance(context,dict) or context.get('version')!=1:raise ValueError('Collector graph capture required')
        for member in context.get('children',[]):self._reserve_member(con,token,row,member,False)
        for member in context.get('retire_candidates',[]):self._reserve_member(con,token,row,member,True)

    def _reserved_member(self,con,token,row,member,retire=False):
        route,state=self._child(con,token,row['workspace_id'],member['execution_id'],member['task_id'],row['scope_key']) or (None,None)
        if route is None:raise Conflict('Derived source reservation missing')
        key=self._key(row,member['execution_id'],retire);slot=_hash(key);op=state['operations'].get(slot)
        if not op or state.get('pending')!=slot or op['stage']!='reserved' or op['base_revision']!=int(member['source_revision']) or state['source_revision']!=op['base_revision'] or op.get('prior_snapshot_ref')!=member['snapshot_ref'] or not op.get('preparation_required'):raise Conflict('Derived source reservation changed')
        return route,state,op

    def _alias(self,con,workspace,execution,owner):
        if not execution:return None
        row=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?",(workspace,execution)).fetchone()
        if row is None:raise Conflict('Thread execution alias unavailable')
        actual=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace,row[0])).fetchone()
        if actual is None or actual[0]!=owner:raise Conflict('Thread execution owner differs')
        return row[0]

    def _thread(self,con,row,plan):
        if not isinstance(plan,dict) or set(plan)!={'thread','create','update','events'}:raise ValueError('Prepared Thread effects required')
        workspace=row['workspace_id'];owner=row['owner_principal_id'];create=plan['create'];update=plan['update'];thread=plan['thread'];events=plan['events']
        if not all(isinstance(v,dict) for v in (create,update,thread)) or not isinstance(events,list):raise ValueError('Prepared Thread fields required')
        context=self.ingest._load(row['context_ref']);user=context['reservation']['provenance']['legacy_username']
        framework=identifier(create.get('framework'));native=identifier(create.get('sourceThreadId'));thread_id=identifier(thread.get('id'))
        if framework!=context['reservation']['provenance'].get('framework'):raise Conflict('Thread framework differs from attested source')
        if create.get('user')!=user or thread.get('user')!=user or thread.get('framework')!=framework or thread.get('sourceThreadId')!=native:raise Conflict('Thread prepared identity differs')
        existing=con.execute('SELECT * FROM collector_trace_threads WHERE workspace_id=? AND owner_principal_id=? AND framework=? AND source_thread_id=?',(workspace,owner,framework,native)).fetchone()
        now=self.control.clock()
        if existing and existing['thread_id']!=thread_id:raise Conflict('Thread natural identity changed')
        fields={'sourceKind':'source_kind','startedAt':'started_at_ms','updatedAt':'updated_at_ms','metadataJson':'metadata_json'}
        selected=update if existing else create;values={}
        for key,destination in fields.items():
            if key in selected:
                value=selected[key]
                if key in ('startedAt','updatedAt') and value is not None:value=_ms(value)
                if key=='metadataJson' and value is not None:
                    if not isinstance(value,str):raise ValueError('Thread metadata JSON string required')
                    json.loads(value)
                values[destination]=value
        if existing:
            if values:
                changed=[key+'=?' for key in values]
                con.execute('UPDATE collector_trace_threads SET '+','.join(changed)+',revision=revision+1,modified_at_ms=? WHERE workspace_id=? AND thread_id=?',(*values.values(),max(now,existing['modified_at_ms']),workspace,thread_id))
        else:
            columns=['workspace_id','thread_id','owner_principal_id','framework','source_thread_id','legacy_username',*values,'created_at_ms','modified_at_ms']
            con.execute('INSERT INTO collector_trace_threads('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',(workspace,thread_id,owner,framework,native,user,*values.values(),now,now))
        event_fields={'kind':'kind','status':'status','sourceTurnId':'source_turn_id','phaseId':'phase_id','startedAt':'started_at_ms','completedAt':'completed_at_ms','payloadJson':'payload_json','executionId':'execution_trace_id','relatedExecutionId':'related_trace_id'}
        for event in events:
            if not isinstance(event,dict):raise ValueError('Thread event object required')
            event_key=event.get('eventKey')
            if not isinstance(event_key,str) or not 1<=len(event_key)<=1024:raise ValueError('Thread event key required')
            identifier(event.get('kind'));_ms(event.get('startedAt'))
            prior=con.execute('SELECT * FROM collector_trace_thread_events WHERE workspace_id=? AND event_key=?',(workspace,event_key)).fetchone()
            if prior and prior['thread_id']!=thread_id:raise Conflict('Thread event belongs to another Thread')
            values={}
            for key,destination in event_fields.items():
                if key not in event:continue
                value=event[key]
                if key in ('startedAt','completedAt') and value is not None:value=_ms(value)
                elif key in ('executionId','relatedExecutionId'):value=self._alias(con,workspace,value,owner)
                elif key=='payloadJson' and value is not None:
                    if not isinstance(value,str):raise ValueError('Thread event payload JSON string required')
                    json.loads(value)
                values[destination]=value
            if prior:
                con.execute('UPDATE collector_trace_thread_events SET '+','.join(key+'=?' for key in values)+',revision=revision+1,modified_at_ms=? WHERE workspace_id=? AND event_key=?',(*values.values(),max(now,prior['modified_at_ms']),workspace,event_key))
            else:
                columns=['workspace_id','event_key','event_id','thread_id',*values,'created_at_ms','modified_at_ms']
                event_id='collector-event:'+_hash([workspace,thread_id,event_key])
                con.execute('INSERT INTO collector_trace_thread_events('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',(workspace,event_key,event_id,thread_id,*values.values(),now,now))
        return thread_id

    def _member_thread(self,con,row,trace,snapshot):
        execution=snapshot['execution'];workspace=row['workspace_id'];thread=execution.get('traceThreadId')
        if not thread:
            con.execute('DELETE FROM collector_trace_thread_executions WHERE workspace_id=? AND trace_id=?',(workspace,trace));return
        head=con.execute('SELECT owner_principal_id FROM collector_trace_threads WHERE workspace_id=? AND thread_id=?',(workspace,thread)).fetchone()
        if head is None or head[0]!=row['owner_principal_id']:raise Conflict('Execution Thread is not owned by its actual actor')
        fields=(thread,row['owner_principal_id'],execution['id'],execution['taskId'],execution.get('sourceExecutionId'),_ms(execution['timestamp']))
        prior=con.execute('SELECT 1 FROM collector_trace_thread_executions WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
        if prior:con.execute('UPDATE collector_trace_thread_executions SET thread_id=?,owner_principal_id=?,execution_id=?,task_id=?,source_execution_id=?,timestamp_ms=? WHERE workspace_id=? AND trace_id=?',(*fields,workspace,trace))
        else:con.execute('INSERT INTO collector_trace_thread_executions VALUES(?,?,?,?,?,?,?,?)',(workspace,trace,*fields))

    def _reconcile(self,con,workspace,thread):
        members=con.execute('SELECT trace_id,source_execution_id FROM collector_trace_thread_executions WHERE workspace_id=? AND thread_id=? ORDER BY trace_id',(workspace,thread)).fetchall()
        by_source={row['source_execution_id']:row['trace_id'] for row in members if row['source_execution_id']}
        if not by_source:return
        for event in con.execute('SELECT * FROM collector_trace_thread_events WHERE workspace_id=? AND thread_id=?',(workspace,thread)).fetchall():
            try:payload=json.loads(event['payload_json']) if event['payload_json'] else {}
            except ValueError:payload={}
            if not isinstance(payload,dict):payload={}
            primary=event['source_turn_id'] or str(payload.get('previousSourceExecutionId') or '');related=str(payload.get('relatedSourceExecutionId') or payload.get('nextSourceExecutionId') or '')
            values={}
            if primary in by_source and event['execution_trace_id']!=by_source[primary]:values['execution_trace_id']=by_source[primary]
            if related in by_source and event['related_trace_id']!=by_source[related]:values['related_trace_id']=by_source[related]
            if values:con.execute('UPDATE collector_trace_thread_events SET '+','.join(key+'=?' for key in values)+',revision=revision+1,modified_at_ms=? WHERE workspace_id=? AND event_key=?',(*values.values(),max(self.control.clock(),event['modified_at_ms']),workspace,event['event_key']))

    def _session_marker(self,state,text):
        parsed=json.loads(text);session=self.sources._load(state.get('session_ref'))
        if _hash(parsed)!=_hash(session):raise Conflict('Child serialized Session differs')
        text_hash=hashlib.sha256(text.encode('utf-8')).hexdigest();text_ref=self.preparations._persist_text(text)
        state['prepared_session']={'source_revision':state['source_revision'],'snapshot_ref':state.get('snapshot_ref'),'session_hash':_hash(session),'text_ref':text_ref,'text_hash':text_hash}

    def _retire(self,con,row,route,state,op):
        if state.get('derived_root_trace_id')!=row['scope_key']:raise Conflict('Only this root can retire its derived execution')
        snapshot=self.sources._load(state.get('snapshot_ref'))
        if snapshot and (snapshot['execution'].get('isSubagent') is not True or snapshot['execution'].get('rootExecutionId')!=self.ingest._load(row['context_ref'])['reservation']['execution_id']):raise Conflict('Derived retirement execution boundary differs')
        prior_text,_=self.preparations._prior_session(state);sources=[]
        for key,entity in state['entities'].items():
            if not entity.get('active'):continue
            head=self.sources.control_artifact_head(row['workspace_id'],route['trace_id'],entity['span_id']);source=self.ingest._load(head['artifact_ref'])
            if _hash(source)!=entity['content_hash']:raise Conflict('Derived retirement source differs')
            source['row']['is_deleted']=1;source['source_revision']=str(entity['source_revision']+1);state['entities'][key]={**entity,'source_revision':entity['source_revision']+1,'content_hash':_hash(source),'active':False};sources.append(source)
        state['snapshot_ref']=None;state['execution_retired']=True;state['source_revision']+=1;state['primary_count']=0
        op.update(stage='committed',source_revision=state['source_revision'],snapshot_ref=None,snapshot_hash=_hash(None),prepared_plan_hash=row['plan_hash']);op['batch_refs']=self.sources._enqueue(con,row['workspace_id'],route['trace_id'],state,op,sources)
        self._session_marker(state,prior_text)
        con.execute('DELETE FROM collector_trace_thread_executions WHERE workspace_id=? AND trace_id=?',(row['workspace_id'],route['trace_id']))

    def apply(self,con,token,row,plan,capture):
        self.require(con)
        if self.applied(con,row):return
        graph=capture.get('graph_context')
        if not isinstance(graph,dict) or graph.get('version')!=1:raise CollectorSourcePending('Collector graph capture is not sealed')
        children=plan.get('children',[])
        if not isinstance(children,list):raise ValueError('Collector children array required')
        expected={child['execution_id']:child for child in graph.get('children',[])}
        if len(children)!=len(expected):raise Conflict('Collector child plan differs from capture')
        row_context=self.ingest._load(row['context_ref']);root_execution=row_context['reservation']['execution_id'];workspace=row['workspace_id'];prepared=[];ids={root_execution}|set(expected)
        for child in children:
            if not isinstance(child,dict) or not isinstance(child.get('snapshot'),dict):raise ValueError('Collector child snapshot required')
            execution=child['snapshot']['execution'];identity=execution.get('id');member=expected.get(identity)
            if not member or execution.get('taskId')!=member['task_id'] or execution.get('isSubagent') is not True or execution.get('rootExecutionId')!=root_execution or execution.get('parentExecutionId') not in ids or identity!=execution['parentExecutionId']+'__sub__'+member['task_id']:raise Conflict('Collector derived child graph differs')
            if execution.get('user')!=row_context['reservation']['provenance']['legacy_username']:raise Conflict('Collector derived child owner differs')
            route,state,op=self._reserved_member(con,token,row,member);prepared.append((child,route,state,op))
        if bool(plan.get('retire_missing_children'))!=bool(graph.get('sweep')):raise Conflict('Collector retirement plan differs')
        retired=[self._reserved_member(con,token,row,member,True) for member in graph.get('retire_candidates',[])]
        touched=set();thread=plan.get('thread')
        if thread:touched.add(self._thread(con,row,thread))
        if row['scope_kind']=='thread':
            if children or retired or plan.get('snapshot') is not None:raise ValueError('Thread-only effects cannot contain Trace facts')
            for identity in touched:self._reconcile(con,workspace,identity)
            self._record_applied(con,row);return
        root_route,_,root_state=self.sources._owned(con,token,workspace,row['scope_key']);root_op=root_state['operations'][_hash(row['operation_key'])]
        if root_op['stage']!='reserved':raise Conflict('Collector graph root was committed outside its plan')
        self.preparations._apply_source(con,row,root_route,root_state,root_op,plan)
        members=[(root_route,root_state,root_op)]
        root_snapshot=self.sources._load(root_state.get('snapshot_ref'))
        if root_snapshot:self._member_thread(con,row,row['scope_key'],root_snapshot)
        for child,route,state,op in prepared:
            self.preparations._apply_source(con,row,route,state,op,child)
            state['execution_skills']=copy.deepcopy(child.get('execution_skills',child.get('skills',[])));state['execution_retired']=False
            self._session_marker(state,child['serialized_session_json']);self._member_thread(con,row,route['trace_id'],child['snapshot']);members.append((route,state,op))
        for route,state,op in retired:self._retire(con,row,route,state,op);members.append((route,state,op))
        if plan.get('retire_missing_children'):root_state['derived_children']={child['snapshot']['execution']['id']:route['trace_id'] for child,route,_,_ in prepared}
        else:root_state.setdefault('derived_children',{}).update({child['snapshot']['execution']['id']:route['trace_id'] for child,route,_,_ in prepared})
        root_state['execution_skills']=copy.deepcopy(plan.get('execution_skills',plan.get('root_skills',root_state.get('execution_skills',[]))))
        vector={'version':1,'root_receipt':{key:row[key] for key in ('scope_kind','scope_key','operation_key','owner_principal_id','plan_hash')},'members':[{'trace_id':route['trace_id'],'operation_key':op['operation_key'],'input_hash':op['input_hash'],'actor_id':op['actor_id'],'batch_refs':copy.deepcopy(op['batch_refs'])} for route,state,op in members]}
        _,graph_ref=self.ingest._persist(vector)
        for route,state,op in members:
            op['graph_ref']=graph_ref
            if not any(member['batch_refs'] for member in vector['members']):state['pending']=None
            elif state.get('pending') is None:state['pending']=_hash(op['operation_key'])
            self.sources._write(con,workspace,route['trace_id'],state)
        for identity in touched:self._reconcile(con,workspace,identity)
        self._record_applied(con,row)
