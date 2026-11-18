"""Finite Benchmark cancellation and cleanup authority; never reads evaluation work DTOs."""
import copy
import json
import math
import re
import uuid
from .contracts import identifier
from .control import Conflict,StorageError
from .iam import Forbidden
from .experiments import _hash,_json,_iso

class CancellationNotFound(StorageError):status=404

ACTIONS=frozenset({'cancel_request','cancel_load','cancel_dispatch_bind','cleanup_confirm','cancel_control'})

def _head(store,con,scope,ws,exp,ordinary_cap='delete'):
    row=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()
    if not row:raise CancellationNotFound('Cancellation experiment unavailable')
    store.iam._authorize_scope(con,scope,ws,'delete' if row['scope']=='benchmark' else ordinary_cap,'run',exp)
    return dict(row)

def _current(store,con,scope,ws,identity,exp=None,ordinary_cap='delete'):
    row=con.execute("SELECT * FROM experiment_annotations WHERE workspace_id=? AND annotation_id=? AND kind='cancellation'",(ws,identifier(identity))).fetchone()
    if not row:raise CancellationNotFound('Cancellation unavailable')
    if exp is not None and exp!=row['experiment_id']:raise Conflict('Cancellation experiment differs')
    head=_head(store,con,scope,ws,row['experiment_id'],ordinary_cap);records=store.experiments._cancellations_tx(con,ws,head['experiment_id'],store.experiments._annotations(con,ws,head['experiment_id']));value=next(value for value in records if value['id']==identity)
    return head,value

def _annotation(store,con,ws,exp,scope,value,kind,subject=None):
    digest,ref=store._put(value);store._insert(con,'experiment_annotations',{'workspace_id':ws,'experiment_id':exp,'annotation_id':value['id'] if kind=='cancellation' else str(uuid.uuid4()),'kind':kind,'case_id':value.get('caseKey') or None if kind=='cancellation' else None,'result_id':None,'machine_result_id':None,'subject_id':subject,'actor_principal_id':scope.principal_id,'payload_hash':digest,'payload_ref':ref,'created_at_ms':store.control.clock()});return digest,ref

def _update(store,con,ws,head,scope,current,targets):
    value=copy.deepcopy(current);value.update(revision=str(int(current['revision'])+1),targetsJson=_json(targets),status='completed' if all(target.get('confirmed') is True for target in targets) else 'pending',updatedAt=_iso(store.control.clock()),error=None);_annotation(store,con,ws,head['experiment_id'],scope,value,'cancellation_update',current['id'])
    if value['status']=='completed':con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND aggregate_id=? AND event_type='benchmark.cancellation.requested.v1'",(store.control.clock(),ws,current['id']))
    return value

def _target(store,con,row,legacy_owner):
    if store._cleanup_complete(con,row):return None
    if row['callback_token_hash'] is None:return None
    request=store._load(row['request_hash'],row['request_ref']);value={'jobId':row['job_id'],'targetId':row['job_id'],'runId':row['job_id'],'requestDigest':request.get('requestDigest'),'requestHash':row['request_hash'],'confirmed':False}
    if not isinstance(value['requestDigest'],str):raise Conflict('Frozen external cancellation digest unavailable')
    if row['kind']=='execute':
        if not legacy_owner or not request.get('clientId'):raise Conflict('Frozen Benchmark client owner unavailable')
        return value|{'kind':'benchmark','clientId':request['clientId'],'legacyOwner':legacy_owner}
    target=request.get('dispatchTarget')
    if not isinstance(target,dict) or not isinstance(target.get('baseUrl'),str):raise Conflict('Frozen Benchmark evaluator target unavailable')
    from urllib.parse import urlsplit
    parsed=urlsplit(target['baseUrl'])
    if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:raise Conflict('Frozen evaluator cancellation target invalid')
    return value|{'kind':'evaluation','baseUrl':target['baseUrl']}

