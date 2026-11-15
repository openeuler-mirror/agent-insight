"""Immutable DiagnosisRun bindings; plans, leases and reports reuse the core ledger."""
import copy
import hashlib
import json
import re
import uuid

from .contracts import identifier, revision
from .control import Conflict, StorageError
from .experiments import ExperimentStore, _hash, _iso, _json
from .iam import IAMStore, Forbidden
from .trace_evidence import EvidenceTooLarge, EvidenceUnavailable, _size

MAX_BYTES=16*1024*1024
MAX_PROGRESS=1024*1024
GENERATOR='agent-debug-diagnosis-skill@0.6:evaluation-input-v1'
SLOT='diagnosis'


def _parse(value,fallback):
    if not isinstance(value,str):return fallback if value is None else value
    try:return json.loads(value)
    except ValueError:return value


class DiagnosisRuns:
    def __init__(self,control,experiments=None,evidence=None,trace_reports=None,frozen_assets_verifier=None):
        self.control=control;self.iam=IAMStore(control);self.experiments=experiments or ExperimentStore(control,evidence)
        self.evidence=evidence or self.experiments.evidence;self.trace_reports=trace_reports;self.frozen_assets_verifier=frozen_assets_verifier

    def _put(self,value,limit=MAX_BYTES):return self.experiments._put(value,limit)
    def _load(self,digest,ref,limit=MAX_BYTES):return self.experiments._load(digest,ref,limit)

    def _scope(self,con,token,ws,capability='read'):
        scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,capability);return scope

    def _row(self,con,token,ws,identity,owner=False):
        scope=self._scope(con,token,ws)
        row=con.execute('SELECT * FROM diagnosis_runs WHERE workspace_id=? AND diagnosis_id=?',(ws,identifier(identity))).fetchone()
        if row is None:raise LookupError('DiagnosisRun not found')
        self.iam._authorize(con,token,ws,'read','run',identity)
        if owner and row['actor_principal_id']!=scope.principal_id:raise Forbidden('Private diagnosis requires its original actor')
        return dict(row),scope

    def _case_snapshot_tx(self,con,ws,head,case,slots,receipts):
        metadata=self._load(head['metadata_hash'],head['metadata_ref']);metadata.update(id=head['experiment_id'],name=head['name'])
        dto=self._load(case['payload_hash'],case['payload_ref']);dto['id']=case['case_id'];dto['results']=[];dto['traceAttempts']=[]
        for slot,receipt in zip(slots,receipts):
            machine=self._load(receipt['content_hash'],receipt['artifact_ref'])['result']
            result={key:None for key in ('verdict','score','summary','humanScore','humanReason','humanBy','humanAt','pointsJson','evidenceJson')}
            result.update(copy.deepcopy(machine));result.update(id=slot['result_id'],evaluatorId=slot['evaluator_id'],status=slot['status'],updatedAt=_iso(slot['updated_at_ms']))
            if 'points' in machine:result['pointsJson']=_json(machine['points'])
            if 'evidence' in machine:result['evidenceJson']=_json(machine['evidence'])
            if slot.get('review_id'):
                review=con.execute('SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND machine_result_id=?',(ws,slot['review_id'],receipt['result_id'])).fetchone()
                if review is None:raise Conflict('Selected human review no longer matches the machine result')
                result.update(self._load(review['payload_hash'],review['payload_ref']))
            dto['results'].append(result)
        cps=con.execute('SELECT c.*,a.attempt_no,a.started_at_ms,a.finished_at_ms,a.status AS attempt_status FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.case_id=? ORDER BY a.started_at_ms,a.attempt_no,c.attempt_id',(ws,case['case_id'])).fetchall()
        for cp in cps:
            payload=self._load(cp['payload_hash'],cp['payload_ref'])
            if payload.get('phase')!='execute':continue
            progress=payload.get('checkpoint',{})
            dto['traceAttempts'].append({'id':cp['attempt_id'],'attemptNo':cp['attempt_no'],'traceId':cp['trace_id'],'status':progress.get('status',cp['attempt_status']),'finishedAt':_iso(cp['finished_at_ms']) if cp['finished_at_ms'] is not None else None})
        _size(dto,MAX_BYTES);return metadata,dto

    def _source_tx(self,con,token,ws,source):
        scope=self._scope(con,token,ws)
        kind=source.get('source_kind','experiment')
        if kind=='experiment':
            exp=identifier(source.get('experiment_id'));case_id=identifier(source.get('case_id'))
            head=self.experiments._head(con,token,ws,exp)
            if head['created_by']!=scope.principal_id:raise Forbidden('Diagnosis gold requires the experiment owner')
            case=self.experiments._case(con,ws,exp,case_id)
            ids=source.get('result_ids')
            if not isinstance(ids,list) or not 1<=len(ids)<=30:raise ValueError('Select 1..30 completed results')
            ids=sorted(set(identifier(v) for v in ids));slots=[];receipts=[];plans=[]
            for identity in ids:
                slot=self.experiments._slot(con,ws,exp,identity)
                if slot['case_id']!=case_id or slot['status']!='done' or not slot['selected_result_id']:raise Conflict('Only current completed Case results may be diagnosed')
                receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,slot['selected_result_id'])).fetchone()
                if receipt is None or receipt['state']=='quarantined':raise Conflict('Selected machine result is unavailable')
                run=con.execute('SELECT * FROM runs WHERE workspace_id=? AND run_id=?',(ws,receipt['run_id'])).fetchone()
                if run is None:raise Conflict('Selected RunPlan unavailable')
                self.experiments._source_assets(con,scope,ws,exp,run['run_id'])
                plan=self._load(run['plan_hash'],run['plan_manifest_ref'],MAX_BYTES)
                sealed=[dict(v) for v in con.execute('SELECT * FROM run_inputs WHERE workspace_id=? AND run_id=? ORDER BY slot',(ws,run['run_id']))]
                slots.append(slot);receipts.append(dict(receipt))
                if not any(p['run_id']==run['run_id'] for p in plans):plans.append({'run_id':run['run_id'],'plan_hash':run['plan_hash'],'inputs':sealed,'plan':plan})
                _size(plans,MAX_BYTES)
            metadata,case_dto=self._case_snapshot_tx(con,ws,head,case,slots,receipts)
            if case_dto is None or not (case_dto.get('executionId') or case_dto.get('taskId')):raise Conflict('Case requires a tested Trace')
            review_ids=[slot['review_id'] for slot in slots if slot.get('review_id')]
            reviews=[]
            for review_id in review_ids:
                review=con.execute('SELECT annotation_id,machine_result_id,payload_hash FROM experiment_annotations WHERE workspace_id=? AND experiment_id=? AND annotation_id=?',(ws,exp,review_id)).fetchone()
                if review is None:raise Conflict('Selected human review unavailable')
                reviews.append(dict(review))
            vector={'head':{k:head[k] for k in ('experiment_id','lifecycle_revision','created_by')},'definition':{k:metadata.get(k) for k in ('name','configSnapshotJson','evaluatorConfigsJson','evaluatorIdsJson')},'case':{k:case[k] for k in ('experiment_id','case_id','payload_hash','lifecycle_revision','trace_id')},'slots':[{k:slot[k] for k in ('result_id','evaluator_id','selected_result_id','review_id')} for slot in slots],'reviews':reviews,'receipts':[{k:r[k] for k in ('result_id','run_id','content_hash')} for r in receipts], 'plans':[{'run_id':p['run_id'],'plan_hash':p['plan_hash'],'inputs':p['inputs']} for p in plans]}
            selected=[v for v in case_dto['results'] if v['id'] in ids]
            if len(selected)!=len(ids):raise Conflict('Completed results unavailable')
            return {'kind':kind,'scope':scope.fingerprint,'vector':vector,'experiment':metadata,'case':case_dto,'results':selected,'plans':plans,'trace_args':{'task_id':case_dto.get('taskId'),'execution_id':case_dto.get('executionId')}}
        if kind!='trace-report' or self.trace_reports is None:raise ValueError('Unsupported diagnosis source')
        ref=source.get('trace_id') or source.get('execution_id');_,route=self.trace_reports._trace(con,token,ws,ref)
        access=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(ws,route['trace_id'])).fetchone()
        if not access or access[0]!=scope.principal_id:raise Forbidden('Trace report freeze requires its owner')
        row=self.trace_reports._row(con,ws,route['trace_id'],'agent-debug')
        if row is None or row['status']!='done':raise Conflict('A completed current AgentDebug report is required')
        report=self.trace_reports._load(row['payload_ref'],8*1024*1024,row['payload_hash'])
        if report.get('generatedAt')!=source.get('generated_at'):raise Conflict('Trace report changed; refresh before freezing')
        return {'kind':kind,'scope':scope.fingerprint,'vector':{'report':{k:row[k] for k in ('report_id','revision','payload_hash','evidence_hash','interactions_hash','generator')},'route':route},'report':report,'trace_args':{'trace_ref':route['trace_id']}}

    @staticmethod
    def _config(body):
        skills=body.get('frozen_skills',[]);model=body.get('model_selection')
        if not isinstance(skills,list) or len(skills)>1000 or model is not None and not isinstance(model,dict):raise ValueError('Invalid sealed diagnosis assets')
        def secrets(value):
            if isinstance(value,dict):
                for k,v in value.items():
                    if str(k).lower().replace('_','') in {'apikey','authorization','password','token','accesstoken','secret','credential'}:raise ValueError('Credentials cannot enter a DiagnosisRun')
                    secrets(v)
            elif isinstance(value,list):
                for item in value:secrets(item)
        secrets(skills);secrets(model)
        config={'frozen_skills':copy.deepcopy(skills),'model_selection':copy.deepcopy(model)}
        if body.get('retry_of_run_id') is not None:config['retry_of_run_id']=identifier(body['retry_of_run_id'])
        _size(config,MAX_BYTES);return config

    @staticmethod
    def _skills(execution,catalog):
        invoked=_parse(execution.get('invokedSkills'),[])
        if not isinstance(invoked,list):invoked=[]
        result=[]
        for item in invoked:
            if not isinstance(item,dict) or not isinstance(item.get('name'),str) or any(v['name']==item['name'] for v in result):continue
            version=item.get('version') if type(item.get('version')) is int else None
            baseline=next((v for skill in catalog if skill.get('name')==item['name'] for v in skill.get('versions',[]) if v.get('version')==version),None) if version is not None else None
            files=baseline.get('files') if baseline else None
            if files is not None and (not isinstance(files,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in files.items())):raise ValueError('Invalid frozen Skill files')
            digest=_hash(files) if files is not None else None
            if baseline and baseline.get('contentHash') is not None:
                if not isinstance(baseline['contentHash'],str) or not re.fullmatch('[0-9a-f]{64}',baseline['contentHash']):raise ValueError('Invalid controller-attested Skill hash')
                digest=baseline['contentHash']
            result.append({'name':item['name'],'version':version,'files':files,'contentHash':digest})
        return result

    def _prepare(self,token,ws,body,*,trusted=False):
        if not trusted and (not callable(self.frozen_assets_verifier) or self.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True):raise Forbidden('Trusted frozen Skill/model verification is required')
        config=self._config(body)
        with self.control.read_transaction() as con:
            before=self._source_tx(con,token,ws,body)
            if config.get('retry_of_run_id'):
                previous,_=self._row(con,token,ws,config['retry_of_run_id'],True)
                if previous['experiment_id']!=body.get('experiment_id') or previous['case_id']!=body.get('case_id'):raise Conflict('Diagnosis retry belongs to a different source')
        if self.evidence is None:raise EvidenceUnavailable('TraceEvidence is required')
        evidence=self.evidence.read(token,ws,**before['trace_args']);execution=evidence['execution'];interactions=evidence['session']['interactions']
        if not interactions:raise Conflict('Trace has no diagnosable trajectory')
        skills=self._skills(execution,config['frozen_skills']);generator=body.get('generator',GENERATOR)
        if not isinstance(generator,str) or not 1<=len(generator)<=300:raise ValueError('Invalid generator')
        if before['kind']=='experiment':
            exp=before['experiment'];case=before['case'];attempts=case.get('traceAttempts',[])
            attempt=attempts[-1] if attempts else None
            if attempt and (attempt['traceId'] not in {execution['id'],execution.get('taskId'),evidence['manifest']['trace_id']} or attempt['status']!='ready'):raise Conflict('Current Case and execution attempt differ')
            if attempt and any(r['updatedAt']<attempt['finishedAt'] for r in before['results'] if attempt.get('finishedAt')):raise Conflict('Evaluation predates the current execution')
            results=[]
            for row in before['results']:
                result={k:row.get(k) for k in ('id','evaluatorId','status','verdict','score','summary','humanScore','humanReason','humanBy','humanAt','updatedAt')}
                result.update(points=_parse(row.get('pointsJson'),row.get('points')),evidence=_parse(row.get('evidenceJson'),row.get('evidence')));results.append(result)
            snapshot={'schemaVersion':1,'experiment':{'id':exp['id'],'name':exp['name'],'config':_parse(exp.get('configSnapshotJson'),{}),'evaluatorConfigs':_parse(exp.get('evaluatorConfigsJson'),{}),'evaluatorIds':_parse(exp.get('evaluatorIdsJson'),[])},'case':{k:case.get(k) for k in ('id','input','referenceOutput','actualOutput')},'attempt':{k:attempt[k] for k in ('id','attemptNo','traceId')} if attempt else None,'results':results}
            report=None
        else:
            report=before['report'];generator=before['vector']['report']['generator']
            if not skills or not report.get('findings'):raise Conflict('Trace report has no Skill invocation or findings')
            if before['vector']['report']['evidence_hash']!=evidence['snapshot_hash']:raise Conflict('Trace report source evidence changed')
            snapshot={'source':'trace-report','schemaVersion':1,'experiment':{'id':'','name':'','config':None,'evaluatorConfigs':None},'case':{'id':'','input':execution.get('query') or '','referenceOutput':None,'actualOutput':execution.get('finalResult') or ''},'attempt':None,'results':[]}
        snapshot.update(execution={k:execution.get(k) for k in ('id','taskId','user','framework','query','model','agentName')},skills=skills,interactions=interactions,traceHash=_hash(interactions));_size(snapshot,MAX_BYTES)
        with self.control.read_transaction() as con:
            after=self._source_tx(con,token,ws,body)
            if before['scope']!=after['scope']:raise Forbidden('Diagnosis authorization changed during source preparation')
            if before['vector']!=after['vector']:raise Conflict('Diagnosis source changed during preparation')
            self.experiments._verify_evidence(con,token,ws,evidence)
        binding={'source':{k:body[k] for k in ('source_kind','experiment_id','case_id','result_ids','trace_id','execution_id','generated_at') if k in body},'vector':before['vector'],'evidence':evidence,'config':config,'snapshot':snapshot,'generator':generator,'source_report':report,'plans':before.get('plans',[])}
        fingerprint=_hash({'vector':before['vector'],'trace':evidence['snapshot_hash'],'skills':skills})
        input_hash=_hash({'snapshot':snapshot,'source_fingerprint':fingerprint,'generator':generator,'model_selection':config['model_selection'],**({'report':report} if report is not None else {})})
        return binding,{'snapshot':snapshot,'input_hash':input_hash,'source_fingerprint':fingerprint,'generator':generator,'execution_id':execution['id'],'experiment_id':body.get('experiment_id'),'case_id':body.get('case_id')},before['scope']

    def _verify_tx(self,con,token,ws,row,plan):
        current=self._source_tx(con,token,ws,plan['source'])
        if current['vector']!=plan['vector']:raise Conflict('Diagnosis source changed; refresh before finishing or importing')
        self.experiments._verify_evidence(con,token,ws,plan['evidence'])
        return current

    def _plan(self,row):return self._load(row['snapshot_hash'],row['snapshot_ref'])

    @staticmethod
    def _fence(value):
        if isinstance(value,str) and re.fullmatch('[1-9][0-9]{0,18}',value):return revision(int(value))
        if type(value) is int and value<=2**53-1:return revision(value)
        raise ValueError('Diagnosis fence must be an exact positive decimal revision')

    def _active(self,con,token,ws,body,plan=None):
        row,scope=self._row(con,token,ws,body.get('diagnosis_id') or body.get('run_id'),True);fence=self._fence(body.get('fence'))
        attempt=con.execute('SELECT a.*,w.run_id,w.etag,w.status AS item_status,w.cancel_requested FROM work_attempts a JOIN work_items w ON w.workspace_id=a.workspace_id AND w.work_item_id=a.work_item_id WHERE a.workspace_id=? AND a.attempt_id=?',(ws,body.get('attempt_id'))).fetchone()
        if not attempt or attempt['run_id']!=row['diagnosis_id'] or attempt['fence']!=self._fence(body.get('fence')) or attempt['worker_id']!=body.get('lease_owner') or attempt['etag']!=fence or attempt['status']!='running' or attempt['item_status']!='running' or attempt['cancel_requested'] or attempt['lease_until_ms']<=self.control.clock():raise Conflict('Diagnosis lease is expired, cancelled or superseded')
        self._verify_tx(con,token,ws,row,plan or self._plan(row));return row,dict(attempt),scope

    def _handle(self,row,attempt):
        return {'diagnosis_id':row['diagnosis_id'],'run_id':row['diagnosis_id'],'attempt_id':attempt['attempt_id'],'fence':str(attempt['fence']),'lease_owner':attempt['worker_id'],'lease_until_ms':attempt['lease_until_ms']}

    def _progress(self,con,ws,identity):
        event=con.execute("SELECT payload_json FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type='diagnosis.progress.v1' ORDER BY aggregate_revision DESC LIMIT 1",(ws,identity)).fetchone()
        if not event:return None
        payload=json.loads(event[0]);return self._load(payload['hash'],payload['ref'],MAX_PROGRESS)

    def _append_progress(self,con,ws,identity,progress):
        if progress is None:return
        digest,ref=self._put(progress,MAX_PROGRESS);now=self.control.clock()
        seq=con.execute("SELECT COALESCE(MAX(aggregate_revision),0)+1 FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type='diagnosis.progress.v1'",(ws,identity)).fetchone()[0]
        con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'diagnosis.progress.v1',?,'sent',?,?)",(ws,str(uuid.uuid4()),identity,seq,_json({'hash':digest,'ref':ref}),now,now))

    @staticmethod
    def _source_models(plan):
        plans=plan.get('plans',[]);models={_json(v['plan'].get('config',{}).get('model_selection')):v['plan'].get('config',{}).get('model_selection') for v in plans}
        descriptors=[{k:p[k] for k in ('run_id','plan_hash','inputs')}|{'model_selection':p['plan'].get('config',{}).get('model_selection')} for p in plans]
        return {'source_runplans':descriptors,'source_model_selection':next(iter(models.values())) if len(models)==1 else None,'source_model_selection_consistent':len(models)<=1}

    def _view_tx(self,con,row,scope,metadata_only=False,source_routes=None):
        identity=row['diagnosis_id'];ws=row['workspace_id'];run=con.execute('SELECT * FROM runs WHERE workspace_id=? AND run_id=?',(ws,identity)).fetchone()
        value={'id':identity,'diagnosis_id':identity,'run_id':identity,'status':run['status'],'errorMessage':None,'createdAt':_iso(row['created_at_ms']),'completedAt':_iso(run['updated_at_ms']) if run['status'] in {'done','failed','cancelled'} else None,'input_hash':row['input_hash'],'source_fingerprint':row['source_fingerprint'],'generator':row['generator'],'experiment_id':row['experiment_id'],'case_id':row['case_id']}
        if row['actor_principal_id']!=scope.principal_id:return value|{'gold_redacted':True,'snapshot':None,'report':None,'progress':None,'execution_id':None}
        if metadata_only:value.update(metadata_only=True,snapshot=None,report=None,progress=None,execution_id=None)
        else:
            plan=self._plan(row);self.experiments._source_route(con,scope,ws,plan['evidence']['manifest'])
            for source in plan.get('plans',[]):self.experiments._source_assets(con,scope,ws,row['experiment_id'],source['run_id'])
            if source_routes is not None:source_routes.append(plan['evidence']['manifest'])
            value['retryOfRunId']=plan['config'].get('retry_of_run_id');value.update(self._source_models(plan));value.update(snapshot=plan['snapshot'],execution_id=plan['snapshot']['execution']['id'],report=None,progress=self._progress(con,ws,identity))
            receipt=con.execute('SELECT r.* FROM result_selections s JOIN result_receipts r ON r.workspace_id=s.workspace_id AND r.result_id=s.result_id WHERE s.workspace_id=? AND s.run_id=? AND s.evaluator_slot=?',(ws,identity,SLOT)).fetchone()
            if receipt:
                if receipt['state']=='quarantined':raise Conflict('Diagnosis report is quarantined')
                packet=self._load(receipt['content_hash'],receipt['artifact_ref']);value.update(report=packet.get('report'),errorMessage=packet.get('error_message'))
        if run['status']=='running':
            active=con.execute("SELECT lease_until_ms FROM work_attempts a JOIN work_items w ON w.workspace_id=a.workspace_id AND w.work_item_id=a.work_item_id WHERE w.workspace_id=? AND w.run_id=? AND a.status='running' ORDER BY attempt_no DESC LIMIT 1",(ws,identity)).fetchone()
            if active and active['lease_until_ms']<=self.control.clock():value.update(status='failed',errorMessage='后台任务已中断，请重新诊断。')
        elif run['status']=='queued' and row['created_at_ms']+90000<self.control.clock():value.update(status='failed',errorMessage='后台任务未启动，请重新诊断。')
        return value

    def _read(self,token,ws,identity,metadata_only=False):
        with self.control.read_transaction() as con:
            row,scope=self._row(con,token,ws,identity);source_routes=[];result=self._view_tx(con,row,scope,metadata_only,source_routes);fingerprint=scope.fingerprint
        with self.control.read_transaction() as con:
            after,current=self._row(con,token,ws,identity)
            if after!=row or current.fingerprint!=fingerprint:raise Forbidden('Diagnosis authorization changed while reading')
            for manifest in source_routes:self.experiments._source_route(con,current,ws,manifest)
            if source_routes:
                plan=self._plan(row)
                for source in plan.get('plans',[]):self.experiments._source_assets(con,current,ws,row['experiment_id'],source['run_id'])
        return result

    def dispatch(self,action,token,workspace_id,body=None):
        body=copy.deepcopy(body or {});ws=identifier(workspace_id)
        if action=='lookup_submission':
            key=identifier(body.get('request_key'))
            expected=body.get('expected_input_hash')
            if not isinstance(expected,str) or len(expected)!=64:raise ValueError('Diagnosis input hash required')
            with self.control.read_transaction() as con:
                scope=self._scope(con,token,ws,'write');self.iam._workspace(scope,ws,'read')
                row=con.execute('SELECT * FROM diagnosis_runs WHERE workspace_id=? AND actor_principal_id=? AND request_key=?',(ws,scope.principal_id,key)).fetchone()
                if row is None:return {'found':False}
                row=dict(row);self._row(con,token,ws,row['diagnosis_id'],True)
                if row['input_hash']!=expected:raise Conflict('Diagnosis request key has another input')
                plan=self._plan(row)
                keys=('experiment_id','case_id','result_ids','trace_id','execution_id','generated_at')
                supplied={k:body[k] for k in keys if k in body};source={k:plan['source'][k] for k in keys if k in plan['source']}
                if body.get('source_kind','experiment')!=plan['source'].get('source_kind','experiment') or _hash(supplied)!=_hash(source) or body.get('retry_of_run_id')!=plan['config'].get('retry_of_run_id'):raise Conflict('Diagnosis request key has another source')
                identity=row['diagnosis_id']
            return {'found':True,'result':self._read(token,ws,identity)}
        if action in {'preview','submit'}:
            if action=='submit':
                key=identifier(body.get('request_key'));expected=body.get('expected_input_hash')
                with self.control.read_transaction() as con:
                    scope=self._scope(con,token,ws,'write');self.iam._workspace(scope,ws,'read')
                    old=con.execute('SELECT * FROM diagnosis_runs WHERE workspace_id=? AND actor_principal_id=? AND request_key=?',(ws,scope.principal_id,key)).fetchone()
                    if old:
                        old=dict(old);self._row(con,token,ws,old['diagnosis_id'],True)
                        if old['input_hash']!=expected:raise Conflict('Diagnosis request key has another input')
                        plan=self._plan(old)
                        supplied={k:body[k] for k in ('source_kind','experiment_id','case_id','result_ids','trace_id','execution_id','generated_at') if k in body}
                        if _hash(supplied)!=_hash(plan['source']) or _hash(self._config(body))!=_hash(plan['config']):raise Conflict('Diagnosis request key has another source or frozen configuration')
                        return self._read(token,ws,old['diagnosis_id'])
            plan,preview,prepared_scope=self._prepare(token,ws,body)
            if action=='preview':return preview
            if expected!=preview['input_hash']:raise Conflict('Diagnosis input changed; refresh preview')
            digest,ref=self._put(plan);identity=str(uuid.uuid4());now=self.control.clock()
            with self.control.transaction() as con:
                scope=self._scope(con,token,ws,'write');self.iam._workspace(scope,ws,'execute')
                if scope.fingerprint!=prepared_scope:raise Forbidden('Diagnosis authorization changed before submission')
                old=con.execute('SELECT * FROM diagnosis_runs WHERE workspace_id=? AND actor_principal_id=? AND request_key=?',(ws,scope.principal_id,key)).fetchone()
                if old:
                    if old['input_hash']!=expected:raise Conflict('Diagnosis request key has another input')
                    identity=old['diagnosis_id']
                else:
                    self._verify_tx(con,token,ws,{},plan)
                    con.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,1,'queued',?,?)",(ws,identity,'DiagnosisRun',digest,ref,now,now))
                    con.execute('INSERT INTO diagnosis_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(ws,identity,scope.principal_id,key,body.get('source_kind','experiment'),body.get('experiment_id'),body.get('case_id'),plan['evidence']['manifest']['trace_id'],preview['source_fingerprint'],expected,preview['generator'],digest,ref,now))
                    self.iam._record_resource(con,ws,'run',identity,scope.principal_id,'private',invalidate_policy=False)
                    item=str(uuid.uuid4())
                    con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'evaluate',?,'queued',?,?)",(ws,item,identity,body.get('case_id') or plan['snapshot']['execution']['id'],SLOT,now,now))
                    if plan['source_report'] is not None:
                        attempt_id=str(uuid.uuid4());worker='trace-report-freeze'
                        con.execute("UPDATE work_items SET status='running',etag=2 WHERE workspace_id=? AND work_item_id=?",(ws,item))
                        con.execute("INSERT INTO work_attempts(workspace_id,attempt_id,work_item_id,attempt_no,fence,worker_id,status,lease_until_ms,started_at_ms) VALUES(?,?,?,1,2,?,'running',?,?)",(ws,attempt_id,item,worker,now+30000,now))
                        packet={'report':plan['source_report'],'error_message':None,'progress':None,'status':'done'};rdigest,rref=self._put(packet)
                        row=dict(con.execute('SELECT * FROM diagnosis_runs WHERE workspace_id=? AND diagnosis_id=?',(ws,identity)).fetchone())
                        self._terminal_tx(con,row,scope,{'attempt_id':attempt_id,'work_item_id':item,'fence':2},'trace-report-freeze',rdigest,rref,packet)
            return self._read(token,ws,identity)
        identity=body.get('diagnosis_id') or body.get('run_id') or body.get('id')
        if action=='read':return self._read(token,ws,identity)
        if action=='list':
            limit=body.get('limit',100)
            if type(limit) is not int or not 1<=limit<=2000:raise ValueError('Invalid DiagnosisRun list limit')
            with self.control.read_transaction() as con:
                scope=self._scope(con,token,ws);where='workspace_id=? AND actor_principal_id=?';params=[ws,scope.principal_id]
                for key in ('experiment_id','case_id','trace_id'):
                    if body.get(key) is not None:where+=' AND '+key+'=?';params.append(body[key])
                if body.get('after_id'):
                    cursor,_=self._row(con,token,ws,body['after_id'],True);where+=' AND (created_at_ms<? OR (created_at_ms=? AND diagnosis_id<?))';params.extend([cursor['created_at_ms'],cursor['created_at_ms'],cursor['diagnosis_id']])
                params.append(limit);rows=con.execute('SELECT diagnosis_id FROM diagnosis_runs WHERE '+where+' ORDER BY created_at_ms DESC,diagnosis_id DESC LIMIT ?',tuple(params)).fetchall();ids=[r['diagnosis_id'] for r in rows]
            return [self._read(token,ws,i,metadata_only=True) for i in ids]
        if action=='verify_source':
            with self.control.read_transaction() as con:
                row,_=self._row(con,token,ws,identity,True);plan=self._plan(row);self._verify_tx(con,token,ws,row,plan)
            current,preview,_=self._prepare(token,ws,plan['source']|plan['config']|{'generator':plan['generator']},trusted=True)
            if preview['source_fingerprint']!=row['source_fingerprint'] or preview['input_hash']!=row['input_hash']:raise Conflict('Diagnosis source changed')
            return {'valid':True,'input_hash':row['input_hash'],'source_fingerprint':row['source_fingerprint'],'snapshot':plan['snapshot'],**self._source_models(plan)}
        if action not in {'claim','load_work','renew','complete','fail','cancel'}:raise ValueError('Unsupported DiagnosisRun action')
        with self.control.transaction() as con:
            row,scope=self._row(con,token,ws,identity,True);self.iam._workspace(scope,ws,'write');plan=self._plan(row)
            if action!='cancel':self.iam._workspace(scope,ws,'execute')
            if action=='claim':
                self._verify_tx(con,token,ws,row,plan);worker=identifier(body.get('worker_id'));lease=self.experiments._lease(body);now=self.control.clock()
                item=con.execute("SELECT * FROM work_items WHERE workspace_id=? AND run_id=? AND evaluator_slot=? AND cancel_requested=0 AND (status='queued' OR (status='running' AND EXISTS(SELECT 1 FROM work_attempts a WHERE a.workspace_id=work_items.workspace_id AND a.work_item_id=work_items.work_item_id AND a.status='running' AND a.lease_until_ms<=?)))",(ws,identity,SLOT,now)).fetchone()
                if not item:return None
                con.execute("UPDATE work_attempts SET status='expired',finished_at_ms=? WHERE workspace_id=? AND work_item_id=? AND status='running'",(now,ws,item['work_item_id']))
                count=con.execute('SELECT COALESCE(MAX(attempt_no),0)+1 FROM work_attempts WHERE workspace_id=? AND work_item_id=?',(ws,item['work_item_id'])).fetchone()[0]
                attempt=str(uuid.uuid4());fence=revision(item['etag']+1)
                con.execute("UPDATE work_items SET status='running',etag=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(fence,now,ws,item['work_item_id']))
                con.execute("INSERT INTO work_attempts(workspace_id,attempt_id,work_item_id,attempt_no,fence,worker_id,status,lease_until_ms,started_at_ms) VALUES(?,?,?,?,?,?,'running',?,?)",(ws,attempt,item['work_item_id'],count,fence,worker,now+lease,now))
                con.execute("UPDATE runs SET status='running',etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND run_id=?",(now,ws,identity))
                return self._handle(row,{'attempt_id':attempt,'fence':fence,'worker_id':worker,'lease_until_ms':now+lease})
            if action=='cancel':
                now=self.control.clock();con.execute("UPDATE work_items SET status='cancelled',cancel_requested=1,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND run_id=? AND status IN ('queued','running')",(now,ws,identity))
                con.execute("UPDATE work_attempts SET status='cancelled',finished_at_ms=? WHERE workspace_id=? AND status='running' AND work_item_id IN (SELECT work_item_id FROM work_items WHERE workspace_id=? AND run_id=?)",(now,ws,ws,identity))
                con.execute("UPDATE runs SET status='cancelled',etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND run_id=? AND status IN ('queued','running')",(now,ws,identity));return self._view_tx(con,row,scope,metadata_only=True)
            if action in {'complete','fail'}:
                key=identifier(body.get('operation_key'));packet={'report':body.get('report') if action=='complete' else None,'error_message':body.get('error_message').replace(token,'[redacted]') if action=='fail' and isinstance(body.get('error_message'),str) else None,'progress':body.get('progress'),'status':'done' if action=='complete' else 'failed'}
                _size(packet,MAX_BYTES);digest,ref=self._put(packet)
                previous=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND attempt_id=? AND receipt_key=?',(ws,body.get('attempt_id'),key)).fetchone()
                if previous:
                    attempt=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND attempt_id=?',(ws,body.get('attempt_id'))).fetchone()
                    if previous['run_id']!=identity or previous['content_hash']!=digest or not attempt or attempt['fence']!=self._fence(body.get('fence')) or attempt['worker_id']!=body.get('lease_owner'):raise Conflict('Conflicting diagnosis terminal replay')
                    self._verify_tx(con,token,ws,row,plan);return self._view_tx(con,row,scope)
            row,attempt,scope=self._active(con,token,ws,body,plan)
            if action=='load_work':return {'handle':self._handle(row,attempt),'runplan':{'run_id':identity,'config':plan['config'],'source_fingerprint':row['source_fingerprint'],'source_runplans':self._source_models(plan)['source_runplans']},**self._source_models(plan),'snapshot':plan['snapshot'],'input_hash':row['input_hash'],'source_fingerprint':row['source_fingerprint']}
            if action=='renew':
                until=self.control.clock()+self.experiments._lease(body);con.execute('UPDATE work_attempts SET lease_until_ms=? WHERE workspace_id=? AND attempt_id=?',(until,ws,attempt['attempt_id']));self._append_progress(con,ws,identity,body.get('progress'));attempt['lease_until_ms']=until;return self._handle(row,attempt)
            return self._terminal_tx(con,row,scope,attempt,key,digest,ref,packet)

    def _terminal_tx(self,con,row,scope,attempt,key,digest,ref,packet):
        ws=row['workspace_id'];identity=row['diagnosis_id'];state=packet['status']
        now=self.control.clock();result_id=str(uuid.uuid4());receipt_id=str(uuid.uuid4())
        con.execute('INSERT INTO result_receipts(workspace_id,run_id,work_item_id,case_key,evaluator_slot,receipt_id,attempt_id,receipt_key,result_id,content_hash,artifact_ref,created_at_ms) SELECT workspace_id,run_id,work_item_id,case_key,evaluator_slot,?,?,?,?,?,?,? FROM work_items WHERE workspace_id=? AND work_item_id=?',(receipt_id,attempt['attempt_id'],key,result_id,digest,ref,now,ws,attempt['work_item_id']))
        case=con.execute('SELECT case_key FROM work_items WHERE workspace_id=? AND work_item_id=?',(ws,attempt['work_item_id'])).fetchone()[0]
        con.execute('INSERT INTO result_selections VALUES(?,?,?,?,?,1,?)',(ws,identity,case,SLOT,result_id,now))
        con.execute('UPDATE work_attempts SET status=?,finished_at_ms=? WHERE workspace_id=? AND attempt_id=?',(state,now,ws,attempt['attempt_id']))
        con.execute('UPDATE work_items SET status=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?',(state,now,ws,attempt['work_item_id']))
        con.execute('UPDATE runs SET status=?,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND run_id=?',(state,now,ws,identity))
        con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'diagnosis.result.accepted.v1',?,'sent',?,?)",(ws,str(uuid.uuid4()),attempt['attempt_id'],attempt['fence'],_json({'run_id':identity,'result_id':result_id,'content_hash':digest}),now,now))
        self._append_progress(con,ws,identity,packet.get('progress'));return self._view_tx(con,row,scope)

    def authorize_recording(self,token,workspace_id,handle):
        with self.control.read_transaction() as con:
            row,_,scope=self._active(con,token,workspace_id,handle)
            return {'owner_principal_id':scope.principal_id,'diagnosis_id':row['diagnosis_id']}

    def register_judge_trace_tx(self,con,token,workspace_id,handle,trace_id):
        row,attempt,scope=self._active(con,token,workspace_id,handle)
        access=con.execute("SELECT owner_principal_id,visibility FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace_id,trace_id)).fetchone()
        if not access or access['owner_principal_id']!=scope.principal_id or access['visibility']!='private':raise Forbidden('Diagnosis judge Trace must remain private to the original actor')
        old=con.execute('SELECT * FROM diagnosis_judge_traces WHERE workspace_id=? AND trace_id=?',(workspace_id,trace_id)).fetchone()
        if old:
            if old['diagnosis_id']!=row['diagnosis_id'] or old['attempt_id']!=attempt['attempt_id'] or old['owner_principal_id']!=scope.principal_id:raise Conflict('Diagnosis judge Trace has another immutable owner')
            return
        con.execute('INSERT INTO diagnosis_judge_traces VALUES(?,?,?,?,?,?)',(workspace_id,row['diagnosis_id'],attempt['attempt_id'],trace_id,scope.principal_id,self.control.clock()))
