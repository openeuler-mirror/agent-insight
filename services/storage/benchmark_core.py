"""Typed Benchmark authority for immutable inputs, external jobs and selected results."""
import base64
import copy
import hashlib
import hmac
import json
import math
import re
import uuid
from pathlib import Path

from .contracts import identifier,revision,canonical_json
from .control import Conflict,StorageError
from .iam import IAMStore,Forbidden,Unauthorized
from .datasets import DatasetStore
from .experiments import ExperimentStore,_json,_hash,_iso
from .controller_protocol import read_controller_key

MAX_BYTES=128*1024*1024
MAX_ARTIFACT_BYTES=64*1024*1024
MAX_CASES=10000
CAP_PURPOSE='benchmark-callback/v1'
TERMINAL=frozenset({'completed','failed','cancelled','blocked','execution_failed','dispatch_failed','evaluation_failed','submission_invalid'})

class BenchmarkNotFound(StorageError):status=404
class BenchmarkTooLarge(StorageError):status=413
class BenchmarkUnavailable(StorageError):status=503

def _identity(*parts):return str(uuid.uuid5(uuid.NAMESPACE_URL,_json(list(parts))))
def _fingerprint(value):return 'sha256:'+_hash(value)
def _hex(value):
    if isinstance(value,str) and value.startswith('sha256:'):value=value[7:]
    if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{64}',value):raise ValueError('Exact SHA-256 required')
    return value

def _bounded(value,limit=MAX_BYTES):
    size=0
    for part in json.JSONEncoder(ensure_ascii=False,allow_nan=False,separators=(',',':'),sort_keys=True).iterencode(value):
        size+=len(part.encode())
        if size>limit:raise BenchmarkTooLarge('Benchmark payload exceeds byte budget')
    return size