def _request(store,con,scope,ws,head,body):
    mode=body.get('mode');case_id=body.get('case_id');exp=head['experiment_id'];now=store.control.clock()
    if mode not in {'cancel','remove','case_remove'} or (mode=='case_remove')!=(case_id is not None):raise ValueError('Exact Benchmark cancellation scope required')
    if body.get('draft_only') is True and (head['status']!='draft' or head['current_run_id'] is not None):raise Conflict('Draft-only deletion cannot stop started Benchmark work')
    params=(ws,exp)+((identifier(case_id),) if case_id else ())
    cases=[dict(row) for row in con.execute('SELECT * FROM experiment_cases WHERE workspace_id=? AND experiment_id=?'+(' AND case_id=?' if case_id else ''),params)]
    if case_id and not cases:raise Conflict('Cancellation Case does not belong to Benchmark')
    rows=[dict(row) for row in con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND experiment_id=?'+(' AND case_id=?' if case_id else '')+' ORDER BY job_id',params)]
    if len(rows)>20000:raise ValueError('Cancellation target budget exceeded')
    native=[dict(row) for row in con.execute("SELECT c.*,a.status AS attempt_status,a.error_code AS attempt_error,w.phase FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id JOIN work_items w ON w.workspace_id=c.workspace_id AND w.work_item_id=c.work_item_id WHERE c.workspace_id=? AND c.experiment_id=? AND w.phase='evaluate'"+(' AND c.case_id=?' if case_id else '')+' ORDER BY c.attempt_id',params)]
    if len(native)>20000:raise ValueError('Native cancellation target budget exceeded')
    work=con.execute('SELECT w.work_item_id,w.run_id,w.case_key,w.phase,w.evaluator_slot FROM work_items w JOIN experiment_runs r ON r.workspace_id=w.workspace_id AND r.run_id=w.run_id WHERE w.workspace_id=? AND r.experiment_id=?'+(' AND w.case_key=?' if case_id else '')+' ORDER BY w.work_item_id LIMIT 20001',params).fetchall()
    if len(work)>20000:raise ValueError('Cancellation work identity budget exceeded')
    source_hash=_hash({'work':[[row[key] for key in ('work_item_id','run_id','case_key','phase','evaluator_slot')] for row in work],'native':[[row[key] for key in ('attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')] for row in native],'cases':sorted(case['case_id'] for case in cases),'jobs':[[row['job_id'],row['request_hash'],row['completion_hash']] for row in rows]});records=store.experiments._cancellations_tx(con,ws,exp,store.experiments._annotations(con,ws,exp));existing=next((value for value in reversed(records) if value.get('caseKey')==(case_id or '') and value.get('sourceJobsHash')==source_hash),None)
    targets=None
    if existing is None:
        _,binding=store._binding(con,ws,exp);owner=binding['run_config'].get('legacyOwner');targets=[target for row in rows if (target:=_target(store,con,row,owner)) is not None]
        for cp in native:
            if (cp['attempt_status'] in {'running','cancelled','expired'} or cp['attempt_error']=='EVALUATION_CLEANUP_UNCONFIRMED') and not native_confirmed(store,con,ws,exp,cp):targets.append({'kind':'native-evaluate','jobId':'native:'+cp['attempt_id'],'targetId':'native:'+cp['attempt_id'],'runId':cp['run_id'],'workspace_id':ws,**{key:str(cp[key]) if key=='fence' else cp[key] for key in ('experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')},'confirmed':False})
    if existing is None or mode=='remove' and head['state']!='deleted' or mode=='case_remove' and any(case['state']=='active' for case in cases):
        for case in cases:
            store.experiments._cancel_items(con,ws,exp,case['case_id'])
            if mode=='case_remove':con.execute("UPDATE experiment_cases SET state='deleted',deleted_at_ms=?,revision=revision+1,lifecycle_revision=lifecycle_revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=? AND state='active'",(now,now,ws,case['case_id']))
        for cp in native:
            if cp['attempt_error']=='EVALUATION_CLEANUP_UNCONFIRMED':con.execute('UPDATE work_items SET cancel_requested=1,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND work_item_id=? AND cancel_requested=0',(now,ws,cp['work_item_id']))
        for row in rows:
            if row['protocol_state'] not in {'completed','failed','cancelled','blocked','execution_failed','dispatch_failed','evaluation_failed','submission_invalid'}:row=store._job_bump(con,row,protocol_state='cancelled')
            for kind in ('benchmark.execution.prepare.requested.v1','benchmark.dispatch.requested.v1','benchmark.execution.completed.v1','benchmark.evaluation.raw.accepted.v1','benchmark.continuation.requested.v1','benchmark.failure.classification.requested.v1'):store._close_intent(con,row,kind)
        remaining=con.execute("SELECT COUNT(*) FROM experiment_cases WHERE workspace_id=? AND experiment_id=? AND state='active'",(ws,exp)).fetchone()[0]
        if mode!='case_remove' or remaining==0:
            con.execute("UPDATE runs SET status='cancelled',etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND run_id IN (SELECT run_id FROM experiment_runs WHERE workspace_id=? AND experiment_id=?)",(now,ws,ws,exp))
            changes={'status':'cancelled'}
            if (mode=='remove' or mode=='case_remove') and head['state']=='active':changes.update(state='deleted',deleted_at_ms=now,lifecycle_revision=head['lifecycle_revision']+1)
            store.experiments._bump(con,ws,exp,**changes)
        else:store.experiments._settle(con,ws,exp)
    if existing:return {'handled':True,'cancellation':existing}
    identity='bcancel_'+uuid.uuid4().hex;value={'id':identity,'experimentId':exp,'caseKey':case_id or '','user':store.experiments._owner(con,scope.principal_id),'revision':'1','status':'pending' if targets else 'completed','targetsJson':_json(targets),'sourceJobsHash':source_hash,'error':None,'createdAt':_iso(now),'updatedAt':_iso(now)};digest,ref=_annotation(store,con,ws,exp,scope,value,'cancellation',head['current_run_id'])
    if targets:con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,1,'benchmark.cancellation.requested.v1',?,?,?)",(ws,str(uuid.uuid4()),identity,_json({'experiment_id':exp,'cancellation_id':identity,'payload_hash':digest,'payload_ref':ref}),now,now))
    return {'handled':True,'cancellation':value}

