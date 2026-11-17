import copy
import json
import math
import hashlib

from .contracts import identifier
from .control import Conflict
from .experiments import MAX_BYTES, MAX_ITEMS, ExperimentNotFound, ExperimentTooLarge, ExperimentUnavailable, _id, _iso, _json
from .iam import Forbidden

SCOPE='skill-trigger-analysis'
SLOT='__skill_trigger_live__'
DRAFT_SLOT='__skill_trigger_draft__'


class TriggerReadChanged(Conflict):
    code='TRIGGER_READ_CHANGED'


def _operation_hash(con,ws,owner,exp):
    row=con.execute("SELECT operation_key FROM experiment_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind='trigger_begin' AND experiment_id=?",(ws,owner,exp)).fetchone()
    return hashlib.sha256(row[0].encode()).hexdigest() if row else ''


def _cancelled(store,con,ws,exp):
    return store._cancellations_tx(con,ws,exp,store._annotations(con,ws,exp))


def _annotation(store,con,ws,scope,exp,value,kind,subject=None):
    digest,ref=store._put(value)
    con.execute('INSERT INTO experiment_annotations(workspace_id,experiment_id,annotation_id,kind,subject_id,actor_principal_id,payload_hash,payload_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)',(ws,exp,value['id'] if kind=='cancellation' else _id(),kind,subject,scope.principal_id,digest,ref,store.control.clock()))


def recovery_checkpoint(store,con,ws,work):
    prior=con.execute('SELECT c.payload_hash,c.payload_ref FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.work_item_id=? AND c.run_id=? ORDER BY a.attempt_no DESC LIMIT 1',(ws,work['work_item_id'],work['run_id'])).fetchone()
    checkpoint=store._load(prior['payload_hash'],prior['payload_ref']).get('checkpoint',{}) if prior else {}
    if '_flow_model_calls' in checkpoint:
        calls=checkpoint['_flow_model_calls']
        if not isinstance(calls,dict) or set(calls)-{'0'} or any(not isinstance(call,dict) or call.get('state')!='observed' or not isinstance(call.get('response'),dict) for call in calls.values()):return None
        return copy.deepcopy(checkpoint)
    samples=checkpoint.get('trigger_samples',{})
    if not isinstance(samples,dict) or samples and checkpoint.get('trigger_runtime_closed') is not True or any(not isinstance(sample,dict) or sample.get('state')!='observed' or not isinstance(sample.get('response'),dict) for sample in samples.values()):return None
    return copy.deepcopy(checkpoint)


