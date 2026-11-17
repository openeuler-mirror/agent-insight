"""Owner-scoped FI lifecycle over the fixed019 control records."""
import hashlib
import json
import math
import uuid
from .contracts import identifier
from .control import Conflict
from .legacy_history import assert_control_live, is_historical_control
from .iam import Forbidden, ROLE_CAPABILITIES
from .platform_controls import PlatformControls, _iso, _ms

TASK='faultInjectionTask';RUN='faultInjectionRun';WORKER='faultInjectionWorker'
TERMINAL={'completed','judge_skipped','failed','stopped'}
READS={'read_tasks','read_run','workers'}
DEVICE_ACTIONS={'identity','heartbeat','claim','commands','collect','sweep'}

def _json(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)
def _object(value):return value if isinstance(value,dict) else {}
def _parse(value):return json.loads(value or '{}')
def _claim_token(row):return hashlib.sha256(_json([row['id'],row.get('workerId'),row.get('claimedAt')]).encode()).hexdigest()

class FaultInjection:
    def __init__(self,control):self.control=control;self.records=PlatformControls(control);self.iam=self.records.iam

    def _scope(self,con,token,workspace,action,username,capability):
        required='read' if action in READS or action=='identity' else 'delete' if action=='delete' else 'write'
        if capability:
            if action not in DEVICE_ACTIONS:raise Forbidden('Device FI action is restricted')
            self.records.capability=capability
            scope,row=self.records._capability_scope(con)
            if row['workspace_id']!=workspace or row['legacy_username']!=username:raise Forbidden('Device FI owner changed')
            grant=self.iam._workspace(scope,workspace,'write')
            if action!='identity' and 'execute' not in ROLE_CAPABILITIES[grant.role]:raise Forbidden('Device owner cannot execute FI')
        else:
            scope,grant=self.records._scope(con,token,workspace,required)
            principal=con.execute('SELECT normalized_login_name FROM iam_principals WHERE principal_id=?',(scope.principal_id,)).fetchone()
            # A legacy label is an attested adapter projection, never a caller-selected owner.
            if not username:username=principal[0]
            if action not in READS and action not in {'identity','progress','delete'}:self.iam._workspace(scope,workspace,'execute')
        return scope,grant,username

    def _rows(self,con,scope,grant,ws,kind,metadata=None):
        return self.records._read(con,scope,grant,ws,{'kind':kind,'body':True,'metadata':metadata or {}},True,owner_only=True)['rows']

    def _find(self,con,scope,grant,ws,kind,key):
        field={TASK:'taskKey',RUN:'runId',WORKER:'workerId'}[kind]
        rows=self._rows(con,scope,grant,ws,kind)
        return next((row for row in rows if key in (row['record_id'],row['data'][field])),None)

    def _write(self,con,scope,grant,ws,username,kind,row,data,method=None,touched=None):
        operation={'kind':kind,'method':method or ('update' if row else 'create'),'data':data}
        if row:operation.update(record_id=row['record_id'],expected_revision=row['revision'])
        return self.records._put(con,scope,grant,ws,username,operation,touched)

    def _progress(self,con,scope,grant,ws,username,task_id,touched):
        task=self._find(con,scope,grant,ws,TASK,task_id)
        if not task:return None
        runs=[row['data'] for row in self._rows(con,scope,grant,ws,RUN,{'fiTaskId':task['record_id']})]
        data=task['data'];items=json.loads(data.get('itemsJson') or '[]');by_id={run['runId']:run for run in runs}
        for item in items:
            run=by_id.get(item.get('run_id'))
            if not run:continue
            item.update(status=run['status'],phase=run['status'],error=run.get('error'),result={'outcome':run['outcome'],'fault_containment_status':run.get('faultContainmentStatus'),'reason':run.get('judgeReason')} if run.get('outcome') else None)
        progress={'total':len(runs),'queued':0,'running':0,'completed':0,'failed':0,'judge_skipped':0,'stopped':0}
        for run in runs:
            key='running' if run['status'] in {'collecting','judging'} else run['status']
            if key in progress:progress[key]+=1
        finished=sum(progress[key] for key in TERMINAL)
        if progress['running']:status='running'
        elif progress['queued']==progress['total'] and progress['total']:status='queued'
        elif progress['stopped'] and progress['stopped']+progress['failed']==progress['total']:status='stopped'
        elif progress['failed'] and finished==progress['total']:status='failed'
        elif finished==progress['total'] and progress['total']:status='completed'
        elif progress['queued']:status='queued'
        else:status='running'
        return self._write(con,scope,grant,ws,username,TASK,task,{'itemsJson':_json(items),'progressJson':_json(progress),'status':status,'startedAt':_iso(self.control.clock()) if status=='running' and not data.get('startedAt') else data.get('startedAt'),'finishedAt':None if status in {'running','queued'} else _iso(self.control.clock())},touched=touched)

    def _worker(self,con,scope,grant,ws,worker,capability,required=True):
        identifier(worker)
        if capability and worker!=capability.get('client_id'):raise Forbidden('FI worker differs from authenticated client')
        row=self._find(con,scope,grant,ws,WORKER,worker)
        if required and not row:raise Conflict('Worker must register before claiming')
        return row

    def _experiment_current(self,con,ws,owner,run_id):
        checkpoints=con.execute("SELECT c.*,a.status AS attempt_status,a.lease_until_ms,w.status AS item_status,w.cancel_requested,w.etag,h.state AS head_state,h.lifecycle_revision AS head_lifecycle,k.state AS case_state,k.lifecycle_revision AS case_lifecycle,s.work_item_id AS current_item FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id JOIN work_items w ON w.workspace_id=c.workspace_id AND w.work_item_id=c.work_item_id JOIN experiment_heads h ON h.workspace_id=c.workspace_id AND h.experiment_id=c.experiment_id JOIN experiment_cases k ON k.workspace_id=c.workspace_id AND k.case_id=c.case_id LEFT JOIN experiment_result_slots s ON s.workspace_id=c.workspace_id AND s.work_item_id=c.work_item_id WHERE c.workspace_id=? AND c.command_id=?",(ws,'fi:'+run_id)).fetchall()
        if not checkpoints:return True
        return any(row['actor_principal_id']==owner and row['attempt_status']=='running' and row['item_status']=='running' and not row['cancel_requested'] and row['head_state']=='active' and row['case_state']=='active' and row['head_lifecycle']==row['lifecycle_revision'] and row['case_lifecycle']==row['case_lifecycle_revision'] and row['etag']==row['fence'] and row['lease_until_ms']>self.control.clock() and row['current_item']==row['work_item_id'] for row in checkpoints)

    def assert_completion(self,con,ws,owner,run_id,task_id,session_id,checkpoint):
        if checkpoint.get('fi_run_id')!=run_id or checkpoint.get('command_id')!='fi:'+run_id:raise Conflict('FI result differs from the current execution checkpoint')
        rows=con.execute("SELECT * FROM platform_control_records WHERE workspace_id=? AND kind=? AND owner_principal_id=? AND state='active'",(ws,RUN,owner)).fetchall()
        if len(rows)>20000:raise Conflict('FI completion selector exceeds budget')
        selected=[row for row in rows if json.loads(row['metadata_json']).get('runId')==run_id]
        if len(selected)!=1:raise Conflict('FI completion source is unavailable')
        assert_control_live(con,ws,RUN,selected[0]['record_id'])
        run=self.records._data(dict(selected[0]))
        if run['status'] not in {'completed','judge_skipped'} or run['stopRequested'] or run.get('sessionTaskId')!=session_id or task_id and run.get('fiTaskId')!=task_id:raise Conflict('FI completion source was stopped, replaced or differs')
        return run

    def _sweep(self,con,scope,grant,ws,username,payload,touched):
        timeout=payload.get('claimTimeoutMs',300000)
        if type(timeout) not in (int,float) or not 60000<=timeout<=86400000:raise ValueError('Invalid FI claim timeout')
        now=self.control.clock();count=0;tasks=set()
        for row in self._rows(con,scope,grant,ws,RUN,{'status':'collecting'})[:50]:
            run=row['data']
            if run.get('claimedAt') and _ms(run['claimedAt'])>=now-timeout:continue
            worker=self._find(con,scope,grant,ws,WORKER,run['workerId']) if run.get('workerId') else None
            if worker and _ms(worker['data']['lastSeenAt'])>=now-min(timeout,60000):
                active=_parse(worker['data'].get('inventoryJson')).get('activeRunIds')
                if not isinstance(active,list) or run['runId'] in active:continue
            self._write(con,scope,grant,ws,username,RUN,row,{'status':'stopped' if run['stopRequested'] else 'queued','workerId':None,'claimedAt':None,'error':run.get('error') or 'stopped by user' if run['stopRequested'] else 'claim timeout; requeued'},touched=touched)
            count+=1
            if run.get('fiTaskId'):tasks.add(run['fiTaskId'])
        for task in tasks:self._progress(con,scope,grant,ws,username,task,touched)
        return count

    def dispatch(self,token,workspace,action,payload,*,username=None,capability=None):
        if not isinstance(payload,dict):raise ValueError('FI object required')
        if action not in READS|DEVICE_ACTIONS|{'create','progress','stop','delete','cancel'}:raise ValueError('Unknown FI action')
        identifier(workspace)
        transaction=self.control.read_transaction if action in READS or action=='identity' else self.control.transaction
        with transaction() as con:
            scope,grant,username=self._scope(con,token,workspace,action,username,capability);touched=set()
            self.records.live_only=action not in READS
            result=self._dispatch(con,scope,grant,workspace,username,action,payload,capability,touched)
            for kind in touched:self.records._bump_scope(con,workspace,scope.principal_id,username,kind)
            if touched:self.records._bump_scope(con,workspace,scope.principal_id,username)
            return result

    def _dispatch(self,con,scope,grant,ws,username,action,p,cap,touched):
        if action=='identity':return {'principal':scope.principal_id,'workspace':ws,'username':username,'client_id':cap.get('client_id') if cap else None}
        if action=='read_tasks':
            rows=[row['data'] for row in self._rows(con,scope,grant,ws,TASK)]
            if p.get('taskIds') is not None:rows=[row for row in rows if row['id'] in p['taskIds'] or row['taskKey'] in p['taskIds']]
            if p.get('status'):rows=[row for row in rows if row['status']==p['status']]
            rows.sort(key=lambda row:row['createdAt'],reverse=True)
            if p.get('includeRuns'):
                runs=[row['data'] for row in self._rows(con,scope,grant,ws,RUN)]
                for row in rows:row['runs']=sorted([run for run in runs if run.get('fiTaskId')==row['id']],key=lambda run:run['createdAt'])
            return {'tasks':rows[:100]}
        if action=='read_run':
            row=self._find(con,scope,grant,ws,RUN,identifier(p.get('runKey')));return {'run':row['data'] if row else None}
        if action=='workers':
            rows=[row['data'] for row in self._rows(con,scope,grant,ws,WORKER)]
            if p.get('after') is not None:rows=[row for row in rows if _ms(row['lastSeenAt'])>=p['after']]
            rows.sort(key=lambda row:row['lastSeenAt'],reverse=True);return {'workers':rows[:100]}
        if action=='create':
            task=p.get('task');runs=p.get('runs')
            if not isinstance(task,dict) or not isinstance(runs,list) or not 1<=len(runs)<=1000:raise ValueError('FI task and bounded runs required')
            if task.get('user')!=username or any(run.get('user')!=username or run.get('fiTaskId')!=task.get('id') or run.get('status')!='queued' for run in runs):raise Forbidden('FI creation owner or state differs')
            prior=self._find(con,scope,grant,ws,TASK,task['taskKey'])
            if prior:
                old=prior['data'];saved=[row['data'] for row in self._rows(con,scope,grant,ws,RUN,{'fiTaskId':old['id']})]
                if _parse(old.get('requestJson')).get('coreRequestHash')!=_parse(task.get('requestJson')).get('coreRequestHash') or {row['runId'] for row in saved}!={row['runId'] for row in runs}:raise Conflict('FI stable identity conflict')
                return {'task':old,'runs':saved,'items':json.loads(old['itemsJson'])}
            for kind,data,field in [(TASK,task,'taskKey')]+[(RUN,run,'runId') for run in runs]:
                key=hashlib.sha256(_json([data[field]]).encode()).hexdigest()
                if con.execute('SELECT 1 FROM platform_control_records WHERE kind=? AND unique_key=?',(kind,key)).fetchone():raise Conflict('FI identity belongs to an existing or deleted execution')
            task=self._write(con,scope,grant,ws,username,TASK,None,task,touched=touched)
            created=[self._write(con,scope,grant,ws,username,RUN,None,run,touched=touched) for run in runs]
            return {'task':task,'runs':created,'items':json.loads(task['itemsJson'])}
        if action=='progress':return {'task':self._progress(con,scope,grant,ws,username,identifier(p.get('taskId')),touched)}
        if action=='heartbeat':
            worker=identifier(p.get('workerId'));row=self._worker(con,scope,grant,ws,worker,cap,False)
            conflicts=con.execute("SELECT owner_principal_id,workspace_id FROM platform_control_records WHERE kind=? AND state='active' AND unique_key=?",(WORKER,hashlib.sha256(_json([worker]).encode()).hexdigest())).fetchall()
            if any(item['owner_principal_id']!=scope.principal_id or item['workspace_id']!=ws for item in conflicts):raise Conflict('Worker identity belongs to another owner')
            inventory=p.get('inventory',{});inventory=inventory if isinstance(inventory,dict) else {}
            if p.get('partial') and row:
                old=_parse(row['data']['inventoryJson']);platforms={**_object(old.get('platforms'))}
                for key,value in _object(inventory.get('platforms')).items():
                    previous=_object(platforms.get(key));value=_object(value);merged={**previous,**value}
                    for field in ('agents','models'):
                        entries={}
                        for entry in (previous.get(field) or [])+(value.get(field) or []):entries[entry if isinstance(entry,str) else (entry.get('id') or entry.get('name') or _json(entry)) if isinstance(entry,dict) else _json(entry)]=entry
                        merged[field]=list(entries.values())
                    platforms[key]=merged
                inventory={**old,**inventory,'platforms':platforms}
            fields={'workerId':worker,'user':username,'lastSeenAt':_iso(self.control.clock()),'inventoryJson':_json(inventory),'busySlots':p.get('busySlots',0)}
            for field in ('hostname','version'):
                if not p.get('partial') or p.get(field):fields[field]=p.get(field) or None
            return {'worker':self._write(con,scope,grant,ws,username,WORKER,row,fields,touched=touched)}
        if action=='sweep':return {'reclaimed':self._sweep(con,scope,grant,ws,username,p,touched)}
        if action in {'claim','commands'}:
            worker=identifier(p.get('workerId'));self._worker(con,scope,grant,ws,worker,cap)
            if action=='commands':return {'commands':[{'type':'stop','runId':row['data']['runId']} for row in self._rows(con,scope,grant,ws,RUN,{'workerId':worker,'status':'collecting','stopRequested':True})]}
            limit=p.get('limit',1)
            if type(limit) not in (int,float) or not math.isfinite(limit):raise ValueError('FI claim limit required')
            limit=math.ceil(max(1,min(limit,8)))
            claimed=[];tasks=set()
            for _ in range(limit):
                candidates=sorted(self._rows(con,scope,grant,ws,RUN,{'status':'queued','stopRequested':False}),key=lambda row:row['data']['queuedAt'])[:100]
                row=next((row for row in candidates if not _parse(row['data'].get('requestJson')).get('targetWorkerId') or _parse(row['data'].get('requestJson')).get('targetWorkerId')==worker),None)
                if row is None:break
                run=row['data'];request=_parse(run.get('requestJson'))
                if not self._experiment_current(con,ws,scope.principal_id,run['runId']):
                    self._write(con,scope,grant,ws,username,RUN,row,{'status':'stopped','stopRequested':True,'error':'experiment cancelled, expired or superseded'},touched=touched)
                else:
                    claimed_ms=max(self.control.clock(),_ms(run['updatedAt'])+1)
                    run=self._write(con,scope,grant,ws,username,RUN,row,{'status':'collecting','workerId':worker,'claimedAt':_iso(claimed_ms),'error':None},touched=touched)
                    first=con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',(ws,'fi-first-lease:'+scope.principal_id,run['id'])).fetchone()
                    if first is None:con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)',(ws,'fi-first-lease:'+scope.principal_id,run['id'],_claim_token(run),self.control.clock()))
                    task=self._find(con,scope,grant,ws,TASK,run['fiTaskId']) if run.get('fiTaskId') else None;task=task['data'] if task else {}
                    claimed.append({'runId':run['runId'],'taskKey':task.get('taskKey'),'platform':run['platform'],'agent':run['agent'],'fault':run['fault'],'submode':run.get('submode'),'prompt':request.get('prompt') or task.get('prompt') or '', 'model':request.get('model') if request.get('model') is not None else task.get('model'),'workspaceLogical':request.get('workspace') or task.get('workspace') or '__default__','timeoutSeconds':request.get('timeoutSeconds') if type(request.get('timeoutSeconds')) in (int,float) else _parse(task.get('requestJson')).get('timeoutSeconds'),'stopRequested':run['stopRequested'],'claimToken':_claim_token(run)})
                if run.get('fiTaskId'):tasks.add(run['fiTaskId'])
            for row in self._rows(con,scope,grant,ws,RUN,{'status':'queued','stopRequested':True})[:20]:
                self._write(con,scope,grant,ws,username,RUN,row,{'status':'stopped','error':'stopped by user'},touched=touched)
                if row['data'].get('fiTaskId'):tasks.add(row['data']['fiTaskId'])
            for task in tasks:self._progress(con,scope,grant,ws,username,task,touched)
            return {'runs':claimed}
        if action in {'stop','delete','cancel'}:
            selected=p.get('taskIds',[])
            if action=='cancel':
                run=self._find(con,scope,grant,ws,RUN,identifier(p.get('runId')));selected=[run['data']['fiTaskId']] if run and run['data'].get('fiTaskId') else []
            if not isinstance(selected,list) or len(selected)>1000:raise ValueError('Bounded FI task identities required')
            tasks=[row for row in self._rows(con,scope,grant,ws,TASK) if row['record_id'] in selected or row['data']['taskKey'] in selected];deleted=0
            for task in tasks:
                runs=self._rows(con,scope,grant,ws,RUN,{'fiTaskId':task['record_id']})
                if action=='delete':
                    if task['data']['status']=='running':continue
                    for row in runs:self._write(con,scope,grant,ws,username,RUN,row,{},method='delete',touched=touched)
                    self._write(con,scope,grant,ws,username,TASK,task,{},method='delete',touched=touched);deleted+=1
                else:
                    for row in runs:
                        run=row['data']
                        if action=='cancel' and run['runId']!=p['runId']:continue
                        if run['status']=='queued':fields={'status':'stopped','stopRequested':True,'error':'stopped by user'}
                        elif run['status'] in {'collecting','judging'}:fields={'stopRequested':True}
                        else:continue
                        self._write(con,scope,grant,ws,username,RUN,row,fields,touched=touched)
                    self._progress(con,scope,grant,ws,username,task['record_id'],touched)
            return {'ok':True,'deleted':deleted} if action=='delete' else {'ok':True,'count':len(tasks)}
        if action=='collect':
            row=self._find(con,scope,grant,ws,RUN,identifier(p.get('runId')))
            if not row:raise Conflict('FI run is unavailable')
            run=row['data'];worker=identifier(p.get('workerId') or (cap.get('client_id') if cap else run.get('workerId')));self._worker(con,scope,grant,ws,worker,cap)
            supplied=p.get('claimToken');current=_claim_token(run)
            first=con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',(ws,'fi-first-lease:'+scope.principal_id,run['id'])).fetchone()
            if run.get('workerId')!=worker or (supplied!=current if supplied is not None else not first or first[0]!=current):raise Conflict('FI collection lease changed or legacy result is ambiguous')
            fields=p.get('data')
            allowed={'status','error','sessionTaskId','faultActivated','faultActivatedAt','injectionMethod','markersJson','stopRequested','outcome'}
            if not isinstance(fields,dict) or set(fields)-allowed or fields.get('status') not in {'completed','failed','stopped'}:raise ValueError('FI collection fields required')
            if fields.get('sessionTaskId'):
                task=identifier(fields['sessionTaskId'])
                from .trace_analytics import ras_task_deleted
                if ras_task_deleted(con,ws,scope.principal_id,task):raise Conflict('FI business task has been deleted')
                owner=con.execute("SELECT a.owner_principal_id,t.state FROM trace_locators t JOIN iam_resource_access a ON a.workspace_id=t.workspace_id AND a.resource_kind='trace' AND a.resource_id=t.trace_id WHERE t.workspace_id=? AND (t.trace_id=? OR EXISTS(SELECT 1 FROM trace_legacy_ids l WHERE l.workspace_id=t.workspace_id AND l.trace_id=t.trace_id AND l.alias_kind='task' AND l.alias_id=?))",(ws,task,task)).fetchone()
                if owner and (owner['owner_principal_id']!=scope.principal_id or owner['state']!='active'):raise Forbidden('FI business Trace is not owned and active')
            if run['status'] in TERMINAL:
                same=all(run.get(key)==value for key,value in fields.items())
                if same:return {'run':run}
                raise Conflict('FI terminal collection is immutable')
            if run['status']!='collecting':raise Conflict('FI run has no active collection lease')
            if not self._experiment_current(con,ws,scope.principal_id,run['runId']):fields={**fields,'status':'stopped','stopRequested':True,'outcome':None,'error':'experiment cancelled, expired or superseded'}
            if run['stopRequested'] or fields.get('status')=='stopped':fields={**fields,'status':'stopped','stopRequested':True,'outcome':None,'error':fields.get('error') or 'stopped by user'}
            updated=self._write(con,scope,grant,ws,username,RUN,row,fields,touched=touched)
            if run.get('fiTaskId'):self._progress(con,scope,grant,ws,username,run['fiTaskId'],touched)
            return {'run':updated}
        raise ValueError('Unknown FI action')
