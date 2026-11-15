import importlib.util
import json
import unittest
from unittest.mock import patch

from services.storage.tests import test_datasets as ds, test_experiments as exp, test_trace_transfer as trace
from services.storage.control import Conflict, StorageError
from services.storage.iam import Forbidden, Unauthorized


class DiagnosisRunTests(unittest.TestCase):
    make_control=ds.DatasetTests.make_control
    def setUp(self):
        ds.DatasetTests.setUp(self)
        from services.storage.observations import ObservationIngest
        from services.storage.trace_metadata import TraceMetadata
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        from services.storage.trace_transfer import LegacyTraceTransfer
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.experiments import ExperimentStore
        self.facts=trace.MemoryFacts();self.ingest=ObservationIngest(self.control,self.facts);self.metadata=TraceMetadata(self.control)
        self.queries=TraceQueries(self.control,self.facts,cursor_secret=b'private-diagnosis-fixture-secret')
        self.authorized=AuthorizedStorage(self.iam,self.facts)
        self.transfer=LegacyTraceTransfer(self.control,self.queries,self.authorized,self.metadata,self.ingest)
        self.evidence=TraceEvidence(self.queries,self.authorized);self.exp=ExperimentStore(self.control,self.evidence)
    drain=trace.TraceTransferTests.drain
    def service(self,**kw):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.diagnosis_runs'),'DiagnosisRun domain must use core authority')
        from services.storage.diagnosis_runs import DiagnosisRuns
        return DiagnosisRuns(self.control,self.exp,self.evidence,frozen_assets_verifier=lambda *_:True,**kw)
    def prepare(self,with_trace=True):
        value=exp.experiment()
        if with_trace:
            source=trace.node();source['execution']['invokedSkills']=[{'name':'skill','version':1}]
            self.transfer.import_bundle(self.token,'w',trace.bundle([source]));self.drain()
            value['cases'][0].update(taskId='task',executionId='root')
        self.exp.dispatch('create',self.token,'w',{'experiment':value,'operation_key':'create'})
        self.exp.dispatch('start',self.token,'w',{'experiment_id':'exp','frozen_evaluators':{'judge':{'id':'judge'}},'operation_key':'start'})
        item=self.exp.dispatch('claim',self.token,'w',{'experiment_id':'exp','worker_id':'fixture'})
        self.exp.dispatch('complete',self.token,'w',exp.ExperimentTests.handle(item)|{'result':{'score':50},'operation_key':'complete'})
        self.result_id=item['result_id']
    def call(self,action,**body):return self.service().dispatch(action,self.token,'w',body)
    def source(self):
        return {'experiment_id':'exp','case_id':'case','result_ids':[self.result_id], 'frozen_skills':[{'id':'skill-id','name':'skill','versions':[{'version':1,'files':{'SKILL.md':'# Frozen'}}]}], 'model_selection':{'modelId':'selected'}}
    def submit(self):
        preview=self.call('preview',**self.source())
        return self.call('submit',**self.source(),request_key='request',expected_input_hash=preview['input_hash'])
    def handle(self,run):
        return {k:run[k] for k in ('diagnosis_id','attempt_id','fence','lease_owner')}
    def test_schema_binding_fk_append_only_and_catalog(self):
        self.service()
        from pathlib import Path
        catalog=json.loads((Path(__file__).resolve().parents[1]/'schema/diagnosis-run-catalog.json').read_text())
        self.assertEqual(catalog['version'],11)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],len(__import__('services.storage.migrations',fromlist=['load_migrations']).load_migrations('sqlite')))
            for table in catalog['tables']:
                columns=[r[0] for r in con.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',(self.control.schema,table['name']))] if hasattr(self.control,'schema') else [r[1] for r in con.execute('PRAGMA table_info('+table['name']+')')]
                self.assertEqual(columns,[c['name'] for c in table['columns']])
        self.prepare();run=self.submit()
        with self.assertRaises(StorageError),self.control.transaction() as con:con.execute("UPDATE diagnosis_runs SET generator='changed'")
        with self.assertRaises(StorageError),self.control.transaction() as con:con.execute('DELETE FROM diagnosis_runs')
    def test_case_without_trace_keeps_original_precondition(self):
        self.prepare(False)
        with self.assertRaises(Conflict):self.call('preview',**self.source())
    def test_unattested_skill_or_model_freeze_is_rejected(self):
        self.prepare()
        from services.storage.diagnosis_runs import DiagnosisRuns
        with self.assertRaises(Forbidden):DiagnosisRuns(self.control,self.exp,self.evidence).dispatch('preview',self.token,'w',self.source()|{'attested':True})
    def test_preview_exact_full_source_and_frozen_skill_not_client_snapshot(self):
        self.prepare();value=self.call('preview',**self.source(),snapshot={'forged':'never'})
        self.assertEqual(value['snapshot']['case']['referenceOutput'],'答案');self.assertEqual(value['snapshot']['skills'][0]['files'],{'SKILL.md':'# Frozen'})
        self.assertEqual(value['snapshot']['interactions'][0]['opaque'],{'扩展':[1,2]});self.assertEqual(len(value['input_hash']),64)
        self.assertNotIn(self.token,json.dumps(value));self.assertNotIn(str(self.control.artifact_directory),json.dumps(value))
    def test_submit_replay_precedes_source_preparation_and_different_input_conflicts(self):
        self.prepare();run=self.submit()
        self.metadata.patch(self.token,'w',self.metadata.resolve(self.token,'w','root','execution')['trace_id'],{'label':'changed'})
        with patch.object(self.evidence,'read',side_effect=AssertionError('committed replay prepares no source')):
            again=self.call('submit',**self.source(),request_key='request',expected_input_hash=run['input_hash'])
        self.assertEqual(again['id'],run['id'])
        with self.assertRaises(Conflict):self.call('submit',**self.source(),request_key='request',expected_input_hash='a'*64)
        self.iam.revoke_credential(self.token)
        with self.assertRaises(Unauthorized):self.call('submit',**self.source(),request_key='request',expected_input_hash=run['input_hash'])

    def test_lookup_submission_replays_exact_source_without_latest_catalog(self):
        self.prepare();run=self.submit();body={'source_kind':'experiment','experiment_id':'exp','case_id':'case','result_ids':[self.result_id],'request_key':'request','expected_input_hash':run['input_hash']}
        service=self.service()
        with patch.object(service,'_prepare',side_effect=AssertionError('latest catalog must not be prepared')):
            value=service.dispatch('lookup_submission',self.token,'w',body)
        self.assertTrue(value['found']);self.assertEqual(value['result']['id'],run['id'])
        self.assertEqual(service.dispatch('lookup_submission',self.token,'w',body|{'request_key':'missing'}),{'found':False})
        with self.assertRaises(Conflict):service.dispatch('lookup_submission',self.token,'w',body|{'expected_input_hash':'a'*64})
        with self.assertRaises(Conflict):service.dispatch('lookup_submission',self.token,'w',body|{'result_ids':['another-result']})
        with self.assertRaises(Conflict):service.dispatch('lookup_submission',self.token,'w',body|{'retry_of_run_id':'another-run'})
        self.assertEqual(service.dispatch('lookup_submission',self.bob,'w',body),{'found':False})
    def test_machine_report_selection_atomic_receipt_and_idempotent_complete(self):
        self.prepare();run=self.submit();claim=self.call('claim',diagnosis_id=run['id'],worker_id='worker')
        loaded=self.call('load_work',**self.handle(claim));self.assertEqual(loaded['runplan']['config']['model_selection'],{'modelId':'selected'})
        report={'generatedAt':'2026-11-12T00:00:00Z','findings':[{'id':'finding','evidence':'完整'}]}
        done=self.call('complete',**self.handle(claim),operation_key='done',report=report)
        self.assertEqual(done['report'],report);self.assertEqual(done['status'],'done')
        self.assertEqual(self.call('complete',**self.handle(claim),operation_key='done',report=report),done)
        with self.assertRaises(Conflict):self.call('complete',**self.handle(claim),operation_key='done',report={'changed':1})
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_selections WHERE run_id=?',(run['id'],)).fetchone()[0],1)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox_events WHERE event_type='diagnosis.result.accepted.v1'").fetchone()[0],1)
    def test_review_change_or_source_deletion_blocks_finish_and_import(self):
        self.prepare();run=self.submit();claim=self.call('claim',diagnosis_id=run['id'],worker_id='worker')
        self.exp.dispatch('review',self.token,'w',{'experiment_id':'exp','result_id':self.result_id,'human_score':80,'human_reason':'人工核验','operation_key':'review'})
        for action,extra in [('verify_source',{}),('complete',{'operation_key':'done','report':{}})]:
            with self.assertRaises(Conflict):self.call(action,**self.handle(claim),**extra)
    def test_lease_cancel_and_owner_gold(self):
        self.prepare();run=self.submit()
        for token in (self.bob,self.admin):
            if token==self.bob:
                with self.assertRaises(Forbidden):self.service().dispatch('read',token,'w',{'diagnosis_id':run['id']})
            else:self.assertTrue(self.service().dispatch('read',token,'w',{'diagnosis_id':run['id']})['gold_redacted'])
            with self.assertRaises(Forbidden):self.service().dispatch('claim',token,'w',{'diagnosis_id':run['id'],'worker_id':'intruder'})
        one=self.call('claim',diagnosis_id=run['id'],worker_id='worker');self.now+=30001
        two=self.call('claim',diagnosis_id=run['id'],worker_id='new');self.assertGreater(two['fence'],one['fence'])
        with self.assertRaises(Conflict):self.call('renew',**self.handle(one))
        self.call('cancel',diagnosis_id=run['id'])
        with self.assertRaises(Conflict):self.call('complete',**self.handle(two),operation_key='late',report={})
    def test_acl_revoked_during_evidence_read_and_budget_fail_closed(self):
        self.prepare();original=self.evidence.read
        def revoked(*args,**kw):
            value=original(*args,**kw);self.iam.revoke_credential(self.token);return value
        with patch.object(self.evidence,'read',side_effect=revoked),self.assertRaises(Unauthorized):self.call('preview',**self.source())
    def test_progress_durable_renew_failure_receipt_and_concurrent_claim(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        self.prepare();run=self.submit();barrier=Barrier(2)
        def claim(worker):barrier.wait();return self.call('claim',diagnosis_id=run['id'],worker_id=worker)
        with ThreadPoolExecutor(max_workers=2) as pool:claims=list(pool.map(claim,['one','two']))
        self.assertEqual(sum(c is not None for c in claims),1);handle=self.handle(next(c for c in claims if c))
        progress={'events':[{'seq':1,'title':'分析中'}]};self.call('renew',**handle,progress=progress)
        self.assertEqual(self.call('read',diagnosis_id=run['id'])['progress'],progress)
        done=self.call('fail',**handle,operation_key='fail',error_message='后台失败',progress=progress)
        self.assertEqual(done['status'],'failed');self.assertEqual(done['errorMessage'],'后台失败')
    def test_source_postflight_mutation_deletion_and_report_budget(self):
        self.prepare();original=self.evidence.read
        def mutated(*args,**kw):
            value=original(*args,**kw);self.exp.dispatch('case_upsert',self.token,'w',{'experiment_id':'exp','case':{'id':'case','referenceOutput':'changed'},'operation_key':'mutation'});return value
        with patch.object(self.evidence,'read',side_effect=mutated),self.assertRaises(Conflict):self.call('preview',**self.source())
        run=self.submit();claim=self.call('claim',diagnosis_id=run['id'],worker_id='w')
        from services.storage.trace_evidence import EvidenceTooLarge
        with patch('services.storage.diagnosis_runs.MAX_BYTES',100),self.assertRaises(EvidenceTooLarge):self.call('complete',**self.handle(claim),operation_key='large',report={'body':'a'*1000})
        self.metadata.delete(self.token,'w',self.metadata.resolve(self.token,'w','root','execution')['trace_id'])
        with self.assertRaises(Conflict):self.call('verify_source',diagnosis_id=run['id'])
    def test_diagnosis_judge_trace_actor_fenced_and_immutable(self):
        self.prepare();run=self.submit();claim=self.call('claim',diagnosis_id=run['id'],worker_id='worker');handle=self.handle(claim);service=self.service()
        self.assertEqual(service.authorize_recording(self.token,'w',handle)['owner_principal_id'],'alice')
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('w','diagnosis-private-trace','judge','native','2026-11-14',0,0)")
            self.iam._record_resource(con,'w','trace','diagnosis-private-trace','alice','private',invalidate_policy=False)
            service.register_judge_trace_tx(con,self.token,'w',handle,'diagnosis-private-trace');service.register_judge_trace_tx(con,self.token,'w',handle,'diagnosis-private-trace')
        self.call('cancel',diagnosis_id=run['id'])
        with self.assertRaises(Conflict):service.authorize_recording(self.token,'w',handle)
    def test_trace_report_freeze_and_revalidation_do_not_rerun_model(self):
        self.prepare()
        from services.storage.trace_reports import TraceReports
        self.reports=TraceReports(self.queries,self.authorized);evidence=self.evidence.read(self.token,'w',execution_id='root')
        reserved=self.reports.begin(self.token,'w','root','agent-debug',expected_snapshot_hash=evidence['snapshot_hash'],interactions_hash='a'*64,generator='agent-debug@fixture')
        payload={'generatedAt':'2026-11-12T00:00:00Z','findings':[{'id':'finding'}]}
        self.reports.update(self.token,'w',reserved['row']['id'],1,reserved['leaseToken'],status='done',payload=payload)
        service=self.service(trace_reports=self.reports)
        body={k:v for k,v in self.source().items() if k not in {'experiment_id','case_id','result_ids'}}|{'source_kind':'trace-report','execution_id':'root','generated_at':payload['generatedAt']}
        preview=service.dispatch('preview',self.token,'w',body)
        run=service.dispatch('submit',self.token,'w',body|{'request_key':'frozen-report','expected_input_hash':preview['input_hash']})
        self.assertEqual(run['status'],'done');self.assertEqual(run['report'],payload)
        self.assertTrue(service.dispatch('verify_source',self.token,'w',{'diagnosis_id':run['id']})['valid'])
        self.reports.delete(self.token,'w','root')
        with self.assertRaises(Conflict):service.dispatch('verify_source',self.token,'w',{'diagnosis_id':run['id']})
    def test_terminal_write_failure_rolls_back_selection_and_run(self):
        self.prepare();run=self.submit();claim=self.call('claim',diagnosis_id=run['id'],worker_id='w');service=self.service()
        with patch.object(service,'_append_progress',side_effect=RuntimeError('injected atomic failure')),self.assertRaises(RuntimeError):service.dispatch('complete',self.token,'w',self.handle(claim)|{'operation_key':'done','report':{}})
        saved=self.call('read',diagnosis_id=run['id']);self.assertEqual(saved['status'],'running');self.assertIsNone(saved['report'])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts WHERE run_id=?',(run['id'],)).fetchone()[0],0)
    def test_trace_report_freeze_is_one_atomic_core_commit(self):
        self.prepare()
        from services.storage.trace_reports import TraceReports
        reports=TraceReports(self.queries,self.authorized);evidence=self.evidence.read(self.token,'w',execution_id='root')
        reserved=reports.begin(self.token,'w','root','agent-debug',expected_snapshot_hash=evidence['snapshot_hash'],interactions_hash='a'*64,generator='agent-debug@fixture')
        payload={'generatedAt':'2026-11-12T00:00:00Z','findings':[{'id':'finding'}]}
        reports.update(self.token,'w',reserved['row']['id'],1,reserved['leaseToken'],status='done',payload=payload)
        service=self.service(trace_reports=reports);body={k:v for k,v in self.source().items() if k not in {'experiment_id','case_id','result_ids'}}|{'source_kind':'trace-report','execution_id':'root','generated_at':payload['generatedAt']}
        preview=service.dispatch('preview',self.token,'w',body)
        with patch.object(service,'_append_progress',side_effect=RuntimeError('injected freeze failure')),self.assertRaises(RuntimeError):service.dispatch('submit',self.token,'w',body|{'request_key':'atomic-freeze','expected_input_hash':preview['input_hash']})
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM diagnosis_runs WHERE request_key='atomic-freeze'").fetchone()[0],0)
    def test_source_runplan_model_identity_is_selected_receipt_plan(self):
        self.prepare();run=self.submit();self.assertTrue(run['source_model_selection_consistent']);self.assertIsNone(run['source_model_selection'])
        with self.control.read_transaction() as con:source=con.execute('SELECT plan_hash FROM runs WHERE run_id=?',(run['source_runplans'][0]['run_id'],)).fetchone()
        self.assertEqual(run['source_runplans'][0]['plan_hash'],source['plan_hash'])
        verified=self.call('verify_source',diagnosis_id=run['id']);self.assertEqual(verified['source_runplans'],run['source_runplans'])
    def test_unrelated_case_reconcile_and_publication_ack_do_not_expire_source(self):
        self.prepare();run=self.submit()
        self.exp.dispatch('reconcile',self.token,'w',{'experiment_id':'exp','operation_key':'settle'})
        self.exp.dispatch('case_upsert',self.token,'w',{'experiment_id':'exp','case':{'id':'unrelated','input':'separate'},'operation_key':'unrelated-case'})
        with self.control.transaction() as con:con.execute("UPDATE result_receipts SET state='published' WHERE run_id<>?",(run['id'],))
        self.assertTrue(self.call('verify_source',diagnosis_id=run['id'])['valid'])
    def test_abandoned_lease_is_visible_failed_and_retry_lineage_is_actor_bound(self):
        self.prepare();run=self.submit();self.call('claim',diagnosis_id=run['id'],worker_id='abandoned');self.now+=30001
        expired=self.call('read',diagnosis_id=run['id']);self.assertEqual(expired['status'],'failed');self.assertTrue(expired['errorMessage'])
        preview=self.call('preview',**self.source());retried=self.call('submit',**self.source(),request_key='retry',expected_input_hash=preview['input_hash'],retry_of_run_id=run['id'])
        self.assertEqual(retried['retryOfRunId'],run['id'])
        with self.assertRaises(LookupError):self.call('submit',**self.source(),request_key='forged-retry',expected_input_hash=preview['input_hash'],retry_of_run_id='absent')
    def test_list_filters_before_limit_and_orders_newest_first(self):
        self.prepare();preview=self.call('preview',**self.source());runs=[]
        for i in range(6):
            self.now+=1000;runs.append(self.call('submit',**self.source(),request_key='list-'+str(i),expected_input_hash=preview['input_hash']))
        self.assertEqual(self.call('list',experiment_id='exp',case_id='case',limit=1)[0]['id'],runs[-1]['id'])
        self.assertEqual(self.call('list',experiment_id='absent',limit=1),[])
    def test_write_read_credential_without_execute_cannot_claim(self):
        self.prepare();run=self.submit();token=self.iam.issue_api_credential(self.token,'w',{'read','write'})
        with self.assertRaises(Forbidden):self.service().dispatch('claim',token,'w',{'diagnosis_id':run['id'],'worker_id':'not-execute'})
    def test_large_fence_survives_decimal_transport_without_float_coercion(self):
        self.prepare();run=self.submit()
        with self.control.transaction() as con:con.execute('UPDATE work_items SET etag=? WHERE workspace_id=? AND run_id=?',(2**53+11,'w',run['id']))
        claim=self.call('claim',diagnosis_id=run['id'],worker_id='w');self.assertEqual(claim['fence'],str(2**53+12))
        self.assertEqual(self.call('renew',**self.handle(claim))['fence'],claim['fence'])
        with self.assertRaises(ValueError):self.call('renew',**(self.handle(claim)|{'fence':float(claim['fence'])}))
    def test_submit_expected_hash_binds_machine_provenance_even_with_identical_values(self):
        self.prepare();preview=self.call('preview',**self.source())
        self.exp.dispatch('retry',self.token,'w',{'experiment_id':'exp','result_id':self.result_id,'operation_key':'retry-same-values'})
        item=self.exp.dispatch('claim',self.token,'w',{'experiment_id':'exp','worker_id':'second'})
        self.exp.dispatch('complete',self.token,'w',exp.ExperimentTests.handle(item)|{'result':{'score':50},'operation_key':'same-values'})
        with self.assertRaises(Conflict):self.call('submit',**self.source(),request_key='stale-preview',expected_input_hash=preview['input_hash'])
    def test_unrelated_case_plan_artifact_is_outside_diagnosis_source(self):
        self.prepare();run=self.submit()
        self.exp.dispatch('case_upsert',self.token,'w',{'experiment_id':'exp','case':{'id':'other','input':'other'},'operation_key':'other'})
        started=self.exp.dispatch('start',self.token,'w',{'experiment_id':'exp','case_ids':['other'],'frozen_evaluators':{'judge':{'id':'judge'}},'operation_key':'other-plan'})
        with self.control.read_transaction() as con:path=con.execute('SELECT plan_manifest_ref FROM runs WHERE run_id=?',(started['run_id'],)).fetchone()[0]
        from pathlib import Path
        Path(path).write_bytes(b'corrupted unrelated plan')
        self.assertTrue(self.call('verify_source',diagnosis_id=run['id'])['valid'])
    def test_source_runplan_response_is_deduplicated_descriptor_without_gold_duplication(self):
        self.prepare();run=self.submit();descriptor=run['source_runplans'][0]
        self.assertNotIn('plan',descriptor);self.assertEqual(set(descriptor),{'run_id','plan_hash','inputs','model_selection'})