def _trace_source(store,con,token,ws,scope,cp,task):
    alias=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='task' AND alias_id=?",(ws,identifier(task))).fetchone()
    if alias is None:raise Conflict('Trigger sample has no actual Trace')
    trace=alias[0]
    store.iam._authorize(con,token,ws,'read','trace',trace)
    route=con.execute("SELECT * FROM trace_locators WHERE workspace_id=? AND trace_id=? AND state='active'",(ws,trace)).fetchone()
    judge=con.execute('SELECT j.*,c.work_item_id FROM experiment_judge_traces j JOIN experiment_attempt_checkpoints c ON c.workspace_id=j.workspace_id AND c.attempt_id=j.attempt_id WHERE j.workspace_id=? AND j.trace_id=?',(ws,trace)).fetchone()
    if route is None or judge is None or judge['experiment_id']!=cp['experiment_id'] or judge['run_id']!=cp['run_id'] or judge['work_item_id']!=cp['work_item_id'] or judge['owner_principal_id']!=scope.principal_id:raise Conflict('Trigger sample belongs to another physical work item')
    from .agent_traces import NAMESPACE
    if route['source_namespace']!=NAMESPACE:raise Conflict('Trigger sample is not a trusted Agent recording')
    annotation=con.execute('SELECT extra_json FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(ws,trace)).fetchone()
    state=json.loads(annotation[0]).get('agent_record_v1',{}) if annotation else {}
    candidates=[op for op in state.get('operations',{}).values() if isinstance(op,dict) and op.get('submitted') and op.get('actor_id')==scope.principal_id and op.get('context',{}).get('experiment_id')==cp['experiment_id'] and op.get('context',{}).get('experiment_attempt_id')==judge['attempt_id']]
    if not candidates:raise Conflict('Trigger sample recording receipt unavailable')
    for op in candidates:
        refs=op.get('batch_refs')
        if not isinstance(refs,list) or not refs or len(refs)!=op.get('packet_count'):raise Conflict('Trigger sample recording batches differ')
        for ref in refs:
            row=con.execute('SELECT state,principal_id,trace_ids_json FROM ingest_batches WHERE workspace_id=? AND batch_id=?',(ws,ref.get('batch_id'))).fetchone()
            if row is None or row['state']!='indexed' or row['principal_id']!=scope.principal_id or json.loads(row['trace_ids_json'])!=[trace]:raise Conflict('Trigger sample is not fully indexed')
    return trace


def validate_result(store,con,token,ws,body,cp,result):
    if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private Trigger result attestation required')
    scope=store.iam._scope(con,token);_,plan=store._plan(con,ws,cp['experiment_id'],cp['run_id']);manifest=plan['config']['core_trigger'];params=manifest['params']
    samples=store._load(cp['payload_hash'],cp['payload_ref']).get('checkpoint',{}).get('trigger_samples')
    report=result.get('evidence',{}).get('json',{}).get('coreTriggerResult')
    if not isinstance(samples,dict) or not samples or not isinstance(report,dict) or store._load(cp['payload_hash'],cp['payload_ref']).get('checkpoint',{}).get('trigger_runtime_closed') is not True:raise Conflict('Trigger requires observed sample receipts and confirmed physical exit')
    checkpoint=store._load(cp['payload_hash'],cp['payload_ref']).get('checkpoint',{})
    if type(checkpoint.get('trigger_started_at_ms')) is not int or type(checkpoint.get('trigger_finished_at_ms')) is not int or result.get('durationMs')!=checkpoint['trigger_finished_at_ms']-checkpoint['trigger_started_at_ms']:raise Conflict('Trigger runtime duration differs from its confirmed physical interval')
    outcomes={};tasks=set();identities=set();orders=set()
    for key,sample in samples.items():
        try:i,r,a=map(int,key.split(':'))
        except (ValueError,AttributeError):raise Conflict('Trigger sample identity differs') from None
        if key!=f'{i}:{r}:{a}' or not 0<=i<len(manifest['trigger_set']['items']) or not 0<=r<params['runsPerQuery'] or not 0<=a<=params['maxTimeoutRetries'] or not isinstance(sample,dict) or sample.get('state')!='observed':raise Conflict('Trigger sample is not confirmed')
        value=sample.get('response')
        if not isinstance(value,dict) or type(value.get('triggered')) is not bool or value.get('endReason') not in {'triggered','completed','timeout','error'} or type(value.get('latencyMs')) not in (int,float) or value['latencyMs']<0 or not math.isfinite(value['latencyMs']):raise Conflict('Trigger sample outcome is invalid')
        if value.get('sessionId') in identities:raise Conflict('Trigger samples cannot share one physical Session')
        order=value.get('completionOrder')
        if type(order) is not int or order<0 or order in orders:raise Conflict('Trigger sample completion order differs')
        orders.add(order)
        _trace_source(store,con,token,ws,scope,cp,value.get('sessionId'));identities.add(value['sessionId']);tasks.add((i,r));outcomes.setdefault((i,r),{})[a]=value
    expected_tasks={(i,r) for i in range(len(manifest['trigger_set']['items'])) for r in range(params['runsPerQuery'])}
    if tasks!=expected_tasks:raise Conflict('Trigger sample coverage is incomplete')
    finals={}
    for task,attempts in outcomes.items():
        if set(attempts)!=set(range(len(attempts))) or any(attempts[index]['endReason']!='timeout' for index in range(len(attempts)-1)):raise Conflict('Trigger retry history differs')
        finals[task]=attempts[len(attempts)-1]
    if all(value.get('sessionError') for value in finals.values()):raise Conflict('Systemic Trigger errors cannot become a score')
    items=[]
    for i,item in enumerate(manifest['trigger_set']['items']):
        runs=sorted([finals[(i,r)] for r in range(params['runsPerQuery'])],key=lambda run:run['completionOrder']);total=len(runs);hits=sum(run['triggered'] for run in runs);rate=hits/total;comp={};errors={}
        for run in runs:
            if run.get('competingSkill'):comp[run['competingSkill']]=comp.get(run['competingSkill'],0)+1
            if run.get('sessionError'):errors[run['sessionError']]=errors.get(run['sessionError'],0)+1
        value={'itemId':item['id'],'query':item['query'],'shouldTrigger':item['shouldTrigger'],'runsTriggered':hits,'runsTotal':total,'triggerRate':rate,'pass':(rate>=params['triggerThreshold'])==item['shouldTrigger'],'latencyMsAvg':math.floor(sum(run['latencyMs'] for run in runs)/total+.5),'runsCompleted':sum(run['endReason'] in {'triggered','completed'} for run in runs),'runsTimedOut':sum(run['endReason']=='timeout' for run in runs),'runsErrored':sum(run['endReason']=='error' for run in runs),'sessionIds':[run['sessionId'] for run in runs]}
        if comp:value['competingSkill']=max(comp,key=comp.get)
        if errors:value['errorMessage']=max(errors,key=errors.get)
        items.append(value)
    positives=[item for item in items if item['shouldTrigger']];negatives=[item for item in items if not item['shouldTrigger']]
    expected={'items':items,'passRate':sum(item['pass'] for item in items)/len(items),'truePositiveRate':sum(item['triggerRate']>=params['triggerThreshold'] for item in positives)/len(positives) if positives else 0,'falsePositiveRate':sum(item['triggerRate']>=params['triggerThreshold'] for item in negatives)/len(negatives) if negatives else 0}
    if {key:report.get(key) for key in expected}!=expected or result.get('score')!=expected['passRate']*100:raise Conflict('Trigger aggregate differs from its observed samples')


def validate_checkpoint(store,con,token,ws,body,cp,previous,incoming):
    if '_flow_model_calls' in incoming:
        return validate_draft_checkpoint(store,con,token,ws,body,cp,previous,incoming)
    if not any(key in incoming for key in ('trigger_samples','trigger_started_at_ms','trigger_finished_at_ms','trigger_runtime_closed')):return
    if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private Trigger sample attestation required')
    samples=incoming.get('trigger_samples',previous.get('trigger_samples',{}));old=previous.get('trigger_samples',{})
    if not isinstance(samples,dict) or not isinstance(old,dict) or not set(old)<=set(samples):raise Conflict('Observed Trigger samples cannot be removed')
    _,plan=store._plan(con,ws,cp['experiment_id'],cp['run_id']);manifest=plan['config']['core_trigger'];params=manifest['params'];scope=store.iam._scope(con,token)
    for key,value in samples.items():
        try:i,r,a=map(int,key.split(':'))
        except (ValueError,AttributeError):raise Conflict('Trigger sample identity differs') from None
        if key!=f'{i}:{r}:{a}' or not 0<=i<len(manifest['trigger_set']['items']) or not 0<=r<params['runsPerQuery'] or not 0<=a<=params['maxTimeoutRetries'] or not isinstance(value,dict) or value.get('state') not in {'intent','observed'} or not isinstance(value.get('request_hash'),str) or len(value['request_hash'])!=64:raise Conflict('Trigger sample intent is invalid')
        prior=old.get(key)
        if prior and (prior.get('request_hash')!=value['request_hash'] or prior.get('state')=='observed' and prior!=value):raise Conflict('Observed Trigger sample is immutable')
        if value['state']=='observed':
            if prior is None:raise Conflict('Trigger observation requires its durable intent')
            response=value.get('response')
            if not isinstance(response,dict):raise Conflict('Trigger observation is unavailable')
            _trace_source(store,con,token,ws,scope,cp,response.get('sessionId'))
    if 'trigger_started_at_ms' in incoming:
        stamp=incoming['trigger_started_at_ms']
        if type(stamp) is not int or stamp<0 or previous.get('trigger_started_at_ms',stamp)!=stamp:raise Conflict('Trigger runtime start is immutable')
    if previous.get('trigger_runtime_closed') is True and incoming.get('trigger_samples',old)!=old:raise Conflict('A closed Trigger runtime cannot schedule another sample')
    if 'trigger_finished_at_ms' in incoming:
        stamp=incoming['trigger_finished_at_ms']
        if type(stamp) is not int or stamp<previous.get('trigger_started_at_ms',0) or previous.get('trigger_finished_at_ms',stamp)!=stamp:raise Conflict('Trigger runtime finish is immutable')
    if 'trigger_runtime_closed' in incoming and (incoming['trigger_runtime_closed'] is not True or 'trigger_finished_at_ms' not in incoming and 'trigger_finished_at_ms' not in previous):raise Conflict('Trigger runtime cleanup must include its confirmed finish')


def _cancel_action(store,action,token,ws,body):
    with store.control.transaction() as con:
        scope=store.iam._scope(con,token)
        for capability in (('read','delete') if action.startswith('trigger_delete_draft') else ('read','write')):store.iam._workspace(scope,ws,capability)
        head=_head(store,con,token,ws,scope,body.get('run_id'));exp=head['experiment_id'];records=_cancelled(store,con,ws,exp)
        current=records[-1] if records else None
        if action.startswith('trigger_delete_draft') and store._plan(con,ws,exp,head['current_run_id'])[1]['config']['core_trigger']['kind']!='draft':raise Forbidden('Set deletion cannot cancel Trigger Runs')
        if action in {'trigger_cancel','trigger_delete_draft'}:
            if current is None and head['status']=='running':
                rows=con.execute("SELECT c.*,a.status AS attempt_status FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.experiment_id=? ORDER BY a.attempt_no",(ws,exp)).fetchall()
                targets=[{'kind':'native-evaluate','workspace_id':ws,**{key:str(cp[key]) if key=='fence' else cp[key] for key in ('experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')},'confirmed':False} for cp in rows if cp['attempt_status'] in {'running','expired','cancelled'}]
                store._cancel_items(con,ws,exp);store._bump(con,ws,exp,status='cancelled');now=store.control.clock()
                current={'id':_id(),'experimentId':exp,'caseKey':'','revision':'1','status':'pending' if targets else 'completed','targetsJson':_json(targets),'createdAt':_iso(now),'updatedAt':_iso(now),'error':None}
                _annotation(store,con,ws,scope,exp,current,'cancellation',head['current_run_id'])
                head=_head(store,con,token,ws,scope,exp)
        else:
            if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private Trigger cleanup attestation required')
            if current is None or current['id']!=body.get('cancellation_id'):raise Conflict('Trigger cancellation source differs')
            proof=body.get('proof');targets=json.loads(current['targetsJson']);target=next((value for value in targets if isinstance(proof,dict) and value['attempt_id']==proof.get('attempt_id')),None)
            expected={key:target[key] for key in ('workspace_id','experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')}|{'transport':'native-worker','cleanup':'confirmed'} if target else None
            if proof!=expected or target is None:raise Conflict('Trigger physical cleanup identity differs')
            if not target['confirmed']:
                target['confirmed']=True;current=copy.deepcopy(current);current.update(revision=str(int(current['revision'])+1),targetsJson=_json(targets),status='completed' if all(value['confirmed'] for value in targets) else 'pending',updatedAt=_iso(store.control.clock()))
                _annotation(store,con,ws,scope,exp,current,'cancellation_update',current['id'])
        return {**({'draft':_draft(store,con,token,ws,scope,head)} if store._plan(con,ws,exp,head['current_run_id'])[1]['config']['core_trigger']['kind']=='draft' else {'run':_run(store,con,token,ws,scope,head)}),'operation_hash':_operation_hash(con,ws,scope.principal_id,exp),'cancellation_id':current['id'] if current else None,'targets':json.loads(current['targetsJson']) if current else []}


def _manifest(value):
    if not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1 or value.get('kind') not in {'run','draft'}:raise ValueError('Frozen Trigger manifest required')
    if 'legacy_owner' in value:identifier(value['legacy_owner'])
    skill=value.get('skill')
    if not isinstance(skill,dict) or not isinstance(skill.get('content'),str) or type(skill.get('version')) is not int or skill['version']<0:raise ValueError('Explicit frozen Skill version and content required')
    for key in ('id','name'):identifier(skill.get(key))
    params=value.get('params')
    if not isinstance(params,dict):raise ValueError('Frozen Trigger parameters required')
    for key,minimum,maximum in [('runsPerQuery',1,10),('timeoutMs',5000,300000),('concurrency',1,10),('maxTimeoutRetries',0,5)]:
        if type(params.get(key)) is not int or not minimum<=params[key]<=maximum:raise ValueError('Invalid Trigger '+key)
    threshold=params.get('triggerThreshold')
    if isinstance(threshold,bool) or not isinstance(threshold,(int,float)) or not math.isfinite(threshold) or not 0<=threshold<=1:raise ValueError('Invalid Trigger threshold')
    dataset=value.get('trigger_set')
    if not isinstance(dataset,dict) or type(dataset.get('version')) is not int or dataset['version']<1 or not isinstance(dataset.get('items'),list):raise ValueError('Frozen Trigger Set required')
    identifier(dataset.get('id'))
    if value['kind']=='run' and not dataset['items']:raise ValueError('Trigger Set has no items')
    identities=set()
    for item in dataset['items']:
        if not isinstance(item,dict) or not isinstance(item.get('query'),str) or not item['query'].strip() or type(item.get('shouldTrigger')) is not bool:raise ValueError('Invalid frozen Trigger item')
        identity=identifier(item.get('id'))
        if identity in identities:raise ValueError('Duplicate Trigger item identity')
        identities.add(identity)
    if not isinstance(value.get('siblings'),list) or not isinstance(value.get('history'),list):raise ValueError('Frozen Trigger Skills and history required')
    if value['kind']=='draft':
        placeholder=value.get('placeholder');source=value.get('draft_skill')
        if not isinstance(placeholder,dict) or placeholder.get('id')!=dataset['id'] or placeholder.get('version')!=dataset['version'] or placeholder.get('skillName')!=skill['name'] or placeholder.get('user')!=value.get('legacy_owner') or placeholder.get('status')!='drafting' or placeholder.get('items')!=[] or not isinstance(source,dict) or source.get('contentHash')!=hashlib.sha256(skill['content'].encode()).hexdigest()[:16] or any(not isinstance(source.get(key),str) for key in ('description','body')):raise ValueError('Frozen draft placeholder and Skill source required')
    return copy.deepcopy(value)


def _head(store,con,token,ws,scope,identity):
    head=store._head(con,token,ws,identifier(identity))
    if head['scope']!=SCOPE:raise ExperimentNotFound('Trigger Run not found')
    if head['created_by']!=scope.principal_id:raise Forbidden('Trigger Run must belong to its owner')
    return head


def _run(store,con,token,ws,scope,head):
    from .legacy_import_experiments import historical_trigger_run
    historical=historical_trigger_run(store,con,ws,scope,head)
    if historical is not None:return historical
    store._guard_sources(con,token,ws,head['experiment_id'])
    _,plan=store._plan(con,ws,head['experiment_id'],head['current_run_id'])
    manifest=plan.get('config',{}).get('core_trigger')
    if not isinstance(manifest,dict) or manifest.get('kind')!='run' or manifest!=json.loads(store._load(head['metadata_hash'],head['metadata_ref'])['configSnapshotJson']).get('coreTrigger'):raise Conflict('Trigger frozen source differs')
    slots=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND evaluator_id=?',(ws,head['experiment_id'],SLOT)).fetchall()
    if len(slots)!=1 or slots[0]['run_id']!=head['current_run_id']:raise Conflict('Trigger current work differs')
    slot=slots[0];report={};error=None;duration=None
    status='cancelled' if head['status']=='cancelled' or slot['status']=='cancelled' else 'failed' if slot['status']=='failed' else 'done' if slot['status']=='done' else 'running'
    if slot['selected_result_id']:
        receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,slot['selected_result_id'])).fetchone()
        if receipt is None or receipt['state']=='quarantined':raise ExperimentUnavailable('Trigger result unavailable')
        machine=store._load(receipt['content_hash'],receipt['artifact_ref'])['result'];report=machine.get('evidence',{}).get('json',{}).get('coreTriggerResult',{})
        duration=machine.get('durationMs');error=machine.get('errorMessage')
        if status=='done' and not isinstance(report.get('items'),list):raise ExperimentUnavailable('Trigger result packet unavailable')
        if status=='done':
            cp=con.execute('SELECT * FROM experiment_attempt_checkpoints WHERE workspace_id=? AND attempt_id=?',(ws,receipt['attempt_id'])).fetchone()
            if cp is None:raise ExperimentUnavailable('Trigger source attempt is unavailable')
            samples=store._load(cp['payload_hash'],cp['payload_ref']).get('checkpoint',{}).get('trigger_samples',{})
            if not isinstance(samples,dict) or not samples:raise ExperimentUnavailable('Trigger sample source is unavailable')
            for sample in samples.values():_trace_source(store,con,token,ws,scope,cp,sample.get('response',{}).get('sessionId'))
    skill=manifest['skill'];params=manifest['params']
    return {'id':head['experiment_id'],'user':manifest.get('legacy_owner') or store._owner(con,scope.principal_id),'skillName':skill['name'],'skillVersion':skill['version'],'triggerSetId':manifest['trigger_set']['id'],
            'results':report.get('items',[]),'passRate':report.get('passRate',0),'truePositiveRate':report.get('truePositiveRate',0),'falsePositiveRate':report.get('falsePositiveRate',0),
            'runsPerQuery':params['runsPerQuery'],'triggerThreshold':params['triggerThreshold'],'timeoutMs':params['timeoutMs'],'durationMs':duration,'modelId':manifest.get('modelId'),'workspaceRoot':manifest.get('workspaceRoot'),
            'status':status,'errorMessage':error or ('已手动终止' if status=='cancelled' else None),'createdAt':_iso(head['created_at_ms']),'updatedAt':_iso(head['updated_at_ms'])}