def _proof(target,proof):
    if not isinstance(proof,dict):raise ValueError('Finite cleanup proof required')
    if target['kind']=='native-evaluate':
        expected={'transport':'native-worker','cleanup':'confirmed',**{key:target[key] for key in ('workspace_id','experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')}}
        if proof!=expected:raise Conflict('Native scoring cleanup provenance differs')
        return
    result=proof.get('result')
    if not isinstance(result,dict) or set(result)!={'runId','status'} or result!={'runId':target['runId'],'status':'cancelled'}:raise Conflict('Actual external cleanup is not confirmed')
    if proof.get('run_id')!=target['runId'] or proof.get('request_digest')!=target['requestDigest']:raise Conflict('Cleanup target identity differs')
    if target['kind']=='benchmark':
        if set(proof)!={'transport','command_id','client_id','legacy_owner','kind','run_id','request_digest','command_status','result'} or proof.get('transport')!='device-command' or proof.get('command_status')!='SUCCEEDED' or not target.get('commandId') or proof.get('command_id')!=target['commandId'] or proof.get('client_id')!=target['clientId'] or proof.get('legacy_owner')!=target['legacyOwner'] or proof.get('kind')!='benchmark':raise Conflict('Cleanup device command provenance differs')
    elif set(proof)!={'transport','base_url','run_id','request_digest','http_status','result'} or proof.get('transport')!='evaluator-http' or proof.get('base_url')!=target['baseUrl'] or proof.get('http_status') not in (200,202):raise Conflict('Cleanup evaluator response provenance differs')

