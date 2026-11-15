import copy
import datetime
import hashlib
import json
import math
import re
import stat
import uuid
from pathlib import Path

from .contracts import canonical_json, identifier, revision
from .control import Conflict, StorageError
from .iam import IAMStore, Forbidden

MAX_BYTES=64*1024*1024
MAX_CASE_BYTES=16*1024*1024
MAX_CASES=10000
MAX_ITEMS=2000
MAX_ANNOTATIONS=10000
EXECUTION_SLOT='__execution__'


class ExperimentNotFound(StorageError):
    status=404


class ExperimentTooLarge(StorageError):
    status=413


class ExperimentArtifactError(StorageError):
    status=503


class ExperimentUnavailable(StorageError):
    status=503


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _hash(value):return hashlib.sha256(_json(value).encode()).hexdigest()
def _iso(ms):return datetime.datetime.fromtimestamp(ms/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def _id():return str(uuid.uuid4())


class ExperimentStore:
    def __init__(self,control,evidence=None,facts=None,cancellation_verifier=None,frozen_assets_verifier=None):
        self.control=control;self.iam=IAMStore(control);self.evidence=evidence;self.facts=facts;self.cancellation_verifier=cancellation_verifier;self.frozen_assets_verifier=frozen_assets_verifier

    def _put(self,value,limit=MAX_CASE_BYTES):
        text=_json(value)
        if len(text.encode())>limit:raise ExperimentTooLarge('Experiment artifact exceeds budget')
        return self.control.persist_artifact({'encoding':'experiment-json/v1','json':text})

    def _load(self,digest,ref,limit=MAX_CASE_BYTES):
        path=Path(ref)
        if not re.fullmatch('[0-9a-f]{64}',digest) or path.parent!=self.control.artifact_directory or path.name!=digest or path.is_symlink():raise ExperimentArtifactError('Invalid private experiment artifact')
        try:
            with path.open('rb') as source:
                info=stat.S_ISREG(__import__('os').fstat(source.fileno()).st_mode)
                if not info:raise ExperimentArtifactError('Experiment artifact is not a regular file')
                body=source.read(limit*6+1024)
            if len(body)>limit*6 or hashlib.sha256(body).hexdigest()!=digest:raise ExperimentArtifactError('Experiment artifact checksum differs')
            wrapper=json.loads(body)
            if wrapper.get('encoding')!='experiment-json/v1':raise ExperimentArtifactError('Experiment artifact encoding differs')
            if len(wrapper['json'].encode())>limit:raise ExperimentTooLarge('Experiment artifact expands beyond budget')
            return json.loads(wrapper['json'])
        except (OSError,KeyError,ValueError) as exc:raise ExperimentArtifactError('Experiment artifact unavailable') from exc

    def _head(self,con,token,ws,identity,capability='read',deleted=False):
        self.iam._workspace(self.iam._scope(con,token),ws,capability)
        row=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,identity)).fetchone()
        if row is None:raise ExperimentNotFound('Experiment not found')
        self.iam._authorize(con,token,ws,capability,'run',identity)
        if row['state']!='active' and not deleted:raise ExperimentNotFound('Experiment is deleted')
        return dict(row)

    def _owner(self,con,principal):
        row=con.execute('SELECT normalized_login_name FROM iam_principals WHERE principal_id=?',(principal,)).fetchone()
        if row is None:raise Forbidden('Experiment owner unavailable')
        return row[0]

    def _case(self,con,ws,exp,case_id,deleted=False):
        row=con.execute('SELECT * FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND case_id=?',(ws,exp,case_id)).fetchone()
        if row is None or row['state']!='active' and not deleted:raise ExperimentNotFound('Experiment Case not found')
        return dict(row)

    def _slot(self,con,ws,exp,result_id):
        row=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND result_id=?',(ws,exp,result_id)).fetchone()
        if row is None:raise ExperimentNotFound('Experiment result slot not found')
        return dict(row)

    def _receipt(self,con,scope,ws,action,body):
        key=identifier(body.get('operation_key',''))
        request=body.get('operation_request',{k:v for k,v in body.items() if k not in {'operation_key','expected_revision'}})
        digest=_hash(request)
        row=con.execute('SELECT * FROM experiment_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind=? AND operation_key=?',(ws,scope.principal_id,action,key)).fetchone()
        if row and row['request_hash']!=digest:raise Conflict('Experiment operation key has different input')
        return key,digest,dict(row) if row else None

    def _bump(self,con,ws,identity,**changes):
        changes.update(updated_at_ms=self.control.clock())
        setters=[key+'=?' for key in changes]+['revision=revision+1']
        con.execute('UPDATE experiment_heads SET '+','.join(setters)+' WHERE workspace_id=? AND experiment_id=?',tuple(changes.values())+(ws,identity))

    def _check_revision(self,head,expected):
        if expected is not None and str(expected) not in {str(head['revision']),self._etag(head)}:raise Conflict('Experiment revision is stale')

    @staticmethod
    def _etag(head):return '"experiment:'+head['experiment_id']+':'+str(head['revision'])+':'+str(head['lifecycle_revision'])+'"'

    def _annotations(self,con,ws,exp):
        rows=con.execute('SELECT * FROM experiment_annotations WHERE workspace_id=? AND experiment_id=? ORDER BY created_at_ms,annotation_id LIMIT ?',(ws,exp,MAX_ANNOTATIONS+1)).fetchall()
        if len(rows)>MAX_ANNOTATIONS:raise ExperimentTooLarge('Experiment annotation history exceeds budget')
        return [dict(row) for row in rows]

    def _comments_tx(self,con,ws,exp,annotations=None):
        rows=annotations if annotations is not None else self._annotations(con,ws,exp)
        removed={row['subject_id'] for row in rows if row['kind']=='comment_remove'}
        result=[];size=0
        for row in rows:
            if row['kind']!='comment' or row['annotation_id'] in removed:continue
            value=self._load(row['payload_hash'],row['payload_ref']);size+=len(_json(value).encode())
            if size>MAX_BYTES:raise ExperimentTooLarge('Experiment comments exceed response budget')
            result.append(value)
        return result

    def _snapshot(self,con,ws,head,case_ids=None,include_cases=True,include_evidence=True):
        exp=head['experiment_id'];data=self._load(head['metadata_hash'],head['metadata_ref']);annotations=self._annotations(con,ws,exp)
        data.update(id=exp,name=head['name'],type=head['type'],scope=head['scope'],skillName=head['skill_name'],agentName=head['agent_name'],status=head['status'],watchMode=bool(head['watch_mode']),watchEnabledAt=_iso(head['watch_enabled_at_ms']) if head['watch_enabled_at_ms'] is not None else None,user=self._owner(con,head['created_by']),createdAt=_iso(head['created_at_ms']),updatedAt=_iso(head['updated_at_ms']),deletedAt=_iso(head['deleted_at_ms']) if head['deleted_at_ms'] is not None else None)
        for key in ('skillVersion','preset','skillContextJson','configSnapshotJson','sourceExperimentId','optimizationRecordId'):data.setdefault(key,None)
        data.setdefault('evaluatorIdsJson','[]');data.setdefault('evaluatorConfigsJson','{}')
        for group in data.get('groups',[]):
            group.setdefault('experimentId',exp);group.setdefault('createdAt',_iso(head['created_at_ms']))
        data['comments']=self._comments_tx(con,ws,exp,annotations);data.setdefault('groups',[]);data['cases']=[];size=len(_json(data).encode())
        cases=con.execute("SELECT * FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND state='active' ORDER BY ordinal,case_id LIMIT ?",(ws,exp,MAX_CASES+1)).fetchall() if include_cases else []
        if len(cases)>MAX_CASES:raise ExperimentTooLarge('Experiment Cases exceed budget')
        for raw in cases:
            row=dict(raw)
            if case_ids is not None and row['case_id'] not in case_ids:continue
            item=self._load(row['payload_hash'],row['payload_ref']);item.update(id=row['case_id'],experimentId=exp,createdAt=_iso(row['created_at_ms']),deletedAt=None)
            for key in ('executionId','taskId','datasetInput','referenceOutput','evaluatorContextJson','groupId','faultInjectionType','caseValuesJson','fiTaskId','fiRunId','traceGenerationCommandId','traceGenerationError'):item.setdefault(key,None)
            item.setdefault('input','');item.setdefault('actualOutput','')
            slots=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? ORDER BY created_at_ms,result_id',(ws,row['case_id'])).fetchall();results=[]
            for slot in slots:
                if slot['evaluator_id']==EXECUTION_SLOT:continue
                result={'id':slot['result_id'],'experimentId':exp,'caseId':row['case_id'],'evaluatorId':slot['evaluator_id'],'status':slot['status'],'verdict':None,'summary':None,'score':None,'pointsJson':None,'evidenceJson':None,'humanScore':None,'humanReason':None,'humanBy':None,'humanAt':None,'errorMessage':None,'attempts':slot['evaluation_version'],'durationMs':None,'createdAt':_iso(slot['created_at_ms']),'updatedAt':_iso(slot['updated_at_ms']),'coreResult':None}
                if slot['selected_result_id']:
                    receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,slot['selected_result_id'])).fetchone()
                    if receipt is None:raise StorageError('Selected machine receipt unavailable')
                    if receipt['state']=='quarantined':raise ExperimentUnavailable('Selected machine receipt is unavailable')
                    packet=self._load(receipt['content_hash'],receipt['artifact_ref']);machine=copy.deepcopy(packet['result']);result.update(machine)
                    result.update(id=slot['result_id'],caseId=row['case_id'],experimentId=exp,evaluatorId=slot['evaluator_id'],status=slot['status'],attempts=slot['evaluation_version'],createdAt=_iso(slot['created_at_ms']),updatedAt=_iso(slot['updated_at_ms']))
                    selected_run=con.execute('SELECT plan_hash FROM runs WHERE workspace_id=? AND run_id=?',(ws,receipt['run_id'])).fetchone()
                    if selected_run is None:raise StorageError('Selected machine RunPlan unavailable')
                    result['coreResult']={'machineResultId':slot['selected_result_id'],'contentHash':receipt['content_hash'],'runId':receipt['run_id'],'evaluationVersion':slot['evaluation_version'],'planHash':selected_run['plan_hash']}
                    if 'points' in machine:result['pointsJson']=_json(machine['points'])
                    if 'evidence' in machine:result['evidenceJson']=_json(machine['evidence'])
                    if slot['review_id']:
                        review=next((v for v in annotations if v['annotation_id']==slot['review_id'] and v['machine_result_id']==slot['selected_result_id']),None)
                        if review:result.update(self._load(review['payload_hash'],review['payload_ref']))
                results.append(result)
            item['results']=results
            cps=con.execute('SELECT c.*,a.attempt_no,a.worker_id,a.started_at_ms,a.finished_at_ms,a.status AS attempt_status FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.case_id=? ORDER BY a.started_at_ms,a.attempt_no,c.attempt_id',(ws,row['case_id'])).fetchall()
            item['traceAttempts']=[]
            for cp in cps:
                payload=self._load(cp['payload_hash'],cp['payload_ref']);progress=payload.get('checkpoint',{})
                if payload.get('phase')=='execute':
                    request=payload.get('execution_request')
                    if request is None:request=self._plan(con,ws,exp,cp['run_id'])[1]['config'].get('execution_request',{})
                    target=progress.get('_command_target') or self._external_target(progress.get('command_id') or cp['command_id'] or '',progress,request,cp['attempt_id'])
                    status={'done':'ready','cancelled':'cancelled','expired':'superseded','failed':'retry_wait' if progress.get('status')=='retry_wait' else 'failed'}.get(cp['attempt_status'],progress.get('status',cp['attempt_status']))
                    item['traceAttempts'].append({'id':cp['attempt_id'],'experimentId':exp,'caseId':row['case_id'],'attemptNo':cp['attempt_no'],'workerId':target.get('clientId'),'runId':cp['run_id'],'kind':target['kind'],'status':status,'commandId':cp['command_id'],'traceId':cp['trace_id'],'platform':progress.get('platform',request.get('platform','')),'agent':progress.get('agent',request.get('agent','')),'model':progress.get('model',request.get('model')),'timeoutSeconds':progress.get('timeoutSeconds',request.get('timeoutSeconds',180)),'failureCode':progress.get('failureCode'),'errorMessage':progress.get('errorMessage'),'startedAt':_iso(cp['started_at_ms']),'finishedAt':_iso(cp['finished_at_ms']) if cp['finished_at_ms'] is not None else None,'createdAt':_iso(cp['created_at_ms']),'updatedAt':_iso(cp['updated_at_ms'])})
            item['traceAttempts'].sort(key=lambda value:(value['attemptNo'],value['startedAt'],value['id']),reverse=True)
            terminal=bool(results) and all(v['status'] in {'done','failed','cancelled','skipped'} for v in results)
            status='failed' if terminal and any(v['status']=='failed' for v in results) else 'cancelled' if terminal and any(v['status']=='cancelled' for v in results) else 'done' if terminal else 'running' if any(v['status']=='running' for v in results) else 'waiting'
            progress={'identity':cps[-1]['attempt_id'] if cps else 'existing:'+row['case_id'],'attemptNo':cps[-1]['attempt_no'] if cps else 0,'generation':row['created_at_ms'],'revision':max([row['updated_at_ms']]+[v['updated_at_ms'] for v in cps]),'evaluationVersion':sum(v['attempts'] for v in results),'source':'generated' if item['traceAttempts'] else 'fault-injection' if item.get('fiRunId') else 'existing','stage':4 if status=='done' else 3,'status':status,'label':{'done':'已完成','failed':'评测失败','cancelled':'已取消','running':'执行评测中','waiting':'等待评测'}[status],'startedAt':_iso(row['created_at_ms']),'finishedAt':_iso(head['updated_at_ms']) if terminal else None,'updatedAt':_iso(head['updated_at_ms']),'traceId':item.get('taskId'),'executionId':item.get('executionId'),'error':next((v.get('errorMessage') for v in results if v.get('errorMessage')),None),'evaluators':[{'id':v['evaluatorId'],'status':v['status'],'error':v.get('errorMessage')} for v in results]}
            execution_slot=next((slot for slot in slots if slot['evaluator_id']==EXECUTION_SLOT),None)
            if execution_slot and execution_slot['status']!='done':
                current_cp=next((cp for cp in reversed(cps) if cp['work_item_id']==execution_slot['work_item_id']),None)
                payload=self._load(current_cp['payload_hash'],current_cp['payload_ref'])['checkpoint'] if current_cp else {}
                state=payload.get('status',execution_slot['status']);stage=2 if state=='waiting_trace' else 1 if state in {'running','retry_wait'} else 0
                state='failed' if execution_slot['status']=='failed' else 'cancelled' if execution_slot['status']=='cancelled' else 'retry_wait' if state=='retry_wait' else 'running' if state in {'running','dispatching'} else 'waiting'
                label='等待 Trace 入库' if payload.get('status')=='waiting_trace' else {'failed':'执行失败','cancelled':'已取消','retry_wait':'等待重试','running':'Agent 执行中','waiting':'等待调度'}[state]
                progress.update(identity=current_cp['attempt_id'] if current_cp else execution_slot['work_item_id'],attemptNo=current_cp['attempt_no'] if current_cp else 0,generation=current_cp['created_at_ms'] if current_cp else execution_slot['created_at_ms'],revision=current_cp['updated_at_ms'] if current_cp else execution_slot['updated_at_ms'],source='fault-injection' if payload.get('fi_run_id') else 'generated',stage=stage,status=state,label=label,error=payload.get('errorMessage') or item.get('traceGenerationError'))
            item['executionSnapshot']={'progress':progress,'taskId':item.get('taskId'),'executionId':item.get('executionId'),'actualOutput':item.get('actualOutput',''),'results':results}
            size+=len(_json(item).encode())
            if size>MAX_BYTES:raise ExperimentTooLarge('Experiment response exceeds budget')
            data['cases'].append(item)
        data['cancellations']=self._cancellations_tx(con,ws,exp,annotations)
        subjects={row['annotation_id']:row['subject_id'] for row in annotations if row['kind']=='cancellation'}
        data['coreActiveCancellationIds']=[row['id'] for row in data['cancellations'] if row.get('caseKey')!='' or subjects.get(row['id'])==head['current_run_id']]
        executions=[];sessions=[];seen=set();session_ids=set();readiness={};current_cases={c['id']:c for c in data['cases']}
        frozen_runs=con.execute('SELECT run_id FROM experiment_runs WHERE workspace_id=? AND experiment_id=? ORDER BY generation DESC LIMIT ?',(ws,exp,MAX_ITEMS+1)).fetchall() if include_cases and include_evidence else []
        if len(frozen_runs)>MAX_ITEMS:raise ExperimentTooLarge('Experiment run history exceeds budget')
        for run in frozen_runs:
            if len(seen)>MAX_ITEMS:raise ExperimentTooLarge('Experiment execution history exceeds budget')
            _,plan=self._plan(con,ws,exp,run[0])
            for case_id,ev in plan.get('frozen_trace_evidence',{}).items():
                execution=ev.get('execution',{});session=ev.get('session',{})
                case=current_cases.get(case_id)
                if case and case_id not in readiness and case.get('executionId')==execution.get('id') and case.get('taskId')==session.get('taskId') and execution.get('id') and session.get('taskId'):
                    messages=session.get('interactions')
                    if isinstance(messages,str):
                        def invalid_constant(_):raise ValueError('Nonstandard JSON constant')
                        try:messages=json.loads(messages,parse_constant=invalid_constant)
                        except (ValueError,TypeError):messages=None
                    messages=messages if isinstance(messages,list) else []
                    def business_response(message):
                        if not isinstance(message,dict) or str(message.get('role') or '').strip().lower() not in {'assistant','opencode'}:return False
                        content=message.get('content')
                        if isinstance(content,str) and content.strip():return True
                        if any(isinstance(message.get(key),list) and message[key] for key in ('tool_calls','toolCalls')):return True
                        parts=message.get('parts') if isinstance(message.get('parts'),list) else content
                        return isinstance(parts,list) and any(isinstance(part,dict) and (isinstance(part.get('text'),str) and part['text'].strip() or str(part.get('type')) in {'tool','tool-call','tool_call'} and (part.get('callID') or part.get('id'))) for part in parts)
                    readiness[case_id]={'executionId':execution['id'],'taskId':session['taskId'],'hasInteractions':bool(messages),'hasBusinessResponse':any(business_response(message) for message in messages),'hasEndTime':bool(session.get('endTime')),'executionAgent':execution.get('agentName')}
                if session.get('taskId') not in session_ids:
                    session_ids.add(session.get('taskId'));sessions.append(session)
                if execution.get('id') not in seen:
                    seen.add(execution.get('id'));source=copy.deepcopy(execution)
                    for key in ('query','finalResult','model','hostIp','createdAt','timestamp','agentName','framework','isSubagent','skill','skillVersion'):source.setdefault(key,None)
                    source.setdefault('executionSkills',[])
                    executions.append(source)
        data['traceAttempts']=[a for c in data['cases'] for a in c['traceAttempts']]
        if len(_json(data).encode())+len(_json(executions).encode())+len(_json(sessions).encode())+len(_json(readiness).encode())>MAX_BYTES:raise ExperimentTooLarge('Experiment frozen source response exceeds budget')
        supplementary={'cancellations':data['cancellations'],'sessions':sessions,'local_executions':[],'business_trace_readiness':readiness}
        if not any(c.get('fiRunId') for c in data['cases']):supplementary['fi_runs']=[]
        if not any(c.get('traceGenerationCommandId') or any(a.get('commandId') for a in c['traceAttempts']) for c in data['cases']):supplementary['commands']=[]
        if head['scope']!='benchmark':supplementary['benchmark_runs']=[]
        if head['scope'] not in {'skill-workbench','skill-case-analysis','grayscale-ab'}:supplementary['grayscale_tasks']=[]
        return {**supplementary,'coverage':('subset' if case_ids is not None else 'complete') if include_cases else 'head','executions':executions,'_owner_principal_id':head['created_by'],'experiment':data,'revision':str(head['revision']),'lifecycle_revision':str(head['lifecycle_revision']),'etag':self._etag(head),'current_run_id':head['current_run_id']}

    def _case_write(self,con,token,ws,exp,value,ordinal,preserve_execution=False,only_if_new=False):
        if not isinstance(value,dict):raise ValueError('Case must be an object')
        value=copy.deepcopy(value);identity=identifier(value.get('id') or _id());old=con.execute('SELECT * FROM experiment_cases WHERE workspace_id=? AND case_id=?',(ws,identity)).fetchone()
        if old and old['experiment_id']!=exp:raise Conflict('Case ID belongs to another experiment')
        if old and old['state']!='active':raise Conflict('Deleted Case ID cannot be reused')
        before=self._load(old['payload_hash'],old['payload_ref']) if old else {}
        value={**before,**value};value['id']=identity
        for key in ('results','traceAttempts','executionSnapshot','experimentId','createdAt','deletedAt','user'):value.pop(key,None)
        value.setdefault('input','');value.setdefault('actualOutput','');value.setdefault('referenceOutput',None)
        head=con.execute('SELECT scope FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()
        logical=self._dataset_case_key(value) if head and head['scope'] in {'skill-workbench','skill-case-analysis','grayscale-ab'} else None
        if logical:
            cancellations=con.execute("SELECT payload_hash,payload_ref FROM experiment_annotations WHERE workspace_id=? AND experiment_id=? AND kind='cancellation' LIMIT ?",(ws,exp,MAX_ANNOTATIONS+1)).fetchall()
            if len(cancellations)>MAX_ANNOTATIONS:raise ExperimentTooLarge('Experiment cancellation history exceeds budget')
            if any(self._load(row['payload_hash'],row['payload_ref']).get('caseKey')==logical for row in cancellations):raise Conflict('Deleted Dataset Case cannot be readded')
        trace=None
        if value.get('taskId') or value.get('executionId'):
            traces=[]
            for kind,key in [('task','taskId'),('execution','executionId')]:
                if not value.get(key):continue
                alias=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(ws,kind,value[key])).fetchone()
                traces.append(alias[0] if alias else value[key])
            if len(set(traces))!=1:raise Conflict('Case Trace aliases do not match')
            trace=traces[0];self.iam._authorize(con,token,ws,'read','trace',trace)
            route=con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(ws,trace)).fetchone()
            if route is None:raise Conflict('Case Trace is not active')
        binding=_hash([trace,value.get('groupId')]) if trace else None
        if only_if_new:
            duplicate=con.execute("SELECT case_id FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND state='active' AND (case_id=? OR (? IS NOT NULL AND binding_hash=?))",(ws,exp,identity,binding,binding)).fetchone()
            if duplicate:return duplicate[0]
        digest,ref=self._put(value);now=self.control.clock()
        if old:
            if old['trace_id']!=trace:
                if not preserve_execution:self._cancel_items(con,ws,exp,identity,now=now)
                con.execute("UPDATE experiment_result_slots SET run_id=NULL,work_item_id=NULL,selected_result_id=NULL,review_id=NULL,status='pending',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=?"+(" AND evaluator_id<>'__execution__'" if preserve_execution else ''),(now,ws,identity))
            con.execute('UPDATE experiment_cases SET payload_hash=?,payload_ref=?,trace_id=?,binding_hash=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=?',(digest,ref,trace,binding,now,ws,identity))
        else:
            con.execute("INSERT INTO experiment_cases(workspace_id,experiment_id,case_id,ordinal,state,payload_hash,payload_ref,trace_id,created_at_ms,updated_at_ms,binding_hash) VALUES(?,?,?,?,'active',?,?,?,?,?,?)",(ws,exp,identity,ordinal,digest,ref,trace,now,now,binding))
        return identity

    def _create(self,con,token,ws,body,scope):
        source=copy.deepcopy(body.get('experiment'))
        if not isinstance(source,dict):raise ValueError('Experiment must be an object')
        identity=identifier(source.get('id') or _id());name=identifier(source.get('name',''))
        if con.execute('SELECT 1 FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,identity)).fetchone():raise Conflict('Experiment ID already exists')
        cases=source.pop('cases',[])
        if not isinstance(cases,list) or len(cases)>MAX_CASES:raise ExperimentTooLarge('Experiment Cases exceed budget')
        for key in ('user','revision','lifecycle_revision','etag','comments','deletedAt','createdAt','updatedAt','current_run_id'):source.pop(key,None)
        source.update(id=identity,name=name,status='draft');source.setdefault('groups',[]);source.setdefault('evaluatorIdsJson','[]');source.setdefault('evaluatorConfigsJson','{}');source.setdefault('configSnapshotJson','{}')
        digest,ref=self._put(source);now=self.control.clock()
        con.execute("INSERT INTO experiment_heads(workspace_id,experiment_id,name,type,scope,skill_name,agent_name,status,watch_mode,watch_enabled_at_ms,metadata_hash,metadata_ref,state,created_by,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,'active',?,?,?)",(ws,identity,name,source.get('type','single'),source.get('scope',''),source.get('skillName',''),source.get('agentName',''),int(bool(source.get('watchMode',False))),now if source.get('watchMode',False) else None,digest,ref,scope.principal_id,now,now))
        self.iam._record_resource(con,ws,'run',identity,scope.principal_id,'private',invalidate_policy=False)
        for i,value in enumerate(cases):self._case_write(con,token,ws,identity,value,i)
        return self._snapshot(con,ws,self._head(con,token,ws,identity))

    def _update(self,con,token,ws,body,scope):
        head=self._head(con,token,ws,body['experiment_id'],'write');self._check_revision(head,body.get('expected_revision'))
        value=self._load(head['metadata_hash'],head['metadata_ref']);changes=body.get('changes',{})
        allowed={'name','type','agentName','evaluatorIdsJson','evaluatorConfigsJson','scope','skillName','skillVersion','preset','skillContextJson','configSnapshotJson','sourceExperimentId','optimizationRecordId','watchMode'}
        if not isinstance(changes,dict) or set(changes)-allowed:raise ValueError('Unsupported Experiment fields')
        value.update(changes);digest,ref=self._put(value)
        self._bump(con,ws,head['experiment_id'],metadata_hash=digest,metadata_ref=ref,name=value['name'],type=value.get('type','single'),scope=value.get('scope',''),skill_name=value.get('skillName',''),agent_name=value.get('agentName',''),watch_mode=int(bool(value.get('watchMode',False))),watch_enabled_at_ms=self.control.clock() if value.get('watchMode') and not head['watch_mode'] else head['watch_enabled_at_ms'] if value.get('watchMode') else None)
        return self._snapshot(con,ws,self._head(con,token,ws,head['experiment_id']))

    def _plan(self,con,ws,exp,run_id=None):
        if run_id is None:
            row=con.execute('SELECT current_run_id FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone();run_id=row[0] if row else None
        row=con.execute('SELECT r.* FROM runs r JOIN experiment_runs e ON e.workspace_id=r.workspace_id AND e.run_id=r.run_id WHERE e.workspace_id=? AND e.experiment_id=? AND e.run_id=?',(ws,exp,run_id)).fetchone()
        if row is None:raise ExperimentNotFound('RunPlan not found')
        return dict(row),self._load(row['plan_hash'],row['plan_manifest_ref'],MAX_BYTES)

    def _verify_evidence(self,con,token,ws,evidence):
        m=evidence['manifest'];trace=m['trace_id'];self._source_route(con,self.iam._scope(con,token),ws,m)
        rows=con.execute('SELECT * FROM obs_entity_heads WHERE workspace_id=? AND trace_id=? ORDER BY entity_kind,entity_id',(ws,trace)).fetchall()
        vector=[{'kind':r['entity_kind'],'id':r['entity_id'],'revision':str(r['revision']),'source_revision':str(r['source_revision']),'content_hash':r['content_hash']} for r in rows]
        if vector!=m['heads']:raise Conflict('Trace evidence changed before freeze')
        annotation=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
        if str(annotation['revision'] if annotation else 0)!=m['annotation_revision']:raise Conflict('Trace annotation changed before freeze')
        for kind,key in [('task','task_id'),('execution','execution_id')]:
            alias=con.execute('SELECT alias_id FROM trace_legacy_ids WHERE workspace_id=? AND trace_id=? AND alias_kind=? ORDER BY created_at_ms,alias_id LIMIT 1',(ws,trace,kind)).fetchone()
            if (alias[0] if alias else trace)!=m['aliases'][key]:raise Conflict('Trace aliases changed before freeze')

    def _source_route(self,con,scope,ws,manifest):
        trace=manifest['trace_id'];self.iam._authorize_scope(con,scope,ws,'read','trace',trace)
        route=con.execute('SELECT state,incarnation,route_epoch FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
        if route is None or route['state']!='active' or str(route['incarnation'])!=str(manifest['incarnation']) or str(route['route_epoch'])!=str(manifest['route_epoch']):raise Conflict('Frozen Trace source lifecycle changed')
        if con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=? AND incarnation=?",(ws,trace,route['incarnation'])).fetchone():raise Conflict('Trace deletion barrier')

    @staticmethod
    def _source_routes(plan,case_id=None):
        return [{key:ev['manifest'][key] for key in ('trace_id','incarnation','route_epoch')} for identity,ev in plan.get('frozen_trace_evidence',{}).items() if case_id is None or identity==case_id]

    def _source_assets(self,con,scope,ws,exp,run_id=None,require_origin=False):
        params=[ws,exp];where='i.workspace_id=? AND e.experiment_id=?'
        if run_id is not None:where+=' AND i.run_id=?';params.append(run_id)
        params.append(MAX_ITEMS+1)
        rows=con.execute('SELECT DISTINCT i.run_id,i.slot,i.release_id,s.asset_id,a.kind FROM run_inputs i JOIN experiment_runs e ON e.workspace_id=i.workspace_id AND e.run_id=i.run_id JOIN asset_release_seals s ON s.workspace_id=i.workspace_id AND s.release_id=i.release_id JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id WHERE '+where+' LIMIT ?',tuple(params)).fetchall()
        if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Experiment source asset vector exceeds budget')
        binding=None
        if con.execute('SELECT 1 FROM schema_meta WHERE version=12').fetchone():binding=con.execute('SELECT * FROM benchmark_experiment_bindings WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()
        if binding:
            public=con.execute("SELECT s.asset_id,a.kind FROM asset_release_seals s JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id WHERE s.workspace_id=? AND s.release_id=?",(ws,binding['public_release_id'])).fetchone()
            private=con.execute("SELECT s.asset_id,a.kind FROM asset_release_seals s JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id WHERE s.workspace_id=? AND s.release_id=?",(ws,binding['private_release_id'])).fetchone()
            if public is None or public['kind']!='dataset' or private is None or private['kind']!='benchmark':raise Conflict('Benchmark source seal differs')
            if run_id is not None:
                inputs={row['slot']:row['release_id'] for row in rows}
                if inputs.get('dataset')!=binding['public_release_id'] or inputs.get('benchmark')!=binding['private_release_id']:raise Conflict('Benchmark source release mapping differs')
            dataset=con.execute('SELECT state FROM benchmark_dataset_heads WHERE workspace_id=? AND dataset_id=? AND public_asset_id=? AND private_asset_id=?',(ws,binding['dataset_id'],public['asset_id'],private['asset_id'])).fetchone()
            if dataset is None or dataset['state']!='active':raise Conflict('Benchmark source Dataset lifecycle changed')
            self.iam._authorize_scope(con,scope,ws,'read','asset',public['asset_id'])
            current=con.execute('SELECT state FROM dataset_compat_heads WHERE workspace_id=? AND asset_id=?',(ws,public['asset_id'])).fetchone()
            if current is not None and current['state']!='active':raise Conflict('Benchmark public Dataset lifecycle changed')
        manual={}
        for row in rows:
            prefix='benchmark:manual-origin:'
            if not row['slot'].startswith(prefix):continue
            if binding is None or row['kind']!='benchmark' or row['release_id']!=binding['private_release_id']:raise Conflict('Manual Benchmark source mapping differs')
            parts=row['slot'][len(prefix):].split(':')
            if len(parts)!=2 or parts[0] not in {'api','session'}:raise Conflict('Manual Benchmark credential marker differs')
            kind,credential=parts;identifier(credential)
            owner=con.execute('SELECT created_by FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()[0]
            receipt=con.execute("SELECT 1 FROM benchmark_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind='supplemental-manual-retry' AND operation_key=? AND experiment_id=?",(ws,owner,row['run_id']+':'+kind+':'+credential,exp)).fetchone()
            table,column=('iam_api_credentials','credential_id') if kind=='api' else ('iam_sessions','session_id')
            registered=con.execute('SELECT principal_id'+(',workspace_id' if kind=='api' else '')+' FROM '+table+' WHERE '+column+'=?',(credential,)).fetchone()
            if receipt is None or registered is None or registered['principal_id']!=owner or kind=='api' and registered['workspace_id']!=ws or row['run_id'] in manual:raise Conflict('Manual Benchmark authorization receipt differs')
            manual[row['run_id']]=(kind,credential,owner)
            if require_origin:
                origin=self.iam._scope_registered_credential(con,credential,kind)
                for capability in ('read','write','execute'):self.iam._authorize_scope(con,origin,ws,capability,'run',exp)
        for row in rows:
            if row['kind']!=row['slot'].split(':',1)[0]:raise Conflict('Frozen source asset kind differs')
            if row['kind']=='benchmark':
                if binding is None or row['release_id']!=binding['private_release_id']:raise Conflict('Private Benchmark source mapping differs')
                if row['slot'].startswith('benchmark:manual-origin:'):continue
                if row['slot']!='benchmark':
                    prefix='benchmark:origin:'
                    if not row['slot'].startswith(prefix):raise Conflict('Private Benchmark source slot differs')
                    job=con.execute('SELECT j.*,e.lifecycle_revision AS run_lifecycle,h.lifecycle_revision AS head_lifecycle,h.created_by AS experiment_owner FROM benchmark_jobs j JOIN experiment_runs e ON e.workspace_id=j.workspace_id AND e.experiment_id=j.experiment_id AND e.run_id=j.run_id JOIN experiment_heads h ON h.workspace_id=j.workspace_id AND h.experiment_id=j.experiment_id WHERE j.workspace_id=? AND j.job_id=?',(ws,row['slot'][len(prefix):])).fetchone()
                    if job is None or job['experiment_id']!=exp or job['run_id']==row['run_id'] or job['actor_principal_id']!=job['experiment_owner'] or job['run_lifecycle']!=job['head_lifecycle']:raise Conflict('Benchmark continuation origin differs')
                    kind=job['origin_credential_kind'];table,column=('iam_api_credentials','credential_id') if kind=='api' else ('iam_sessions','session_id')
                    registered=con.execute('SELECT principal_id FROM '+table+' WHERE '+column+'=?',(job['origin_credential_id'],)).fetchone()
                    if registered is None or registered['principal_id']!=job['actor_principal_id']:raise Conflict('Benchmark continuation credential provenance differs')
                    if require_origin and row['run_id'] not in manual:
                        origin=self.iam._scope_registered_credential(con,job['origin_credential_id'],kind)
                        for capability in ('read','write','execute'):self.iam._authorize_scope(con,origin,ws,capability,'run',exp)
                continue
            if binding and row['slot']=='dataset' and row['release_id']!=binding['public_release_id']:raise Conflict('Benchmark public source mapping differs')
            self.iam._authorize_scope(con,scope,ws,'read','asset',row['asset_id'])
            if row['kind']=='dataset':
                head=con.execute('SELECT state FROM dataset_compat_heads WHERE workspace_id=? AND asset_id=?',(ws,row['asset_id'])).fetchone()
                if head is not None and head['state']!='active':raise Conflict('Frozen Dataset source lifecycle changed')

    def _guard_sources(self,con,token,ws,exp,run_id=None,plan=None):
        scope=self.iam._scope(con,token)
        self._source_assets(con,scope,ws,exp,run_id or (plan.get('run_id') if plan is not None else None))
        if plan is not None:plans=[plan]
        elif run_id is not None:plans=[self._plan(con,ws,exp,run_id)[1]]
        else:
            runs=con.execute('SELECT run_id FROM experiment_runs WHERE workspace_id=? AND experiment_id=? ORDER BY generation DESC LIMIT ?',(ws,exp,MAX_ITEMS+1)).fetchall()
            if len(runs)>MAX_ITEMS:raise ExperimentTooLarge('Experiment run history exceeds budget')
            plans=(self._plan(con,ws,exp,row[0])[1] for row in runs)
        for value in plans:
            for manifest in self._source_routes(value):self._source_route(con,scope,ws,manifest)

    def _delivery_authorization(self,con,token):
        row,is_api=self.iam._authenticate(con,token)
        return {'credential_id':row['credential_id'] if is_api else row['session_id'],'kind':'api' if is_api else 'session','principal_id':row['principal_id']}

    def _prepare_start(self,token,ws,body):
        snapshot=self.dispatch('read',token,ws,{'experiment_id':body['experiment_id'],'case_ids':body.get('case_ids')})
        traces={}
        if snapshot['experiment'].get('scope')=='trace-flow-analysis' and body.get('evaluator_ids')==['__trace_flow_attribution__']:
            if not callable(self.frozen_assets_verifier) or self.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private frozen flow attestation required')
            with self.control.read_transaction() as con:
                head=self._head(con,token,ws,body['experiment_id']);scope=self.iam._scope(con,token)
                source=self._flow_parent_evidence(con,scope,ws,head,snapshot['experiment']['cases'],body.get('config',{}).get('core_flow_match_source'))
                traces[snapshot['experiment']['cases'][0]['id']]=source
            return snapshot,traces
        for case in snapshot['experiment']['cases']:
            if not body.get('_execute') and (case.get('taskId') or case.get('executionId')):
                if self.evidence is None:raise ExperimentUnavailable('Bound Trace requires frozen TraceEvidence')
                traces[case['id']]=self.evidence.read(token,ws,task_id=case.get('taskId'),execution_id=case.get('executionId'))
        return snapshot,traces

    def _flow_parent_evidence(self,con,scope,ws,head,cases,source):
        if head['scope']!='trace-flow-analysis' or head['created_by']!=scope.principal_id or len(cases)!=1 or not isinstance(source,dict) or set(source)!={'machine_result_id','content_hash','run_id'}:raise Conflict('Flow attribution parent is unavailable')
        selected=con.execute("SELECT r.* FROM experiment_result_slots s JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.selected_result_id WHERE s.workspace_id=? AND s.experiment_id=? AND s.case_id=? AND s.evaluator_id='__trace_flow_match__' AND s.status='done'",(ws,head['experiment_id'],cases[0]['id'])).fetchone()
        if selected is None or selected['state']=='quarantined' or any(source[key]!=selected[column] for key,column in [('machine_result_id','result_id'),('content_hash','content_hash'),('run_id','run_id')]):raise Conflict('Flow attribution parent selection differs')
        self._source_assets(con,scope,ws,head['experiment_id'],selected['run_id']);_,plan=self._plan(con,ws,head['experiment_id'],selected['run_id'])
        evidence=plan.get('frozen_trace_evidence',{}).get(cases[0]['id'])
        if not evidence:raise Conflict('Flow attribution parent has no real frozen Trace')
        case=self._case(con,ws,head['experiment_id'],cases[0]['id'])
        if evidence['manifest']['trace_id']!=case['trace_id']:raise Conflict('Flow attribution parent Case binding differs')
        self._source_route(con,scope,ws,evidence['manifest']);return copy.deepcopy(evidence)

    def _start(self,con,token,ws,body,scope,prepared,trusted_parent=False):
        head=self._head(con,token,ws,body['experiment_id'],'write');self.iam._authorize(con,token,ws,'execute','run',head['experiment_id'])
        if scope.principal_id!=head['created_by']:raise Forbidden('Private RunPlan creation requires the experiment owner')
        self._check_revision(head,body.get('expected_revision'))
        snapshot,traces=prepared
        if str(head['revision'])!=snapshot['revision']:raise Conflict('Experiment changed while preparing RunPlan')
        flow_parent=False
        if head['scope']=='trace-flow-analysis':
            if not callable(self.frozen_assets_verifier) or self.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private frozen flow attestation required')
            try:manifest=json.loads(snapshot['experiment'].get('configSnapshotJson') or '{}')['coreFlowAnalysis']
            except (KeyError,ValueError,TypeError):raise Conflict('Frozen flow manifest unavailable') from None
            config=body.get('config',{})
            if not isinstance(manifest,dict) or type(manifest.get('version')) is not int or manifest['version']!=1 or manifest.get('mode') not in {'compare','dynamic'} or _json(config.get('core_flow_analysis'))!=_json(manifest) or _json(config.get('model_selection'))!=_json(manifest.get('model_selection')):raise Conflict('Frozen flow configuration differs')
            evaluators=body.get('evaluator_ids',json.loads(snapshot['experiment'].get('evaluatorIdsJson','[]')))
            if not isinstance(evaluators,list) or len(evaluators)!=1 or evaluators[0] not in {'__trace_flow_match__','__trace_flow_attribution__'}:raise Conflict('One internal flow stage is required')
            if evaluators[0]=='__trace_flow_attribution__':
                if manifest['mode']!='compare':raise Conflict('Dynamic flow has no Skill attribution')
                parent=self._flow_parent_evidence(con,scope,ws,head,snapshot['experiment']['cases'],config.get('core_flow_match_source'))
                traces={snapshot['experiment']['cases'][0]['id']:parent};flow_parent=True
            if len(snapshot['experiment']['cases'])!=1 or len(traces)!=1:raise Conflict('Flow analysis requires one real frozen Trace')
            evidence=next(iter(traces.values()))
            if evidence['manifest']['trace_id']!=manifest.get('trace_id') or evidence['snapshot_hash']!=manifest.get('trace_snapshot_hash'):raise Conflict('Flow analysis source snapshot differs')
            assets=json.loads(snapshot['experiment'].get('configSnapshotJson') or '{}').get('coreAssets',{}).get('releases',{})
            if _json(body.get('releases',{}))!=_json(assets):raise Conflict('Flow public source assets differ')
        cases=snapshot['experiment']['cases'];exp=head['experiment_id'];selected=body.get('case_ids')
        if selected is not None and set(selected)!={v['id'] for v in cases}:raise ExperimentNotFound('RunPlan selected Case is not active')
        if not cases:raise ValueError('RunPlan requires at least one Case')
        evaluators=json.loads(snapshot['experiment'].get('evaluatorIdsJson','[]'))
        if not isinstance(evaluators,list) or not evaluators and not body.get('_execute') or len(evaluators)>1000 or len(set(evaluators))!=len(evaluators):raise ValueError('RunPlan requires unique evaluators')
        if 'evaluator_ids' in body:
            chosen=body['evaluator_ids']
            if not isinstance(chosen,list) or not chosen or len(set(chosen))!=len(chosen) or not set(chosen)<=set(evaluators):raise ValueError('Evaluator subset must belong to the frozen Experiment')
            evaluators=chosen
        if EXECUTION_SLOT in evaluators:raise ValueError('Execution slot is reserved')
        frozen=body.get('frozen_evaluators',{})
        if any(e not in frozen for e in evaluators):raise ValueError('Every evaluator requires a frozen definition')
        if body.get('_execute') and 'retry_from_attempt_id' in body:
            if len(cases)!=1:raise ValueError('Execution retry reservations require one Case')
            slot=con.execute('SELECT work_item_id FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,cases[0]['id'],EXECUTION_SLOT)).fetchone()
            current=None
            if slot and slot['work_item_id']:
                item=con.execute('SELECT status FROM work_items WHERE workspace_id=? AND work_item_id=?',(ws,slot['work_item_id'])).fetchone()
                if item and item[0] in {'queued','running'}:raise Conflict('Execution retry has already been reserved')
                current=con.execute('SELECT attempt_id FROM work_attempts WHERE workspace_id=? AND work_item_id=? ORDER BY attempt_no DESC LIMIT 1',(ws,slot['work_item_id'])).fetchone()
            if (current[0] if current else None)!=body.get('retry_from_attempt_id'):raise Conflict('Execution retry source attempt is stale')
        pending={}
        for case in cases:
            for evaluator in ([EXECUTION_SLOT] if body.get('_execute') else evaluators):
                active=con.execute("SELECT w.status FROM experiment_result_slots s JOIN work_items w ON w.workspace_id=s.workspace_id AND w.work_item_id=s.work_item_id WHERE s.workspace_id=? AND s.case_id=? AND s.evaluator_id=?",(ws,case['id'],evaluator)).fetchone()
                if active and active[0] in {'queued','running'} and not body.get('force_new_trace'):continue
                pending.setdefault(case['id'],[]).append(evaluator)
        cases=[case for case in cases if case['id'] in pending]
        if not cases:
            result=self._snapshot(con,ws,head);result.update(alreadyRunning=True,run_id=head['current_run_id']);return result
        releases=body.get('releases',{})
        for slot,release in releases.items():
            row=con.execute('SELECT a.kind,a.asset_id FROM asset_release_seals s JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id WHERE s.workspace_id=? AND s.release_id=?',(ws,release)).fetchone()
            if row is None or row['kind']!=slot.split(':',1)[0]:raise Conflict('Run input requires matching sealed release')
            if trusted_parent and head['scope']=='benchmark' and (slot=='benchmark' or slot.startswith('benchmark:origin:')):
                binding=con.execute('SELECT private_release_id FROM benchmark_experiment_bindings WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()
                if not binding or binding['private_release_id']!=release:raise Conflict('Trusted Benchmark source release differs')
                if slot!='benchmark':
                    identity=slot[len('benchmark:origin:'):];parent=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,identity)).fetchone();config=body.get('config',{})
                    if not parent or parent['experiment_id']!=exp or parent['run_id']!=config.get('benchmark_continuation_parent_run_id') or identity!=config.get('benchmark_continuation_parent_job_id') or parent['actor_principal_id']!=scope.principal_id:raise Conflict('Trusted Benchmark origin provenance differs')
                    origin=self.iam._scope_registered_credential(con,parent['origin_credential_id'],parent['origin_credential_kind']);self.iam._workspace(origin,ws,'write');self.iam._authorize_scope(con,origin,ws,'execute','run',exp)
                self._source_assets(con,scope,ws,exp,head['current_run_id'])
            else:self.iam._authorize(con,token,ws,'read','asset',row['asset_id'])
        for evidence in traces.values():
            if flow_parent:self._source_route(con,scope,ws,evidence['manifest'])
            else:self._verify_evidence(con,token,ws,evidence)
        clean_cases=[]
        for case in cases:
            clean=copy.deepcopy(case)
            for key in ('results','traceAttempts','executionSnapshot'):clean.pop(key,None)
            clean_cases.append(clean)
        run=_id();now=self.control.clock();generation=con.execute('SELECT COALESCE(MAX(generation),0)+1 FROM experiment_runs WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()[0]
        config=copy.deepcopy(body.get('config',{}))
        allowed=config.get('derived_skill_ids',[])
        if allowed:
            if not isinstance(allowed,list) or any(not isinstance(value,str) or not value for value in allowed) or len(set(allowed))!=len(allowed) or len(allowed)>1000:raise ValueError('Invalid frozen derived Skill scope')
            if not (trusted_parent and config.get('_derived_scope_attested') is True):
                if not callable(self.frozen_assets_verifier) or self.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Trusted frozen Skill scope verification is required')
            versions=config.get('derived_skill_versions')
            if not isinstance(versions,dict) or set(versions)!=set(allowed):raise ValueError('Frozen derived Skill versions must cover the exact Skill scope')
            for choices in versions.values():
                if not isinstance(choices,list) or not choices or len(choices)>1000 or any(value is not None and (type(value) is not int or value<0) for value in choices) or len(set(choices))!=len(choices):raise ValueError('Frozen derived Skill versions must be explicit unique version lists')
            config['_derived_scope_attested']=True
        else:config.pop('_derived_scope_attested',None)
        if body.get('_execute'):
            request=copy.deepcopy(body.get('execution_request',{}))
            if not isinstance(request,dict):raise ValueError('execution_request must be an object')
            request['user']=self._owner(con,scope.principal_id);config['execution_request']=request
        plan={'format':'agent-insight.runplan','version':1,'experiment_id':exp,'run_id':run,'generation':generation,'experiment_config':snapshot['experiment']|{'cases':[],'comments':[]},'cases':clean_cases,'frozen_trace_evidence':traces,'frozen_evaluators':frozen,'config':config,'phase':'execute' if body.get('_execute') else 'evaluate','releases':releases,'expected_case_count':len(cases),'work_members':[{'case_key':case['id'],'evaluator_slot':evaluator} for case in cases for evaluator in pending[case['id']]]}
        digest,ref=self._put(plan,MAX_BYTES)
        dataset=next((release for slot,release in releases.items() if slot=='dataset' or slot.startswith('dataset:')),None)
        con.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,dataset_release_id,expected_case_count,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,'draft',?,?)",(ws,run,snapshot['experiment']['name'],digest,ref,dataset,len(cases),now,now))
        con.execute('INSERT INTO experiment_runs VALUES(?,?,?,?,?,?,?)',(ws,exp,run,generation,head['lifecycle_revision'],scope.principal_id,now))
        for slot,release in releases.items():con.execute('INSERT INTO run_inputs VALUES(?,?,?,?,?,?)',(ws,run,slot,release,_hash(body.get('config',{})),now))
        for case in cases:
            self._cancel_items(con,ws,exp,case['id'],None if body.get('_execute') else pending[case['id']],now=now)
            if body.get('_execute'):
                con.execute("UPDATE experiment_result_slots SET run_id=NULL,work_item_id=NULL,selected_result_id=NULL,review_id=NULL,status='pending',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=? AND evaluator_id<>?",(now,ws,case['id'],EXECUTION_SLOT))
                for evaluator in evaluators:
                    if not con.execute('SELECT 1 FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,case['id'],evaluator)).fetchone():
                        con.execute("INSERT INTO experiment_result_slots(workspace_id,experiment_id,case_id,result_id,evaluator_id,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'pending',?,?)",(ws,exp,case['id'],_id(),evaluator,now,now))
            for evaluator in pending[case['id']]:
                item=_id();con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'queued',?,?)",(ws,item,run,case['id'],'execute' if body.get('_execute') else 'evaluate',evaluator,now,now))
                slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,case['id'],evaluator)).fetchone()
                if slot:con.execute("UPDATE experiment_result_slots SET run_id=?,work_item_id=?,selected_result_id=NULL,review_id=NULL,status='pending',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?",(run,item,now,ws,slot['result_id']))
                else:con.execute("INSERT INTO experiment_result_slots(workspace_id,experiment_id,case_id,result_id,evaluator_id,run_id,work_item_id,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,'pending',?,?)",(ws,exp,case['id'],_id(),evaluator,run,item,now,now))
        con.execute("UPDATE runs SET status='queued',updated_at_ms=? WHERE workspace_id=? AND run_id=?",(now,ws,run));self._bump(con,ws,exp,current_run_id=run,status='running')
        result=self._snapshot(con,ws,self._head(con,token,ws,exp));result['run_id']=run
        return result

    def _cancel_items(self,con,ws,exp,case_id=None,evaluators=None,now=None):
        sql='SELECT w.* FROM work_items w JOIN experiment_runs e ON e.workspace_id=w.workspace_id AND e.run_id=w.run_id WHERE e.workspace_id=? AND e.experiment_id=? AND w.status IN (\'queued\',\'running\')';args=[ws,exp]
        if case_id is not None:sql+=' AND w.case_key=?';args.append(case_id)
        if evaluators is not None:
            if not evaluators:return
            sql+=' AND w.evaluator_slot IN ('+','.join('?' for _ in evaluators)+')';args.extend(evaluators)
        now=self.control.clock() if now is None else now
        for row in con.execute(sql,tuple(args)).fetchall():
            con.execute("UPDATE work_items SET status='cancelled',cancel_requested=1,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,ws,row['work_item_id']))
            con.execute("UPDATE work_attempts SET status='cancelled',finished_at_ms=? WHERE workspace_id=? AND work_item_id=? AND status='running'",(now,ws,row['work_item_id']))
        suffix=' AND case_id=?' if case_id is not None else '';params=(now,ws,exp)+((case_id,) if case_id is not None else ())
        if evaluators is not None:suffix+=' AND evaluator_id IN ('+','.join('?' for _ in evaluators)+')';params+=tuple(evaluators)
        con.execute("UPDATE experiment_result_slots SET status='cancelled',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND experiment_id=? AND status IN ('pending','running')"+suffix,params)

    def _handle(self,con,ws,attempt_id):
        row=con.execute('SELECT c.*,a.lease_until_ms,a.attempt_no,w.evaluator_slot,w.phase,s.result_id FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id JOIN work_items w ON w.workspace_id=c.workspace_id AND w.work_item_id=c.work_item_id JOIN experiment_result_slots s ON s.workspace_id=w.workspace_id AND s.work_item_id=w.work_item_id WHERE c.workspace_id=? AND c.attempt_id=?',(ws,attempt_id)).fetchone()
        if row is None:raise Conflict('Attempt is not the current slot')
        plan=con.execute('SELECT plan_hash FROM runs WHERE workspace_id=? AND run_id=?',(ws,row['run_id'])).fetchone()
        return {'attempt_no':row['attempt_no'],'phase':row['phase'],'experiment_id':row['experiment_id'],'work_item_id':row['work_item_id'],'attempt_id':attempt_id,'run_id':row['run_id'],'case_id':row['case_id'],'case_key':row['case_id'],'result_id':row['result_id'],'evaluator_id':row['evaluator_slot'],'evaluator_slot':row['evaluator_slot'],'fence':str(row['fence']),'lease_owner':row['lease_owner'],'lease_until_ms':row['lease_until_ms'],'checkpoint_revision':str(row['revision']),'plan_hash':plan[0]}

    def _active(self,con,token,ws,body):
        head=self._head(con,token,ws,body['experiment_id'],'write');scope=self.iam._authorize(con,token,ws,'execute','run',body['experiment_id'])
        cp=con.execute('SELECT * FROM experiment_attempt_checkpoints WHERE workspace_id=? AND experiment_id=? AND attempt_id=?',(ws,body['experiment_id'],body['attempt_id'])).fetchone()
        if cp is None or cp['actor_principal_id']!=scope.principal_id or cp['lease_owner']!=body.get('lease_owner') or str(cp['fence'])!=str(body.get('fence')):raise Conflict('Attempt actor, owner or fence differs')
        self._source_assets(con,scope,ws,head['experiment_id'],cp['run_id'],require_origin=True)
        attempt=con.execute('SELECT a.*,w.status AS item_status,w.cancel_requested,w.etag,w.evaluator_slot FROM work_attempts a JOIN work_items w ON w.workspace_id=a.workspace_id AND w.work_item_id=a.work_item_id WHERE a.workspace_id=? AND a.attempt_id=?',(ws,body['attempt_id'])).fetchone()
        case=self._case(con,ws,body['experiment_id'],cp['case_id'])
        slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND work_item_id=?',(ws,cp['work_item_id'])).fetchone()
        if attempt is None or slot is None or attempt['status']!='running' or attempt['item_status']!='running' or attempt['cancel_requested'] or attempt['etag']!=cp['fence'] or attempt['lease_until_ms']<=self.control.clock() or cp['lifecycle_revision']!=head['lifecycle_revision'] or cp['case_lifecycle_revision']!=case['lifecycle_revision']:raise Conflict('Attempt is expired, cancelled or superseded')
        if body.get('plan_hash') and body['plan_hash']!=self._handle(con,ws,cp['attempt_id'])['plan_hash']:raise Conflict('RunPlan hash differs')
        checkpoint=self._load(cp['payload_hash'],cp['payload_ref'])
        routes=checkpoint.get('source_routes')
        if routes is None:routes=self._source_routes(self._plan(con,ws,head['experiment_id'],cp['run_id'])[1],cp['case_id'])
        for manifest in routes:self._source_route(con,scope,ws,manifest)
        return head,dict(cp),dict(attempt),dict(slot)

    def _claim(self,con,token,ws,body,scope):
        head=self._head(con,token,ws,body['experiment_id'],'write');self.iam._authorize(con,token,ws,'execute','run',head['experiment_id']);worker=identifier(body['worker_id']);lease=self._lease(body);now=self.control.clock()
        if scope.principal_id!=head['created_by']:raise Forbidden('Scoring private inputs require the experiment owner')
        sql="""SELECT w.* FROM work_items w JOIN experiment_result_slots s ON s.workspace_id=w.workspace_id AND s.work_item_id=w.work_item_id JOIN experiment_cases c ON c.workspace_id=s.workspace_id AND c.case_id=s.case_id WHERE s.workspace_id=? AND s.experiment_id=? AND c.state='active' AND w.cancel_requested=0 AND w.next_attempt_at_ms<=? AND (w.status='queued' OR (w.status='running' AND EXISTS(SELECT 1 FROM work_attempts a WHERE a.workspace_id=w.workspace_id AND a.work_item_id=w.work_item_id AND a.status='running' AND a.lease_until_ms<=?)))""";params=[ws,head['experiment_id'],now,now]
        if body.get('run_id'):sql+=' AND w.run_id=?';params.append(body['run_id'])
        if body.get('result_id'):sql+=' AND s.result_id=?';params.append(body['result_id'])
        phase=body.get('phase','evaluate')
        if phase not in {'execute','evaluate'}:raise ValueError('Unsupported worker phase')
        sql+=' AND w.phase=?';params.append(phase)
        if body.get('case_id'):sql+=' AND w.case_key=?';params.append(body['case_id'])
        sql+=' ORDER BY w.priority DESC,w.created_at_ms,w.work_item_id LIMIT 1';row=con.execute(sql,tuple(params)).fetchone()
        if row is None:return None
        if phase=='evaluate' and head['scope']=='trace-flow-analysis':
            prior=con.execute('SELECT c.payload_hash,c.payload_ref FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.work_item_id=? AND c.run_id=? ORDER BY a.attempt_no DESC LIMIT 1',(ws,row['work_item_id'],row['run_id'])).fetchone()
            if prior:
                checkpoint=self._load(prior['payload_hash'],prior['payload_ref']).get('checkpoint',{})
                if '_flow_model_calls' in checkpoint:
                    calls=checkpoint['_flow_model_calls']
                    if not isinstance(calls,dict) or len(calls)>1000 or set(calls)!={str(index) for index in range(len(calls))}:return None
                    for call in calls.values():
                        if not isinstance(call,dict) or not isinstance(call.get('request_hash'),str) or not re.fullmatch('[0-9a-f]{64}',call['request_hash']) or call.get('state') not in {'observed','failed'} or call['state']=='observed' and not isinstance(call.get('response'),dict):return None
        if phase=='execute' and body.get('recovery_only_if_idle') is True:
            if con.execute("SELECT 1 FROM work_items w JOIN work_attempts a ON a.workspace_id=w.workspace_id AND a.work_item_id=w.work_item_id JOIN experiment_result_slots s ON s.workspace_id=w.workspace_id AND s.work_item_id=w.work_item_id JOIN experiment_cases c ON c.workspace_id=s.workspace_id AND c.case_id=s.case_id WHERE w.workspace_id=? AND w.run_id=? AND s.experiment_id=? AND c.state='active' AND w.phase='execute' AND w.status='running' AND w.cancel_requested=0 AND a.status='running' AND a.lease_until_ms>? LIMIT 1",(ws,row['run_id'],head['experiment_id'],now)).fetchone():return None
        item=row['work_item_id'];con.execute("UPDATE work_attempts SET status='expired',finished_at_ms=? WHERE workspace_id=? AND work_item_id=? AND status='running' AND lease_until_ms<=?",(now,ws,item,now))
        count=con.execute('SELECT COALESCE(MAX(a.attempt_no),0)+1 FROM work_attempts a JOIN work_items w ON w.workspace_id=a.workspace_id AND w.work_item_id=a.work_item_id WHERE w.workspace_id=? AND w.case_key=? AND w.evaluator_slot=? AND w.phase=?',(ws,row['case_key'],row['evaluator_slot'],row['phase'])).fetchone()[0];fence=revision(row['etag']+1);attempt=_id()
        con.execute("UPDATE work_items SET status='running',etag=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(fence,now,ws,item));con.execute("INSERT INTO work_attempts(workspace_id,attempt_id,work_item_id,attempt_no,fence,worker_id,status,lease_until_ms,started_at_ms) VALUES(?,?,?,?,?,?,'running',?,?)",(ws,attempt,item,count,fence,worker,now+lease,now))
        previous=con.execute("SELECT c.payload_hash,c.payload_ref,c.run_id,c.attempt_id FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id JOIN work_items w ON w.workspace_id=c.workspace_id AND w.work_item_id=c.work_item_id WHERE c.workspace_id=? AND c.case_id=? AND w.phase='execute' ORDER BY a.attempt_no DESC LIMIT 1",(ws,row['case_key'])).fetchone() if row['phase']=='execute' else None
        checkpoint={}
        if row['phase']=='execute' and previous:
            previous_payload=self._load(previous['payload_hash'],previous['payload_ref']);checkpoint=previous_payload['checkpoint']
            previous_request=previous_payload.get('execution_request')
            if previous_request is None:previous_request=self._plan(con,ws,head['experiment_id'],previous['run_id'])[1]['config'].get('execution_request',{})
            if checkpoint.get('command_id'):checkpoint['_command_target']=checkpoint.get('_command_target') or self._external_target(checkpoint['command_id'],checkpoint,previous_request,previous['attempt_id'])
            if checkpoint.get('command_id') and not checkpoint.get('cleanup_confirmed'):
                checkpoint['cleanup_required']=True
        if row['phase']=='evaluate' and head['scope']=='trace-flow-analysis':
            prior=con.execute('SELECT c.payload_hash,c.payload_ref FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.work_item_id=? AND c.run_id=? ORDER BY a.attempt_no DESC LIMIT 1',(ws,item,row['run_id'])).fetchone()
            if prior:
                observed=self._load(prior['payload_hash'],prior['payload_ref']).get('checkpoint',{})
                if '_flow_model_calls' in observed:checkpoint['_flow_model_calls']=copy.deepcopy(observed['_flow_model_calls'])
        self._source_assets(con,scope,ws,head['experiment_id'],row['run_id'],require_origin=True)
        _,plan=self._plan(con,ws,head['experiment_id'],row['run_id']);routes=self._source_routes(plan,row['case_key'])
        for manifest in routes:self._source_route(con,scope,ws,manifest)
        request=plan['config'].get('execution_request',{}) if row['phase']=='execute' else {}
        digest,ref=self._put({'phase':row['phase'],'execution_request':self._request_summary(request),'source_routes':routes,'checkpoint':checkpoint});case=self._case(con,ws,head['experiment_id'],row['case_key'])
        con.execute("INSERT INTO experiment_attempt_checkpoints(workspace_id,experiment_id,case_id,run_id,work_item_id,attempt_id,fence,lease_owner,actor_principal_id,lifecycle_revision,case_lifecycle_revision,payload_hash,payload_ref,stage,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?)",(ws,head['experiment_id'],row['case_key'],row['run_id'],item,attempt,fence,worker,scope.principal_id,head['lifecycle_revision'],case['lifecycle_revision'],digest,ref,now,now))
        con.execute("UPDATE experiment_result_slots SET status='running',revision=revision+1,evaluation_version=evaluation_version+1,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,ws,item));self._bump(con,ws,head['experiment_id'],status='running')
        return self._handle(con,ws,attempt)

    @staticmethod
    def _lease(body):
        lease=body.get('lease_ms',30000)
        if type(lease) is not int or not 0<lease<=3600000:raise ValueError('Lease must be 1..3600000 milliseconds')
        return lease

    def _renew(self,con,token,ws,body,scope):
        _,cp,_,_=self._active(con,token,ws,body);until=self.control.clock()+self._lease(body)
        con.execute('UPDATE work_attempts SET lease_until_ms=? WHERE workspace_id=? AND attempt_id=?',(until,ws,cp['attempt_id']))
        return self._handle(con,ws,cp['attempt_id'])

    def _load_work(self,con,token,ws,body):
        head,cp,_,slot=self._active(con,token,ws,body);_,plan=self._plan(con,ws,head['experiment_id'],cp['run_id'])
        self._guard_sources(con,token,ws,head['experiment_id'],plan=plan)
        case=next((v for v in plan['cases'] if v['id']==cp['case_id']),None)
        if case is None:raise StorageError('Frozen Case is missing')
        evidence=plan['frozen_trace_evidence'].get(cp['case_id'])
        payload=self._load(cp['payload_hash'],cp['payload_ref'])
        if payload.get('phase')=='execute':
            public={k:case[k] for k in ('id','input','datasetInput','groupId','faultInjectionType') if k in case}
            return {'handle':self._handle(con,ws,cp['attempt_id']),'raw_case':public,'execution_request':plan['config'].get('execution_request',{}),'cleanup_required':bool(payload['checkpoint'].get('cleanup_required')),'cleanup_target':payload['checkpoint'].get('_command_target') if payload['checkpoint'].get('cleanup_required') else None,'experiment_config':{k:plan['experiment_config'].get(k) for k in ('id','name','agentName','scope','skillName','skillVersion')},'frozen_trace_evidence':None,'frozen_evaluator':None,'runplan':{k:plan[k] for k in ('run_id','experiment_id','generation','phase','expected_case_count')},'checkpoint':payload['checkpoint']}
        return {'handle':self._handle(con,ws,cp['attempt_id']),'raw_case':case,'experiment_config':plan['experiment_config'],'frozen_trace_evidence':evidence,'frozen_evaluator':plan['frozen_evaluators'][slot['evaluator_id']],'runplan':plan,'checkpoint':payload['checkpoint']}

    def _checkpoint(self,con,token,ws,body,scope):
        head,cp,_,_=self._active(con,token,ws,body)
        if str(body.get('expected_revision'))!=str(cp['revision']):raise Conflict('Checkpoint revision is stale')
        value=body.get('checkpoint')
        if not isinstance(value,dict):raise ValueError('Checkpoint must be an object')
        old=self._load(cp['payload_hash'],cp['payload_ref']);prior=old['checkpoint'];provided=set(value);value={**prior,**value}
        old_command=prior.get('command_id') or cp['command_id'];command=value.get('command_id',old_command);trace=value.get('trace_id',cp['trace_id'])
        replacing=old_command and command!=old_command
        if replacing and (old.get('phase')!='execute' or not prior.get('cleanup_confirmed')):raise Conflict('Previous external command cleanup is not confirmed')
        cleaned=list(prior.get('_cleaned_commands',[]))
        if replacing:
            value['cleanup_confirmed']=False
            if old_command not in cleaned:cleaned.append(old_command)
            for key in ('fi_run_id','fi_task_key','observed_trace_id','trace_id'):
                if key not in provided:value.pop(key,None)
        if len(cleaned)>MAX_ITEMS:raise ExperimentTooLarge('External cleanup history exceeds budget')
        value['_cleaned_commands']=cleaned
        if command:
            request=old.get('execution_request')
            if request is None:request=self._plan(con,ws,head['experiment_id'],cp['run_id'])[1]['config'].get('execution_request',{})
            value['_command_target']=prior.get('_command_target') if not replacing and prior.get('_command_target') else self._external_target(command,value,request,cp['attempt_id'])
        if value.get('cleanup_confirmed'):value['cleanup_required']=False
        if command:
            foreign=con.execute('SELECT work_item_id FROM experiment_attempt_checkpoints WHERE workspace_id=? AND command_id=? AND case_id<>?',(ws,command,cp['case_id'])).fetchone()
            if foreign:raise Conflict('External command belongs to another work item')
        digest,ref=self._put(old|{'checkpoint':value})
        if cp['command_id'] and cp['command_id']!=command and not replacing or cp['trace_id'] and cp['trace_id']!=trace:raise Conflict('Attempt command/Trace identity is frozen after binding')
        if trace:self.iam._authorize(con,token,ws,'read','trace',trace)
        con.execute('UPDATE experiment_attempt_checkpoints SET payload_hash=?,payload_ref=?,stage=?,command_id=?,trace_id=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND attempt_id=?',(digest,ref,value.get('stage','running'),command,trace,self.control.clock(),ws,cp['attempt_id']))
        return self._handle(con,ws,cp['attempt_id'])

    def _complete(self,con,token,ws,body,scope,failed=False):
        head,cp,attempt,slot=self._active(con,token,ws,body);result=copy.deepcopy(body.get('result',{}))
        if not isinstance(result,dict):raise ValueError('Machine result must be an object')
        result.pop('cleanupUnconfirmed',None);failure_code='EVALUATION_FAILED' if failed else None
        if failed:
            error=body.get('error','Evaluation failed');result.update(errorMessage=error if isinstance(error,str) else str(error.get('message','Evaluation failed')),status='failed')
            if isinstance(error,dict) and error.get('code')=='EVALUATION_CLEANUP_UNCONFIRMED':failure_code=error['code'];result.update(cleanupUnconfirmed=True,score=None)
        else:result['status']='done'
        if slot['evaluator_id']==EXECUTION_SLOT:raise Conflict('Execution attempts cannot submit machine evaluation results')
        score=result.get('score')
        if score is not None and (type(score) not in (float,int) or not math.isfinite(score) or not 0<=score<=100):raise ValueError('Machine score must be finite 0..100 or null')
        for k in ('humanScore','humanReason','humanBy','humanAt','id','caseId','experimentId','evaluatorId','user'):result.pop(k,None)
        self._record_derived(con,token,ws,scope,head,cp,slot,None,result,validate_only=True)
        packet={'format':'agent-insight.machine-result','version':1,'result':result,'run_id':cp['run_id'],'case_key':cp['case_id'],'evaluator_slot':slot['evaluator_id'],'attempt_id':cp['attempt_id'],'fence':str(cp['fence'])};digest,ref=self._put(packet)
        now=self.control.clock();machine=_id();receipt=_id()
        con.execute('INSERT INTO result_receipts(workspace_id,run_id,work_item_id,case_key,evaluator_slot,receipt_id,attempt_id,receipt_key,result_id,content_hash,artifact_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(ws,cp['run_id'],cp['work_item_id'],cp['case_id'],slot['evaluator_id'],receipt,cp['attempt_id'],body['operation_key'],machine,digest,ref,now))
        self._record_derived(con,token,ws,scope,head,cp,slot,machine,result)
        selected=con.execute('SELECT selection_revision FROM result_selections WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(ws,cp['run_id'],cp['case_id'],slot['evaluator_id'])).fetchone();selection=selected[0]+1 if selected else 1
        if selected:con.execute('UPDATE result_selections SET result_id=?,selection_revision=?,updated_at_ms=? WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(machine,selection,now,ws,cp['run_id'],cp['case_id'],slot['evaluator_id']))
        else:con.execute('INSERT INTO result_selections VALUES(?,?,?,?,?,?,?)',(ws,cp['run_id'],cp['case_id'],slot['evaluator_id'],machine,selection,now))
        status='failed' if failed else 'done';con.execute('UPDATE work_attempts SET status=?,finished_at_ms=?,error_code=? WHERE workspace_id=? AND attempt_id=?',(status,now,failure_code,ws,cp['attempt_id']));con.execute('UPDATE work_items SET status=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?',(status,now,ws,cp['work_item_id']))
        con.execute('UPDATE experiment_result_slots SET selected_result_id=?,review_id=NULL,status=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?',(machine,status,now,ws,slot['result_id']))
        event={'experiment_id':head['experiment_id'],'lifecycle_revision':head['lifecycle_revision'],'result_id':machine,'content_hash':digest,'artifact_ref':ref,'run_id':cp['run_id'],'attempt_id':cp['attempt_id'],'case_key':cp['case_id'],'evaluator_slot':slot['evaluator_id'],'selection_revision':selection,'slot_id':slot['result_id'],'result_bucket':_iso(now)[:10],'case_lifecycle_revision':cp['case_lifecycle_revision'],'source_trace_id':self._case(con,ws,head['experiment_id'],cp['case_id'])['trace_id']}
        event['authorization']=self._delivery_authorization(con,token)
        con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'evaluation.result.accepted.v1',?,?,?)",(ws,_id(),cp['attempt_id'],cp['fence'],canonical_json(event),self._queued_at(con,now),now));self._settle(con,ws,head['experiment_id'])
        return self._snapshot(con,ws,self._head(con,token,ws,head['experiment_id']))

    def _settle(self,con,ws,exp):
        head=con.execute('SELECT current_run_id FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()
        if head is None:raise ExperimentNotFound('Experiment not found')
        current=head['current_run_id'];subject='subject_id IS NULL' if current is None else 'subject_id=?'
        parameters=(ws,exp)+(() if current is None else (current,))+(MAX_ANNOTATIONS+1,)
        cancellations=con.execute("SELECT payload_hash,payload_ref FROM experiment_annotations WHERE workspace_id=? AND experiment_id=? AND kind='cancellation' AND "+subject+' LIMIT ?',parameters).fetchall()
        if len(cancellations)>MAX_ANNOTATIONS:raise ExperimentTooLarge('Experiment cancellation history exceeds budget')
        global_cancelled=any(self._load(row['payload_hash'],row['payload_ref']).get('caseKey')=='' for row in cancellations)
        rows=con.execute("SELECT s.status FROM experiment_result_slots s JOIN experiment_cases c ON c.workspace_id=s.workspace_id AND c.case_id=s.case_id WHERE s.workspace_id=? AND s.experiment_id=? AND c.state='active'",(ws,exp)).fetchall();states=[r[0] for r in rows]
        status='running' if any(s in {'pending','running'} for s in states) else 'cancelled' if states and all(s=='cancelled' for s in states) else 'failed' if states and all(s=='failed' for s in states) else 'partial' if any(s in {'failed','cancelled'} for s in states) else 'done' if states else 'draft'
        if global_cancelled:status='cancelled'
        self._bump(con,ws,exp,status=status)
        for row in con.execute('SELECT run_id FROM experiment_runs WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchall():
            states=[r[0] for r in con.execute('SELECT status FROM work_items WHERE workspace_id=? AND run_id=?',(ws,row[0])).fetchall()];runstatus='running' if any(v in {'running','queued'} for v in states) else 'cancelled' if states and all(v=='cancelled' for v in states) else 'failed' if states and all(v=='failed' for v in states) else 'partial' if any(v in {'failed','cancelled'} for v in states) else 'done'
            if global_cancelled and row[0]==current:runstatus='cancelled'
            con.execute('UPDATE runs SET status=?,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND run_id=?',(runstatus,self.control.clock(),ws,row[0]))

    def _retry(self,con,token,ws,body,scope):
        head=self._head(con,token,ws,body['experiment_id'],'write');self.iam._authorize(con,token,ws,'execute','run',head['experiment_id']);now=self.control.clock()
        if scope.principal_id!=head['created_by']:raise Forbidden('Private scoring retries require the experiment owner')
        if body.get('result_id'):slots=[self._slot(con,ws,head['experiment_id'],body['result_id'])]
        else:
            self._case(con,ws,head['experiment_id'],body['case_id']);slots=[dict(r) for r in con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND case_id=?',(ws,head['experiment_id'],body['case_id'])).fetchall()]
        if not slots:raise ExperimentNotFound('No frozen result slots to retry')
        by_run={}
        for slot in slots:by_run.setdefault(slot['run_id'],[]).append(slot)
        for prior_run,selected in by_run.items():
            old_run,old_plan=self._plan(con,ws,head['experiment_id'],prior_run);run=_id();plan=copy.deepcopy(old_plan)
            case_ids={v['case_id'] for v in selected};plan['cases']=[v for v in plan['cases'] if v['id'] in case_ids];plan['run_id']=run;plan['parent_run_id']=prior_run;plan['expected_case_count']=len(case_ids);plan['work_members']=[{'case_key':value['case_id'],'evaluator_slot':value['evaluator_id']} for value in selected]
            manual=None
            if head['scope']=='benchmark' and con.execute('SELECT 1 FROM benchmark_experiment_bindings WHERE workspace_id=? AND experiment_id=?',(ws,head['experiment_id'])).fetchone():
                manual=self._delivery_authorization(con,token);plan['releases']={key:value for key,value in plan['releases'].items() if not key.startswith('benchmark:manual-origin:')};plan['releases']['benchmark:manual-origin:'+manual['kind']+':'+manual['credential_id']]=plan['releases']['benchmark']
            generation=con.execute('SELECT COALESCE(MAX(generation),0)+1 FROM experiment_runs WHERE workspace_id=? AND experiment_id=?',(ws,head['experiment_id'])).fetchone()[0];plan['generation']=generation
            digest,ref=self._put(plan,MAX_BYTES)
            con.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,dataset_release_id,expected_case_count,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,'draft',?,?)",(ws,run,old_run['name'],digest,ref,old_run['dataset_release_id'],len(case_ids),now,now))
            con.execute('INSERT INTO experiment_runs VALUES(?,?,?,?,?,?,?)',(ws,head['experiment_id'],run,generation,head['lifecycle_revision'],scope.principal_id,now))
            if manual:
                receipt_key=run+':'+manual['kind']+':'+manual['credential_id'];packet={'format':'benchmark.supplemental-manual-retry/v1','experiment_id':head['experiment_id'],'run_id':run,'parent_run_id':prior_run,'authorization':manual,'members':plan['work_members']};response_hash,response_ref=self._put(packet)
                con.execute('INSERT INTO benchmark_operation_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)',(ws,scope.principal_id,'supplemental-manual-retry',receipt_key,_hash(packet),head['experiment_id'],None,None,response_hash,response_ref,now))
                for key,release in plan['releases'].items():con.execute('INSERT INTO run_inputs VALUES(?,?,?,?,?,?)',(ws,run,key,release,_hash(plan['config']),now))
            else:
                for item in con.execute('SELECT * FROM run_inputs WHERE workspace_id=? AND run_id=?',(ws,prior_run)).fetchall():con.execute('INSERT INTO run_inputs VALUES(?,?,?,?,?,?)',(ws,run,item['slot'],item['release_id'],item['config_hash'],now))
            for slot in selected:
                self._case(con,ws,head['experiment_id'],slot['case_id']);old_item=con.execute('SELECT * FROM work_items WHERE workspace_id=? AND work_item_id=?',(ws,slot['work_item_id'])).fetchone()
                if old_item is None:raise Conflict('Result slot has no frozen work item')
                con.execute("UPDATE work_attempts SET status='cancelled',finished_at_ms=? WHERE workspace_id=? AND work_item_id=? AND status='running'",(now,ws,slot['work_item_id']))
                if old_item['status'] in {'running','queued'}:con.execute("UPDATE work_items SET status='cancelled',cancel_requested=1,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,ws,slot['work_item_id']))
                item=_id();con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,etag,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'evaluate',?,'queued',?,?,?)",(ws,item,run,slot['case_id'],slot['evaluator_id'],revision(old_item['etag']+1),now,now))
                con.execute("UPDATE experiment_result_slots SET run_id=?,work_item_id=?,selected_result_id=NULL,review_id=NULL,status='pending',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?",(run,item,now,ws,slot['result_id']))
            con.execute("UPDATE runs SET status='queued',updated_at_ms=? WHERE workspace_id=? AND run_id=?",(now,ws,run));head['current_run_id']=run
        self._bump(con,ws,head['experiment_id'],status='running',current_run_id=head['current_run_id']);return self._snapshot(con,ws,self._head(con,token,ws,head['experiment_id']))

    def _annotation(self,con,token,ws,body,scope,kind):
        exp=body['experiment_id'];head=self._head(con,token,ws,exp,'delete' if kind=='comment_remove' else 'write');case_id=body.get('case_id');result_id=body.get('result_id');machine=None;subject=None;now=self.control.clock();identity=_id()
        if result_id:
            slot=self._slot(con,ws,exp,result_id)
            if case_id and case_id!=slot['case_id']:raise Conflict('Comment result belongs to another Case')
            case_id=slot['case_id'];machine=slot['selected_result_id']
        if case_id:self._case(con,ws,exp,case_id)
        if kind=='review':
            if not result_id or not machine:raise Conflict('Review requires an immutable machine result')
            expected=body.get('expected_revision')
            if expected is not None and str(expected)!=str(slot['revision']):raise Conflict('Review slot revision is stale')
            score=body.get('human_score');reason=body.get('human_reason','')
            if score is not None and (type(score) not in (int,float) or not math.isfinite(score) or not 0<=score<=100 or not isinstance(reason,str) or not reason.strip()):raise ValueError('Human score requires 0..100 and a reason')
            value={'humanScore':self._human_score(score) if score is not None else None,'humanReason':reason if score is not None else None,'humanBy':self._owner(con,scope.principal_id) if score is not None else None,'humanAt':_iso(now) if score is not None else None}
        elif kind=='comment':
            text=body.get('body','')
            if not isinstance(text,str) or not text.strip() or len(text.encode())>65536:raise ValueError('Comment must be bounded nonempty text')
            value={'id':identity,'experimentId':exp,'caseId':case_id,'resultId':result_id,'user':self._owner(con,scope.principal_id),'body':text,'createdAt':_iso(now)}
        else:
            subject=body['comment_id'];old=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND experiment_id=? AND annotation_id=? AND kind='comment'",(ws,exp,subject)).fetchone()
            if old is None:raise ExperimentNotFound('Comment not found')
            grant=self.iam._workspace(scope,ws,'delete')
            if old['actor_principal_id']!=scope.principal_id and grant.role not in {'owner','admin','personal'}:raise Forbidden('Only comment author or administrator may remove it')
            value={'removed':True,'comment_id':subject}
        digest,ref=self._put(value);con.execute('INSERT INTO experiment_annotations(workspace_id,experiment_id,annotation_id,kind,case_id,result_id,machine_result_id,subject_id,actor_principal_id,payload_hash,payload_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(ws,exp,identity,kind,case_id,result_id,machine,subject,scope.principal_id,digest,ref,now))
        if kind=='review':
            con.execute('UPDATE experiment_result_slots SET review_id=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?',(identity,now,ws,result_id))
            con.execute('UPDATE result_selections SET selection_revision=selection_revision+1,updated_at_ms=? WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(now,ws,slot['run_id'],slot['case_id'],slot['evaluator_id']))
            selected=con.execute('SELECT selection_revision FROM result_selections WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(ws,slot['run_id'],slot['case_id'],slot['evaluator_id'])).fetchone()
            machine_receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,machine)).fetchone()
            event={'experiment_id':exp,'lifecycle_revision':head['lifecycle_revision'],'result_id':machine,'content_hash':machine_receipt['content_hash'],'artifact_ref':machine_receipt['artifact_ref'],'run_id':slot['run_id'],'attempt_id':machine_receipt['attempt_id'],'case_key':slot['case_id'],'evaluator_slot':slot['evaluator_id'],'selection_revision':selected[0],'slot_id':result_id,'result_bucket':_iso(machine_receipt['created_at_ms'])[:10],'review_id':identity,'review_hash':digest,'review_ref':ref,'case_lifecycle_revision':self._case(con,ws,exp,slot['case_id'])['lifecycle_revision'],'source_trace_id':self._case(con,ws,exp,slot['case_id'])['trace_id']}
            event['authorization']=self._delivery_authorization(con,token)
            con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,1,'evaluation.result.accepted.v1',?,?,?)",(ws,_id(),identity,canonical_json(event),self._queued_at(con,now),now))
        self._bump(con,ws,exp)
        return self._snapshot(con,ws,self._head(con,token,ws,exp)) if kind=='review' else value

    def _benchmark_dispatch_guard(self,con,ws,action,body,scope=None):
        if action not in {'case_upsert','case_upsert_many','case_remove','cancel','remove','cancellation_update','start','execute_start','retry'}:return
        if not con.execute('SELECT 1 FROM schema_meta WHERE version=12').fetchone():return
        if not con.execute('SELECT 1 FROM benchmark_experiment_bindings WHERE workspace_id=? AND experiment_id=?',(ws,body.get('experiment_id'))).fetchone():return
        if action=='retry' and body.get('result_id') and not body.get('case_id'):
            head=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,body['experiment_id'])).fetchone()
            if scope is None or scope.principal_id!=head['created_by']:raise Forbidden('Benchmark supplemental retry requires original owner')
            self.iam._authorize_scope(con,scope,ws,'execute','run',head['experiment_id'])
            slot=self._slot(con,ws,head['experiment_id'],body['result_id']);work=con.execute('SELECT * FROM work_items WHERE workspace_id=? AND work_item_id=?',(ws,slot['work_item_id'])).fetchone()
            if work is not None and work['phase']=='evaluate' and not slot['evaluator_id'].startswith('benchmark:') and slot['evaluator_id']!=EXECUTION_SLOT:
                if slot['status'] not in {'done','failed'}:raise Conflict('Benchmark supplemental work is not terminal')
                from .benchmark_cancellation import native_confirmed
                checkpoints=con.execute("SELECT c.*,a.status AS attempt_status,a.error_code FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id JOIN work_items w ON w.workspace_id=c.workspace_id AND w.work_item_id=c.work_item_id WHERE c.workspace_id=? AND c.experiment_id=? AND c.case_id=? AND w.phase='evaluate' AND w.evaluator_slot=? LIMIT 20001",(ws,head['experiment_id'],slot['case_id'],slot['evaluator_id'])).fetchall()
                if len(checkpoints)>20000:raise ExperimentTooLarge('Native supplemental cleanup history exceeds budget')
                for checkpoint in checkpoints:
                    if checkpoint['attempt_status'] in {'running','cancelled','expired'} or checkpoint['error_code']=='EVALUATION_CLEANUP_UNCONFIRMED':
                        if not native_confirmed(self,con,ws,head['experiment_id'],checkpoint):raise Conflict('Native scoring cleanup is unconfirmed')
                _,plan=self._plan(con,ws,head['experiment_id'],slot['run_id']);parent=plan.get('config',{}).get('benchmark_continuation_parent_job_id')
                if not parent or not plan.get('frozen_trace_evidence',{}).get(slot['case_id']):raise Conflict('Benchmark supplemental retry requires its frozen execution Trace')
                self._case(con,ws,head['experiment_id'],slot['case_id']);self._source_assets(con,scope,ws,head['experiment_id'],slot['run_id'])
                for manifest in self._source_routes(plan,slot['case_id']):self._source_route(con,scope,ws,manifest)
                return
        if action in {'case_upsert','case_upsert_many'}:raise Conflict('Benchmark Cases use their frozen Dataset input; create a new selection or use typed retry')
        if action in {'start','execute_start','retry'}:raise ExperimentUnavailable('Benchmark plans require their typed domain entry point')
        raise ExperimentUnavailable('Typed Benchmark process cancellation is required before deleting or cancelling its work')

    def dispatch(self,action,token,workspace_id,body=None):
        ws=identifier(workspace_id);body=copy.deepcopy(body or {})
        if not isinstance(body,dict):raise ValueError('Experiment RPC body must be an object')
        if len(_json(body).encode())>MAX_BYTES:raise ExperimentTooLarge('Experiment request exceeds budget')
        reads={'list','read','get','runplan','load_work','check_work','comments'};ephemeral={'claim','renew','reconcile'}
        allowed=reads|ephemeral|{'create','ensure','update','case_upsert','case_upsert_many','case_remove','bind_trace','start','checkpoint','complete','fail','execute_start','execute_complete','execute_fail','execute_reconcile','cancellation_update','retry','cancel','remove','review','comment','comment_remove'}
        if action=='derived_issue_resolve':return self._resolve_derived_issues(token,ws,body)
        if action=='derived_resolution_scope':
            with self.control.read_transaction() as con:
                scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read');self.iam._workspace(scope,ws,'write')
                return {'fingerprint':scope.fingerprint}
        if action=='lookup_operation':
            kind=body.get('operation_kind')
            if kind not in allowed-reads-ephemeral:raise ValueError('Unsupported Experiment receipt kind')
            if not isinstance(body.get('operation_request'),dict):raise ValueError('Exact Experiment operation request required')
            with self.control.read_transaction() as con:
                scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
                _,_,receipt=self._receipt(con,scope,ws,kind,body)
                if receipt is None:return {'found':False}
                result=self._load(receipt['response_hash'],receipt['response_ref'],MAX_BYTES)
                exp=receipt['experiment_id']
            return {'found':True,'result':self._response(token,ws,kind,exp,result)}
        if action=='cancellations':return self._pending_cancellations(token,ws,body)
        if action=='cancellation_route':return self._cancellation_route(token,ws,body)
        if action=='list_view':return self._list_view(token,ws,body)
        if action=='flow_lookup':return self._flow_lookup(token,ws,body)
        if action=='derived_detail':return self._derived_detail(token,ws,body['id'])
        if action=='derived_trigger_frontier':return self._derived_trigger_frontier(token,ws,body)
        if action=='ensure_lookup':return self._ensure_lookup(token,ws,body)
        if action=='derived_counts':
            with self.control.read_transaction() as con:
                self._head(con,token,ws,body['experiment_id']);return self._derived_counts(con,ws,body['experiment_id'])
        if action in {'derived_lookup','derived_list'}:return self._derived_read(action,token,ws,body)
        if action=='execute_start':body['_execute']=True
        if action=='execute_reconcile':
            with self.control.read_transaction() as con:body['experiment_id']=self._case_lookup(con,token,ws,body)['experiment_id']
        if action=='case_lookup':
            with self.control.read_transaction() as con:return self._case_lookup(con,token,ws,body)
        if action in {'cancellation_lookup','cancellation_update'}:
            with self.control.read_transaction() as con:
                current=self._cancellation(con,token,ws,body['cancellation_id'])
                if action=='cancellation_lookup':return current
                body['experiment_id']=current['experimentId']
        if action=='result_lookup':
            with self.control.read_transaction() as con:
                scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
                slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND result_id=?',(ws,body['result_id'])).fetchone()
                if slot is None:raise ExperimentNotFound('Experiment result not found')
                self._head(con,token,ws,slot['experiment_id']);self._case(con,ws,slot['experiment_id'],slot['case_id'])
                return {key:slot[key] for key in ('experiment_id','case_id','result_id','evaluator_id','status')}
        if action=='read_view':
            if body.get('experiment_id'):
                return {'snapshots':[self.dispatch('read',token,ws,{'experiment_id':body['experiment_id']})],'coverage':'complete'}
            values=self.dispatch('list',token,ws,{k:v for k,v in body.items() if k in {'scope','skill_name'}}|{'limit':MAX_ITEMS,'_all':True,'_full':True,'_hide_internal':True})
            return {'snapshots':values,'coverage':'complete'}
        if action=='baseline_view':return self._baseline_view(token,ws,body['experiment_id'])
        if action not in allowed:raise ValueError('Unsupported Experiment action')
        if action in reads:
            with self.control.read_transaction() as con:
                scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
                if action=='list':
                    limit=body.get('limit',100)
                    if type(limit) is not int or not 1<=limit<=MAX_ITEMS:raise ValueError('Invalid list limit')
                    grant=self.iam._workspace(scope,ws,'read');where="e.workspace_id=? AND e.state='active' AND e.experiment_id>?";params=[ws,body.get('after_id','')]
                    if body.get('_hide_internal') is True:where+=" AND e.scope<>'trace-flow-analysis'"
                    for key,col in [('scope','scope'),('skill_name','skill_name')]:
                        if key in body:where+=' AND e.'+col+'=?';params.append(body[key])
                    if grant.role not in {'owner','admin','personal'}:where+=" AND (a.owner_principal_id=? OR a.visibility='group' OR EXISTS(SELECT 1 FROM iam_resource_grants g WHERE g.workspace_id=a.workspace_id AND g.resource_kind=a.resource_kind AND g.resource_id=a.resource_id AND g.grantee_principal_id=?))";params.extend([scope.principal_id,scope.principal_id])
                    if body.get('owned_only') is True:where+=' AND a.owner_principal_id=?';params.append(scope.principal_id)
                    params.append(limit+1 if body.get('_all') else limit);rows=con.execute("SELECT e.* FROM experiment_heads e JOIN iam_resource_access a ON a.workspace_id=e.workspace_id AND a.resource_kind='run' AND a.resource_id=e.experiment_id WHERE "+where+' ORDER BY e.experiment_id LIMIT ?',tuple(params)).fetchall()
                    if body.get('_all') and len(rows)>limit:raise ExperimentTooLarge('Experiment view count exceeds budget')
                    result=[];size=0
                    for row in rows:
                        if body.get('_full'):self._guard_sources(con,token,ws,row['experiment_id'])
                        value=self._snapshot(con,ws,dict(row),include_cases=body.get('_full',False));size+=len(_json(value).encode())
                        if size>MAX_BYTES:raise ExperimentTooLarge('Experiment list exceeds budget')
                        result.append(value)
                else:
                    head=self._head(con,token,ws,body['experiment_id'])
                    if action in {'read','get'}:
                        if body.get('include_cases',True):self._guard_sources(con,token,ws,head['experiment_id'])
                        result=self._snapshot(con,ws,head,body.get('case_ids'),body.get('include_cases',True))
                    elif action=='runplan':
                        if scope.principal_id!=head['created_by']:raise Forbidden('RunPlan private inputs require the experiment owner')
                        row,plan=self._plan(con,ws,head['experiment_id'],body.get('run_id'));self._guard_sources(con,token,ws,head['experiment_id'],plan=plan);result={'run_id':row['run_id'],'plan_hash':row['plan_hash'],'runplan':plan,'status':row['status']}
                    elif action=='load_work':result=self._load_work(con,token,ws,body)
                    elif action=='check_work':self._active(con,token,ws,body);result={'active':True}
                    else:result=self._comments_tx(con,ws,head['experiment_id'])
                result=self._redact(result,scope.principal_id)
                fingerprint=scope.fingerprint
            with self.control.read_transaction() as con:
                current=self.iam._scope(con,token);self.iam._workspace(current,ws,'read')
                if current.fingerprint!=fingerprint:raise Forbidden('Experiment authorization changed while reading')
                if action!='list':
                    self._head(con,token,ws,body['experiment_id'])
                    if action in {'load_work','check_work'}:self._active(con,token,ws,body)
                    if action in {'read','get'} and body.get('include_cases',True):self._guard_sources(con,token,ws,body['experiment_id'])
                    if action in {'runplan','load_work'}:self._guard_sources(con,token,ws,body['experiment_id'],run_id=result.get('run_id') if action=='runplan' else result['handle']['run_id'])
                else:
                    for envelope in result:
                        self._head(con,token,ws,envelope['experiment']['id'])
                        if body.get('_full'):self._guard_sources(con,token,ws,envelope['experiment']['id'])
            return result
        capability='delete' if action in {'remove','case_remove','comment_remove'} else 'write'
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,capability);self.iam._workspace(scope,ws,'read')
            if action not in {'create','ensure'}:self._head(con,token,ws,body['experiment_id'],capability,deleted=action in {'remove','case_remove','cancellation_update'})
            if action not in ephemeral:
                _,_,receipt=self._receipt(con,scope,ws,action,body)
                if receipt:
                    self._head(con,token,ws,receipt['experiment_id'],'read',deleted=action in {'remove','case_remove','cancellation_update'});return self._response(token,ws,action,receipt['experiment_id'],self._load(receipt['response_hash'],receipt['response_ref'],MAX_BYTES))
            self._benchmark_dispatch_guard(con,ws,action,body,scope)
        prepared=self._prepare_start(token,ws,body) if action in {'start','execute_start'} else self._prepare_execution(token,ws,body) if action=='execute_complete' else self._prepare_late_execution(token,ws,body) if action=='execute_reconcile' else None
        with self.control.transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,capability);self.iam._workspace(scope,ws,'read')
            if action not in {'create','ensure'}:self._head(con,token,ws,body['experiment_id'],capability,deleted=action in {'remove','case_remove','cancellation_update'})
            if action not in ephemeral:
                key,digest,receipt=self._receipt(con,scope,ws,action,body)
                if receipt:self._head(con,token,ws,receipt['experiment_id'],'read',deleted=action in {'remove','case_remove','cancellation_update'});return self._response(token,ws,action,receipt['experiment_id'],self._load(receipt['response_hash'],receipt['response_ref'],MAX_BYTES))
            self._benchmark_dispatch_guard(con,ws,action,body,scope)
            if action=='create':result=self._create(con,token,ws,body,scope)
            elif action=='ensure':result=self._ensure(con,token,ws,body,scope)
            elif action=='update':result=self._update(con,token,ws,body,scope)
            elif action in {'start','execute_start'}:result=self._start(con,token,ws,body,scope,prepared)
            elif action=='claim':result=self._claim(con,token,ws,body,scope)
            elif action=='renew':result=self._renew(con,token,ws,body,scope)
            elif action=='execute_reconcile':result=self._execute_reconcile(con,token,ws,body,scope,prepared)
            elif action=='execute_complete':result=self._execute_complete(con,token,ws,body,scope,prepared)
            elif action=='execute_fail':result=self._execute_fail(con,token,ws,body,scope)
            elif action=='cancellation_update':result=self._cancellation_update(con,token,ws,body,scope)
            elif action=='checkpoint':result=self._checkpoint(con,token,ws,body,scope)
            elif action in {'complete','fail'}:result=self._complete(con,token,ws,body,scope,action=='fail')
            elif action=='retry':result=self._retry(con,token,ws,body,scope)
            elif action in {'review','comment','comment_remove'}:result=self._annotation(con,token,ws,body,scope,{'review':'review','comment':'comment','comment_remove':'comment_remove'}[action])
            elif action=='case_upsert_many':result=self._case_upsert_many(con,token,ws,body,scope)
            elif action in {'case_upsert','bind_trace'}:
                head=self._head(con,token,ws,body['experiment_id'],'write');self._check_revision(head,body.get('expected_revision'));value=body.get('case') or {'id':body['case_id'],'taskId':body.get('task_id'),'executionId':body.get('execution_id')}
                count=con.execute('SELECT COUNT(*) FROM experiment_cases WHERE workspace_id=? AND experiment_id=?',(ws,head['experiment_id'])).fetchone()[0]
                if count>=MAX_CASES and not con.execute('SELECT 1 FROM experiment_cases WHERE workspace_id=? AND case_id=?',(ws,value.get('id'))).fetchone():raise ExperimentTooLarge('Experiment Cases exceed budget')
                value=copy.deepcopy(value);value.setdefault('id',_id());existing=con.execute('SELECT 1 FROM experiment_cases WHERE workspace_id=? AND case_id=?',(ws,value['id'])).fetchone()
                identity=self._case_write(con,token,ws,head['experiment_id'],value,count,only_if_new=body.get('only_if_new') is True);reused=bool(body.get('only_if_new') and (existing or identity!=value['id']))
                if not reused:self._bump(con,ws,head['experiment_id'])
                result=self._snapshot(con,ws,self._head(con,token,ws,head['experiment_id']));result.update(case_id=identity,reused=reused)
            elif action in {'cancel','remove','case_remove'}:
                head=self._head(con,token,ws,body['experiment_id'],capability,deleted=action in {'remove','case_remove','cancellation_update'});self._check_revision(head,body.get('expected_revision'));case_id=body.get('case_id') if action!='remove' else None;now=self.control.clock()
                if action=='remove' and body.get('draft_only') and (head['status']!='draft' or head['state']!='active'):raise Conflict('Draft compensation cannot remove a started Experiment')
                if action=='case_remove' and head['state']!='active':raise ExperimentNotFound('Experiment is deleted')
                _,case_ids=self._cancel_case_scope(con,ws,head,case_id)
                cancellation=self._append_cancel(con,ws,head,case_id,scope)
                if case_id is None:self._cancel_items(con,ws,head['experiment_id'])
                else:
                    for actual_case_id in case_ids:self._cancel_items(con,ws,head['experiment_id'],actual_case_id)
                if action=='case_remove':
                    for actual_case_id in case_ids:con.execute("UPDATE experiment_cases SET state='deleted',deleted_at_ms=?,revision=revision+1,lifecycle_revision=lifecycle_revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=?",(now,now,ws,actual_case_id))
                if action=='remove':
                    if head['state']=='active':self._bump(con,ws,head['experiment_id'],state='deleted',deleted_at_ms=now,lifecycle_revision=head['lifecycle_revision']+1,status='cancelled',watch_mode=0,watch_enabled_at_ms=None)
                    counts=self._derived_counts(con,ws,head['experiment_id']);result={'removed':True,'experiment_id':head['experiment_id'],'deleted_evaluations':counts['evaluations'],'deleted_skill_issues':counts['skill_issues']}
                else:
                    remaining=con.execute("SELECT COUNT(*) FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND state='active'",(ws,head['experiment_id'])).fetchone()[0]
                    empty_parent=action=='case_remove' and remaining==0 and head['scope'] not in {'skill-workbench','skill-case-analysis','grayscale-ab'}
                    if empty_parent:self._bump(con,ws,head['experiment_id'],state='deleted',deleted_at_ms=now,lifecycle_revision=head['lifecycle_revision']+1,status='cancelled',watch_mode=0,watch_enabled_at_ms=None)
                    elif action=='case_remove' and remaining==0 and not self._planned_cases_remaining(con,ws,head):self._bump(con,ws,head['experiment_id'],status='cancelled')
                    else:self._settle(con,ws,head['experiment_id'])
                    result=self._snapshot(con,ws,self._head(con,token,ws,head['experiment_id'],deleted=empty_parent));result['removed']=empty_parent;result['case_removed']=action=='case_remove'
                    if empty_parent:
                        counts=self._derived_counts(con,ws,head['experiment_id']);result.update(deleted_evaluations=counts['evaluations'],deleted_skill_issues=counts['skill_issues'])
                result['cancellation_id']=cancellation['id'];result['cancellation']=cancellation
            else:
                self._settle(con,ws,body['experiment_id']);result=self._snapshot(con,ws,self._head(con,token,ws,body['experiment_id']))
            if action not in ephemeral:
                exp=result['experiment']['id'] if action in {'create','ensure'} else body['experiment_id'];response_hash,response_ref=self._put(result,MAX_BYTES)
                con.execute('INSERT INTO experiment_operation_receipts VALUES(?,?,?,?,?,?,?,?,?)',(ws,scope.principal_id,action,key,digest,exp,response_hash,response_ref,self.control.clock()))
        return self._response(token,ws,action,body.get('experiment_id') or result.get('experiment',{}).get('id'),result)

    def _redact(self,result,principal):
        value=copy.deepcopy(result)
        if isinstance(value,list):return [self._redact(v,principal) for v in value]
        if not isinstance(value,dict) or 'experiment' not in value:return value
        owner=value.pop('_owner_principal_id',None)
        if owner==principal:return value
        value['sessions']=[{**{k:v for k,v in row.items() if k not in {'interactions','langfuseTraceNodes'}},'interactions':None,'langfuseTraceNodes':None} for row in value.get('sessions',[])]
        value['gold_redacted']=True;data=value['experiment']
        public_head={'id','name','type','scope','skillName','skillVersion','agentName','preset','status','watchMode','watchEnabledAt','user','createdAt','updatedAt','deletedAt','sourceExperimentId','optimizationRecordId','evaluatorIdsJson','groups','cases','comments','cancellations','traceAttempts'}
        for key in list(data):
            if key not in public_head:data.pop(key)
        for key in ('evaluatorConfigsJson','configSnapshotJson','skillContextJson'):data[key]='{}'
        for case in data.get('cases',[]):
            public_case={'id','experimentId','input','actualOutput','datasetInput','taskId','executionId','groupId','faultInjectionType','fiTaskId','fiRunId','traceGenerationCommandId','traceGenerationError','createdAt','deletedAt','results','traceAttempts','executionSnapshot'}
            for key in list(case):
                if key not in public_case:case.pop(key)
            for key in ('referenceOutput','caseValuesJson','evaluatorContextJson'):case[key]=None
            for result in case.get('results',[]):
                public_result={'id','experimentId','caseId','evaluatorId','status','verdict','score','humanScore','humanBy','humanAt','attempts','durationMs','createdAt','updatedAt'}
                for key in list(result):
                    if key not in public_result:result.pop(key)
                for key in ('pointsJson','evidenceJson','points','evidence','summary','humanReason'):result[key]=None
            snapshot=case.get('executionSnapshot')
            if snapshot:snapshot['results']=copy.deepcopy(case.get('results',[]))
        return value

    def _recording_scope_tx(self,con,token,workspace_id,handle,public_execution=False):
        head,cp,_,_=self._active(con,token,workspace_id,handle)
        phase=self._load(cp['payload_hash'],cp['payload_ref'])['phase']
        if public_execution:
            _,plan=self._plan(con,workspace_id,head['experiment_id'],cp['run_id'])
            if phase!='execute' or plan['config'].get('execution_request',{}).get('kind')!='local':raise Forbidden('Business Agent recording requires a local execution attempt')
        elif phase!='evaluate':raise Forbidden('Judge recording requires a scoring attempt')
        return head,cp

    def authorize_recording(self,token,workspace_id,handle,public_execution=False):
        with self.control.read_transaction() as con:
            head,cp=self._recording_scope_tx(con,token,workspace_id,handle,public_execution)
            return {'owner_principal_id':cp['actor_principal_id'],'experiment_id':head['experiment_id'],'run_id':cp['run_id'],'attempt_id':cp['attempt_id'],'fence':str(cp['fence'])}

    def register_judge_trace_tx(self,con,token,workspace_id,handle,trace_id):
        head,cp=self._recording_scope_tx(con,token,workspace_id,handle)
        owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace_id,trace_id)).fetchone()
        route=con.execute("SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(workspace_id,trace_id)).fetchone()
        if owner is None or owner[0]!=cp['actor_principal_id'] or route is None:raise Forbidden('Judge Trace must be an active Trace owned by the scoring actor')
        expected=(head['experiment_id'],cp['run_id'],cp['attempt_id'],cp['actor_principal_id'])
        old=con.execute('SELECT * FROM experiment_judge_traces WHERE workspace_id=? AND trace_id=?',(workspace_id,trace_id)).fetchone()
        if old:
            if tuple(old[k] for k in ('experiment_id','run_id','attempt_id','owner_principal_id'))!=expected:raise Conflict('Judge Trace already belongs to another attempt')
            return
        con.execute('INSERT INTO experiment_judge_traces VALUES(?,?,?,?,?,?,?)',(workspace_id,trace_id,*expected,self.control.clock()))

    def _project_gate(self,con,event,worker,payload,lease_ms):
        row=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=?',(event['workspace_id'],event['event_id'])).fetchone()
        now=self.control.clock()
        if row is None or row['state']!='dispatching' or row['attempts']!=event['attempts'] or row['lease_owner']!=worker or row['lease_until_ms']<=now:raise Conflict('Result projection lease was lost')
        head=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(event['workspace_id'],payload['experiment_id'])).fetchone()
        if head is None or head['state']!='active' or head['lifecycle_revision']!=payload['lifecycle_revision']:raise ExperimentNotFound('Experiment projection lifecycle changed')
        case=con.execute('SELECT * FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND case_id=?',(event['workspace_id'],payload['experiment_id'],payload['case_key'])).fetchone()
        if case is None or case['state']!='active' or case['lifecycle_revision']!=payload.get('case_lifecycle_revision',case['lifecycle_revision']) or case['trace_id']!=payload.get('source_trace_id'):raise ExperimentNotFound('Case projection lifecycle or Trace binding changed')
        receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(event['workspace_id'],payload['result_id'])).fetchone()
        if receipt is None or receipt['content_hash']!=payload['content_hash'] or receipt['run_id']!=payload['run_id'] or receipt['attempt_id']!=payload['attempt_id']:raise StorageError('Result projection provenance differs')
        if receipt['state']=='quarantined':raise ExperimentArtifactError('Result projection receipt is quarantined')
        authorization=payload.get('authorization')
        if not isinstance(authorization,dict):raise Forbidden('Result delivery requires current authenticated provenance')
        scope=self.iam._scope_registered_credential(con,authorization.get('credential_id',''),authorization.get('kind'))
        if scope.principal_id!=authorization.get('principal_id'):raise Forbidden('Result delivery principal changed')
        self.iam._authorize_scope(con,scope,event['workspace_id'],'read','run',payload['experiment_id'])
        self.iam._authorize_scope(con,scope,event['workspace_id'],'write','run',payload['experiment_id'])
        self._source_assets(con,scope,event['workspace_id'],payload['experiment_id'],payload['run_id'],require_origin=True)
        _,plan=self._plan(con,event['workspace_id'],payload['experiment_id'],payload['run_id'])
        for manifest in self._source_routes(plan,payload['case_key']):self._source_route(con,scope,event['workspace_id'],manifest)
        if head['scope']=='benchmark':
            from .benchmark_core import BenchmarkStore
            benchmark=BenchmarkStore(self.control)
            benchmark._source_acl(con,scope,event['workspace_id'],head['experiment_id'],payload['run_id'])
            if payload.get('benchmark_job_id'):
                job=benchmark._job_scope(con,scope,event['workspace_id'],payload['benchmark_job_id'])
                if any(job[key]!=expected for key,expected in [('experiment_id',head['experiment_id']),('run_id',payload['run_id']),('case_id',payload['case_key']),('callback_attempt_id',receipt['attempt_id'])]):raise Conflict('Benchmark projection job provenance differs')
            if payload.get('benchmark_failure_job_id'):
                if payload.get('benchmark_job_id'):raise Conflict('Benchmark projection origins are exclusive')
                job,source=benchmark._failure_source(con,scope,event['workspace_id'],payload['benchmark_failure_job_id'],payload.get('benchmark_failure_source_hash'))
                if any(job[key]!=expected for key,expected in [('experiment_id',head['experiment_id']),('run_id',payload['run_id']),('case_id',payload['case_key'])]):raise Conflict('Benchmark failure job provenance differs')
                _,binding=benchmark._binding(con,event['workspace_id'],head['experiment_id']);evaluator=binding['adapter']['evaluatorId']
                work=con.execute('SELECT * FROM work_items WHERE workspace_id=? AND work_item_id=?',(event['workspace_id'],receipt['work_item_id'])).fetchone()
                attempt=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND attempt_id=?',(event['workspace_id'],receipt['attempt_id'])).fetchone()
                cp=con.execute('SELECT * FROM experiment_attempt_checkpoints WHERE workspace_id=? AND attempt_id=?',(event['workspace_id'],receipt['attempt_id'])).fetchone()
                if work is None or attempt is None or cp is None:raise Conflict('Benchmark classifier checkpoint unavailable')
                if receipt['evaluator_slot']!=evaluator or work['phase']!='publish' or any(work[key]!=expected for key,expected in [('run_id',payload['run_id']),('case_key',payload['case_key']),('evaluator_slot',evaluator)]):raise Conflict('Benchmark classifier work membership differs')
                count=con.execute('SELECT COUNT(*) FROM work_items WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(event['workspace_id'],payload['run_id'],payload['case_key'],evaluator)).fetchone()[0]
                if count!=1 or sum(member.get('case_key')==payload['case_key'] and member.get('evaluator_slot')==evaluator for member in plan.get('work_members',[]))!=1:raise Conflict('Benchmark classifier primary work is not unique')
                if attempt['work_item_id']!=work['work_item_id'] or attempt['worker_id']!='benchmark-failure-classifier' or attempt['status']!='failed' or attempt['error_code']!=source['failureCode']:raise Conflict('Benchmark classifier attempt differs')
                expected={'experiment_id':head['experiment_id'],'run_id':payload['run_id'],'case_id':payload['case_key'],'work_item_id':work['work_item_id'],'fence':attempt['fence'],'lease_owner':attempt['worker_id'],'actor_principal_id':scope.principal_id,'stage':'terminal'}
                if any(cp[key]!=value for key,value in expected.items()):raise Conflict('Benchmark classifier provenance differs')
                value=self._load(cp['payload_hash'],cp['payload_ref'])
                if value.get('phase')!='benchmark:classification' or value.get('checkpoint')!={'job_id':job['job_id'],'failure_source_hash':payload['benchmark_failure_source_hash']}:raise Conflict('Benchmark classifier source checkpoint differs')
        con.execute('UPDATE outbox_events SET lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?',(now+lease_ms,now,event['workspace_id'],event['event_id']))
        return dict(receipt)

    @staticmethod
    def _projection_checkpoint(ws,event_id,payload):
        return _hash({'workspace_id':ws,'event_id':event_id,**{key:payload.get(key) for key in ('experiment_id','run_id','result_id','content_hash','case_key','evaluator_slot','selection_revision','review_id','review_hash','review_ref')}})

    def project_once(self,facts,worker_id,lease_ms=30000):
        identifier(worker_id);self._lease({'lease_ms':lease_ms});now=self.control.clock()
        with self.control.transaction() as con:
            row=con.execute("SELECT * FROM outbox_events WHERE event_type='evaluation.result.accepted.v1' AND (EXISTS(SELECT 1 FROM experiment_attempt_checkpoints c WHERE c.workspace_id=outbox_events.workspace_id AND c.attempt_id=outbox_events.aggregate_id) OR EXISTS(SELECT 1 FROM experiment_annotations a WHERE a.workspace_id=outbox_events.workspace_id AND a.annotation_id=outbox_events.aggregate_id AND a.kind='review')) AND ((state='pending' AND next_attempt_at_ms<=?) OR (state='dispatching' AND lease_until_ms<=?)) ORDER BY created_at_ms,event_id LIMIT 1",(now,now)).fetchone()
            if row is None:return False
            event=dict(row);payload=json.loads(event['payload_json'])
            if 'experiment_id' not in payload:raise ExperimentUnavailable('Legacy result event requires an explicit materializer')
            event['attempts']+=1;con.execute("UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(event['attempts'],worker_id,now+lease_ms,now,event['workspace_id'],event['event_id']))
        ws=event['workspace_id']
        try:
            with self.control.transaction() as con:
                receipt=self._project_gate(con,event,worker_id,payload,lease_ms);run,plan=self._plan(con,ws,payload['experiment_id'],payload['run_id'])
            packet=self._load(receipt['content_hash'],receipt['artifact_ref']);result=packet['result'];evaluator=payload['evaluator_slot'];evidence=plan['frozen_trace_evidence'].get(payload['case_key']);case=next(v for v in plan['cases'] if v['id']==payload['case_key'])
            frozen_release=plan['releases'].get('evaluator:'+evaluator,'plan-local:'+run['plan_hash']+':'+evaluator)
            verdict=result.get('verdict') or ('error' if result.get('status')=='failed' else 'inconclusive')
            if verdict not in {'pass','warn','fail','inconclusive','not_applicable','error'}:raise ValueError('Unsupported machine verdict')
            rows={'eval_result_facts':[{'workspace_id':ws,'result_bucket':payload['result_bucket'],'result_id':payload['result_id'],'run_id':payload['run_id'],'case_key':payload['case_key'],'attempt_id':payload['attempt_id'],'evaluator_release_id':frozen_release,'input_snapshot_id':evidence['snapshot_hash'] if evidence else 'case:'+_hash(case),'verdict':verdict,'summary':(result.get('summary') or '')[:200],'evidence_ref':'experiment.machine:'+receipt['content_hash'],'content_hash':receipt['content_hash'],'created_at_ms':receipt['created_at_ms'],'schema_version':1,'retry_version':1}]}
            metrics=[]
            values=[{'key':'score','value':result.get('score') if result.get('status')=='done' else None,'unit':'points'}]+result.get('metrics',[])
            if payload.get('review_id'):
                review=self._load(payload['review_hash'],payload['review_ref'])
                values.append({'key':'human_score','value':review['humanScore'],'dimension_key':payload['review_id'],'unit':'points'})
            if len(values)>1000:raise ExperimentTooLarge('Machine metrics exceed budget')
            seen=set()
            for metric in values:
                key=identifier(metric['key']);dimension=metric.get('dimension_key','');identity=(key,dimension)
                if identity in seen:raise ValueError('Duplicate machine metric identity')
                seen.add(identity);value=metric.get('value');kind='missing' if value is None else 'boolean' if type(value) is bool else 'integer' if type(value) is int else 'float' if type(value) is float else 'category'
                row={'workspace_id':ws,'result_bucket':payload['result_bucket'],'result_id':payload['result_id'],'metric_definition_release_id':metric.get('definition_release_id','builtin:'+key+'/v1'),'metric_key':key,'dimension_key':dimension,'value_type':kind,'value_int':int(value) if kind in {'integer','boolean'} else None,'value_float':value if kind=='float' else None,'value_decimal':'','value_text':value if kind=='category' else '','unit':metric.get('unit',''),'method':metric.get('method',''),'evidence_ref':'','retry_version':1}
                row['content_hash']=_hash(row);metrics.append(row)
            rows['eval_metric_facts']=metrics
            rows['eval_result_selection_current']=[{'workspace_id':ws,'run_bucket':_iso(run['created_at_ms'])[:10],'run_id':payload['run_id'],'case_key':payload['case_key'],'evaluator_slot':evaluator,'result_id':payload['result_id'],'selection_revision':payload['selection_revision'],'review_decision_id':payload.get('review_id',''),'is_deleted':0}]
            def insert(table,batch):
                for offset in range(0,len(batch),128):
                    page=batch[offset:offset+128]
                    with self.control.transaction() as con:self._project_gate(con,event,worker_id,payload,lease_ms)
                    facts._insert(table,page)
                    if offset+128>=len(batch) and hasattr(facts,'_request') and table in {'eval_result_facts','eval_metric_facts'}:
                        # Verify the immutable result body, rather than treating an HTTP response as a row-count receipt.
                        if table=='eval_result_facts':
                            actual=[json.loads(line) for line in facts._request('SELECT content_hash FROM eval_result_facts FINAL WHERE workspace_id={w:String} AND result_bucket={b:Date} AND result_id={r:String} FORMAT JSONEachRow',parameters={'w':ws,'b':payload['result_bucket'],'r':payload['result_id']}).splitlines() if line]
                            if actual!=[{'content_hash':receipt['content_hash']}]:raise StorageError('Result fact readback differs')
                        else:
                            actual=[json.loads(line) for line in facts._request('SELECT metric_key,dimension_key,content_hash FROM eval_metric_facts FINAL WHERE workspace_id={w:String} AND result_bucket={b:Date} AND result_id={r:String} FORMAT JSONEachRow',parameters={'w':ws,'b':payload['result_bucket'],'r':payload['result_id']}).splitlines() if line]
                            expected={(v['metric_key'],v['dimension_key'],v['content_hash']) for v in metrics}
                            if not expected<={(v['metric_key'],v['dimension_key'],v['content_hash']) for v in actual}:raise StorageError('Metric fact readback differs')
                    with self.control.transaction() as con:self._project_gate(con,event,worker_id,payload,lease_ms)
            if payload.get('_projection_indexed')==self._projection_checkpoint(ws,event['event_id'],payload) or receipt['state'] in {'indexed','published'} and not payload.get('review_id'):rows={}
            for table,batch in rows.items():insert(table,batch)
            with self.control.transaction() as con:
                self._project_gate(con,event,worker_id,payload,lease_ms)
                con.execute("UPDATE result_receipts SET state='indexed' WHERE workspace_id=? AND result_id=? AND state='accepted'",(ws,payload['result_id']))
                payload['_projection_indexed']=self._projection_checkpoint(ws,event['event_id'],payload)
                con.execute('UPDATE outbox_events SET payload_json=? WHERE workspace_id=? AND event_id=?',(_json(payload),ws,event['event_id']))
                work=con.execute('SELECT * FROM work_items WHERE workspace_id=? AND run_id=? ORDER BY case_key,evaluator_slot',(ws,payload['run_id'])).fetchall();members=[]
                scoring=[item for item in work if item['evaluator_slot']!=EXECUTION_SLOT]
                complete=bool(scoring) and all(w['status'] in {'done','failed'} for w in work)
                if complete:
                    for ordinal,item in enumerate(scoring):
                        selected=con.execute('SELECT s.result_id,r.content_hash,r.state FROM result_selections s JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.result_id WHERE s.workspace_id=? AND s.run_id=? AND s.case_key=? AND s.evaluator_slot=?',(ws,payload['run_id'],item['case_key'],item['evaluator_slot'])).fetchone()
                        if selected is None or selected['state'] not in {'indexed','published'}:complete=False;break
                        review_slot=con.execute('SELECT review_id FROM experiment_result_slots WHERE workspace_id=? AND run_id=? AND case_id=? AND evaluator_id=? AND selected_result_id=?',(ws,payload['run_id'],item['case_key'],item['evaluator_slot'],selected['result_id'])).fetchone()
                        review_id=review_slot[0] if review_slot and review_slot[0] else ''
                        if review_id and review_id!=payload.get('review_id'):
                            review_event=con.execute("SELECT event_id,state,payload_json FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type='evaluation.result.accepted.v1'",(ws,review_id)).fetchone()
                            ready=False
                            if review_event and review_event['state']!='dead':
                                review_payload=json.loads(review_event['payload_json'])
                                annotation=con.execute("SELECT payload_hash,payload_ref FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='review' AND machine_result_id=?",(ws,review_id,selected['result_id'])).fetchone()
                                bound=annotation is not None and all(review_payload.get(key)==value for key,value in [('run_id',payload['run_id']),('case_key',item['case_key']),('evaluator_slot',item['evaluator_slot']),('result_id',selected['result_id']),('review_id',review_id),('review_hash',annotation['payload_hash']),('review_ref',annotation['payload_ref'])])
                                ready=bound and (review_event['state']=='sent' or review_payload.get('_projection_indexed')==self._projection_checkpoint(ws,review_event['event_id'],review_payload))
                            if not ready:complete=False;break
                        members.append({'review_decision_id':review_id,'workspace_id':ws,'publication_bucket':_iso(run['created_at_ms'])[:10],'publication_id':payload['run_id'],'ordinal':ordinal,'run_id':payload['run_id'],'case_key':item['case_key'],'evaluator_slot':item['evaluator_slot'],'result_id':selected['result_id'],'content_hash':selected['content_hash'],'retry_version':1})
            if complete:
                publication=_hash({'run_id':payload['run_id'],'members':[(v['case_key'],v['evaluator_slot'],v['result_id'],v['review_decision_id']) for v in members]})
                for member in members:member['publication_id']=publication
                insert('eval_publication_members',members)
            with self.control.transaction() as con:
                self._project_gate(con,event,worker_id,payload,lease_ms)
                if complete:
                    for member in members:con.execute("UPDATE result_receipts SET state='published' WHERE workspace_id=? AND result_id=? AND state='indexed'",(ws,member['result_id']))
                if complete:
                    con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(self.control.clock(),ws,event['event_id']))
                else:
                    now=self.control.clock();con.execute("UPDATE outbox_events SET state='pending',next_attempt_at_ms=?,lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(now+min(60000,1000*2**min(event['attempts'],6)),now,ws,event['event_id']))
        except Exception as exc:
            with self.control.transaction() as con:
                current=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=?',(ws,event['event_id'])).fetchone()
                if current and current['state']=='dispatching' and current['attempts']==event['attempts'] and current['lease_owner']==worker_id:
                    permanent=isinstance(exc,(ExperimentNotFound,ValueError,ExperimentTooLarge,ExperimentArtifactError))
                    if isinstance(exc,(ValueError,ExperimentTooLarge,ExperimentArtifactError)):
                        con.execute("UPDATE result_receipts SET state='quarantined' WHERE workspace_id=? AND result_id=?",(ws,payload['result_id']))
                    con.execute('UPDATE outbox_events SET state=?,next_attempt_at_ms=?,lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?',('dead' if permanent else 'pending',self.control.clock()+min(60000,1000*2**min(event['attempts'],6)),self.control.clock(),ws,event['event_id']))
        return True

    def _flow_lookup(self,token,ws,body):
        from .trace_metadata import TraceMetadata
        reference=identifier(body.get('trace_ref'))
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
            aliases=con.execute("SELECT DISTINCT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=? AND alias_kind IN ('task','execution')",(ws,reference)).fetchall()
            if len(aliases)>1:raise Conflict('Flow source alias is ambiguous')
            trace=aliases[0][0] if aliases else reference
            TraceMetadata(self.control)._trace(con,token,ws,trace)
            where="e.workspace_id=? AND e.created_by=? AND e.scope='trace-flow-analysis' AND e.state='active' AND c.state='active' AND c.trace_id=? AND s.evaluator_id='__trace_flow_match__' AND s.status='done'";params=[ws,scope.principal_id,trace]
            if body.get('experiment_id'):where+=' AND e.experiment_id=?';params.append(identifier(body['experiment_id']))
            row=con.execute("SELECT e.experiment_id,s.result_id AS slot_id,r.result_id AS machine_id FROM experiment_heads e JOIN experiment_cases c ON c.workspace_id=e.workspace_id AND c.experiment_id=e.experiment_id JOIN experiment_result_slots s ON s.workspace_id=c.workspace_id AND s.case_id=c.case_id JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.selected_result_id WHERE "+where+' ORDER BY r.created_at_ms DESC,e.experiment_id DESC LIMIT 1',tuple(params)).fetchone()
            values={'match':None,'attribution':None};checked=[]
            if row:
                head=self._head(con,token,ws,row['experiment_id'])
                metadata=self._load(head['metadata_hash'],head['metadata_ref']);manifest=json.loads(metadata.get('configSnapshotJson') or '{}').get('coreFlowAnalysis')
                if not isinstance(manifest,dict) or manifest.get('trace_id')!=trace or type(manifest.get('version')) is not int or manifest['version']!=1:raise Conflict('Flow source manifest differs')
                def selected(slot_id,key):
                    slot=self._slot(con,ws,head['experiment_id'],slot_id)
                    receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,slot['selected_result_id'])).fetchone()
                    if receipt is None or receipt['state']=='quarantined':raise ExperimentUnavailable('Flow selected machine is unavailable')
                    self._source_assets(con,scope,ws,head['experiment_id'],receipt['run_id']);_,plan=self._plan(con,ws,head['experiment_id'],receipt['run_id'])
                    if _json(plan.get('config',{}).get('core_flow_analysis'))!=_json(manifest):raise Conflict('Flow RunPlan manifest differs')
                    routes=self._source_routes(plan,slot['case_id'])
                    if not routes:raise Conflict('Flow result has no real Trace source')
                    for route in routes:self._source_route(con,scope,ws,route)
                    packet=self._load(receipt['content_hash'],receipt['artifact_ref']);value=packet.get('result',{}).get('evidence',{}).get('json',{}).get(key)
                    if not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1:raise ExperimentUnavailable('Flow result DTO is unavailable')
                    result={'experiment_id':head['experiment_id'],'case_id':slot['case_id'],'result_slot_id':slot['result_id'],'machine_result_id':receipt['result_id'],'content_hash':receipt['content_hash'],'run_id':receipt['run_id'],'created_at':_iso(receipt['created_at_ms']),'manifest':manifest,'value':value}
                    checked.append((head['experiment_id'],head['metadata_hash'],head['lifecycle_revision'],slot['result_id'],receipt['result_id'],receipt['content_hash'],receipt['run_id'],routes))
                    return result
                values['match']=selected(row['slot_id'],'coreFlowMatch')
                if values['match']['value'].get('mode')!=manifest.get('mode'):raise Conflict('Flow result mode differs')
                attribution=con.execute("SELECT result_id FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND case_id=? AND evaluator_id='__trace_flow_attribution__' AND status='done' AND selected_result_id IS NOT NULL",(ws,head['experiment_id'],values['match']['case_id'])).fetchone()
                if attribution:
                    derived=selected(attribution[0],'coreAlignmentAttribution');expected={key:values['match'][key] for key in ('machine_result_id','content_hash','run_id')}
                    if _json(derived['value'].get('match_source'))==_json(expected):values['attribution']=derived
            if len(_json(values).encode())>MAX_BYTES:raise ExperimentTooLarge('Flow response exceeds budget')
            fingerprint=scope.fingerprint
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,ws,'read');TraceMetadata(self.control)._trace(con,token,ws,trace)
            if current.fingerprint!=fingerprint:raise Forbidden('Flow authorization changed during read')
            for exp,metadata_hash,lifecycle,slot_id,machine,digest,run,routes in checked:
                head=self._head(con,token,ws,exp);slot=self._slot(con,ws,exp,slot_id)
                receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,machine)).fetchone()
                if head['created_by']!=current.principal_id or head['state']!='active' or head['scope']!='trace-flow-analysis' or head['metadata_hash']!=metadata_hash or head['lifecycle_revision']!=lifecycle or slot['selected_result_id']!=machine or slot['status']!='done' or receipt is None or receipt['state']=='quarantined' or receipt['content_hash']!=digest:raise Conflict('Flow selection changed during read')
                self._case(con,ws,exp,slot['case_id']);self._source_assets(con,current,ws,exp,run)
                for route in routes:self._source_route(con,current,ws,route)
        return values

    def _response(self,token,ws,action,exp,result):
        capability='delete' if action in {'remove','case_remove','comment_remove'} else 'write'
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
            if exp:
                self._head(con,token,ws,exp,capability,deleted=action in {'remove','case_remove','cancellation_update'});self._head(con,token,ws,exp,'read',deleted=action in {'remove','case_remove','cancellation_update'})
                if isinstance(result,dict) and result.get('coverage') in {'complete','subset'}:self._guard_sources(con,token,ws,exp)
            return self._redact(result,scope.principal_id)

    def _list_view(self,token,ws,body):
        def hide_scores(value):
            value['source_available']=False
            for case in value['experiment']['cases']:
                case.update(fiRunId=None,executionId=None,taskId=None,traceGenerationError=None)
                for result in case['results']:result.update(score=None,humanScore=None,errorMessage=None)
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);grant=self.iam._workspace(scope,ws,'read')
            where="e.workspace_id=? AND e.state='active' AND e.scope<>'trace-flow-analysis'";params=[ws]
            if body.get('experiment_id'):where+=' AND e.experiment_id=?';params.append(identifier(body['experiment_id']))
            if body.get('task_id'):
                task=identifier(body['task_id']);alias=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='task' AND alias_id=?",(ws,task)).fetchone()
                where+=" AND EXISTS(SELECT 1 FROM experiment_cases c WHERE c.workspace_id=e.workspace_id AND c.experiment_id=e.experiment_id AND c.state='active' AND c.trace_id=?)";params.append(alias[0] if alias else task)
            if grant.role not in {'owner','admin','personal'}:
                where+=" AND (r.owner_principal_id=? OR r.visibility='group' OR EXISTS(SELECT 1 FROM iam_resource_grants g WHERE g.workspace_id=r.workspace_id AND g.resource_kind=r.resource_kind AND g.resource_id=r.resource_id AND g.grantee_principal_id=?))";params.extend([scope.principal_id,scope.principal_id])
            params.append(MAX_ITEMS+1)
            heads=con.execute("SELECT e.* FROM experiment_heads e JOIN iam_resource_access r ON r.workspace_id=e.workspace_id AND r.resource_kind='run' AND r.resource_id=e.experiment_id WHERE "+where+' ORDER BY e.experiment_id LIMIT ?',tuple(params)).fetchall()
            if len(heads)>MAX_ITEMS:raise ExperimentTooLarge('Experiment list count exceeds budget')
            values=[];size=0
            for raw in heads:
                head=dict(raw);exp=head['experiment_id'];self._head(con,token,ws,exp)
                source_available=True
                try:self._guard_sources(con,token,ws,exp)
                except (Forbidden,Conflict):source_available=False
                metadata=self._load(head['metadata_hash'],head['metadata_ref'])
                try:config=json.loads(metadata.get('configSnapshotJson') or '{}')
                except (ValueError,TypeError):config={}
                imported=isinstance(config,dict) and config.get('submissionSource')=='imported' and head['created_by']==scope.principal_id
                data={'id':exp,'name':head['name'],'type':head['type'],'scope':head['scope'],'skillName':head['skill_name'],'skillVersion':metadata.get('skillVersion'),'preset':metadata.get('preset'),'agentName':head['agent_name'],'status':head['status'],'watchMode':bool(head['watch_mode']),'user':self._owner(con,head['created_by']),'createdAt':_iso(head['created_at_ms']),'updatedAt':_iso(head['updated_at_ms']),'deletedAt':None,'evaluatorIdsJson':metadata.get('evaluatorIdsJson','[]'),'configSnapshotJson':_json({'submissionSource':'imported' if imported else 'agent'}),'cases':[]}
                cases=con.execute("SELECT * FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND state='active' ORDER BY ordinal,case_id LIMIT ?",(ws,exp,MAX_CASES+1)).fetchall()
                if len(cases)>MAX_CASES:raise ExperimentTooLarge('Experiment list Case count exceeds budget')
                for case in cases:
                    item={'id':case['case_id'],'experimentId':exp,'deletedAt':None,'createdAt':_iso(case['created_at_ms']),'fiRunId':None,'executionId':None,'taskId':None,'traceGenerationError':None,'results':[]}
                    if source_available:
                        payload=self._load(case['payload_hash'],case['payload_ref'])
                        for key in ('fiRunId','executionId','taskId','traceGenerationError'):item[key]=payload.get(key)
                    slots=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? ORDER BY created_at_ms,result_id',(ws,case['case_id'])).fetchall()
                    for slot in slots:
                        if slot['evaluator_id']==EXECUTION_SLOT:continue
                        result={'id':slot['result_id'],'experimentId':exp,'caseId':case['case_id'],'evaluatorId':slot['evaluator_id'],'status':slot['status'],'score':None,'humanScore':None,'errorMessage':None,'updatedAt':_iso(slot['updated_at_ms'])}
                        if slot['selected_result_id']:
                            receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,slot['selected_result_id'])).fetchone()
                            if receipt is None:raise StorageError('Selected list machine receipt unavailable')
                            if receipt['state']=='quarantined':result.update(status='failed',errorMessage='机器结果暂不可用' if source_available else None)
                            elif source_available:
                                packet=self._load(receipt['content_hash'],receipt['artifact_ref']);result['score']=packet['result'].get('score');result['errorMessage']=packet['result'].get('errorMessage')
                                if slot['review_id']:
                                    review=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='review' AND machine_result_id=?",(ws,slot['review_id'],slot['selected_result_id'])).fetchone()
                                    if review:result['humanScore']=self._load(review['payload_hash'],review['payload_ref']).get('humanScore')
                        item['results'].append(result)
                    data['cases'].append(item)
                value={'coverage':'complete','projection':'experiment-list/v1','source_available':source_available,'experiment':data};size+=len(_json(value).encode())+1
                if size+2>MAX_BYTES:raise ExperimentTooLarge('Experiment list response exceeds budget')
                values.append(value)
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,ws,'read');checked=[]
            for value in values:
                exp=value['experiment']['id']
                try:self._head(con,token,ws,exp)
                except (Forbidden,ExperimentNotFound):continue
                try:self._guard_sources(con,token,ws,exp)
                except (Forbidden,Conflict):hide_scores(value)
                checked.append(value)
        return {'coverage':'complete','projection':'experiment-list/v1','snapshots':checked}

    def _baseline_view(self,token,ws,identity):
        with self.control.read_transaction() as con:
            current=self._head(con,token,ws,identity);self._guard_sources(con,token,ws,identity)
            scope=self.iam._scope(con,token);fingerprint=scope.fingerprint
            rows=con.execute("SELECT * FROM experiment_heads WHERE workspace_id=? AND state='active' AND created_by=? AND type='single' AND scope=? AND status IN ('done','partial') AND watch_mode=0 AND created_at_ms<=? AND experiment_id<>? ORDER BY created_at_ms DESC,experiment_id DESC LIMIT 200",(ws,current['created_by'],current['scope'],current['created_at_ms'],identity)).fetchall()
            snapshots=[];size=0
            for head in [current]+[dict(row) for row in rows]:
                try:
                    self._head(con,token,ws,head['experiment_id']);self._guard_sources(con,token,ws,head['experiment_id'])
                except (Forbidden,Conflict,ExperimentNotFound):
                    if head['experiment_id']==identity:raise
                    continue
                value=self._snapshot(con,ws,head,include_evidence=False)
                case_keys={'id','experimentId','input','datasetInput','referenceOutput','evaluatorContextJson','caseValuesJson','faultInjectionType','results'}
                result_keys={'experimentId','caseId','evaluatorId','status','score','humanScore'}
                for case in value['experiment']['cases']:
                    case['results']=[{k:v for k,v in result.items() if k in result_keys} for result in case['results']]
                    for key in list(case):
                        if key not in case_keys:case.pop(key)
                value['experiment']['traceAttempts']=[];value=self._redact(value,scope.principal_id);size+=len(_json(value).encode())+1
                if size+2>MAX_BYTES:raise ExperimentTooLarge('Experiment baseline view exceeds budget')
                snapshots.append(value)
        with self.control.read_transaction() as con:
            current_scope=self.iam._scope(con,token)
            if current_scope.fingerprint!=fingerprint:raise Forbidden('Experiment baseline authorization changed during read')
            checked=[]
            for value in snapshots:
                exp=value['experiment']['id']
                try:self._head(con,token,ws,exp);self._guard_sources(con,token,ws,exp)
                except (Forbidden,Conflict,ExperimentNotFound):
                    if exp==identity:raise
                    continue
                checked.append(value)
        return {'snapshots':checked,'coverage':'complete'}

    def _cancellations_tx(self,con,ws,exp,annotations):
        rows={event['annotation_id']:self._load(event['payload_hash'],event['payload_ref']) for event in annotations if event['kind']=='cancellation'}
        updates=[(event['subject_id'],self._load(event['payload_hash'],event['payload_ref'])) for event in annotations if event['kind']=='cancellation_update']
        for identity,update in sorted(updates,key=lambda pair:int(pair[1]['revision'])):
            if identity in rows:rows[identity].update(update)
        return list(rows.values())

    @staticmethod
    def _dataset_case_key(value):
        try:
            values=json.loads(value.get('caseValuesJson') or '{}');binding=values.get('__agentInsightDatasetCase') if isinstance(values,dict) else None
            if not isinstance(binding,dict) or not isinstance(binding.get('datasetId'),str) or not isinstance(binding.get('caseId'),str):return None
            identifier(binding['datasetId']);return 'dataset:'+identifier(binding['caseId'])
        except (ValueError,TypeError):return None

    def _planned_cases_remaining(self,con,ws,head):
        metadata=self._load(head['metadata_hash'],head['metadata_ref']);config=json.loads(metadata.get('configSnapshotJson') or '{}');planned=config.get('caseIds',[])
        if not isinstance(planned,list):return False
        if len(planned)>MAX_CASES:raise ExperimentTooLarge('Planned Dataset Cases exceed budget')
        rows=con.execute("SELECT payload_hash,payload_ref FROM experiment_annotations WHERE workspace_id=? AND experiment_id=? AND kind='cancellation' LIMIT ?",(ws,head['experiment_id'],MAX_ANNOTATIONS+1)).fetchall()
        if len(rows)>MAX_ANNOTATIONS:raise ExperimentTooLarge('Experiment cancellation history exceeds budget')
        removed={self._load(row['payload_hash'],row['payload_ref']).get('caseKey') for row in rows}
        return '' not in removed and any(isinstance(value,str) and 'dataset:'+value not in removed for value in planned)

    def _cancel_case_scope(self,con,ws,head,case_id):
        if case_id is None:return '',None
        identifier(case_id);exp=head['experiment_id'];skill_scope=head['scope'] in {'skill-workbench','skill-case-analysis','grayscale-ab'}
        actual=con.execute("SELECT * FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND case_id=? AND state='active'",(ws,exp,case_id)).fetchone()
        logical=self._dataset_case_key(self._load(actual['payload_hash'],actual['payload_ref'])) if actual and skill_scope else None
        if not logical and actual:return case_id,[case_id]
        if not logical:
            if not skill_scope or not case_id.startswith('dataset:'):raise ExperimentNotFound('Experiment Case not found')
            identifier(case_id[8:]);logical=case_id
        rows=con.execute("SELECT * FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND state='active' LIMIT ?",(ws,exp,MAX_CASES+1)).fetchall()
        if len(rows)>MAX_CASES:raise ExperimentTooLarge('Experiment Case scope exceeds budget')
        found=[row['case_id'] for row in rows if self._dataset_case_key(self._load(row['payload_hash'],row['payload_ref']))==logical]
        metadata=self._load(head['metadata_hash'],head['metadata_ref']);config=json.loads(metadata.get('configSnapshotJson') or '{}');planned=config.get('caseIds',[]) if isinstance(config,dict) else []
        if not found and (not isinstance(planned,list) or logical[8:] not in planned):raise ExperimentNotFound('Dataset Case is not part of the frozen Experiment')
        return logical,found

    def _append_cancel(self,con,ws,head,case_id,scope):
        now=self.control.clock();identity=_id();params=[ws,head['experiment_id']]
        case_key,case_ids=self._cancel_case_scope(con,ws,head,case_id)
        sql='SELECT c.*,a.attempt_no,a.status AS attempt_status FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.experiment_id=?'
        if case_id is not None:
            if case_ids:sql+=' AND c.case_id IN ('+','.join('?' for _ in case_ids)+')';params.extend(case_ids)
            else:sql+=' AND 1=0'
        sql+=' ORDER BY a.attempt_no DESC,c.revision DESC LIMIT ?';params.append(MAX_CASES*4+1)
        checkpoints=con.execute(sql,tuple(params)).fetchall()
        if len(checkpoints)>MAX_CASES*4:raise ExperimentTooLarge('External cancellation history exceeds budget')
        candidates=[];confirmed=set()
        for row in checkpoints:
            payload=self._load(row['payload_hash'],row['payload_ref']);checkpoint=payload['checkpoint'];command=checkpoint.get('command_id') or row['command_id']
            confirmed.update(checkpoint.get('_cleaned_commands',[]))
            if not command:continue
            if row['attempt_status']=='done' or checkpoint.get('cleanup_confirmed') is True:confirmed.add(command)
            request=payload.get('execution_request')
            if request is None:request=self._plan(con,ws,head['experiment_id'],row['run_id'])[1]['config'].get('execution_request',{})
            target=checkpoint.get('_command_target') or self._external_target(command,checkpoint,request,row['attempt_id'])
            candidates.append((command,target))
        seen=set();targets=[]
        for command,target in candidates:
            if command in confirmed or command in seen:continue
            seen.add(command);targets.append(target|{'confirmed':False})
        value={'revision':'1','id':identity,'user':self._owner(con,scope.principal_id),'experimentId':head['experiment_id'],'caseKey':case_key,'status':'pending' if targets else 'completed','targetsJson':_json(targets),'error':None,'createdAt':_iso(now),'updatedAt':_iso(now)}
        annotation_case=case_ids[0] if case_ids is not None and len(case_ids)==1 else None
        digest,ref=self._put(value);con.execute('INSERT INTO experiment_annotations(workspace_id,experiment_id,annotation_id,kind,case_id,result_id,machine_result_id,subject_id,actor_principal_id,payload_hash,payload_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(ws,head['experiment_id'],identity,'cancellation',annotation_case,None,None,head['current_run_id'],scope.principal_id,digest,ref,now))
        if targets:
            payload=canonical_json({'experiment_id':head['experiment_id'],'cancellation_id':identity,'payload_hash':digest,'payload_ref':ref,'lifecycle_revision':head['lifecycle_revision']})
            con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,1,'experiment.cancel.requested.v1',?,?,?)",(ws,_id(),identity,payload,now,now))
        return value

    @staticmethod
    def _queued_at(con,now):
        latest=con.execute('SELECT COALESCE(MAX(created_at_ms),0) FROM outbox_events').fetchone()[0]
        return max(now,latest+1)

    @staticmethod
    def _human_score(score):
        value=math.floor(score*10+0.5)/10
        return int(value) if value.is_integer() else value

    def _cancellation_route(self,token,ws,body):
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);mode=body.get('mode','cancel');exp=body.get('experiment_id')
            if body.get('cancellation_id'):
                if 'mode' in body:raise ValueError('Cancellation lookup has no mutation mode')
                row=con.execute("SELECT experiment_id FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='cancellation'",(ws,identifier(body['cancellation_id']))).fetchone()
                if row is None:raise ExperimentNotFound('Cancellation not found')
                if exp is not None and exp!=row['experiment_id']:raise Conflict('Cancellation experiment differs')
                exp=row['experiment_id'];mode='load'
            if mode not in {'cancel','remove','case_remove','load'}:raise ValueError('Unknown cancellation mode')
            head=con.execute('SELECT scope FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,identifier(exp))).fetchone()
            if head is None:raise ExperimentNotFound('Cancellation experiment not found')
            capability='delete' if head['scope']=='benchmark' or mode in {'remove','case_remove'} else 'read' if mode=='load' else 'write'
            self.iam._authorize_scope(con,scope,ws,capability,'run',exp);fingerprint=scope.fingerprint
            result={'kind':'benchmark' if head['scope']=='benchmark' else 'ordinary'}
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token)
            if current.fingerprint!=fingerprint:raise Forbidden('Cancellation authorization changed')
            self.iam._authorize_scope(con,current,ws,capability,'run',exp)
        return result

    def _cancellation(self,con,token,ws,identity):
        row=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='cancellation'",(ws,identity)).fetchone()
        if row is None:raise ExperimentNotFound('Cancellation not found')
        self._head(con,token,ws,row['experiment_id'],'read',deleted=True)
        records=self._cancellations_tx(con,ws,row['experiment_id'],self._annotations(con,ws,row['experiment_id']))
        record=next(v for v in records if v['id']==identity);record.setdefault('revision','1')
        return record

    def _cancellation_update(self,con,token,ws,body,scope):
        current=self._cancellation(con,token,ws,body['cancellation_id']);head=self._head(con,token,ws,current['experimentId'],'execute',deleted=True)
        if scope.principal_id!=head['created_by']:raise Forbidden('Only the cancellation owner may coordinate cleanup')
        if str(body.get('expected_revision'))!=str(current['revision']):raise Conflict('Cancellation revision is stale')
        if not callable(self.cancellation_verifier) or self.cancellation_verifier(token,ws,copy.deepcopy(current),copy.deepcopy(body)) is not True:raise Forbidden('Trusted external cleanup verification is required')
        targets=body.get('targets',json.loads(current['targetsJson']));status=body.get('status',current['status'])
        if status not in {'pending','completed','failed'} or not isinstance(targets,list):raise ValueError('Unsupported cancellation update')
        old={(t.get('kind'),t.get('runId'),t.get('clientId')) for t in json.loads(current['targetsJson'])}
        if {(t.get('kind'),t.get('runId'),t.get('clientId')) for t in targets}!=old:raise Conflict('Cancellation targets are frozen')
        if status=='completed' and any(t.get('confirmed') is not True for t in targets):raise Conflict('Every external target requires cleanup confirmation')
        value=current|{'revision':str(int(current['revision'])+1),'status':status,'targetsJson':_json(targets),'error':body.get('error'),'updatedAt':_iso(self.control.clock())}
        digest,ref=self._put(value);identity=_id()
        con.execute('INSERT INTO experiment_annotations(workspace_id,experiment_id,annotation_id,kind,case_id,result_id,machine_result_id,subject_id,actor_principal_id,payload_hash,payload_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(ws,current['experimentId'],identity,'cancellation_update',None,None,None,current['id'],scope.principal_id,digest,ref,self.control.clock()))
        return value

    def _prepare_execution(self,token,ws,body):
        if self.evidence is None:raise ExperimentUnavailable('Execution completion requires indexed TraceEvidence')
        with self.control.read_transaction() as con:
            _,cp,_,_=self._active(con,token,ws,body);payload=self._load(cp['payload_hash'],cp['payload_ref'])
            if payload['phase']!='execute':raise Conflict('Attempt is not an execution phase')
            if payload['checkpoint'].get('cleanup_required'):raise Conflict('Previous external command cleanup is unconfirmed')
        return self.evidence.read(token,ws,trace_ref=identifier(body['trace_id']))

    def _indexed_trace(self,con,ws,evidence):
        trace=evidence['manifest']['trace_id'];route=con.execute('SELECT created_at_ms FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
        rows=con.execute('SELECT state,trace_ids_json FROM ingest_batches WHERE workspace_id=? AND accepted_at_ms>=? ORDER BY accepted_at_ms DESC,batch_id LIMIT ?',(ws,route[0],MAX_ITEMS+1)).fetchall()
        if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Trace receipt boundary exceeds budget')
        matching=[row['state'] for row in rows if trace in json.loads(row['trace_ids_json'])]
        if 'indexed' not in matching or any(state in {'accepted','prepared'} for state in matching):raise ExperimentUnavailable('Trace ingestion has not reached indexed state')

    def _execute_complete(self,con,token,ws,body,scope,evidence):
        head,cp,attempt,slot=self._active(con,token,ws,body);payload=self._load(cp['payload_hash'],cp['payload_ref'])
        if payload['phase']!='execute':raise Conflict('Attempt is not an execution phase')
        self._verify_evidence(con,token,ws,evidence);self._indexed_trace(con,ws,evidence)
        case=self._case(con,ws,head['experiment_id'],cp['case_id']);raw=self._load(case['payload_hash'],case['payload_ref']);_,parent=self._plan(con,ws,head['experiment_id'],cp['run_id'])
        raw.update(taskId=evidence['execution']['taskId'],executionId=evidence['execution']['id'],actualOutput=evidence['execution'].get('finalResult') or '',traceGenerationError=None)
        for source,target in [('fi_run_id','fiRunId'),('fi_task_id','fiTaskId'),('fault_injection_type','faultInjectionType')]:
            if source in body:raw[target]=body[source]
        if 'trigger_decision' in body:raw['triggerDecision']=body['trigger_decision']
        checkpoint=payload['checkpoint']|{'status':'ready','stage':'ready','errorMessage':None,'failureCode':None,'trace_id':evidence['manifest']['trace_id'],'snapshot_hash':evidence['snapshot_hash']}
        if 'trigger_decision' in body:checkpoint['trigger_decision']=body['trigger_decision']
        digest,ref=self._put(payload|{'checkpoint':checkpoint});now=self.control.clock()
        con.execute("UPDATE work_attempts SET status='done',finished_at_ms=? WHERE workspace_id=? AND attempt_id=?",(now,ws,cp['attempt_id']))
        con.execute("UPDATE work_items SET status='done',updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,ws,cp['work_item_id']))
        con.execute("UPDATE experiment_result_slots SET status='done',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?",(now,ws,slot['result_id']))
        con.execute("UPDATE experiment_attempt_checkpoints SET payload_hash=?,payload_ref=?,trace_id=?,stage='ready',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND attempt_id=?",(digest,ref,evidence['manifest']['trace_id'],now,ws,cp['attempt_id']))
        self._case_write(con,token,ws,head['experiment_id'],raw,case['ordinal'],preserve_execution=True)
        evaluators=json.loads(parent['experiment_config'].get('evaluatorIdsJson','[]'))
        if evaluators:
            snapshot={'experiment':copy.deepcopy(parent['experiment_config'])|{'cases':[raw]},'revision':str(head['revision'])}
            child={'experiment_id':head['experiment_id'],'case_ids':[cp['case_id']],'config':parent['config'],'releases':parent['releases'],'frozen_evaluators':parent['frozen_evaluators']}
            result=self._start(con,token,ws,child,scope,(snapshot,{cp['case_id']:evidence}),trusted_parent=True)
        else:
            self._bump(con,ws,head['experiment_id'],status='done');result=self._snapshot(con,ws,self._head(con,token,ws,head['experiment_id']))
        result['execution_run_id']=cp['run_id'];return result

    def _execute_fail(self,con,token,ws,body,scope):
        head,cp,attempt,slot=self._active(con,token,ws,body);payload=self._load(cp['payload_hash'],cp['payload_ref'])
        if payload['phase']!='execute':raise Conflict('Attempt is not an execution phase')
        error=body.get('error','Execution failed');message=error if isinstance(error,str) else str(error.get('message','Execution failed'));code='EXECUTION_FAILED' if isinstance(error,str) else str(error.get('code','EXECUTION_FAILED'))
        confirmed=body.get('cleanup_confirmed') is True
        used=con.execute('SELECT COUNT(*) FROM work_attempts WHERE workspace_id=? AND work_item_id=?',(ws,cp['work_item_id'])).fetchone()[0]
        retry=body.get('retryable') is True and confirmed and used<3
        checkpoint=payload['checkpoint']|{'status':'retry_wait' if retry else 'failed','stage':'failed','errorMessage':message,'failureCode':code,'cleanup_confirmed':confirmed,'cleanup_required':bool(payload['checkpoint'].get('command_id')) and not confirmed}
        digest,ref=self._put(payload|{'checkpoint':checkpoint});now=self.control.clock();delay=(5000,20000)[min(used-1,1)]
        con.execute("UPDATE work_attempts SET status='failed',error_code=?,finished_at_ms=? WHERE workspace_id=? AND attempt_id=?",(code,now,ws,cp['attempt_id']))
        con.execute('UPDATE work_items SET status=?,next_attempt_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?',('queued' if retry else 'failed',now+delay if retry else 0,now,ws,cp['work_item_id']))
        con.execute('UPDATE experiment_result_slots SET status=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?',('pending' if retry else 'failed',now,ws,slot['result_id']))
        con.execute('UPDATE experiment_attempt_checkpoints SET payload_hash=?,payload_ref=?,stage=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND attempt_id=?',(digest,ref,'retry_wait' if retry else 'failed',now,ws,cp['attempt_id']))
        case=self._case(con,ws,head['experiment_id'],cp['case_id']);raw=self._load(case['payload_hash'],case['payload_ref']);raw['traceGenerationError']=message;digest,ref=self._put(raw)
        con.execute('UPDATE experiment_cases SET payload_hash=?,payload_ref=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=?',(digest,ref,now,ws,cp['case_id']))
        self._bump(con,ws,head['experiment_id'],status='running' if retry else 'failed')
        return self._snapshot(con,ws,self._head(con,token,ws,head['experiment_id']))

    def _case_lookup(self,con,token,ws,body):
        self.iam._workspace(self.iam._scope(con,token),ws,'read');checkpoint=None
        if body.get('fi_run_id'):
            row=con.execute('SELECT c.* FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.command_id=? ORDER BY a.attempt_no DESC LIMIT 1',(ws,'fi:'+identifier(body['fi_run_id']))).fetchone()
            if row is None:raise ExperimentNotFound('FI experiment binding not found')
            case=self._case(con,ws,row['experiment_id'],row['case_id']);checkpoint=dict(row)
        else:
            row=con.execute('SELECT * FROM experiment_cases WHERE workspace_id=? AND case_id=?',(ws,body['case_id'])).fetchone()
            if row is None:raise ExperimentNotFound('Experiment Case not found')
            case=self._case(con,ws,row['experiment_id'],row['case_id'])
        self._head(con,token,ws,case['experiment_id']);raw=self._load(case['payload_hash'],case['payload_ref']);public={k:raw.get(k) for k in ('id','input','taskId','executionId','actualOutput','fiRunId','fiTaskId','faultInjectionType','traceGenerationError')}
        result={'experiment_id':case['experiment_id'],'case_id':case['case_id'],'case':public}
        if checkpoint:
            result['checkpoint']=self._load(checkpoint['payload_hash'],checkpoint['payload_ref'])['checkpoint'];result['attempt_no']=con.execute('SELECT attempt_no FROM work_attempts WHERE workspace_id=? AND attempt_id=?',(ws,checkpoint['attempt_id'])).fetchone()[0]
            if not result['case'].get('fiRunId'):result['case']['fiRunId']=result['checkpoint'].get('fi_run_id')
        return result

    def _ensure(self,con,token,ws,body,scope):
        source=copy.deepcopy(body.get('experiment'))
        if not isinstance(source,dict):raise ValueError('Prepared Experiment DTO is required')
        if body.get('existing_id'):
            head=self._head(con,token,ws,body['existing_id'],'write')
            if head['created_by']!=scope.principal_id:raise Forbidden('Existing Experiment must belong to the actor')
            return self._snapshot(con,ws,head)
        rows=con.execute("SELECT * FROM experiment_heads WHERE workspace_id=? AND created_by=? AND state='active' AND name=? AND scope=? AND agent_name=? AND skill_name=? ORDER BY created_at_ms,experiment_id LIMIT ?",(ws,scope.principal_id,source['name'],source.get('scope',''),source.get('agentName',''),source.get('skillName',''),MAX_ITEMS+1)).fetchall()
        if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Experiment identity candidates exceed budget')
        for row in rows:
            metadata=self._load(row['metadata_hash'],row['metadata_ref'])
            if metadata.get('skillVersion')==source.get('skillVersion'):return self._snapshot(con,ws,dict(row))
        if source.get('id') and con.execute('SELECT 1 FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,source['id'])).fetchone():source.pop('id')
        return self._create(con,token,ws,body|{'experiment':source},scope)

    def _late_execution(self,con,token,ws,body):
        head=self._head(con,token,ws,body['experiment_id'],'write');scope=self.iam._authorize(con,token,ws,'execute','run',body['experiment_id']);case=self._case(con,ws,body['experiment_id'],body['case_id'])
        if scope.principal_id!=head['created_by']:raise Forbidden('Late execution reconciliation requires the owner')
        slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,case['case_id'],EXECUTION_SLOT)).fetchone()
        if slot is None or slot['status']!='failed':raise Conflict('Current execution is not a failed ingest wait')
        cp=con.execute('SELECT c.*,a.attempt_no,a.status AS attempt_status,a.error_code,w.status AS item_status,w.etag,w.cancel_requested FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id JOIN work_items w ON w.workspace_id=c.workspace_id AND w.work_item_id=c.work_item_id WHERE c.workspace_id=? AND c.work_item_id=? ORDER BY a.attempt_no DESC LIMIT 1',(ws,slot['work_item_id'])).fetchone()
        minimum=body.get('min_attempt_no',0)
        if type(minimum) is not int or minimum<0:raise ValueError('min_attempt_no must be a nonnegative integer')
        if cp is None or cp['attempt_status']!='failed' or cp['error_code']!='TRACE_INGEST_TIMEOUT' or cp['item_status']!='failed' or cp['cancel_requested'] or cp['etag']!=cp['fence'] or cp['attempt_no']<minimum or cp['lifecycle_revision']!=head['lifecycle_revision'] or cp['case_lifecycle_revision']!=case['lifecycle_revision'] or cp['actor_principal_id']!=scope.principal_id:raise Conflict('Only the current TRACE_INGEST_TIMEOUT attempt may reconcile')
        checkpoint=self._load(cp['payload_hash'],cp['payload_ref'])['checkpoint']
        if checkpoint.get('cleanup_required') or checkpoint.get('cleanup_confirmed') is not True:raise Conflict('External execution cleanup is not confirmed')
        if body.get('command_id') and body['command_id']!=checkpoint.get('command_id'):raise Conflict('Late Trace command differs')
        observed=checkpoint.get('observed_trace_id') or checkpoint.get('trace_id')
        if not observed:raise ExperimentUnavailable('No observed Trace identity is available for reconciliation')
        return dict(cp),observed

    def _prepare_late_execution(self,token,ws,body):
        if self.evidence is None:raise ExperimentUnavailable('Late execution reconciliation requires indexed evidence')
        with self.control.read_transaction() as con:cp,observed=self._late_execution(con,token,ws,body)
        evidence=self.evidence.read(token,ws,trace_ref=observed)
        return evidence,self._late_handle(cp)

    @staticmethod
    def _late_handle(cp):
        return {'experiment_id':cp['experiment_id'],'attempt_id':cp['attempt_id'],'fence':str(cp['fence']),'lease_owner':cp['lease_owner']}

    def _execute_reconcile(self,con,token,ws,body,scope,prepared):
        evidence,handle=prepared;cp,_=self._late_execution(con,token,ws,body)
        if self._late_handle(cp)!=handle:raise Conflict('Execution changed while reading late Trace evidence')
        if body.get('trace_id'):
            ref=body['trace_id'];matches={row[0] for row in con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_id=?',(ws,ref)).fetchall()}
            if con.execute('SELECT 1 FROM trace_locators WHERE workspace_id=? AND trace_id=?',(ws,ref)).fetchone():matches.add(ref)
            if matches!={evidence['manifest']['trace_id']}:raise Conflict('Late Trace differs from the observed execution identity')
        self._verify_evidence(con,token,ws,evidence);self._indexed_trace(con,ws,evidence);now=self.control.clock()
        con.execute("UPDATE work_attempts SET status='running',finished_at_ms=NULL,error_code=NULL,lease_until_ms=? WHERE workspace_id=? AND attempt_id=?",(now+30000,ws,cp['attempt_id']))
        con.execute("UPDATE work_items SET status='running',updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,ws,cp['work_item_id']))
        result=self._execute_complete(con,token,ws,body|handle,scope,evidence);result['reconciled']=True;return result

    def _record_derived(self,con,token,ws,scope,head,cp,slot,machine,result,validate_only=False):
        evidence=result.get('evidence')
        if evidence is None and isinstance(result.get('evidenceJson'),str):
            try:evidence=json.loads(result['evidenceJson'])
            except ValueError:raise ValueError('Machine evidence JSON is invalid') from None
        container=evidence.get('json',{}) if isinstance(evidence,dict) else {}
        derived=container.get('directTrajectoryDerived') if isinstance(container,dict) else None
        business=container.get('experimentSkillDerived') if isinstance(container,dict) else None
        if derived is not None and business is not None:raise Conflict('Derived machine envelopes are mutually exclusive')
        if business is not None:derived=business
        if derived is None:return
        if not isinstance(derived,dict) or set(derived)-({'version','points','evaluations','skillIssues'} if business is not None else {'evaluations','skillIssues'}):raise ValueError('Unsupported derived trajectory payload')
        evaluations=derived.get('evaluations',[]);issues=derived.get('skillIssues',[])
        if not isinstance(evaluations,list) or not isinstance(issues,list) or len(evaluations)+len(issues)>1000:raise ExperimentTooLarge('Derived trajectory objects exceed budget')
        if not evaluations and not issues:
            if business is not None:raise Conflict('Experiment Skill envelope must contain actual attributed issues')
            return
        _,plan=self._plan(con,ws,head['experiment_id'],cp['run_id']);allowed=plan['config'].get('derived_skill_ids',[]);source=plan['frozen_trace_evidence'].get(cp['case_id'])
        if not isinstance(allowed,list) or not allowed or source is None and business is None or plan['config'].get('_derived_scope_attested') is not True:raise Conflict('Derived objects require frozen Skill scope and Trace evidence')
        if business is not None:
            frozen=plan.get('experiment_config',{});binding=plan['config'].get('experiment_skill_scope')
            issue_source='trigger' if frozen.get('preset')=='trigger' else 'dynamic' if frozen.get('preset')=='use-case' or frozen.get('scope')=='skill-case-analysis' else None
            if not isinstance(binding,dict) or type(binding.get('version')) is not int or binding['version']<0 or issue_source is None or binding!={'skill_id':binding.get('skill_id'),'skill_name':frozen.get('skillName'),'version':frozen.get('skillVersion'),'source':issue_source,'preset':frozen.get('preset'),'scope':frozen.get('scope','')}:raise Conflict('Experiment Skill scope differs from its sealed configuration')
            if binding.get('skill_id') not in allowed or binding.get('version') not in plan['config'].get('derived_skill_versions',{}).get(binding['skill_id'],[]):raise Forbidden('Experiment Skill is outside the attested scope')
            points=result.get('points')
            if 'points' not in result and isinstance(result.get('pointsJson'),str):
                try:points=json.loads(result['pointsJson'])
                except ValueError:raise ValueError('Machine points JSON is invalid') from None
            if type(derived.get('version')) is not int or derived['version']!=1 or not isinstance(points,list) or _json(derived.get('points'))!=_json(points):raise Conflict('Derived issues differ from the original machine points')
            if len(points)>1000:raise ExperimentTooLarge('Experiment Skill points exceed the derived object budget')
            whitespace=r'[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
            def text(value):return re.sub('^'+whitespace+'+|'+whitespace+'+$','',value) if isinstance(value,str) else ''
            def number(value):
                if value is None:return 0
                if isinstance(value,bool):return int(value)
                if isinstance(value,(int,float)):return value
                def array_text(parts):
                    return ','.join('' if part is None else array_text(part) if isinstance(part,list) else '[object Object]' if isinstance(part,dict) else str(part).lower() if isinstance(part,bool) else str(part) for part in parts)
                if isinstance(value,list):value=array_text(value)
                if isinstance(value,str):
                    value=text(value)
                    if not value:return 0
                    if not re.fullmatch(r'(?:[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]?Infinity|0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+)',value):return float('nan')
                    try:return int(value,0) if re.match(r'^0[xXbBoO]',value) else float(value)
                    except ValueError:return float('nan')
                return float('nan')
            def normalized(point):
                if not isinstance(point,dict) or not any(point.get(key) is True for key in ('skillAttributable','isSkillAttributable','is_skill_attributable')):return None
                fix=text(point.get('suggestion')) or text(point.get('improvementSuggestion')) or text(point.get('improvement_suggestion'))
                if not fix:return None
                summary=text(point.get('label')) or text(result.get('summary')) or slot['evaluator_id']
                explicit=text(point.get('severity')).lower();status=text(point.get('status')).lower();score=number(point.get('score',float('nan')))
                severity=explicit if explicit in {'high','medium','low'} else 'high' if status in {'missing','fail','failed'} else 'medium' if status in {'partial','warn','warning'} else 'high' if math.isfinite(score) and score<50 else 'medium' if math.isfinite(score) and score<100 else 'low'
                category='触发评测' if issue_source=='trigger' else '任务完成度' if 'task-completion' in slot['evaluator_id'] else '轨迹偏差' if 'trace-quality' in slot['evaluator_id'] else '结果问题' if 'result' in slot['evaluator_id'] else '用例评测'
                norm=lambda value:text(re.sub(whitespace+'+',' ',value.lower()))
                dedup=hashlib.sha1('::'.join([issue_source,norm(category),norm(summary),norm(fix)]).encode()).hexdigest()[:12]
                raw=point.get('evidence');proof=text(raw) or None if isinstance(raw,str) else text(raw.get('md')) or json.dumps(raw,ensure_ascii=False,separators=(',',':'),allow_nan=False) if isinstance(raw,dict) else None
                return {'source':issue_source,'dedupKey':dedup,'severity':severity,'summary':summary,'evidence':proof,'reasoning':text(result.get('summary')) or None,'suggestedFix':fix,'ruleId':'experiment','dimension':slot['evaluator_id'],'category':category}
            evaluation_id='experiment-evaluation-'+_hash([cp['attempt_id'],slot['evaluator_id']])[:40]
            expected_evaluation={'id':evaluation_id,'type':issue_source,'skillId':binding['skill_id'],'version':binding['version'],'executionId':source['execution']['id'] if source else None,'generator':'experiment-skill-issues@1.0','runId':'experiment:'+head['experiment_id']+':'+slot['result_id'],'status':'ok'}
            expected_issues={}
            for index,point in enumerate(points):
                value=normalized(point)
                if value:expected_issues[value['dedupKey']]={'id':'experiment-issue-'+_hash([cp['attempt_id'],slot['evaluator_id'],index])[:40],'evaluationId':evaluation_id,'skillId':binding['skill_id'],'version':binding['version'],**value,'pointIndex':index}
            clean=lambda values:[{key:value for key,value in item.items() if key!='user'} if isinstance(item,dict) else item for item in values]
            if not expected_issues or _json(clean(evaluations))!=_json([expected_evaluation]) or _json(clean(issues))!=_json(list(expected_issues.values())):raise Conflict('Derived Issue DTO escaped its original machine points')
        owner=self._owner(con,scope.principal_id);by_id={};objects=[]
        for kind,rows in [('derived-evaluation',evaluations),('derived-issue',issues)]:
            for raw in rows:
                if not isinstance(raw,dict):raise ValueError('Derived object must be a DTO')
                dto=copy.deepcopy(raw);identity=identifier(dto.get('id',''));skill=identifier(dto.get('skillId',''))
                if skill not in allowed:raise Forbidden('Derived Skill is outside frozen actor scope')
                if business is None and skill==plan['config'].get('derived_public_business_skill_id'):raise Forbidden('Public business Skill scope cannot authorize direct trajectory objects')
                version=dto.get('version')
                if version is not None and type(version) is not int or version not in plan['config'].get('derived_skill_versions',{}).get(skill,[]):raise Forbidden('Derived Skill version is outside the sealed version scope')
                if kind=='derived-evaluation':
                    if dto.get('executionId')!=(source['execution']['id'] if source else None):raise Conflict('Derived Evaluation escaped the frozen source execution')
                    if identity in by_id:raise Conflict('Duplicate derived Evaluation identity')
                    by_id[identity]=dto
                else:
                    parent=by_id.get(dto.get('evaluationId'))
                    if parent is None or parent.get('skillId')!=skill or parent.get('version')!=dto.get('version'):raise Conflict('Derived issue must reference its own packet Evaluation and Skill version')
                dto['user']=owner;objects.append((kind,identity,skill,dto))
        if validate_only:
            derived['evaluations']=[dto for kind,_,_,dto in objects if kind=='derived-evaluation'];derived['skillIssues']=[dto for kind,_,_,dto in objects if kind=='derived-issue']
            if isinstance(result.get('evidenceJson'),str):result['evidenceJson']=_json(evidence)
            return
        seen=set()
        for kind,identity,skill,dto in objects:
            if identity in seen:raise Conflict('Duplicate derived object identity')
            seen.add(identity);digest,ref=self._put(dto);old=con.execute('SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=?',(ws,identity)).fetchone()
            if old:
                if old['experiment_id']!=head['experiment_id'] or old['case_id']!=cp['case_id'] or old['result_id']!=slot['result_id'] or old['machine_result_id']!=machine or old['kind']!=kind or old['payload_hash']!=digest:raise Conflict('Derived object identity already has another immutable owner or receipt')
                continue
            con.execute('INSERT INTO experiment_annotations(workspace_id,experiment_id,annotation_id,kind,case_id,result_id,machine_result_id,subject_id,actor_principal_id,payload_hash,payload_ref,created_at_ms,lookup_key) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?)',(ws,head['experiment_id'],identity,kind,cp['case_id'],slot['result_id'],machine,scope.principal_id,digest,ref,self.control.clock(),skill))

    def _derived_trigger_frontier(self,token,ws,body):
        skill=identifier(body.get('skill_id'));requested=body.get('version')
        if requested is not None and (type(requested) is not int or requested<0):raise ValueError('Explicit Skill version required')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read');candidates=[];latest={};size=0
            heads=con.execute("SELECT * FROM experiment_heads WHERE workspace_id=? AND created_by=? AND state='active' AND status IN ('done','partial') ORDER BY experiment_id LIMIT ?",(ws,scope.principal_id,MAX_ITEMS+1)).fetchall()
            if len(heads)>MAX_ITEMS:raise ExperimentTooLarge('Trigger frontier head budget exceeded')
            for head in heads:
                metadata=self._load(head['metadata_hash'],head['metadata_ref'])
                if metadata.get('preset')!='trigger' or requested is not None and metadata.get('skillVersion')!=requested:continue
                if con.execute("SELECT 1 FROM experiment_result_slots s JOIN experiment_cases c ON c.workspace_id=s.workspace_id AND c.case_id=s.case_id WHERE s.workspace_id=? AND s.experiment_id=? AND c.state='active' AND s.status NOT IN ('done','failed','cancelled','skipped') LIMIT 1",(ws,head['experiment_id'])).fetchone():continue
                receipts=con.execute("SELECT r.* FROM experiment_result_slots s JOIN experiment_cases c ON c.workspace_id=s.workspace_id AND c.case_id=s.case_id JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.selected_result_id WHERE s.workspace_id=? AND s.experiment_id=? AND c.state='active' AND s.status='done' ORDER BY r.result_id LIMIT ?",(ws,head['experiment_id'],MAX_ITEMS+1)).fetchall()
                if len(receipts)>MAX_ITEMS:raise ExperimentTooLarge('Trigger frontier selection budget exceeded')
                accepted=[];evaluations=[];sources=[];version=None
                for receipt in receipts:
                    _,plan=self._plan(con,ws,head['experiment_id'],receipt['run_id']);binding=plan.get('config',{}).get('experiment_skill_scope');config=plan.get('config',{});frozen=plan.get('experiment_config',{})
                    if not isinstance(binding,dict) or binding.get('skill_id')!=skill:continue
                    expected={'skill_id':skill,'skill_name':head['skill_name'],'version':metadata.get('skillVersion'),'source':'trigger','preset':'trigger','scope':head['scope']}
                    if binding!=expected or frozen.get('preset')!='trigger' or frozen.get('scope','')!=head['scope'] or frozen.get('skillName')!=head['skill_name'] or frozen.get('skillVersion')!=metadata.get('skillVersion') or config.get('_derived_scope_attested') is not True or binding['version'] not in config.get('derived_skill_versions',{}).get(skill,[]):raise Conflict('Trigger frontier source scope differs')
                    if receipt['state']=='quarantined':raise ExperimentUnavailable('Trigger frontier machine receipt is quarantined')
                    self._head(con,token,ws,head['experiment_id']);self._source_assets(con,scope,ws,head['experiment_id'],receipt['run_id'])
                    for manifest in self._source_routes(plan,receipt['case_key']):self._source_route(con,scope,ws,manifest);sources.append(manifest)
                    version=binding['version'];accepted.append(dict(receipt))
                    evaluations.extend(row[0] for row in con.execute("SELECT annotation_id FROM experiment_annotations WHERE workspace_id=? AND machine_result_id=? AND kind='derived-evaluation' AND lookup_key=? ORDER BY annotation_id",(ws,receipt['result_id'],skill)).fetchall())
                    if len(evaluations)>MAX_ITEMS:raise ExperimentTooLarge('Trigger frontier Evaluation budget exceeded')
                if not accepted:continue
                stamp=max(row['created_at_ms'] for row in accepted);key=(stamp,head['experiment_id']);item={'version':version,'experiment_id':head['experiment_id'],'evaluation_ids':sorted(set(evaluations)),'settled_at':_iso(stamp)}
                if version not in latest or key>latest[version][0]:
                    size+=len(_json(item).encode())-(len(_json(latest[version][1]).encode()) if version in latest else 0)
                    if size>MAX_BYTES:raise ExperimentTooLarge('Trigger frontier byte budget exceeded')
                    latest[version]=(key,item)
                candidates.append((dict(head),[dict(row) for row in receipts],accepted,sources))
            fingerprint=scope.fingerprint;values=[latest[version][1] for version in sorted(latest)]
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,ws,'read')
            if current.fingerprint!=fingerprint:raise Forbidden('Trigger frontier authorization changed')
            for head,receipts,accepted,sources in candidates:
                fresh=self._head(con,token,ws,head['experiment_id'])
                if fresh['created_by']!=current.principal_id or fresh['status']!=head['status'] or fresh['current_run_id']!=head['current_run_id'] or fresh['revision']!=head['revision'] or fresh['lifecycle_revision']!=head['lifecycle_revision']:raise Conflict('Trigger frontier lifecycle changed')
                selected=con.execute("SELECT r.result_id,r.state FROM experiment_result_slots s JOIN experiment_cases c ON c.workspace_id=s.workspace_id AND c.case_id=s.case_id JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.selected_result_id WHERE s.workspace_id=? AND s.experiment_id=? AND c.state='active' AND s.status='done' ORDER BY r.result_id LIMIT ?",(ws,head['experiment_id'],MAX_ITEMS+1)).fetchall()
                if [(row[0],row[1]) for row in selected]!=[(row['result_id'],row['state']) for row in receipts]:raise Conflict('Trigger frontier selection changed')
                for receipt in accepted:self._source_assets(con,current,ws,head['experiment_id'],receipt['run_id'])
                for manifest in sources:self._source_route(con,current,ws,manifest)
        return {'versions':values}

    def _derived_read(self,action,token,ws,body):
        kind={'evaluation':'derived-evaluation','issue':'derived-issue'}.get(body.get('kind'))
        if kind is None:raise ValueError('Derived kind must be evaluation or issue')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);grant=self.iam._workspace(scope,ws,'read');params=[ws,kind];where="a.workspace_id=? AND a.kind=? AND e.state='active' AND p.state<>'quarantined'"
            if action=='derived_lookup':where+=' AND a.annotation_id=?';params.append(body['id']);limit=2
            else:
                limit=body.get('limit',100)
                if type(limit) is not int or not 1<=limit<=MAX_ITEMS:raise ValueError('Invalid derived list limit')
                where+=' AND a.annotation_id>?';params.append(body.get('after_id',''))
                if body.get('owned_only') is True:where+=' AND e.created_by=?';params.append(scope.principal_id)
                if body.get('include_historical'):
                    if kind!='derived-issue' or not body.get('evaluation_id'):raise ValueError('Historical issue lists require an explicit Evaluation identity')
                else:where+=" AND s.selected_result_id=a.machine_result_id AND c.state='active'"
                if body.get('evaluation_id'):
                    evaluation=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='derived-evaluation'",(ws,body['evaluation_id'])).fetchone()
                    if evaluation is None:raise ExperimentNotFound('Derived Evaluation not found')
                    self._head(con,token,ws,evaluation['experiment_id'])
                    where+=' AND a.machine_result_id=? AND a.result_id=?';params.extend([evaluation['machine_result_id'],evaluation['result_id']])
                for key,column in [('scope','e.scope'),('skill_id','a.lookup_key')]:
                    if key in body:where+=' AND '+column+'=?';params.append(body[key])
                for key,alias_kind in [('execution_id','execution'),('task_id','task')]:
                    if key in body:
                        ref=body[key];alias=con.execute('SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind=? AND alias_id=?',(ws,alias_kind,ref)).fetchone();trace=alias[0] if alias else ref
                        where+=' AND c.trace_id=?';params.append(trace)
            if grant.role not in {'owner','admin','personal'}:
                where+=" AND (r.owner_principal_id=? OR r.visibility='group' OR EXISTS(SELECT 1 FROM iam_resource_grants g WHERE g.workspace_id=r.workspace_id AND g.resource_kind=r.resource_kind AND g.resource_id=r.resource_id AND g.grantee_principal_id=?))";params.extend([scope.principal_id,scope.principal_id])
            params.append(MAX_ITEMS+1 if body.get('evaluation_id') else limit)
            rows=con.execute("SELECT a.*,e.created_by FROM experiment_annotations a JOIN experiment_heads e ON e.workspace_id=a.workspace_id AND e.experiment_id=a.experiment_id JOIN experiment_cases c ON c.workspace_id=a.workspace_id AND c.case_id=a.case_id JOIN experiment_result_slots s ON s.workspace_id=a.workspace_id AND s.result_id=a.result_id JOIN result_receipts p ON p.workspace_id=a.workspace_id AND p.result_id=a.machine_result_id AND p.case_key=a.case_id JOIN iam_resource_access r ON r.workspace_id=e.workspace_id AND r.resource_kind='run' AND r.resource_id=e.experiment_id WHERE "+where+' ORDER BY a.annotation_id LIMIT ?',tuple(params)).fetchall()
            if action=='derived_lookup' and not rows:
                # Resolve a known identifier through the root check so private records cannot bypass live IAM.
                raw=con.execute('SELECT experiment_id FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind=?',(ws,body['id'],kind)).fetchone()
                if raw:self._head(con,token,ws,raw[0])
                if raw or body.get('allow_missing') is not True:raise ExperimentNotFound('Derived object not found')
            result=[];size=0;roots=set();source_routes=[];source_assets=set()
            for row in rows:
                self._head(con,token,ws,row['experiment_id']);roots.add(row['experiment_id'])
                receipt=con.execute('SELECT run_id FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,row['machine_result_id'])).fetchone()
                self._source_assets(con,scope,ws,row['experiment_id'],receipt['run_id']);source_assets.add((row['experiment_id'],receipt['run_id']))
                _,plan=self._plan(con,ws,row['experiment_id'],receipt['run_id'])
                for manifest in self._source_routes(plan,row['case_id']):self._source_route(con,scope,ws,manifest);source_routes.append(manifest)
                dto=self._derived_dto(row,con)
                if body.get('evaluation_id') and dto.get('evaluationId')!=body['evaluation_id']:continue
                if action=='derived_list' and len(result)>=limit:break
                if row['created_by']!=scope.principal_id:
                    dto={key:value for key,value in dto.items() if key in {'id','type','source','status','skillId','version','user','executionId','evaluationId','runId','generator','severity','category','ruleId','dimension'}}|{'gold_redacted':True}
                size+=len(_json(dto).encode())
                if size>MAX_BYTES:raise ExperimentTooLarge('Derived response exceeds budget')
                result.append(dto)
            fingerprint=scope.fingerprint
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,ws,'read')
            if current.fingerprint!=fingerprint:raise Forbidden('Derived authorization changed while reading')
            for exp in roots:self._head(con,token,ws,exp)
            for exp,run in source_assets:self._source_assets(con,current,ws,exp,run)
            for manifest in source_routes:self._source_route(con,current,ws,manifest)
        if action=='derived_lookup' and body.get('allow_missing') is True:return {'found':bool(result),'value':result[0] if result else None}
        return result[0] if action=='derived_lookup' else result

    @staticmethod
    def _derived_counts(con,ws,exp):
        rows=con.execute("SELECT kind,COUNT(*) AS total FROM experiment_annotations WHERE workspace_id=? AND experiment_id=? AND kind IN ('derived-evaluation','derived-issue') GROUP BY kind",(ws,exp)).fetchall()
        counts={row['kind']:row['total'] for row in rows}
        return {'evaluations':counts.get('derived-evaluation',0),'skill_issues':counts.get('derived-issue',0)}

    def _ensure_lookup(self,token,ws,body):
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
            rows=con.execute("SELECT * FROM experiment_heads WHERE workspace_id=? AND created_by=? AND state='active' AND name=? AND scope=? AND agent_name=? AND skill_name=? ORDER BY created_at_ms,experiment_id LIMIT ?",(ws,scope.principal_id,body['name'],body.get('scope',''),body.get('agent_name',''),body.get('skill_name',''),MAX_ITEMS+1)).fetchall()
            if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Experiment identity candidates exceed budget')
            result=None
            for row in rows:
                metadata=self._load(row['metadata_hash'],row['metadata_ref'])
                if metadata.get('skillVersion')==body.get('skill_version'):
                    self._head(con,token,ws,row['experiment_id']);self._guard_sources(con,token,ws,row['experiment_id']);result=self._snapshot(con,ws,dict(row));break
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,ws,'read')
            if current.fingerprint!=scope.fingerprint:raise Forbidden('Experiment authorization changed while looking up identity')
            if result:self._head(con,token,ws,result['experiment']['id']);self._guard_sources(con,token,ws,result['experiment']['id'])
        return self._redact(result,current.principal_id)

    def _derived_detail(self,token,ws,identity):
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'read')
            row=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='derived-evaluation'",(ws,identity)).fetchone()
            if row is None:raise ExperimentNotFound('Derived Evaluation not found')
            head=self._head(con,token,ws,row['experiment_id']);receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=? AND case_key=?',(ws,row['machine_result_id'],row['case_id'])).fetchone()
            if receipt is None or receipt['state']=='quarantined':raise ExperimentUnavailable('Derived source receipt is unavailable')
            self._source_assets(con,scope,ws,row['experiment_id'],receipt['run_id'])
            run,plan=self._plan(con,ws,row['experiment_id'],receipt['run_id']);source=plan.get('frozen_trace_evidence',{}).get(row['case_id'])
            if source is None:
                packet=self._load(receipt['content_hash'],receipt['artifact_ref']);result=packet.get('result',{});proof=result.get('evidence')
                if proof is None and isinstance(result.get('evidenceJson'),str):proof=json.loads(result['evidenceJson'])
                envelope=proof.get('json',{}).get('experimentSkillDerived') if isinstance(proof,dict) and isinstance(proof.get('json'),dict) else None
                if not isinstance(envelope,dict) or not any(value.get('id')==identity and value.get('executionId') is None for value in envelope.get('evaluations',[]) if isinstance(value,dict)):raise ExperimentUnavailable('Derived source has no frozen Trace evidence')
                cp=con.execute('SELECT * FROM experiment_attempt_checkpoints WHERE workspace_id=? AND attempt_id=?',(ws,receipt['attempt_id'])).fetchone()
                if cp is None:raise ExperimentUnavailable('Derived source attempt is unavailable')
                self._record_derived(con,token,ws,scope,head,cp,self._slot(con,ws,row['experiment_id'],row['result_id']),receipt['result_id'],result,validate_only=True)
            else:self._source_route(con,scope,ws,source['manifest'])
            evaluation=self._derived_dto(row,con);issues=[];size=len(_json(evaluation).encode())+len(_json(source).encode())
            rows=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND result_id=? AND machine_result_id=? AND kind='derived-issue' ORDER BY annotation_id LIMIT ?",(ws,row['result_id'],row['machine_result_id'],MAX_ITEMS+1)).fetchall()
            if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Derived detail issue set exceeds budget')
            for issue in rows:
                dto=self._derived_dto(issue,con)
                if dto.get('evaluationId')!=identity:continue
                size+=len(_json(dto).encode())
                if size>MAX_BYTES:raise ExperimentTooLarge('Derived detail exceeds byte budget')
                issues.append(dto)
            metadata=plan.get('experiment_config',{}).get('configSnapshotJson') or '{}'
            if isinstance(metadata,str):
                try:metadata=json.loads(metadata)
                except ValueError:raise ExperimentUnavailable('Frozen Skill metadata is invalid') from None
            skills=metadata.get('coreDirectSkills',[]) if isinstance(metadata,dict) else []
            frozen=next((skill for skill in skills if isinstance(skill,dict) and skill.get('id')==evaluation.get('skillId')),None)
            business_scope=plan.get('config',{}).get('experiment_skill_scope',{})
            skill={'id':evaluation.get('skillId'),'name':frozen.get('name') if frozen else business_scope.get('skill_name') if business_scope.get('skill_id')==evaluation.get('skillId') else None,'user':frozen.get('user') if frozen else evaluation.get('user'),'version':evaluation.get('version')}
            if frozen:
                versions=frozen.get('versions',[]);selected=next((value for value in versions if isinstance(value,dict) and value.get('version')==evaluation.get('version')),None)
                flows=[value for value in frozen.get('parsedFlows',[]) if isinstance(value,dict) and value.get('version')==evaluation.get('version')]
                skill.update(description=frozen.get('description'),content=selected.get('content') if selected else None,selectedVersion=selected,parsedFlows=flows)
            result={'evaluation':evaluation,'issues':issues,'skill':skill,'execution':copy.deepcopy(source['execution']) if source else None,'trace_evidence':source,'experiment_id':row['experiment_id'],'run_id':receipt['run_id'],'case_id':row['case_id']}
            result['provenance']={'owner_principal_id':head['created_by'],'lifecycle_revision':str(head['lifecycle_revision']),'machine_result_id':row['machine_result_id'],'result_slot_id':row['result_id'],'machine_content_hash':receipt['content_hash'],'derived_content_hash':row['payload_hash'],'plan_hash':run['plan_hash']}
            if scope.principal_id!=head['created_by']:
                safe={'id','type','source','status','skillId','version','user','executionId','evaluationId','runId','generator','severity','category','ruleId','dimension'}
                result['evaluation']={k:v for k,v in evaluation.items() if k in safe};result['issues']=[{k:v for k,v in issue.items() if k in safe} for issue in issues];result['skill']={k:skill[k] for k in ('id','name','user','version')};result['trace_evidence']=None;result['execution']=({k:v for k,v in source['execution'].items() if k in {'id','taskId','user','framework','model','timestamp','createdAt','agentName','hostIp'}}|{'query':None,'finalResult':None}) if source else None;result['gold_redacted']=True
            if len(_json(result).encode())>MAX_BYTES:raise ExperimentTooLarge('Derived detail exceeds response budget')
            fingerprint=scope.fingerprint;exp=row['experiment_id'];machine=row['machine_result_id'];digest=receipt['content_hash']
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,ws,'read');self._head(con,token,ws,exp)
            latest=con.execute('SELECT state,content_hash FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,machine)).fetchone()
            if current.fingerprint!=fingerprint:raise Forbidden('Derived detail authorization changed during read')
            if latest is None or latest['state']=='quarantined' or latest['content_hash']!=digest:raise ExperimentUnavailable('Derived detail source changed during read')
            self._source_assets(con,current,ws,row['experiment_id'],receipt['run_id'])
            if source:self._source_route(con,current,ws,source['manifest'])
        return result

    @staticmethod
    def _request_summary(request):
        return {key:request[key] for key in ('kind','workerId','targetWorkerId','platform','agent','model','timeoutSeconds') if key in request}

    @staticmethod
    def _external_target(command,checkpoint,request,attempt_id=None):
        if request.get('kind')=='local':
            if not attempt_id or command and command!='local:'+attempt_id:raise Conflict('Local execution target differs from its actual attempt')
            return {'kind':'local','runId':attempt_id,'clientId':None}
        if command.startswith('fi:'):
            return {'kind':'fi','runId':checkpoint.get('fi_run_id') or command[3:],'clientId':request.get('targetWorkerId') or request.get('workerId'),'fiTaskKey':checkpoint.get('fi_task_key')}
        return {'kind':'ordinary','runId':command,'clientId':request.get('workerId') or request.get('targetWorkerId')}

    def _derived_dto(self,row,con=None):
        dto=self._load(row['payload_hash'],row['payload_ref'])
        if row['kind']=='derived-evaluation':
            dto.setdefault('ranAt',_iso(row['created_at_ms']))
            if con is not None:
                machine=con.execute('SELECT run_id FROM result_receipts WHERE workspace_id=? AND result_id=?',(row['workspace_id'],row['machine_result_id'])).fetchone()
                if machine:dto.setdefault('runId',machine['run_id'])
            for key in ('contentHash','errorMessage','durationMs','l2ScoresJson'):dto.setdefault(key,None)
        elif row['kind']=='derived-issue':
            dto.setdefault('createdAt',_iso(row['created_at_ms']))
            if con is not None and con.execute('SELECT 1 FROM schema_meta WHERE version=14').fetchone():
                annotation=con.execute('SELECT * FROM experiment_derived_issue_annotations WHERE workspace_id=? AND issue_id=? ORDER BY resolved_at_ms DESC,annotation_id DESC LIMIT 1',(row['workspace_id'],row['annotation_id'])).fetchone()
                dto['resolvedAt']=_iso(annotation['resolved_at_ms']) if annotation else None;dto['resolvedRunId']=self._resolution_run(con,annotation) if annotation else None
        return dto

    def _resolution_run(self,con,annotation):
        value=annotation['resolved_run_id']
        reference='resolution-operation:'+_hash([annotation['workspace_id'],annotation['actor_principal_id'],annotation['operation_key']])
        if value!=reference:return value
        receipt=con.execute('SELECT * FROM experiment_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind=? AND operation_key=?',(annotation['workspace_id'],annotation['actor_principal_id'],annotation['operation_kind'],annotation['operation_key'])).fetchone()
        if receipt is None or receipt['request_hash']!=annotation['request_hash']:raise ExperimentUnavailable('Issue resolution provenance is unavailable')
        packet=self._load(receipt['response_hash'],receipt['response_ref'],MAX_BYTES);ids=packet.get('resolved_ids')
        if not isinstance(ids,list) or not ids or annotation['issue_id'] not in ids:raise ExperimentUnavailable('Issue resolution provenance differs')
        first=con.execute("SELECT experiment_id FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='derived-issue'",(annotation['workspace_id'],ids[0])).fetchone()
        if first is None or first['experiment_id']!=receipt['experiment_id'] or packet.get('resolved_run_id') not in (None,value):raise ExperimentUnavailable('Issue resolution source differs')
        return packet.get('resolved_run_id')

    def _resolution_sources(self,con,token,ws,scope,ids,*,current):
        rows=[];routes=[]
        for identity in ids:
            row=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='derived-issue'",(ws,identity)).fetchone()
            if row is None:raise ExperimentNotFound('Derived Issue not found')
            row=dict(row);head=self._head(con,token,ws,row['experiment_id'],'write')
            if head['created_by']!=scope.principal_id or row['actor_principal_id']!=scope.principal_id:raise Forbidden('Only the original owner can resolve a derived Issue')
            self._case(con,ws,row['experiment_id'],row['case_id'])
            machine=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=? AND case_key=?',(ws,row['machine_result_id'],row['case_id'])).fetchone()
            if machine is None or machine['state']=='quarantined':raise Conflict('Derived Issue source receipt is unavailable')
            self._source_assets(con,scope,ws,row['experiment_id'],machine['run_id'])
            slot=self._slot(con,ws,row['experiment_id'],row['result_id'])
            if current and slot['selected_result_id']!=row['machine_result_id']:raise Conflict('Derived Issue selection has changed')
            _,plan=self._plan(con,ws,row['experiment_id'],machine['run_id'])
            manifests=self._source_routes(plan,row['case_id'])
            for manifest in manifests:self._source_route(con,scope,ws,manifest);routes.append(manifest)
            selection=con.execute('SELECT selection_revision,result_id FROM result_selections WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(ws,machine['run_id'],row['case_id'],machine['evaluator_slot'])).fetchone()
            if current and (selection is None or selection['result_id']!=row['machine_result_id']):raise Conflict('Derived Issue machine selection has changed')
            rows.append((row,dict(machine),dict(selection) if selection else None))
        return rows,routes

    def _resolve_derived_issues(self,token,ws,body):
        if 'resolved_run_id' not in body:raise ValueError('Explicit nullable resolution context required')
        ids=body.get('issue_ids');run=None if body['resolved_run_id'] is None else identifier(body['resolved_run_id'])
        if not isinstance(ids,list) or not 1<=len(ids)<=MAX_ITEMS or any(not isinstance(value,str) for value in ids) or len(set(ids))!=len(ids):raise ValueError('Bounded unique derived Issue identities required')
        ids=sorted(identifier(value) for value in ids)
        if not callable(self.frozen_assets_verifier) or self.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Trusted Issue resolution verification required')
        with self.control.transaction() as con:
            scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,'write');self.iam._workspace(scope,ws,'read')
            key,digest,old=self._receipt(con,scope,ws,'derived_issue_resolve',body)
            reference=run if run is not None else 'resolution-operation:'+_hash([ws,scope.principal_id,key])
            rows,routes=self._resolution_sources(con,token,ws,scope,ids,current=old is None);fingerprint=scope.fingerprint
            if old:
                result=self._load(old['response_hash'],old['response_ref'],MAX_BYTES)
                if result.get('resolved_ids')!=ids or result.get('resolved_run_id')!=run:raise Conflict('Issue resolution receipt has another source')
            else:
                fresh=[entry for entry in rows if con.execute('SELECT 1 FROM experiment_derived_issue_annotations WHERE workspace_id=? AND issue_id=? LIMIT 1',(ws,entry[0]['annotation_id'])).fetchone() is None];now=self.control.clock()
                result={'resolved_ids':ids,'newly_resolved':len(fresh),'resolved_run_id':run};response_hash,response_ref=self._put(result,MAX_BYTES)
                con.execute('INSERT INTO experiment_operation_receipts VALUES(?,?,?,?,?,?,?,?,?)',(ws,scope.principal_id,'derived_issue_resolve',key,digest,rows[0][0]['experiment_id'],response_hash,response_ref,now))
                for row,machine,selection in fresh:
                    con.execute('INSERT INTO experiment_derived_issue_annotations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(ws,_id(),row['experiment_id'],row['annotation_id'],row['machine_result_id'],scope.principal_id,scope.principal_id,reference,now,'derived_issue_resolve',key,digest,row['payload_hash'],machine['content_hash'],selection['selection_revision']))
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token)
            if current.fingerprint!=fingerprint:raise Forbidden('Issue resolution authorization changed')
            self._resolution_sources(con,token,ws,current,ids,current=False)
        return result

    def _pending_cancellations(self,token,ws,body):
        limit=body.get('limit',100)
        if type(limit) is not int or not 1<=limit<=100:raise ValueError('Pending cancellation limit must be 1..100')
        with self.control.read_transaction() as con:
            scope=self.iam._scope(con,token);grant=self.iam._workspace(scope,ws,'read');params=[ws];where="a.workspace_id=? AND a.kind='cancellation'"
            if grant.role not in {'owner','admin','personal'}:
                where+=" AND (r.owner_principal_id=? OR r.visibility='group' OR EXISTS(SELECT 1 FROM iam_resource_grants g WHERE g.workspace_id=r.workspace_id AND g.resource_kind=r.resource_kind AND g.resource_id=r.resource_id AND g.grantee_principal_id=?))";params.extend([scope.principal_id,scope.principal_id])
            if body.get('owned_only') is True:where+=' AND r.owner_principal_id=?';params.append(scope.principal_id)
            params.append(MAX_ITEMS+1)
            rows=con.execute("SELECT a.experiment_id FROM experiment_annotations a JOIN iam_resource_access r ON r.workspace_id=a.workspace_id AND r.resource_kind='run' AND r.resource_id=a.experiment_id WHERE "+where+' ORDER BY a.created_at_ms DESC,a.annotation_id DESC LIMIT ?',tuple(params)).fetchall()
            if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Pending cancellation scan exceeds budget')
            result=[];seen=set();size=0
            for row in rows:
                exp=row['experiment_id']
                if exp in seen:continue
                seen.add(exp);self._head(con,token,ws,exp,'read',deleted=True)
                for record in self._cancellations_tx(con,ws,exp,self._annotations(con,ws,exp)):
                    if record['status']!='pending':continue
                    size+=len(_json(record).encode())
                    if size>MAX_BYTES:raise ExperimentTooLarge('Pending cancellation response exceeds budget')
                    result.append(record)
            result.sort(key=lambda value:(value['updatedAt'],value['id']),reverse=body.get('oldest_first') is not True);result=result[:limit];fingerprint=scope.fingerprint
        with self.control.read_transaction() as con:
            current=self.iam._scope(con,token);self.iam._workspace(current,ws,'read')
            if current.fingerprint!=fingerprint:raise Forbidden('Cancellation authorization changed during read')
            for row in result:self._head(con,token,ws,row['experimentId'],'read',deleted=True)
        return result

    def _case_upsert_many(self,con,token,ws,body,scope):
        head=self._head(con,token,ws,body['experiment_id'],'write');self._check_revision(head,body.get('expected_revision'));cases=body.get('cases')
        if not isinstance(cases,list) or not cases or len(cases)>MAX_CASES:raise ValueError('Atomic Case batch must contain 1..MAX_CASES records')
        metadata=self._load(head['metadata_hash'],head['metadata_ref']);groups={group.get('id') for group in metadata.get('groups',[])}
        if any(not isinstance(value,dict) or value.get('groupId') is not None and value.get('groupId') not in groups for value in cases):raise ValueError('Every Case group must belong to the Experiment')
        identities=[];skipped=[];changed=False
        for raw in cases:
            value=copy.deepcopy(raw);value.setdefault('id',_id());existed=con.execute('SELECT * FROM experiment_cases WHERE workspace_id=? AND case_id=?',(ws,value['id'])).fetchone()
            if existed and existed['experiment_id']!=head['experiment_id']:raise Conflict('Case ID belongs to another Experiment')
            if existed and existed['state']=='deleted':
                if body.get('skip_deleted') is True:skipped.append(value['id']);continue
                raise Conflict('Deleted Case ID cannot be reused')
            count=con.execute('SELECT COUNT(*) FROM experiment_cases WHERE workspace_id=? AND experiment_id=?',(ws,head['experiment_id'])).fetchone()[0]
            identity=self._case_write(con,token,ws,head['experiment_id'],value,count,only_if_new=True);reused=bool(existed or identity!=value['id']);identities.append(identity)
            if reused:
                old=self._case(con,ws,head['experiment_id'],identity);before=self._load(old['payload_hash'],old['payload_ref']);delta={k:v for k,v in value.items() if k not in {'id','user','createdAt','deletedAt','results','traceAttempts','executionSnapshot'} and before.get(k)!=v}
                if delta:
                    active=con.execute("SELECT 1 FROM experiment_result_slots s JOIN work_items w ON w.workspace_id=s.workspace_id AND w.work_item_id=s.work_item_id WHERE s.workspace_id=? AND s.case_id=? AND w.status IN ('queued','running') LIMIT 1",(ws,identity)).fetchone()
                    if active:raise Conflict('Atomic pairing cannot replace inputs of an active Case')
                    self._case_write(con,token,ws,head['experiment_id'],value|{'id':identity},old['ordinal']);changed=True
            else:changed=True
            total=con.execute('SELECT COUNT(*) FROM experiment_cases WHERE workspace_id=? AND experiment_id=?',(ws,head['experiment_id'])).fetchone()[0]
            if total>MAX_CASES:raise ExperimentTooLarge('Atomic Case batch exceeds Experiment Case budget')
        if changed:self._bump(con,ws,head['experiment_id'])
        result=self._snapshot(con,ws,self._head(con,token,ws,head['experiment_id']));result['case_ids']=identities;result['skipped_deleted_ids']=skipped;return result