def dispatch_trigger(store,action,token,ws,body):
    if action in {'trigger_cancel','trigger_cleanup','trigger_delete_draft','trigger_delete_draft_cleanup'}:return _cancel_action(store,action,token,ws,body)
    if action=='trigger_scope':
        capabilities={'read':('read',),'save':('read','write'),'upload':('read','write'),'delete':('read','delete'),'cancel':('read','write'),'run':('read','write','execute'),'draft':('read','write','execute')}
        operation=body.get('operation')
        if operation not in capabilities:raise ValueError('Unsupported Trigger operation')
        with store.control.read_transaction() as con:
            scope=store.iam._scope(con,token)
            for capability in capabilities[operation]:store.iam._workspace(scope,ws,capability)
            return {'authorized':True,'operation':operation,'principal_id':scope.principal_id,'workspace_id':ws}
    if action in {'trigger_draft_read','trigger_draft_refs'}:return dispatch_draft_read(store,action,token,ws,body)
    if action in {'trigger_read','trigger_list'}:
        with store.control.read_transaction() as con:
            scope=store.iam._scope(con,token);store.iam._workspace(scope,ws,'read')
            if action=='trigger_read':
                head=_head(store,con,token,ws,scope,body.get('run_id'));heads=[head];result={'run':_run(store,con,token,ws,scope,head),'operation_hash':_operation_hash(con,ws,scope.principal_id,head['experiment_id'])}
            else:
                skill=identifier(body.get('skill_name'));limit=body.get('limit',50);version=body.get('skill_version')
                if type(limit) is not int or not 1<=limit<=200 or version is not None and (type(version) is not int or version<0):raise ValueError('Invalid Trigger history selection')
                rows=con.execute("SELECT * FROM experiment_heads WHERE workspace_id=? AND created_by=? AND scope=? AND skill_name=? AND state='active' ORDER BY created_at_ms DESC,experiment_id DESC LIMIT ?",(ws,scope.principal_id,SCOPE,skill,MAX_ITEMS+1)).fetchall()
                if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Trigger history exceeds budget')
                heads=[];runs=[]
                for raw in rows:
                    head=dict(raw);metadata=store._load(head['metadata_hash'],head['metadata_ref'])
                    if json.loads(metadata.get('configSnapshotJson') or '{}').get('coreTrigger',{}).get('kind')!='run':continue
                    if version is not None and metadata.get('skillVersion')!=version:continue
                    if body.get('latest_only') and head['status']!='done':continue
                    if body.get('running_only') and head['status']!='running':continue
                    heads.append(head);runs.append(_run(store,con,token,ws,scope,head))
                    if len(runs)>=(1 if body.get('latest_only') else limit):break
                result={'run':runs[0] if runs else None} if body.get('latest_only') else {'runs':runs}
            fingerprint=scope.fingerprint
        with store.control.read_transaction() as con:
            current=store.iam._scope(con,token);store.iam._workspace(current,ws,'read')
            if current.fingerprint!=fingerprint:raise Forbidden('Trigger authorization changed while reading')
            for old in heads:
                fresh=_head(store,con,token,ws,current,old['experiment_id'])
                if fresh['revision']!=old['revision'] or fresh['current_run_id']!=old['current_run_id']:raise TriggerReadChanged('Trigger changed while reading')
                store._guard_sources(con,token,ws,old['experiment_id'])
                _run(store,con,token,ws,current,fresh)
        return result
    if action!='trigger_begin':raise ValueError('Unsupported Trigger action')
    if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private frozen Trigger attestation required')
    value=_manifest(body.get('manifest'))
    expected_scope={'derived_skill_ids':[value['skill']['id']],'derived_skill_versions':{value['skill']['id']:[value['skill']['version']]}}
    if body.get('config')!=expected_scope:raise Forbidden('Attested Skill scope differs from the frozen Trigger manifest')
    with store.control.transaction() as con:
        scope=store.iam._scope(con,token)
        for capability in ('read','write','execute'):store.iam._workspace(scope,ws,capability)
        key,digest,old=store._receipt(con,scope,ws,action,body)
        if old:
            _head(store,con,token,ws,scope,old['experiment_id']);return store._load(old['response_hash'],old['response_ref'],MAX_BYTES)
        skill=value['skill'];active=con.execute("SELECT * FROM experiment_heads WHERE workspace_id=? AND created_by=? AND scope=? AND skill_name=? AND state='active' AND status IN ('running','cancelled','failed') LIMIT ?",(ws,scope.principal_id,SCOPE,skill['name'],MAX_ITEMS+1)).fetchall()
        if len(active)>MAX_ITEMS:raise ExperimentTooLarge('Trigger active Run budget exceeded')
        for head in active:
            prior=json.loads(store._load(head['metadata_hash'],head['metadata_ref']).get('configSnapshotJson') or '{}').get('coreTrigger',{})
            if prior.get('kind')!=value['kind']:continue
            if value['kind']=='run' and prior.get('skill',{}).get('version')!=skill['version']:continue
            if head['status']=='running':raise Conflict('该版本已有一次评测正在运行，等它结束再发起')
            records=_cancelled(store,con,ws,head['experiment_id'])
            unknown=con.execute("SELECT 1 FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id WHERE c.workspace_id=? AND c.experiment_id=? AND a.error_code='EVALUATION_CLEANUP_UNCONFIRMED' LIMIT 1",(ws,head['experiment_id'])).fetchone()
            if any(record['status']!='completed' for record in records) or unknown and not records:raise ExperimentUnavailable('Trigger physical cleanup is not confirmed')
        slot_id=SLOT if value['kind']=='run' else DRAFT_SLOT
        identity=_id();source={'id':identity,'name':'触发评测 · '+skill['name'],'scope':SCOPE,'type':'single','preset':'trigger' if value['kind']=='run' else 'trigger-draft','skillName':skill['name'],'skillVersion':skill['version'],'agentName':skill['name'],'evaluatorIdsJson':_json([slot_id]),'configSnapshotJson':_json({'coreTrigger':value}),'cases':[{'id':_id(),'input':'trigger evaluation','actualOutput':'','referenceOutput':None}]}
        created=store._create(con,token,ws,{'experiment':source},scope,private=True)
        request={'experiment_id':identity,'config':{'core_trigger':value,'model_selection':value.get('model_selection'),'derived_skill_ids':[skill['id']],'derived_skill_versions':{skill['id']:[skill['version']]},'experiment_skill_scope':{'skill_id':skill['id'],'skill_name':skill['name'],'version':skill['version'],'source':'trigger','preset':'trigger','scope':SCOPE}},'releases':body.get('releases',{}),'frozen_evaluators':{slot_id:{'origin':'core-trigger','version':1}}}
        if value['kind']=='draft':request['config'].pop('experiment_skill_scope')
        started=store._start(con,token,ws,request,scope,(created,{}),trusted_parent=True)
        head=_head(store,con,token,ws,scope,identity);result={**({'run':_run(store,con,token,ws,scope,head)} if value['kind']=='run' else {'set':copy.deepcopy(value['placeholder'])}),'experiment_id':identity,'run_id':started['run_id']}
        hashed,ref=store._put(result,MAX_BYTES);con.execute('INSERT INTO experiment_operation_receipts VALUES(?,?,?,?,?,?,?,?,?)',(ws,scope.principal_id,action,key,digest,identity,hashed,ref,store.control.clock()))
    return result


