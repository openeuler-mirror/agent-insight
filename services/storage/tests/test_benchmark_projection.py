import json
import unittest
from unittest.mock import patch
from services.storage.benchmark_core import BenchmarkStore
from services.storage.tests import test_benchmark_core as fixture

class BenchmarkSupplementalCleanupTests(unittest.TestCase):
    def test_unconfirmed_native_process_cannot_be_replaced_by_supplemental_retry(self):
        from services.storage.experiments import ExperimentStore
        from services.storage.iam import Conflict
        base=fixture.BenchmarkCoreTests();base.setUp();self.addCleanup(base.doCleanups)
        _,intent=base.supplemental_ready(evaluators=['judge'])
        continued=base.invoke('finish_intent',**intent['handle'],operation='prepare_continuation',operation_key='cleanup-continuation')
        store=ExperimentStore(base.control,base.evidence)
        handle=store.dispatch('claim',base.token,'w',{'experiment_id':'bexp','run_id':continued['run_id'],'worker_id':'uncertain-native'})
        store.dispatch('fail',base.token,'w',handle|{'error':{'code':'EVALUATION_CLEANUP_UNCONFIRMED','message':'process remains'},'operation_key':'uncertain-failure'})
        request={'experiment_id':'bexp','result_id':handle['result_id'],'operation_key':'manual-replacement'}
        with self.assertRaises(Conflict):store.dispatch('retry',base.token,'w',request)
        cancelled=base.invoke('cancel_request',experiment_id='bexp',mode='cancel',operation_key='native-stop')['cancellation']
        with self.assertRaises(Conflict):store.dispatch('retry',base.token,'w',request)
        target=next(row for row in json.loads(cancelled['targetsJson']) if row['kind']=='native-evaluate')
        proof={key:target[key] for key in ('workspace_id','experiment_id','attempt_id','work_item_id','run_id','fence','lease_owner','actor_principal_id')}
        proof.update(transport='native-worker',cleanup='confirmed')
        base.invoke('cleanup_confirm',experiment_id='bexp',cancellation_id=cancelled['id'],expected_revision=cancelled['revision'],target_id=target['jobId'],proof=proof,operation_key='native-stopped')
        retried=store.dispatch('retry',base.token,'w',request)
        self.assertIsNotNone(store.dispatch('claim',base.token,'w',{'experiment_id':'bexp','run_id':retried['current_run_id'],'worker_id':'replacement'}))

class BenchmarkFailureProjectionTests(unittest.TestCase):
    def setUp(self):
        self.base=fixture.BenchmarkCoreTests();self.base.setUp();self.addCleanup(self.base.doCleanups)
        self.control=self.base.control
        claim,_=self.base.seal();cap=self.base.invoke('load_dispatch',**claim)['request']['callbackHeaders']['x-agent-insight-callback-token']
        self.base.service().callback('execution_complete',cap,{'job_id':claim['job_id'],'completion':{'kind':'execution','status':'failed','artifacts':[],'runFacts':{},'cleanup':{'status':'succeeded'}}},verified_device_client_id='client')
        self.base.classify_pending_failure()
        from services.storage.experiments import ExperimentStore
        self.store=ExperimentStore(self.control)

    def project(self):
        class Sink:
            def __init__(self):self.rows={}
            def _insert(self,table,rows):self.rows.setdefault(table,[]).extend(rows)
        sink=Sink();self.assertTrue(self.store.project_once(sink,'projection-worker'));return sink

    def test_real_failure_classifier_publishes_without_a_zero_score_or_harness_execution(self):
        sink=self.project();self.assertEqual(len(sink.rows['eval_publication_members']),1)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'published')
        self.assertFalse(any(row.get('metric_key')=='score' and row.get('value_float')==0 for row in sink.rows.get('eval_metric_facts',[])))

    def test_generic_cleanup_cannot_replace_typed_benchmark_cleanup_receipts(self):
        from services.storage.experiments import ExperimentStore,ExperimentUnavailable
        cancelled=self.base.invoke('cancel_request',experiment_id='bexp',mode='cancel',operation_key='typed-cancel')['cancellation']
        with self.assertRaises(ExperimentUnavailable):
            ExperimentStore(self.control,cancellation_verifier=lambda *_:True).dispatch('cancellation_update',self.base.token,'w',{'experiment_id':'bexp','cancellation_id':cancelled['id'],'expected_revision':cancelled['revision'],'targets':[],'status':'completed','operation_key':'generic-cleanup'})

    def test_cancellation_route_metadata_supports_delete_only_benchmark_authority(self):
        from services.storage.experiments import ExperimentStore
        key=self.base.iam.issue_api_credential(self.base.token,'w',['delete'])
        self.assertEqual(ExperimentStore(self.control).dispatch('cancellation_route',key,'w',{'experiment_id':'bexp','mode':'remove'}),{'kind':'benchmark'})

    def test_a_misbound_failure_job_cannot_project_any_fact(self):
        original=BenchmarkStore._failure_source
        def mismatched(instance,*args):
            job,packet=original(instance,*args);return job|{'case_id':'another-case'},packet
        with patch.object(BenchmarkStore,'_failure_source',mismatched):sink=self.project()
        self.assertEqual(sink.rows,{})

    def test_classifier_provenance_is_checked_instead_of_a_success_callback_fence(self):
        original=self.store._load
        def wrong_phase(digest,ref,*args):
            value=original(digest,ref,*args)
            if value.get('phase')=='benchmark:classification':return value|{'phase':'evaluate'}
            return value
        with patch.object(self.store,'_load',wrong_phase):sink=self.project()
        self.assertEqual(sink.rows,{})
