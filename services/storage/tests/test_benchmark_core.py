import importlib.util
import json
import unittest
from pathlib import Path
from services.storage.tests import test_datasets as fixture
from services.storage.iam import Forbidden,Unauthorized
from services.storage.control import Conflict

class BenchmarkCoreTests(unittest.TestCase):
    make_control=fixture.DatasetTests.make_control
    setUp=fixture.DatasetTests.setUp

    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.benchmark_core'),'Benchmark must have a typed core domain')
        from services.storage.benchmark_core import BenchmarkStore
        key=Path(self.tmp.name)/'controller-key'
        if not key.exists():key.write_text('a'*64);key.chmod(0o600)
        return BenchmarkStore(self.control,controller_key_file=key,definitions_verifier=lambda *_:True,device_verifier=lambda *_:True,evidence=getattr(self,'evidence',None))

    def test012_catalog_and_five_new_tables_match_full_columns(self):
        path=Path(__file__).resolve().parents[1]/'schema/benchmark-catalog.json'
        self.assertTrue(path.is_file(),'012 Benchmark catalog must exist')
        catalog=json.loads(path.read_text());self.assertEqual(catalog['version'],12);self.assertEqual(len(catalog['tables']),5)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],len(__import__('services.storage.migrations',fromlist=['load_migrations']).load_migrations('sqlite')))
            for table in catalog['tables']:
                actual=[r['column_name'] for r in con.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',(self.control.schema,table['name']))] if hasattr(self.control,'schema') else [r[1] for r in con.execute('PRAGMA table_info('+table['name']+')')]
                self.assertEqual(actual,[column['name'] for column in table['columns']])

    def test_registered_origin_credential_scope_reuses_live_auth_revocation_checks(self):
        with self.control.read_transaction() as con:
            origin,is_api=self.iam._authenticate(con,self.token);identity=origin['credential_id'] if is_api else origin['session_id']
            self.assertEqual(self.iam._scope_registered_credential(con,identity,'api' if is_api else 'session'),self.iam._scope(con,self.token))
        self.iam.revoke_credential(self.token)
        with self.control.read_transaction() as con,self.assertRaises(Unauthorized):self.iam._scope_registered_credential(con,identity,'api' if is_api else 'session')

    def dataset(self):
        return {'dataset_id':'bench','adapter_key':'fixture','public_dataset':{'id':'public-bench','name':'Benchmark Fixture','description':'','datasetKind':'benchmark','tags':[],'fields':[],'cases':[{'id':'dc','input':'public input','expectedOutput':'','trajectory':'','evaluationFocus':'','tags':[],'values':{'externalCaseId':'external'}}]},'cases':[{'id':'dc','externalCaseId':'external','ordinal':0,'publicPayload':{'input':'public input'},'privatePayload':{'answer':'PRIVATE GOLD'},'rawCase':{'question':'public input','answer':'PRIVATE GOLD'}}]}

    def invoke(self,action,**body):return self.service().dispatch(action,self.token,'w',body)
    def save_dataset(self):return self.invoke('dataset_import',**self.dataset(),operation_key='import')
    def create(self):
        self.save_dataset()
        return self.invoke('create',dataset_id='bench',experiment={'id':'bexp','name':'Benchmark experiment','scope':'benchmark','evaluatorIdsJson':json.dumps(['benchmark:fixture',*getattr(self,'supplemental_evaluators',[])]),'cases':[]},selection={'mode':'all'},run_config={'platform':'opencode','agent':'build','clientId':'client','legacyOwner':'alice','timeoutSeconds':30,**({'submissionSource':'imported'} if getattr(self,'imported_submission',False) else {})},adapter={'key':'fixture','evaluatorId':'benchmark:fixture','requiredArtifacts':[{'name':'answer.txt','mediaType':'text/plain','maxBytes':1024}],'evaluation':{'evaluatorKey':'fixture','defaultTimeoutSeconds':30}},operation_key='create')

    def test_dataset_public_projection_never_contains_gold_and_exact_replay_does_not_prepare_new_release(self):
        value=self.save_dataset();self.assertEqual(value['id'],'bench')
        from services.storage.datasets import DatasetStore
        public=DatasetStore(self.control).get(self.token,'w','public-bench');self.assertNotIn('PRIVATE GOLD',json.dumps(public))
        self.assertEqual(self.save_dataset(),value)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM benchmark_dataset_heads').fetchone()[0],1)

    def test_create_atomically_binds_frozen_public_and_private_releases_and_preserves_old_tables(self):
        result=self.create();self.assertEqual(result['id'],'bexp');self.assertEqual(result['caseCount'],1)
        from services.storage.experiments import ExperimentStore
        snapshot=ExperimentStore(self.control).dispatch('read',self.token,'w',{'experiment_id':'bexp'})
        self.assertEqual(snapshot['experiment']['cases'][0]['input'],'public input');self.assertNotIn('PRIVATE GOLD',json.dumps(snapshot))
        with self.control.read_transaction() as con:
            binding=con.execute('SELECT * FROM benchmark_experiment_bindings').fetchone();self.assertNotEqual(binding['public_release_id'],binding['private_release_id'])
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_heads').fetchone()[0],1)

    def start(self):
        self.create();return self.invoke('start',experiment_id='bexp',public_callback_origin='http://localhost:3000',executor_callback_origin='http://localhost:3000',operation_key='start',**({'frozen_evaluators':{key:{'id':key,'origin':'custom'} for key in self.supplemental_evaluators}} if getattr(self,'supplemental_evaluators',[]) else {}))
    def claim(self):
        started=self.start();return self.invoke('claim',job_id=started['runId'],worker_id='controller')
    def seal(self):
        claim=self.claim();request={'runId':claim['job_id'],'requestDigest':'sha256:'+'c'*64,'clientId':'client','timeoutSeconds':30,'callbackBaseUrl':'http://localhost:3000/api/benchmark/v1/runs/'+claim['job_id'],'task':{'submission':{'requiredArtifacts':[{'name':'answer.txt','mediaType':'text/plain','maxBytes':1024}]}}}
        return claim,self.invoke('checkpoint',**claim,request=request,operation_key='dispatch')

    def test_start_freezes_one_runplan_and_external_work_is_not_claimed_by_the_ordinary_scorer(self):
        first=self.start();again=self.invoke('start',experiment_id='bexp',public_callback_origin='http://localhost:3000',executor_callback_origin='http://localhost:3000',operation_key='start');self.assertEqual(first,again)
        self.assertNotIn('bcap_',json.dumps(first));self.assertIsNone(self.experiments_claim())
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],1);self.assertEqual(con.execute('SELECT COUNT(*) FROM benchmark_jobs').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT phase FROM work_items').fetchone()[0],'publish')
    def experiments_claim(self):
        from services.storage.experiments import ExperimentStore
        return ExperimentStore(self.control).dispatch('claim',self.token,'w',{'experiment_id':'bexp','phase':'evaluate','worker_id':'ordinary'})

    def test_dispatch_capability_is_recoverable_but_never_persisted_in_plaintext_or_public_plan(self):
        claim,sealed=self.seal();one=self.invoke('load_dispatch',**claim);two=self.invoke('load_dispatch',**claim)
        token=one['request']['callbackHeaders']['x-agent-insight-callback-token'];self.assertEqual(one,two);self.assertTrue(token.startswith('bcap_'))
        with self.control.read_transaction() as con:
            row=dict(con.execute('SELECT * FROM benchmark_jobs').fetchone());self.assertNotIn(token,json.dumps(row));self.assertEqual(row['callback_attempt_id'],claim['attempt_id'])
            files=[r[0] for r in con.execute('SELECT plan_manifest_ref FROM runs')]
        for file in files:self.assertNotIn(token,Path(file).read_text())

    def test_callback_live_origin_revocation_and_cross_job_are_rejected(self):
        claim,_=self.seal();token=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        service=self.service();progress={'kind':'execution','stage':'agent_running','occurredAt':'2026-11-12T00:00:00Z','progress':{}}
        value=service.callback('progress',token,{'job_id':claim['job_id'],'progress':progress},verified_device_client_id='client');self.assertTrue(value['accepted'])
        with self.assertRaises(Forbidden):service.callback('progress',token,{'job_id':'another','progress':progress},verified_device_client_id='client')
        self.iam.revoke_credential(self.token)
        with self.assertRaises(Unauthorized):service.callback('progress',token,{'job_id':claim['job_id'],'progress':progress},verified_device_client_id='client')

    def upload(self):
        import base64,hashlib
        claim,_=self.seal();token=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token'];raw=b'public submission\n';digest='sha256:'+hashlib.sha256(raw).hexdigest()
        payload={'job_id':claim['job_id'],'name':'answer.txt','media_type':'text/plain','expected_sha256':digest,'bytes_base64':base64.b64encode(raw).decode()}
        value=self.service().callback('artifact_put',token,payload,verified_device_client_id='client')
        return claim,token,value,digest,payload

    def execute_complete(self):
        claim,token,artifact,digest,_=self.upload();completion={'kind':'execution','status':'succeeded','artifacts':[{'artifactId':artifact['artifactId'],'name':'answer.txt','sha256':digest}],'runFacts':{'traceId':getattr(self,'execution_trace','new-business-trace')},'cleanup':{'status':'succeeded'}}
        result=self.service().callback('execution_complete',token,{'job_id':claim['job_id'],'completion':completion},verified_device_client_id='client')
        return claim,token,completion,result

    def test_artifact_upload_is_exactly_idempotent_and_cannot_escape_frozen_contract(self):
        import base64
        claim,token,artifact,digest,payload=self.upload();service=self.service()
        self.assertEqual(service.callback('artifact_put',token,payload,verified_device_client_id='client'),artifact)
        with self.assertRaises(ValueError):service.callback('artifact_put',token,payload|{'name':'../private'},verified_device_client_id='client')
        with self.assertRaises(Conflict):service.callback('artifact_put',token,payload|{'bytes_base64':base64.b64encode(b'changed').decode()},verified_device_client_id='client')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM benchmark_artifacts').fetchone()[0],1)

    def test_execution_completion_is_atomic_replayable_and_rejects_changed_submission(self):
        claim,token,completion,result=self.execute_complete();self.assertEqual(result,{'accepted':True,'status':'submitted'})
        service=self.service();self.assertEqual(service.callback('execution_complete',token,{'job_id':claim['job_id'],'completion':completion},verified_device_client_id='client'),result)
        with self.assertRaises(Conflict):service.callback('execution_complete',token,{'job_id':claim['job_id'],'completion':completion|{'runFacts':{'traceId':'another'}}},verified_device_client_id='client')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT protocol_state FROM benchmark_jobs').fetchone()[0],'submitted')
            self.assertEqual(con.execute('SELECT status FROM work_items WHERE work_item_id=?',(claim['work_item_id'],)).fetchone()[0],'done')
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)

    def test_execution_completion_rejects_missing_artifact_before_any_terminal_write(self):
        claim,_=self.seal();token=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        with self.assertRaises(Conflict):self.service().callback('execution_complete',token,{'job_id':claim['job_id'],'completion':{'kind':'execution','status':'succeeded','artifacts':[],'runFacts':{},'cleanup':{}}},verified_device_client_id='client')
        with self.control.read_transaction() as con:self.assertIsNone(con.execute('SELECT completion_hash FROM benchmark_jobs').fetchone()[0])

    def evaluation(self):
        claim,token,completion,_=self.execute_complete();identifier='veval_fixture';job={'protocolVersion':'benchmark-evaluation/v1','evaluationId':identifier,'executionRunId':claim['job_id'],'context':{'experimentId':'bexp','caseId':claim['case_id'],'datasetContentHash':self.save_dataset()['contentHash']},'benchmark':{'key':'fixture'},'evaluator':{'key':'fixture'},'artifacts':[{**value,'mediaType':'text/plain','sizeBytes':len(b'public submission\n')} for value in completion['artifacts']],'payload':{'privateAnswer':'PRIVATE GOLD'},'limits':{'timeoutSeconds':30,'cpu':1,'memoryMiB':128}}
        request={'runId':identifier,'requestDigest':'sha256:'+'e'*64,'evaluationJob':job,'platformBaseUrl':'http://localhost:3000','callbackBaseUrl':'http://localhost:3000/api/benchmark/v1/evaluations/'+identifier,'timeoutSeconds':30,'dispatchTarget':{'baseUrl':'http://evaluator.fixture','evaluatorKey':'fixture'}}
        prepared=self.invoke('evaluation_prepare',parent_job_id=claim['job_id'],request=request,operation_key='prepare-evaluation')
        handle=self.invoke('claim',job_id=prepared['evaluationRunId'],worker_id='evaluation-dispatch');self.invoke('checkpoint',**handle,request=request,operation_key='seal-eval');capability=self.invoke('load_dispatch',**handle)['request']['callbackHeaders']['x-agent-insight-callback-token']
        return handle,capability,request

    def test_raw_evaluation_then_normalize_selects_one_immutable_machine_receipt_and_keeps_gold_private(self):
        handle,capability,_=self.evaluation();service=self.service();raw={'status':'completed','rawResult':{'passed':True,'score':80},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}}
        accepted=service.callback('evaluation_complete',capability,{'job_id':handle['job_id'],'completion':raw});self.assertEqual(accepted['evaluationStatus'],'normalizing')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)
        normalized={'status':'done','verdict':'pass','score':80,'summary':'真实raw结果归一化','points':[],'evidence':{'opaque':{'中文':[1.25,False]}},'nativeMetrics':{'passed':True},'primaryMetric':{'key':'passed','value':True,'aggregation':'boolean-rate'}}
        request={'job_id':handle['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':normalized}
        completed=service.callback('normalize_commit',capability,request);self.assertEqual(completed['normalizedResult'],normalized);self.assertEqual(service.callback('normalize_commit',capability,request),completed)
        from services.storage.experiments import ExperimentStore
        snapshot=ExperimentStore(self.control).dispatch('read',self.token,'w',{'experiment_id':'bexp'});result=snapshot['experiment']['cases'][0]['results'][0];self.assertEqual(result['score'],80);self.assertEqual(json.loads(result['evidenceJson']),normalized['evidence'])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1);self.assertEqual(con.execute('SELECT COUNT(*) FROM result_selections').fetchone()[0],1);self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0],1)
            row=dict(con.execute("SELECT * FROM benchmark_jobs WHERE kind='evaluate'").fetchone());self.assertNotIn('score',row)

    def test_callback_without_controller_attestation_cannot_submit_its_own_normalized_score(self):
        handle,capability,_=self.evaluation();service=self.service();raw={'status':'completed','rawResult':{},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}};accepted=service.callback('evaluation_complete',capability,{'job_id':handle['job_id'],'completion':raw})
        from services.storage.benchmark_core import BenchmarkStore
        attacker=BenchmarkStore(self.control,controller_key_file=Path(self.tmp.name)/'controller-key')
        with self.assertRaises(Forbidden):attacker.callback('normalize_commit',capability,{'job_id':handle['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':{'status':'done','score':100}})

    def test_benchmark_read_view_preserves_original_result_shape_without_private_dispatch_payload(self):
        handle,capability,_=self.evaluation();service=self.service();raw={'status':'completed','rawResult':{'passed':True},'evidenceArtifactIds':[],'runtimeFacts':{'sandbox':'fixture'},'cleanup':{'controller':{'status':'succeeded'}}}
        accepted=service.callback('evaluation_complete',capability,{'job_id':handle['job_id'],'completion':raw})
        normalized={'status':'done','verdict':'pass','score':80,'summary':'public summary','points':[],'evidence':{},'nativeMetrics':{'passed':True},'primaryMetric':{'key':'passed','value':True,'aggregation':'boolean-rate'}}
        service.callback('normalize_commit',capability,{'job_id':handle['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':normalized})
        view=self.invoke('read_view',experiment_id='bexp');self.assertEqual(view['coverage'],'complete');snapshot=view['snapshots'][0]
        self.assertEqual(snapshot['experiment']['benchmarkBinding']['expectedCaseCount'],1)
        run=snapshot['benchmark_runs'][0];self.assertEqual(run['status'],'evaluated');self.assertEqual(run['datasetCase']['externalCaseId'],'external');self.assertEqual(run['experimentCase']['results'][0]['score'],80)
        self.assertEqual(json.loads(run['evaluations'][0]['normalizedResultJson']),normalized)
        text=json.dumps(view);self.assertNotIn('PRIVATE GOLD',text);self.assertNotIn('bcap_',text);self.assertNotIn('private_release_id',text)

    def test_benchmark_publish_execution_slot_keeps_native_projection_empty_and_owner_scope(self):
        from services.storage.experiments import ExperimentStore
        from services.storage.control import StorageError
        started=self.start();view=self.invoke('read_view',experiment_id='bexp');snapshot=view['snapshots'][0]
        case=snapshot['experiment']['cases'][0]
        self.assertEqual(snapshot['experiment']['user'],'alice');self.assertEqual(case['input'],'public input')
        self.assertIsNone(case['coreExecution']);self.assertEqual(snapshot['benchmark_runs'][0]['id'],started['runId'])
        self.assertNotIn('PRIVATE GOLD',json.dumps(view));self.assertNotIn('bcap_',json.dumps(view))
        with self.assertRaises(Forbidden):self.service().dispatch('read_view',self.bob,'w',{'experiment_id':'bexp'})
        ordinary=ExperimentStore(self.control).dispatch('read',self.token,'w',{'experiment_id':'bexp'})
        self.assertIsNone(ordinary['experiment']['cases'][0]['coreExecution'])
        with self.control.transaction() as con:con.execute("UPDATE work_items SET phase='execute' WHERE evaluator_slot='__execution__'")
        with self.assertRaises(StorageError):self.invoke('read_view',experiment_id='bexp')

    def test_cancelled_benchmark_publish_slot_keeps_its_original_history_readable(self):
        started=self.start();self.invoke('cancel_request',experiment_id='bexp',mode='cancel',operation_key='cancel-unstarted')
        snapshot=self.invoke('read_view',experiment_id='bexp')['snapshots'][0]
        self.assertIsNone(snapshot['experiment']['cases'][0]['coreExecution'])
        self.assertEqual(snapshot['benchmark_runs'][0]['id'],started['runId'])
        self.assertEqual(snapshot['benchmark_runs'][0]['status'],'cancelled')
        self.assertNotIn('PRIVATE GOLD',json.dumps(snapshot))

    def test_old_callback_cannot_write_when_its_result_slot_has_been_rebound(self):
        claim,_=self.seal();token=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        with self.control.transaction() as con:con.execute("UPDATE experiment_result_slots SET run_id=NULL,work_item_id=NULL,revision=revision+1 WHERE evaluator_id='__execution__'")
        with self.assertRaises(Conflict):self.service().callback('progress',token,{'job_id':claim['job_id'],'progress':{'kind':'execution','stage':'agent_running','occurredAt':'2026-11-12T00:00:00Z','progress':{}}},verified_device_client_id='client')

    def test_dataset_public_load_is_sufficient_for_create_preflight_and_never_returns_private_cases(self):
        self.save_dataset();value=self.invoke('dataset_load',dataset_id='bench');self.assertEqual(value['cases'][0]['id'],'dc');self.assertEqual(json.loads(value['cases'][0]['publicPayloadJson']),{'input':'public input'});self.assertNotIn('PRIVATE GOLD',json.dumps(value))

    def test_execution_callback_can_durably_dispatch_only_its_own_child_and_capability_survives_exact_retry(self):
        claim,parent_cap,completion,_=self.execute_complete();identifier='veval_child';job={'protocolVersion':'benchmark-evaluation/v1','evaluationId':identifier,'executionRunId':claim['job_id'],'context':{'experimentId':'bexp','caseId':claim['case_id'],'datasetContentHash':self.save_dataset()['contentHash']},'benchmark':{'key':'fixture'},'evaluator':{'key':'fixture'},'artifacts':[{**value,'mediaType':'text/plain','sizeBytes':len(b'public submission\n')} for value in completion['artifacts']],'payload':{},'limits':{'timeoutSeconds':30,'cpu':1,'memoryMiB':128}};request={'runId':identifier,'requestDigest':'sha256:'+'e'*64,'evaluationJob':job,'platformBaseUrl':'http://localhost:3000','callbackBaseUrl':'http://localhost:3000/api/benchmark/v1/evaluations/'+identifier,'timeoutSeconds':30}
        service=self.service();service.callback('evaluation_prepare',parent_cap,{'job_id':claim['job_id'],'request':request},verified_device_client_id='client')
        body={'job_id':claim['job_id'],'child_job_id':identifier}
        first=service.callback('load_child_dispatch',parent_cap,body,verified_device_client_id='client');again=self.service().callback('load_child_dispatch',parent_cap,body,verified_device_client_id='client');self.assertEqual(first,again);self.assertIn('callbackHeaders',first['request'])
        self.assertNotEqual(first['request']['callbackHeaders']['x-agent-insight-callback-token'],parent_cap)
        with self.assertRaises(Forbidden):service.callback('load_child_dispatch',parent_cap,body|{'child_job_id':claim['job_id']},verified_device_client_id='client')
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM work_attempts WHERE worker_id='benchmark-evaluator-controller'").fetchone()[0],1)

    def denied_callback_after(self,sql,args=(),error=Unauthorized):
        claim,_=self.seal();capability=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        with self.control.transaction() as con:con.execute(sql,args)
        with self.assertRaises(error):self.service().callback('progress',capability,{'job_id':claim['job_id'],'progress':{'kind':'execution','stage':'agent_running','occurredAt':'2026-11-12T00:00:00Z','progress':{}}},verified_device_client_id='client')

    def test_callback_rechecks_origin_session_expiry(self):self.denied_callback_after("UPDATE iam_sessions SET expires_at_ms=? WHERE principal_id='alice'",(self.now,))
    def test_callback_rechecks_origin_principal_disable(self):self.denied_callback_after("UPDATE iam_principals SET status='disabled' WHERE principal_id='alice'")
    def test_callback_rechecks_origin_auth_version(self):self.denied_callback_after("UPDATE iam_principals SET auth_version=auth_version+1 WHERE principal_id='alice'")
    def test_callback_rechecks_group_membership(self):self.denied_callback_after("UPDATE iam_group_memberships SET status='disabled' WHERE principal_id='alice'",error=Forbidden)
    def test_callback_rechecks_workspace_deletion(self):self.denied_callback_after("UPDATE workspaces SET state='deleted' WHERE workspace_id='w'",error=Forbidden)
    def test_callback_capability_expiry_cannot_be_replayed_after_hard_deadline(self):
        claim,_=self.seal();capability=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token'];self.now=claim['lease_until_ms']
        with self.assertRaises(Unauthorized):self.service().callback('load_work',capability,{'job_id':claim['job_id']},verified_device_client_id='client')

    def test_012_to_013_preserves_all_history_bytes_and_artifact_guards(self):
        from unittest.mock import patch
        from services.storage import migrations
        known={backend:migrations.load_migrations(backend) for backend in ('sqlite','postgresql','opengauss')}
        with patch.object(migrations,'load_migrations',side_effect=lambda backend:known[backend][:12]):
            fixture.DatasetTests.setUp(self);claim,cap,artifact,_,_=self.upload()
        def inventory():
            with self.control.read_transaction() as con:
                names=[r[0] for r in con.execute('SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type=?',(self.control.schema,'BASE TABLE'))] if hasattr(self.control,'schema') else [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
                return {name:sorted([tuple(row) for row in con.execute('SELECT * FROM '+name)],key=repr) for name in sorted(names)}
        before=inventory()
        with patch.object(migrations,'load_migrations',side_effect=lambda backend:known[backend][:13]):
            if hasattr(self.control,'schema'):
                with self.control.transaction() as con:migrations.apply(con,self.control.backend,clock=self.control.clock,applied=12)
            else:
                result=self.control.migrate(backup_path=Path(self.tmp.name)/'before-013.db');self.assertTrue(Path(result['backup_path']).is_file())
        after=inventory();self.assertEqual([row for row in after.pop('schema_meta') if row[0]<=12],before.pop('schema_meta'));self.assertEqual(after,before)
        with self.assertRaises(Conflict):
            with self.control.transaction() as con:con.execute('UPDATE benchmark_artifacts SET name=? WHERE artifact_id=?',('changed',artifact['artifactId']))
        with self.assertRaises(Conflict):
            with self.control.transaction() as con:con.execute('DELETE FROM benchmark_artifacts WHERE artifact_id=?',(artifact['artifactId'],))

    def test_empty_unicode_evidence_remains_supported_without_weakening_artifact_identity(self):
        import base64,hashlib
        handle,capability,_=self.evaluation();payload={'job_id':handle['job_id'],'name':'日志/标准输出.txt','kind':'runtime-output','media_type':'text/plain','expected_sha256':'sha256:'+hashlib.sha256(b'').hexdigest(),'bytes_base64':base64.b64encode(b'').decode()}
        result=self.service().callback('artifact_put',capability,payload);self.assertEqual(result['size'],0)
        self.assertEqual(self.service().callback('artifact_put',capability,payload),result)
        with self.assertRaises(ValueError):self.service().callback('artifact_put',capability,payload|{'name':'日志/..'},verified_device_client_id=None)

    def test_claim_handle_alone_does_not_authorize_private_work_or_callback_capability_reads(self):
        claim,_=self.seal()
        from services.storage.benchmark_core import BenchmarkStore
        public=BenchmarkStore(self.control,controller_key_file=Path(self.tmp.name)/'controller-key',device_verifier=lambda *_:True,evidence=getattr(self,'evidence',None))
        for action in ('load_work','load_dispatch'):
            with self.subTest(action=action),self.assertRaises(Forbidden):public.dispatch(action,self.token,'w',claim)
        capability=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        with self.assertRaises(Forbidden):public.callback('load_work',capability,{'job_id':claim['job_id']},verified_device_client_id='client')

    def test_definitive_dispatch_rejection_settles_work_and_case_without_a_fake_machine_score(self):
        claim,_=self.seal();result=self.invoke('dispatch_checkpoint',**claim,state='failed',operation_key='definitive-rejection');self.assertEqual(result['protocol_state'],'dispatch_failed');self.assertEqual(self.invoke('dispatch_checkpoint',**claim,state='failed',operation_key='definitive-rejection'),result)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT status FROM work_items WHERE work_item_id=?',(claim['work_item_id'],)).fetchone()[0],'failed');self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)
            self.assertEqual(con.execute("SELECT status FROM experiment_heads WHERE experiment_id='bexp'").fetchone()[0],'running')
        intent=self.invoke('claim_intents',worker_id='failure',limit=10)[0];self.invoke('finish_intent',**intent['handle'],operation='classify_failure',failure_source_hash=intent['failure_source_hash'],operation_key='classify-rejection')
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT status FROM experiment_heads WHERE experiment_id='bexp'").fetchone()[0],'failed')

    def test_api_origin_credential_is_also_live_validated_without_storing_its_plaintext(self):
        self.token=self.iam.issue_api_credential(self.token,'w',['read','write','execute'])
        claim,_=self.seal();capability=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        with self.control.read_transaction() as con:
            row=dict(con.execute('SELECT * FROM benchmark_jobs').fetchone());self.assertEqual(row['origin_credential_kind'],'api');self.assertNotIn(self.token,json.dumps(row))
        self.iam.revoke_credential(self.token)
        with self.assertRaises(Unauthorized):self.service().callback('progress',capability,{'job_id':claim['job_id'],'progress':{'kind':'execution','stage':'agent_running','occurredAt':'2026-11-12T00:00:00Z','progress':{}}},verified_device_client_id='client')

    def test_callback_rejects_an_attempt_that_lost_its_actual_worker_fence(self):
        claim,_=self.seal();capability=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        with self.control.transaction() as con:con.execute('UPDATE work_items SET etag=etag+1 WHERE work_item_id=?',(claim['work_item_id'],))
        with self.assertRaises(Conflict):self.service().callback('load_work',capability,{'job_id':claim['job_id']},verified_device_client_id='client')

    def test_callback_rechecks_shared_public_dataset_acl_without_exposing_its_private_gold_asset(self):
        from unittest.mock import patch
        service=self.service();dataset=service.dispatch('dataset_import',self.bob,'w',self.dataset()|{'operation_key':'bob-source'})
        with self.control.read_transaction() as con:asset=con.execute('SELECT public_asset_id FROM benchmark_dataset_heads').fetchone()[0]
        self.iam.share_resource(self.bob,'w','asset',asset,'alice')
        with patch.object(self,'save_dataset',return_value=dataset):
            claim,_=self.seal();capability=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        self.iam.unshare_resource(self.bob,'w','asset',asset,'alice')
        with self.assertRaises(Forbidden):service.callback('progress',capability,{'job_id':claim['job_id'],'progress':{'kind':'execution','stage':'agent_running','occurredAt':'2026-11-12T00:00:00Z','progress':{}}},verified_device_client_id='client')

    def test_execution_claim_enforces_frozen_experiment_concurrency_and_resumes_the_same_attempt(self):
        from unittest.mock import patch
        data=self.dataset();second=json.loads(json.dumps(data['cases'][0]));second.update(id='dc2',externalCaseId='external2',ordinal=1);data['cases'].append(second);data['public_dataset']['cases'].append(data['public_dataset']['cases'][0]|{'id':'dc2'})
        with patch.object(self,'dataset',return_value=data):started=self.start()
        first=self.invoke('claim',job_id=started['runId'],worker_id='one');jobs=self.invoke('list_jobs',experiment_id='bexp');other=next(row for row in jobs if row['job_id']!=first['job_id'])
        self.assertIsNone(self.invoke('claim',job_id=other['job_id'],worker_id='two'))
        resumed=self.invoke('resume_work',job_id=first['job_id']);self.assertEqual(resumed['handle'],first)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM work_attempts').fetchone()[0],1)

    def shared_source(self,finished=False):
        from unittest.mock import patch
        service=self.service();dataset=service.dispatch('dataset_import',self.bob,'w',self.dataset()|{'operation_key':'bob-shared-source'})
        with self.control.read_transaction() as con:asset=con.execute('SELECT public_asset_id FROM benchmark_dataset_heads').fetchone()[0]
        self.iam.share_resource(self.bob,'w','asset',asset,'alice')
        with patch.object(self,'save_dataset',return_value=dataset):value=self.execute_complete() if finished else self.seal()
        return asset,value

    def test_read_view_and_artifact_download_recheck_source_permissions(self):
        asset,(_,_,completion,_)=self.shared_source(finished=True);artifact=completion['artifacts'][0]['artifactId'];self.iam.unshare_resource(self.bob,'w','asset',asset,'alice')
        for action,body in [('read',{'experiment_id':'bexp'}),('read_view',{'experiment_id':'bexp'}),('artifact_lookup',{'artifact_id':artifact})]:
            with self.subTest(action=action),self.assertRaises(Forbidden):self.invoke(action,**body)

    def test_artifact_source_acl_postflight_uses_a_fresh_transaction_after_loading_bytes(self):
        from unittest.mock import patch
        asset,(_,_,completion,_)=self.shared_source(finished=True);artifact=completion['artifacts'][0]['artifactId'];service=self.service();read=service._artifact_read_tx
        def during_read(*args):
            value=read(*args);self.iam.unshare_resource(self.bob,'w','asset',asset,'alice');return value
        with patch.object(service,'_artifact_read_tx',side_effect=during_read),self.assertRaises(Forbidden):service.dispatch('artifact_lookup',self.token,'w',{'artifact_id':artifact})

    def test_execution_deadline_covers_frozen_environment_prepare_agent_cleanup_and_delivery(self):
        from unittest.mock import patch
        invoke=self.invoke
        def with_profile(action,**body):
            if action=='create':body['run_config']['executionProfile']={'timeouts':{'prepareSeconds':1800,'cleanupSeconds':120}}
            return invoke(action,**body)
        with patch.object(self,'invoke',side_effect=with_profile):claim,_=self.seal()
        self.assertEqual(claim['lease_until_ms']-self.now,(1800+30+120+300)*1000)

    def test_resume_only_cannot_create_a_new_run_after_the_last_job_finishes(self):
        handle,capability,_=self.evaluation();accepted=self.service().callback('evaluation_complete',capability,{'job_id':handle['job_id'],'completion':{'status':'completed','rawResult':{},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}}})
        self.service().callback('normalize_commit',capability,{'job_id':handle['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':{'status':'done','summary':'done','score':10,'points':[],'evidence':{},'nativeMetrics':{}}})
        value=self.invoke('start',experiment_id='bexp',resume_only=True,expected_runplan_id=handle['run_id'],operation_key='resume-after-complete');self.assertEqual(value['status'],'idle')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],1)

    def test_draft_results_project_all_pending_cases_without_creating_a_fake_runplan(self):
        self.create();view=self.invoke('read_view',experiment_id='bexp');run=view['snapshots'][0]['benchmark_runs'][0];self.assertEqual(run['status'],'pending');self.assertEqual(run['datasetCase']['externalCaseId'],'external')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],0)
        started=self.invoke('start',experiment_id='bexp',public_callback_origin='http://localhost:3000',executor_callback_origin='http://localhost:3000',operation_key='first-start');self.assertEqual(started['runId'],run['id'])

    def test_result_read_source_acl_postflight_does_not_reuse_the_original_snapshot(self):
        from unittest.mock import patch
        asset,_=self.shared_source();service=self.service();read=service._result_view
        def during_read(*args):
            value=read(*args);self.iam.unshare_resource(self.bob,'w','asset',asset,'alice');return value
        with patch.object(service,'_result_view',side_effect=during_read),self.assertRaises(Forbidden):service.dispatch('read_view',self.token,'w',{'experiment_id':'bexp'})

    def test_generic_experiment_rpc_cannot_mutate_benchmark_case_inputs_or_bypass_pending_delete_guard(self):
        self.create()
        from services.storage.experiments import ExperimentStore,ExperimentUnavailable
        store=ExperimentStore(self.control)
        for action in ('case_upsert','case_upsert_many'):
            with self.subTest(action=action),self.assertRaises(Conflict):store.dispatch(action,self.token,'w',{'experiment_id':'bexp','case':{'input':'different'},'cases':[],'operation_key':'generic-'+action})
        for action in ('cancel','remove','case_remove'):
            with self.subTest(action=action),self.assertRaises(ExperimentUnavailable):store.dispatch(action,self.token,'w',{'experiment_id':'bexp','case_id':'missing','operation_key':'generic-'+action})

    def test_dispatch_intent_recovery_reuses_exact_job_request_capability_and_actual_attempt(self):
        claim,_=self.seal();original=self.invoke('load_dispatch',**claim)['request'];intent=self.invoke('claim_intents',worker_id='recovery-one',limit=10)[0];self.assertEqual(intent['request'],original)
        self.assertEqual(self.invoke('claim_intents',worker_id='recovery-one',limit=10)[0],intent)
        result=self.invoke('finish_intent',**intent['handle'],operation='dispatch_ack',state='unknown',operation_key='unknown-intent');self.assertEqual(result['intent_state'],'pending')
        self.now+=1001;again=self.invoke('claim_intents',worker_id='recovery-two',limit=10)[0];self.assertEqual(again['request'],original);self.assertNotEqual(again['handle']['outbox_attempt'],intent['handle']['outbox_attempt'])
        done=self.invoke('finish_intent',**again['handle'],operation='dispatch_ack',state='accepted',operation_key='accepted-intent');self.assertEqual(done['intent_state'],'sent')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM work_attempts').fetchone()[0],1)
            capability=original['callbackHeaders']['x-agent-insight-callback-token'];self.assertNotIn(capability,json.dumps([dict(row) for row in con.execute('SELECT * FROM outbox_events')]))

    def test_accepted_raw_result_recovers_normalization_without_running_the_external_evaluator_again(self):
        handle,capability,_=self.evaluation();raw={'status':'completed','rawResult':{'score':50},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}};accepted=self.service().callback('evaluation_complete',capability,{'job_id':handle['job_id'],'completion':raw})
        intents=self.invoke('claim_intents',worker_id='raw-recovery',limit=10);self.assertEqual(len(intents),1);intent=intents[0];self.assertEqual(intent['event_type'],'benchmark.evaluation.raw.accepted.v1');self.assertEqual(intent['work']['completion_hash'],accepted['completion_hash'])
        normalized={'status':'done','summary':'recovered raw','score':50,'points':[],'evidence':{},'nativeMetrics':{}}
        result=self.invoke('finish_intent',**intent['handle'],operation='normalize',raw_completion_hash=accepted['completion_hash'],normalized=normalized,operation_key='recover-raw');self.assertEqual(result['normalizedResult'],normalized)
        self.assertEqual(self.invoke('finish_intent',**intent['handle'],operation='normalize',raw_completion_hash=accepted['completion_hash'],normalized=normalized,operation_key='recover-raw'),result)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM work_attempts').fetchone()[0],2);self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox_events WHERE event_type LIKE 'benchmark.%' AND state<>'sent'").fetchone()[0],0)

    def test_external_completion_replay_after_internal_raw_recovery_returns_the_same_selected_result(self):
        handle,capability,_=self.evaluation();raw={'status':'completed','rawResult':{},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}};accepted=self.service().callback('evaluation_complete',capability,{'job_id':handle['job_id'],'completion':raw});intent=self.invoke('claim_intents',worker_id='recovery',limit=10)[0];normalized={'status':'done','summary':'recovered','score':25,'points':[],'evidence':{},'nativeMetrics':{}}
        first=self.invoke('finish_intent',**intent['handle'],operation='normalize',raw_completion_hash=accepted['completion_hash'],normalized=normalized,operation_key='recovery')
        replay=self.service().callback('normalize_commit',capability,{'job_id':handle['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':normalized});self.assertEqual(replay,first)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)

    def test_start_prebuilds_primary_scoring_work_and_evaluation_reuses_it(self):
        self.start()
        with self.control.read_transaction() as con:
            slot=dict(con.execute("SELECT * FROM experiment_result_slots WHERE evaluator_id='benchmark:fixture'").fetchone());self.assertIsNotNone(slot['work_item_id']);self.assertIsNotNone(slot['run_id'])
        handle,_,_=self.evaluation()
        self.assertEqual(handle['work_item_id'],slot['work_item_id'])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM work_items').fetchone()[0],2)

    def test_failed_execution_has_recoverable_null_score_classifier_with_real_primary_attempt(self):
        claim,_=self.seal();cap=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token'];completion={'kind':'execution','status':'failed','artifacts':[],'runFacts':{},'cleanup':{'status':'succeeded'}}
        self.service().callback('execution_complete',cap,{'job_id':claim['job_id'],'completion':completion},verified_device_client_id='client')
        intents=self.invoke('claim_intents',worker_id='classifier-recovery',limit=10);self.assertEqual(len(intents),1);intent=intents[0];self.assertEqual(intent['event_type'],'benchmark.failure.classification.requested.v1')
        result=self.invoke('finish_intent',**intent['handle'],operation='classify_failure',failure_source_hash=intent['failure_source_hash'],operation_key='classify')
        self.assertTrue(result['accepted']);self.assertEqual(self.invoke('finish_intent',**intent['handle'],operation='classify_failure',failure_source_hash=intent['failure_source_hash'],operation_key='classify'),result)
        with self.control.read_transaction() as con:
            receipt=dict(con.execute('SELECT * FROM result_receipts').fetchone());packet=self.service()._load(receipt['content_hash'],receipt['artifact_ref']);self.assertIsNone(packet['result']['score']);self.assertEqual(packet['result']['status'],'failed');self.assertFalse(packet['result']['evidence']['harnessExecuted'])
            attempt=dict(con.execute('SELECT * FROM work_attempts WHERE attempt_id=?',(receipt['attempt_id'],)).fetchone());self.assertEqual(attempt['worker_id'],'benchmark-failure-classifier');self.assertEqual(attempt['status'],'failed')
            event=json.loads(con.execute("SELECT payload_json FROM outbox_events WHERE event_type='evaluation.result.accepted.v1'").fetchone()[0]);self.assertEqual(event['benchmark_failure_job_id'],claim['job_id']);self.assertEqual(event['benchmark_failure_source_hash'],intent['failure_source_hash']);self.assertNotIn('benchmark_job_id',event)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox_events WHERE event_type LIKE 'benchmark.%' AND state<>'sent'").fetchone()[0],0)

    def test_unknown_dispatch_cannot_be_reclassified_as_a_definitive_failure(self):
        claim,_=self.seal();self.invoke('dispatch_checkpoint',**claim,state='unknown',operation_key='unknown')
        with self.assertRaises(Conflict):self.invoke('dispatch_checkpoint',**claim,state='failed',operation_key='failed-after-unknown')
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM benchmark_operation_receipts WHERE operation_kind='failure-source'").fetchone()[0],0)

    def classify_pending_failure(self):
        intent=self.invoke('claim_intents',worker_id='failure-recovery',limit=10)[0]
        return self.invoke('finish_intent',**intent['handle'],operation='classify_failure',failure_source_hash=intent['failure_source_hash'],operation_key='classify-'+intent['job']['job_id'])

    def test_submission_rejection_uses_the_prebuilt_primary_without_claiming_harness_execution(self):
        claim,cap,_,_=self.execute_complete();self.service().callback('submission_reject',cap,{'job_id':claim['job_id']},verified_device_client_id='client');self.classify_pending_failure()
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM benchmark_jobs WHERE kind='evaluate'").fetchone()[0],0);self.assertEqual(con.execute('SELECT COUNT(*) FROM work_items').fetchone()[0],2)
            slot=con.execute("SELECT evaluation_version,status FROM experiment_result_slots WHERE evaluator_id='benchmark:fixture'").fetchone();self.assertEqual(slot['evaluation_version'],0);self.assertEqual(slot['status'],'failed')
        result=self.invoke('read_view',experiment_id='bexp')['snapshots'][0]['experiment']['cases'][0]['results'][0];self.assertIsNone(result['score']);self.assertEqual(result['status'],'failed')

    def test_undispatched_preparation_failure_can_recover_without_a_callback_capability(self):
        claim=self.claim();self.invoke('dispatch_checkpoint',**claim,state='failed',preparation_failed=True,operation_key='prep-failed');self.classify_pending_failure()
        with self.control.read_transaction() as con:
            job=con.execute('SELECT * FROM benchmark_jobs').fetchone();self.assertIsNone(job['request_hash']);self.assertIsNone(job['callback_token_hash']);self.assertEqual(job['protocol_state'],'blocked');self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)

    def test_evaluator_definite_rejection_classifies_same_primary_work_and_fences_late_callback(self):
        handle,cap,_=self.evaluation();self.invoke('dispatch_checkpoint',**handle,state='failed',operation_key='eval-rejected');self.classify_pending_failure()
        with self.control.read_transaction() as con:
            receipt=con.execute('SELECT * FROM result_receipts').fetchone();self.assertEqual(receipt['work_item_id'],handle['work_item_id']);self.assertNotEqual(receipt['attempt_id'],handle['attempt_id']);self.assertEqual(con.execute('SELECT COUNT(*) FROM work_items').fetchone()[0],2)
        with self.assertRaises(Conflict):self.service().callback('evaluation_complete',cap,{'job_id':handle['job_id'],'completion':{'status':'completed','rawResult':{},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}}})

    def test_failure_classifier_requires_proof_exact_source_live_origin_and_current_primary_slot(self):
        from services.storage.benchmark_core import BenchmarkStore
        claim,_=self.seal();self.invoke('dispatch_checkpoint',**claim,state='failed',operation_key='rejected');intent=self.invoke('claim_intents',worker_id='failure',limit=10)[0]
        body={'job_id':claim['job_id'],'failure_source_hash':intent['failure_source_hash'],'operation_key':'classify-direct'}
        with self.assertRaises(Forbidden):BenchmarkStore(self.control).dispatch('classify_failure',self.token,'w',body)
        with self.assertRaises(Conflict):self.invoke('classify_failure',**(body|{'failure_source_hash':'0'*64}))
        with self.control.transaction() as con:con.execute("UPDATE work_items SET cancel_requested=1 WHERE evaluator_slot='benchmark:fixture'")
        with self.assertRaises(Conflict):self.invoke('classify_failure',**body)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)

    def test_failure_classifier_rechecks_revoked_origin_even_for_an_alternate_live_owner_session(self):
        claim,_=self.seal();self.invoke('dispatch_checkpoint',**claim,state='failed',operation_key='rejected');intent=self.invoke('claim_intents',worker_id='failure',limit=10)[0];other=self.iam.issue_session_for_provisioning('alice');self.iam.revoke_credential(self.token)
        with self.assertRaises(Unauthorized):self.service().dispatch('classify_failure',other,'w',{'job_id':claim['job_id'],'failure_source_hash':intent['failure_source_hash'],'operation_key':'classify-revoked'})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)

    def test_pending_failure_classification_cannot_accidentally_start_a_new_generation(self):
        claim,_=self.seal();self.invoke('dispatch_checkpoint',**claim,state='failed',operation_key='reject')
        again=self.invoke('start',experiment_id='bexp',public_callback_origin='http://localhost:3000',executor_callback_origin='http://localhost:3000',operation_key='start-during-classification');self.assertTrue(again['alreadyRunning']);self.assertEqual(again['runplanId'],claim['run_id'])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],1)

    def supplemental_ready(self,with_trace=True,evaluators=None):
        from services.storage.authorized import AuthorizedStorage
        from services.storage.observations import ObservationIngest
        from services.storage.tests.test_observations import packet
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.trace_service import TraceQueries
        self.supplemental_evaluators=evaluators or ['judge'];facts=MemoryFacts();ingest=ObservationIngest(self.control,facts);accepted=ingest.accept(self.token,'w',packet());ingest.work_once('benchmark-trace-indexer');self.execution_trace=accepted['trace_ids'][0] if with_trace else None
        self.evidence=TraceEvidence(TraceQueries(self.control,facts,cursor_secret=b'benchmark-supplemental-test-cursor'),AuthorizedStorage(self.iam,facts))
        handle,cap,_=self.evaluation();raw={'status':'completed','rawResult':{},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}};accepted=self.service().callback('evaluation_complete',cap,{'job_id':handle['job_id'],'completion':raw});self.service().callback('normalize_commit',cap,{'job_id':handle['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':{'status':'done','score':80,'summary':'primary','points':[],'evidence':{}}})
        return handle,self.invoke('claim_intents',worker_id='continuation-owner',limit=10)[0]

    def test_supplemental_uses_independent_frozen_trace_plan_without_rewriting_primary_case(self):
        handle,intent=self.supplemental_ready();self.assertEqual(intent['event_type'],'benchmark.continuation.requested.v1')
        with self.control.read_transaction() as con:before=dict(con.execute('SELECT * FROM experiment_cases').fetchone())
        result=self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-primary');self.assertTrue(result['accepted']);self.assertNotEqual(result['run_id'],handle['run_id'])
        self.assertEqual(self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-primary'),result)
        from services.storage.experiments import ExperimentStore
        store=ExperimentStore(self.control,self.evidence);work=store.dispatch('claim',self.token,'w',{'experiment_id':'bexp','worker_id':'real-supplemental-worker'});loaded=store.dispatch('load_work',self.token,'w',work);self.assertEqual(loaded['frozen_trace_evidence']['manifest']['trace_id'],self.execution_trace);self.assertEqual(loaded['frozen_evaluator']['id'],'judge')
        with self.control.read_transaction() as con:
            self.assertEqual(dict(con.execute('SELECT * FROM experiment_cases').fetchone()),before);self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],2);self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)
            plan=store._plan(con,'w','bexp',result['run_id'])[1];parent=store._plan(con,'w','bexp',handle['run_id'])[1];self.assertEqual(plan['releases'],parent['releases']|{'benchmark:origin:'+handle['job_id']:parent['releases']['benchmark']});self.assertEqual(plan['config']['model_selection'],parent['config']['model_selection']);self.assertEqual(plan['work_members'],[{'case_key':handle['case_id'],'evaluator_slot':'judge'}])

    def test_missing_trace_supplemental_creates_real_failed_null_receipts_without_evaluator_execution(self):
        handle,intent=self.supplemental_ready(with_trace=False);result=self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-missing');self.assertTrue(result['missing_trace'])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],2);attempt=con.execute("SELECT * FROM work_attempts WHERE worker_id='benchmark-source-classifier'").fetchone();self.assertIsNotNone(attempt);self.assertEqual(attempt['status'],'failed')
            receipt=con.execute("SELECT * FROM result_receipts WHERE evaluator_slot='judge'").fetchone();packet=self.service()._load(receipt['content_hash'],receipt['artifact_ref']);self.assertIsNone(packet['result']['score']);self.assertEqual(packet['result']['status'],'failed');self.assertFalse(packet['result']['evidence']['evaluatorModelExecuted'])
            self.assertEqual(con.execute("SELECT status FROM experiment_heads WHERE experiment_id='bexp'").fetchone()[0],'partial')

    def test_failed_primary_classification_also_settles_missing_trace_supplementals(self):
        self.supplemental_evaluators=['judge'];claim,_=self.seal();self.invoke('dispatch_checkpoint',**claim,state='failed',operation_key='dispatch-fail');self.classify_pending_failure();intent=self.invoke('claim_intents',worker_id='continuation',limit=10)[0];self.assertEqual(intent['event_type'],'benchmark.continuation.requested.v1')
        result=self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-failed-primary');self.assertTrue(result['missing_trace'])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],2);self.assertFalse(con.execute("SELECT 1 FROM experiment_result_slots WHERE status IN ('pending','running')").fetchone())

    def test_supplemental_shared_public_dataset_does_not_require_private_gold_permission(self):
        imported=self.service().dispatch('dataset_import',self.bob,'w',self.dataset()|{'operation_key':'bob-import'})
        with self.control.read_transaction() as con:head=dict(con.execute('SELECT * FROM benchmark_dataset_heads').fetchone())
        self.iam.share_resource(self.bob,'w','asset',head['public_asset_id'],'alice');self.save_dataset=lambda:imported
        with self.control.read_transaction() as con,self.assertRaises(Forbidden):self.iam._authorize(con,self.token,'w','read','asset',head['private_asset_id'])
        _,intent=self.supplemental_ready();result=self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-shared');self.assertTrue(result['supplemental'])

    def test_supplemental_claim_rejects_revoked_original_benchmark_credential_even_with_new_owner_session(self):
        _,intent=self.supplemental_ready();result=self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-origin');old=self.token;self.token=self.iam.issue_session_for_provisioning('alice');self.iam.revoke_credential(old)
        from services.storage.experiments import ExperimentStore
        with self.assertRaises(Unauthorized):ExperimentStore(self.control,self.evidence).dispatch('claim',self.token,'w',{'experiment_id':'bexp','run_id':result['run_id'],'worker_id':'supplemental-after-revoke'})

    def imported_body(self):
        import base64,hashlib
        raw=b'imported answer';return {'experiment_id':'bexp','public_callback_origin':'http://localhost:3000','executor_callback_origin':'http://localhost:3000','submissions':[{'dataset_case_id':'dc','artifacts':[{'name':'answer.txt','media_type':'text/plain','expected_sha256':'sha256:'+hashlib.sha256(raw).hexdigest(),'bytes_base64':base64.b64encode(raw).decode()}]}],'operation_key':'import-submissions'}

    def test_imported_submission_has_real_import_work_artifacts_and_eval_intent_without_agent_or_capability(self):
        self.imported_submission=True;self.create();body=self.imported_body();value=self.invoke('import_submissions',**body);self.assertEqual(self.invoke('import_submissions',**body),value)
        with self.control.read_transaction() as con:
            job=dict(con.execute('SELECT * FROM benchmark_jobs').fetchone());self.assertEqual(job['protocol_state'],'submitted');self.assertIsNone(job['callback_token_hash']);self.assertIsNone(job['callback_attempt_id']);self.assertEqual(con.execute('SELECT worker_id FROM work_attempts').fetchone()[0],'benchmark-submission-importer');self.assertEqual(con.execute('SELECT COUNT(*) FROM benchmark_artifacts').fetchone()[0],1);self.assertFalse(con.execute("SELECT 1 FROM outbox_events WHERE event_type='benchmark.dispatch.requested.v1'").fetchone())
            completion=self.service()._load(job['completion_hash'],job['completion_ref']);self.assertEqual(completion['runFacts'],{});self.assertEqual(completion['submissionSource'],'imported')
        intent=self.invoke('claim_intents',worker_id='import-eval-recovery',limit=10)[0];self.assertEqual(intent['event_type'],'benchmark.execution.completed.v1');self.assertEqual(intent['work']['request']['format'],'benchmark.imported-submission/v1');self.assertEqual(self.invoke('read_view',experiment_id='bexp')['snapshots'][0]['benchmark_runs'][0]['submissionSource'],'imported')
        with self.assertRaises(Conflict):self.invoke('start',experiment_id='bexp',public_callback_origin='http://localhost:3000',executor_callback_origin='http://localhost:3000',operation_key='forbidden-agent-start')
        changed=self.imported_body();changed['submissions'][0]['artifacts'][0]['bytes_base64']='Y2hhbmdlZA=='
        with self.assertRaises(Conflict):self.invoke('import_submissions',**changed)

    def test_imported_submission_invalid_bytes_roll_back_all_jobs_attempts_artifacts_and_runplan(self):
        self.imported_submission=True;self.create();body=self.imported_body();body['submissions'][0]['artifacts'][0]['expected_sha256']='sha256:'+'0'*64
        with self.assertRaises(Conflict):self.invoke('import_submissions',**body)
        with self.control.read_transaction() as con:
            for table in ('runs','benchmark_jobs','work_items','work_attempts','benchmark_artifacts','experiment_runs'):
                self.assertEqual(con.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0,table)

    def test_real_callback_winning_dispatch_ack_race_finishes_the_specific_recovery_intent(self):
        handle,cap,_=self.evaluation();intent=self.invoke('claim_intents',worker_id='dispatch-recovery',limit=10)[0]
        self.service().callback('progress',cap,{'job_id':handle['job_id'],'progress':{'kind':'evaluation','stage':'running_harness','occurredAt':'2026-11-12T00:00:00Z','progress':{}}})
        result=self.invoke('finish_intent',**intent['handle'],operation='dispatch_ack',state='accepted',operation_key='callback-won-ack');self.assertEqual(result['intent_state'],'sent')
        self.assertEqual(self.invoke('finish_intent',**intent['handle'],operation='dispatch_ack',state='accepted',operation_key='callback-won-ack'),result)

    def test_imported_empty_artifact_is_supported_and_storage_paths_are_opaque(self):
        import hashlib
        self.imported_submission=True;self.create();body=self.imported_body();artifact=body['submissions'][0]['artifacts'][0];artifact.update(bytes_base64='',expected_sha256='sha256:'+hashlib.sha256(b'').hexdigest());result=self.invoke('import_submissions',**body);self.assertTrue(result['accepted'])
        view=self.invoke('read_view',experiment_id='bexp');self.assertNotIn('storage_ref',json.dumps(view));self.assertNotIn(str(self.tmp.name),json.dumps(view))
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT size_bytes FROM benchmark_artifacts').fetchone()[0],0)

    def test_generic_plan_mutations_cannot_bypass_benchmark_primary_authority(self):
        from services.storage.experiments import ExperimentStore,ExperimentUnavailable
        self.create();store=ExperimentStore(self.control)
        for action in ('start','execute_start','retry'):
            with self.subTest(action=action),self.assertRaises(ExperimentUnavailable):store.dispatch(action,self.token,'w',{'experiment_id':'bexp','frozen_evaluators':{'benchmark:fixture':{'id':'forged'}} ,'operation_key':'generic-'+action})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],0)

    def normalized_evaluation(self):
        handle,cap,_=self.evaluation();raw={'status':'completed','rawResult':{},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}};accepted=self.service().callback('evaluation_complete',cap,{'job_id':handle['job_id'],'completion':raw});self.service().callback('normalize_commit',cap,{'job_id':handle['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':{'status':'done','score':80,'summary':'first primary','points':[],'evidence':{}}});return handle,cap

    def test_evaluation_retry_creates_new_frozen_plan_and_job_without_rerunning_agent_or_overwriting_history(self):
        import copy
        handle,cap=self.normalized_evaluation()
        with self.control.read_transaction() as con:slot=dict(con.execute("SELECT * FROM experiment_result_slots WHERE evaluator_id='benchmark:fixture'").fetchone());old_receipt=dict(con.execute('SELECT * FROM result_receipts').fetchone())
        prepared=self.invoke('prepare_evaluation_retry',experiment_id='bexp',result_id=slot['result_id']);self.assertEqual(prepared['previous_job_id'],handle['job_id']);self.assertEqual(prepared['expected_machine_result_id'],old_receipt['result_id'])
        with self.control.read_transaction() as con:old_job=dict(con.execute("SELECT * FROM benchmark_jobs WHERE kind='evaluate'").fetchone());request=self.service()._load(old_job['request_hash'],old_job['request_ref'])
        request.update(runId='veval_retry_fixture',requestDigest='sha256:'+'e'*64,callbackBaseUrl='http://localhost:3000/api/benchmark/v1/evaluations/veval_retry_fixture');request['evaluationJob']['evaluationId']='veval_retry_fixture'
        body={'experiment_id':'bexp','result_id':slot['result_id'],'previous_job_id':handle['job_id'],'expected_machine_result_id':old_receipt['result_id'],'request':request,'operation_key':'retry-primary'};result=self.invoke('retry_evaluation',**body);self.assertNotEqual(result['runplan_id'],handle['run_id']);self.assertEqual(self.invoke('retry_evaluation',**body),result)
        with self.control.read_transaction() as con:
            self.assertEqual(dict(con.execute('SELECT * FROM result_receipts WHERE result_id=?',(old_receipt['result_id'],)).fetchone()),old_receipt);self.assertEqual(con.execute("SELECT COUNT(*) FROM benchmark_jobs WHERE kind='execute'").fetchone()[0],1);new=dict(con.execute("SELECT * FROM benchmark_jobs WHERE job_id='veval_retry_fixture'").fetchone());self.assertEqual(new['attempt_no'],2);self.assertEqual(new['retry_of_job_id'],handle['job_id']);self.assertEqual(new['parent_job_id'],old_job['parent_job_id']);self.assertNotEqual(new['work_item_id'],handle['work_item_id'])
        with self.assertRaises(Conflict):self.invoke('retry_evaluation',**(body|{'operation_key':'concurrent-loser'}))
        with self.assertRaises(Conflict):self.service().callback('normalize_commit',cap,{'job_id':handle['job_id'],'raw_completion_hash':old_job['completion_hash'],'normalized':{'status':'done','score':80,'summary':'first primary','points':[],'evidence':{}}})

    def evaluation_retry_body(self,handle,identity='veval_retry_fixture'):
        import copy
        with self.control.read_transaction() as con:
            slot=dict(con.execute("SELECT * FROM experiment_result_slots WHERE evaluator_id='benchmark:fixture'").fetchone());job=dict(con.execute('SELECT * FROM benchmark_jobs WHERE job_id=?',(handle['job_id'],)).fetchone());request=copy.deepcopy(self.service()._load(job['request_hash'],job['request_ref']))
        request.update(runId=identity,requestDigest='sha256:'+'f'*64,callbackBaseUrl='http://localhost:3000/api/benchmark/v1/evaluations/'+identity);request['evaluationJob']['evaluationId']=identity
        return {'experiment_id':'bexp','result_id':slot['result_id'],'previous_job_id':handle['job_id'],'expected_machine_result_id':slot['selected_result_id'],'request':request,'operation_key':'retry-'+identity}

    def test_manual_evaluation_retry_accepts_current_owner_origin_and_preserves_old_human_review(self):
        from services.storage.experiments import ExperimentStore
        handle,_=self.normalized_evaluation();body=self.evaluation_retry_body(handle);ExperimentStore(self.control).dispatch('review',self.token,'w',{'experiment_id':'bexp','result_id':body['result_id'],'human_score':50,'human_reason':'old review','operation_key':'old-review'})
        old=self.token;self.token=self.iam.issue_session_for_provisioning('alice');self.iam.revoke_credential(old);prepared=self.invoke('prepare_evaluation_retry',experiment_id='bexp',result_id=body['result_id']);self.assertEqual(prepared['previous_job_id'],handle['job_id']);result=self.invoke('retry_evaluation',**body)
        new=self.invoke('claim',job_id=result['evaluationRunId'],worker_id='new-evaluator');self.invoke('checkpoint',**new,request=body['request'],operation_key='retry-seal');cap=self.invoke('load_dispatch',**new)['request']['callbackHeaders']['x-agent-insight-callback-token'];raw={'status':'completed','rawResult':{},'evidenceArtifactIds':[],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}};accepted=self.service().callback('evaluation_complete',cap,{'job_id':new['job_id'],'completion':raw});self.service().callback('normalize_commit',cap,{'job_id':new['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':{'status':'done','score':90,'summary':'new actual evaluation','points':[],'evidence':{}}})
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],2);self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_annotations WHERE kind='review'").fetchone()[0],1);slot=con.execute('SELECT review_id FROM experiment_result_slots WHERE result_id=?',(body['result_id'],)).fetchone();self.assertIsNone(slot['review_id'])
        view=self.invoke('read_view',experiment_id='bexp')['snapshots'][0];self.assertEqual(view['experiment']['cases'][0]['results'][0]['score'],90);self.assertEqual(view['benchmark_runs'][0]['evaluations'][0]['attemptNo'],2)

    def test_evaluation_retry_bad_artifact_rolls_back_plan_and_selection_atomically(self):
        handle,_=self.normalized_evaluation();body=self.evaluation_retry_body(handle);body['request']['evaluationJob']['artifacts'][0]['artifactId']='foreign-artifact'
        with self.assertRaises(Conflict):self.invoke('retry_evaluation',**body)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],1);self.assertEqual(con.execute('SELECT selected_result_id FROM experiment_result_slots WHERE result_id=?',(body['result_id'],)).fetchone()[0],body['expected_machine_result_id']);self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],1)

    def test_evaluation_retry_requires_private_proof_and_cannot_retry_an_active_harness(self):
        from services.storage.benchmark_core import BenchmarkStore
        handle,_,_=self.evaluation()
        with self.control.read_transaction() as con:slot=con.execute("SELECT result_id FROM experiment_result_slots WHERE evaluator_id='benchmark:fixture'").fetchone()[0]
        body={'experiment_id':'bexp','result_id':slot}
        with self.assertRaises(Forbidden):BenchmarkStore(self.control).dispatch('prepare_evaluation_retry',self.token,'w',body)
        with self.assertRaises(Conflict):self.invoke('prepare_evaluation_retry',**body)

    def test_delete_only_cancellation_fences_normal_callbacks_without_exposing_gold_or_requiring_execute(self):
        claim,_=self.seal();cap=self.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token'];token=self.iam.issue_api_credential(self.token,'w',['delete'])
        result=self.service().dispatch('cancel_request',token,'w',{'experiment_id':'bexp','mode':'remove','operation_key':'delete-only'});record=result['cancellation'];self.assertEqual(record['status'],'pending');self.assertTrue(result['handled'])
        private=self.service().dispatch('cancel_load',token,'w',{'experiment_id':'bexp','cancellation_id':record['id']});self.assertEqual(private['targets'][0]['legacyOwner'],'alice');self.assertEqual(private['targets'][0]['kind'],'benchmark');text=json.dumps(private);self.assertNotIn('PRIVATE GOLD',text);self.assertNotIn('bcap_',text);self.assertNotIn('storage_ref',text)
        with self.assertRaises((Conflict,Forbidden,__import__('services.storage.benchmark_core',fromlist=['BenchmarkNotFound']).BenchmarkNotFound)):self.service().callback('progress',cap,{'job_id':claim['job_id'],'progress':{'kind':'execution','stage':'agent_running','occurredAt':'2026-11-12T00:00:00Z','progress':{}}},verified_device_client_id='client')
        with self.assertRaises(Forbidden):self.service().dispatch('load_work',token,'w',claim)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM experiment_heads').fetchone()[0],'deleted');self.assertEqual(con.execute('SELECT cancel_requested FROM work_items WHERE work_item_id=?',(claim['work_item_id'],)).fetchone()[0],1);self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)
        self.assertEqual(self.service().dispatch('cancel_request',token,'w',{'experiment_id':'bexp','mode':'remove','operation_key':'delete-only'}),result)

    def test_cancellation_binds_command_before_cleanup_and_only_confirms_the_exact_frozen_target(self):
        claim,_=self.seal();record=self.invoke('cancel_request',experiment_id='bexp',mode='cancel',operation_key='cancel')['cancellation'];target=json.loads(record['targetsJson'])[0]
        proof={'transport':'device-command','command_id':'cmd_cancel','client_id':'client','legacy_owner':'alice','kind':'benchmark','run_id':claim['job_id'],'request_digest':target['requestDigest'],'command_status':'SUCCEEDED','result':{'runId':claim['job_id'],'status':'cancelled'}}
        with self.assertRaises(Conflict):self.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=record['id'],expected_revision=record['revision'],target_id=claim['job_id'],proof=proof,operation_key='unbound-cleanup')
        bound=self.invoke('cancel_dispatch_bind',experiment_id='bexp',cancellation_id=record['id'],expected_revision=record['revision'],target_id=claim['job_id'],command_id='cmd_cancel',previous_command_id=None,operation_key='bind');self.assertEqual(json.loads(bound['targetsJson'])[0]['commandId'],'cmd_cancel')
        for changed in ({'client_id':'other'}, {'run_id':'other'}, {'request_digest':'sha256:'+'0'*64}, {'result':{'runId':claim['job_id'],'status':'cancelling'}}):
            with self.subTest(changed=changed),self.assertRaises(Conflict):self.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=record['id'],expected_revision=bound['revision'],target_id=claim['job_id'],proof=proof|changed,operation_key='bad-'+str(len(json.dumps(changed))))
        done=self.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=record['id'],expected_revision=bound['revision'],target_id=claim['job_id'],proof=proof,operation_key='cleanup');self.assertEqual(done['status'],'completed')
        self.assertEqual(self.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=record['id'],expected_revision=bound['revision'],target_id=claim['job_id'],proof=proof,operation_key='cleanup'),done)
        with self.control.read_transaction() as con:
            self.assertIsNone(con.execute('SELECT completion_hash FROM benchmark_jobs').fetchone()[0]);self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox_events WHERE event_type='benchmark.cancellation.requested.v1' AND state<>'sent'").fetchone()[0],0)

    def test_cancel_draft_only_cannot_stop_an_already_started_benchmark(self):
        self.seal()
        with self.assertRaises(Conflict):self.invoke('cancel_request',experiment_id='bexp',mode='remove',draft_only=True,operation_key='draft-only')
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_annotations WHERE kind='cancellation'").fetchone()[0],0)

    def test_benchmark_cancellation_discriminator_preserves_ordinary_cancel_permissions_without_delete(self):
        from services.storage.experiments import ExperimentStore
        from services.storage.tests.test_experiments import experiment
        store=ExperimentStore(self.control);store.dispatch('create',self.token,'w',{'experiment':experiment(),'operation_key':'ordinary-create'});limited=self.iam.issue_api_credential(self.token,'w',['read','write','execute'])
        self.assertEqual(self.service().dispatch('cancel_request',limited,'w',{'experiment_id':'exp','mode':'cancel','operation_key':'ordinary-probe'}),{'handled':False})
        result=store.dispatch('cancel',limited,'w',{'experiment_id':'exp','operation_key':'ordinary-cancel'});self.assertEqual(self.service().dispatch('cancel_load',limited,'w',{'cancellation_id':result['cancellation']['id']}),{'handled':False})
        with self.assertRaises(Forbidden):self.service().dispatch('cancel_request',limited,'w',{'experiment_id':'exp','mode':'remove','operation_key':'ordinary-delete-denied'})

    def test_pending_cancellations_are_paged_by_original_actor_with_delete_only_permissions(self):
        self.seal();first=self.service().dispatch('cancel_request',self.admin,'w',{'experiment_id':'bexp','mode':'cancel','operation_key':'admin-cancel'})['cancellation'];token=self.iam.issue_api_credential(self.admin,'w',['delete'])
        values=self.service().dispatch('cancel_load',token,'w',{'pending':True,'limit':1});self.assertEqual([value['id'] for value in values],[first['id']]);self.assertEqual(self.service().dispatch('cancel_load',token,'w',{'pending':True,'limit':1,'after_id':first['id']}),[])
        alice=self.iam.issue_api_credential(self.token,'w',['delete']);self.assertEqual(self.service().dispatch('cancel_load',alice,'w',{'pending':True,'limit':10}),[])
        reader=self.iam.issue_api_credential(self.admin,'w',['read','write','execute'])
        with self.assertRaises(Forbidden):self.service().dispatch('cancel_load',reader,'w',{'pending':True,'limit':10})
        self.assertNotIn('PRIVATE GOLD',json.dumps(values));self.assertEqual(json.loads(values[0]['targetsJson'])[0]['legacyOwner'],'alice')

    def test_manual_supplemental_retry_uses_new_origin_without_reviving_old_queued_work_or_hiding_history(self):
        from services.storage.experiments import ExperimentStore
        _,intent=self.supplemental_ready(evaluators=['judge','judge2']);continued=self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-two');store=ExperimentStore(self.control,self.evidence)
        handle=store.dispatch('claim',self.token,'w',{'experiment_id':'bexp','run_id':continued['run_id'],'worker_id':'one-judge'});store.dispatch('complete',self.token,'w',handle|{'result':{'score':55},'operation_key':'first-judge'})
        old=self.token;self.token=self.iam.issue_session_for_provisioning('alice');self.iam.revoke_credential(old);self.assertEqual(len(store.dispatch('read',self.token,'w',{'experiment_id':'bexp'})['experiment']['cases'][0]['results']),3);self.assertEqual(self.invoke('read_view',experiment_id='bexp')['coverage'],'complete')
        with self.assertRaises(Unauthorized):store.dispatch('claim',self.token,'w',{'experiment_id':'bexp','run_id':continued['run_id'],'worker_id':'old-queued-after-revoke'})
        result=store.dispatch('retry',self.token,'w',{'experiment_id':'bexp','result_id':handle['result_id'],'operation_key':'manual-judge-retry'});new_run=result['current_run_id'];self.assertNotEqual(new_run,continued['run_id'])
        with self.control.read_transaction() as con:
            plan=store._plan(con,'w','bexp',new_run)[1];self.assertEqual(plan['work_members'],[{'case_key':handle['case_id'],'evaluator_slot':handle['evaluator_id']}]);self.assertTrue(any(key.startswith('benchmark:manual-origin:') for key in plan['releases']));self.assertEqual(con.execute("SELECT COUNT(*) FROM benchmark_operation_receipts WHERE operation_kind='supplemental-manual-retry'").fetchone()[0],1)
        new=store.dispatch('claim',self.token,'w',{'experiment_id':'bexp','run_id':new_run,'worker_id':'new-manual-judge'});self.assertIsNotNone(new)
        with self.assertRaises(Unauthorized):store.dispatch('claim',self.token,'w',{'experiment_id':'bexp','run_id':continued['run_id'],'worker_id':'old-still-not-revived'})
        store.dispatch('complete',self.token,'w',new|{'result':{'score':65},'operation_key':'new-judge'});self.assertEqual(self.invoke('read_view',experiment_id='bexp')['snapshots'][0]['benchmark_runs'][0]['experimentCase']['results'][0]['evaluatorId'] is not None,True)

    def test_missing_trace_source_classifier_result_cannot_be_manually_scored_without_a_real_trace(self):
        from services.storage.experiments import ExperimentStore
        _,intent=self.supplemental_ready(with_trace=False);self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-missing-retry')
        with self.control.read_transaction() as con:slot=con.execute("SELECT result_id FROM experiment_result_slots WHERE evaluator_id='judge'").fetchone()[0]
        with self.assertRaises(Conflict):ExperimentStore(self.control).dispatch('retry',self.token,'w',{'experiment_id':'bexp','result_id':slot,'operation_key':'no-synthetic-trace'})

    def test_cancel_seals_running_native_evaluate_work_and_requires_exact_cleanup_proof(self):
        from services.storage.experiments import ExperimentStore
        _,intent=self.supplemental_ready();continued=self.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='continue-native-cancel');store=ExperimentStore(self.control,self.evidence);handle=store.dispatch('claim',self.token,'w',{'experiment_id':'bexp','run_id':continued['run_id'],'worker_id':'native-judge'})
        record=self.invoke('cancel_request',experiment_id='bexp',mode='cancel',operation_key='cancel-native')['cancellation'];targets=json.loads(record['targetsJson']);self.assertEqual(len(targets),1);target=targets[0];self.assertEqual(target['kind'],'native-evaluate');self.assertEqual(target['attempt_id'],handle['attempt_id']);self.assertEqual(target['actor_principal_id'],'alice')
        proof={key:target[key] for key in ('workspace_id','experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')};proof.update(transport='native-worker',cleanup='confirmed')
        with self.assertRaises(Conflict):self.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=record['id'],expected_revision=record['revision'],target_id=target['jobId'],proof=proof|{'fence':'999'},operation_key='bad-native-proof')
        done=self.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=record['id'],expected_revision=record['revision'],target_id=target['jobId'],proof=proof,operation_key='native-cleanup');self.assertEqual(done['status'],'completed')
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM benchmark_operation_receipts WHERE operation_kind='cleanup-confirmed-native'").fetchone()[0],1)

    def test_case_retry_requires_real_cleanup_and_creates_new_agent_identity_with_frozen_inputs(self):
        handle,_=self.normalized_evaluation()
        with self.control.read_transaction() as con:execute=dict(con.execute("SELECT * FROM benchmark_jobs WHERE kind='execute'").fetchone());old_receipts=[dict(row) for row in con.execute('SELECT * FROM result_receipts')]
        prepared=self.invoke('prepare_case_retry',experiment_id='bexp',case_id=handle['case_id']);body={'experiment_id':'bexp','case_id':handle['case_id'],'previous_job_id':execute['job_id'],'expected_machine_result_id':prepared['expected_machine_result_id'],'operation_key':'case-retry'};new=self.invoke('retry_case',**body);self.assertNotEqual(new['runId'],execute['job_id']);self.assertNotEqual(new['runplanId'],execute['run_id']);self.assertEqual(self.invoke('retry_case',**body),new)
        with self.control.read_transaction() as con:
            row=dict(con.execute('SELECT * FROM benchmark_jobs WHERE job_id=?',(new['runId'],)).fetchone());self.assertEqual(row['retry_of_job_id'],execute['job_id']);self.assertEqual(row['attempt_no'],2);self.assertEqual([dict(row) for row in con.execute('SELECT * FROM result_receipts')],old_receipts);oldplan=self.service().experiments._plan(con,'w','bexp',execute['run_id'])[1];newplan=self.service().experiments._plan(con,'w','bexp',new['runplanId'])[1];self.assertEqual(newplan['releases'],oldplan['releases']);self.assertEqual(newplan['config']['model_selection'],oldplan['config']['model_selection'])
        with self.assertRaises(Conflict):self.invoke('retry_case',**(body|{'operation_key':'concurrent-case-loser'}))

    def test_unknown_cancelled_execution_blocks_both_case_retry_and_new_start_until_cleanup(self):
        claim,_=self.seal();self.invoke('cancel_request',experiment_id='bexp',mode='cancel',operation_key='cancel-unknown')
        with self.assertRaises(Conflict):self.invoke('prepare_case_retry',experiment_id='bexp',case_id=claim['case_id'])
        with self.assertRaises(Conflict):self.invoke('start',experiment_id='bexp',public_callback_origin='http://localhost:3000',executor_callback_origin='http://localhost:3000',operation_key='start-cannot-bypass-cleanup')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],1)

    def test_pending_execution_preparation_recovers_without_an_external_request_and_fences_expired_pure_preparation(self):
        started=self.start();first=self.invoke('claim_intents',worker_id='preparation-one',limit=1)[0];self.assertEqual(first['event_type'],'benchmark.execution.prepare.requested.v1');self.assertIsNone(first['work']['request']);old=first['work']['handle'];self.now=old['lease_until_ms']+1
        second=self.invoke('claim_intents',worker_id='preparation-two',limit=1)[0];self.assertEqual(second['job']['job_id'],started['runId']);self.assertNotEqual(second['work']['handle']['attempt_id'],old['attempt_id']);self.assertGreater(int(second['work']['handle']['fence']),int(old['fence']))
        request={'runId':started['runId'],'requestDigest':'sha256:'+'c'*64,'clientId':'client','timeoutSeconds':30,'callbackBaseUrl':'http://localhost:3000/api/benchmark/v1/runs/'+started['runId'],'task':{}}
        with self.assertRaises(Conflict):self.invoke('checkpoint',**old,request=request,operation_key='stale-preparation')
        self.invoke('checkpoint',**second['work']['handle'],request=request,operation_key='recovered-preparation')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='benchmark.execution.prepare.requested.v1'").fetchone()[0],'sent');self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox_events WHERE event_type='benchmark.dispatch.requested.v1' AND state='pending'").fetchone()[0],1)

    def test_unknown_cancelled_agent_keeps_its_concurrency_slot_until_exact_cleanup_receipt(self):
        from unittest.mock import patch
        data=self.dataset();second=json.loads(json.dumps(data['cases'][0]));second.update(id='dc2',externalCaseId='external2',ordinal=1);data['cases'].append(second);data['public_dataset']['cases'].append(data['public_dataset']['cases'][0]|{'id':'dc2'})
        with patch.object(self,'dataset',return_value=data):claim,_=self.seal()
        other=next(row for row in self.invoke('list_jobs',experiment_id='bexp') if row['job_id']!=claim['job_id']);record=self.invoke('cancel_request',experiment_id='bexp',mode='case_remove',case_id=claim['case_id'],operation_key='remove-one')['cancellation']
        self.assertIsNone(self.invoke('claim',job_id=other['job_id'],worker_id='must-wait-cleanup'))
        target=json.loads(record['targetsJson'])[0];bound=self.invoke('cancel_dispatch_bind',experiment_id='bexp',cancellation_id=record['id'],expected_revision=record['revision'],target_id=claim['job_id'],command_id='cmd_clean',previous_command_id=None,operation_key='bind-clean');proof={'transport':'device-command','command_id':'cmd_clean','client_id':'client','legacy_owner':'alice','kind':'benchmark','run_id':claim['job_id'],'request_digest':target['requestDigest'],'command_status':'SUCCEEDED','result':{'runId':claim['job_id'],'status':'cancelled'}};self.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=record['id'],expected_revision=bound['revision'],target_id=claim['job_id'],proof=proof,operation_key='clear-slot')
        self.assertIsNotNone(self.invoke('claim',job_id=other['job_id'],worker_id='confirmed-next'))

    def test_case_retry_budget_blocked_new_run_preparation_recovers_without_old_run_callback(self):
        from unittest.mock import patch
        data=self.dataset();second=json.loads(json.dumps(data['cases'][0]));second.update(id='dc2',externalCaseId='external2',ordinal=1);data['cases'].append(second);data['public_dataset']['cases'].append(data['public_dataset']['cases'][0]|{'id':'dc2'})
        with patch.object(self,'dataset',return_value=data):handle,_=self.normalized_evaluation()
        second=next(row for row in self.invoke('list_jobs',experiment_id='bexp') if row['kind']=='execute' and row['case_id']!=handle['case_id'])
        other=self.invoke('claim',job_id=second['job_id'],worker_id='other-case');request={'runId':other['job_id'],'requestDigest':'sha256:'+'b'*64,'clientId':'client','timeoutSeconds':30,'callbackBaseUrl':'http://localhost:3000/api/benchmark/v1/runs/'+other['job_id'],'task':{}}
        self.invoke('checkpoint',**other,request=request,operation_key='seal-other');self.invoke('dispatch_checkpoint',**other,state='accepted',operation_key='accept-other');capability=self.invoke('load_dispatch',**other)['request']['callbackHeaders']['x-agent-insight-callback-token']
        prepared=self.invoke('prepare_case_retry',experiment_id='bexp',case_id=handle['case_id']);new=self.invoke('retry_case',experiment_id='bexp',case_id=handle['case_id'],**{key:prepared[key] for key in ('previous_job_id','expected_machine_result_id')},operation_key='budget-case-retry')
        self.assertNotEqual(new['runplanId'],other['run_id']);self.assertIsNone(self.invoke('claim',job_id=new['runId'],worker_id='blocked-new-run'));self.assertEqual(self.invoke('claim_intents',worker_id='still-full',limit=10),[])
        self.service().callback('execution_complete',capability,{'job_id':other['job_id'],'completion':{'kind':'execution','status':'failed','artifacts':[],'runFacts':{},'cleanup':{'status':'succeeded'}}},verified_device_client_id='client')
        intents=self.invoke('claim_intents',worker_id='independent-background',limit=10);recovered=next(intent for intent in intents if intent['event_type']=='benchmark.execution.prepare.requested.v1');self.assertEqual(recovered['job']['job_id'],new['runId']);self.assertEqual(recovered['work']['handle']['run_id'],new['runplanId']);self.assertIsNone(recovered['work']['request'])

    def test_sealed_unknown_dispatch_expiry_never_reclaims_a_new_external_preparation_attempt(self):
        handle,_=self.seal();self.invoke('dispatch_checkpoint',**handle,state='unknown',operation_key='unknown-before-expiry');self.now=handle['lease_until_ms']+1
        self.assertEqual(self.invoke('claim_intents',worker_id='after-expiry',limit=10),[])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM work_attempts WHERE work_item_id=?',(handle['work_item_id'],)).fetchone()[0],1);self.assertEqual(con.execute('SELECT protocol_state FROM benchmark_jobs WHERE job_id=?',(handle['job_id'],)).fetchone()[0],'dispatch_unknown')

    def test_unknown_cancelled_harness_keeps_workspace_evaluation_budget_until_exact_cleanup(self):
        from unittest.mock import patch
        data=self.dataset();second=json.loads(json.dumps(data['cases'][0]));second.update(id='dc2',externalCaseId='external2',ordinal=1);data['cases'].append(second);data['public_dataset']['cases'].append(data['public_dataset']['cases'][0]|{'id':'dc2'})
        with patch.object(self,'dataset',return_value=data):self.create()
        def bounded_start():return self.invoke('start',experiment_id='bexp',public_callback_origin='http://localhost:3000',executor_callback_origin='http://localhost:3000',scheduler_limits={'maxPendingEvaluations':1,'maxPendingEvaluationsPerUser':1},operation_key='bounded-start')
        with patch.object(self,'start',side_effect=bounded_start),patch.object(self,'dataset',return_value=data):handle,_,_=self.evaluation()
        other=next(row for row in self.invoke('list_jobs',experiment_id='bexp') if row['kind']=='execute' and row['case_id']!=handle['case_id']);record=self.invoke('cancel_request',experiment_id='bexp',mode='case_remove',case_id=handle['case_id'],operation_key='remove-harness')['cancellation']
        self.assertIsNone(self.invoke('claim',job_id=other['job_id'],worker_id='harness-budget-full'))
        target=next(value for value in json.loads(record['targetsJson']) if value['kind']=='evaluation');proof={'transport':'evaluator-http','base_url':target['baseUrl'],'run_id':target['runId'],'request_digest':target['requestDigest'],'http_status':202,'result':{'runId':target['runId'],'status':'cancelled'}};self.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=record['id'],expected_revision=record['revision'],target_id=target['jobId'],proof=proof,operation_key='confirm-harness-cleanup')
        self.assertIsNotNone(self.invoke('claim',job_id=other['job_id'],worker_id='harness-budget-released'))