def _pending(store,con,scope,ws,body):
    grant=store.iam._workspace(scope,ws,'delete');limit=body.get('limit',20);after=body.get('after_id')
    if type(limit) is not int or not 1<=limit<=100:raise ValueError('Pending cancellation limit must be 1..100')
    if after is not None:identifier(after)
    params=[ws,scope.principal_id];where="a.workspace_id=? AND a.actor_principal_id=? AND a.kind='cancellation' AND h.scope='benchmark' AND o.event_type='benchmark.cancellation.requested.v1' AND o.state IN ('pending','dispatching')"
    if grant.role not in {'owner','admin','personal'}:where+=" AND EXISTS(SELECT 1 FROM iam_resource_access r WHERE r.workspace_id=a.workspace_id AND r.resource_kind='run' AND r.resource_id=a.experiment_id AND r.owner_principal_id=?)";params.append(scope.principal_id)
    if after is not None:where+=' AND a.annotation_id>?';params.append(after)
    params.append(limit);rows=con.execute('SELECT a.annotation_id,a.experiment_id FROM experiment_annotations a JOIN experiment_heads h ON h.workspace_id=a.workspace_id AND h.experiment_id=a.experiment_id JOIN outbox_events o ON o.workspace_id=a.workspace_id AND o.aggregate_id=a.annotation_id WHERE '+where+' ORDER BY a.annotation_id LIMIT ?',tuple(params)).fetchall();values=[];size=0
    for row in rows:
        try:_,value=_current(store,con,scope,ws,row['annotation_id'],row['experiment_id'])
        except Forbidden:continue
        if value['status']!='pending':continue
        weight=len(_json(value).encode())
        if size+weight>128*1024*1024-65536:break
        values.append(value);size+=weight
    return values


def _control(store,con,scope,ws,head,current,body):
    from .platform_controls import PlatformControls
    from .legacy_history import assert_control_live
    allowed={'action','cancellation_id','experiment_id','target_id','operation','command_id','ttl_ms','operation_key','operation_request'}
    if set(body)-allowed or body.get('operation') not in {'lookup','create','sent'}:raise ValueError('Fixed cancellation control operation required')
    owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='run' AND resource_id=?",(ws,head['experiment_id'])).fetchone()
    if not owner or owner[0]!=scope.principal_id:raise Forbidden('Cancellation command requires actual owner')
    grant=store.iam._workspace(scope,ws,'delete');assert_control_live(con,ws,'experiment',head['experiment_id'])
    target=next((value for value in json.loads(current['targetsJson']) if value['jobId']==body.get('target_id')),None)
    if not target or target['kind']!='benchmark' or target.get('confirmed') or current['status']!='pending':raise Conflict('Pending frozen client cancellation required')
    job=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,target['jobId'])).fetchone()
    if not job or job['experiment_id']!=head['experiment_id'] or job['request_hash']!=target['requestHash']:raise Conflict('Cancellation command source changed')
    controls=PlatformControls(store.control);controls.live_only=True
    clients=controls._read(con,scope,grant,ws,{'kind':'reliabilityClient','metadata':{'clientId':target['clientId']},'body':True},True,owner_only=True)['rows']
    if len(clients)!=1 or clients[0]['data'].get('unboundAt') or clients[0]['data'].get('user')!=target['legacyOwner']:raise Conflict('Frozen cancellation client unavailable')
    command_id=target.get('commandId')
    if body.get('command_id') is not None and body['command_id']!=command_id:raise Conflict('Cancellation command binding changed')
    commands=controls._read(con,scope,grant,ws,{'kind':'reliabilityCommand','metadata':{'commandId':command_id},'body':True},True,owner_only=True)['rows'] if command_id else []
    if len(commands)>1:raise Conflict('Cancellation command identity is ambiguous')
    old=commands[0] if commands else None;command=old['data'] if old else None
    payload={'kind':'benchmark','runId':target['runId'],'requestDigest':target['requestDigest']}
    if command and (command.get('clientId')!=target['clientId'] or command.get('user')!=target['legacyOwner'] or command.get('action')!='CANCEL_EXPERIMENT_RUN' or json.loads(command.get('payloadJson') or '{}')!=payload):raise Conflict('Cancellation command provenance differs')
    operation=body['operation'];touched=set()
    if operation=='create' and not command:
        ttl=body.get('ttl_ms',30000);now=store.control.clock()
        if not command_id or type(ttl) not in (int,float) or not math.isfinite(ttl) or ttl<5000 or ttl+now>9007199254740991:raise ValueError('Bound cancellation command TTL required')
        command=controls._put(con,scope,grant,ws,target['legacyOwner'],{'kind':'reliabilityCommand','method':'create','data':{'commandId':command_id,'clientId':target['clientId'],'user':target['legacyOwner'],'action':'CANCEL_EXPERIMENT_RUN','payloadJson':json.dumps(payload,ensure_ascii=False,separators=(',',':')),'status':'CREATED','createdAt':_iso(now),'expiresAt':_iso(now+ttl)}},touched)
    elif operation=='sent':
        if not command:raise Conflict('Cancellation command is not persisted')
        if command['status']=='CREATED':command=controls._put(con,scope,grant,ws,target['legacyOwner'],{'kind':'reliabilityCommand','method':'update','record_id':old['record_id'],'expected_revision':old['revision'],'data':{'status':'SENT','sentAt':_iso(store.control.clock()),'channel':'wss'}},touched)
    for kind in touched:controls._bump_scope(con,ws,scope.principal_id,target['legacyOwner'],kind)
    if touched:controls._bump_scope(con,ws,scope.principal_id,target['legacyOwner'])
    return {'command':command}