def guard_derived_sources(store,con,token,ws,scope,head,run):
    if head['scope']!=SCOPE:return
    if head['created_by']!=scope.principal_id:raise Forbidden('Trigger derived records require their owner')
    if head['current_run_id']!=run:raise Conflict('Trigger derived Run binding differs')
    _run(store,con,token,ws,scope,head)


def _resolve_previous(store,con,token,ws,scope,head,skill):
    rows=con.execute("SELECT a.* FROM experiment_annotations a JOIN experiment_heads h ON h.workspace_id=a.workspace_id AND h.experiment_id=a.experiment_id JOIN experiment_result_slots s ON s.workspace_id=a.workspace_id AND s.result_id=a.result_id JOIN experiment_cases c ON c.workspace_id=a.workspace_id AND c.case_id=a.case_id WHERE a.workspace_id=? AND a.kind='derived-issue' AND a.lookup_key=? AND a.actor_principal_id=? AND h.created_by=? AND h.state='active' AND c.state='active' AND s.selected_result_id=a.machine_result_id AND a.experiment_id<>? AND NOT EXISTS(SELECT 1 FROM experiment_derived_issue_annotations d WHERE d.workspace_id=a.workspace_id AND d.issue_id=a.annotation_id) ORDER BY a.annotation_id LIMIT ?",(ws,skill['id'],scope.principal_id,scope.principal_id,head['experiment_id'],MAX_ITEMS+1)).fetchall()
    if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Trigger automatic resolution exceeds issue budget')
    ids=[]
    for row in rows:
        dto=store._derived_dto(row,con)
        if dto.get('source')=='trigger' and dto.get('skillId')==skill['id'] and dto.get('version')==skill['version']:ids.append(row['annotation_id'])
    if not ids:return
    request={'issue_ids':ids,'resolved_run_id':head['experiment_id']};key='trigger-auto-resolve:'+head['experiment_id']
    _,digest,old=store._receipt(con,scope,ws,'derived_issue_resolve',{'operation_key':key,'operation_request':request})
    if old:raise Conflict('Trigger resolution operation already belongs to another completion')
    sources,_=store._resolution_sources(con,token,ws,scope,ids,current=True)
    result={'resolved_ids':ids,'newly_resolved':len(ids),'resolved_run_id':head['experiment_id']};response_hash,response_ref=store._put(result,MAX_BYTES);now=store.control.clock()
    con.execute('INSERT INTO experiment_operation_receipts VALUES(?,?,?,?,?,?,?,?,?)',(ws,scope.principal_id,'derived_issue_resolve',key,digest,sources[0][0]['experiment_id'],response_hash,response_ref,now))
    for row,machine,selection in sources:
        con.execute('INSERT INTO experiment_derived_issue_annotations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(ws,_id(),row['experiment_id'],row['annotation_id'],row['machine_result_id'],scope.principal_id,scope.principal_id,head['experiment_id'],now,'derived_issue_resolve',key,digest,row['payload_hash'],machine['content_hash'],selection['selection_revision']))


def record_derived(store,con,token,ws,scope,head,cp,slot,machine,result,validate_only=False):
    container=result.get('evidence',{}).get('json',{});derived=container.get('coreTriggerDerived')
    if head['scope']!=SCOPE:raise Forbidden('Trigger derived records require their sealed private scope')
    _,draft_plan=store._plan(con,ws,head['experiment_id'],cp['run_id'])
    if draft_plan.get('config',{}).get('core_trigger',{}).get('kind')=='draft':
        if any(key in container for key in ('coreTriggerDerived','experimentSkillDerived','directTrajectoryDerived')):raise Conflict('Draft cannot publish Skill issues')
        return
    if result.get('status')=='failed':
        if derived is not None:raise Conflict('Failed Trigger work cannot publish derived issues')
        return
    if any(key in container for key in ('experimentSkillDerived','directTrajectoryDerived')):raise Conflict('Trigger aggregate cannot mix derived envelopes')
    _,plan=store._plan(con,ws,head['experiment_id'],cp['run_id']);config=plan.get('config',{});manifest=config.get('core_trigger');frozen=plan.get('experiment_config',{})
    if not isinstance(manifest,dict) or manifest.get('kind')!='run' or config.get('_derived_scope_attested') is not True:raise Forbidden('Trigger derived records require their attested RunPlan')
    skill=manifest['skill'];binding={'skill_id':skill['id'],'skill_name':skill['name'],'version':skill['version'],'source':'trigger','preset':'trigger','scope':SCOPE}
    if config.get('experiment_skill_scope')!=binding or config.get('derived_skill_ids')!=[skill['id']] or config.get('derived_skill_versions')!={skill['id']:[skill['version']]} or frozen.get('scope')!=SCOPE or frozen.get('skillName')!=skill['name'] or frozen.get('skillVersion')!=skill['version'] or frozen.get('preset')!='trigger' or slot['evaluator_id']!=SLOT:raise Conflict('Trigger derived scope escaped its frozen source')
    if not isinstance(derived,dict) or set(derived)!={'version','evaluations','skillIssues'} or type(derived.get('version')) is not int or derived['version']!=1:raise Conflict('Trigger aggregate derived envelope required')
    report=container.get('coreTriggerResult')
    if not isinstance(report,dict) or not isinstance(report.get('items'),list):raise Conflict('Trigger aggregate source report unavailable')
    missed=sum(item['shouldTrigger'] and not item['pass'] for item in report['items']);false=sum(not item['shouldTrigger'] and not item['pass'] for item in report['items']);stolen=sum(item['shouldTrigger'] and bool(item.get('competingSkill')) for item in report['items']);write=report['passRate']<1 or stolen>0
    evaluations=derived['evaluations'];issues=derived['skillIssues']
    if not isinstance(evaluations,list) or not isinstance(issues,list) or len(evaluations)!=int(write) or len(issues)!=int(write):raise Conflict('Trigger must preserve its one aggregate issue semantics')
    owner=manifest.get('legacy_owner') or store._owner(con,scope.principal_id);objects=[]
    if write:
        evaluation={'id':'trigger-evaluation-'+head['experiment_id'],'type':'trigger','skillId':skill['id'],'version':skill['version'],'user':owner,'executionId':None,'generator':'trigger-evaluator@1.0','runId':head['experiment_id'],'status':'ok'}
        if _json(evaluations[0])!=_json(evaluation):raise Conflict('Trigger Evaluation DTO differs from its frozen Run')
        severity='high' if report['passRate']<.6 else 'medium' if report['passRate']<.85 or missed>0 and false>0 else 'low'
        parts=([f'漏 {missed}'] if missed else [])+([f'误 {false}'] if false else [])+([f'抢路由 {stolen}'] if stolen else [])
        summary=f"触发评测通过率 {math.floor(report['passRate']*100+.5)}%"+('（'+' · '.join(parts)+'）' if parts else '')
        expected={'id':'trigger-issue-'+head['experiment_id'],'evaluationId':evaluation['id'],'source':'trigger','skillId':skill['id'],'version':skill['version'],'user':owner,'dedupKey':'trigger:'+skill['name'],'severity':severity,'summary':summary,'reasoning':None,'ruleId':None,'dimension':None,'category':'触发评测'}
        issue=issues[0]
        if not isinstance(issue,dict) or set(issue)!=set(expected)|{'evidence','suggestedFix'} or _json({key:issue.get(key) for key in expected})!=_json(expected) or any(not isinstance(issue[key],str) or not issue[key] for key in ('evidence','suggestedFix')):raise Conflict('Trigger Issue DTO differs from its original aggregate semantics')
        objects=[('derived-evaluation',evaluation),('derived-issue',copy.deepcopy(issue))]
    if validate_only:return
    _resolve_previous(store,con,token,ws,scope,head,skill)
    for kind,dto in objects:
        digest,ref=store._put(dto);identity=dto['id'];old=con.execute('SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=?',(ws,identity)).fetchone()
        if old is not None:raise Conflict('Trigger derived identity already exists')
        con.execute('INSERT INTO experiment_annotations(workspace_id,experiment_id,annotation_id,kind,case_id,result_id,machine_result_id,subject_id,actor_principal_id,payload_hash,payload_ref,created_at_ms,lookup_key) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?)',(ws,head['experiment_id'],identity,kind,cp['case_id'],slot['result_id'],machine,scope.principal_id,digest,ref,store.control.clock(),skill['id']))


def _draft(store,con,token,ws,scope,head):
    store._guard_sources(con,token,ws,head['experiment_id'])
    _,plan=store._plan(con,ws,head['experiment_id'],head['current_run_id']);manifest=plan['config'].get('core_trigger')
    if not isinstance(manifest,dict) or manifest.get('kind')!='draft' or manifest!=json.loads(store._load(head['metadata_hash'],head['metadata_ref'])['configSnapshotJson']).get('coreTrigger'):raise Conflict('Frozen draft binding differs')
    slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND evaluator_id=?',(ws,head['experiment_id'],DRAFT_SLOT)).fetchone()
    if slot is None or slot['run_id']!=head['current_run_id']:raise Conflict('Draft work binding differs')
    status='cancelled' if head['status']=='cancelled' or slot['status']=='cancelled' else 'failed' if slot['status']=='failed' else 'done' if slot['status']=='done' else 'running';result=None;error=None
    if slot['selected_result_id']:
        receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,slot['selected_result_id'])).fetchone()
        if receipt is None or receipt['state']=='quarantined':raise ExperimentUnavailable('Draft result unavailable')
        packet=store._load(receipt['content_hash'],receipt['artifact_ref'])['result'];result=packet.get('evidence',{}).get('json',{}).get('coreTriggerDraft');error=packet.get('errorMessage')
        cp=con.execute('SELECT * FROM experiment_attempt_checkpoints WHERE workspace_id=? AND attempt_id=?',(ws,receipt['attempt_id'])).fetchone()
        if cp is None:raise Conflict('Draft attempt unavailable')
        calls=store._load(cp['payload_hash'],cp['payload_ref']).get('checkpoint',{}).get('_flow_model_calls',{})
        for call in calls.values():
            if call.get('state')!='observed':raise Conflict('Draft model response is not confirmed')
            _trace_source(store,con,token,ws,scope,cp,call.get('response',{}).get('task_id'))
    return {'experiment_id':head['experiment_id'],'set':copy.deepcopy(manifest['placeholder']),'status':status,'result':result,'error':error}


