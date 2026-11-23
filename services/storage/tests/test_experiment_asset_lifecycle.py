import unittest
from unittest.mock import patch

from services.storage.tests import test_experiments as fixture,test_datasets as dataset_fixture
from services.storage.datasets import DatasetStore
from services.storage.iam import Forbidden
from services.storage.control import Conflict


class ExperimentAssetLifecycleTests(unittest.TestCase):
    make_control=fixture.ExperimentTests.make_control
    setUp=fixture.ExperimentTests.setUp
    def prepare(self,with_evaluator=False):
        self.datasets=DatasetStore(self.control);self.dataset=self.datasets.save(self.bob,'w',dataset_fixture.record(),operation_key='source')
        with self.control.read_transaction() as con:self.asset=con.execute('SELECT asset_id FROM dataset_compat_heads').fetchone()[0]
        self.iam.share_resource(self.bob,'w','asset',self.asset,'alice');self.store=fixture.ExperimentTests.service(self)
        self.call('create',experiment=fixture.experiment(),operation_key='create')
        releases={'dataset':self.dataset['release_id']}
        if with_evaluator:
            self.control.create_identity('w','shared-judge','evaluator','shared-judge');self.control.publish_release('w','shared-judge','judge-v1','1',{'prompt':'frozen'},publisher_id='bob')
            with self.control.transaction() as con:self.iam._record_resource(con,'w','asset','shared-judge','bob','private')
            self.iam.share_resource(self.bob,'w','asset','shared-judge','alice');releases['evaluator:judge']='judge-v1'
        self.call('start',experiment_id='exp',frozen_evaluators={'judge':{'id':'judge'}},releases=releases,operation_key='start')
    def call(self,action,**body):return self.store.dispatch(action,self.token,'w',body)
    def revoke(self):self.iam.unshare_resource(self.bob,'w','asset',self.asset,'alice')
    def claim(self):return self.call('claim',experiment_id='exp',worker_id='worker')
    def test_asset_revoke_blocks_private_reads_and_claim_but_list_keeps_metadata(self):
        self.prepare();self.revoke()
        for action in ('read','read_view','runplan'):
            with self.subTest(action=action),self.assertRaises(Forbidden):self.call(action,experiment_id='exp')
        with self.assertRaises(Forbidden):self.claim()
        self.assertEqual(self.call('list_view')['snapshots'][0]['experiment']['id'],'exp')
    def test_active_renew_checks_small_asset_vector_without_parsing_runplan(self):
        self.prepare();handle=fixture.ExperimentTests.handle(self.claim())
        with patch.object(self.store,'_plan',side_effect=AssertionError('Renew must not parse full RunPlan')):self.call('renew',**handle)
        self.revoke()
        with patch.object(self.store,'_plan',side_effect=AssertionError('Renew must not parse full RunPlan')),self.assertRaises(Forbidden):self.call('renew',**handle)
        for action,extra in [('load_work',{}),('complete',{'result':{'score':90},'operation_key':'done'})]:
            with self.subTest(action=action),self.assertRaises(Forbidden):self.call(action,**handle,**extra)
    def test_content_advance_keeps_original_sealed_inputs_usable(self):
        self.prepare();updated=dataset_fixture.record(name='new content')
        self.datasets.save(self.bob,'w',updated,operation_key='source-update',expected_revision=self.dataset['revision'])
        self.assertEqual(self.call('read',experiment_id='exp')['experiment']['id'],'exp');self.assertIsNotNone(self.claim())
    def test_deleted_source_blocks_read_and_execution_even_if_iam_grant_remains(self):
        self.prepare();self.datasets.remove(self.bob,'w','dataset',operation_key='delete',expected_revision=self.dataset['revision'])
        with self.assertRaises(Conflict):self.call('read',experiment_id='exp')
        with self.assertRaises(Conflict):self.claim()
    def test_committed_result_replay_checks_live_source_assets(self):
        self.prepare();handle=fixture.ExperimentTests.handle(self.claim());body=handle|{'result':{'score':90},'operation_key':'done'}
        self.call('complete',**body);self.revoke()
        with self.assertRaises(Forbidden):self.call('complete',**body)
    def test_asset_revoke_stops_fact_projection_without_discarding_accepted_receipt(self):
        self.prepare();handle=fixture.ExperimentTests.handle(self.claim());self.call('complete',**handle,result={'score':90},operation_key='done');self.revoke()
        class Sink:
            def __init__(self):self.tables=[]
            def _insert(self,table,rows):self.tables.append(table)
        sink=Sink();self.assertTrue(self.store.project_once(sink,'projection-worker'));self.assertEqual(sink.tables,[])
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT state FROM result_receipts').fetchone()[0],'accepted')
    def test_source_asset_revoked_while_reading_is_rechecked_before_private_response(self):
        self.prepare();handle=fixture.ExperimentTests.handle(self.claim());self.call('complete',**handle,result={'score':90},operation_key='done');original=self.store._load;revoked=False
        def load(*args,**kwargs):
            nonlocal revoked
            result=original(*args,**kwargs)
            if not revoked and isinstance(result,dict) and isinstance(result.get('result'),dict):revoked=True;self.revoke()
            return result
        with patch.object(self.store,'_load',side_effect=load),self.assertRaises(Forbidden):self.call('read',experiment_id='exp')
    def test_missing_optional_vectors_do_not_invalidate_old_builtin_plans(self):
        self.store=fixture.ExperimentTests.service(self);self.call('create',experiment=fixture.experiment(),operation_key='create');self.call('start',experiment_id='exp',frozen_evaluators={'judge':{'id':'judge'}},operation_key='start')
        self.assertIsNotNone(self.claim())

    def test_shared_evaluator_revoke_blocks_the_same_active_fence(self):
        self.prepare(with_evaluator=True);handle=fixture.ExperimentTests.handle(self.claim());self.iam.unshare_resource(self.bob,'w','asset','shared-judge','alice')
        with self.assertRaises(Forbidden):self.call('renew',**handle)
        with self.assertRaises(Forbidden):self.call('read',experiment_id='exp')

    def test_benchmark_gold_uses_only_its_bound_public_dataset_access(self):
        from services.storage.tests.test_benchmark_core import BenchmarkCoreTests
        other=BenchmarkCoreTests();other.setUp();self.addCleanup(other.doCleanups);service=other.service()
        dataset=service.dispatch('dataset_import',other.bob,'w',other.dataset()|{'operation_key':'source'})
        with other.control.read_transaction() as con:asset=con.execute('SELECT public_asset_id FROM benchmark_dataset_heads').fetchone()[0]
        other.iam.share_resource(other.bob,'w','asset',asset,'alice')
        with patch.object(other,'save_dataset',return_value=dataset):other.seal()
        self.assertEqual(service.experiments.dispatch('read',other.token,'w',{'experiment_id':'bexp'})['experiment']['id'],'bexp')
        other.iam.unshare_resource(other.bob,'w','asset',asset,'alice')
        with self.assertRaises(Forbidden):service.experiments.dispatch('read',other.token,'w',{'experiment_id':'bexp'})

    def test_diagnosis_rechecks_original_asset_vector_for_read_claim_and_exact_submit_replay(self):
        from services.storage.tests.test_diagnosis_runs import DiagnosisRunTests
        other=DiagnosisRunTests();other.setUp();self.addCleanup(other.doCleanups)
        data=DatasetStore(other.control).save(other.bob,'w',dataset_fixture.record(),operation_key='source')
        with other.control.read_transaction() as con:asset=con.execute('SELECT asset_id FROM dataset_compat_heads').fetchone()[0]
        other.iam.share_resource(other.bob,'w','asset',asset,'alice');original=other.exp.dispatch
        def dispatch(action,token,ws,body):return original(action,token,ws,body|({'releases':{'dataset':data['release_id']}} if action=='start' else {}))
        with patch.object(other.exp,'dispatch',side_effect=dispatch):other.prepare()
        run=other.submit();other.iam.unshare_resource(other.bob,'w','asset',asset,'alice')
        for action,body in [('read',{'diagnosis_id':run['id']}),('claim',{'diagnosis_id':run['id'],'worker_id':'worker'}),('submit',other.source()|{'request_key':'request','expected_input_hash':run['input_hash']})]:
            with self.subTest(action=action),self.assertRaises(Forbidden):other.call(action,**body)

    def test_derived_issue_history_and_resolution_recheck_original_assets(self):
        from services.storage.tests.test_derived_issue_resolution import DerivedIssueResolutionTests
        other=DerivedIssueResolutionTests();other.setUp();self.addCleanup(other.doCleanups)
        data=DatasetStore(other.control).save(other.bob,'w',dataset_fixture.record(),operation_key='source')
        with other.control.read_transaction() as con:asset=con.execute('SELECT asset_id FROM dataset_compat_heads').fetchone()[0]
        other.iam.share_resource(other.bob,'w','asset',asset,'alice');original=other.call
        def call(action,**body):return original(action,**(body|({'releases':{'dataset':data['release_id']}} if action=='start' else {})))
        with patch.object(other,'call',side_effect=call):other.prepare()
        other.resolve();other.iam.unshare_resource(other.bob,'w','asset',asset,'alice')
        for action,body in [('derived_lookup',{'kind':'issue','id':'issue'}),('derived_detail',{'id':'evaluation'}),('derived_list',{'kind':'issue'})]:
            with self.subTest(action=action),self.assertRaises(Forbidden):other.call(action,**body)
        with self.assertRaises(Forbidden):other.resolve()


if __name__=='__main__':unittest.main()
