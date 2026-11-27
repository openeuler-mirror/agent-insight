import datetime
import hashlib
import json
import math
import re
from pathlib import Path

from .control import Conflict,StorageError
from .iam import IAMStore,Forbidden
from .observations import ObservationIngest
from .trace_metadata import TraceMetadata

MODELS=json.loads((Path(__file__).parent/'schema'/'semantic-models.json').read_text())
FACTS={'semantic_immutable_facts','usage_event_facts','usage_daily_facts'}
MAX_RECORDS=2000

def _json(value):return json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':'),sort_keys=True)
def _hash(value):return hashlib.sha256(_json(value).encode()).hexdigest()
def _text(value,maximum=512):
    if not isinstance(value,str) or not value or len(value.encode())>maximum or '\0' in value:raise ValueError('Bounded text required')
    return value

def _date(value):
    if not isinstance(value,str):raise ValueError('ISO date required')
    stamp=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    if stamp.tzinfo is None:raise ValueError('Zoned date required')
    return int(stamp.timestamp()*1000)

def _day(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):raise ValueError('Date key required')
    datetime.date.fromisoformat(value);return value

class SemanticUsageStore:
    def __init__(self,control,facts):self.control=control;self.facts=facts;self.iam=IAMStore(control);self.artifacts=ObservationIngest(control,facts);self.metadata=TraceMetadata(control)
    def _scope(self,con,token,ws,capability='read'):
        if not con.execute('SELECT 1 FROM schema_meta WHERE version=20').fetchone():raise StorageError('Explicit semantic/usage migration020 required')
        scope=self.iam._scope(con,token);grant=self.iam._workspace(scope,ws,capability);return scope,grant
    def scope(self,token,ws,capability='read'):
        if capability not in ('read','write'):raise ValueError('Known capability required')
        with self.control.read_transaction() as con:
            scope,grant=self._scope(con,token,ws,capability)
            return {'authorized':True,'principal':scope.principal_id,'workspace':ws,'admin':grant.role in ('owner','admin','personal')}
    def _payload(self,row):
        value=self.artifacts._load(row['payload_ref'])
        if _hash(value)!=row['content_hash']:raise StorageError('Semantic artifact differs')
        return value
    def _record_body(self,row):
        if MODELS[row['kind']]['immutable']:
            body=self.facts.read_semantic_fact('semantic_immutable_facts',row['workspace_id'],row['owner_principal_id'],row['kind'],row['record_id'],row['content_hash'])
            if body is None or _hash(body)!=row['content_hash']:raise StorageError('Semantic fact publication unavailable')
            return body
        return self._payload(row)
    def read(self,token,ws,domain,*,after=None,revision=None,limit=256,preparation=False,owner_username=None):
        if domain not in ('goal','collaboration') or type(limit) is not int or not 1<=limit<=256:raise ValueError('Bounded semantic domain required')
        with self.control.read_transaction() as con:
            scope,grant=self._scope(con,token,ws,'write' if preparation is True else 'read');owner=scope.principal_id
            if owner_username is not None:
                _text(owner_username)
                current=con.execute('SELECT legacy_username FROM semantic_scopes WHERE workspace_id=? AND owner_principal_id=? AND domain=?',(ws,owner,domain)).fetchone()
                if current and current[0]!=owner_username:
                    if preparation is True or grant.role not in ('owner','admin','personal'):raise Forbidden('Semantic owner required')
                    owners=con.execute('SELECT owner_principal_id FROM semantic_scopes WHERE workspace_id=? AND domain=? AND legacy_username=?',(ws,domain,owner_username)).fetchall()
                    if len(owners)!=1:return {'revision':0,'rows':[],'cursor':None}
                    owner=owners[0][0]
                elif not current and grant.role in ('owner','admin','personal') and preparation is not True:
                    owners=con.execute('SELECT owner_principal_id FROM semantic_scopes WHERE workspace_id=? AND domain=? AND legacy_username=?',(ws,domain,owner_username)).fetchall()
                    if len(owners)==1:owner=owners[0][0]
            clock=con.execute('SELECT revision FROM semantic_scopes WHERE workspace_id=? AND owner_principal_id=? AND domain=?',(ws,owner,domain)).fetchone();version=clock[0] if clock else 0
            if revision is not None and revision!=version:raise Conflict('Semantic projection changed')
            kinds=[k for k,d in MODELS.items() if d['domain']==domain]
            rows=con.execute("SELECT * FROM semantic_records WHERE workspace_id=? AND owner_principal_id=? AND kind IN ("+','.join('?' for _ in kinds)+") AND state='active'"+(' AND (kind>? OR (kind=? AND record_id>?))' if after else '')+' ORDER BY kind,record_id LIMIT ?',tuple([ws,owner,*kinds]+([after['kind'],after['kind'],after['id']] if after else [])+[limit+1])).fetchall()
            selected=rows[:limit];values=[{'kind':row['kind'],'id':row['record_id'],'data':self._record_body(row)} for row in selected]
            return {'revision':version,'rows':values,'cursor':{'kind':selected[-1]['kind'],'id':selected[-1]['record_id']} if len(rows)>limit else None}
    def _normalize(self,kind,value,username):
        model=MODELS[kind]
        if not isinstance(value,dict) or set(value)-set(model['fields']):raise ValueError('Fixed semantic scalar fields required')
        result={}
        for key,definition in model['fields'].items():
            val=value.get(key)
            if val is None:
                if not definition['nullable']:raise ValueError('Required semantic field '+key)
            elif definition['type']=='String':
                if not isinstance(val,str) or len(val.encode())>4*1024*1024:raise ValueError('Bounded string required')
            elif definition['type']=='DateTime':_date(val)
            elif definition['type']=='Boolean':
                if type(val) is not bool:raise ValueError('Boolean required')
            elif definition['type']=='Int':
                if type(val) is not int or not -(2**31)<=val<2**31:raise ValueError('Signed Int32 required')
            elif type(val) not in (int,float) or not math.isfinite(val):raise ValueError('Finite number required')
            result[key]=val
        if result.get('user',username)!=username:raise Forbidden('Actual semantic owner required')
        if kind=='collaborationEndpointResolution' and result['side'] not in ('from','to'):raise ValueError('Endpoint side required')
        if kind in ('collaborationEndpointResolution','goalPlusExecutionLink') and result['linkState'] not in ('pending','linked','ambiguous','superseded'):raise ValueError('Known link state required')
        return result
    def _trace(self,con,token,ws,owner,execution):
        if not execution:return
        alias=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?",(ws,execution)).fetchone();trace=alias[0] if alias else execution
        try:self.metadata._trace(con,token,ws,trace,'read')
        except Forbidden:self.metadata._trace(con,token,ws,trace,'write')
        access=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(ws,trace)).fetchone()
        if not access or access[0]!=owner:raise Forbidden('Same-owner actual Trace required')
    def _ensure_scope(self, con, ws, owner, domain, username):
        con.execute('INSERT INTO semantic_scopes VALUES(?,?,?,?,0)' + self.control.insert_if_absent_clause,
                    (ws, owner, domain, username))

    def apply(self,token,ws,value):
        if not isinstance(value,dict) or set(value)!={'domain','revision','legacy_username','operations'}:raise ValueError('Fixed semantic batch required')
        domain=value['domain'];username=_text(value['legacy_username']);ops=value['operations']
        if domain not in ('goal','collaboration') or type(value['revision']) is not int or not isinstance(ops,list) or not 1<=len(ops)<=MAX_RECORDS:raise ValueError('Bounded semantic batch required')
        with self.control.transaction(shared=(('semantic', ws), ('trace', ws))) as con:
            scope,_=self._scope(con,token,ws,'write');owner=scope.principal_id
            self.control.lock_keys(con, ('semantic', ws, owner, domain))
            clock=con.execute('SELECT * FROM semantic_scopes WHERE workspace_id=? AND owner_principal_id=? AND domain=?',(ws,owner,domain)).fetchone();version=clock['revision'] if clock else 0
            if version!=value['revision']:raise Conflict('Semantic projection changed')
            if clock and clock['legacy_username']!=username:raise Forbidden('Semantic owner label differs')
            if not clock:
                self._ensure_scope(con,ws,owner,domain,username)
            changed=con.execute('UPDATE semantic_scopes SET revision=revision+1 WHERE workspace_id=? AND owner_principal_id=? AND domain=? AND revision=?',(ws,owner,domain,version))
            if changed.rowcount!=1:raise Conflict('Semantic projection changed')
            normalized=[];pending={}
            for op in ops:
                if not isinstance(op,dict) or set(op)-{'kind','id','data','delete'}:raise ValueError('Fixed semantic operation required')
                kind=op.get('kind');rid=_text(op.get('id'))
                if kind not in MODELS or MODELS[kind]['domain']!=domain:raise ValueError('Fixed semantic kind required')
                if (kind,rid) in pending:raise ValueError('Duplicate semantic operation')
                old=con.execute('SELECT * FROM semantic_records WHERE workspace_id=? AND owner_principal_id=? AND kind=? AND record_id=?',(ws,owner,kind,rid)).fetchone()
                if op.get('delete') is True:
                    if MODELS[kind]['immutable']:raise Conflict('Immutable semantic facts retained')
                    data=None
                else:
                    data=self._normalize(kind,op.get('data'),username)
                    if data['id']!=rid:raise ValueError('Semantic identity differs')
                    if old and old['state']=='deleted':raise Conflict('Retired semantic identity retained')
                    if old:
                        prior=self._payload(old)
                        for unique in MODELS[kind]['unique']:
                            if any(prior[field]!=data[field] for field in unique):raise Conflict('Semantic identity fields differ')
                        if MODELS[kind]['immutable'] and prior!=data:raise Conflict('Immutable semantic identity differs')
                        if kind=='goalPlusSource' and (prior['workspaceFingerprint']!=data['workspaceFingerprint'] or prior['sourceId']!=data['sourceId']):raise Conflict('Goal source identity differs')
                        if kind=='collaborationSessionBinding' and prior!=data:raise Conflict('Immutable collaboration binding differs')
                    self._trace(con,token,ws,owner,data.get('executionId'))
                normalized.append((kind,rid,data,old));pending[kind,rid]=data
            def current(kind,rid):
                if (kind,rid) in pending:return pending[kind,rid]
                row=con.execute("SELECT * FROM semantic_records WHERE workspace_id=? AND owner_principal_id=? AND kind=? AND record_id=? AND state='active'",(ws,owner,kind,rid)).fetchone();return self._payload(row) if row else None
            for kind,rid,data,old in normalized:
                if data:
                    for key,parent in MODELS[kind]['parents'].items():
                        if parent=='execution':continue
                        if data[key] is not None and not current(parent,data[key]):raise Conflict('Actual semantic parent required')
                    if kind=='collaborationSessionBinding':
                        parent=any(k=='collaboration' and item and item['collaborationId']==data['collaborationId'] for (k,_),item in pending.items())
                        if not parent:parent=con.execute("SELECT 1 FROM semantic_unique_keys k JOIN semantic_records r ON r.workspace_id=k.workspace_id AND r.owner_principal_id=k.owner_principal_id AND r.kind=k.kind AND r.record_id=k.record_id WHERE k.workspace_id=? AND k.owner_principal_id=? AND k.kind='collaboration' AND k.constraint_key='user,collaborationId' AND k.key_hash=? AND r.state='active'",(ws,owner,_hash([username,data['collaborationId']]))).fetchone()
                        if not parent:raise Conflict('Actual collaboration parent required')
                        roots=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='task' AND alias_id=?",(ws,data['traceSessionId'])).fetchall()
                        for route in roots:self._trace(con,token,ws,owner,route[0])
            for kind,rid,data,old in normalized:
                con.execute('DELETE FROM semantic_unique_keys WHERE workspace_id=? AND owner_principal_id=? AND kind=? AND record_id=?',(ws,owner,kind,rid))
                if data is None:
                    if old:con.execute("UPDATE semantic_records SET state='deleted',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND owner_principal_id=? AND kind=? AND record_id=?",(self.control.clock(),ws,owner,kind,rid))
                    continue
                digest=_hash(data);ref=self.artifacts._persist(data)[1];now=self.control.clock()
                if MODELS[kind]['immutable']:self.facts.write_semantic_fact('semantic_immutable_facts',{'workspace_id':ws,'owner_principal_id':owner,'kind':kind,'record_id':rid,'content_hash':digest,'body_json':_json(data),'retry_version':1})
                if old:con.execute('UPDATE semantic_records SET content_hash=?,payload_ref=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND owner_principal_id=? AND kind=? AND record_id=?',(digest,ref,now,ws,owner,kind,rid))
                else:con.execute('INSERT INTO semantic_records VALUES(?,?,?,?,?,?,\'active\',1,?,?)',(ws,owner,kind,rid,digest,ref,now,now))
                for unique in MODELS[kind]['unique']:
                    keys=[data[field] for field in unique]
                    if any(v is None for v in keys):continue
                    con.execute('INSERT INTO semantic_unique_keys VALUES(?,?,?,?,?,?)',(ws,owner,kind,','.join(unique),_hash(keys),rid))
            next_version=version+1
            self._scope(con,token,ws,'write');return {'revision':next_version}
    def usage_persist(self,token,ws,events):
        if not isinstance(events,list) or not 1<=len(events)<=1000:raise ValueError('Bounded usage batch required')
        normalized=[]
        for e in events:
            if not isinstance(e,dict) or set(e)!={'eventId','occurredAt','dateKey','user','featureKey','eventKey','source','route'}:raise ValueError('Fixed usage event required')
            normalized.append({**e,'eventId':_text(e['eventId'],200),'dateKey':_day(e['dateKey']),'user':_text(e['user'],200),'featureKey':_text(e['featureKey'],100),'eventKey':_text(e['eventKey'],100)})
            _date(e['occurredAt'])
            if e['source'] not in ('client','server') or e['route'] is not None and (not isinstance(e['route'],str) or len(e['route'])>1024):raise ValueError('Usage source/route required')
        with self.control.transaction(shared=(('usage', ws),)) as con:
            scope,_=self._scope(con,token,ws,'write');owner=scope.principal_id;fresh=[];changed={}
            self.control.lock_keys(con, ('usage', ws, owner))
            username=normalized[0]['user']
            if any(e['user']!=username for e in normalized):raise Forbidden('Same-owner usage batch required')
            self._ensure_scope(con,ws,owner,'usage',username)
            con.execute("UPDATE semantic_scopes SET revision=revision+1 WHERE workspace_id=? AND owner_principal_id=? AND domain='usage'",(ws,owner))
            label=con.execute("SELECT legacy_username FROM semantic_scopes WHERE workspace_id=? AND owner_principal_id=? AND domain='usage'",(ws,owner)).fetchone()[0]
            if label!=username:raise Forbidden('Usage owner label differs')
            for event in normalized:
                rid=event['eventId'];digest=_hash(event)
                previous=con.execute('SELECT content_hash FROM usage_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND event_id=?',(ws,owner,rid)).fetchone()
                if previous:continue
                self.facts.write_semantic_fact('usage_event_facts',{'workspace_id':ws,'owner_principal_id':owner,'kind':'usage','record_id':rid,'content_hash':digest,'body_json':_json(event),'retry_version':1})
                con.execute("INSERT INTO usage_event_receipts VALUES(?,?,?,?,?,?,'active')",(ws,owner,rid,digest,event['dateKey'],self.control.clock()));fresh.append(event)
                key=event['dateKey'],event['featureKey'],event['eventKey'];stamp=_date(event['occurredAt'])
                row=con.execute('SELECT * FROM usage_daily_heads WHERE workspace_id=? AND owner_principal_id=? AND date_key=? AND feature_key=? AND event_key=?',(ws,owner,*key)).fetchone()
                if row and row['legacy_username']!=event['user']:raise Forbidden('Usage owner label differs')
                count=(row['total'] if row else 0)+1;first=min(row['first_occurred_ms'],stamp) if row else stamp;last=max(row['last_occurred_ms'],stamp) if row else stamp;rev=(row['revision'] if row else 0)+1
                body={'dateKey':key[0],'user':event['user'],'featureKey':key[1],'eventKey':key[2],'count':count,'firstOccurredMs':first,'lastOccurredMs':last};content=_hash(body)
                if row:con.execute('UPDATE usage_daily_heads SET total=?,first_occurred_ms=?,last_occurred_ms=?,revision=?,content_hash=? WHERE workspace_id=? AND owner_principal_id=? AND date_key=? AND feature_key=? AND event_key=?',(count,first,last,rev,content,ws,owner,*key))
                else:con.execute('INSERT INTO usage_daily_heads VALUES(?,?,?,?,?,?,?,?,?,?,?)',(ws,owner,*key,event['user'],count,first,last,rev,content))
                changed[key]=(body,rev,content)
            for key,(body,rev,content) in changed.items():self.facts.write_semantic_fact('usage_daily_facts',{'workspace_id':ws,'owner_principal_id':owner,'kind':'daily','record_id':_hash(list(key)),'content_hash':content,'body_json':_json(body),'retry_version':rev})
            self._scope(con,token,ws,'write');return len(fresh)
    def usage_daily(self,token,ws,*,to,from_=None,feature=None):
        _day(to)
        if from_ is not None:_day(from_)
        with self.control.read_transaction() as con:
            scope,grant=self._scope(con,token,ws);params=[ws,to];sql='SELECT * FROM usage_daily_heads WHERE workspace_id=? AND date_key<=?'
            if grant.role not in ('owner','admin','personal'):sql+=' AND owner_principal_id=?';params.append(scope.principal_id)
            if from_ is not None:sql+=' AND date_key>=?';params.append(from_)
            if feature is not None:sql+=' AND feature_key=?';params.append(_text(feature,100))
            rows=con.execute(sql+' ORDER BY date_key,owner_principal_id,feature_key,event_key',tuple(params)).fetchall();result=[]
            if len(rows)>100000:raise StorageError('Usage aggregate query exceeds budget')
            for row in rows:
                key=[row['date_key'],row['feature_key'],row['event_key']];body=self.facts.read_semantic_fact('usage_daily_facts',ws,row['owner_principal_id'],'daily',_hash(key),row['content_hash'])
                if body is None or _hash(body)!=row['content_hash']:raise StorageError('Usage fact publication unavailable')
                result.append({k:body[k] for k in ('dateKey','user','featureKey','eventKey','count')})
            return result
    def usage_earliest(self,token,ws):
        with self.control.read_transaction() as con:
            scope,grant=self._scope(con,token,ws);row=con.execute('SELECT MIN(date_key) FROM usage_daily_heads WHERE workspace_id=?'+(' AND owner_principal_id=?' if grant.role not in ('owner','admin','personal') else ''),(ws,scope.principal_id) if grant.role not in ('owner','admin','personal') else (ws,)).fetchone();return row[0]
    def usage_cleanup(self,token,ws,date_key,limit=5000):
        _day(date_key)
        if type(limit) is not int or not 1<=limit<=50000:raise ValueError('Bounded cleanup required')
        with self.control.transaction(shared=(('usage', ws),)) as con:
            scope,_=self._scope(con,token,ws,'write')
            self.control.lock_keys(con, ('usage', ws, scope.principal_id))
            rows=con.execute("SELECT event_id FROM usage_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND date_key<? AND raw_state='active' ORDER BY date_key,event_id LIMIT ?",(ws,scope.principal_id,date_key,limit)).fetchall()
            if rows:self.facts.delete_usage_event_facts(ws,scope.principal_id,[row[0] for row in rows])
            for row in rows:con.execute("UPDATE usage_event_receipts SET raw_state='retired' WHERE workspace_id=? AND owner_principal_id=? AND event_id=?",(ws,scope.principal_id,row[0]))
            return len(rows)
    def dispatch(self,token,ws,action,payload):
        if not isinstance(payload,dict):raise ValueError('Semantic action payload required')
        if action=='scope':return self.scope(token,ws,payload.get('capability','read'))
        if action=='read':return self.read(token,ws,**payload)
        if action=='apply':return self.apply(token,ws,payload)
        if action=='usage_persist':return self.usage_persist(token,ws,payload['events'])
        if action=='usage_daily':return self.usage_daily(token,ws,**payload)
        if action=='usage_earliest':return self.usage_earliest(token,ws)
        if action=='usage_cleanup':return self.usage_cleanup(token,ws,**payload)
        raise ValueError('Unknown semantic action')

    def import_history_row(self,con,workspace,owner,username,table,row):
        """Called only by the isolated manifest importer; never schedules execution."""
        if not con.execute('SELECT 1 FROM iam_principals WHERE principal_id=?',(owner,)).fetchone():raise Forbidden('Mapped historical principal required')
        _text(workspace);_text(username)
        model=table[0].lower()+table[1:] if isinstance(table,str) and table else ''
        if model in MODELS:
            definition=MODELS[model];data={}
            for key,field in definition['fields'].items():
                value=row.get(key,row.get(field.get('column',key)))
                if key not in row and field.get('column',key) not in row and field['hasDefault'] and field['default'] not in ('$id','$now'):value=field['default']
                if field['type']=='DateTime' and value is not None:
                    if isinstance(value,(int,float)):value=datetime.datetime.fromtimestamp(value/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
                    elif isinstance(value,datetime.datetime):value=value.astimezone(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
                if field['type']=='Boolean' and value in (0,1):value=bool(value)
                data[key]=value
            if 'user' in data:data['user']=username
            data=self._normalize(model,data,username);rid=_text(data['id']);digest=_hash(data)
            previous=con.execute('SELECT * FROM semantic_records WHERE workspace_id=? AND owner_principal_id=? AND kind=? AND record_id=?',(workspace,owner,model,rid)).fetchone()
            if previous:
                if previous['content_hash']!=digest:raise Conflict('Historical semantic target differs')
                return {'kind':model,'id':rid,'content_hash':digest,'duplicate':True}
            for field,parent in definition['parents'].items():
                target=data[field]
                if target is None:continue
                if parent=='execution':
                    alias=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?",(workspace,target)).fetchone();trace=alias[0] if alias else target
                    access=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(workspace,trace)).fetchone()
                    if not access or access[0]!=owner:raise Conflict('Historical actual Trace mapping required')
                elif not con.execute("SELECT 1 FROM semantic_records WHERE workspace_id=? AND owner_principal_id=? AND kind=? AND record_id=? AND state='active'",(workspace,owner,parent,target)).fetchone():raise Conflict('Historical semantic parent required')
            ref=self.artifacts._persist(data)[1]
            if definition['immutable']:self.facts.write_semantic_fact('semantic_immutable_facts',{'workspace_id':workspace,'owner_principal_id':owner,'kind':model,'record_id':rid,'content_hash':digest,'body_json':_json(data),'retry_version':1})
            created=_date(data['createdAt']) if isinstance(data.get('createdAt'),str) else _date(data['firstSeenAt']) if model=='goalPlusSource' else _date(data['ingestedAt']) if model=='goalPlusSemanticSnapshot' else _date(data['observedAt']) if data.get('observedAt') else self.control.clock()
            updated=_date(data['updatedAt']) if data.get('updatedAt') else created
            con.execute("INSERT INTO semantic_records VALUES(?,?,?,?,?,?,'active',1,?,?)",(workspace,owner,model,rid,digest,ref,max(0,created),max(0,updated,created)))
            for unique in definition['unique']:
                values=[data[field] for field in unique]
                if all(value is not None for value in values):con.execute('INSERT INTO semantic_unique_keys VALUES(?,?,?,?,?,?)',(workspace,owner,model,','.join(unique),_hash(values),rid))
            self._ensure_scope(con,workspace,owner,definition['domain'],username)
            con.execute('UPDATE semantic_scopes SET revision=revision+1 WHERE workspace_id=? AND owner_principal_id=? AND domain=?',(workspace,owner,definition['domain']))
            return {'kind':model,'id':rid,'content_hash':digest,'duplicate':False}
        if table=='PlatformUsageEvent':
            occurred=row['occurredAt'];occurred=datetime.datetime.fromtimestamp(occurred/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z') if isinstance(occurred,(int,float)) else occurred.isoformat() if isinstance(occurred,datetime.datetime) else occurred
            event={key:row.get(key) for key in ('eventId','dateKey','featureKey','eventKey','source','route')};event.update(user=username,occurredAt=occurred);_date(occurred);_day(event['dateKey']);digest=_hash(event);rid=_text(event['eventId'])
            previous=con.execute('SELECT content_hash FROM usage_event_receipts WHERE workspace_id=? AND owner_principal_id=? AND event_id=?',(workspace,owner,rid)).fetchone()
            if previous:
                if previous[0]!=digest:raise Conflict('Historical usage receipt differs')
                return {'kind':'usage','id':rid,'content_hash':digest,'duplicate':True}
            self.facts.write_semantic_fact('usage_event_facts',{'workspace_id':workspace,'owner_principal_id':owner,'kind':'usage','record_id':rid,'content_hash':digest,'body_json':_json(event),'retry_version':1})
            con.execute("INSERT INTO usage_event_receipts VALUES(?,?,?,?,?,?,'active')",(workspace,owner,rid,digest,event['dateKey'],self.control.clock()))
            self._ensure_scope(con,workspace,owner,'usage',username)
            return {'kind':'usage','id':rid,'content_hash':digest,'duplicate':False}
        if table=='PlatformUsageDaily':
            key=[_day(row['dateKey']),_text(row['featureKey']),_text(row['eventKey'])];count=row['count']
            if type(count) is not int or count<0:raise ValueError('Historical daily count required')
            def ms(value):return int(value) if isinstance(value,(int,float)) else int(value.timestamp()*1000) if isinstance(value,datetime.datetime) else _date(value)
            first=ms(row['firstOccurredAt']);last=ms(row['lastOccurredAt']);body={'dateKey':key[0],'user':username,'featureKey':key[1],'eventKey':key[2],'count':count,'firstOccurredMs':first,'lastOccurredMs':last};digest=_hash(body);rid=_hash(key)
            previous=con.execute('SELECT content_hash FROM usage_daily_heads WHERE workspace_id=? AND owner_principal_id=? AND date_key=? AND feature_key=? AND event_key=?',(workspace,owner,*key)).fetchone()
            if previous:
                if previous[0]!=digest:raise Conflict('Historical daily target differs')
                return {'kind':'daily','id':rid,'content_hash':digest,'duplicate':True}
            self.facts.write_semantic_fact('usage_daily_facts',{'workspace_id':workspace,'owner_principal_id':owner,'kind':'daily','record_id':rid,'content_hash':digest,'body_json':_json(body),'retry_version':1})
            con.execute('INSERT INTO usage_daily_heads VALUES(?,?,?,?,?,?,?,?,?,?,?)',(workspace,owner,*key,username,count,first,last,1,digest))
            self._ensure_scope(con,workspace,owner,'usage',username)
            return {'kind':'daily','id':rid,'content_hash':digest,'duplicate':False}
        raise ValueError('Known historical semantic table required')