def dispatch_draft_read(store,action,token,ws,body):
    with store.control.read_transaction() as con:
        scope=store.iam._scope(con,token);store.iam._workspace(scope,ws,'read')
        if action=='trigger_draft_read':
            head=_head(store,con,token,ws,scope,body.get('experiment_id'));value=_draft(store,con,token,ws,scope,head);heads=[head]
        else:
            rows=con.execute("SELECT * FROM experiment_heads WHERE workspace_id=? AND created_by=? AND scope=? AND skill_name=? AND state='active' ORDER BY created_at_ms DESC,experiment_id DESC LIMIT ?",(ws,scope.principal_id,SCOPE,identifier(body.get('skill_name')),MAX_ITEMS+1)).fetchall()
            if len(rows)>MAX_ITEMS:raise ExperimentTooLarge('Draft reference budget exceeded')
            heads=[];refs=[]
            for raw in rows:
                head=dict(raw);manifest=json.loads(store._load(head['metadata_hash'],head['metadata_ref']).get('configSnapshotJson') or '{}').get('coreTrigger',{})
                if manifest.get('kind')!='draft':continue
                _head(store,con,token,ws,scope,head['experiment_id']);heads.append(head);refs.append({'experiment_id':head['experiment_id'],'set_id':manifest['placeholder']['id'],'status':head['status']})
            value={'drafts':refs}
        fingerprint=scope.fingerprint
    with store.control.read_transaction() as con:
        current=store.iam._scope(con,token);store.iam._workspace(current,ws,'read')
        if current.fingerprint!=fingerprint:raise Forbidden('Draft authorization changed')
        for old in heads:
            fresh=_head(store,con,token,ws,current,old['experiment_id'])
            if fresh['revision']!=old['revision'] or fresh['current_run_id']!=old['current_run_id']:raise Conflict('Draft reference changed')
            if action=='trigger_draft_read':_draft(store,con,token,ws,current,fresh)
    return value