class BenchmarkStore:
    def __init__(self,control,*,controller_key_file=None,definitions_verifier=None,device_verifier=None,evidence=None,facts=None):
        self.control=control;self.iam=IAMStore(control);self.experiments=ExperimentStore(control,evidence,facts);self.datasets=DatasetStore(control)
        self.controller_key_file=controller_key_file;self.definitions_verifier=definitions_verifier;self.device_verifier=device_verifier

    def _put(self,value):return self.experiments._put(value,MAX_BYTES)
    def _load(self,digest,ref):return self.experiments._load(digest,ref,MAX_BYTES)
    def _trusted(self,token,ws,body):
        if not callable(self.definitions_verifier) or self.definitions_verifier(token,ws,copy.deepcopy(body)) is not True:raise Forbidden('Trusted Benchmark definition verification required')
    def _scope(self,con,token,ws,cap='read'):
        scope=self.iam._scope(con,token);self.iam._workspace(scope,ws,cap);return scope
    def _head_scope(self,con,scope,ws,exp,cap='read',deleted=False):
        if cap=='execute':
            from .legacy_history import assert_control_live
            assert_control_live(con,ws,'experiment',exp)
        self.iam._authorize_scope(con,scope,ws,cap,'run',exp)
        row=con.execute('SELECT * FROM experiment_heads WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()
        if not row or row['scope']!='benchmark' or row['state']!='active' and not deleted:raise BenchmarkNotFound('Benchmark experiment unavailable')
        return dict(row)
    def _head(self,con,token,ws,exp,cap='read',deleted=False):return self._head_scope(con,self._scope(con,token,ws,cap),ws,exp,cap,deleted)
    def _dataset(self,con,token,ws,identity,cap='read',deleted=False):
        row=con.execute('SELECT * FROM benchmark_dataset_heads WHERE workspace_id=? AND dataset_id=?',(ws,identity)).fetchone()
        if row is None:raise BenchmarkNotFound('Benchmark Dataset unavailable')
        self.iam._authorize(con,token,ws,cap,'asset',row['public_asset_id'])
        if row['state']!='active' and not deleted:raise BenchmarkNotFound('Benchmark Dataset is deleted')
        return dict(row)
    def _private_dataset(self,con,head):
        release=con.execute('SELECT * FROM asset_releases WHERE workspace_id=? AND release_id=?',(head['workspace_id'],head['private_release_id'])).fetchone()
        if not release or release['asset_id']!=head['private_asset_id']:raise BenchmarkUnavailable('Frozen Benchmark release unavailable')
        return self._load(release['content_hash'],release['manifest_ref'])
    def _dataset_dto(self,con,head):
        private=self._private_dataset(con,head);visibility=con.execute('SELECT visibility FROM iam_resource_access WHERE workspace_id=? AND resource_kind=? AND resource_id=?',(head['workspace_id'],'asset',head['public_asset_id'])).fetchone()
        return {'shared':bool(visibility and visibility[0]=='group'),'id':head['dataset_id'],'agentEvalDatasetId':head['public_dataset_id'],'adapterKey':head['adapter_key'],'contentHash':'sha256:'+head['content_hash'],'status':'ready' if head['state']=='active' else 'deleted','caseCount':len(private['cases']),'name':private['public_dataset']['name'],'sourceJson':_json(private.get('source',{})),'user':self.experiments._owner(con,head['created_by']),'createdAt':_iso(head['created_at_ms']),'updatedAt':_iso(head['updated_at_ms'])}
    def _receipt(self,con,scope,ws,action,body):
        key=identifier(body.get('operation_key'));request=body.get('operation_request',{k:v for k,v in body.items() if k!='operation_key'});digest=_hash(request)
        old=con.execute('SELECT * FROM benchmark_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind=? AND operation_key=?',(ws,scope.principal_id,action,key)).fetchone()
        if old and old['request_hash']!=digest:raise Conflict('Benchmark operation key has different input')
        return key,digest,dict(old) if old else None
    def _receipt_response(self,con,token,ws,row):
        if row['experiment_id']:self._head(con,token,ws,row['experiment_id'])
        elif row['dataset_id']:self._dataset(con,token,ws,row['dataset_id'])
        else:self._job(con,token,ws,row['job_id'])
        return self._load(row['response_hash'],row['response_ref'])
    def _write_receipt(self,con,scope,ws,action,key,digest,value,*,experiment_id=None,dataset_id=None,job_id=None):
        response_hash,response_ref=self._put(value)
        con.execute('INSERT INTO benchmark_operation_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)',(ws,scope.principal_id,action,key,digest,experiment_id,dataset_id,job_id,response_hash,response_ref,self.control.clock()))
    def _origin(self,con,token):
        row,is_api=self.iam._authenticate(con,token)
        return row['credential_id'] if is_api else row['session_id'],'api' if is_api else 'session'

    def dispatch(self,action,token,workspace_id,body=None):
        ws=identifier(workspace_id);body=copy.deepcopy(body or {});_bounded(body)
        if action in {'cancel_request','cancel_load','cancel_dispatch_bind','cleanup_confirm','cancel_control'}:
            from .benchmark_cancellation import dispatch
            return dispatch(self,action,token,ws,body)
        if action=='lookup_operation':
            kind=body.get('kind')
            if kind not in {'dataset_import','create','start','evaluation_prepare','import_submissions','retry_evaluation','retry_case'}:raise ValueError('Unsupported Benchmark operation lookup')
            with self.control.read_transaction() as con:
                scope=self._scope(con,token,ws);_,_,old=self._receipt(con,scope,ws,kind,body)
                return self._receipt_response(con,token,ws,old) if old else None
        if action in {'dataset_read','dataset_list','dataset_load'}:
            with self.control.read_transaction() as con:
                scope=self._scope(con,token,ws)
                if action in {'dataset_read','dataset_load'}:
                    head=self._dataset(con,token,ws,body['dataset_id']);value=self._dataset_dto(con,head)
                    if action=='dataset_load':
                        private=self._private_dataset(con,head);value.update(cases=[{'id':row['id'],'ordinal':row['ordinal'],'publicPayloadJson':_json(row['publicPayload'])} for row in private['cases']],agentEvalDataset={'casesJson':_json(private['public_dataset']['cases'])})
                    return value
                rows=con.execute("SELECT * FROM benchmark_dataset_heads WHERE workspace_id=? AND state='active' ORDER BY created_at_ms,dataset_id LIMIT 2001",(ws,)).fetchall()
                if len(rows)>2000:raise BenchmarkTooLarge('Benchmark Dataset listing exceeds budget')
                values=[]
                for row in rows:
                    try:head=self._dataset(con,token,ws,row['dataset_id'])
                    except Forbidden:continue
                    values.append(self._dataset_dto(con,head))
                return values
        if action in {'claim_intents','finish_intent'}:return self._intent_dispatch(action,token,ws,body)
        if action not in {'dataset_import','create'}:return self._dispatch_job(action,token,ws,body)
        with self.control.read_transaction() as con:
            scope=self._scope(con,token,ws,'write');self.iam._workspace(scope,ws,'read');key,digest,old=self._receipt(con,scope,ws,action,body)
            if old:return self._receipt_response(con,token,ws,old)
        self._trusted(token,ws,body)
        if action=='dataset_import':prepared=self._prepare_dataset(body)
        else:prepared=None
        with self.control.transaction() as con:
            scope=self._scope(con,token,ws,'write');self.iam._workspace(scope,ws,'read');key,digest,old=self._receipt(con,scope,ws,action,body)
            if old:return self._receipt_response(con,token,ws,old)
            if action=='dataset_import':
                value=self._import_dataset_tx(con,token,ws,scope,body,prepared);self._write_receipt(con,scope,ws,action,key,digest,value,dataset_id=value['id'])
            else:
                value=self._create_tx(con,token,ws,scope,body);self._write_receipt(con,scope,ws,action,key,digest,value,experiment_id=value['id'])
            return value

    def _prepare_dataset(self,body):
        identity=identifier(body.get('dataset_id'));adapter=identifier(body.get('adapter_key'));public=copy.deepcopy(body.get('public_dataset'));cases=body.get('cases')
        if not isinstance(public,dict) or public.get('datasetKind')!='benchmark' or not isinstance(cases,list) or not 1<=len(cases)<=MAX_CASES:raise ValueError('Complete public/private Benchmark Dataset required')
        public_ids=[row.get('id') for row in public.get('cases',[])];ids=[];external=[]
        for ordinal,row in enumerate(cases):
            if not isinstance(row,dict) or row.get('ordinal')!=ordinal or not isinstance(row.get('publicPayload'),dict) or not isinstance(row.get('privatePayload'),dict) or 'rawCase' not in row:raise ValueError('Complete ordered Benchmark Case required')
            ids.append(identifier(row.get('id')));external.append(identifier(row.get('externalCaseId')))
        if len(set(ids))!=len(ids) or len(set(external))!=len(external) or ids!=public_ids:raise ValueError('Benchmark public/private Case membership differs')
        prepared=self.datasets._prepare_record(public);private={'format':'benchmark-dataset/v1','dataset_id':identity,'adapter_key':adapter,'source':copy.deepcopy(body.get('source',{})),'public_dataset':public,'cases':copy.deepcopy(cases)}
        private_hash,private_ref=self._put(private);content_hash=_hex(body['content_hash']) if 'content_hash' in body else _hash([{'externalCaseId':row['externalCaseId'],'sourceFingerprint':_fingerprint(row['rawCase'])} for row in cases])
        return prepared,private,private_hash,private_ref,content_hash

    def _import_dataset_tx(self,con,token,ws,scope,body,prepared):
        public,private,digest,ref,content_hash=prepared;identity=body['dataset_id']
        same=con.execute("SELECT * FROM benchmark_dataset_heads WHERE workspace_id=? AND adapter_key=? AND content_hash=? AND created_by=? AND state='active' ORDER BY created_at_ms,dataset_id LIMIT 1",(ws,body['adapter_key'],content_hash,scope.principal_id)).fetchone()
        if same:return self._dataset_dto(con,self._dataset(con,token,ws,same['dataset_id']))
        existing=con.execute('SELECT * FROM benchmark_dataset_heads WHERE workspace_id=? AND dataset_id=?',(ws,identity)).fetchone()
        if existing:
            self._dataset(con,token,ws,identity,'write')
            if existing['content_hash']!=content_hash:raise Conflict('Benchmark Dataset content differs; import an explicit new version')
            return self._dataset_dto(con,dict(existing))
        public_saved=self.datasets._save_tx(con,token,ws,public,operation_key='benchmark-public:'+identity,operation_kind='benchmark-import',operation_request={'dataset_id':identity,'content_hash':content_hash},allow_readonly=True)
        meta=con.execute('SELECT * FROM dataset_compat_heads WHERE workspace_id=? AND dataset_id=?',(ws,public_saved['dataset']['id'])).fetchone()
        asset=_identity('benchmark-private',ws,identity);release=_identity('benchmark-private-release',ws,identity,digest);now=self.control.clock()
        con.execute("INSERT INTO asset_identities(workspace_id,asset_id,kind,name,created_at_ms,updated_at_ms) VALUES(?,?,'benchmark',?,?,?)",(ws,asset,'benchmark:'+asset,now,now));self.iam._record_resource(con,ws,'asset',asset,scope.principal_id,'private',invalidate_policy=False)
        con.execute('INSERT INTO asset_releases(workspace_id,release_id,asset_id,version_label,content_hash,manifest_ref,schema_version,publisher_id,created_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',(ws,release,asset,'1',digest,ref,scope.principal_id,now))
        con.execute('INSERT INTO asset_release_seals VALUES(?,?,?,0,?)',(ws,release,asset,now))
        con.execute("INSERT INTO benchmark_dataset_heads VALUES(?,?,?,?,?,?,?,?,?,'active',1,1,?,?,?)",(ws,identity,meta['dataset_id'],meta['asset_id'],meta['release_id'],asset,release,body['adapter_key'],content_hash,scope.principal_id,now,now))
        return self._dataset_dto(con,self._dataset(con,token,ws,identity))

    def _create_tx(self,con,token,ws,scope,body):
        self.iam._workspace(scope,ws,'execute');head=self._dataset(con,token,ws,body['dataset_id']);private=self._private_dataset(con,head)
        value=copy.deepcopy(body.get('experiment'));selection=body.get('selection',{'mode':'all'});config=copy.deepcopy(body.get('run_config',{}));adapter=copy.deepcopy(body.get('adapter'))
        if not isinstance(value,dict) or not isinstance(adapter,dict) or adapter.get('key')!=head['adapter_key'] or not isinstance(config,dict):raise ValueError('Verified Benchmark Experiment configuration required')
        cases=private['cases'];chosen=selection.get('caseIds') if selection.get('mode')=='explicit' else [row['id'] for row in cases] if selection.get('mode')=='all' else None
        if not isinstance(chosen,list) or not chosen or len(set(chosen))!=len(chosen) or not set(chosen)<={row['id'] for row in cases}:raise ValueError('Benchmark Case selection differs from Dataset')
        by_id={row['id']:row for row in cases};public_by_id={row['id']:row for row in private['public_dataset']['cases']};identity=identifier(value.get('id') or str(uuid.uuid4()));rows=[]
        for case_id in chosen:
            source=by_id[case_id];public=source['publicPayload'];rows.append({'id':_identity('benchmark-case',ws,identity,case_id),'input':public_by_id[case_id].get('input') or public.get('input') or _json(public),'actualOutput':'','datasetInput':_json(public),'caseValuesJson':_json(public),'benchmarkDatasetCaseId':case_id})
        value.update(id=identity,scope='benchmark',type='single',cases=rows,status='draft',user=self.experiments._owner(con,scope.principal_id))
        metadata=json.loads(value.get('configSnapshotJson') or '{}');metadata['coreBenchmark']={'dataset_id':head['dataset_id'],'public_release_id':head['public_release_id'],'private_release_id':head['private_release_id'],'adapter':adapter,'selection':selection,'run_config':config};value['configSnapshotJson']=_json(metadata)
        self.experiments._create(con,token,ws,{'experiment':value},scope)
        binding={'format':'benchmark-binding/v1','dataset_id':head['dataset_id'],'dataset_content_hash':'sha256:'+head['content_hash'],'public_release_id':head['public_release_id'],'private_release_id':head['private_release_id'],'selection':selection,'run_config':config,'adapter':adapter,'cases':[{**row,'dataset_case':copy.deepcopy(by_id[row['benchmarkDatasetCaseId']])} for row in rows]};digest,ref=self._put(binding);now=self.control.clock()
        con.execute('INSERT INTO benchmark_experiment_bindings VALUES(?,?,?,?,?,?,?,?,?)',(ws,identity,head['dataset_id'],head['public_release_id'],head['private_release_id'],digest,ref,scope.principal_id,now))
        return {'id':identity,'status':'draft','caseCount':len(rows)}

    def _binding(self,con,ws,exp):
        row=con.execute('SELECT * FROM benchmark_experiment_bindings WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()
        if row is None:raise BenchmarkNotFound('Benchmark binding unavailable')
        return dict(row),self._load(row['binding_hash'],row['binding_ref'])

    def _job(self,con,token,ws,identity,cap='read'):
        scope=self._scope(con,token,ws,cap)
        return self._job_scope(con,scope,ws,identity,cap)

    def _source_acl(self,con,scope,ws,exp,run):
        from .legacy_import_experiments import historical_benchmark_plan
        historical=historical_benchmark_plan(self,con,scope,ws,exp,run)
        if historical is not None:return historical
        self.experiments._source_assets(con,scope,ws,exp,run)
        binding=con.execute('SELECT * FROM benchmark_experiment_bindings WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()
        if binding is None:raise BenchmarkNotFound('Benchmark binding unavailable')
        public=con.execute("SELECT a.asset_id FROM asset_release_seals s JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id WHERE s.workspace_id=? AND s.release_id=? AND a.kind='dataset'",(ws,binding['public_release_id'])).fetchone()
        if public is None:raise Conflict('Benchmark public Dataset seal is unavailable')
        self.iam._authorize_scope(con,scope,ws,'read','asset',public['asset_id'])
        if run is None:return None
        _,plan=self.experiments._plan(con,ws,exp,run);releases=plan.get('releases',{})
        if releases.get('dataset')!=binding['public_release_id'] or releases.get('benchmark')!=binding['private_release_id'] or plan.get('config',{}).get('benchmark_binding_hash')!=binding['binding_hash']:raise Conflict('Benchmark frozen source binding differs')
        for slot,release in releases.items():
            sealed=con.execute('SELECT a.kind,a.asset_id FROM asset_release_seals s JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id WHERE s.workspace_id=? AND s.release_id=?',(ws,release)).fetchone()
            if not sealed or sealed['kind']!=slot.split(':',1)[0]:raise Conflict('Benchmark input seal is unavailable')
            if sealed['kind']!='benchmark':self.iam._authorize_scope(con,scope,ws,'read','asset',sealed['asset_id'])
            elif release!=binding['private_release_id'] or slot!='benchmark' and not slot.startswith(('benchmark:origin:','benchmark:manual-origin:')):raise Conflict('Benchmark private source marker differs')
        parent_id=plan.get('config',{}).get('benchmark_continuation_parent_job_id')
        if parent_id:
            parent=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,parent_id)).fetchone()
            if not parent or parent['experiment_id']!=exp or parent['run_id']!=plan['config'].get('benchmark_continuation_parent_run_id'):raise Conflict('Benchmark continuation parent provenance differs')
            if parent['case_id'] not in {case['id'] for case in plan['cases']} or releases.get('benchmark:origin:'+parent_id)!=binding['private_release_id']:raise Conflict('Benchmark continuation Case provenance differs')
        return plan

    def _job_scope(self,con,scope,ws,identity,cap='read'):
        if cap=='execute':
            from .legacy_history import assert_control_live
            assert_control_live(con,ws,'benchmarkJob',identity)
        row=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,identity)).fetchone()
        if row is None:raise BenchmarkNotFound('Benchmark job unavailable')
        head=self._head_scope(con,scope,ws,row['experiment_id'],cap)
        case=self.experiments._case(con,ws,row['experiment_id'],row['case_id'])
        planrow,plan=self.experiments._plan(con,ws,row['experiment_id'],row['run_id'])
        self._source_acl(con,scope,ws,row['experiment_id'],row['run_id'])
        if planrow['status']=='cancelled' or head['lifecycle_revision']!=plan['config']['benchmark_lifecycle'] or case['lifecycle_revision']!=plan['config']['benchmark_case_lifecycles'][row['case_id']]:raise Conflict('Benchmark source lifecycle changed')
        return dict(row)

    @staticmethod
    def _insert(con,table,values):
        columns=','.join(values);marks=','.join('?' for _ in values)
        con.execute('INSERT INTO '+table+'('+columns+') VALUES('+marks+')',tuple(values.values()))

    def _job_bump(self,con,row,**changes):
        changes.update(revision=revision(row['revision']+1),updated_at_ms=max(self.control.clock(),row['updated_at_ms']))
        con.execute('UPDATE benchmark_jobs SET '+','.join(key+'=?' for key in changes)+' WHERE workspace_id=? AND job_id=? AND revision=?',tuple(changes.values())+(row['workspace_id'],row['job_id'],row['revision']))
        return dict(con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(row['workspace_id'],row['job_id'])).fetchone())

    def _dispatch_job(self,action,token,ws,body):
        if action not in {'start','claim','load_work','load_dispatch','checkpoint','dispatch_checkpoint','read','read_view','list_jobs','evaluation_prepare','artifact_read','artifact_lookup','resume_work','classify_failure','import_submissions','prepare_evaluation_retry','retry_evaluation','prepare_case_retry','retry_case'}:raise ValueError('Unsupported Benchmark action')
        if action=='prepare_case_retry':return self._prepare_case_retry(token,ws,body)
        if action=='prepare_evaluation_retry':return self._prepare_evaluation_retry(token,ws,body)
        if action in {'read','read_view','list_jobs'}:return self._read(action,token,ws,body)
        if action=='artifact_lookup':return self._lookup_artifact(token,ws,body)
        if action=='artifact_read':
            with self.control.read_transaction() as con:
                scope=self._scope(con,token,ws,'execute');row=self._job_scope(con,scope,ws,body['job_id'])
                self.iam._authorize_scope(con,scope,ws,'execute','run',row['experiment_id'])
                return self._artifact_read_tx(con,row,body)
        if action in {'load_work','load_dispatch','resume_work'}:
            self._trusted(token,ws,body)
            with self.control.read_transaction() as con:
                scope=self._scope(con,token,ws,'execute');row=self._job_scope(con,scope,ws,body['job_id'],'execute')
                if action=='resume_work':
                    current=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND work_item_id=? ORDER BY attempt_no DESC LIMIT 1',(ws,row['work_item_id'])).fetchone()
                    if current is None:return None
                    body=self._handle(row,current)
                attempt=self._active(con,row,body,scope)
                if action in {'load_work','resume_work'}:return self._work(con,row,attempt)
                if row['request_hash'] is None:raise Conflict('Benchmark dispatch has not been sealed')
                request=self._load(row['request_hash'],row['request_ref']);request['callbackHeaders']={'x-agent-insight-callback-token':self._capability(row)}
                return {'request':request,'job':self._job_dto(row),'handle':self._handle(row,attempt)}
        with self.control.transaction() as con:
            scope=self._scope(con,token,ws,'write');self.iam._workspace(scope,ws,'execute')
            if action=='retry_case':
                self._head_scope(con,scope,ws,body['experiment_id'],'execute');key,digest,old=self._receipt(con,scope,ws,action,body)
                if old:return self._receipt_response(con,token,ws,old)
                self._trusted(token,ws,body);value=self._retry_case_tx(con,token,ws,scope,body);self._write_receipt(con,scope,ws,action,key,digest,value,experiment_id=body['experiment_id']);return value
            if action=='retry_evaluation':
                self._head_scope(con,scope,ws,body['experiment_id'],'execute');key,digest,old=self._receipt(con,scope,ws,action,body)
                if old:return self._receipt_response(con,token,ws,old)
                self._trusted(token,ws,body);value=self._retry_evaluation_tx(con,token,ws,scope,body);self._write_receipt(con,scope,ws,action,key,digest,value,job_id=value['evaluationRunId']);return value
            if action=='import_submissions':
                self._head_scope(con,scope,ws,body['experiment_id'],'execute');key,digest,old=self._receipt(con,scope,ws,action,body)
                if old:return self._receipt_response(con,token,ws,old)
                self._trusted(token,ws,body);value=self._import_submissions_tx(con,token,ws,scope,body);self._write_receipt(con,scope,ws,action,key,digest,value,experiment_id=body['experiment_id']);return value
            if action=='start':
                self._head_scope(con,scope,ws,body['experiment_id'],'execute');key,digest,old=self._receipt(con,scope,ws,action,body)
                if old:return self._receipt_response(con,token,ws,old)
                self._trusted(token,ws,body);value=self._start_tx(con,token,ws,scope,body);self._write_receipt(con,scope,ws,action,key,digest,value,experiment_id=body['experiment_id']);return value
            if action=='evaluation_prepare':
                parent=self._job_scope(con,scope,ws,body['parent_job_id'],'execute');key,digest,old=self._receipt(con,scope,ws,action,body)
                if old:return self._receipt_response(con,token,ws,old)
                self._trusted(token,ws,body);origin_id,origin_kind=self._origin(con,token);value=self._evaluation_prepare_tx(con,parent,scope,body,origin_id,origin_kind)
                self._write_receipt(con,scope,ws,action,key,digest,value,job_id=value['evaluationRunId']);return value
            row=self._job_scope(con,scope,ws,body['job_id'],'execute')
            if scope.principal_id!=row['actor_principal_id']:raise Forbidden('Benchmark execution requires its original owner')
            if action=='claim':return self._claim_tx(con,row,body,scope)
            if action=='classify_failure':
                self._trusted(token,ws,body);key,digest,old=self._receipt(con,scope,ws,action,body)
                if old:return self._load(old['response_hash'],old['response_ref'])
                value=self._classify_failure_tx(con,row,scope,body.get('failure_source_hash'));self._write_receipt(con,scope,ws,action,key,digest,value,job_id=row['job_id']);return value
            self._trusted(token,ws,body);return self._stage_tx(con,row,scope,action,body)

    def _stage_tx(self,con,row,scope,action,body):
        ws=row['workspace_id']
        if action=='load_dispatch':
            attempt=self._active(con,row,body,scope)
            if row['request_hash'] is None:raise Conflict('Benchmark dispatch has not been sealed')
            request=self._load(row['request_hash'],row['request_ref']);request['callbackHeaders']={'x-agent-insight-callback-token':self._capability(row)}
            return {'request':request,'job':self._job_dto(row),'handle':self._handle(row,attempt)}
        if action not in {'checkpoint','dispatch_checkpoint'}:raise ValueError('Unsupported Benchmark execution stage')
        key,digest,old=self._receipt(con,scope,ws,action,body)
        if old:return self._load(old['response_hash'],old['response_ref'])
        attempt=self._active(con,row,body,scope,terminal=row['protocol_state'] in TERMINAL or row['completion_hash'] is not None)
        if action=='checkpoint':
            request=copy.deepcopy(body.get('request'))
            if not isinstance(request,dict) or request.get('runId')!=row['job_id'] or not isinstance(request.get('requestDigest'),str) or 'callbackHeaders' in request:raise ValueError('Exact credential-free external request required')
            _hex(request['requestDigest'])
            _,binding=self._binding(con,ws,row['experiment_id']);_,plan=self.experiments._plan(con,ws,row['experiment_id'],row['run_id'])
            if row['kind']=='execute':
                expected=plan['config']['executor_callback_origin'].rstrip('/')+'/api/benchmark/v1/runs/'+row['job_id']
                if request.get('clientId')!=binding['run_config'].get('clientId') or request.get('callbackBaseUrl','').rstrip('/')!=expected or request.get('timeoutSeconds')!=binding['run_config'].get('timeoutSeconds'):raise Conflict('Execution request differs from frozen client, origin or limits')
            request_hash,request_ref=self._put(request)
            if row['request_hash'] and row['request_hash']!=request_hash:raise Conflict('External dispatch request is immutable')
            row=self._issue_capability_tx(con,row,attempt,request_hash,request_ref)
            value=self._job_dto(row)
        else:
            state=body.get('state')
            if state not in {'accepted','unknown','failed'}:raise ValueError('Exact Benchmark dispatch acknowledgement required')
            if body.get('preparation_failed') is True and row['request_hash'] is not None:raise Conflict('A sealed dispatch cannot be declared an undispatched preparation failure')
            row=self._ack_dispatch_tx(con,row,attempt,state,'preparation' if body.get('preparation_failed') is True else 'dispatch')
            if body.get('preparation_failed') is True:
                failure_hash,failure_ref=self._put({'failureCode':'BENCHMARK_PREPARATION_FAILED','failureMessage':'Benchmark执行准备失败，未启动Agent'})
                row=self._job_bump(con,row,protocol_state='blocked',progress_hash=failure_hash,progress_ref=failure_ref)
            if body.get('command_id') is not None:
                command=identifier(body['command_id'])
                if not con.execute("SELECT 1 FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND aggregate_revision=? AND event_type='benchmark.dispatch.acknowledged.v1'",(ws,row['job_id'],row['revision'])).fetchone():self._outbox(con,row,'benchmark.dispatch.acknowledged.v1',{'job_id':row['job_id'],'state':state,'command_id':command})
            value=self._job_dto(row)
        self._write_receipt(con,scope,ws,action,key,digest,value,job_id=row['job_id']);return value


    def _ack_dispatch_tx(self,con,row,attempt,state,stage='dispatch'):
        if state=='failed' and row['protocol_state']=='dispatch_unknown':raise Conflict('Unknown dispatch requires reconciliation, not a definitive rejection')
        if state!='unknown':self._close_intent(con,row,'benchmark.dispatch.requested.v1')
        if state=='failed':self._close_intent(con,row,'benchmark.execution.prepare.requested.v1')
        if row['protocol_state'] not in {'preparing','dispatching','dispatch_unknown'}:
            if state=='failed':raise Conflict('A started Benchmark execution cannot be treated as rejected')
            return row
        if state!='failed':return self._job_bump(con,row,protocol_state='dispatch_unknown' if state=='unknown' else 'running_agent' if row['kind']=='execute' else 'running_evaluator')
        now=self.control.clock();ws=row['workspace_id'];row=self._job_bump(con,row,protocol_state='blocked' if stage=='preparation' else 'dispatch_failed')
        con.execute("UPDATE work_items SET status='failed',updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,ws,row['work_item_id']));con.execute("UPDATE work_attempts SET status='failed',finished_at_ms=? WHERE workspace_id=? AND attempt_id=?",(now,ws,attempt['attempt_id']))
        con.execute("UPDATE experiment_result_slots SET status='failed',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=? AND (work_item_id=? OR work_item_id IS NULL) AND selected_result_id IS NULL",(now,ws,row['case_id'],row['work_item_id']))
        if row['parent_job_id']:
            parent=dict(con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,row['parent_job_id'])).fetchone());self._job_bump(con,parent,protocol_state='evaluation_failed')
        self._seal_failure_tx(con,row,stage);self._outbox(con,row,'benchmark.dispatch.rejected.v1',{'job_id':row['job_id']});self.experiments._settle(con,ws,row['experiment_id']);return row

    def _start_tx(self,con,token,ws,scope,body,imported=False,retry_case=None):
        exp=body['experiment_id'];head=self._head_scope(con,scope,ws,exp,'write')
        if scope.principal_id!=head['created_by']:raise Forbidden('Benchmark plan requires original owner')
        if body.get('resume_only') is True and body.get('expected_runplan_id')!=head['current_run_id']:raise Conflict('Benchmark resume plan changed')
        binding_row,binding=self._binding(con,ws,exp)
        if binding['run_config'].get('submissionSource')=='imported' and not imported:raise Conflict('Imported Benchmark does not support Agent execution')
        snapshot=self.experiments._snapshot(con,ws,head);cases=snapshot['experiment']['cases']
        pending_sql="SELECT j.job_id,j.run_id FROM benchmark_jobs j JOIN work_items w ON w.workspace_id=j.workspace_id AND w.work_item_id=j.work_item_id JOIN experiment_cases c ON c.workspace_id=j.workspace_id AND c.case_id=j.case_id JOIN experiment_runs r ON r.workspace_id=j.workspace_id AND r.run_id=j.run_id WHERE j.workspace_id=? AND j.experiment_id=? AND c.state='active' AND w.cancel_requested=0 AND r.lifecycle_revision=? AND (j.protocol_state NOT IN ('completed','failed','cancelled','blocked','execution_failed','dispatch_failed','evaluation_failed','submission_invalid') OR EXISTS (SELECT 1 FROM outbox_events o WHERE o.workspace_id=j.workspace_id AND o.aggregate_id=j.job_id AND o.event_type='benchmark.failure.classification.requested.v1' AND o.state<>'sent'))"
        pending_args=(ws,exp,head['lifecycle_revision'])
        pending=con.execute(pending_sql+' ORDER BY j.created_at_ms,j.job_id LIMIT 1',pending_args).fetchone()
        if pending and retry_case is None:return {'status':'running','alreadyRunning':True,'runId':pending['job_id'],'runplanId':pending['run_id']}
        if body.get('resume_only') is True:return {'status':'idle','alreadyRunning':False,'runId':None,'runplanId':head['current_run_id']}
        selected=body.get('case_ids')
        if selected is not None:
            if not isinstance(selected,list) or not selected or len(set(selected))!=len(selected) or not set(selected)<={row['id'] for row in cases}:raise ValueError('Selected Benchmark Cases must be active')
            cases=[row for row in cases if row['id'] in selected]
        if not cases:raise Conflict('Benchmark requires an active Case')
        if not imported:
            for case in cases:self._case_cleanup_ready(con,ws,exp,case['id'])
        origins={key:body.get(key) for key in ('public_callback_origin','executor_callback_origin')}
        from urllib.parse import urlsplit
        for value in origins.values():
            if not isinstance(value,str):raise ValueError('Explicit Benchmark callback origins required')
            parsed=urlsplit(value)
            if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:raise ValueError('Credential-free callback origin required')
        now=self.control.clock();run=str(uuid.uuid4());generation=con.execute('SELECT COALESCE(MAX(generation),0)+1 FROM experiment_runs WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()[0]
        rows=[];case_lifecycles={}
        for value in cases:
            clean=copy.deepcopy(value)
            for key in ('results','traceAttempts','executionSnapshot'):clean.pop(key,None)
            rows.append(clean);case_lifecycles[value['id']]=self.experiments._case(con,ws,exp,value['id'])['lifecycle_revision']
        evaluator=binding['adapter']['evaluatorId'];frozen=copy.deepcopy(body.get('frozen_evaluators',{}));frozen.setdefault(evaluator,{'id':evaluator,'origin':'benchmark','adapter':binding['adapter']})
        limits=copy.deepcopy(body.get('scheduler_limits',{'maxPendingEvaluations':256,'maxPendingEvaluationsPerUser':64}))
        if not isinstance(limits,dict) or any(type(limits.get(key)) is not int or not 1<=limits[key]<=100000 for key in ('maxPendingEvaluations','maxPendingEvaluationsPerUser')):raise ValueError('Bounded Benchmark scheduling limits required')
        selected=json.loads(snapshot['experiment'].get('evaluatorIdsJson') or '[]')
        if not isinstance(selected,list) or evaluator not in selected or any(value not in frozen for value in selected):raise Conflict('Every Benchmark evaluator requires a frozen definition')
        config={**copy.deepcopy(body.get('config',{})),'scheduler_limits':limits,'benchmark_binding_hash':binding_row['binding_hash'],'benchmark_binding_ref':binding_row['binding_ref'],'benchmark_lifecycle':head['lifecycle_revision'],'benchmark_case_lifecycles':case_lifecycles,'model_selection':body.get('model_selection',body.get('config',{}).get('model_selection')),**origins}
        releases=copy.deepcopy(body.get('releases',{}))
        for slot,release in releases.items():
            sealed=con.execute('SELECT a.kind,a.asset_id FROM asset_release_seals s JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id WHERE s.workspace_id=? AND s.release_id=?',(ws,release)).fetchone()
            if not sealed or sealed['kind']!=slot.split(':',1)[0]:raise Conflict('Benchmark input requires matching sealed release')
            self.iam._authorize(con,token,ws,'read','asset',sealed['asset_id'])
        if releases.get('dataset',binding['public_release_id'])!=binding['public_release_id']:raise Conflict('Benchmark public Dataset release changed')
        releases.update(dataset=binding['public_release_id'],benchmark=binding['private_release_id']);plan={'format':'agent-insight.runplan','version':1,'experiment_id':exp,'run_id':run,'generation':generation,'experiment_config':snapshot['experiment']|{'cases':[],'comments':[]},'cases':rows,'frozen_trace_evidence':{},'frozen_evaluators':frozen,'config':config,'phase':'benchmark','releases':releases,'expected_case_count':len(rows),'work_members':[{'case_key':row['id'],'evaluator_slot':evaluator} for row in rows]};digest,ref=self._put(plan)
        con.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,dataset_release_id,expected_case_count,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,'draft',?,?)",(ws,run,head['name'],digest,ref,binding['public_release_id'],len(rows),now,now));con.execute('INSERT INTO experiment_runs VALUES(?,?,?,?,?,?,?)',(ws,exp,run,generation,head['lifecycle_revision'],scope.principal_id,now))
        for slot,release in releases.items():con.execute('INSERT INTO run_inputs VALUES(?,?,?,?,?,?)',(ws,run,slot,release,_hash(config),now))
        origin_id,origin_kind=self._origin(con,token);first=None
        for case in rows:
            prior=con.execute("SELECT 1 FROM benchmark_jobs WHERE workspace_id=? AND experiment_id=? AND case_id=? AND kind='execute' LIMIT 1",(ws,exp,case['id'])).fetchone()
            job='erun_'+(uuid.uuid4().hex if prior else _identity('benchmark-initial-execution',ws,exp,case['id']).replace('-',''));first=first or job;item=str(uuid.uuid4());slot='__execution__'
            con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'publish',?,'queued',?,?)",(ws,item,run,case['id'],slot,now,now))
            self._insert(con,'benchmark_jobs',{'workspace_id':ws,'job_id':job,'experiment_id':exp,'case_id':case['id'],'run_id':run,'work_item_id':item,'kind':'execute','adapter_key':binding['adapter']['key'],'attempt_no':retry_case['attempt_no']+1 if retry_case else 1,'retry_of_job_id':retry_case['job_id'] if retry_case else None,'origin_credential_id':origin_id,'origin_credential_kind':origin_kind,'actor_principal_id':scope.principal_id,'protocol_state':'pending','revision':1,'callback_epoch':1,'created_at_ms':now,'updated_at_ms':now})
            if not imported:self._outbox(con,{'workspace_id':ws,'job_id':job,'revision':1},'benchmark.execution.prepare.requested.v1',{'job_id':job})
            primary_item=str(uuid.uuid4())
            con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'publish',?,'queued',?,?)",(ws,primary_item,run,case['id'],evaluator,now,now))
            for evaluator_id in ['__execution__',*selected]:
                existing=con.execute('SELECT result_id FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,case['id'],evaluator_id)).fetchone();work=item if evaluator_id=='__execution__' else primary_item if evaluator_id==evaluator else None;slot_run=run if work else None
                if existing:con.execute("UPDATE experiment_result_slots SET run_id=?,work_item_id=?,selected_result_id=NULL,review_id=NULL,status='pending',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?",(slot_run,work,now,ws,existing['result_id']))
                else:con.execute("INSERT INTO experiment_result_slots(workspace_id,experiment_id,case_id,result_id,evaluator_id,run_id,work_item_id,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,'pending',?,?)",(ws,exp,case['id'],str(uuid.uuid4()),evaluator_id,slot_run,work,now,now))
        con.execute("UPDATE runs SET status='queued',updated_at_ms=? WHERE workspace_id=? AND run_id=?",(now,ws,run));self.experiments._bump(con,ws,exp,current_run_id=run,status='running')
        return {'status':'running','alreadyRunning':False,'runId':first,'runplanId':run}

    def _import_submissions_tx(self,con,token,ws,scope,body):
        exp=body['experiment_id'];head=self._head_scope(con,scope,ws,exp,'write');_,binding=self._binding(con,ws,exp)
        if head['created_by']!=scope.principal_id:raise Forbidden('Benchmark submission import requires original owner')
        if head['current_run_id'] is not None or head['status']!='draft' or binding['run_config'].get('submissionSource')!='imported':raise Conflict('Imported submissions require an unstarted imported Draft')
        submissions=body.get('submissions');cases={case['benchmarkDatasetCaseId']:case for case in binding['cases']}
        if not isinstance(submissions,list) or len(submissions)!=len(cases) or {value.get('dataset_case_id') for value in submissions if isinstance(value,dict)}!=set(cases):raise ValueError('Imported submissions must cover the exact frozen Case selection')
        start=copy.deepcopy(body);start.pop('case_ids',None);started=self._start_tx(con,token,ws,scope,start,imported=True);now=self.control.clock();jobs=[]
        for submission in submissions:
            case=cases[submission['dataset_case_id']];row=dict(con.execute("SELECT * FROM benchmark_jobs WHERE workspace_id=? AND experiment_id=? AND run_id=? AND case_id=? AND kind='execute'",(ws,exp,started['runplanId'],case['id'])).fetchone());item=con.execute('SELECT * FROM work_items WHERE workspace_id=? AND work_item_id=?',(ws,row['work_item_id'])).fetchone();attempt=str(uuid.uuid4());fence=revision(item['etag']+1);worker='benchmark-submission-importer'
            request={'format':'benchmark.imported-submission/v1','submissionSource':'imported','runId':row['job_id'],'task':{'submission':{'requiredArtifacts':binding['adapter'].get('requiredArtifacts',[])}}};request_hash,request_ref=self._put(request);row=self._job_bump(con,row,request_hash=request_hash,request_ref=request_ref)
            artifacts=submission.get('artifacts')
            if not isinstance(artifacts,list) or len(artifacts)>1000:raise ValueError('Bounded imported artifact list required')
            saved=[];names=[]
            for value in artifacts:
                if not isinstance(value,dict):raise ValueError('Complete imported artifact required')
                prepared=self._prepare_artifact(row,request,value);artifact=self._artifact_put_tx(con,row,prepared);names.append(prepared['name']);saved.append({'artifactId':artifact['artifactId'],'name':prepared['name'],'sha256':artifact['sha256']})
            if len(names)!=len(set(names)) or any(rule['name'] not in names for rule in binding['adapter'].get('requiredArtifacts',[])):raise Conflict('Imported artifacts differ from frozen submission contract')
            completion={'kind':'execution','status':'succeeded','submissionSource':'imported','artifacts':saved,'runFacts':{},'cleanup':{'status':'succeeded','origin':'no-agent-process-created'}};completion_hash,completion_ref=self._put(completion)
            con.execute("UPDATE work_items SET status='done',etag=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(fence,now,ws,row['work_item_id']));con.execute("INSERT INTO work_attempts(workspace_id,attempt_id,work_item_id,attempt_no,fence,worker_id,status,lease_until_ms,started_at_ms,finished_at_ms) VALUES(?,?,?,1,?,?,'done',?,?,?)",(ws,attempt,row['work_item_id'],fence,worker,now+300000,now,now))
            cp_hash,cp_ref=self._put({'phase':'benchmark:import','checkpoint':{'job_id':row['job_id'],'source':'imported-submission/v1','completion_hash':completion_hash}});case_row=self.experiments._case(con,ws,exp,row['case_id'])
            con.execute("INSERT INTO experiment_attempt_checkpoints(workspace_id,experiment_id,case_id,run_id,work_item_id,attempt_id,fence,lease_owner,actor_principal_id,lifecycle_revision,case_lifecycle_revision,payload_hash,payload_ref,stage,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'terminal',?,?)",(ws,exp,row['case_id'],row['run_id'],row['work_item_id'],attempt,fence,worker,scope.principal_id,head['lifecycle_revision'],case_row['lifecycle_revision'],cp_hash,cp_ref,now,now))
            con.execute("UPDATE experiment_result_slots SET status='done',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,ws,row['work_item_id']));row=self._job_bump(con,row,protocol_state='submitted',completion_hash=completion_hash,completion_ref=completion_ref);self._outbox(con,row,'benchmark.execution.completed.v1',{'job_id':row['job_id'],'completion_hash':completion_hash,'completion_ref':completion_ref,'needs_evaluation':True,'submissionSource':'imported'});jobs.append(self._job_dto(row))
        return {'accepted':True,'experiment_id':exp,'runplan_id':started['runplanId'],'jobs':jobs,'submissionSource':'imported'}

    def _claim_tx(self,con,row,body,scope):
        ws=row['workspace_id'];item=con.execute('SELECT * FROM work_items WHERE workspace_id=? AND work_item_id=?',(ws,row['work_item_id'])).fetchone()
        if item['status']!='queued' or item['cancel_requested']:return None
        origin=self.iam._scope_registered_credential(con,row['origin_credential_id'],row['origin_credential_kind']);self.iam._workspace(origin,ws,'execute');self.iam._workspace(origin,ws,'write')
        worker=identifier(body.get('worker_id'));_,binding=self._binding(con,ws,row['experiment_id'])
        if row['kind']=='execute':
            concurrency=binding['run_config'].get('executionConcurrency',1)
            if type(concurrency) is not int or not 1<=concurrency<=1000:raise ValueError('Frozen execution concurrency must be 1..1000')
            operation_key = "CONCAT('target:',j.job_id,':',j.request_hash)" if getattr(self.control, 'backend', None) == 'mariadb' else "'target:'||j.job_id||':'||j.request_hash"
            unknown=f"j.protocol_state='cancelled' AND j.callback_token_hash IS NOT NULL AND j.completion_hash IS NULL AND NOT EXISTS(SELECT 1 FROM benchmark_operation_receipts r WHERE r.workspace_id=j.workspace_id AND r.job_id=j.job_id AND r.operation_kind='cleanup-confirmed' AND r.operation_key={operation_key})"
            active=con.execute("SELECT COUNT(*) FROM benchmark_jobs j WHERE j.workspace_id=? AND j.experiment_id=? AND j.kind='execute' AND (j.protocol_state IN ('preparing','dispatching','dispatch_unknown','running_agent','collecting','uploading','cleaning') OR ("+unknown+'))',(ws,row['experiment_id'])).fetchone()[0]
            _,plan=self.experiments._plan(con,ws,row['experiment_id'],row['run_id']);limits=plan['config']['scheduler_limits']
            count_sql="SELECT COUNT(*) FROM benchmark_jobs j WHERE j.workspace_id=? AND ((j.kind='execute' AND j.protocol_state IN ('preparing','dispatching','dispatch_unknown','running_agent','collecting','uploading','cleaning','submitted')) OR ("+unknown+'))'
            occupied=con.execute(count_sql,(ws,)).fetchone()[0];user_occupied=con.execute(count_sql+' AND j.actor_principal_id=?',(ws,scope.principal_id)).fetchone()[0]
            if active>=concurrency or occupied>=limits['maxPendingEvaluations'] or user_occupied>=limits['maxPendingEvaluationsPerUser']:return None
        timeout=binding['run_config'].get('timeoutSeconds',180) if row['kind']=='execute' else binding['adapter']['evaluation'].get('defaultTimeoutSeconds',180)
        if type(timeout) is not int or not 1<=timeout<=86400:raise ValueError('Benchmark hard timeout must be 1..86400 seconds')
        preparation=cleanup=0
        profile=binding['run_config'].get('executionProfile') if row['kind']=='execute' else None
        if profile is not None:
            values=profile.get('timeouts') if isinstance(profile,dict) else None
            if not isinstance(values,dict) or type(values.get('prepareSeconds')) is not int or not 1<=values['prepareSeconds']<=86400 or type(values.get('cleanupSeconds')) is not int or not 1<=values['cleanupSeconds']<=3600:raise ValueError('Bounded frozen execution environment timeouts required')
            preparation=values['prepareSeconds'];cleanup=values['cleanupSeconds']
        now=self.control.clock();until=now+(preparation+timeout+cleanup+300)*1000;attempt=str(uuid.uuid4());fence=revision(item['etag']+1);number=con.execute('SELECT COALESCE(MAX(attempt_no),0)+1 FROM work_attempts WHERE workspace_id=? AND work_item_id=?',(ws,item['work_item_id'])).fetchone()[0]
        con.execute("UPDATE work_items SET status='running',etag=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(fence,now,ws,item['work_item_id']));con.execute("INSERT INTO work_attempts(workspace_id,attempt_id,work_item_id,attempt_no,fence,worker_id,status,lease_until_ms,started_at_ms) VALUES(?,?,?,?,?,?,'running',?,?)",(ws,attempt,item['work_item_id'],number,fence,worker,until,now))
        self._close_intent(con,row,'benchmark.evaluation.raw.accepted.v1')
        head=self._head_scope(con,scope,ws,row['experiment_id']);case=self.experiments._case(con,ws,row['experiment_id'],row['case_id']);digest,ref=self._put({'phase':'benchmark:'+row['kind'],'checkpoint':{'job_id':row['job_id']}})
        con.execute("INSERT INTO experiment_attempt_checkpoints(workspace_id,experiment_id,case_id,run_id,work_item_id,attempt_id,fence,lease_owner,actor_principal_id,lifecycle_revision,case_lifecycle_revision,payload_hash,payload_ref,stage,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?)",(ws,row['experiment_id'],row['case_id'],row['run_id'],item['work_item_id'],attempt,fence,worker,scope.principal_id,head['lifecycle_revision'],case['lifecycle_revision'],digest,ref,now,now))
        row=self._job_bump(con,row,protocol_state='preparing');con.execute("UPDATE experiment_result_slots SET status='running',evaluation_version=evaluation_version+1,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,ws,item['work_item_id']))
        return self._handle(row,dict(con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND attempt_id=?',(ws,attempt)).fetchone()))

    @staticmethod
    def _handle(row,attempt):return {'job_id':row['job_id'],'experiment_id':row['experiment_id'],'case_id':row['case_id'],'run_id':row['run_id'],'work_item_id':row['work_item_id'],'attempt_id':attempt['attempt_id'],'fence':str(attempt['fence']),'lease_owner':attempt['worker_id'],'lease_until_ms':attempt['lease_until_ms']}
    @staticmethod
    def _job_dto(row):return {key:row[key] for key in ('job_id','experiment_id','case_id','run_id','kind','parent_job_id','adapter_key','evaluator_key','attempt_no','retry_of_job_id','protocol_state','revision','created_at_ms','updated_at_ms')}
    def _active(self,con,row,body,scope,terminal=False):
        from .legacy_history import assert_control_live
        assert_control_live(con,row['workspace_id'],'benchmarkJob',row['job_id']);assert_control_live(con,row['workspace_id'],'experiment',row['experiment_id'])
        if scope.principal_id!=row['actor_principal_id']:raise Forbidden('Benchmark work belongs to another owner')
        origin=self.iam._scope_registered_credential(con,row['origin_credential_id'],row['origin_credential_kind'])
        if origin.principal_id!=row['actor_principal_id']:raise Forbidden('Benchmark origin principal changed')
        self.iam._workspace(origin,row['workspace_id'],'write');self.iam._authorize_scope(con,origin,row['workspace_id'],'execute','run',row['experiment_id'])
        attempt=con.execute('SELECT a.*,w.etag,w.cancel_requested,w.status AS item_status FROM work_attempts a JOIN work_items w ON w.workspace_id=a.workspace_id AND w.work_item_id=a.work_item_id WHERE a.workspace_id=? AND a.attempt_id=? AND a.work_item_id=?',(row['workspace_id'],body.get('attempt_id'),row['work_item_id'])).fetchone()
        if not attempt or str(attempt['fence'])!=str(body.get('fence')) or attempt['worker_id']!=body.get('lease_owner') or attempt['fence']!=attempt['etag'] or attempt['cancel_requested'] or not terminal and (attempt['status']!='running' or attempt['item_status']!='running' or attempt['lease_until_ms']<=self.control.clock()):raise Conflict('Benchmark work fence is stale or expired')
        slot=con.execute('SELECT work_item_id,run_id FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(row['workspace_id'],row['case_id'],'__execution__' if row['kind']=='execute' else 'benchmark:'+row['evaluator_key'])).fetchone()
        if not slot or slot['work_item_id']!=row['work_item_id'] or slot['run_id']!=row['run_id']:raise Conflict('Benchmark result slot has been superseded')
        return dict(attempt)
    def _work(self,con,row,attempt):
        _,binding=self._binding(con,row['workspace_id'],row['experiment_id']);case=next((value for value in binding['cases'] if value['id']==row['case_id']),None)
        if case is None:raise BenchmarkUnavailable('Frozen Benchmark Case unavailable')
        _,plan=self.experiments._plan(con,row['workspace_id'],row['experiment_id'],row['run_id'])
        return {'handle':self._handle(row,attempt),'job':self._job_dto(row),'actor_username':self.experiments._owner(con,row['actor_principal_id']),'binding':{key:value for key,value in binding.items() if key!='cases'},'case':case,'runplan':plan,'request':self._load(row['request_hash'],row['request_ref']) if row['request_hash'] else None}
    def _close_intent(self,con,row,kind):
        if kind not in {'benchmark.execution.prepare.requested.v1','benchmark.dispatch.requested.v1','benchmark.execution.completed.v1','benchmark.evaluation.raw.accepted.v1','benchmark.continuation.requested.v1','benchmark.failure.classification.requested.v1'}:raise ValueError('Unknown Benchmark recovery intent')
        con.execute("UPDATE outbox_events SET state='sent',lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND aggregate_id=? AND event_type=? AND state<>'sent'",(self.control.clock(),row['workspace_id'],row['job_id'],kind))

    def _outbox(self,con,row,kind,payload):
        intent=kind in {'benchmark.execution.prepare.requested.v1','benchmark.dispatch.requested.v1','benchmark.evaluation.raw.accepted.v1','benchmark.failure.classification.requested.v1'} or kind=='benchmark.execution.completed.v1' and payload.get('needs_evaluation') is True or kind=='benchmark.continuation.requested.v1' and payload.get('needs_supplemental') is True
        now=self.control.clock();con.execute('INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)',(row['workspace_id'],str(uuid.uuid4()),row['job_id'],row['revision'],kind,canonical_json(payload),'pending' if intent else 'sent',self.experiments._queued_at(con,now),now))
    def _issue_capability_tx(self,con,row,attempt,request_hash,request_ref):
        if row['kind']=='execute':self._close_intent(con,row,'benchmark.execution.prepare.requested.v1')
        if row['callback_token_hash'] is not None:return row
        expires=attempt['lease_until_ms'];candidate=row|{'request_hash':request_hash,'request_ref':request_ref,'callback_attempt_id':attempt['attempt_id'],'callback_fence':attempt['fence'],'callback_expires_ms':expires}
        capability=self._capability(candidate);row=self._job_bump(con,row,request_hash=request_hash,request_ref=request_ref,callback_token_hash=hashlib.sha256(capability.encode()).hexdigest(),callback_attempt_id=attempt['attempt_id'],callback_fence=attempt['fence'],callback_expires_ms=expires,protocol_state='dispatching')
        if not con.execute("SELECT 1 FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type='benchmark.dispatch.requested.v1'",(row['workspace_id'],row['job_id'])).fetchone():self._outbox(con,row,'benchmark.dispatch.requested.v1',{'job_id':row['job_id'],'request_hash':request_hash,'request_ref':request_ref})
        return row

    def _capability(self,row):
        payload={'workspace_id':row['workspace_id'],'principal_id':row['actor_principal_id'],'job_id':row['job_id'],'attempt_id':row['callback_attempt_id'],'fence':str(row['callback_fence']),'epoch':str(row['callback_epoch']),'expires_ms':str(row['callback_expires_ms']),'request_hash':row['request_hash']}
        encoded=base64.urlsafe_b64encode(canonical_json(payload).encode()).decode().rstrip('=')
        try:key=read_controller_key(self.controller_key_file)
        except (OSError,ValueError,TypeError):raise BenchmarkUnavailable('Private Benchmark callback credential unavailable') from None
        signature=hmac.new(key,(CAP_PURPOSE+'\0'+encoded).encode(),hashlib.sha256).hexdigest();return 'bcap_'+encoded+'.'+signature

    def _verify_capability(self,con,capability,body,verified_device_client_id):
        if not isinstance(capability,str) or len(capability)>4096 or not capability.startswith('bcap_'):raise Unauthorized('Benchmark callback capability required')
        try:
            encoded,signature=capability[5:].split('.');raw=base64.b64decode(encoded+'='*(-len(encoded)%4),altchars=b'-_',validate=True);payload=json.loads(raw)
            if base64.urlsafe_b64encode(raw).decode().rstrip('=')!=encoded:raise ValueError()
            ws=identifier(payload['workspace_id']);identity=identifier(payload['job_id'])
        except (ValueError,KeyError,TypeError):raise Unauthorized('Invalid Benchmark callback capability') from None
        row=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,identity)).fetchone()
        if row is None:raise Unauthorized('Benchmark callback unavailable')
        row=dict(row)
        if not row['callback_token_hash'] or not hmac.compare_digest(hashlib.sha256(capability.encode()).hexdigest(),row['callback_token_hash']) or not hmac.compare_digest(self._capability(row),capability) or row['callback_expires_ms']<=self.control.clock():raise Unauthorized('Benchmark callback is expired or superseded')
        if body.get('job_id')!=identity:raise Forbidden('Benchmark callback belongs to another job')
        scope=self.iam._scope_registered_credential(con,row['origin_credential_id'],row['origin_credential_kind']);self.iam._workspace(scope,ws,'write');self.iam._workspace(scope,ws,'execute');row=self._job_scope(con,scope,ws,identity,'execute')
        if row['kind']=='execute':
            request=self._load(row['request_hash'],row['request_ref'])
            if not verified_device_client_id or request.get('clientId')!=verified_device_client_id or not callable(self.device_verifier) or self.device_verifier(verified_device_client_id,row) is not True:raise Forbidden('Authenticated Benchmark execution client required')
        handle={'attempt_id':row['callback_attempt_id'],'fence':str(row['callback_fence'])}
        attempt=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND attempt_id=?',(ws,row['callback_attempt_id'])).fetchone()
        if attempt is None:raise Conflict('Benchmark callback attempt is unavailable')
        handle['lease_owner']=attempt['worker_id'];self._active(con,row,handle,scope,terminal=row['protocol_state'] in TERMINAL or row['completion_hash'] is not None)
        return row,scope,dict(attempt)

    def _artifact_contract(self,request,row,name,media_type):
        if row['kind']=='execute':
            contract=next((value for value in request.get('task',{}).get('submission',{}).get('requiredArtifacts',[]) if value.get('name')==name),None)
            if not contract or contract.get('mediaType')!=media_type:raise Conflict('Artifact does not match frozen submission contract')
            maximum=contract.get('maxBytes')
            if type(maximum) is not int or not 1<=maximum<=MAX_ARTIFACT_BYTES:raise ValueError('Invalid frozen artifact budget')
            return contract,maximum
        contract={'kind':'evaluation-evidence','name':name,'mediaType':media_type,'maxBytes':MAX_ARTIFACT_BYTES}
        return contract,MAX_ARTIFACT_BYTES

    def _prepare_artifact(self,row,request,body,capability=None):
        name=body.get('name');media_type=body.get('media_type');encoded=body.get('bytes_base64')
        if not isinstance(name,str) or not name or len(name)>512 or len(name.split('/'))>16 or any(not part or len(part)>128 or part in {'.','..'} or part.endswith(('.', ' ')) or re.search(r'[\x00-\x1f\x7f-\x9f\\:<>\"|?*\u202a-\u202e\u2066-\u2069\ud800-\udfff]',part) for part in name.split('/')):raise ValueError('Invalid Benchmark artifact name')
        if row['kind']=='execute' and '/' in name:raise ValueError('Submission artifact must use its contract name')
        if not isinstance(media_type,str) or not 1<=len(media_type)<=256 or not isinstance(encoded,str) or len(encoded)>((MAX_ARTIFACT_BYTES+2)//3)*4:raise BenchmarkTooLarge('Invalid artifact transport budget')
        contract,maximum=self._artifact_contract(request,row,name,media_type)
        try:raw=base64.b64decode(encoded,validate=True)
        except (ValueError,TypeError):raise ValueError('Exact base64 artifact required') from None
        if base64.b64encode(raw).decode()!=encoded or not 0<=len(raw)<=maximum:raise ValueError('Artifact size differs from contract')
        if capability and capability.encode() in raw:raise Forbidden('Callback credential cannot be persisted as artifact evidence')
        digest=hashlib.sha256(raw).hexdigest()
        if digest!=_hex(body.get('expected_sha256')):raise Conflict('Artifact digest differs')
        storage_hash,storage_ref=self._put({'format':'benchmark-bytes/v1','bytes_base64':encoded})
        return {'artifact_id':'bart_'+_identity(row['workspace_id'],row['job_id'],name,digest).replace('-',''),'name':name,'kind':str(body.get('kind') or ('submission' if row['kind']=='execute' else 'evidence')),'media_type':media_type,'content_hash':digest,'size_bytes':len(raw),'storage_hash':storage_hash,'storage_ref':storage_ref,'contract_hash':_hash(contract)}

    @staticmethod
    def _artifact_dto(row):return {'artifactId':row['artifact_id'],'sha256':'sha256:'+row['content_hash'],'size':row['size_bytes']}

    def _artifact_put_tx(self,con,row,prepared):
        old=con.execute('SELECT * FROM benchmark_artifacts WHERE workspace_id=? AND job_id=? AND name=?',(row['workspace_id'],row['job_id'],prepared['name'])).fetchone()
        if old:
            if any(old[key]!=prepared[key] for key in ('kind','media_type','content_hash','size_bytes','contract_hash')):raise Conflict('Artifact name has different immutable content')
            return self._artifact_dto(old)
        if row['completion_hash'] is not None or row['protocol_state'] in TERMINAL:raise Conflict('Completed Benchmark job no longer accepts artifacts')
        self._insert(con,'benchmark_artifacts',{'workspace_id':row['workspace_id'],'job_id':row['job_id'],**prepared,'created_at_ms':self.control.clock()})
        return self._artifact_dto(prepared)

    def _artifact_read_tx(self,con,row,body):
        artifact=con.execute('SELECT * FROM benchmark_artifacts WHERE workspace_id=? AND artifact_id=?',(row['workspace_id'],body.get('artifact_id'))).fetchone()
        if artifact is None:raise BenchmarkNotFound('Benchmark artifact unavailable')
        if artifact['job_id']!=row['job_id']:
            if row['kind']!='evaluate' or artifact['job_id']!=row['parent_job_id']:raise Forbidden('Artifact belongs to another Benchmark job')
            request=self._load(row['request_hash'],row['request_ref']);members=request.get('evaluationJob',{}).get('artifacts',[])
            if not any(value.get('artifactId')==artifact['artifact_id'] and _hex(value.get('sha256'))==artifact['content_hash'] and value.get('sizeBytes')==artifact['size_bytes'] for value in members):raise Forbidden('Artifact is not a frozen evaluation input')
        packet=self._load(artifact['storage_hash'],artifact['storage_ref'])
        if packet.get('format')!='benchmark-bytes/v1':raise BenchmarkUnavailable('Artifact encoding differs')
        raw=base64.b64decode(packet['bytes_base64'],validate=True)
        if len(raw)!=artifact['size_bytes'] or hashlib.sha256(raw).hexdigest()!=artifact['content_hash']:raise BenchmarkUnavailable('Artifact bytes differ from receipt')
        return self._artifact_dto(artifact)|{'kind':artifact['kind'],'media_type':artifact['media_type'],'name':artifact['name'],'bytes_base64':packet['bytes_base64']}

    def _execution_complete_tx(self,con,row,scope,attempt,body):
        completion=body.get('completion')
        if row['kind']!='execute' or not isinstance(completion,dict) or completion.get('kind')!='execution' or completion.get('status') not in {'succeeded','failed'} or not isinstance(completion.get('artifacts'),list) or not isinstance(completion.get('runFacts'),dict) or not isinstance(completion.get('cleanup'),dict):raise ValueError('Complete Benchmark execution terminal required')
        digest,ref=self._put(completion)
        if row['completion_hash']:
            if row['completion_hash']!=digest:raise Conflict('Execution completion has different immutable content')
            return {'accepted':True,'status':row['protocol_state']}
        if row['protocol_state'] in TERMINAL:raise Conflict('Execution is no longer active')
        request=self._load(row['request_hash'],row['request_ref']);artifacts={value['artifact_id']:dict(value) for value in con.execute('SELECT * FROM benchmark_artifacts WHERE workspace_id=? AND job_id=?',(row['workspace_id'],row['job_id']))};members=completion['artifacts'];names=[]
        for member in members:
            actual=artifacts.get(member.get('artifactId'))
            if not actual or actual['name']!=member.get('name') or actual['content_hash']!=_hex(member.get('sha256')):raise Conflict('Execution completion artifact differs')
            names.append(actual['name'])
        if len(names)!=len(set(names)):raise Conflict('Execution completion repeats an artifact')
        if completion['status']=='succeeded' and any(value['name'] not in names for value in request.get('task',{}).get('submission',{}).get('requiredArtifacts',[])):raise Conflict('Execution completion is missing required artifacts')
        if completion['cleanup'].get('status')!='succeeded':raise Conflict('Execution process cleanup is unconfirmed')
        facts=completion['runFacts'];trace=facts.get('traceId')
        if trace is not None:identifier(trace)
        if row['progress_hash']:
            previous=self._load(row['progress_hash'],row['progress_ref']).get('progress',{}).get('traceId')
            if previous and trace and previous!=trace:raise Conflict('Execution Trace identity differs from progress')
        if trace:
            others=con.execute("SELECT completion_hash,completion_ref FROM benchmark_jobs WHERE workspace_id=? AND case_id=? AND kind='execute' AND job_id<>? AND completion_hash IS NOT NULL LIMIT 10001",(row['workspace_id'],row['case_id'],row['job_id'])).fetchall()
            if len(others)>10000:raise BenchmarkTooLarge('Trace ownership history exceeds budget')
            if any(self._load(other['completion_hash'],other['completion_ref']).get('runFacts',{}).get('traceId')==trace for other in others):raise Conflict('Trace identity was already used by another execution')
        self._close_intent(con,row,'benchmark.dispatch.requested.v1')
        state='submitted' if completion['status']=='succeeded' else 'execution_failed';row=self._job_bump(con,row,protocol_state=state,completion_hash=digest,completion_ref=ref);now=self.control.clock();status='done' if state=='submitted' else 'failed'
        con.execute('UPDATE work_attempts SET status=?,finished_at_ms=? WHERE workspace_id=? AND attempt_id=?',(status,now,row['workspace_id'],attempt['attempt_id']));con.execute('UPDATE work_items SET status=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?',(status,now,row['workspace_id'],row['work_item_id']));con.execute('UPDATE experiment_result_slots SET status=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?',(status,now,row['workspace_id'],row['work_item_id']))
        if state=='execution_failed':
            self._seal_failure_tx(con,row,'execution')
            con.execute("UPDATE experiment_result_slots SET status='failed',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=? AND work_item_id IS NULL AND selected_result_id IS NULL",(now,row['workspace_id'],row['case_id']));self.experiments._settle(con,row['workspace_id'],row['experiment_id'])
        self._outbox(con,row,'benchmark.execution.completed.v1',{'job_id':row['job_id'],'completion_hash':digest,'completion_ref':ref,'needs_evaluation':state=='submitted'})
        return {'accepted':True,'status':state}

    def callback(self,action,capability,body,*,verified_device_client_id=None):
        body=copy.deepcopy(body);_bounded(body);prepared=None
        if isinstance(capability,str) and capability in _json(body):raise Forbidden('Callback credential cannot be persisted in a payload')
        if action=='artifact_put':
            with self.control.read_transaction() as con:
                row,_,_=self._verify_capability(con,capability,body,verified_device_client_id);request=self._load(row['request_hash'],row['request_ref'])
            prepared=self._prepare_artifact(row,request,body,capability)
        with self.control.transaction() as con:
            row,scope,attempt=self._verify_capability(con,capability,body,verified_device_client_id)
            if action in {'progress','artifact_put'}:self._close_intent(con,row,'benchmark.dispatch.requested.v1')
            if action=='artifact_read':return self._artifact_read_tx(con,row,body)
            if action in {'load_work','load_next_work','load_normalization_work'}:self._trusted(None,row['workspace_id'],body)
            if action=='load_work':return self._work(con,row,attempt)
            if action=='load_normalization_work':
                if row['kind']!='evaluate' or not row['completion_hash']:raise Conflict('Benchmark raw result is not ready for normalization')
                value=self._work(con,row,attempt);value['completion']=self._load(row['completion_hash'],row['completion_ref']);value['completion_hash']=row['completion_hash'];value['artifacts']=[self._artifact_read_tx(con,row,{'artifact_id':identity}) for identity in value['completion']['evidenceArtifactIds']]
                return value
            if action=='load_next_work':
                if row['kind']!='execute' or row['protocol_state']!='submitted':raise Conflict('Benchmark submission is not ready for evaluation')
                value=self._work(con,row,attempt);value['artifacts']=[self._artifact_read_tx(con,row,{'artifact_id':artifact['artifact_id']}) for artifact in con.execute('SELECT * FROM benchmark_artifacts WHERE workspace_id=? AND job_id=? ORDER BY name',(row['workspace_id'],row['job_id']))];return value
            if action=='execution_stage':
                self._trusted(None,row['workspace_id'],body);target=self._job_scope(con,scope,row['workspace_id'],body.get('target_job_id'),'execute')
                if target['kind']!='execute' or target['experiment_id']!=row['experiment_id'] or target['run_id']!=row['run_id']:raise Forbidden('Benchmark execution stage belongs to another plan')
                return self._stage_tx(con,target,scope,body.get('execution_action'),body|{'job_id':target['job_id']})
            if action=='claim_next_execution':
                self._trusted(None,row['workspace_id'],body)
                candidate=con.execute("SELECT j.job_id FROM benchmark_jobs j JOIN experiment_cases c ON c.workspace_id=j.workspace_id AND c.case_id=j.case_id WHERE j.workspace_id=? AND j.experiment_id=? AND j.run_id=? AND j.kind='execute' AND j.protocol_state='pending' AND c.state='active' ORDER BY c.ordinal,j.created_at_ms,j.job_id LIMIT 1",(row['workspace_id'],row['experiment_id'],row['run_id'])).fetchone()
                if not candidate:return None
                child=self._job_scope(con,scope,row['workspace_id'],candidate['job_id'],'execute');handle=self._claim_tx(con,child,{'worker_id':'benchmark-executor-controller'},scope)
                if not handle:return None
                child=dict(con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(child['workspace_id'],child['job_id'])).fetchone());return self._work(con,child,self._active(con,child,handle,scope))
            if action=='evaluation_prepare':
                self._trusted(None,row['workspace_id'],body)
                return self._evaluation_prepare_tx(con,row,scope,body,row['origin_credential_id'],row['origin_credential_kind'])

            if action in {'load_child_dispatch','child_dispatch_checkpoint'}:
                self._trusted(None,row['workspace_id'],body);child=self._job_scope(con,scope,row['workspace_id'],body.get('child_job_id'),'execute')
                if row['kind']!='execute' or child['kind']!='evaluate' or child['parent_job_id']!=row['job_id']:raise Forbidden('Evaluation dispatch belongs to another execution')
                if action=='load_child_dispatch':
                    if child['callback_attempt_id']:
                        current=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND attempt_id=?',(child['workspace_id'],child['callback_attempt_id'])).fetchone();handle=self._handle(child,current)
                    else:handle=self._claim_tx(con,child,{'worker_id':'benchmark-evaluator-controller'},scope)
                    if not handle:raise Conflict('Benchmark evaluation dispatch cannot be claimed')
                    current=self._active(con,child,handle,scope);child=dict(con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(child['workspace_id'],child['job_id'])).fetchone());child=self._issue_capability_tx(con,child,current,child['request_hash'],child['request_ref']);request=self._load(child['request_hash'],child['request_ref']);request['callbackHeaders']={'x-agent-insight-callback-token':self._capability(child)}
                    return {'request':request,'job':self._job_dto(child),'handle':self._handle(child,current)}
                receipt_body=body|{'operation_key':'callback:'+action+':'+_hash(body)};key,digest,old=self._receipt(con,scope,row['workspace_id'],'callback:'+action,receipt_body)
                if old:return self._load(old['response_hash'],old['response_ref'])
                current=self._active(con,child,body,scope,terminal=child['protocol_state'] in TERMINAL);state=body.get('state')
                if state not in {'accepted','unknown','failed'}:raise ValueError('Exact Benchmark dispatch acknowledgement required')
                child=self._ack_dispatch_tx(con,child,current,state)
                if not con.execute("SELECT 1 FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND aggregate_revision=? AND event_type='benchmark.dispatch.acknowledged.v1'",(child['workspace_id'],child['job_id'],child['revision'])).fetchone():self._outbox(con,child,'benchmark.dispatch.acknowledged.v1',{'job_id':child['job_id'],'state':state})
                value=self._job_dto(child);self._write_receipt(con,scope,row['workspace_id'],'callback:'+action,key,digest,value,job_id=child['job_id']);return value

            if action=='submission_reject':
                self._trusted(None,row['workspace_id'],body)
                return self._submission_reject_tx(con,row)

            if action in {'artifact_put','execution_complete','evaluation_complete','normalize_commit'}:
                receipt_body=body|{'operation_key':'callback:'+action+':'+_hash(body)};key,digest,old=self._receipt(con,scope,row['workspace_id'],'callback:'+action,receipt_body)
                if old:return self._load(old['response_hash'],old['response_ref'])
                if action=='artifact_put':value=self._artifact_put_tx(con,row,prepared)
                elif action=='execution_complete':value=self._execution_complete_tx(con,row,scope,attempt,body)
                elif action=='evaluation_complete':value=self._evaluation_complete_tx(con,row,scope,attempt,body)
                else:
                    self._trusted(None,row['workspace_id'],body);value=self._normalize_commit_tx(con,row,scope,attempt,body)

                self._write_receipt(con,scope,row['workspace_id'],'callback:'+action,key,digest,value,job_id=row['job_id']);return value
            if action!='progress':raise ValueError('Unsupported Benchmark callback action')
            progress=body.get('progress');allowed=['preparing','agent_running','collecting','uploading','cleaning'] if row['kind']=='execute' else ['downloading_artifacts','preparing_runtime','resolving_image','running_harness','collecting_evidence','uploading_evidence','cleaning']
            if not isinstance(progress,dict) or progress.get('kind')!=('execution' if row['kind']=='execute' else 'evaluation') or progress.get('stage') not in allowed:raise ValueError('Invalid Benchmark progress')
            try:
                import datetime
                timestamp=datetime.datetime.fromisoformat(progress.get('occurredAt','').replace('Z','+00:00')).timestamp()
                if not math.isfinite(timestamp):raise ValueError()
            except (ValueError,TypeError):raise ValueError('Valid Benchmark progress time required') from None
            if row['protocol_state'] in TERMINAL or row['completion_hash'] is not None:raise Conflict('Benchmark job no longer accepts progress')
            old=self._load(row['progress_hash'],row['progress_ref']) if row['progress_hash'] else None
            if old and (allowed.index(progress['stage'])<allowed.index(old['stage']) or progress['stage']==old['stage'] and progress['occurredAt']<old['occurredAt']):return {'accepted':True,'desiredState':'continue'}
            trace=(progress.get('progress') or {}).get('traceId')
            if trace is not None:identifier(trace)
            previous=(old or {}).get('progress',{}).get('traceId')
            if previous and trace and previous!=trace:raise Conflict('Execution Trace identity changed')
            if previous:progress['progress']={**progress.get('progress',{}),'traceId':previous}
            digest,ref=self._put(progress);state=progress['stage'] if row['kind']=='execute' and progress['stage'] in {'collecting','uploading','cleaning'} else 'running_agent' if row['kind']=='execute' else 'running_evaluator'
            self._job_bump(con,row,progress_hash=digest,progress_ref=ref,protocol_state=state);return {'accepted':True,'desiredState':'continue'}

    def _seal_failure_tx(self,con,row,stage):
        if stage not in {'execution','submission','dispatch','preparation'}:raise ValueError('Known definite Benchmark failure stage required')
        ws=row['workspace_id'];scope=self.iam._scope_registered_credential(con,row['origin_credential_id'],row['origin_credential_kind'])
        packet={'format':'benchmark.failure-source/v1','workspace_id':ws,'experiment_id':row['experiment_id'],'run_id':row['run_id'],'case_id':row['case_id'],'job_id':row['job_id'],'stage':stage,'terminal_state':row['protocol_state'],'request_hash':row['request_hash'],'completion_hash':row['completion_hash'],'external_attempt_id':row['callback_attempt_id'],'external_fence':str(row['callback_fence']) if row['callback_fence'] is not None else None,'failureCode':'BENCHMARK_'+stage.upper()+'_FAILED','harnessExecuted':False,'evaluatorModelExecuted':False,'not_started':stage in {'preparation','dispatch'},'cleanup_confirmed':stage=='execution'}
        key='source:'+row['job_id'];old=con.execute("SELECT * FROM benchmark_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind='failure-source' AND operation_key=?",(ws,row['actor_principal_id'],key)).fetchone()
        if old:
            if self._load(old['response_hash'],old['response_ref'])!=packet:raise Conflict('Benchmark failure source is immutable')
            return old['response_hash']
        self._write_receipt(con,scope,ws,'failure-source',key,_hash(packet),packet,job_id=row['job_id'])
        saved=con.execute("SELECT response_hash FROM benchmark_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind='failure-source' AND operation_key=?",(ws,row['actor_principal_id'],key)).fetchone();source_hash=saved['response_hash']
        self._outbox(con,row,'benchmark.failure.classification.requested.v1',{'job_id':row['job_id'],'failure_source_hash':source_hash});return source_hash

    def _failure_source(self,con,scope,ws,identity,expected_hash):
        row=self._job_scope(con,scope,ws,identity,'read')
        origin=self.iam._scope_registered_credential(con,row['origin_credential_id'],row['origin_credential_kind']);self.iam._workspace(origin,ws,'write');self.iam._workspace(origin,ws,'execute')
        if origin.principal_id!=row['actor_principal_id']:raise Forbidden('Benchmark failure origin changed')
        self._source_acl(con,origin,ws,row['experiment_id'],row['run_id'])
        receipt=con.execute("SELECT * FROM benchmark_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind='failure-source' AND operation_key=? AND job_id=?",(ws,row['actor_principal_id'],'source:'+identity,identity)).fetchone()
        if not receipt or receipt['response_hash']!=expected_hash:raise Conflict('Exact immutable Benchmark failure source required')
        packet=self._load(receipt['response_hash'],receipt['response_ref']);stage=packet.get('stage');states={'execution':'execution_failed','submission':'submission_invalid','dispatch':'dispatch_failed','preparation':'blocked'}
        if stage not in states or row['protocol_state']!=states[stage] or packet.get('terminal_state')!=states[stage] or packet.get('format')!='benchmark.failure-source/v1':raise Conflict('Benchmark failure source is no longer terminal')
        for key,value in {'workspace_id':ws,'experiment_id':row['experiment_id'],'run_id':row['run_id'],'case_id':row['case_id'],'job_id':identity,'request_hash':row['request_hash'],'completion_hash':row['completion_hash'],'external_attempt_id':row['callback_attempt_id'],'external_fence':str(row['callback_fence']) if row['callback_fence'] is not None else None}.items():
            if packet.get(key)!=value:raise Conflict('Benchmark failure source identity differs')
        if stage=='execution':
            completion=self._load(row['completion_hash'],row['completion_ref']) if row['completion_hash'] else {}
            if row['kind']!='execute' or completion.get('status')!='failed' or completion.get('cleanup',{}).get('status')!='succeeded':raise Conflict('Execution failure cleanup is not confirmed')
        if stage=='submission' and (row['kind']!='execute' or not row['completion_hash'] or con.execute('SELECT 1 FROM benchmark_jobs WHERE workspace_id=? AND parent_job_id=?',(ws,identity)).fetchone()):raise Conflict('Submission rejection no longer precedes evaluation')
        if stage=='preparation' and row['request_hash'] is not None:raise Conflict('Preparation failure had an external request')
        return row,packet

    def _classify_failure_tx(self,con,row,scope,source_hash):
        ws=row['workspace_id'];row,source=self._failure_source(con,scope,ws,row['job_id'],source_hash)
        if scope.principal_id!=row['actor_principal_id']:raise Forbidden('Benchmark failure classification requires original owner')
        _,binding=self._binding(con,ws,row['experiment_id']);evaluator=binding['adapter']['evaluatorId'];_,plan=self.experiments._plan(con,ws,row['experiment_id'],row['run_id'])
        if sum(member.get('case_key')==row['case_id'] and member.get('evaluator_slot')==evaluator for member in plan.get('work_members',[]))!=1:raise Conflict('Failure primary work is not a unique frozen plan member')
        slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,row['case_id'],evaluator)).fetchone()
        work=con.execute('SELECT * FROM work_items WHERE workspace_id=? AND work_item_id=?',(ws,slot['work_item_id'] if slot else None)).fetchone()
        if not slot or slot['run_id']!=row['run_id'] or not work or work['run_id']!=row['run_id'] or work['case_key']!=row['case_id'] or work['evaluator_slot']!=evaluator or work['phase']!='publish' or work['cancel_requested']:raise Conflict('Benchmark primary work has been superseded')
        siblings=con.execute('SELECT COUNT(*) FROM work_items WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(ws,row['run_id'],row['case_id'],evaluator)).fetchone()[0]
        if siblings!=1:raise Conflict('Benchmark primary scoring work must be unique')
        receipt_key='benchmark-failure:'+row['job_id']+':'+source_hash
        old=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND run_id=? AND receipt_key=?',(ws,row['run_id'],receipt_key)).fetchone()
        if old:
            if slot['selected_result_id']!=old['result_id']:raise Conflict('Benchmark failure selection has changed')
            self._close_intent(con,row,'benchmark.failure.classification.requested.v1');return {'accepted':True,'result_id':old['result_id'],'status':'failed','score':None}
        if slot['selected_result_id'] is not None or work['status'] not in {'queued','failed'}:raise Conflict('Benchmark primary result is already running or selected')
        now=self.control.clock();item=work['work_item_id'];attempt=str(uuid.uuid4());fence=revision(work['etag']+1);number=con.execute('SELECT COALESCE(MAX(attempt_no),0)+1 FROM work_attempts WHERE workspace_id=? AND work_item_id=?',(ws,item)).fetchone()[0];worker='benchmark-failure-classifier'
        con.execute("UPDATE work_items SET status='failed',etag=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(fence,now,ws,item))
        con.execute("INSERT INTO work_attempts(workspace_id,attempt_id,work_item_id,attempt_no,fence,worker_id,status,lease_until_ms,started_at_ms,finished_at_ms,error_code) VALUES(?,?,?,?,?,?,'failed',?,?,?,?)",(ws,attempt,item,number,fence,worker,now+30000,now,now,source['failureCode']))
        head=self._head_scope(con,scope,ws,row['experiment_id']);case=self.experiments._case(con,ws,row['experiment_id'],row['case_id']);cp_hash,cp_ref=self._put({'phase':'benchmark:classification','checkpoint':{'job_id':row['job_id'],'failure_source_hash':source_hash}})
        con.execute("INSERT INTO experiment_attempt_checkpoints(workspace_id,experiment_id,case_id,run_id,work_item_id,attempt_id,fence,lease_owner,actor_principal_id,lifecycle_revision,case_lifecycle_revision,payload_hash,payload_ref,stage,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'terminal',?,?)",(ws,row['experiment_id'],row['case_id'],row['run_id'],item,attempt,fence,worker,scope.principal_id,head['lifecycle_revision'],case['lifecycle_revision'],cp_hash,cp_ref,now,now))
        result={'status':'failed','score':None,'summary':'Benchmark '+source['stage']+'失败，未运行评分Harness','points':[],'evidence':{'origin':'benchmark-failure-classifier','stage':source['stage'],'failureCode':source['failureCode'],'failureSourceHash':source_hash,'harnessExecuted':False,'evaluatorModelExecuted':False},'metrics':[]}
        packet={'format':'agent-insight.machine-result','version':1,'result':result,'run_id':row['run_id'],'case_key':row['case_id'],'evaluator_slot':evaluator,'attempt_id':attempt,'fence':str(fence),'benchmark_failure_job_id':row['job_id'],'benchmark_failure_source_hash':source_hash};digest,ref=self._put(packet);machine=str(uuid.uuid4())
        con.execute('INSERT INTO result_receipts(workspace_id,run_id,work_item_id,case_key,evaluator_slot,receipt_id,attempt_id,receipt_key,result_id,content_hash,artifact_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(ws,row['run_id'],item,row['case_id'],evaluator,str(uuid.uuid4()),attempt,receipt_key,machine,digest,ref,now))
        if con.execute('SELECT 1 FROM result_selections WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(ws,row['run_id'],row['case_id'],evaluator)).fetchone():raise Conflict('Benchmark failure cannot replace an existing selection')
        con.execute('INSERT INTO result_selections VALUES(?,?,?,?,?,1,?)',(ws,row['run_id'],row['case_id'],evaluator,machine,now));con.execute("UPDATE experiment_result_slots SET selected_result_id=?,review_id=NULL,status='failed',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?",(machine,now,ws,slot['result_id']))
        event={'experiment_id':row['experiment_id'],'lifecycle_revision':head['lifecycle_revision'],'result_id':machine,'content_hash':digest,'artifact_ref':ref,'run_id':row['run_id'],'attempt_id':attempt,'case_key':row['case_id'],'evaluator_slot':evaluator,'selection_revision':1,'slot_id':slot['result_id'],'result_bucket':_iso(now)[:10],'case_lifecycle_revision':case['lifecycle_revision'],'source_trace_id':case['trace_id'],'benchmark_failure_job_id':row['job_id'],'benchmark_failure_source_hash':source_hash,'authorization':{'credential_id':row['origin_credential_id'],'kind':row['origin_credential_kind'],'principal_id':scope.principal_id}}
        con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'evaluation.result.accepted.v1',?,?,?)",(ws,str(uuid.uuid4()),attempt,fence,canonical_json(event),self.experiments._queued_at(con,now),now))
        self._close_intent(con,row,'benchmark.failure.classification.requested.v1')
        continuation=row if row['kind']=='execute' else dict(con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,row['parent_job_id'])).fetchone())
        self._outbox(con,continuation,'benchmark.continuation.requested.v1',{'job_id':continuation['job_id'],'machine_result_id':machine,'needs_supplemental':(row['kind']=='execute' or row['attempt_no']==1) and any(not key.startswith('benchmark:') for key in json.loads(plan['experiment_config'].get('evaluatorIdsJson') or '[]'))});self.experiments._settle(con,ws,row['experiment_id']);return {'accepted':True,'result_id':machine,'status':'failed','score':None}

    def _submission_reject_tx(self,con,row):
        if row['kind']=='execute' and row['protocol_state']=='submission_invalid':return {'accepted':True,'status':'submission_invalid'}
        if row['kind']!='execute' or row['protocol_state']!='submitted':raise Conflict('Benchmark submission validation is no longer current')
        child=con.execute('SELECT 1 FROM benchmark_jobs WHERE workspace_id=? AND parent_job_id=?',(row['workspace_id'],row['job_id'])).fetchone()
        if child:raise Conflict('Benchmark evaluation already exists')
        message='提交物未通过冻结Adapter验证，原产物已保留';digest,ref=self._put({'failureCode':'SUBMISSION_INVALID','failureMessage':message});row=self._job_bump(con,row,protocol_state='submission_invalid',progress_hash=digest,progress_ref=ref);now=self.control.clock()
        con.execute("UPDATE experiment_result_slots SET status='failed',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=? AND evaluator_id=? AND selected_result_id IS NULL",(now,row['workspace_id'],row['case_id'],'benchmark:'+self._binding(con,row['workspace_id'],row['experiment_id'])[1]['adapter']['evaluation']['evaluatorKey']))
        self._seal_failure_tx(con,row,'submission');self._close_intent(con,row,'benchmark.execution.completed.v1');self._outbox(con,row,'benchmark.submission.rejected.v1',{'job_id':row['job_id'],'reason_hash':digest,'reason_ref':ref});self.experiments._settle(con,row['workspace_id'],row['experiment_id']);return {'accepted':True,'status':'submission_invalid'}


    def _case_cleanup_ready(self,con,ws,exp,case_id):
        rows=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND experiment_id=? AND case_id=? ORDER BY created_at_ms,job_id',(ws,exp,case_id)).fetchall()
        if len(rows)>20000:raise BenchmarkTooLarge('Case cleanup history exceeds budget')
        for row in rows:
            if not self._cleanup_complete(con,dict(row)):raise Conflict('Benchmark external cleanup is unconfirmed')
        from .benchmark_cancellation import native_confirmed
        cps=con.execute("SELECT c.*,a.status AS attempt_status,a.error_code FROM experiment_attempt_checkpoints c JOIN work_attempts a ON a.workspace_id=c.workspace_id AND a.attempt_id=c.attempt_id JOIN work_items w ON w.workspace_id=c.workspace_id AND w.work_item_id=c.work_item_id WHERE c.workspace_id=? AND c.experiment_id=? AND c.case_id=? AND w.phase='evaluate'",(ws,exp,case_id)).fetchall()
        if len(cps)>20000:raise BenchmarkTooLarge('Native Case cleanup history exceeds budget')
        for cp in cps:
            if cp['attempt_status'] in {'running','cancelled','expired'} or cp['error_code']=='EVALUATION_CLEANUP_UNCONFIRMED':
                if not native_confirmed(self,con,ws,exp,cp):raise Conflict('Native scoring cleanup is unconfirmed')

    def _case_retry_source(self,con,scope,ws,body):
        exp=body['experiment_id'];case_id=identifier(body.get('case_id'));head=self._head_scope(con,scope,ws,exp,'execute');self.iam._workspace(scope,ws,'write')
        if head['created_by']!=scope.principal_id:raise Forbidden('Benchmark Case retry requires original owner')
        _,binding=self._binding(con,ws,exp)
        if binding['run_config'].get('submissionSource')=='imported':raise Conflict('Imported submissions cannot rerun an Agent')
        self.experiments._case(con,ws,exp,case_id)
        if con.execute("SELECT 1 FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND status IN ('pending','running')",(ws,case_id)).fetchone():raise Conflict('Benchmark Case work has not settled')
        slot=con.execute("SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id='__execution__'",(ws,case_id)).fetchone();previous=con.execute("SELECT * FROM benchmark_jobs WHERE workspace_id=? AND experiment_id=? AND case_id=? AND kind='execute' AND work_item_id=?",(ws,exp,case_id,slot['work_item_id'] if slot else None)).fetchone()
        if not previous or previous['protocol_state'] not in TERMINAL:raise Conflict('Benchmark Case execution is not terminal')
        primary=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,case_id,binding['adapter']['evaluatorId'])).fetchone()
        if primary is None:raise Conflict('Benchmark primary slot unavailable')
        self._source_acl(con,scope,ws,exp,previous['run_id']);self._case_cleanup_ready(con,ws,exp,case_id)
        return head,dict(previous),dict(primary)

    def _prepare_case_retry(self,token,ws,body):
        self._trusted(token,ws,body)
        with self.control.read_transaction() as con:
            scope=self._scope(con,token,ws,'execute');_,previous,primary=self._case_retry_source(con,scope,ws,body)
            return {'case_id':previous['case_id'],'previous_job_id':previous['job_id'],'expected_machine_result_id':primary['selected_result_id']}

    def _retry_case_tx(self,con,token,ws,scope,body):
        _,previous,primary=self._case_retry_source(con,scope,ws,body)
        if body.get('previous_job_id')!=previous['job_id'] or 'expected_machine_result_id' not in body or body['expected_machine_result_id']!=primary['selected_result_id']:raise Conflict('Benchmark Case retry source changed')
        _,plan=self.experiments._plan(con,ws,body['experiment_id'],previous['run_id']);config=copy.deepcopy(plan['config']);start={'experiment_id':body['experiment_id'],'case_ids':[previous['case_id']],'config':config,'model_selection':config.get('model_selection'),'scheduler_limits':config['scheduler_limits'],'public_callback_origin':config['public_callback_origin'],'executor_callback_origin':config['executor_callback_origin'],'frozen_evaluators':copy.deepcopy(plan['frozen_evaluators']),'releases':{key:value for key,value in plan['releases'].items() if key.split(':',1)[0]!='benchmark'}}
        return self._start_tx(con,token,ws,scope,start,retry_case=previous)

    def _cleanup_complete(self,con,row):
        if row['protocol_state']=='cancelled' and row['callback_token_hash'] is None:return True
        if row['completion_hash']:
            completion=self._load(row['completion_hash'],row['completion_ref']);cleanup=completion.get('cleanup',{})
            if (cleanup.get('controller') or cleanup).get('status')=='succeeded':return True
        receipt=con.execute("SELECT * FROM benchmark_operation_receipts WHERE workspace_id=? AND actor_principal_id=? AND operation_kind='failure-source' AND operation_key=?",(row['workspace_id'],row['actor_principal_id'],'source:'+row['job_id'])).fetchone()
        if receipt:
            packet=self._load(receipt['response_hash'],receipt['response_ref'])
            if packet.get('stage') in {'dispatch','preparation'} and (packet.get('terminal_state')==row['protocol_state'] or row['protocol_state']=='cancelled') and packet.get('request_hash')==row['request_hash'] and packet.get('completion_hash')==row['completion_hash']:return True
        from .benchmark_cancellation import confirmed
        return confirmed(self,con,row)

    def _evaluation_retry_source(self,con,scope,ws,body):
        exp=body['experiment_id'];head=self._head_scope(con,scope,ws,exp,'execute')
        if head['created_by']!=scope.principal_id:raise Forbidden('Benchmark retry requires original owner')
        self.iam._workspace(scope,ws,'write');_,binding=self._binding(con,ws,exp);slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND experiment_id=? AND result_id=?',(ws,exp,body.get('result_id'))).fetchone()
        if not slot or slot['evaluator_id']!=binding['adapter']['evaluatorId']:raise BenchmarkNotFound('Benchmark primary result unavailable')
        self.experiments._case(con,ws,exp,slot['case_id'])
        if slot['status'] not in {'done','failed'} or slot['selected_result_id'] is None:raise Conflict('Benchmark primary result is still running')
        if con.execute("SELECT 1 FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND status IN ('pending','running')",(ws,slot['case_id'])).fetchone():raise Conflict('Benchmark Case continuation has not settled')
        job=con.execute("SELECT * FROM benchmark_jobs WHERE workspace_id=? AND experiment_id=? AND case_id=? AND kind='evaluate' AND work_item_id=? AND run_id=?",(ws,exp,slot['case_id'],slot['work_item_id'],slot['run_id'])).fetchone()
        if not job or job['protocol_state'] not in TERMINAL:raise Conflict('Benchmark evaluation is not terminal')
        job=dict(job);parent=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,job['parent_job_id'])).fetchone()
        if not parent or parent['kind']!='execute' or not self._cleanup_complete(con,dict(parent)) or not self._cleanup_complete(con,job):raise Conflict('Benchmark external cleanup is unconfirmed')
        self._source_acl(con,scope,ws,exp,job['run_id']);self._source_acl(con,scope,ws,exp,parent['run_id'])
        if con.execute("SELECT 1 FROM outbox_events WHERE workspace_id=? AND aggregate_id=? AND event_type='benchmark.continuation.requested.v1' AND state<>'sent'",(ws,job['job_id'])).fetchone():raise Conflict('Benchmark continuation has not converged')
        return head,dict(slot),job,dict(parent)

    def _prepare_evaluation_retry(self,token,ws,body):
        self._trusted(token,ws,body)
        with self.control.read_transaction() as con:
            scope=self._scope(con,token,ws,'execute');_,slot,job,parent=self._evaluation_retry_source(con,scope,ws,body)
            attempt=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND work_item_id=? ORDER BY attempt_no DESC LIMIT 1',(ws,parent['work_item_id'])).fetchone()
            if not attempt:raise Conflict('Benchmark submission work unavailable')
            work=self._work(con,parent,attempt);work['artifacts']=[self._artifact_read_tx(con,parent,{'artifact_id':a['artifact_id']}) for a in con.execute('SELECT artifact_id FROM benchmark_artifacts WHERE workspace_id=? AND job_id=? ORDER BY name',(ws,parent['job_id']))]
            previous_request=self._load(job['request_hash'],job['request_ref']);value={'dispatch_target':previous_request.get('dispatchTarget'),'work':work,'previous_job_id':job['job_id'],'expected_machine_result_id':slot['selected_result_id'],'next_attempt_no':job['attempt_no']+1};fingerprint=scope.fingerprint;runs=[job['run_id'],parent['run_id']]
        self._read_postflight(token,ws,body['experiment_id'],runs,fingerprint);return value

    def _new_evaluation_retry_plan(self,con,scope,ws,head,slot,job):
        _,original=self.experiments._plan(con,ws,head['experiment_id'],job['run_id']);plan=copy.deepcopy(original);run=str(uuid.uuid4());now=self.control.clock();exp=head['experiment_id'];generation=con.execute('SELECT COALESCE(MAX(generation),0)+1 FROM experiment_runs WHERE workspace_id=? AND experiment_id=?',(ws,exp)).fetchone()[0];case=self.experiments._case(con,ws,exp,slot['case_id'])
        plan.update(run_id=run,parent_run_id=job['run_id'],generation=generation,cases=[row for row in plan['cases'] if row['id']==slot['case_id']],expected_case_count=1,work_members=[{'case_key':slot['case_id'],'evaluator_slot':slot['evaluator_id']}]);plan['frozen_trace_evidence']={key:value for key,value in plan.get('frozen_trace_evidence',{}).items() if key==slot['case_id']};plan['config'].update(benchmark_lifecycle=head['lifecycle_revision'],benchmark_case_lifecycles={slot['case_id']:case['lifecycle_revision']},benchmark_retry_kind='evaluation',benchmark_retry_of_job_id=job['job_id'],benchmark_retry_parent_execution_job_id=job['parent_job_id'])
        if len(plan['cases'])!=1:raise Conflict('Benchmark retry Case lacks frozen membership')
        digest,ref=self._put(plan);con.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,dataset_release_id,expected_case_count,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,1,'draft',?,?)",(ws,run,head['name'],digest,ref,plan['releases']['dataset'],now,now));con.execute('INSERT INTO experiment_runs VALUES(?,?,?,?,?,?,?)',(ws,exp,run,generation,head['lifecycle_revision'],scope.principal_id,now))
        for key,release in plan['releases'].items():con.execute('INSERT INTO run_inputs VALUES(?,?,?,?,?,?)',(ws,run,key,release,_hash(plan['config']),now))
        item=str(uuid.uuid4());con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'publish',?,'queued',?,?)",(ws,item,run,slot['case_id'],slot['evaluator_id'],now,now));con.execute("UPDATE experiment_result_slots SET run_id=?,work_item_id=?,selected_result_id=NULL,review_id=NULL,status='pending',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?",(run,item,now,ws,slot['result_id']));con.execute("UPDATE runs SET status='queued',updated_at_ms=? WHERE workspace_id=? AND run_id=?",(now,ws,run));self.experiments._bump(con,ws,exp,current_run_id=run,status='running');return run

    def _retry_evaluation_tx(self,con,token,ws,scope,body):
        head,slot,previous,parent=self._evaluation_retry_source(con,scope,ws,body)
        if body.get('previous_job_id')!=previous['job_id'] or body.get('expected_machine_result_id')!=slot['selected_result_id']:raise Conflict('Benchmark evaluation retry source changed')
        request=body.get('request')
        if not isinstance(request,dict) or request.get('runId')==previous['job_id']:raise ValueError('Benchmark retry requires a new external job identity')
        original_request=self._load(previous['request_hash'],previous['request_ref'])
        if request.get('dispatchTarget')!=original_request.get('dispatchTarget'):raise Conflict('Benchmark retry must retain its frozen evaluator target')
        run=self._new_evaluation_retry_plan(con,scope,ws,head,slot,previous);origin_id,origin_kind=self._origin(con,token);value=self._evaluation_prepare_tx(con,parent,scope,body,origin_id,origin_kind,retry={'run_id':run,'previous':previous})
        return value|{'runplan_id':run,'status':'running'}

    def _evaluation_prepare_tx(self,con,parent,scope,body,origin_id,origin_kind,retry=None):
        if parent['kind']!='execute' or not parent['completion_hash'] or retry is None and parent['protocol_state']!='submitted':raise Conflict('Only validated submitted Benchmark execution may be evaluated')
        ws=parent['workspace_id'];old=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND parent_job_id=? ORDER BY attempt_no DESC LIMIT 1',(ws,parent['job_id'])).fetchone()
        if old and retry is None and not body.get('force_new_attempt'):
            self._close_intent(con,parent,'benchmark.execution.completed.v1');return {'evaluationRunId':old['job_id'],'status':old['protocol_state'],'created':False}
        if body.get('force_new_attempt'):raise Conflict('Explicit Benchmark evaluation retry requires its own frozen retry action')
        request=copy.deepcopy(body.get('request'));job=request.get('evaluationJob') if isinstance(request,dict) else None
        if not isinstance(job,dict) or not isinstance(request.get('runId'),str) or 'callbackHeaders' in request or job.get('protocolVersion')!='benchmark-evaluation/v1' or job.get('evaluationId')!=request['runId'] or job.get('executionRunId')!=parent['job_id']:raise ValueError('Exact frozen Benchmark evaluation request required')
        identifier(request['runId']);_hex(request.get('requestDigest'));context=job.get('context',{})
        _,binding=self._binding(con,ws,parent['experiment_id']);dataset=con.execute('SELECT content_hash FROM benchmark_dataset_heads WHERE workspace_id=? AND dataset_id=?',(ws,binding['dataset_id'])).fetchone();adapter=binding['adapter'];evaluator=adapter['evaluation']['evaluatorKey']
        if context.get('experimentId')!=parent['experiment_id'] or context.get('caseId')!=parent['case_id'] or _hex(context.get('datasetContentHash'))!=dataset['content_hash'] or job.get('benchmark',{}).get('key')!=adapter['key'] or job.get('evaluator',{}).get('key')!=evaluator:raise Conflict('Evaluation source differs from frozen Benchmark binding')
        timeout=request.get('timeoutSeconds')
        if type(timeout) is not int or timeout!=adapter['evaluation']['defaultTimeoutSeconds'] or job.get('limits',{}).get('timeoutSeconds')!=timeout:raise Conflict('Evaluation limits differ from frozen adapter')
        target_run=retry['run_id'] if retry else parent['run_id'];_,plan=self.experiments._plan(con,ws,parent['experiment_id'],target_run);origin=plan['config']['public_callback_origin'].rstrip('/')
        if request.get('platformBaseUrl','').rstrip('/')!=origin or request.get('callbackBaseUrl','').rstrip('/')!=origin+'/api/benchmark/v1/evaluations/'+request['runId']:raise Conflict('Evaluation callback differs from frozen origin')
        artifacts={row['artifact_id']:dict(row) for row in con.execute('SELECT * FROM benchmark_artifacts WHERE workspace_id=? AND job_id=?',(ws,parent['job_id']))};submitted=self._load(parent['completion_hash'],parent['completion_ref'])['artifacts'];required_ids={value['artifactId'] for value in submitted};members=job.get('artifacts')
        if not isinstance(members,list) or len(members)!=len(required_ids) or {value.get('artifactId') for value in members}!=required_ids:raise Conflict('Evaluation inputs differ from submitted artifact set')
        for member in members:
            actual=artifacts.get(member['artifactId'])
            if not actual or member.get('name')!=actual['name'] or member.get('mediaType')!=actual['media_type'] or member.get('sizeBytes')!=actual['size_bytes'] or _hex(member.get('sha256'))!=actual['content_hash']:raise Conflict('Evaluation artifact content differs')
        self._close_intent(con,parent,'benchmark.execution.completed.v1')
        now=self.control.clock();identity=request['runId'];slot=adapter['evaluatorId'];digest,ref=self._put(request)
        primary=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,parent['case_id'],slot)).fetchone()
        if primary and primary['work_item_id'] is not None:
            item=primary['work_item_id'];work=con.execute('SELECT * FROM work_items WHERE workspace_id=? AND work_item_id=?',(ws,item)).fetchone()
            if primary['run_id']!=target_run or not work or work['status']!='queued' or work['cancel_requested']:raise Conflict('Frozen primary scoring work is no longer available')
        else:
            item=str(uuid.uuid4());con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'publish',?,'queued',?,?)",(ws,item,target_run,parent['case_id'],slot,now,now))
        self._insert(con,'benchmark_jobs',{'workspace_id':ws,'job_id':identity,'experiment_id':parent['experiment_id'],'case_id':parent['case_id'],'run_id':target_run,'work_item_id':item,'kind':'evaluate','parent_job_id':parent['job_id'],'adapter_key':adapter['key'],'evaluator_key':evaluator,'attempt_no':retry['previous']['attempt_no']+1 if retry else 1,'retry_of_job_id':retry['previous']['job_id'] if retry else None,'origin_credential_id':origin_id,'origin_credential_kind':origin_kind,'actor_principal_id':scope.principal_id,'protocol_state':'queued','revision':1,'request_hash':digest,'request_ref':ref,'callback_epoch':1,'created_at_ms':now,'updated_at_ms':now})
        con.execute("UPDATE experiment_result_slots SET run_id=?,work_item_id=?,selected_result_id=NULL,review_id=NULL,status='pending',revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND case_id=? AND evaluator_id=?",(target_run,item,now,ws,parent['case_id'],slot))
        self._outbox(con,dict(con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,identity)).fetchone()),'benchmark.evaluation.prepared.v1',{'job_id':identity,'parent_job_id':parent['job_id']})
        self._outbox(con,{'workspace_id':ws,'job_id':identity,'revision':1},'benchmark.dispatch.requested.v1',{'job_id':identity,'request_hash':digest,'request_ref':ref})
        return {'evaluationRunId':identity,'status':'queued','created':True}

    def _evaluation_complete_tx(self,con,row,scope,attempt,body):
        completion=body.get('completion')
        if row['kind']!='evaluate' or not isinstance(completion,dict) or completion.get('status') not in {'completed','submission_invalid','failed'} or 'rawResult' not in completion or not isinstance(completion.get('evidenceArtifactIds'),list) or 'runtimeFacts' not in completion or 'cleanup' not in completion:raise ValueError('Complete Benchmark evaluation terminal required')
        digest,ref=self._put(completion)
        if row['completion_hash']:
            if row['completion_hash']!=digest:raise Conflict('Evaluation completion has different immutable content')
            return {'accepted':True,'evaluationStatus':row['protocol_state'],'completion_hash':digest,'normalizationStatus':'completed' if row['protocol_state'] in TERMINAL else 'pending'}
        if row['protocol_state'] in TERMINAL:raise Conflict('Evaluation is no longer active')
        artifacts={value['artifact_id'] for value in con.execute('SELECT artifact_id FROM benchmark_artifacts WHERE workspace_id=? AND job_id=?',(row['workspace_id'],row['job_id']))};members=completion['evidenceArtifactIds']
        if len(members)!=len(set(members)) or not set(members)<=artifacts:raise Conflict('Evaluation completion references another job artifact')
        cleanup=completion['cleanup']
        if not isinstance(cleanup,dict) or (cleanup.get('controller') or cleanup).get('status')!='succeeded':raise Conflict('Evaluator controller cleanup is unconfirmed')
        self._close_intent(con,row,'benchmark.dispatch.requested.v1')
        row=self._job_bump(con,row,completion_hash=digest,completion_ref=ref,protocol_state='normalizing');self._outbox(con,row,'benchmark.evaluation.raw.accepted.v1',{'job_id':row['job_id'],'completion_hash':digest,'completion_ref':ref})
        return {'accepted':True,'evaluationStatus':'normalizing','completion_hash':digest,'normalizationStatus':'pending'}

    def _normalize_commit_tx(self,con,row,scope,attempt,body):
        if row['kind']!='evaluate' or not row['completion_hash'] or body.get('raw_completion_hash')!=row['completion_hash']:raise Conflict('Normalization does not match the accepted raw completion')
        normalized=copy.deepcopy(body.get('normalized'))
        if not isinstance(normalized,dict) or normalized.get('status') not in {'done','failed'} or not isinstance(normalized.get('summary'),str) or not isinstance(normalized.get('points'),list) or 'evidence' not in normalized:raise ValueError('Complete normalized Benchmark result required')
        score=normalized.get('score')
        if score is not None and (type(score) not in (int,float) or not math.isfinite(score) or not 0<=score<=100):raise ValueError('Benchmark score must be finite 0..100 or null')
        if row['protocol_state'] in TERMINAL:
            receipt=con.execute('SELECT content_hash,artifact_ref FROM result_receipts WHERE workspace_id=? AND work_item_id=?',(row['workspace_id'],row['work_item_id'])).fetchone()
            packet=self._load(receipt['content_hash'],receipt['artifact_ref']) if receipt else None
            if packet and packet.get('raw_completion_hash')==row['completion_hash'] and packet.get('normalized_hash',_hash({key:value for key,value in packet['result'].items() if key!='metrics'}))==_hash(normalized):return {'accepted':True,'evaluationStatus':row['protocol_state'],'normalizationStatus':'completed','normalizedResult':normalized}
            raise Conflict('Benchmark result is already selected')
        if row['protocol_state'] not in {'normalizing','normalization_failed'}:raise Conflict('Benchmark raw result is not ready for normalization')
        ws=row['workspace_id'];evaluator='benchmark:'+row['evaluator_key'];slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,row['case_id'],evaluator)).fetchone()
        if not slot or slot['work_item_id']!=row['work_item_id'] or slot['run_id']!=row['run_id']:raise Conflict('Benchmark result slot has been superseded')
        result=copy.deepcopy(normalized);metrics=[];primary=normalized.get('primaryMetric')
        if primary is not None:
            if not isinstance(primary,dict) or not isinstance(primary.get('key'),str) or primary.get('aggregation') not in {'boolean-rate','mean'} or primary.get('value') is not None and type(primary.get('value')) not in (bool,int,float):raise ValueError('Invalid Benchmark primary metric')
            metrics.append({'key':'benchmark.primary.'+primary['key'],'value':primary.get('value'),'method':primary['aggregation']})
        if isinstance(normalized.get('nativeMetrics'),dict):
            for key,value in normalized['nativeMetrics'].items():
                if value is None or type(value) in (bool,int,float,str):metrics.append({'key':'benchmark.native.'+key,'value':value})
        if len(metrics)>999:raise BenchmarkTooLarge('Benchmark metrics exceed budget')
        result['metrics']=metrics
        for name in ('humanScore','humanReason','humanBy','humanAt','id','caseId','experimentId','evaluatorId','user'):result.pop(name,None)
        packet={'format':'agent-insight.machine-result','version':1,'result':result,'run_id':row['run_id'],'case_key':row['case_id'],'evaluator_slot':evaluator,'attempt_id':attempt['attempt_id'],'fence':str(attempt['fence']),'benchmark_job_id':row['job_id'],'raw_completion_hash':row['completion_hash'],'normalized_hash':_hash(normalized)};digest,ref=self._put(packet);now=self.control.clock();machine=str(uuid.uuid4());receipt=str(uuid.uuid4());receipt_key='benchmark-normalize:'+row['job_id']+':'+row['completion_hash']
        con.execute('INSERT INTO result_receipts(workspace_id,run_id,work_item_id,case_key,evaluator_slot,receipt_id,attempt_id,receipt_key,result_id,content_hash,artifact_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(ws,row['run_id'],row['work_item_id'],row['case_id'],evaluator,receipt,attempt['attempt_id'],receipt_key,machine,digest,ref,now))
        old=con.execute('SELECT selection_revision FROM result_selections WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(ws,row['run_id'],row['case_id'],evaluator)).fetchone();selection=revision(old[0]+1) if old else 1
        if old:con.execute('UPDATE result_selections SET result_id=?,selection_revision=?,updated_at_ms=? WHERE workspace_id=? AND run_id=? AND case_key=? AND evaluator_slot=?',(machine,selection,now,ws,row['run_id'],row['case_id'],evaluator))
        else:con.execute('INSERT INTO result_selections VALUES(?,?,?,?,?,?,?)',(ws,row['run_id'],row['case_id'],evaluator,machine,selection,now))
        status=normalized['status'];con.execute('UPDATE work_attempts SET status=?,finished_at_ms=? WHERE workspace_id=? AND attempt_id=?',(status,now,ws,attempt['attempt_id']));con.execute('UPDATE work_items SET status=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?',(status,now,ws,row['work_item_id']));con.execute('UPDATE experiment_result_slots SET selected_result_id=?,review_id=NULL,status=?,revision=revision+1,updated_at_ms=? WHERE workspace_id=? AND result_id=?',(machine,status,now,ws,slot['result_id']))
        raw=self._load(row['completion_hash'],row['completion_ref']);state='failed' if status=='failed' else 'submission_invalid' if raw['status']=='submission_invalid' else 'completed';row=self._job_bump(con,row,protocol_state=state)
        parent=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,row['parent_job_id'])).fetchone()
        if parent:self._job_bump(con,dict(parent),protocol_state='completed' if status=='done' else 'evaluation_failed')
        self._close_intent(con,row,'benchmark.evaluation.raw.accepted.v1')
        head=self._head_scope(con,scope,ws,row['experiment_id']);case=self.experiments._case(con,ws,row['experiment_id'],row['case_id']);event={'experiment_id':row['experiment_id'],'lifecycle_revision':head['lifecycle_revision'],'result_id':machine,'content_hash':digest,'artifact_ref':ref,'run_id':row['run_id'],'attempt_id':attempt['attempt_id'],'case_key':row['case_id'],'evaluator_slot':evaluator,'selection_revision':selection,'slot_id':slot['result_id'],'result_bucket':_iso(now)[:10],'case_lifecycle_revision':case['lifecycle_revision'],'source_trace_id':case['trace_id'],'benchmark_job_id':row['job_id'],'authorization':{'credential_id':row['origin_credential_id'],'kind':row['origin_credential_kind'],'principal_id':scope.principal_id}}
        con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'evaluation.result.accepted.v1',?,?,?)",(ws,str(uuid.uuid4()),attempt['attempt_id'],attempt['fence'],canonical_json(event),self.experiments._queued_at(con,now),now));self._outbox(con,row,'benchmark.continuation.requested.v1',{'job_id':row['job_id'],'parent_job_id':row['parent_job_id'],'machine_result_id':machine,'needs_supplemental':row['attempt_no']==1 and any(key not in {evaluator,'__execution__'} for key in json.loads(self.experiments._load(head['metadata_hash'],head['metadata_ref']).get('evaluatorIdsJson') or '[]'))});self.experiments._settle(con,ws,row['experiment_id'])
        return {'accepted':True,'evaluationStatus':state,'normalizationStatus':'completed','normalizedResult':normalized}

    def _intent_job(self,con,current,ws,identity):
        source=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,identity)).fetchone()
        if source is None:raise BenchmarkNotFound('Benchmark recovery job unavailable')
        row=dict(source);self._head_scope(con,current,ws,row['experiment_id'],'execute')
        if current.principal_id!=row['actor_principal_id']:raise Forbidden('Benchmark recovery requires its original owner')
        origin=self.iam._scope_registered_credential(con,row['origin_credential_id'],row['origin_credential_kind']);self.iam._workspace(origin,ws,'write');self.iam._workspace(origin,ws,'execute');self._job_scope(con,origin,ws,identity,'execute')
        attempt=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND attempt_id=?',(ws,row['callback_attempt_id'])).fetchone()
        if attempt is None and self._binding(con,ws,row['experiment_id'])[1]['run_config'].get('submissionSource')=='imported':attempt=con.execute("SELECT * FROM work_attempts WHERE workspace_id=? AND work_item_id=? AND worker_id='benchmark-submission-importer' ORDER BY attempt_no DESC LIMIT 1",(ws,row['work_item_id'])).fetchone()
        if attempt is None and row['kind']=='execute' and row['request_hash'] is None and row['protocol_state']=='preparing':attempt=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND work_item_id=? ORDER BY attempt_no DESC LIMIT 1',(ws,row['work_item_id'])).fetchone()
        if attempt is None and row['protocol_state']=='blocked' and row['request_hash'] is None:attempt=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND work_item_id=? ORDER BY attempt_no DESC LIMIT 1',(ws,row['work_item_id'])).fetchone()
        return row,origin,dict(attempt) if attempt else None

    def _continuation_parent(self,con,scope,ws,row):
        if row['protocol_state'] not in TERMINAL:raise Conflict('Benchmark primary result is not terminal')
        _,binding=self._binding(con,ws,row['experiment_id']);slot=con.execute('SELECT * FROM experiment_result_slots WHERE workspace_id=? AND case_id=? AND evaluator_id=?',(ws,row['case_id'],binding['adapter']['evaluatorId'])).fetchone()
        receipt=con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND result_id=?',(ws,slot['selected_result_id'] if slot else None)).fetchone()
        if not slot or slot['run_id']!=row['run_id'] or not receipt or receipt['work_item_id']!=slot['work_item_id'] or receipt['case_key']!=row['case_id']:raise Conflict('Benchmark continuation primary result has been superseded')
        if row['kind']=='evaluate':
            if slot['work_item_id']!=row['work_item_id']:raise Conflict('Benchmark continuation evaluation differs')
            parent=self._job_scope(con,scope,ws,row['parent_job_id'],'execute')
        else:
            parent=row;packet=self._load(receipt['content_hash'],receipt['artifact_ref']);failure_job,_=self._failure_source(con,scope,ws,packet.get('benchmark_failure_job_id'),packet.get('benchmark_failure_source_hash'))
            if failure_job['job_id']!=row['job_id'] and failure_job['parent_job_id']!=row['job_id']:raise Conflict('Benchmark continuation failure provenance differs')
        if parent['kind']!='execute' or parent['experiment_id']!=row['experiment_id'] or parent['case_id']!=row['case_id'] or parent['run_id']!=row['run_id']:raise Conflict('Benchmark continuation execution source differs')
        completion=self._load(parent['completion_hash'],parent['completion_ref']) if parent['completion_hash'] else {};trace=completion.get('runFacts',{}).get('traceId')
        return parent,identifier(trace) if trace else None,receipt['result_id']

    def _prepare_continuation(self,token,ws,body):
        with self.control.read_transaction() as con:
            current=self._scope(con,token,ws,'execute');row,origin,_=self._intent_job(con,current,ws,body.get('job_id'));parent,trace,machine=self._continuation_parent(con,origin,ws,row)
        evidence=None
        if trace:
            if self.experiments.evidence is None:raise BenchmarkUnavailable('Benchmark supplemental TraceEvidence unavailable')
            evidence=self.experiments.evidence.read(token,ws,trace_ref=trace)
        return {'job_id':row['job_id'],'parent_job_id':parent['job_id'],'completion_hash':parent['completion_hash'],'machine_result_id':machine,'trace_id':trace,'evidence':evidence}

    def _continuation_tx(self,con,token,ws,row,scope,prepared):
        parent,trace,machine=self._continuation_parent(con,scope,ws,row)
        if any(prepared.get(key)!=value for key,value in {'job_id':row['job_id'],'parent_job_id':parent['job_id'],'completion_hash':parent['completion_hash'],'machine_result_id':machine,'trace_id':trace}.items()):raise Conflict('Benchmark continuation source changed while freezing Trace')
        evidence=prepared['evidence']
        if trace:
            if evidence is None:raise Conflict('Benchmark continuation Trace evidence missing')
            self.experiments._verify_evidence(con,token,ws,evidence);self.experiments._indexed_trace(con,ws,evidence)
            if evidence['manifest']['trace_id']!=trace:raise Conflict('Benchmark continuation Trace alias differs')
        elif evidence is not None:raise Conflict('Missing Benchmark Trace cannot have synthetic evidence')
        head=self._head_scope(con,scope,ws,row['experiment_id'],'write');_,plan=self.experiments._plan(con,ws,row['experiment_id'],row['run_id']);selected=json.loads(plan['experiment_config'].get('evaluatorIdsJson') or '[]');supplemental=[key for key in selected if not key.startswith('benchmark:')]
        if not supplemental:return {'accepted':True,'run_id':None,'supplemental':False}
        case=next((copy.deepcopy(case) for case in plan['cases'] if case['id']==row['case_id']),None)
        if case is None or any(key not in plan['frozen_evaluators'] for key in supplemental):raise Conflict('Benchmark continuation frozen membership differs')
        if evidence:case.update(taskId=evidence['execution']['taskId'],executionId=evidence['execution']['id'],actualOutput=evidence['execution'].get('finalResult') or '',traceGenerationError=None)
        else:case.update(taskId=None,executionId=None,traceGenerationError='执行完成未返回Trace ID，未运行补充评测模型')
        snapshot={'experiment':copy.deepcopy(plan['experiment_config'])|{'cases':[case]},'revision':str(head['revision'])}
        child={'experiment_id':row['experiment_id'],'case_ids':[row['case_id']],'evaluator_ids':supplemental,'config':copy.deepcopy(plan['config'])|{'benchmark_continuation_parent_job_id':row['job_id'],'benchmark_continuation_parent_run_id':row['run_id']},'releases':copy.deepcopy(plan['releases'])|{'benchmark:origin:'+row['job_id']:plan['releases']['benchmark']},'frozen_evaluators':copy.deepcopy(plan['frozen_evaluators'])}
        value=self.experiments._start(con,token,ws,child,scope,(snapshot,{row['case_id']:evidence} if evidence else {}),trusted_parent=True)
        if evidence is None:
            for _ in supplemental:
                handle=self.experiments._claim(con,token,ws,{'experiment_id':row['experiment_id'],'run_id':value['run_id'],'case_id':row['case_id'],'worker_id':'benchmark-source-classifier','lease_ms':300000},scope)
                if not handle:raise Conflict('Benchmark missing-Trace work could not be claimed')
                marker={'job_id':row['job_id'],'execution_job_id':parent['job_id'],'completion_hash':parent['completion_hash'],'primary_result_id':machine,'reason':'EXECUTION_TRACE_ABSENT'}
                handle=self.experiments._checkpoint(con,token,ws,handle|{'expected_revision':handle['checkpoint_revision'],'checkpoint':{'source_classification':marker}},scope)
                self.experiments._complete(con,token,ws,handle|{'operation_key':'benchmark-missing-trace:'+row['job_id']+':'+handle['evaluator_id'],'error':'执行完成未返回Trace ID，未运行补充评测模型','result':{'score':None,'summary':'执行完成未返回Trace ID，未运行补充评测模型','evidence':{'origin':'benchmark-source-classifier','evaluatorModelExecuted':False,'source':marker}}},scope,failed=True)
        return {'accepted':True,'run_id':value['run_id'],'supplemental':True,'missing_trace':evidence is None}

    def _intent_dispatch(self,action,token,ws,body):
        self._trusted(token,ws,body);prepared=None
        if action=='finish_intent' and body.get('operation')=='prepare_continuation':
            with self.control.read_transaction() as con:
                current=self._scope(con,token,ws,'execute');self._intent_job(con,current,ws,body.get('job_id'));_,_,old=self._receipt(con,current,ws,action,body)
                if old:return self._load(old['response_hash'],old['response_ref'])
            prepared=self._prepare_continuation(token,ws,body)
        with self.control.transaction() as con:
            current=self._scope(con,token,ws,'write');self.iam._workspace(current,ws,'read');self.iam._workspace(current,ws,'execute');now=self.control.clock()
            if action=='claim_intents':
                worker=identifier(body.get('worker_id'));limit=body.get('limit',10)
                if type(limit) is not int or not 1<=limit<=100:raise ValueError('Benchmark intent claim limit must be 1..100')
                events=con.execute("SELECT o.* FROM outbox_events o JOIN benchmark_jobs j ON j.workspace_id=o.workspace_id AND j.job_id=o.aggregate_id WHERE o.workspace_id=? AND j.actor_principal_id=? AND o.event_type IN ('benchmark.execution.prepare.requested.v1','benchmark.dispatch.requested.v1','benchmark.execution.completed.v1','benchmark.evaluation.raw.accepted.v1','benchmark.continuation.requested.v1','benchmark.failure.classification.requested.v1') AND ((o.state='pending' AND o.next_attempt_at_ms<=?) OR (o.state='dispatching' AND (o.lease_until_ms<=? OR o.lease_owner=?))) ORDER BY o.created_at_ms,o.event_id LIMIT ?",(ws,current.principal_id,now,now,worker,min(1000,limit*10))).fetchall();values=[];size=0
                for event in events:
                    event=dict(event)
                    try:row,origin,attempt=self._intent_job(con,current,ws,event['aggregate_id'])
                    except (Unauthorized,Forbidden,Conflict,BenchmarkNotFound):
                        con.execute("UPDATE outbox_events SET state='pending',next_attempt_at_ms=?,lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(now+60000,now,ws,event['event_id']));continue
                    kind=event['event_type']
                    if kind=='benchmark.execution.prepare.requested.v1':
                        if row['kind']!='execute' or row['request_hash'] is not None or row['protocol_state'] in TERMINAL:self._close_intent(con,row,kind);continue
                        if attempt and attempt['lease_until_ms']<=now:
                            con.execute("UPDATE work_attempts SET status='expired',finished_at_ms=? WHERE workspace_id=? AND attempt_id=? AND status='running'",(now,ws,attempt['attempt_id']));con.execute("UPDATE work_items SET status='queued',updated_at_ms=? WHERE workspace_id=? AND work_item_id=? AND cancel_requested=0",(now,ws,row['work_item_id']));row=self._job_bump(con,row,protocol_state='pending');attempt=None
                    if attempt is None:
                        prepare=kind=='benchmark.execution.prepare.requested.v1' and row['kind']=='execute' and row['protocol_state']=='pending'
                        if not prepare and (kind!='benchmark.dispatch.requested.v1' or row['kind']!='evaluate' or row['protocol_state']!='queued'):continue
                        handle=self._claim_tx(con,row,{'worker_id':'benchmark-intent-preparation' if prepare else 'benchmark-intent-dispatch'},origin)
                        if not handle:continue
                        attempt=self._active(con,row,handle,origin);row=dict(con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,row['job_id'])).fetchone())
                        if not prepare:row=self._issue_capability_tx(con,row,attempt,row['request_hash'],row['request_ref'])
                    handle=self._handle(row,attempt)
                    if kind=='benchmark.dispatch.requested.v1' and (row['protocol_state'] in TERMINAL or row['completion_hash'] is not None or row['protocol_state'] in {'running_agent','running_evaluator','collecting','uploading','cleaning'}):self._close_intent(con,row,kind);continue
                    if kind=='benchmark.execution.completed.v1' and (row['protocol_state']!='submitted' or con.execute('SELECT 1 FROM benchmark_jobs WHERE workspace_id=? AND parent_job_id=?',(ws,row['job_id'])).fetchone()):self._close_intent(con,row,kind);continue
                    if kind=='benchmark.evaluation.raw.accepted.v1' and row['protocol_state'] in TERMINAL:self._close_intent(con,row,kind);continue
                    try:self._active(con,row,handle,origin,terminal=kind not in {'benchmark.execution.prepare.requested.v1','benchmark.dispatch.requested.v1'})
                    except Conflict:
                        con.execute("UPDATE outbox_events SET state='pending',next_attempt_at_ms=?,lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(now+60000,now,ws,event['event_id']));continue
                    value={'event_type':kind,'job':self._job_dto(row),'actor_username':self.experiments._owner(con,row['actor_principal_id'])}
                    if kind=='benchmark.execution.prepare.requested.v1':value['work']=self._work(con,row,attempt)
                    elif kind=='benchmark.dispatch.requested.v1':
                        if row['callback_expires_ms']<=now:continue
                        value['request']=self._load(row['request_hash'],row['request_ref']);value['request']['callbackHeaders']={'x-agent-insight-callback-token':self._capability(row)}
                    elif kind=='benchmark.continuation.requested.v1':
                        self._continuation_parent(con,origin,ws,row)
                    elif kind=='benchmark.failure.classification.requested.v1':
                        payload=json.loads(event['payload_json']);self._failure_source(con,origin,ws,row['job_id'],payload.get('failure_source_hash'));value['failure_source_hash']=payload['failure_source_hash']
                    else:
                        work=self._work(con,row,attempt);work['completion']=self._load(row['completion_hash'],row['completion_ref']);work['completion_hash']=row['completion_hash'];ids=work['completion']['evidenceArtifactIds'] if kind=='benchmark.evaluation.raw.accepted.v1' else [a['artifact_id'] for a in con.execute('SELECT artifact_id FROM benchmark_artifacts WHERE workspace_id=? AND job_id=? ORDER BY name',(ws,row['job_id']))];work['artifacts']=[self._artifact_read_tx(con,row,{'artifact_id':identity}) for identity in ids];value['work']=work
                    weight=_bounded(value)
                    if size+weight>MAX_BYTES-65536:break
                    number=event['attempts'] if event['state']=='dispatching' and event['lease_owner']==worker and event['lease_until_ms']>now else event['attempts']+1;until=event['lease_until_ms'] if number==event['attempts'] else now+30000
                    con.execute("UPDATE outbox_events SET state='dispatching',attempts=?,lease_owner=?,lease_until_ms=?,updated_at_ms=? WHERE workspace_id=? AND event_id=?",(number,worker,until,now,ws,event['event_id']))
                    value['handle']=handle|{'event_id':event['event_id'],'event_type':kind,'outbox_attempt':str(number),'outbox_lease_owner':worker,'outbox_lease_until_ms':until};values.append(value);size+=weight
                    if len(values)>=limit:break
                return values
            row,origin,attempt=self._intent_job(con,current,ws,body.get('job_id'))
            if attempt is None:raise Conflict('Benchmark recovery has no sealed attempt')
            key,digest,old=self._receipt(con,current,ws,action,body)
            if old:return self._load(old['response_hash'],old['response_ref'])
            event=con.execute('SELECT * FROM outbox_events WHERE workspace_id=? AND event_id=? AND aggregate_id=?',(ws,body.get('event_id'),row['job_id'])).fetchone()
            if event and event['event_type']==body.get('event_type')=='benchmark.dispatch.requested.v1' and event['state']=='sent' and str(event['attempts'])==str(body.get('outbox_attempt')) and body.get('operation')=='dispatch_ack' and body.get('state') in {'accepted','unknown'} and row['protocol_state'] not in {'pending','preparing','dispatching','dispatch_unknown','blocked','dispatch_failed','cancelled'}:
                self._active(con,row,body,origin,terminal=row['completion_hash'] is not None or row['protocol_state'] in TERMINAL);value={'job':self._job_dto(row),'intent_state':'sent'};self._write_receipt(con,current,ws,action,key,digest,value,job_id=row['job_id']);return value
            if not event or event['event_type']!=body.get('event_type') or event['state']!='dispatching' or str(event['attempts'])!=str(body.get('outbox_attempt')) or event['lease_owner']!=body.get('outbox_lease_owner') or event['lease_until_ms']<=now:raise Conflict('Benchmark recovery intent lease is stale')
            self._active(con,row,body,origin,terminal=event['event_type'] not in {'benchmark.execution.prepare.requested.v1','benchmark.dispatch.requested.v1'} or row['completion_hash'] is not None or row['protocol_state'] in TERMINAL)
            operation=body.get('operation');kind=event['event_type'];state='sent'
            if operation=='defer' and kind in {'benchmark.execution.prepare.requested.v1','benchmark.dispatch.requested.v1','benchmark.execution.completed.v1','benchmark.evaluation.raw.accepted.v1','benchmark.continuation.requested.v1','benchmark.failure.classification.requested.v1'}:
                reason=body.get('reason')
                if reason not in {'ADAPTER_UNAVAILABLE','TRANSPORT_UNAVAILABLE','STORAGE_UNAVAILABLE'}:raise ValueError('Known Benchmark recovery deferral reason required')
                row=self._job_bump(con,row);self._outbox(con,row,'benchmark.recovery.deferred.v1',{'job_id':row['job_id'],'event_id':event['event_id'],'reason':reason});state='pending';value={'intent_state':'pending','deferred':True}
            elif kind=='benchmark.dispatch.requested.v1' and operation=='dispatch_ack':
                ack=body.get('state')
                if ack not in {'accepted','unknown','failed'}:raise ValueError('Exact Benchmark transport acknowledgement required')
                row=self._ack_dispatch_tx(con,row,attempt,ack);state='pending' if ack=='unknown' and row['protocol_state']=='dispatch_unknown' else 'sent';value={'job':self._job_dto(row),'intent_state':state}
            elif kind=='benchmark.continuation.requested.v1' and operation=='prepare_continuation':value=self._continuation_tx(con,token,ws,row,origin,prepared)
            elif kind=='benchmark.failure.classification.requested.v1' and operation=='classify_failure':value=self._classify_failure_tx(con,row,origin,body.get('failure_source_hash'))
            elif kind=='benchmark.execution.completed.v1' and operation=='submission_reject':value=self._submission_reject_tx(con,row)
            elif kind=='benchmark.execution.completed.v1' and operation=='prepare_evaluation':value=self._evaluation_prepare_tx(con,row,origin,body,row['origin_credential_id'],row['origin_credential_kind'])
            elif kind=='benchmark.evaluation.raw.accepted.v1' and operation=='normalize':value=self._normalize_commit_tx(con,row,origin,attempt,body)
            else:raise ValueError('Unsupported Benchmark recovery stage')
            retry=now+min(60000,1000*2**min(event['attempts']-1,6)) if state=='pending' else 0
            con.execute('UPDATE outbox_events SET state=?,next_attempt_at_ms=?,lease_owner=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND event_id=?',(state,retry,now,ws,event['event_id']));self._write_receipt(con,current,ws,action,key,digest,value,job_id=row['job_id']);return value

    def _read_postflight(self,token,ws,exp,runs,fingerprint):
        with self.control.read_transaction() as con:
            scope=self._scope(con,token,ws)
            if scope.fingerprint!=fingerprint:raise Forbidden('Benchmark read authorization changed')
            self._head_scope(con,scope,ws,exp)
            for run in runs or [None]:self._source_acl(con,scope,ws,exp,run)

    def _lookup_artifact(self,token,ws,body):
        with self.control.read_transaction() as con:
            identity=identifier(body.get('artifact_id'));artifact=con.execute('SELECT * FROM benchmark_artifacts WHERE workspace_id=? AND artifact_id=?',(ws,identity)).fetchone()
            if not artifact or body.get('job_id') and body['job_id']!=artifact['job_id']:raise BenchmarkNotFound('Benchmark artifact unavailable')
            row=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND job_id=?',(ws,artifact['job_id'])).fetchone();scope=self._scope(con,token,ws);head=self._head_scope(con,scope,ws,row['experiment_id'])
            if scope.principal_id!=head['created_by']:raise Forbidden('Benchmark artifact requires its original owner')
            self._source_acl(con,scope,ws,row['experiment_id'],row['run_id']);value=self._artifact_read_tx(con,dict(row),{'artifact_id':identity})
            value.update(name=artifact['name'],mediaType=artifact['media_type'],sha256='sha256:'+artifact['content_hash'],sizeBytes=artifact['size_bytes'])
            exp=row['experiment_id'];run=row['run_id'];fingerprint=scope.fingerprint
        self._read_postflight(token,ws,exp,[run],fingerprint);return value

    def _read(self,action,token,ws,body):
        with self.control.read_transaction() as con:
            scope=self._scope(con,token,ws);exp=body['experiment_id'];head=self._head_scope(con,scope,ws,exp);rows=con.execute('SELECT * FROM benchmark_jobs WHERE workspace_id=? AND experiment_id=? ORDER BY created_at_ms,job_id LIMIT 20001',(ws,exp)).fetchall()
            if len(rows)>20000:raise BenchmarkTooLarge('Benchmark job history exceeds budget')
            if action=='list_jobs':return [self._job_dto(dict(row)) for row in rows]
            runs=list({row['run_id'] for row in rows})
            for run in runs or [None]:self._source_acl(con,scope,ws,exp,run)
            snapshot=self.experiments._redact(self.experiments._snapshot(con,ws,head),scope.principal_id)
            if action=='read_view':value={'coverage':'complete','snapshots':[self._result_view(con,head,snapshot,[dict(row) for row in rows],scope)]}
            else:value={'experiment':snapshot,'jobs':[self._job_dto(dict(row)) for row in rows]}
            fingerprint=scope.fingerprint
        self._read_postflight(token,ws,exp,runs,fingerprint);return value

    def _result_view(self,con,head,snapshot,jobs,scope):
        ws=head['workspace_id'];exp=head['experiment_id'];_,binding=self._binding(con,ws,exp);experiment=snapshot['experiment'];cases={case['id']:case for case in experiment['cases']};sources={case['id']:case for case in binding['cases']};runs=[]
        experiment['benchmarkBinding']={'adapterKey':binding['adapter']['key'],'expectedCaseCount':len(cases)}
        config=json.loads(experiment.get('configSnapshotJson') or '{}');config.pop('coreBenchmark',None);experiment['configSnapshotJson']=_json(config)
        owner=scope.principal_id==head['created_by']
        def artifacts(job):
            return [{'id':a['artifact_id'],'name':a['name'],'kind':a['kind'],'mediaType':a['media_type'],'sha256':'sha256:'+a['content_hash'],'sizeBytes':a['size_bytes']} for a in con.execute('SELECT * FROM benchmark_artifacts WHERE workspace_id=? AND job_id=? ORDER BY created_at_ms,artifact_id',(ws,job['job_id']))]
        def runtime(job,completion,diagnostic):
            attempt=con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND work_item_id=? ORDER BY attempt_no DESC LIMIT 1',(ws,job['work_item_id'])).fetchone();error=completion.get('error');error=error if isinstance(error,dict) else {}
            return {'createdAt':_iso(job['created_at_ms']),'updatedAt':_iso(job['updated_at_ms']),'startedAt':_iso(attempt['started_at_ms']) if attempt else None,'finishedAt':_iso(attempt['finished_at_ms']) if attempt and attempt['finished_at_ms'] is not None else None,'lastProgressAt':diagnostic.get('occurredAt'),'progressJson':_json(diagnostic) if diagnostic and owner else None,'failureCode':error.get('code') or completion.get('failureCode') or diagnostic.get('failureCode'),'failureMessage':(error.get('message') or completion.get('failureMessage') or diagnostic.get('failureMessage')) if owner else None}
        for job in jobs:
            if job['kind']!='execute' or job['case_id'] not in cases:continue
            case=cases[job['case_id']];source=sources[job['case_id']];diagnostic=self._load(job['progress_hash'],job['progress_ref']) if job['progress_hash'] else {};completion=self._load(job['completion_hash'],job['completion_ref']) if job['completion_hash'] else {};facts=completion.get('runFacts',{});facts=facts if owner else {'traceId':facts.get('traceId')};evaluations=[]
            for child in reversed(jobs):
                if child['parent_job_id']!=job['job_id']:continue
                raw=self._load(child['completion_hash'],child['completion_ref']) if child['completion_hash'] else {};normalized=None
                receipt=con.execute('SELECT content_hash,artifact_ref FROM result_receipts WHERE workspace_id=? AND work_item_id=?',(ws,child['work_item_id'])).fetchone()
                if receipt:
                    normalized=self._load(receipt['content_hash'],receipt['artifact_ref'])['result'];normalized={key:value for key,value in normalized.items() if key!='metrics'}
                    if not owner:normalized={key:normalized[key] for key in ('status','score','verdict','primaryMetric') if key in normalized}
                child_progress=self._load(child['progress_hash'],child['progress_ref']) if child['progress_hash'] else {}
                evaluations.append({**runtime(child,raw,child_progress),'id':child['job_id'],'attemptNo':child['attempt_no'],'status':child['protocol_state'],'normalizedResultJson':_json(normalized) if normalized is not None else None,'runtimeFactsJson':_json(raw.get('runtimeFacts',{})) if owner else '{}','artifacts':artifacts(child) if owner else []})
            evaluations.sort(key=lambda value:value['attemptNo'],reverse=True)
            state=job['protocol_state'];state='evaluated' if state=='completed' else state
            if evaluations and evaluations[0]['status'] in {'queued','preparing','dispatching','dispatch_unknown','running_evaluator','normalizing','normalization_failed'}:state='submitted'
            if evaluations and evaluations[0]['status']=='submission_invalid':state='submission_invalid'
            request=self._load(job['request_hash'],job['request_ref']) if job['request_hash'] else {}
            runs.append({**runtime(job,completion,diagnostic),'taskEnvelopeJson':_json(request['task']) if owner and 'task'in request else None,'publicPayloadJson':_json(source['dataset_case']['publicPayload']),'cleanupJson':_json(completion['cleanup']) if owner and 'cleanup'in completion else None,'id':job['job_id'],'experimentId':exp,'experimentCaseId':job['case_id'],'retryOfRunId':job['retry_of_job_id'],'ordinal':list(sources).index(job['case_id']),'status':state,'runFactsJson':_json(facts),'submissionSource':'imported' if binding['run_config'].get('submissionSource')=='imported' else 'execution','datasetCase':{'externalCaseId':source['dataset_case']['externalCaseId']},'artifacts':artifacts(job) if owner else [],'experimentCase':case,'evaluations':evaluations,'createdAt':_iso(job['created_at_ms']),'updatedAt':_iso(job['updated_at_ms'])})
        present={row['experimentCaseId'] for row in runs}
        for case_id,case in cases.items():
            if case_id in present:continue
            source=sources.get(case_id)
            if source is None:raise BenchmarkUnavailable('Benchmark Case lacks its frozen Dataset source')
            runs.append({'id':'erun_'+_identity('benchmark-initial-execution',ws,exp,case_id).replace('-',''),'experimentId':exp,'experimentCaseId':case_id,'retryOfRunId':None,'ordinal':list(sources).index(case_id),'status':'pending','taskEnvelopeJson':None,'publicPayloadJson':_json(source['dataset_case']['publicPayload']),'cleanupJson':None,'progressJson':None,'startedAt':None,'finishedAt':None,'lastProgressAt':None,'runFactsJson':'{}','submissionSource':'imported' if binding['run_config'].get('submissionSource')=='imported' else 'execution','failureCode':None,'failureMessage':None,'datasetCase':{'externalCaseId':source['dataset_case']['externalCaseId']},'artifacts':[],'experimentCase':case,'evaluations':[],'createdAt':_iso(head['created_at_ms']),'updatedAt':_iso(head['updated_at_ms'])})
        snapshot['benchmark_runs']=runs
        from .legacy_import_experiments import enrich_benchmark_view
        return enrich_benchmark_view(self,con,ws,head,snapshot,scope)

