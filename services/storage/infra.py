import hashlib
import json
import math
import uuid

from .contracts import identifier
from .control import Conflict,StorageError
from .iam import IAMStore,Forbidden
from .observations import ObservationIngest
from .trace_metadata import TraceMetadata

MAX_SAMPLE_BYTES=4*1024*1024
EVENT='infra.sample/v1'

def _json(value):return json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':'))
def _num(value):
    if type(value) not in (int,float) or not math.isfinite(value):raise ValueError('Finite numeric value required')
    return value

def _text(value,nullable=False):
    if value is None and nullable:return None
    if not isinstance(value,str) or len(value.encode())>16384:raise ValueError('Bounded text required')
    return value

class InfraStore:
    def __init__(self,control,facts,*,queries=None,authorized=None):self.queries=queries;self.authorized=authorized;self.control=control;self.facts=facts;self.iam=IAMStore(control);self.artifacts=ObservationIngest(control,facts);self.metadata=TraceMetadata(control)
    def _scope(self,con,token,ws,capability='read'):
        identifier(ws)
        if not con.execute('SELECT 1 FROM schema_meta WHERE version=18').fetchone():raise StorageError('Explicit Infra migration018 required')
        scope=self.iam._scope(con,token);grant=self.iam._workspace(scope,ws,capability);return scope,grant
    def _source(self,con,token,ws,source,capability='read',required=True):
        scope,grant=self._scope(con,token,ws,capability);row=con.execute("SELECT * FROM infra_sources WHERE workspace_id=? AND source_id=? AND state='active'",(ws,identifier(source))).fetchone()
        if row is None:
            if required:raise Forbidden('Active Infra source required')
            return None
        if row['owner_principal_id']!=scope.principal_id and (capability!='read' or grant.role not in ('owner','admin','personal')):raise Forbidden('Infra source owner required')
        return dict(row)
    def _view(self,row):
        if row is None:return None
        auth=self.artifacts._load(row['auth_ref'])['authHeaders'] if row['auth_ref'] else None
        return {'id':row['source_id'],'endpoint':row['endpoint'],'scrapeUrl':row['scrape_url'],'kind':row['kind'],'authHeaders':auth,'model':row['model'],'hardwareName':row['hardware_name'],'memBandwidthGBs':row['mem_bandwidth_gbs'],'scrapeIntervalMs':row['scrape_interval_ms'],'enabled':bool(row['enabled']),'createdAt':self._iso(row['created_at_ms']),'updatedAt':self._iso(row['updated_at_ms'])}
    @staticmethod
    def _iso(stamp):
        import datetime
        return datetime.datetime.fromtimestamp(stamp/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    def list_sources(self,token,ws,*,own_only=False):
        with self.control.read_transaction() as con:
            scope,grant=self._scope(con,token,ws);owner=own_only or grant.role not in ('owner','admin','personal');rows=con.execute("SELECT * FROM infra_sources WHERE workspace_id=? AND state='active'"+(' AND owner_principal_id=?' if owner else '')+' ORDER BY created_at_ms DESC,source_id',((ws,scope.principal_id) if owner else (ws,))).fetchall();return [self._view(dict(row)) for row in rows]
    def _trace(self,con,token,ws,execution,capability='read'):
        alias=con.execute("SELECT trace_id FROM trace_legacy_ids WHERE workspace_id=? AND alias_kind='execution' AND alias_id=?",(ws,_text(execution))).fetchone();trace=alias[0] if alias else execution;scope,route=self.metadata._trace(con,token,ws,trace,capability)
        owner=con.execute("SELECT owner_principal_id FROM iam_resource_access WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(ws,trace)).fetchone()[0]
        if capability!='read' and owner!=scope.principal_id:raise Forbidden('Actual Trace owner required')
        return trace,owner
    def get_source(self,token,ws,*,source_id=None,endpoint=None,owner_execution=None):
        with self.control.read_transaction() as con:
            scope,grant=self._scope(con,token,ws)
            if source_id:return self._view(self._source(con,token,ws,source_id,required=False))
            owner=self._trace(con,token,ws,owner_execution)[1] if owner_execution else scope.principal_id
            if owner!=scope.principal_id and grant.role not in ('owner','admin','personal'):raise Forbidden('Infra source owner required')
            row=con.execute("SELECT * FROM infra_sources WHERE workspace_id=? AND owner_principal_id=? AND endpoint=? AND state='active'",(ws,owner,_text(endpoint))).fetchone();return self._view(dict(row)) if row else None
    def _fields(self,input,*,create=False):
        names={'scrapeUrl':'scrape_url','kind':'kind','model':'model','hardwareName':'hardware_name','memBandwidthGBs':'mem_bandwidth_gbs','scrapeIntervalMs':'scrape_interval_ms','enabled':'enabled'};result={}
        for key,column in names.items():
            if key not in input:continue
            value=input[key]
            if key in ('scrapeIntervalMs','memBandwidthGBs'):
                if value is not None:_num(value)
                if key=='scrapeIntervalMs' and (type(value) is not int or not -(2**31)<=value<=2**31-1):raise ValueError('Integer interval required')
            elif key=='enabled':
                if type(value) is not bool:raise ValueError('Boolean enabled required')
                value=int(value)
            else:_text(value,nullable=key in ('model','hardwareName'))
            if key=='kind' and value not in ('pull','push'):raise ValueError('Infra source kind required')
            result[column]=value
        if 'authHeaders' in input:
            auth=input['authHeaders'];_text(auth,nullable=True)
            if auth is not None:
                parsed=json.loads(auth)
                if not isinstance(parsed,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in parsed.items()):raise ValueError('Header object required')
            result['auth_ref']=self.artifacts._persist({'authHeaders':auth})[1] if auth else None
        return result
    def ensure_source(self,token,ws,input):
        if not isinstance(input,dict) or set(input)-{'endpoint','scrapeUrl','kind','model','hardwareName','memBandwidthGBs','scrapeIntervalMs','authHeaders'}:raise ValueError('Infra source input required')
        endpoint=_text(input.get('endpoint'));raw_values=({'scrapeUrl':input.get('scrapeUrl',''),'kind':input.get('kind','pull'),'model':input.get('model'),'hardwareName':input.get('hardwareName'),'memBandwidthGBs':input.get('memBandwidthGBs'),'scrapeIntervalMs':input.get('scrapeIntervalMs',1000),**({'authHeaders':input['authHeaders']} if 'authHeaders' in input else {})})
        with self.control.transaction() as con:
            scope,_=self._scope(con,token,ws,'write');values=self._fields(raw_values);old=con.execute("SELECT * FROM infra_sources WHERE workspace_id=? AND owner_principal_id=? AND endpoint=? AND state='active'",(ws,scope.principal_id,endpoint)).fetchone()
            now=self.control.clock()
            if old:
                source=old['source_id'];self._update(con,ws,dict(old),values)
            else:
                source=str(uuid.uuid4());row={'workspace_id':ws,'source_id':source,'owner_principal_id':scope.principal_id,'endpoint':endpoint,**values,'enabled':1,'state':'active','revision':1,'created_at_ms':now,'updated_at_ms':now};row.setdefault('auth_ref',None);columns=list(row);con.execute('INSERT INTO infra_sources('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',tuple(row.values()))
            return self._view(self._source(con,token,ws,source,'write'))
    def _update(self,con,ws,old,values):
        if not values:return
        updates={**values,'revision':old['revision']+1,'updated_at_ms':max(self.control.clock(),old['updated_at_ms'])};con.execute('UPDATE infra_sources SET '+','.join(k+'=?' for k in updates)+' WHERE workspace_id=? AND source_id=? AND revision=?',(*updates.values(),ws,old['source_id'],old['revision']))
    def patch_source(self,token,ws,source,input):
        if not isinstance(input,dict) or set(input)-{'scrapeUrl','kind','model','hardwareName','memBandwidthGBs','scrapeIntervalMs','authHeaders','enabled'}:raise ValueError('Infra patch required')
        with self.control.transaction() as con:
            old=self._source(con,token,ws,source,'write');values=self._fields(input);self._update(con,ws,old,values);return self._view(self._source(con,token,ws,source,'write'))
    def delete_source(self,token,ws,*,source_id=None,endpoint=None):
        with self.control.transaction() as con:
            scope,_=self._scope(con,token,ws,'delete')
            if not source_id:
                row=con.execute("SELECT source_id FROM infra_sources WHERE workspace_id=? AND owner_principal_id=? AND endpoint=? AND state='active'",(ws,scope.principal_id,_text(endpoint))).fetchone();source_id=row[0] if row else None
            if not source_id:return 0
            old=self._source(con,token,ws,source_id,'delete',required=False)
            if old is None:return 0
            self._update(con,ws,old,{'state':'deleted'});return 1
    def accept_sample(self,token,ws,source,operation,text):
        identifier(operation)
        if not isinstance(text,str) or len(text.encode())>MAX_SAMPLE_BYTES:raise ValueError('Bounded sample JSON required')
        value=json.loads(text,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Finite JSON required')))
        if not isinstance(value,dict) or set(value)!={'tsMs','via','model','gauges','counters','histograms','waitingByReason'}:raise ValueError('Serialized sample required')
        stamp=_num(value['tsMs'])
        if value['via'] not in ('push','pull'):raise ValueError('Sample clock/path required')
        _text(value['model'],True)
        for key in ('gauges','counters','histograms','waitingByReason'):
            if key=='waitingByReason' and value[key] is None:continue
            parsed=json.loads(value[key],parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Finite JSON required')))
            if not isinstance(parsed,dict):raise ValueError('Sample partition object required')
        digest=hashlib.sha256(_json([source,text]).encode()).hexdigest()
        with self.control.transaction() as con:
            row=self._source(con,token,ws,source,'write');owner=row['owner_principal_id'];purpose='infra-accept/v1:'+owner;receipt=con.execute('SELECT content_hash FROM inbox_receipts WHERE workspace_id=? AND source_id=? AND event_id=?',(ws,purpose,operation)).fetchone();sample=str(uuid.uuid5(uuid.NAMESPACE_URL,_json([ws,owner,operation])));event='infra:'+sample
            if receipt:
                if receipt[0]!=digest:raise Conflict('Infra operation has different input')
                return {'sampleId':sample,'state':'accepted'}
            now=self.control.clock();fact={'workspace_id':ws,'source_id':source,'sample_id':sample,'owner_principal_id':owner,'content_hash':digest,'ts_ms':stamp,'received_at_ms':now,'sample_json':text,'retry_version':1}
            if len(_json(fact).encode())>MAX_SAMPLE_BYTES-128:raise ValueError('Encoded Infra sample exceeds adapter budget')
            ref=self.artifacts._persist(fact)[1]
            con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)',(ws,purpose,operation,digest,now));payload=_json({'source_id':source,'artifact_ref':ref,'content_hash':digest})
            con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)',(ws,event,sample,1,EVENT,payload,now,now));return {'sampleId':sample,'state':'accepted'}
    def ingest_source(self,token,ws,endpoint,model):
        with self.control.read_transaction() as con:
            scope,_=self._scope(con,token,ws,'write');target=_text(endpoint) if endpoint else 'push:'+ '//'+(model or 'unknown');row=con.execute("SELECT * FROM infra_sources WHERE workspace_id=? AND owner_principal_id=? AND endpoint=? AND state='active'",(ws,scope.principal_id,target)).fetchone()
            if row:return self._view(dict(row))
        return self.ensure_source(token,ws,{'endpoint':target,'scrapeUrl':'','kind':'push','model':model})
    def sample_status(self,token,ws,source,operation):
        with self.control.read_transaction() as con:
            row=self._source(con,token,ws,source,'write');sample=str(uuid.uuid5(uuid.NAMESPACE_URL,_json([ws,row['owner_principal_id'],identifier(operation)])));event=con.execute('SELECT state FROM outbox_events WHERE workspace_id=? AND event_id=? AND event_type=?',(ws,'infra:'+sample,EVENT)).fetchone()
            if event is None:raise Conflict('Infra sample receipt unavailable')
            return {'sampleId':sample,'state':'indexed' if event[0]=='sent' else 'accepted'}
    def project_once(self,worker,lease_ms=30000):
        now=self.control.clock()
        with self.control.transaction() as con:
            row=con.execute("SELECT * FROM outbox_events WHERE event_type=? AND ((state='pending' AND next_attempt_at_ms<=?) OR (state='dispatching' AND lease_until_ms<=?)) ORDER BY created_at_ms,event_id LIMIT 1",(EVENT,now,now)).fetchone()
            if row is None:return False
            event=dict(row);attempt=event['attempts']+1;con.execute("UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(attempt,worker,now+lease_ms,now,event['workspace_id'],event['event_id']))
        try:
            payload=json.loads(event['payload_json']);fact=self.artifacts._load(payload['artifact_ref'])
            if fact['source_id']!=payload['source_id'] or fact['workspace_id']!=event['workspace_id'] or fact['sample_id']!=event['aggregate_id'] or fact['content_hash']!=payload['content_hash'] or hashlib.sha256(_json([fact['source_id'],fact['sample_json']]).encode()).hexdigest()!=fact['content_hash']:raise StorageError('Infra publication source differs')
            self.facts.write_infra_sample(fact)
            with self.control.transaction() as con:
                updated=con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=? AND state='dispatching' AND lease_owner=? AND attempts=? AND lease_until_ms>?",(max(now,self.control.clock()),event['workspace_id'],event['event_id'],worker,attempt,self.control.clock()))
                return updated.rowcount==1
        except Exception:
            with self.control.transaction() as con:con.execute("UPDATE outbox_events SET state='pending',lease_owner=NULL,lease_until_ms=NULL,next_attempt_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=? AND state='dispatching' AND lease_owner=? AND attempts=? AND lease_until_ms>?",(self.control.clock()+1000,max(now,self.control.clock()),event['workspace_id'],event['event_id'],worker,attempt,self.control.clock()))
            return False
    def query_samples(self,token,ws,source,*,from_ms=None,to_ms=None,model=None,via=None,limit=512,order='asc',after=None):
        if type(limit) is not int or not 1<=limit<=5000 or order not in ('asc','desc') or via not in (None,'push','pull'):raise ValueError('Infra query required')
        for stamp in (from_ms,to_ms):
            if stamp is not None:_num(stamp)
        if after is not None:
            if not isinstance(after,dict) or set(after)!={'ts_ms','sample_id'}:raise ValueError('Infra cursor required')
            _num(after['ts_ms']);identifier(after['sample_id'])
        with self.control.read_transaction() as con:before=self._source(con,token,ws,source,required=False)
        if before is None:return {'rows':[],'cursor':None}
        facts=self.facts.read_infra_samples(ws,source,limit=limit,order=order,model=model or None,via=via,from_ms=from_ms,to_ms=to_ms,after=after);rows=[]
        for fact in facts:
            if fact.get('workspace_id')!=ws or fact.get('source_id')!=source or fact.get('owner_principal_id')!=before['owner_principal_id']:raise StorageError('Infra fact scope differs')
            value=json.loads(fact['sample_json'])
            if value['tsMs']!=fact['ts_ms'] or hashlib.sha256(_json([source,fact['sample_json']]).encode()).hexdigest()!=fact['content_hash']:raise StorageError('Infra sample content differs')
            rows.append({**value,'source':{'endpoint':before['endpoint']}})
        with self.control.read_transaction() as con:
            current=self._source(con,token,ws,source)
            if current['revision']!=before['revision']:raise Conflict('Infra source changed during read')
            for fact in facts:
                receipt=con.execute('SELECT payload_json FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type=?',(ws,fact['sample_id'],EVENT)).fetchone()
                if not receipt or json.loads(receipt[0]).get('content_hash')!=fact['content_hash']:raise StorageError('Infra sample receipt differs')
        cursor={'ts_ms':facts[-1]['ts_ms'],'sample_id':facts[-1]['sample_id']} if facts else None
        return {'rows':rows,'cursor':cursor}
    def endpoints(self,token,ws,items):
        from .trace_analytics import TraceAnalytics
        from .dataset_generation_sources import GenerationSources
        from .trace_evidence import TraceEvidence
        if not isinstance(items,list) or len(items)>200:raise ValueError('Bounded endpoint selection required')
        if self.queries is None or self.authorized is None:raise StorageError('Authorized endpoint reader required')
        analytics=TraceAnalytics(self.queries,self.authorized);scope=self.iam.scope(token);boundaries={item['trace_id']:item['boundary'] for item in items};analytics._recheck(token,ws,scope,boundaries);reader=GenerationSources(self.queries,self.authorized);result=[]
        for item in items:
            begin,summary,rows,heads,_=reader._boundary(token,ws,item['trace_id']);execution,_,capsule,_=reader._metadata(begin,summary,rows,heads)
            if not capsule:
                execution={}
                for row in rows:
                    if row.get('parent_span_id'):continue
                    fields=TraceEvidence._fields(reader._source(row,heads[row['span_id']]),analytics_fields=True)
                    if 'endpoint' in fields:
                        if 'endpoint' in execution and execution['endpoint']!=fields['endpoint']:raise Conflict('Ambiguous Infra endpoint')
                        execution['endpoint']=fields['endpoint']
            endpoint=execution.get('endpoint')
            if endpoint is not None and not isinstance(endpoint,str):raise ValueError('Endpoint must be text or null')
            reader._verify_end(token,ws,None,None,begin,item['trace_id']);result.append({**item,'endpoint':endpoint})
        analytics._recheck(token,ws,scope,boundaries);return result
    def get_links(self,token,ws,execution):
        with self.control.read_transaction() as con:
            trace,_=self._trace(con,token,ws,execution);rows=con.execute('SELECT source_id,model FROM session_infra_links WHERE workspace_id=? AND root_trace_id=? AND retired_at_ms IS NULL ORDER BY position',(ws,trace));return [{'sourceId':row['source_id'],'model':row['model']} for row in rows]
    def set_links(self,token,ws,execution,links):
        if not isinstance(links,list) or len(links)>256:raise ValueError('Infra links required')
        with self.control.transaction() as con:
            self._scope(con,token,ws,'write');trace,_=self._trace(con,token,ws,execution,'write');uniq=[];seen=set()
            for link in links:
                if not isinstance(link,dict) or set(link)!={'sourceId','model'}:raise ValueError('Infra link required')
                source=identifier(link['sourceId']);model=_text(link['model'],True);self._source(con,token,ws,source);key=(source,model or '')
                if key not in seen:seen.add(key);uniq.append((source,model))
            now=self.control.clock();con.execute('UPDATE session_infra_links SET retired_at_ms=CASE WHEN created_at_ms>? THEN created_at_ms ELSE ? END WHERE workspace_id=? AND root_trace_id=? AND retired_at_ms IS NULL',(now,now,ws,trace))
            for position,(source,model) in enumerate(uniq):con.execute('INSERT INTO session_infra_links VALUES(?,?,?,?,?,?,?,NULL)',(ws,trace,str(uuid.uuid4()),source,model,position,now))