def validate_draft_checkpoint(store,con,token,ws,body,cp,previous,incoming):
    if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private draft checkpoint attestation required')
    _,plan=store._plan(con,ws,cp['experiment_id'],cp['run_id'])
    if plan['config']['core_trigger'].get('kind')!='draft':raise Conflict('Model-call checkpoint requires draft work')
    calls=incoming['_flow_model_calls'];old=previous.get('_flow_model_calls',{})
    if not isinstance(calls,dict) or set(calls)-{'0'} or not set(old)<=set(calls):raise Conflict('Draft requires one stable model call')
    scope=store.iam._scope(con,token)
    for key,call in calls.items():
        if not isinstance(call,dict) or not isinstance(call.get('request_hash'),str) or len(call['request_hash'])!=64 or any(char not in '0123456789abcdef' for char in call['request_hash']) or call.get('state') not in {'intent','observed'}:raise Conflict('Draft model intent differs')
        prior=old.get(key)
        if prior and (prior['request_hash']!=call['request_hash'] or prior['state']=='observed' and prior!=call):raise Conflict('Observed draft call is immutable')
        if call['state']=='observed':
            response=call.get('response')
            if prior is None or not isinstance(response,dict):raise Conflict('Draft observation requires its intent')
            _trace_source(store,con,token,ws,scope,cp,response.get('task_id'))


