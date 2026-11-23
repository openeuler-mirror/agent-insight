"""Trace dataset jobs: actor-bound leases and atomic version publication, no bearer persistence."""
import datetime
import hashlib
import json
import os
import stat
from pathlib import Path
import re
import uuid

from .control import Conflict, StorageError
from .contracts import identifier, revision
from .iam import IAMStore, Forbidden
from .trace_evidence import EvidenceTooLarge, EvidenceUnavailable, _hash, _size
from .dataset_generation_sources import GenerationSources, platform
from .legacy_generation import GenerationHistoryStore
from .legacy_history import assert_control_live

LEASE_MS=30000
MAX_CONFIG_BYTES=64*1024
MAX_MEMBERS_BYTES=8*1024*1024
MAX_JOB_RESULT_BYTES=32*1024*1024
STAGES=('read','dedup','stratify','sample','convert','save','complete')


def _json(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _time(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z',value):raise ValueError('UTC generation window required')
    return int(datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()*1000)


class GenerationRequestExpired(Conflict):
    status=410
    code='REQUEST_EXPIRED'


class GenerationQueueFull(Conflict):
    status=429
    code='QUEUE_LIMIT'


class GenerationSourceUnavailable(ValueError):
    status=422
    code='SOURCE_NOT_AVAILABLE'


class DatasetGeneration:
    def __init__(self,control,datasets,queries,authorized):
        self.control=control;self.datasets=datasets;self.queries=queries;self.authorized=authorized;self.iam=IAMStore(control)
        self.sources=GenerationSources(queries,authorized)

    def _auth(self,con,token,ws,capability='write'):
        scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,capability);return scope

    def _job(self,con,token,ws,*,dataset=None,job=None):
        scope=self._auth(con,token,ws)
        column='dataset_id' if dataset is not None else 'job_id';value=dataset if dataset is not None else job
        identifier(value)
        row=con.execute('SELECT * FROM dataset_generation_jobs WHERE workspace_id=? AND '+column+'=?',(ws,value)).fetchone()
        if not row:
            history=GenerationHistoryStore(self.control).find(con,ws,scope.principal_id,'job-dataset' if dataset is not None else 'job',value)
            if history:assert_control_live(con,ws,'datasetGenerationJob',history['data']['id'])
            raise LookupError('Generation job not found')
        if row['actor_principal_id']!=scope.principal_id:raise Forbidden('Generation belongs to another actor')
        self.datasets._get_tx(con,token,ws,row['dataset_id'],write=True,include_deleted=row['status']=='deleted')
        return dict(row)

    def _persist(self,value,limit):
        _size(value,limit);return self.control.persist_artifact({'encoding':'dataset-generation-json/v1','json':_json(value)})

    def _load(self,digest,ref,limit):
        path=Path(ref)
        if path.parent!=self.control.artifact_directory or path.name!=digest or path.is_symlink():raise EvidenceUnavailable('Invalid generation artifact')
        try:
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(fd,'rb') as stream:
                info=os.fstat(stream.fileno());bound=limit*6+4096
                if not stat.S_ISREG(info.st_mode) or info.st_size>bound:raise EvidenceTooLarge('Generation artifact exceeds budget')
                hasher=hashlib.sha256();parts=[];count=0
                while True:
                    block=stream.read(65536)
                    if not block:break
                    count+=len(block)
                    if count>bound:raise EvidenceTooLarge('Generation artifact exceeds budget')
                    hasher.update(block);parts.append(block)
            if hasher.hexdigest()!=digest:raise EvidenceUnavailable('Generation artifact checksum differs')
            wrapper=json.loads(b''.join(parts));value=json.loads(wrapper['json'])
            if wrapper['encoding']!='dataset-generation-json/v1':raise ValueError()
            _size(value,limit);return value
        except (OSError,KeyError,ValueError,TypeError):raise EvidenceUnavailable('Generation artifact unavailable') from None

    def _config(self,raw,*,now=None):
        if not isinstance(raw,dict):raise ValueError('Generation config must be object')
        _size(raw,MAX_CONFIG_BYTES)
        name=raw.get('name');description=raw.get('description','');limit=raw.get('limit');request=raw.get('requestId')
        if not isinstance(name,str) or not 1<=len(name.strip())<=50 or not isinstance(description,str) or len(description)>200 or type(limit) is not int or not 1<=limit<=500:raise ValueError('Invalid generation config')
        if not isinstance(request,str) or not re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',request):raise ValueError('UUIDv7 requestId required')
        start=_time(raw.get('from'));end=_time(raw.get('to'));now=self.control.clock() if now is None else now;stamp=int(request.replace('-','')[:12],16)
        if end-start not in (86400000,7*86400000,30*86400000) or end>now+300000 or stamp>now+300000:raise ValueError('Invalid generation time window')
        if now>=stamp+86400000:raise GenerationRequestExpired('REQUEST_EXPIRED')
        for key in ('platform','agentKey'):identifier(raw.get(key))
        keys=('name','description','platform','agentKey','from','to','limit','requestId','mappingVersion','processorVersion','purpose')
        clean={key:raw[key] for key in keys if key in raw}
        if isinstance(raw.get('policy'),dict):clean['policy']={key:raw['policy'][key] for key in ('version','seed','rho','signatureProtocol') if key in raw['policy']}
        return {**clean,'name':name.strip(),'description':description,'platform':platform(raw['platform'])}

    def catalog(self,token,ws,from_,to,platform_=None):
        _time(from_);_time(to)
        rows=self.sources.catalog_rows(token,ws);all_platforms=sorted({platform(row['framework']) for row in rows})
        agents={};names={}
        for row in rows:
            if platform(row['framework'])!=platform_ or not from_<=row['timestamp']<to:continue
            key=row['agentKey'];name=row['agentName'] or row['agentId']
            if not name:continue
            if key not in agents:agents[key]={'agentKey':key,'name':name,'traceCount':0}
            agents[key]['traceCount']+=1
        for row in agents.values():names[row['name']]=names.get(row['name'],0)+1
        for row in agents.values():
            if names[row['name']]>1:row['name']+=' ('+row['agentKey'][-8:]+')'
        return {'platforms':[{'id':value,'label':value} for value in all_platforms],'agents':sorted(agents.values(),key=lambda row:(row['name'],row['agentKey']))}

    def create(self,token,ws,raw):
        with self.control.read_transaction() as con:
            scope=self._auth(con,token,ws)
            history=GenerationHistoryStore(self.control);historical=history.replay_create(con,ws,scope.principal_id,raw)
            if historical:return historical
            historical_clock=history.clock(con,ws)
        config=self._config(raw,now=historical_clock);digest=_hash(config)
        with self.control.read_transaction() as con:
            scope=self._auth(con,token,ws)
            previous=con.execute('SELECT * FROM dataset_generation_jobs WHERE workspace_id=? AND actor_principal_id=? AND request_id=?',(ws,scope.principal_id,config['requestId'])).fetchone()
            if previous:return self._replay(previous,digest)
            username=con.execute('SELECT normalized_login_name FROM iam_principals WHERE principal_id=?',(scope.principal_id,)).fetchone()[0]
        members=self.sources.members(token,ws,config)
        # A selected identity must still exist in the frozen authorized catalog.
        if not members:raise GenerationSourceUnavailable('SOURCE_NOT_AVAILABLE')
        config_hash,config_ref=self._persist(config,MAX_CONFIG_BYTES);members_hash,members_ref=self._persist(members,MAX_MEMBERS_BYTES)
        dataset=str(uuid.uuid4());job=str(uuid.uuid4());now=self.control.clock();stamp=datetime.datetime.fromtimestamp(now/1000,datetime.timezone.utc).isoformat().replace('+00:00','Z')
        record={'id':dataset,'user':username,'name':config['name'],'description':config['description'],'targetAgent':members[0].get('agentName',''),'targetSkill':'','tags':[],
                'datasetKind':'ideal_output','fields':[{'id':'input','key':'input','label':'input','type':'text','system':True},{'id':'reference_output','key':'reference_output','label':'reference_output','type':'text','system':True}],
                'cases':[],'generationSource':'trace','generationStatus':'generating','createdAt':stamp,'updatedAt':stamp}
        prepared=self.datasets._prepare_record(record)
        with self.control.transaction() as con:
            scope=self._auth(con,token,ws)
            previous=con.execute('SELECT * FROM dataset_generation_jobs WHERE workspace_id=? AND actor_principal_id=? AND request_id=?',(ws,scope.principal_id,config['requestId'])).fetchone()
            if previous:return self._replay(previous,digest)
            self._source_access(con,token,ws,members)
            if con.execute("SELECT COUNT(*) FROM dataset_generation_jobs WHERE status IN ('queued','running')").fetchone()[0]>=20:raise GenerationQueueFull('QUEUE_LIMIT')
            saved=self.datasets._save_tx(con,token,ws,prepared,operation_key='generation-create:'+config['requestId'],operation_kind='generation-create',allow_generated=True)
            con.execute("""INSERT INTO dataset_generation_jobs(workspace_id,job_id,dataset_id,actor_principal_id,request_id,request_hash,config_hash,config_ref,members_hash,members_ref,status,stage,stage_index,generated_count,epoch,revision,dataset_revision,dataset_lifecycle_revision,created_at_ms,updated_at_ms)
                VALUES(?,?,?,?,?,?,?,?,?,?,'queued','queued',0,0,0,1,?,?,?,?)""",(ws,job,dataset,scope.principal_id,config['requestId'],digest,config_hash,config_ref,members_hash,members_ref,int(saved['revision']),int(saved['lifecycle_revision']),now,now))
        return {'datasetId':dataset,'jobId':job}

    @staticmethod
    def _replay(row,digest):
        if row['request_hash']!=digest:raise Conflict('IDEMPOTENCY_CONFLICT')
        if row['status']=='deleted':raise GenerationRequestExpired('REQUEST_EXPIRED')
        return {'datasetId':row['dataset_id'],'jobId':row['job_id']}

    def _progress(self,row):
        status='published' if row['status']=='succeeded' else 'failed' if row['status']=='failed' else 'generating'
        config=self._load(row['config_hash'],row['config_ref'],MAX_CONFIG_BYTES) if status=='failed' else None
        if config is not None:config={key:config[key] for key in ('name','description','platform','agentKey','from','to','limit','requestId') if key in config}
        summary=self._load(row['summary_hash'],row['summary_ref'],MAX_CONFIG_BYTES) if row['summary_ref'] else None
        return {'datasetId':row['dataset_id'],'jobId':row['job_id'],'status':status,'stage':row['stage'],'stageIndex':row['stage_index'],'totalStages':6,'generatedCount':row['generated_count'],
                'summary':summary,'error':{'code':row['error_code'],'message':row['error_message']} if status=='failed' else None,
                'generationConfig':config,'canCancel':status!='published','canFinish':status=='published','canReturn':status=='failed'}

    def progress(self,token,ws,dataset):
        with self.control.read_transaction() as con:
            scope=self._auth(con,token,ws)
            if not con.execute('SELECT 1 FROM dataset_generation_jobs WHERE workspace_id=? AND dataset_id=?',(ws,dataset)).fetchone():
                historical=GenerationHistoryStore(self.control).progress(con,ws,scope.principal_id,dataset)
                if historical is not None:return historical
            row=self._job(con,token,ws,dataset=dataset)
        if row['status']=='deleted':raise LookupError('Dataset deleted')
        value=self._progress(row)
        with self.control.read_transaction() as con:
            current=self._job(con,token,ws,dataset=dataset)
            if current['revision']!=row['revision']:raise Conflict('Generation changed during read')
        return value

    def claim(self,token,ws,dataset,lease_owner):
        identifier(lease_owner);now=self.control.clock()
        with self.control.transaction() as con:
            scope=self._auth(con,token,ws)
            if not con.execute('SELECT 1 FROM dataset_generation_jobs WHERE workspace_id=? AND dataset_id=?',(ws,dataset)).fetchone() and GenerationHistoryStore(self.control).has_dataset(con,ws,scope.principal_id,dataset):return None
            row=self._job(con,token,ws,dataset=dataset)
            if row['status'] not in ('queued','running') or (row['lease_until_ms'] is not None and row['lease_until_ms']>now):return None
            head=self.datasets._get_tx(con,token,ws,dataset,write=True)
            if int(head['lifecycle_revision'])!=row['dataset_lifecycle_revision'] or int(head['revision'])!=row['dataset_revision']:raise Conflict('Dataset changed before generation resumed')
            epoch=revision(row['epoch']+1)
            attempts=row['attempt_count']+(1 if row['status']=='running' else 0)
            con.execute("UPDATE dataset_generation_jobs SET status='running',stage='queued',stage_index=0,attempt_count=?,epoch=?,lease_owner=?,lease_until_ms=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND job_id=?",(attempts,epoch,lease_owner,now+LEASE_MS,max(now,row['updated_at_ms']),ws,row['job_id']))
        if attempts>=3:
            self.fail(token,ws,row['job_id'],epoch,lease_owner,code='WORKER_RECOVERY_EXHAUSTED',message='后台任务多次中断，请重新生成')
            return None
        return {'jobId':row['job_id'],'datasetId':dataset,'epoch':epoch,'leaseOwner':lease_owner,'config':self._load(row['config_hash'],row['config_ref'],MAX_CONFIG_BYTES),'datasetRevision':str(row['dataset_revision'])}

    def _lease(self,con,token,ws,job,epoch,owner):
        if type(epoch) is not int or epoch<1:raise ValueError('Invalid generation fence')
        identifier(owner)
        row=self._job(con,token,ws,job=job)
        if row['status']!='running' or row['epoch']!=epoch:raise Conflict('Generation fence is stale')
        if row['lease_owner']!=owner:raise Forbidden('Generation worker lease differs')
        if row['lease_until_ms'] is None or row['lease_until_ms']<=self.control.clock():raise Conflict('Generation lease expired')
        head=self.datasets._get_tx(con,token,ws,row['dataset_id'],write=True)
        if int(head['revision'])!=row['dataset_revision'] or int(head['lifecycle_revision'])!=row['dataset_lifecycle_revision']:raise Conflict('Dataset changed during generation')
        return row

    def checkpoint(self,token,ws,job,epoch,lease_owner,**values):
        with self.control.read_transaction() as con:self._lease(con,token,ws,job,epoch,lease_owner)
        summary=values.get('summary');summary_pair=self._persist(summary,MAX_CONFIG_BYTES) if summary is not None else None
        stage=values.get('stage');index=values.get('stageIndex')
        if stage is not None and (stage not in STAGES or index!=STAGES.index(stage)):raise ValueError('Invalid generation stage')
        now=self.control.clock()
        with self.control.transaction() as con:
            row=self._lease(con,token,ws,job,epoch,lease_owner)
            if index is not None and index<row['stage_index']:raise Conflict('Generation stage moved backwards')
            con.execute('UPDATE dataset_generation_jobs SET stage=?,stage_index=?,summary_hash=?,summary_ref=?,lease_until_ms=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND job_id=?',
                (stage or row['stage'],index if index is not None else row['stage_index'],summary_pair[0] if summary_pair else row['summary_hash'],summary_pair[1] if summary_pair else row['summary_ref'],now+LEASE_MS,max(now,row['updated_at_ms']),ws,job))
        return {'renewed':True}

    def source_members(self,token,ws,job,epoch,lease_owner,after=0,limit=100):
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=100:raise ValueError('Invalid source member page')
        with self.control.read_transaction() as con:row=self._lease(con,token,ws,job,epoch,lease_owner)
        members=self._load(row['members_hash'],row['members_ref'],MAX_MEMBERS_BYTES);end=after+limit
        result={'items':members[after:end],'next':end if end<len(members) else None}
        with self.control.read_transaction() as con:
            self._lease(con,token,ws,job,epoch,lease_owner)
            self._source_access(con,token,ws,result['items'])
        return result

    def _source_access(self,con,token,ws,members):
        for member in members:
            self.iam._authorize(con,token,ws,'read','trace',member['id'])
            route=con.execute("SELECT state,incarnation,route_epoch FROM trace_locators WHERE workspace_id=? AND trace_id=?",(ws,member['id'])).fetchone()
            if not route or route['state']!='active':raise Conflict('Generation source retired')
            if any(key in member and str(member[key])!=str(route[key]) for key in ('incarnation','route_epoch')):raise Conflict('Generation source lifecycle changed')
            if con.execute("SELECT 1 FROM deletion_requests WHERE workspace_id=? AND resource_kind='trace' AND resource_id=?",(ws,member['id'])).fetchone():raise Conflict('Generation source deletion barrier')

    def source(self,token,ws,job,epoch,lease_owner,trace_id,expected_fingerprint):
        with self.control.read_transaction() as con:row=self._lease(con,token,ws,job,epoch,lease_owner)
        members=self._load(row['members_hash'],row['members_ref'],MAX_MEMBERS_BYTES)
        member=next((item for item in members if item['id']==trace_id and item['fingerprint']==expected_fingerprint),None)
        if member is None:raise Forbidden('Trace is not a frozen generation member')
        with self.control.read_transaction() as con:self._source_access(con,token,ws,[member])
        captured=self._load(row['capture_hash'],row['capture_ref'],MAX_MEMBERS_BYTES) if row['capture_ref'] else {}
        if trace_id in captured:
            cached=captured[trace_id];result=self._load(cached['hash'],cached['ref'],16*1024*1024)
        else:
            result=self.sources.read_source(token,ws,trace_id,expected_fingerprint)
            digest,ref=self._persist(result,16*1024*1024)
            with self.control.transaction() as con:
                row=self._lease(con,token,ws,job,epoch,lease_owner);self._source_access(con,token,ws,[member])
                captured=self._load(row['capture_hash'],row['capture_ref'],MAX_MEMBERS_BYTES) if row['capture_ref'] else {}
                if trace_id not in captured:
                    captured[trace_id]={'hash':digest,'ref':ref};index_hash,index_ref=self._persist(captured,MAX_MEMBERS_BYTES)
                    con.execute('UPDATE dataset_generation_jobs SET capture_hash=?,capture_ref=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND job_id=?',(index_hash,index_ref,max(self.control.clock(),row['updated_at_ms']),ws,job))
                elif captured[trace_id]['hash']!=digest:
                    chosen=captured[trace_id];result=self._load(chosen['hash'],chosen['ref'],16*1024*1024)
        with self.control.read_transaction() as con:
            self._lease(con,token,ws,job,epoch,lease_owner);self._source_access(con,token,ws,[member])
        return result

    def _finish(self,token,ws,job,epoch,owner,*,cases=None,summary=None,error=None):
        result_hash=_hash({'cases':cases,'summary':summary,'error':error});_size(cases,MAX_JOB_RESULT_BYTES)
        with self.control.read_transaction() as con:
            row=self._job(con,token,ws,job=job)
            if row['status'] in ('succeeded','failed'):
                if row['result_hash']!=result_hash:raise Conflict('Generation completion content differs')
                return self._progress(row)
            self._lease(con,token,ws,job,epoch,owner)
        members=self._load(row['members_hash'],row['members_ref'],MAX_MEMBERS_BYTES)
        if error is None:
            captured=self._load(row['capture_hash'],row['capture_ref'],MAX_MEMBERS_BYTES) if row['capture_ref'] else {}
            if any(member['id'] not in captured for member in members):raise Conflict('Generation source capture is incomplete')
        saved=self.datasets.get(token,ws,row['dataset_id']);record=saved['dataset']
        record=dict(record,cases=cases if error is None else [],generationSource='trace',generationStatus='published' if error is None else 'failed',updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        if error is None and (not isinstance(cases,list) or not cases):raise ValueError('NO_VALID_SAMPLES')
        prepared=self.datasets.prepare_for_save(token,ws,record);summary_pair=self._persist(summary,MAX_CONFIG_BYTES) if summary is not None else None
        with self.control.transaction() as con:
            current=self._job(con,token,ws,job=job)
            if current['status'] in ('succeeded','failed'):
                if current['result_hash']!=result_hash:raise Conflict('Generation completion content differs')
                return self._progress(current)
            current=self._lease(con,token,ws,job,epoch,owner)
            if error is None:self._source_access(con,token,ws,members)
            saved=self.datasets._save_tx(con,token,ws,prepared,operation_key='generation-finish:'+job,expected_revision=current['dataset_revision'],operation_kind='generation-finish',allow_generated=True)
            now=max(self.control.clock(),current['updated_at_ms'])
            con.execute('UPDATE dataset_generation_jobs SET status=?,stage=?,stage_index=?,generated_count=?,dataset_revision=?,summary_hash=?,summary_ref=?,result_hash=?,error_code=?,error_message=?,lease_owner=NULL,lease_until_ms=NULL,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND job_id=?',
                ('failed' if error else 'succeeded','failed' if error else 'complete',current['stage_index'] if error else 6,len(cases or []),int(saved['revision']),summary_pair[0] if summary_pair else current['summary_hash'],summary_pair[1] if summary_pair else current['summary_ref'],result_hash,error['code'] if error else None,error['message'] if error else None,now,ws,job))
            finished=dict(con.execute('SELECT * FROM dataset_generation_jobs WHERE workspace_id=? AND job_id=?',(ws,job)).fetchone())
        return self._progress(finished)

    def complete(self,token,ws,job,epoch,lease_owner,*,cases,summary):return self._finish(token,ws,job,epoch,lease_owner,cases=cases,summary=summary)

    def fail(self,token,ws,job,epoch,lease_owner,*,code,message):
        if not isinstance(code,str) or not 1<=len(code)<=100 or not isinstance(message,str) or len(message)>1000:raise ValueError('Invalid generation error')
        return self._finish(token,ws,job,epoch,lease_owner,error={'code':code,'message':message})

    def release(self,token,ws,dataset):
        with self.control.transaction() as con:
            scope=self._auth(con,token,ws)
            if not con.execute('SELECT 1 FROM dataset_generation_jobs WHERE workspace_id=? AND dataset_id=?',(ws,dataset)).fetchone() and GenerationHistoryStore(self.control).has_dataset(con,ws,scope.principal_id,dataset):
                self.datasets._get_tx(con,token,ws,dataset,write=True);return None
            row=self._job(con,token,ws,dataset=dataset)
            con.execute('UPDATE dataset_generation_jobs SET summary_hash=NULL,summary_ref=NULL,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND job_id=?',(max(self.control.clock(),row['updated_at_ms']),ws,row['job_id']))

    def remove(self,token,ws,dataset,cancel_only=False,expected_revision=None):
        with self.control.transaction() as con:
            scope=self._auth(con,token,ws);history=GenerationHistoryStore(self.control)
            if not con.execute('SELECT 1 FROM dataset_generation_jobs WHERE workspace_id=? AND dataset_id=?',(ws,dataset)).fetchone() and history.has_dataset(con,ws,scope.principal_id,dataset):
                head=self.datasets._get_tx(con,token,ws,dataset,write=True,include_deleted=True)
                if cancel_only and head['generation_status']=='published':raise Conflict('ALREADY_COMPLETED')
                deletion=history.deletion_id(ws,scope.principal_id,dataset)
                if head['state']!='deleted':
                    self.datasets._delete_tx(con,token,ws,dataset,operation_key='generation-delete:history:'+dataset,operation_kind='generation-delete',expected_revision=expected_revision)
                return {'deletionId':deletion,'status':'deleted'}
            row=self._job(con,token,ws,dataset=dataset)
            if row['status']=='deleted':
                head=self.datasets._get_tx(con,token,ws,dataset,write=True,include_deleted=True)
                if head['state']!='deleted':raise Conflict('Dataset deletion was superseded by restore')
                return None
            if cancel_only and row['status']=='succeeded':raise Conflict('ALREADY_COMPLETED')
            deletion=str(uuid.uuid4());now=max(self.control.clock(),row['updated_at_ms'])
            head=self.datasets._get_tx(con,token,ws,dataset,write=True)
            expected=int(expected_revision) if expected_revision is not None else int(head['revision'])
            self.datasets._delete_tx(con,token,ws,dataset,operation_key='generation-delete:'+row['job_id'],expected_revision=expected,operation_kind='generation-delete')
            con.execute("UPDATE dataset_generation_jobs SET status='deleted',epoch=epoch+1,deletion_id=?,lease_owner=NULL,lease_until_ms=NULL,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND job_id=?",(deletion,now,ws,row['job_id']))
        return {'deletionId':deletion,'status':'deleted'}

    def deletion(self,token,ws,deletion):
        with self.control.read_transaction() as con:
            scope=self._auth(con,token,ws)
            historical=GenerationHistoryStore(self.control).deletion(con,ws,scope.principal_id,deletion)
            if historical:return historical
            row=con.execute('SELECT dataset_id FROM dataset_generation_jobs WHERE workspace_id=? AND deletion_id=?',(ws,deletion)).fetchone()
            if not row:raise LookupError('Generation deletion not found')
            self._job(con,token,ws,dataset=row[0])
            head=self.datasets._get_tx(con,token,ws,row[0],write=True,include_deleted=True)
            if head['state']!='deleted':raise Conflict('Dataset deletion was superseded by restore')
        return {'deletionId':deletion,'status':'deleted','error':None}

    def dispatch(self,token,ws,action,payload):
        p=payload;job=p.get('jobId');epoch=p.get('epoch');owner=p.get('leaseOwner')
        if action=='catalog':return self.catalog(token,ws,p.get('from'),p.get('to'),p.get('platform'))
        if action=='create':return self.create(token,ws,p.get('config'))
        if action=='progress':return self.progress(token,ws,p.get('datasetId'))
        if action=='release':return self.release(token,ws,p.get('datasetId'))
        if action=='claim':return self.claim(token,ws,p.get('datasetId'),owner)
        if action=='checkpoint':return self.checkpoint(token,ws,job,epoch,owner,**{key:p[key] for key in ('stage','stageIndex','summary') if key in p})
        if action=='source_members':return self.source_members(token,ws,job,epoch,owner,p.get('after',0),p.get('limit',100))
        if action=='source':return self.source(token,ws,job,epoch,owner,p.get('traceId'),p.get('expectedFingerprint'))
        if action=='complete':return self.complete(token,ws,job,epoch,owner,cases=p.get('cases'),summary=p.get('summary'))
        if action=='fail':return self.fail(token,ws,job,epoch,owner,code=p.get('code'),message=p.get('message'))
        if action in ('cancel','remove'):return self.remove(token,ws,p.get('datasetId'),cancel_only=action=='cancel',expected_revision=p.get('expectedRevision'))
        if action=='deletion':return self.deletion(token,ws,p.get('deletionId'))
        raise ValueError('Unknown dataset generation action')
