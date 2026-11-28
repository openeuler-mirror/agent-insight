import copy
import json

from .collector_sources import CollectorSources, NAMESPACE, indexed_boundary, _iso, _ms, _hash, CollectorSourcePending
from .collector_preparations import CollectorPreparations
from .iam import Forbidden
from .control import Conflict


class CollectorPublic:
    def __init__(self,control,ingest):
        self.control=control;self.ingest=ingest;self.sources=CollectorSources(control,ingest);self.iam=ingest.iam;self.preparations=CollectorPreparations(control,ingest)

    def _route(self,con,workspace,reference):
        aliases=con.execute('SELECT DISTINCT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=?',(workspace,reference)).fetchall()
        if len(aliases)>1:raise Conflict('Collector alias is ambiguous')
        trace=aliases[0][0] if aliases else reference
        row=con.execute('SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=?',(workspace,trace)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def _identity_hash(con,workspace,route,owner):
        aliases=[dict(row) for row in con.execute('SELECT alias_kind,alias_id FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=? ORDER BY alias_kind,created_at_ms,alias_id',(workspace,route['trace_id']))]
        return _hash({'route':route,'owner':owner,'aliases':aliases})

    def _read(self,con,token,workspace,reference):
        scope=self.iam._scope(con,token);self.iam._workspace(scope,workspace,'read')
        route=self._route(con,workspace,reference)
        if not route:return None
        self.iam._authorize(con,token,workspace,'read','trace',route['trace_id'])
        if route['state']!='active':raise Forbidden('Trace route is not active')
        if route['source_namespace']!=NAMESPACE:return None
        annotation,_,state=self.sources._state(con,workspace,route['trace_id'])
        if not isinstance(state,dict):raise CollectorSourcePending('Collector source is unavailable')
        owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace,route['trace_id'])).fetchone()
        if not owner or owner[0]!=state.get('actor_id'):raise CollectorSourcePending('Collector owner differs')
        indexed_boundary(self.control,workspace,[route])
        identity_hash=self._identity_hash(con,workspace,route,owner[0])
        snapshot=self.sources._load(state.get('snapshot_ref'))
        execution=copy.deepcopy(snapshot['execution']) if snapshot and not state.get('execution_retired') else None
        text,_=self.preparations._prior_session(state);session=json.loads(text)
        if session is not None:
            if not isinstance(session,dict) or not isinstance(session.get('interactions'),list):raise CollectorSourcePending('Collector Session is invalid')
            session['user']=state['legacy_username']
            extra=json.loads(annotation['extra_json']) if annotation else {};overrides=extra.get('override_fields',[])
            for key,column in [('label','label'),('query','query_override')]:
                if key in overrides:session[key]=annotation[column]
            # The first Node string is used until an explicit user override changes its fields.
            if json.loads(text)!=session:text=json.dumps(session,ensure_ascii=False,separators=(',',':'))
        can_write=scope.principal_id==state['actor_id'] and 'write' in scope.capabilities
        if can_write:
            try:self.iam._workspace(scope,workspace,'write')
            except Forbidden:can_write=False
        can_execute=can_write and 'execute' in scope.capabilities
        if can_execute:
            try:self.iam._workspace(scope,workspace,'execute')
            except Forbidden:can_execute=False
        return {'collector':True,'trace_id':route['trace_id'],'identity_hash':identity_hash,'source_revision':str(state['source_revision']),'annotation_revision':str(annotation['revision']) if annotation else '0','session_json':text,'execution':execution,'can_write':can_write,'can_execute':can_execute,'owner_principal_id':state['actor_id'],'execution_skills':copy.deepcopy(state.get('execution_skills',[]))},state

    def _thread(self,con,token,workspace,execution):
        identity=execution.get('traceThreadId') if execution else None
        if not identity:return None
        head=con.execute('SELECT * FROM collector_trace_threads WHERE workspace_id=? AND thread_id=?',(workspace,identity)).fetchone()
        if not head:return None
        members=[]
        for row in con.execute('SELECT * FROM collector_trace_thread_executions WHERE workspace_id=? AND thread_id=? ORDER BY timestamp_ms,trace_id',(workspace,identity)):
            try:value=self._read(con,token,workspace,row['trace_id'])
            except Forbidden:continue
            if value and value[0]['execution']:members.append(dict(row))
        tasks={row['trace_id']:row['task_id'] or row['execution_id'] for row in members}
        current=next((i for i,row in enumerate(members) if row['execution_id']==execution['id']),-1)
        result={'id':identity,'events':[]}
        if head['source_kind']:result['sourceKind']=head['source_kind']
        if current>0:result['previousExecutionId']=tasks[members[current-1]['trace_id']]
        if 0<=current<len(members)-1:result['nextExecutionId']=tasks[members[current+1]['trace_id']]
        for event in con.execute('SELECT * FROM collector_trace_thread_events WHERE workspace_id=? AND thread_id=? ORDER BY started_at_ms,event_key',(workspace,identity)):
            visible=True
            for key in ('execution_trace_id','related_trace_id'):
                if event[key] and event[key] not in tasks:
                    try:self.iam._authorize(con,token,workspace,'read','trace',event[key])
                    except Forbidden:visible=False
            if not visible:continue
            item={'id':event['event_id'],'kind':event['kind'],'startedAt':_iso(event['started_at_ms'])}
            for column,key in [('status','status'),('source_turn_id','sourceTurnId'),('phase_id','phaseId')]:
                if event[column]:item[key]=event[column]
            if event['completed_at_ms'] is not None:item['completedAt']=_iso(event['completed_at_ms'])
            for column,key in [('execution_trace_id','executionId'),('related_trace_id','relatedExecutionId')]:
                if event[column] in tasks:item[key]=tasks[event[column]]
            if event['payload_json']:
                payload=json.loads(event['payload_json'])
                if isinstance(payload,dict):item['payload']=payload
            result['events'].append(item)
        return result

    def session(self,token,workspace,reference):
        with self.control.read_transaction() as con:
            value=self._read(con,token,workspace,reference)
            if value is None:return {'collector':False}
            result,state=value;result['thread']=self._thread(con,token,workspace,result['execution'])
            return result

    def relations(self,token,workspace,task_ids):
        if not isinstance(task_ids,list) or len(task_ids)>256 or any(not isinstance(item,str) for item in task_ids):raise ValueError('Bounded Session identities required')
        result={}
        with self.control.read_transaction() as con:
            def reference(execution):
                value=self._read(con,token,workspace,execution)
                if not value or not value[0]['execution']:return {'state':'pending'}
                row=value[0]['execution'];session=json.loads(value[0]['session_json'])
                if session is None:return {'state':'pending'}
                item={'state':'resolved','taskId':row['taskId'],'executionId':row['id'],'agentName':row.get('agentName') or row.get('subagentName') or row.get('framework') or 'Agent','framework':row.get('framework')}
                stats={key:row[field] for key,field in [('durationMs','latency'),('totalTokens','tokens')] if row.get(field) is not None}
                if stats:item['stats']=stats
                return item
            for task in task_ids:
                value=self._read(con,token,workspace,task);relation={'parent':None,'children':[]};result[task]=relation
                if not value or not value[0]['execution']:continue
                execution=value[0]['execution'];state=value[1];parent=execution.get('parentExecutionId')
                if parent:
                    try:relation['parent']=reference(parent)
                    except Forbidden:relation['parent']={'state':'unavailable'}
                root=state.get('derived_root_trace_id',value[0]['trace_id']);_,_,root_state=self.sources._state(con,workspace,root)
                for child in (root_state or {}).get('derived_children',{}):
                    try:
                        candidate=self._read(con,token,workspace,child)
                        if candidate and candidate[0]['execution'] and candidate[0]['execution'].get('parentExecutionId')==execution['id']:relation['children'].append(reference(child))
                    except Forbidden:continue
        return result

    def owned_session(self,token,workspace,task):
        with self.control.read_transaction() as con:
            self.sources._scope(con,token,workspace)
            route=self._route(con,workspace,task)
            if not route:return None
            route,_,state=self.sources._owned(con,token,workspace,route['trace_id'])
            pending=state.get('pending')
            if pending and state['operations'][pending]['stage']=='committed' and self.sources._op_state(con,workspace,route['trace_id'],state['operations'][pending])!='indexed':raise CollectorSourcePending('Session is not indexed')
            text,origin=self.preparations._prior_session(state)
            return {'trace_id':route['trace_id'],'source_revision':str(state['source_revision']),'session_json':text,'session_origin':origin,'execution':self.sources._load(state.get('snapshot_ref'))}

    def mutate_session(self,token,workspace,value):
        if not isinstance(value,dict) or set(value)-{'operation_key','task_id','legacy_username','mode','changes','expected_revision','expected_annotation_revision','session_json'} or value.get('mode') not in ('create','patch','append'):raise ValueError('Session mutation required')
        changes=value.get('changes')
        if not isinstance(changes,dict) or set(changes)-{'label','query','model','startTime','endTime','interaction','interactions'}:raise ValueError('Session fields required')
        with self.control.transaction(('collector', workspace), ('trace', workspace), ('ingest', workspace)) as con:
            signature=_hash({key:value.get(key) for key in ('operation_key','task_id','legacy_username','mode','changes')})
            prior_route=self._route(con,workspace,value['task_id'])
            if prior_route:
                prior_annotation,_,prior_state=self.sources._state(con,workspace,prior_route['trace_id'])
                self.sources._owned(con,token,workspace,prior_route['trace_id'])
                previous=prior_state['operations'].get(_hash(value['operation_key']))
                if previous:
                    if previous.get('mutation_request_hash')!=signature:raise Conflict('Session mutation operation differs')
                    return {'state':self.sources._op_state(con,workspace,prior_route['trace_id'],previous),'session':self.sources._load(previous.get('session_ref')),'source_revision':str(previous['source_revision'])}
                if value.get('expected_annotation_revision') is not None and str(prior_annotation['revision'] if prior_annotation else 0)!=str(value['expected_annotation_revision']):raise Conflict('Session annotation changed before publication')
            reservation=self.sources._reserve(con,token,workspace,{'operation':'snapshot','operation_key':value['operation_key'],'task_id':value['task_id'],'execution_id':value['task_id'],'legacy_username':value['legacy_username'],'operation_request':value})
            route,_,state=self.sources._owned(con,token,workspace,reservation['trace_id']);op=state['operations'][_hash(reservation['operation_key'])]
            if reservation.get('resume_pending'):raise CollectorSourcePending('Session has an earlier pending operation')
            if op['stage']!='reserved':return {'state':self.sources._op_state(con,workspace,route['trace_id'],op),'session':self.sources._load(state.get('session_ref')),'source_revision':str(state['source_revision'])}
            if op.get('preparation_required'):raise Conflict('Session mutation cannot replace a prepared snapshot')
            if value.get('expected_revision') is not None and str(value['expected_revision'])!=str(state['source_revision']):raise Conflict('Session changed before append')
            snapshot=self.sources._load(state.get('snapshot_ref'));session=copy.deepcopy(snapshot['session']) if snapshot else self.sources._load(state.get('session_ref'))
            if value['mode']=='create' and session is not None:raise Conflict('Session already exists')
            if session is None:session={'taskId':state['task_id'],'label':None,'query':None,'model':None,'user':state['legacy_username'],'startTime':_iso(op['received_at_ms']),'endTime':None,'interactions':[]}
            if value['mode']=='append':
                if 'interaction' not in changes:raise ValueError('Session interaction required')
                session['interactions'].append(copy.deepcopy(changes['interaction']))
            else:
                for key,item in changes.items():
                    if key=='interaction':raise ValueError('Use append for interactions')
                    if key in ('startTime','endTime'):
                        if item=='server':item=_iso(op['received_at_ms'])
                        elif item is not None:item=_iso(_ms(item))
                    if key=='interactions' and not isinstance(item,list):raise ValueError('Session interactions array required')
                    session[key]=copy.deepcopy(item)
            session['user']=state['legacy_username'];text=value.get('session_json')
            if text is not None:
                from .collector_preparations import _text
                from .collector_sources import MAX_INPUT_BYTES
                parsed,_=_text(text,MAX_INPUT_BYTES)
                if _hash(parsed)!=_hash(session):raise Conflict('Serialized Session mutation differs')
            else:text=json.dumps(session,ensure_ascii=False,separators=(',',':'))
            sources=[]
            if snapshot is not None:
                snapshot['session']=session;snapshot,framework=self.sources._snapshot(state,op,snapshot);state['framework']=framework
                sources=self.sources._sources(workspace,route,snapshot,state);_,state['snapshot_ref']=self.ingest._persist(snapshot)
            _,state['session_ref']=self.ingest._persist(session);state['source_revision']+=1
            state['prepared_session']={'source_revision':state['source_revision'],'snapshot_ref':state.get('snapshot_ref'),'session_hash':_hash(session),'text_ref':self.preparations._persist_text(text),'text_hash':__import__('hashlib').sha256(text.encode()).hexdigest()}
            op.update(stage='committed',source_revision=state['source_revision'],snapshot_ref=state.get('snapshot_ref'),session_ref=state['session_ref'],mutation_request_hash=signature,snapshot_hash=_hash(snapshot));op['batch_refs']=self.sources._enqueue(con,workspace,route['trace_id'],state,op,sources)
            if not op['batch_refs']:state['pending']=None
            self.sources._write(con,workspace,route['trace_id'],state)
            return {'state':self.sources._op_state(con,workspace,route['trace_id'],op),'session':session,'source_revision':str(state['source_revision']),'trace_id':route['trace_id'],'operation_key':op['operation_key']}

    def jobs(self,token,workspace,action,value):
        from .collector_jobs import CollectorJobs
        return CollectorJobs(self).dispatch(token,workspace,action,value)

    def logs(self,token,workspace,action,value):
        from .collector_logs import CollectorLogs
        return CollectorLogs(self).dispatch(token,workspace,action,value)

    def query_sessions(self,token,workspace,value,*,owned=False):
        if not isinstance(value,dict) or set(value)-{'references','agent_session_ids','prefix','framework','legacy_username','limit','include_session'}:raise ValueError('Trace source query required')
        refs=value.get('references',[]);agents=value.get('agent_session_ids',[]);limit=value.get('limit',200)
        if not isinstance(refs,list) or not isinstance(agents,list) or len(refs)>2000 or len(agents)>256 or type(limit) is not int or not 1<=limit<=2000:raise ValueError('Bounded source query required')
        with self.control.read_transaction() as con:
            scope=self.sources._scope(con,token,workspace) if owned else self.iam._scope(con,token)
            self.iam._workspace(scope,workspace,'write' if owned else 'read');params=[workspace,NAMESPACE];where=''
            if owned:where+=' AND a.owner_principal_id=?';params.append(scope.principal_id)
            if refs:
                if any(not isinstance(item,str) for item in refs):raise ValueError('Trace identities required')
                marks=','.join('?' for _ in refs);where+=' AND (t.trace_id IN ('+marks+') OR EXISTS(SELECT 1 FROM trace_legacy_ids x WHERE x.workspace_id=t.workspace_id AND x.trace_id=t.trace_id AND x.alias_id IN ('+marks+')))';params.extend(refs);params.extend(refs)
            prefix=value.get('prefix')
            if prefix is not None:
                if not isinstance(prefix,str) or len(prefix)>512:raise ValueError('Trace prefix required')
                where+=" AND EXISTS(SELECT 1 FROM trace_legacy_ids x WHERE x.workspace_id=t.workspace_id AND x.trace_id=t.trace_id AND x.alias_kind='task' AND substr(x.alias_id,1,?)=?)";params.extend([len(prefix),prefix])
            rows=con.execute("SELECT t.trace_id FROM trace_locators t JOIN iam_resource_access a ON a.workspace_id=t.workspace_id AND a.resource_kind='trace' AND a.resource_id=t.trace_id WHERE t.workspace_id=? AND t.source_namespace=? AND t.state='active'"+where+' ORDER BY t.created_at_ms DESC,t.trace_id',tuple(params));result=[]
            for route in rows:
                if owned:
                    actual,_,state=self.sources._owned(con,token,workspace,route[0]);indexed_boundary(self.control,workspace,[actual]);text,_=self.preparations._prior_session(state);snapshot=self.sources._load(state.get('snapshot_ref'));entry={'collector':True,'trace_id':route[0],'source_revision':str(state['source_revision']),'session_json':text,'execution':snapshot['execution'] if snapshot and not state.get('execution_retired') else None,'execution_skills':copy.deepcopy(state.get('execution_skills',[]))}
                else:
                    try:read=self._read(con,token,workspace,route[0])
                    except Forbidden:continue
                    if not read:continue
                    entry,state=read
                execution=entry['execution'];session=json.loads(entry['session_json'])
                if value.get('legacy_username') and state.get('legacy_username')!=value['legacy_username']:continue
                if value.get('framework') and (execution or {}).get('framework')!=value['framework']:continue
                if agents and not((execution and (execution.get('agentSessionId') in agents or execution.get('taskId') in agents)) or session and session.get('taskId') in agents):continue
                if value.get('include_session') is False:entry['session_json']=None;entry['session_exists']=session is not None;entry['start_time']=session.get('startTime') if session else None
                result.append(entry)
                if len(result)>=limit:break
            return result

    def normalize_history(self,token,workspace,value):
        framework=value.get('framework');primary=value.get('primary_agent_name');codex=value.get('codex') is True
        if not isinstance(framework,str) or (not codex and not isinstance(primary,str)):raise ValueError('Framework normalization required')
        with self.control.transaction(('collector', workspace), ('trace', workspace), ('ingest', workspace)) as con:
            scope=self.sources._scope(con,token,workspace);count=0
            rows=con.execute("SELECT t.* FROM trace_locators t JOIN iam_resource_access a ON a.workspace_id=t.workspace_id AND a.resource_kind='trace' AND a.resource_id=t.trace_id WHERE t.workspace_id=? AND t.source_namespace=? AND t.state='active' AND a.owner_principal_id=? ORDER BY t.trace_id",(workspace,NAMESPACE,scope.principal_id)).fetchall()
            for row in rows:
                route,_,state=self.sources._owned(con,token,workspace,row['trace_id']);snapshot=self.sources._load(state.get('snapshot_ref'))
                if not snapshot or state.get('execution_retired') or snapshot['execution'].get('framework')!=framework:continue
                pending=state.get('pending')
                if pending and self.sources._op_state(con,workspace,row['trace_id'],state['operations'][pending])!='indexed':raise CollectorSourcePending('Framework history has a pending source')
                execution=snapshot['execution'];changed=False
                if codex:
                    if execution.get('isSubagent') or execution.get('query')!='Codex Session':continue
                    if all(execution.get(key)==0 for key in ('tokens','latency','toolCallCount','llmCallCount')) and execution.get('finalResult')=='':
                        from .collector_graphs import CollectorGraphs
                        key='history-retire:'+_hash([state['source_revision'],framework]);body={'operation':'snapshot','operation_key':key,'task_id':state['task_id'],'execution_id':state['execution_id'],'framework':framework,'legacy_username':state['legacy_username'],'operation_request':{'codex_retire':True,'source_revision':state['source_revision']}}
                        reserved=self.sources._reserve(con,token,workspace,body);route,_,current=self.sources._owned(con,token,workspace,reserved['trace_id']);op=current['operations'][_hash(key)]
                        CollectorGraphs(self.preparations)._retire(con,{'workspace_id':workspace,'scope_key':route['trace_id'],'plan_hash':_hash(body)},route,current,op,derived_only=False)
                        self.sources._write(con,workspace,row['trace_id'],current);count+=1;continue
                    if any((execution.get(key) or 0)>0 for key in ('tokens','latency','toolCallCount','llmCallCount')) or execution.get('finalResult')!='':execution['query']='Codex execution';changed=True
                elif execution.get('agentName')!=primary or execution.get('observedAgents')!=[primary]:execution['agentName']=primary;execution['observedAgents']=[primary];changed=True
                if not changed:continue
                key='history:'+_hash([state['source_revision'],framework,primary,codex]);body={'operation':'snapshot','operation_key':key,'task_id':state['task_id'],'execution_id':state['execution_id'],'framework':framework,'legacy_username':state['legacy_username'],'operation_request':{'normalization':value,'source_revision':state['source_revision']}}
                reserved=self.sources._reserve(con,token,workspace,body);route,_,current=self.sources._owned(con,token,workspace,reserved['trace_id']);op=current['operations'][_hash(key)]
                plan={'snapshot':snapshot,'serialized_session_json':self.preparations._prior_session(state)[0]};self.preparations._apply_source(con,{'workspace_id':workspace,'plan_hash':_hash(plan)},route,current,op,plan);self.sources._write(con,workspace,route['trace_id'],current);count+=1
            return {'updated':count}

    def model_scope(self,token,workspace,value):
        with self.control.read_transaction() as con:
            scope=self.sources._scope(con,token,workspace);self.iam._workspace(scope,workspace,'execute')
            if value.get('task_id'):
                route=self._route(con,workspace,value['task_id'])
                if not route:raise Forbidden('Model source is unavailable')
                self.sources._owned(con,token,workspace,route['trace_id'])
            return {'authorized':True,'principal_id':scope.principal_id,'workspace_id':workspace}