def validate_draft_result(store,con,token,ws,body,cp,result):
    if not callable(store.frozen_assets_verifier) or store.frozen_assets_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Private draft result attestation required')
    _,plan=store._plan(con,ws,cp['experiment_id'],cp['run_id']);manifest=plan['config']['core_trigger'];value=result.get('evidence',{}).get('json',{}).get('coreTriggerDraft')
    if manifest.get('kind')!='draft' or manifest.get('draft_preparation_error'):raise Conflict('Draft work source differs')
    checkpoint=store._load(cp['payload_hash'],cp['payload_ref']).get('checkpoint',{});calls=checkpoint.get('_flow_model_calls',{});call=calls.get('0')
    if not isinstance(call,dict) or call.get('state')!='observed' or not isinstance(call.get('response'),dict):raise Conflict('Draft requires an observed indexed model response')
    _trace_source(store,con,token,ws,store.iam._scope(con,token),cp,call['response'].get('task_id'))
    if call['response'].get('failure') or not isinstance(value,dict) or value.get('version')!=1 or value.get('set_id')!=manifest['placeholder']['id'] or value.get('draftedFromSkillHash')!=manifest['draft_skill']['contentHash'] or value.get('skillDescription')!=manifest['draft_skill']['description'] or not isinstance(value.get('items'),list) or not value['items']:raise Conflict('Draft output escaped its frozen source')
    ids=set()
    for item in value['items']:
        if not isinstance(item,dict) or not isinstance(item.get('query'),str) or not item['query'].strip() or type(item.get('shouldTrigger')) is not bool or item.get('source')!='llm-draft' or not isinstance(item.get('id'),str) or item['id'] in ids:raise Conflict('Draft output item is invalid')
        identifier(item['id']);ids.add(item['id'])