def dispatch(store,action,token,ws,body):
    store._trusted(token,ws,body)
    with store.control.transaction() as con:
        scope=store.iam._scope(con,token)
        if action=='cancel_load' and body.get('pending') is True:return _pending(store,con,scope,ws,body)
        if action=='cancel_request':head=_head(store,con,scope,ws,identifier(body.get('experiment_id')),'write' if body.get('mode')=='cancel' else 'delete');current=None
        else:head,current=_current(store,con,scope,ws,body.get('cancellation_id'),body.get('experiment_id'),'read' if action=='cancel_load' else 'delete')
        if head['scope']!='benchmark':
            if action not in {'cancel_request','cancel_load'}:raise Conflict('Benchmark cleanup action requires its Benchmark cancellation')
            return {'handled':False}
        if action=='cancel_load':return {'handled':True,'experiment_deleted':head['state']=='deleted','cancellation':current,'targets':json.loads(current['targetsJson'])}
        if action=='cancel_control':return _control(store,con,scope,ws,head,current,body)
        key,digest,old=store._receipt(con,scope,ws,action,body)
        if old:
            value=store._load(old['response_hash'],old['response_ref'])
            if action=='cancel_request':value['experiment_deleted']=head['state']=='deleted'
            return value
        if action=='cancel_request':value=_request(store,con,scope,ws,head,body)
        else:
            if str(body.get('expected_revision'))!=str(current['revision']):raise Conflict('Cancellation revision is stale')
            targets=json.loads(current['targetsJson']);target=next((value for value in targets if value['jobId']==body.get('target_id')),None)
            if target is None:raise Conflict('Cancellation target is not frozen in this request')
            native=target['kind']=='native-evaluate';job=None
            if native:
                cp=con.execute('SELECT c.*,w.cancel_requested,w.etag,w.phase FROM experiment_attempt_checkpoints c JOIN work_items w ON w.workspace_id=c.workspace_id AND w.work_item_id=c.work_item_id WHERE c.workspace_id=? AND c.attempt_id=?',(ws,target['attempt_id'])).fetchone()
                if not cp or cp['phase']!='evaluate' or not cp['cancel_requested'] or cp['etag']<=cp['fence'] or target['workspace_id']!=ws or target['experiment_id']!=head['experiment_id'] or any(str(cp[key])!=str(target[key]) for key in ('experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')):raise Conflict('Native cancellation checkpoint source differs')
            else:
                job=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,target['jobId'])).fetchone()
                if not job or job['experiment_id']!=head['experiment_id'] or job['request_hash']!=target['requestHash']:raise Conflict('Cancellation job source differs')
            if action=='cancel_dispatch_bind':
                command=body.get('command_id')
                if target['kind']!='benchmark' or target.get('confirmed') or not isinstance(command,str) or not re.fullmatch(r'cmd_[A-Za-z0-9_-]{1,160}',command) or body.get('previous_command_id')!=target.get('commandId'):raise Conflict('Exact cancellation command binding required')
                if target.get('commandId'):
                    previous=body.get('previous_state',{})
                    if previous.get('status') not in {'FAILED','EXPIRED','DELIVERY_FAILED'} and not (previous.get('status')=='SUCCEEDED' and previous.get('result_status')=='cancelling'):raise Conflict('Prior cleanup command has not reached a replaceable state')
                target['commandId']=command
            elif action=='cleanup_confirm':
                _proof(target,body.get('proof'));target['confirmed']=True
                if native:
                    packet={'format':'benchmark.native-cleanup-confirmed/v1','cancellation_id':current['id'],'confirmed':True,'target':copy.deepcopy(target),'proof':body['proof']};source_key='target:'+target['attempt_id']+':'+target['fence'];source_kind='cleanup-confirmed-native';subject={'experiment_id':head['experiment_id']}
                else:
                    packet={'format':'benchmark.cleanup-confirmed/v1','job_id':job['job_id'],'request_hash':job['request_hash'],'cancellation_id':current['id'],'confirmed':True,'proof':body['proof']};source_key='target:'+job['job_id']+':'+job['request_hash'];source_kind='cleanup-confirmed';subject={'job_id':job['job_id']}
                existing=con.execute('SELECT 1 FROM benchmark_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind=? AND operation_key=?',(ws,scope.principal_id,source_kind,source_key)).fetchone()
                if not existing:store._write_receipt(con,scope,ws,source_kind,source_key,_hash(packet),packet,**subject)
            else:raise ValueError('Unsupported cancellation action')
            value=_update(store,con,ws,head,scope,current,targets)
        if action=='cancel_request':value['experiment_deleted']=con.execute('SELECT state FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,head['experiment_id'])).fetchone()[0]=='deleted'
        store._write_receipt(con,scope,ws,action,key,digest,value,experiment_id=head['experiment_id']);return value

def confirmed(store,con,row):
    receipts=con.execute("SELECT response_hash,response_ref FROM benchmark_operation_receipts WHERE workspace_id=? AND job_id=? AND operation_kind='cleanup-confirmed'",(row['workspace_id'],row['job_id'])).fetchall()
    for receipt in receipts:
        packet=store._load(receipt['response_hash'],receipt['response_ref'])
        if packet.get('format')=='benchmark.cleanup-confirmed/v1' and packet.get('job_id')==row['job_id'] and packet.get('request_hash')==row['request_hash'] and packet.get('confirmed') is True:return True
    return False

def native_confirmed(store,con,ws,exp,cp):
    key='target:'+cp['attempt_id']+':'+str(cp['fence']);receipts=con.execute("SELECT response_hash,response_ref FROM benchmark_operation_receipts WHERE workspace_id=? AND experiment_id=? AND operation_kind='cleanup-confirmed-native' AND operation_key=?",(ws,exp,key)).fetchall()
    for receipt in receipts:
        packet=store._load(receipt['response_hash'],receipt['response_ref']);proof=packet.get('proof',{})
        if packet.get('format')=='benchmark.native-cleanup-confirmed/v1' and packet.get('confirmed') is True and proof.get('cleanup')=='confirmed' and proof.get('workspace_id')==ws and all(str(proof.get(key))==str(cp[key]) for key in ('experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')):return True
    return False
