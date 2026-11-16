import collections
import datetime
import json
import math

from .iam import Forbidden
from .control import StorageError


class CompatibilityListLimit(StorageError):
    status=413


def _number(value):
    if value is None:return None
    try:
        number=float(value)
        return number if math.isfinite(number) else None
    except (ValueError,TypeError):return None


def _integer(value):
    if value is None:return None
    number=int(value)
    return number if abs(number)<=9007199254740991 else str(number)


def _milliseconds(value):
    if isinstance(value,(int,float)):return value
    return datetime.datetime.fromisoformat(str(value).replace('Z','+00:00')).timestamp()*1000


def _flag(value):return value in ('1','true',True)


class LegacyTraceList:
    def __init__(self,queries,metadata=None,*,analytics=None):
        self.queries=queries;self.control=queries.control;self.iam=queries.iam;self.metadata=metadata;self.analytics=analytics

    def _records(self,token,workspace,trace_ids=None):
        from .experiments import ExperimentStore
        from .trace_outcome import _lookup_tx
        from .trace_outcome_projection import overlay_record
        outcome_store=ExperimentStore(self.control)
        from .trace_analytics import MAX_EXECUTION_SOURCE_BYTES
        from .execution_metadata import record_fields
        cursor=None;result=[];scope=self.iam.scope(token);source_budget={'remaining':MAX_EXECUTION_SOURCE_BYTES};boundaries={}
        self.iam._workspace(scope,workspace,'read')
        if trace_ids is not None:trace_ids=sorted(trace_ids)
        while True:
            if trace_ids is None:page=self.queries.list_traces(token,workspace,limit=200,cursor=cursor)
            else:
                offset=cursor or 0;items=[]
                for trace in trace_ids[offset:offset+200]:
                    route=self.queries.route(token,workspace,trace)
                    row=self.queries.summary(token,workspace,trace)['trace']
                    if row is not None:
                        if row['trace_bucket']!=route['trace_bucket']:raise Forbidden('Trace route changed during compatibility read')
                        items.append(dict(row,created_at_ms=route['created_at_ms']))
                page={'items':items,'next_cursor':offset+200 if offset+200<len(trace_ids) else None}
            captured={}
            if self.analytics and page['items']:
                with self.control.read_transaction() as con:
                    selections=[{'trace_id':row['trace_id'],'boundary':self.analytics._boundary(con,token,workspace,row['trace_id'],scope)[0]} for row in page['items']]
                snapshot=self.analytics.execution_metadata(token,workspace,selections,source_budget=source_budget)
                captured={row['trace_id']:row for row in snapshot['items']}
                boundaries.update({row['trace_id']:row['boundary'] for row in snapshot['items']})
            with self.control.read_transaction() as con:
                for row in page['items']:
                    owner=con.execute('SELECT normalized_login_name FROM iam_principals WHERE principal_id=?',(row['owner_principal_id'],)).fetchone()
                    properties=self.metadata.properties(token,workspace,row['trace_id']) if self.metadata else {}
                    aliases=self.metadata.resolve(token,workspace,row['trace_id']) if self.metadata else {'task_id':row['trace_id'],'execution_id':row['trace_id']}
                    tags=self.metadata.get_trace_tags(token,workspace,row['trace_id']) if self.metadata else []
                    metadata=json.loads(row.get('attributes_json') or '{}')
                    if not isinstance(metadata,dict):raise ValueError('invalid Trace metadata')
                    start=row.get('started_at_ms')
                    timestamp=int(start if start is not None else row.get('created_at_ms',0))
                    end=_number(row.get('ended_at_ms'))
                    latency=max(0,end-float(start)) if end is not None and start is not None else None
                    it=_integer(row.get('input_tokens'));ot=_integer(row.get('output_tokens'))
                    tokens=_integer(int(it)+int(ot)) if it is not None and ot is not None else None
                    status={'done':'completed','failed':'failed','running':'in_progress','unknown':'unknown'}.get(row.get('execution_status'),'unknown')
                    trace_status={'completed':'success','failed':'failed','in_progress':'running'}.get(status,'unknown')
                    record={
                        'task_id':aliases['task_id'],'upload_id':aliases['execution_id'],'user':owner[0] if owner else row['owner_principal_id'],
                        'agentName':row.get('agent_name') or '', 'agent':row.get('agent_name') or '', 'framework':row.get('framework') or '',
                        'timestamp':datetime.datetime.fromtimestamp(timestamp/1000,datetime.timezone.utc).isoformat().replace('+00:00','Z'),
                        'execution_status':status,'executionStatus':status,'trace_status':trace_status,
                        'trace_completed_at':datetime.datetime.fromtimestamp(end/1000,datetime.timezone.utc).isoformat().replace('+00:00','Z') if end is not None else None,
                        'tokens':tokens,'input_tokens':it,'output_tokens':ot,'latency':latency,'cost':_number(row.get('cost_decimal')),
                        'span_count':_integer(row.get('span_count')),'llm_call_count':_integer(row.get('llm_call_count')),
                        'tool_call_count':_integer(row.get('tool_call_count')),'tool_call_error_count':metadata.get('tool_error_count'),
                        'query':properties.get('query') if 'query' in properties.get('override_fields',[]) else metadata.get('query'),'label':properties.get('label') if 'label' in properties.get('override_fields',[]) else metadata.get('label'),
                        'final_result':properties.get('final_result') if 'final_result' in properties.get('override_fields',[]) else metadata.get('final_result'),'user_feedback':properties.get('user_feedback'),
                        'model':metadata.get('model'),'observedIp':metadata.get('observed_ip'),'source_kind':metadata.get('source_kind','otlp'),
                        'agentOwnership':metadata.get('ownership','user'),'invoked_skills':metadata.get('invoked_skills',[]),
                        'agents':metadata.get('agents',[]),'subagent_name':metadata.get('subagent_name'),'subagent_type':metadata.get('subagent_type'),'agent_session_id':metadata.get('agent_session_id'),
                        'skills':metadata.get('skills',[]),'is_subagent':metadata.get('is_subagent',False),
                        'parent_execution_id':metadata.get('parent_execution_id'),'root_execution_id':metadata.get('root_execution_id'),
                        'anomaly_status':properties.get('anomaly_status',metadata.get('anomaly_status','unknown')),
                        'userTags':tags,'_trace_id':row['trace_id'],
                    }
                    metrics=metadata.get('legacy_execution_metrics',{})
                    if not isinstance(metrics,dict):raise ValueError('invalid captured execution metrics')
                    for key in ('cost','latency','tool_call_count','tool_call_error_count'):
                        if key in metrics:record[key]=_number(metrics[key]) if key in ('cost','latency') else metrics[key]
                    record['is_answer_correct']=metrics.get('is_answer_correct')
                    record['has_failures']=metrics.get('has_failures')
                    record['trace_started_at']=metrics.get('session_start') if metrics.get('session_captured') else record['timestamp']
                    if metrics.get('session_captured'):record['trace_completed_at']=metrics.get('session_end')
                    if row['trace_id'] in captured:record.update(record_fields(captured[row['trace_id']]['execution']))
                    if 'invokedSkills' not in record:record['invokedSkills']=record.get('invoked_skills')
                    current=_lookup_tx(outcome_store,con,token,workspace,{'trace_ref':row['trace_id']})
                    record=overlay_record(record,current);record['_outcome_selection']=current['selection_hash']
                    projection=current['outcome']['value'].get('record_projection') if current.get('outcome') else None
                    if self.analytics and isinstance(projection,dict):
                        if 'skill' in projection:record['_source_skill']=projection['skill'];record['_source_skill_version']=projection.get('skill_version')
                        if 'invokedSkills' in projection:
                            record['_execution_relations']=[{'skillName':item['name'],'skillVersion':item.get('version')} for item in projection['invokedSkills'] or []]
                    result.append(record)
            if len(result)>100000:raise CompatibilityListLimit('narrow the legacy query scope')
            cursor=page.get('next_cursor')
            if not cursor:break
        self._recheck(token,workspace,scope,[row['_trace_id'] for row in result],{row['_trace_id']:row['_outcome_selection'] for row in result},boundaries)
        for row in result:row['_execution_boundary']=boundaries.get(row['_trace_id'])
        return result,scope

    def _recheck(self,token,workspace,scope,trace_ids=(),outcomes=None,boundaries=None):
        from .experiments import ExperimentStore
        from .trace_outcome import _lookup_tx
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,workspace,'read')
            if current.fingerprint!=scope.fingerprint:raise Forbidden('authorization changed during compatibility read')
            for start in range(0,len(trace_ids),500):
                roots=trace_ids[start:start+500]
                marks=','.join('?' for _ in roots)
                count=con.execute("SELECT COUNT(*) FROM trace_locators WHERE workspace_id=? AND state='active' AND trace_id IN ("+marks+")",tuple([workspace,*roots])).fetchone()[0]
                if count!=len(roots):raise Forbidden('Trace deletion changed during compatibility read')
            store=ExperimentStore(self.control)
            for trace,selection in (outcomes or {}).items():
                if _lookup_tx(store,con,token,workspace,{'trace_ref':trace})['selection_hash']!=selection:
                    from .control import Conflict
                    raise Conflict('Outcome selection changed during Trace list read')
        if self.analytics and boundaries:self.analytics._recheck(token,workspace,scope,boundaries)

    @staticmethod
    def _value(row,column):
        names={'agent':'agentName','status':'trace_status','ownership':'agentOwnership','sourceKind':'source_kind','toolCallCount':'tool_call_count','llmCallCount':'llm_call_count','isSubagent':'is_subagent','taskId':'task_id','id':'upload_id','finalResult':'final_result','inputTokens':'input_tokens','outputTokens':'output_tokens','toolCallErrorCount':'tool_call_error_count','subagentName':'subagent_name','subagentType':'subagent_type','answerScore':'answer_score','skillScore':'skill_score','skillTriggerRate':'skill_trigger_rate','isAnswerCorrect':'is_answer_correct','observedAgents':'agents','skill':'skills'}
        key=names.get(column,column)
        if key not in {'agentName','framework','user','timestamp','latency','tokens','cost','query','label','model','observedIp','source_kind','tool_call_count','llm_call_count','is_subagent','task_id','upload_id','trace_status','agentOwnership','skills','agents','execution_status','final_result','input_tokens','output_tokens','tool_call_error_count','subagent_name','subagent_type','answer_score','skill_score','skill_trigger_rate','is_answer_correct'}:raise ValueError('unsupported existing Trace filter column')
        return row.get(key)

    def _matches(self,row,clause):
        if not isinstance(clause,dict):raise ValueError('invalid filter')
        column=clause['column'];operator=clause['operator'];expected=clause.get('value');value=self._value(row,column)
        if operator=='is null':return value is None
        if operator=='is not null':return value is not None
        if value is None:return operator in ('none of','does not contain')
        if operator in ('any of','none of','all of'):
            if not isinstance(expected,list) or len(expected)>1000:raise ValueError('invalid options filter')
            actual=value if isinstance(value,list) else [value]
            found=[item in actual for item in expected]
            return any(found) if operator=='any of' else (not any(found) if operator=='none of' else all(found))
        if operator in ('contains','does not contain','starts with','ends with'):
            a=str(value).casefold();b=str(expected).casefold()
            return b in a if operator=='contains' else b not in a if operator=='does not contain' else a.startswith(b) if operator=='starts with' else a.endswith(b)
        if column=='timestamp':value=_milliseconds(value);expected=_milliseconds(expected)
        elif operator in ('>','>=','<','<='):value=float(value);expected=float(expected)
        if operator=='=':return value==expected
        if operator=='>':return value>expected
        if operator=='>=':return value>=expected
        if operator=='<':return value<expected
        if operator=='<=':return value<=expected
        raise ValueError('unsupported Trace filter operator')

    def read(self,token,workspace,params):
        facet=params.get('facet');task_selection=execution_selection=tasks_selection=None
        def resolve_refs(refs,kind):
            found=set()
            for ref in refs:
                try:
                    if self.metadata:found.add(self.metadata.resolve(token,workspace,ref,kind)['trace_id'])
                    else:self.queries.route(token,workspace,ref);found.add(ref)
                except Forbidden:pass
            return found
        if facet not in ('tags','skills','values'):
            tasks=set(filter(None,params.get('taskIds','').split(',')))
            task_selection=resolve_refs([params['taskId']],'task') if params.get('taskId') else None
            execution_selection=resolve_refs([params['executionId']],'execution') if params.get('executionId') else None
            tasks_selection=resolve_refs(tasks,'task') if tasks else None
        selections=[value for value in (task_selection,execution_selection,tasks_selection) if value is not None]
        trace_ids=set.intersection(*selections) if selections else None
        rows,scope=self._records(token,workspace,trace_ids)
        grant=self.iam._workspace(scope,workspace,'read')
        can_all=grant.role in ('owner','admin')
        if facet=='tags':return self.metadata.list_tags(token,workspace,params.get('kind')) if self.metadata else []
        if facet=='skills':
            names=collections.defaultdict(set)
            for row in rows:
                relations=row.get('_execution_relations')
                values=[{'name':item.get('skillName',item.get('name')),'version':item.get('skillVersion',item.get('version'))} for item in relations] if relations is not None else [] if '_execution_relations' in row else row.get('invoked_skills') or []
                for item in values:
                    if isinstance(item,dict) and item.get('name'):
                        if item.get('version') is not None:names[item['name']].add(item['version'])
                        else:names[item['name']]
            if not names:
                for row in rows:
                    if row.get('_source_skill'):
                        name=row['_source_skill'];version=row.get('_source_skill_version')
                        if version is not None:names[name].add(version)
                        else:names[name]
            return [{'name':name,'versions':sorted(versions)} for name,versions in sorted(names.items())]
        if facet=='values':
            counter=collections.Counter()
            for row in rows:
                value=self._value(row,params.get('column',''))
                if value is not None:
                    for item in value if isinstance(value,list) else [value]:counter[str(item)]+=1
            return [{'value':value,'count':count} for value,count in sorted(counter.items(),key=lambda item:(-item[1],item[0]))]
        selected=[]
        raw_filters=params.get('filters')
        clauses=json.loads(raw_filters) if raw_filters else []
        if not isinstance(clauses,list) or len(clauses)>100:raise ValueError('invalid filters')
        # Validate even with no matches, so unsupported filtering never silently broadens a query.
        for clause in clauses:
            if not isinstance(clause,dict) or clause.get('operator') not in ('=','contains','does not contain','starts with','ends with','>','>=','<','<=','any of','none of','all of','is null','is not null'):raise ValueError('invalid filter')
            self._value({},clause.get('column',''))
        windows={'30m':1800000,'1h':3600000,'3h':10800000,'24h':86400000,'7d':604800000,'30d':2592000000}
        time_filter=params.get('time','all')
        if time_filter not in ('all','custom',*windows):raise ValueError('invalid time window')
        from_time=self.control.clock()-windows[time_filter] if time_filter in windows else None
        if params.get('timeFrom'):from_time=_milliseconds(params['timeFrom'])
        to_time=_milliseconds(params['timeTo']) if params.get('timeTo') else None
        tag_ids=set(filter(None,(params.get('tagIds') or params.get('bizTag') or '').split(',')))
        for row in rows:
            if task_selection is not None and row['_trace_id'] not in task_selection:continue
            if execution_selection is not None and row['_trace_id'] not in execution_selection:continue
            if tasks_selection is not None and row['_trace_id'] not in tasks_selection:continue
            if params.get('parentExecutionId') and row['parent_execution_id']!=params['parentExecutionId']:continue
            if params.get('traceUser') and row['user']!=params['traceUser']:continue
            if any(params.get(key) and params[key]!=row.get(target) for key,target in [('framework','framework'),('sourceKind','source_kind'),('agentName','agentName'),('ownership','agentOwnership')]):continue
            if '_execution_relations' in row:
                relations=row['_execution_relations']
                if relations is not None:
                    if params.get('skill') and not any(i.get('skillName',i.get('name'))==params['skill'] and (not params.get('skillVersion') or str(i.get('skillVersion',i.get('version')))==params['skillVersion']) for i in relations):continue
                    if not params.get('skill') and params.get('skillVersion') and str(row.get('_source_skill_version'))!=params['skillVersion']:continue
                else:
                    if params.get('skill') and params['skill']!=row.get('_source_skill'):continue
                    if params.get('skillVersion') and str(row.get('_source_skill_version'))!=params['skillVersion']:continue
            else:
                if params.get('skill') and params['skill'] not in row.get('skills',[]):continue
                if params.get('skillVersion') and not any(i.get('name')==params.get('skill') and str(i.get('version'))==params['skillVersion'] for i in row.get('invoked_skills') or []):continue
            if _flag(params.get('onlySubagents')) and not row['is_subagent']:continue
            if not _flag(params.get('includeSubagents')) and not _flag(params.get('onlySubagents')) and row['is_subagent']:continue
            status=params.get('status','all')
            if status not in ('all','') and row['trace_status']!=status:continue
            if params.get('anomaly','all') not in ('all','',row['anomaly_status']):continue
            if tag_ids and not tag_ids<={tag['id'] for tag in row['userTags']}:continue
            if from_time is not None and _milliseconds(row['timestamp'])<from_time:continue
            if to_time is not None and _milliseconds(row['timestamp'])>to_time:continue
            if params.get('query') and params['query'].casefold() not in ' '.join(str(row.get(k) or '') for k in ('task_id','upload_id','query','label','agentName')).casefold():continue
            if not all(self._matches(row,clause) for clause in clauses):continue
            selected.append(row)
        sort=params.get('sort','timestamp');direction=params.get('dir','desc')
        if sort not in ('timestamp','agent','agentName','status','latency','tokens','cost'):raise ValueError('invalid sort')
        if direction not in ('asc','desc'):raise ValueError('invalid sort direction')
        def order(row):
            value=self._value(row,sort)
            if sort in ('latency','tokens','cost'):value=_number(value)
            return (value is not None,value if value is not None else 0,row['task_id'])
        selected.sort(key=order,reverse=direction=='desc')
        if params.get('summary')=='agents':return {'agents':sorted({r['agentName'] for r in selected if r['agentName']})}
        if params.get('summary')=='traceIds':return {'traceIds':list(dict.fromkeys(r['task_id'] for r in selected))}
        latencies=[r['latency'] for r in selected if r['latency'] is not None]
        calls=sum(int(r.get('tool_call_count') or 0) for r in selected);errors=sum(int(r.get('tool_call_error_count') or 0) for r in selected)
        stats={'total':len(selected),'failedCount':sum(r['trace_status']=='failed' for r in selected),'avgLatencyMs':sum(latencies)/len(selected) if selected else 0,'toolErrorRate':math.floor(errors/calls*1000+0.5)/10 if calls else 0}
        self._recheck(token,workspace,scope,[row['_trace_id'] for row in selected],{row['_trace_id']:row['_outcome_selection'] for row in selected},{row['_trace_id']:row['_execution_boundary'] for row in selected if row.get('_execution_boundary')})
        for row in selected:
            trace_id=row.pop('_trace_id',None)
            row.pop('_outcome_selection',None)
            for key in ('_execution_boundary','_execution_relations','_source_skill','_source_skill_version'):row.pop(key,None)
            if _flag(params.get('includeCoreIdentity')):row['core_trace_id']=trace_id
        if not _flag(params.get('paginated')):return selected
        page=int(params.get('page',1));size=int(params.get('pageSize',20))
        if not 1<=page<=1000000 or not 1<=size<=100:raise ValueError('invalid existing pagination')
        part=params.get('listPart')
        if part=='stats':return {'stats':stats}
        output={'records':selected[(page-1)*size:page*size],'page':page,'pageSize':size,'canViewAllTraces':can_all,'hasMore':page*size<len(selected)}
        if part!='records':output.update(total=len(selected),stats=stats)
        return output
