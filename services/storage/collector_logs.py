import json
import hashlib
from .collector_sources import _hash, CollectorSourcePending
from .control import Conflict
from .iam import Forbidden
from .observations import _json

EVENT='collector.logs.packet.v1'
RAW='collector.logs.raw.v1'

class CollectorLogs:
    def __init__(self,public):self.public=public;self.control=public.control;self.ingest=public.ingest;self.sources=public.sources

    def _handle(self,con,scope,workspace,value):
        row=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=? AND event_type=?',(workspace,value.get('event_id'),EVENT)).fetchone()
        if not row:raise Conflict('Collector log work unavailable')
        data=json.loads(row['payload_json'])
        if data['owner']!=scope.principal_id:raise Forbidden('Collector log owner differs')
        if row['state']!='dispatching' or row['attempts']!=value.get('attempts') or row['lease_owner']!=value.get('lease_owner') or (row['lease_until_ms'] or 0)<=self.control.clock():raise Conflict('Collector log lease changed')
        return row,data

    def dispatch(self,token,workspace,action,value):
        with self.control.transaction() as con:
            scope=self.sources._scope(con,token,workspace);now=self.control.clock()
            if action=='accept':
                raw=value.get('raw_json');groups=value.get('groups');key=value.get('operation_key')
                if not isinstance(raw,str) or len(raw.encode())>64*1024*1024 or not isinstance(groups,list) or len(groups)>4096:raise ValueError('Bounded collector packet required')
                digest=hashlib.sha256(raw.encode()).hexdigest();packet='collector-logs:'+_hash([scope.principal_id,key or digest])
                previous=con.execute('SELECT * FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',(workspace,RAW,packet)).fetchone()
                if previous:
                    if previous['content_hash']!=digest:raise Conflict('Collector packet key differs')
                    rows=con.execute('SELECT payload_json FROM outbox_events WHERE workspace_id=? AND event_type=? AND aggregate_id=?',(workspace,RAW,packet)).fetchall()
                    return json.loads(rows[0][0])['response']
                _,raw_ref=self.ingest._persist({'raw_json':raw,'owner':scope.principal_id,'received_at_ms':now,'controller_purpose':'collector-source/v1'})
                accepted=[]
                for index,group in enumerate(groups):
                    if not isinstance(group,dict) or group.get('channel') not in ('claude','codeagent','harness','traces','jiuwen') or not isinstance(group.get('session_id'),str) or not 1<=len(group['session_id'])<=2048 or not isinstance(group.get('events'),list):raise ValueError('Collector event group required')
                    aggregate='collector-logs:'+_hash(scope.principal_id)+':'+_hash([group['channel'],group['session_id']]);revision=con.execute('SELECT MAX(aggregate_revision) FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type=?',(workspace,aggregate,EVENT)).fetchone()[0] or 0
                    _,ref=self.ingest._persist(group['events']);event=packet+':'+str(index)
                    data={'owner':scope.principal_id,'legacy_username':value.get('legacy_username'),'session_id':group['session_id'],'channel':group['channel'],'events_ref':ref,'raw_ref':raw_ref,'packet_id':packet,'received_at_ms':now,'session_ids':group.get('session_ids',[]),'multi_sessions':group.get('multi_sessions',[])}
                    con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,next_attempt_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)',(workspace,event,aggregate,revision+1,EVENT,_json(data),now,now,now));accepted.append({'channel':group['channel'],'session_id':group['session_id']})
                response={'packet_id':packet,'accepted':accepted,'received_at_ms':now}
                con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,state,next_attempt_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,\'sent\',?,?,?)',(workspace,packet,packet,RAW,_json({'owner':scope.principal_id,'raw_ref':raw_ref,'response':response}),now,now,now))
                con.execute('INSERT INTO inbox_receipts(workspace_id,source_id,event_id,content_hash,processed_at_ms) VALUES(?,?,?,?,?)',(workspace,RAW,packet,digest,now));return response
            if action=='claim':
                worker=value.get('worker_id')
                if not isinstance(worker,str) or not 1<=len(worker)<=512:raise ValueError('Collector logs worker required')
                prefix='collector-logs:'+_hash(scope.principal_id)+':'
                rows=con.execute("SELECT * FROM outbox_events WHERE workspace_id=? AND event_type=? AND substr(aggregate_id,1,?)=? AND state IN ('pending','dispatching') AND next_attempt_at_ms<=? AND (lease_until_ms IS NULL OR lease_until_ms<=?) ORDER BY created_at_ms,event_id LIMIT 128",(workspace,EVENT,len(prefix),prefix,now,now)).fetchall();result=[];seen=set()
                for row in rows:
                    aggregate=row['aggregate_id']
                    if aggregate in seen:continue
                    seen.add(aggregate);data=json.loads(row['payload_json'])
                    if data['owner']!=scope.principal_id:continue
                    peers={aggregate}
                    if data['channel']=='jiuwen':
                        catalog=con.execute('SELECT aggregate_id,payload_json FROM outbox_events WHERE workspace_id=? AND event_type=? AND substr(aggregate_id,1,?)=? ORDER BY created_at_ms,event_id',(workspace,EVENT,len(prefix),prefix)).fetchall();sessions={};multi=set();members={}
                        for item in catalog:
                            part=json.loads(item['payload_json'])
                            if part['channel']!='jiuwen':continue
                            for session in part.get('session_ids',[]):sessions[item['aggregate_id']]=session;members.setdefault(session,set()).add(item['aggregate_id'])
                            multi.update(part.get('multi_sessions',[]))
                        session=sessions.get(aggregate)
                        if session in multi:peers=members.get(session,peers)
                    packets=[];covered=[];leased=False
                    for peer in sorted(peers):
                        if con.execute("SELECT 1 FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type=? AND state='dispatching' AND lease_until_ms>?",(workspace,peer,EVENT,now)).fetchone():leased=True;break
                        head=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type=? ORDER BY aggregate_revision DESC LIMIT 1',(workspace,peer,EVENT)).fetchone()
                        covered.append({'aggregate_id':peer,'revision':head['aggregate_revision'],'event_id':head['event_id']})
                        packets.extend(con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type=? AND aggregate_revision<=? ORDER BY aggregate_revision',(workspace,peer,EVENT,head['aggregate_revision'])).fetchall())
                    if leased:continue
                    latest=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type=? ORDER BY aggregate_revision DESC LIMIT 1',(workspace,aggregate,EVENT)).fetchone()
                    if latest['state']=='sent':continue
                    events=[];hashes=[]
                    for packet in sorted(packets,key=lambda packet:(packet['created_at_ms'],packet['event_id'])):
                        part=json.loads(packet['payload_json']);events.extend(self.ingest._load(part['events_ref']));hashes.append([packet['event_id'],part['events_ref']])
                    data=json.loads(latest['payload_json'])
                    if data.get('watermark_hash')!=_hash(hashes):data.pop('outputs',None);data.pop('retirement_receipts',None)
                    data['watermark_hash']=_hash(hashes);data['covered']=covered
                    if len(_json(events).encode())>128*1024*1024:continue
                    handle={'event_id':latest['event_id'],'attempts':latest['attempts']+1,'lease_owner':worker}
                    con.execute("UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,lease_until_ms=?,payload_json=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(handle['attempts'],worker,now+120000,_json(data),now,workspace,latest['event_id']))
                    for item in covered:
                        if item['event_id']!=latest['event_id']:con.execute("UPDATE outbox_events SET state='dispatching',lease_owner=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(worker,now+120000,now,workspace,item['event_id']))
                    seen.update(peers)
                    result.append({'handle':handle,'session_id':data['session_id'],'channel':data['channel'],'events':events,'received_at_ms':data['received_at_ms'],'source_proof':{'version':1,'event_id':latest['event_id'],'watermark_hash':data['watermark_hash']}})
                    if len(result)>=4:break
                return result
            row,data=self._handle(con,scope,workspace,value)
            if action=='renew':
                for item in data.get('covered',[]):
                    if item['event_id']!=row['event_id']:con.execute('UPDATE outbox_events SET lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=? AND lease_owner=?',(now+120000,now,workspace,item['event_id'],row['lease_owner']))
                con.execute('UPDATE outbox_events SET lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?',(now+120000,now,workspace,row['event_id']));return {'renewed':True}
            if action=='outputs':
                outputs=value.get('outputs');retired=value.get('retired',[])
                if not isinstance(outputs,list) or not isinstance(retired,list) or len(outputs)+len(retired)>2048 or any(not isinstance(item,str) or not item for item in outputs+retired):raise ValueError('Bounded collector outputs required')
                expected={'outputs':outputs,'retired':retired}
                if data.get('outputs') is not None and data['outputs']!=expected:raise Conflict('Collector output identities changed')
                data['outputs']=expected;con.execute('UPDATE outbox_events SET payload_json=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?',(_json(data),now+120000,now,workspace,row['event_id']));return expected
            if action=='retire_orphans':
                if data['channel']!='jiuwen':raise ValueError('Jiuwen source work required')
                outputs=data.get('outputs',{});tasks=outputs.get('retired',[]);receipts=[]
                from .collector_graphs import CollectorGraphs
                proof={'version':1,'event_id':row['event_id'],'watermark_hash':data['watermark_hash']}
                for task in tasks:
                    if not task.startswith('jiuwen-'):raise ValueError('Jiuwen orphan identity required')
                    route=self.public._route(con,workspace,task)
                    if not route:continue
                    route,_,state=self.sources._owned(con,token,workspace,route['trace_id']);snapshot=self.sources._load(state.get('snapshot_ref'))
                    key='jiuwen-retire:'+_hash([row['event_id'],task]);existing=state['operations'].get(_hash(key))
                    if existing:receipts.append({'scope_key':route['trace_id'],'operation_key':key,'task_id':task});continue
                    if state.get('execution_retired'):continue
                    if not snapshot or snapshot['execution'].get('framework')!='jiuwenswarm':raise Conflict('Jiuwen orphan source differs')
                    reserved=self.sources._reserve(con,token,workspace,{'operation':'snapshot','operation_key':key,'task_id':state['task_id'],'execution_id':state['execution_id'],'legacy_username':state['legacy_username'],'framework':'jiuwenswarm','operation_request':{'source_proof':proof,'jiuwen_orphan':True}})
                    if reserved.get('resume_pending'):raise CollectorSourcePending('Jiuwen orphan has pending writes')
                    route,_,state=self.sources._owned(con,token,workspace,route['trace_id']);op=state['operations'][_hash(key)]
                    CollectorGraphs(self.public.preparations)._retire(con,{'workspace_id':workspace,'scope_key':route['trace_id'],'plan_hash':_hash(proof)},route,state,op,derived_only=False);self.sources._write(con,workspace,route['trace_id'],state);receipts.append({'scope_key':route['trace_id'],'operation_key':key,'task_id':task})
                data['retirement_receipts']=receipts;con.execute('UPDATE outbox_events SET payload_json=? WHERE workspace_id=? AND event_id=?',(_json(data),workspace,row['event_id']));return receipts
            if action=='ack':
                disposition=value.get('disposition')
                if disposition=='indexed':
                    receipts=value.get('receipts') or [value.get('receipt',{})]
                    expected={'version':1,'event_id':row['event_id'],'watermark_hash':data['watermark_hash']};tasks=set()
                    for receipt in receipts:
                        route,_,state=self.sources._owned(con,token,workspace,receipt.get('scope_key'));op=state['operations'].get(_hash(receipt.get('operation_key')))
                        if not op or self.sources._load(op['request_ref']).get('source_proof')!=expected:raise Conflict('Collector receipt provenance differs')
                        if self.sources._op_state(con,workspace,route['trace_id'],op)!='indexed':raise CollectorSourcePending('Collector graph is not indexed')
                        tasks.add(state['task_id'])
                    wanted=set(data.get('outputs',{}).get('outputs',[]))|{item['task_id'] for item in data.get('retirement_receipts',[])}
                    if wanted and tasks!=wanted:raise Conflict('Collector output receipt vector is incomplete')
                elif disposition=='discard':
                    if value.get('reason') not in ('context-supplement','hidden-background','empty-harness','aggregation-limit'):raise ValueError('Explicit original discard reason required')
                else:raise ValueError('Indexed receipt or explicit discard required')
                content=_hash({'watermark':data['watermark_hash'],'disposition':disposition,'receipt':value.get('receipts',value.get('receipt')),'reason':value.get('reason')})
                con.execute('INSERT INTO inbox_receipts(workspace_id,source_id,event_id,content_hash,processed_at_ms) VALUES(?,?,?,?,?)',(workspace,EVENT,row['event_id'],content,now))
                for item in data.get('covered',[{'aggregate_id':row['aggregate_id'],'revision':row['aggregate_revision']}]):con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND aggregate_id=? AND event_type=? AND aggregate_revision<=?",(now,workspace,item['aggregate_id'],EVENT,item['revision']))
                return {'acknowledged':True}
            if action=='retry':
                for item in data.get('covered',[]):
                    if item['event_id']!=row['event_id']:con.execute("UPDATE outbox_events SET state='pending',lease_owner=NULL,lease_until_ms=NULL,next_attempt_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=? AND lease_owner=?",(now+5000,now,workspace,item['event_id'],row['lease_owner']))
                con.execute("UPDATE outbox_events SET state='pending',lease_owner=NULL,lease_until_ms=NULL,next_attempt_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(now+5000,now,workspace,row['event_id']));return {'retained':True}
            raise ValueError('Unknown collector log action')
