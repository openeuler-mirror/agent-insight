import copy
import json

from .collector_sources import _hash, CollectorSourcePending
from .control import Conflict
from .iam import Forbidden
from .observations import _json

EVENT='collector.source.effects.v1'

def annotation_hash(row):
    if not row:return _hash(None)
    extra=json.loads(row['extra_json']);extra={key:item for key,item in extra.items() if key not in ('collector_source_v1','agent_record_v1')}
    return _hash({**{key:row[key] for key in ('label','query_override','final_result_override','feedback_json')},'extra':extra})


class CollectorJobs:
    def __init__(self,public):self.public=public;self.control=public.control;self.ingest=public.ingest;self.sources=public.sources

    def schedule(self,con,row,plan):
        intent=plan.get('collector_entry')
        if not isinstance(intent,dict) or not(intent.get('analysis_requested') or plan.get('post_hooks')):return
        event='collector-effects:'+_hash([row['scope_kind'],row['scope_key'],row['operation_key']]);workspace=row['workspace_id']
        if con.execute('SELECT 1 FROM outbox_events WHERE workspace_id=? AND event_id=?',(workspace,event)).fetchone():return
        source_revision=None;annotation=None
        if row['scope_kind']=='source':
            _,_,state=self.sources._state(con,workspace,row['scope_key']);source_revision=str(state['source_revision']);annotation=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,row['scope_key'])).fetchone()
        payload={'version':1,'owner':row['owner_principal_id'],'receipt':{key:row[key] for key in ('scope_kind','scope_key','operation_key')},'plan_ref':row['plan_ref'],'plan_hash':row['plan_hash'],'capture_ref':row['capture_ref'],'capture_hash':row['capture_hash'],'source_revision':source_revision,'annotation_hash':annotation_hash(annotation),'checkpoint_revision':0,'checkpoint_ref':None,'published':{},'requires_execute':intent.get('analysis_requested') is True}
        now=self.control.clock();due=now+max(0,min(int(intent.get('debounce_ms',0)),60000))
        aggregate='collector:'+_hash(row['owner_principal_id'])+':'+_hash(event)
        con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,next_attempt_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?,?)',(workspace,event,aggregate,EVENT,_json(payload),due,now,now))

    def _event(self,con,token,workspace,value,*,check_fence=True):
        scope=self.sources._scope(con,token,workspace)
        row=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=? AND event_type=?',(workspace,value.get('event_id'),EVENT)).fetchone()
        if not row:raise Conflict('Collector work unavailable')
        payload=json.loads(row['payload_json'])
        if payload['owner']!=scope.principal_id:raise Forbidden('Collector work belongs to another owner')
        if row['state']!='dispatching' or row['attempts']!=value.get('attempts') or row['lease_owner']!=value.get('lease_owner') or row['lease_until_ms']<=self.control.clock():raise Conflict('Collector work lease changed')
        receipt=payload['receipt']
        if payload.get('requires_execute'):self.public.iam._workspace(scope,workspace,'execute')
        if check_fence and receipt['scope_kind']=='source':
            _,_,state=self.sources._owned(con,token,workspace,receipt['scope_key'])
            annotation=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,receipt['scope_key'])).fetchone()
            pending=state.get('operations',{}).get(state.get('pending'))
            if pending and pending['stage']=='reserved' and self.sources._load(pending['request_ref']).get('_collector_job')!=row['event_id']:raise Conflict('A newer collector input is pending')
            if str(state['source_revision'])!=payload['source_revision'] or annotation_hash(annotation)!=payload['annotation_hash']:raise Conflict('Collector source or user annotation changed')
        return dict(row),payload

    def _save(self,con,workspace,event,payload,**fields):
        fields['payload_json']=_json(payload);fields['updated_at_ms']=self.control.clock()
        con.execute('UPDATE outbox_events SET '+','.join(key+'=?' for key in fields)+' WHERE workspace_id=? AND event_id=?',(*fields.values(),workspace,event))

    def before_commit(self,con,token,workspace,row,plan,current_handle=None):
        intent=plan.get('collector_entry',{}).get('analysis_job')
        if not intent:return None
        if current_handle is not None and current_handle.get('event_id')!=intent.get('event_id'):raise Conflict('Collector work handle belongs to another plan')
        authority=current_handle or intent
        event,payload=self._event(con,token,workspace,authority,check_fence=False)
        previous=payload['published'].get(row['operation_key'])
        if previous:
            if previous!=row['plan_hash']:raise Conflict('Collector analysis receipt differs')
            return event,payload
        self._event(con,token,workspace,authority)
        if payload['receipt']['scope_kind']!=row['scope_kind'] or payload['receipt']['scope_key']!=row['scope_key']:raise Conflict('Collector analysis target differs')
        return event,payload

    def after_commit(self,con,workspace,row,job):
        if not job:return
        event,payload=job
        if row['scope_kind']=='source':
            _,_,state=self.sources._state(con,workspace,row['scope_key']);payload['source_revision']=str(state['source_revision'])
        payload['published'][row['operation_key']]=row['plan_hash'];self._save(con,workspace,event['event_id'],payload)

    def dispatch(self,token,workspace,action,value):
        with self.control.transaction(('collector', workspace), ('trace', workspace), ('ingest', workspace)) as con:
            scope=self.sources._scope(con,token,workspace);now=self.control.clock()
            if action=='enqueue_proxy':
                self.public.iam._workspace(scope,workspace,'execute')
                task=value.get('task_id');route=self.public._route(con,workspace,task)
                if not route:raise Conflict('Proxy Session unavailable')
                route,_,state=self.sources._owned(con,token,workspace,route['trace_id'])
                event='collector-proxy:'+_hash([scope.principal_id,task,value.get('operation_key')])
                previous=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=?',(workspace,event)).fetchone()
                request_hash=_hash(value)
                if previous:
                    if json.loads(previous['payload_json']).get('request_hash')!=request_hash:raise Conflict('Proxy end request differs')
                    return {'event_id':event}
                if state.get('pending'):raise CollectorSourcePending('Proxy Session awaits indexing')
                text,_=self.public.preparations._prior_session(state);session=json.loads(text)
                if not session:raise Conflict('Proxy Session unavailable')
                annotation=con.execute('SELECT * FROM trace_annotations WHERE workspace_id=? AND trace_id=?',(workspace,route['trace_id'])).fetchone()
                plan={'collector_entry':{'kind':'proxy','analysis_requested':True},'request':value.get('body',{}),'session':session,'ended_at_ms':now,'post_hooks':[]}
                capture={'model_selection':value.get('model_selection')}
                payload={'version':1,'owner':scope.principal_id,'receipt':{'scope_kind':'source','scope_key':route['trace_id'],'operation_key':event},'plan_ref':self.public.preparations._persist_text(_json(plan)),'plan_hash':__import__('hashlib').sha256(_json(plan).encode()).hexdigest(),'capture_ref':self.public.preparations._persist_text(_json(capture)),'capture_hash':__import__('hashlib').sha256(_json(capture).encode()).hexdigest(),'source_revision':str(state['source_revision']),'annotation_hash':annotation_hash(annotation),'checkpoint_revision':0,'checkpoint_ref':None,'published':{},'requires_execute':True,'request_hash':request_hash}
                con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,next_attempt_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?,?)',(workspace,event,'collector:'+_hash(scope.principal_id)+':'+_hash(event),EVENT,_json(payload),now,now,now))
                return {'event_id':event}
            if action=='result':
                row=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=? AND event_type=?',(workspace,value.get('event_id'),EVENT)).fetchone()
                if not row:raise Conflict('Collector work unavailable')
                payload=json.loads(row['payload_json'])
                if payload['owner']!=scope.principal_id:raise Forbidden('Collector work belongs to another owner')
                self.sources._owned(con,token,workspace,payload['receipt']['scope_key'])
                return {'state':row['state'],'response':payload.get('response')}
            if action=='claim':
                worker=value.get('worker_id')
                if not isinstance(worker,str) or not 1<=len(worker)<=512:raise ValueError('Collector worker required')
                prefix='collector:'+_hash(scope.principal_id)+':'
                rows=con.execute("SELECT * FROM outbox_events WHERE workspace_id=? AND event_type=? AND substr(aggregate_id,1,?)=? AND state IN ('pending','dispatching') AND next_attempt_at_ms<=? AND (lease_until_ms IS NULL OR lease_until_ms<=?) ORDER BY created_at_ms,event_id LIMIT 8",(workspace,EVENT,len(prefix),prefix,now,now)).fetchall();result=[]
                for row in rows:
                    payload=json.loads(row['payload_json']);handle={'event_id':row['event_id'],'attempts':row['attempts']+1,'lease_owner':worker}
                    con.execute("UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(handle['attempts'],worker,now+60000,now,workspace,row['event_id']))
                    if payload.get('requires_execute'):
                        try:self.public.iam._workspace(scope,workspace,'execute')
                        except Forbidden:
                            self._save(con,workspace,row['event_id'],payload,state='pending',lease_owner=None,lease_until_ms=None,next_attempt_at_ms=now+1000);continue
                    try:
                        self._event(con,token,workspace,handle)
                        if payload['receipt']['scope_kind']=='source':
                            _,_,state=self.sources._owned(con,token,workspace,payload['receipt']['scope_key']);op=state['operations'].get(_hash(payload['receipt']['operation_key']))
                            if op and self.sources._op_state(con,workspace,payload['receipt']['scope_key'],op)!='indexed':raise CollectorSourcePending('Collector graph awaits indexing')
                    except CollectorSourcePending:
                        self._save(con,workspace,row['event_id'],payload,state='pending',lease_owner=None,lease_until_ms=None,next_attempt_at_ms=now+1000);continue
                    except (Conflict,Forbidden):
                        self._save(con,workspace,row['event_id'],payload,state='sent',lease_owner=None,lease_until_ms=None);continue
                    plan=json.loads(self.public.preparations._load_text(payload['plan_ref'],payload['plan_hash']));capture=json.loads(self.public.preparations._load_text(payload['capture_ref'],payload['capture_hash']))
                    result.append({'handle':{**handle,'checkpoint_revision':str(payload['checkpoint_revision'])},'receipt':payload['receipt'],'plan':plan,'capture':capture,'checkpoint':self.ingest._load(payload['checkpoint_ref']) if payload['checkpoint_ref'] else {}})
                return result
            event,payload=self._event(con,token,workspace,value,check_fence=action!='finish')
            handle={'event_id':event['event_id'],'attempts':event['attempts'],'lease_owner':event['lease_owner'],'checkpoint_revision':str(payload['checkpoint_revision'])}
            if action in ('check','renew'):
                self._save(con,workspace,event['event_id'],payload,lease_until_ms=now+60000);return handle
            if action=='lookup_checkpoint':
                previous=payload.get('checkpoint_receipts',{}).get(value.get('operation_key'))
                if previous and value.get('checkpoint') is not None and previous['hash']!=_hash({'checkpoint':value.get('checkpoint'),'expected_revision':value.get('expected_revision')}):raise Conflict('Collector checkpoint operation differs')
                return {'found':previous is not None,**({'result':{**handle,'checkpoint_revision':str(previous['revision'])}} if previous else {})}
            if action=='checkpoint':
                key=value.get('operation_key');digest=_hash({'checkpoint':value.get('checkpoint'),'expected_revision':value.get('expected_revision')})
                previous=payload.get('checkpoint_receipts',{}).get(key) if key else None
                if previous:
                    if previous['hash']!=digest:raise Conflict('Collector checkpoint operation differs')
                    return {**handle,'checkpoint_revision':str(previous['revision'])}
                if str(value.get('expected_revision'))!=str(payload['checkpoint_revision']):raise Conflict('Collector work checkpoint changed')
                checkpoint=value.get('checkpoint')
                if not isinstance(checkpoint,dict):raise ValueError('Collector checkpoint required')
                if len(_json(checkpoint).encode())>16*1024*1024:raise ValueError('Collector checkpoint exceeds budget')
                _,payload['checkpoint_ref']=self.ingest._persist(checkpoint);payload['checkpoint_revision']+=1
                if key:payload.setdefault('checkpoint_receipts',{})[key]={'hash':digest,'revision':payload['checkpoint_revision']}
                self._save(con,workspace,event['event_id'],payload,lease_until_ms=now+60000);return {**handle,'checkpoint_revision':str(payload['checkpoint_revision'])}
            if action=='finish':
                if value.get('response') is not None:
                    if len(_json(value['response']).encode())>16*1024*1024:raise ValueError('Collector response exceeds budget')
                    payload['response']=value['response']
                retry=value.get('retry') is True;self._save(con,workspace,event['event_id'],payload,state='pending' if retry else 'sent',lease_owner=None,lease_until_ms=None,next_attempt_at_ms=now+5000);return {'finished':True}
            raise ValueError('Unknown collector work action')
