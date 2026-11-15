import copy
import json
import unittest
from unittest.mock import patch

from services.storage.tests import test_experiment_source_lifecycle as source_fixture
from services.storage.tests import test_experiments as fixture
from services.storage.iam import Forbidden


class ExperimentListViewTests(unittest.TestCase):
    def setUp(self):
        self.base=source_fixture.ExperimentSourceLifecycleTests();self.base.setUp();self.addCleanup(self.base.doCleanups)
        item=self.base.claim();self.base.call('complete',**self.base.base.handle(item),result={'score':80,'evidence':{'json':{'private':'body'}}},operation_key='done')
        self.base.call('review',experiment_id='exp',result_id=item['result_id'],human_score=0,human_reason='private',operation_key='review')
        self.store=self.base.store

    def call(self,**body):return self.base.call('list_view',**body)

    def test_list_reads_only_required_fields_without_sessions_executions_or_full_snapshot(self):
        original=self.store._plan
        class PrivateSession:
            def __deepcopy__(self,*_):raise AssertionError('Frozen Session must not be copied')
            def __iter__(self):raise AssertionError('Frozen Session must not be traversed')
        def plan(*args,**kwargs):
            row,value=original(*args,**kwargs)
            for evidence in value['frozen_trace_evidence'].values():evidence['session']=PrivateSession()
            return row,value
        with patch.object(self.store,'_snapshot',side_effect=AssertionError('Full snapshot forbidden')),patch.object(self.store,'_plan',side_effect=plan):value=self.call()
        snapshot=value['snapshots'][0];self.assertEqual(snapshot['coverage'],'complete');self.assertNotIn('sessions',snapshot);self.assertNotIn('executions',snapshot)
        case=snapshot['experiment']['cases'][0];self.assertNotIn('input',case);self.assertNotIn('actualOutput',case);self.assertNotIn('referenceOutput',case)
        result=case['results'][0];self.assertEqual(result['score'],80);self.assertEqual(result['humanScore'],0);self.assertNotIn('evidenceJson',result)

    def test_revoked_source_keeps_metadata_does_not_block_legal_experiment_or_detail_gate(self):
        other=fixture.experiment();other['id']='other';other['cases'][0]['id']='other-case';self.base.call('create',experiment=other,operation_key='other')
        self.base.revoke();value=self.call();self.assertEqual({item['experiment']['id'] for item in value['snapshots']},{'exp','other'})
        revoked=next(item for item in value['snapshots'] if item['experiment']['id']=='exp');self.assertEqual(len(revoked['experiment']['cases']),1);self.assertIsNone(revoked['experiment']['cases'][0]['results'][0]['score']);self.assertIsNone(revoked['experiment']['cases'][0]['results'][0]['humanScore'])
        with self.assertRaises(Forbidden):self.base.call('read',experiment_id='exp')

    def test_revoked_source_never_loads_private_case_or_machine_artifacts(self):
        with self.base.control.read_transaction() as con:
            forbidden={con.execute("SELECT payload_hash FROM experiment_cases WHERE experiment_id='exp'").fetchone()[0],con.execute('SELECT content_hash FROM result_receipts').fetchone()[0]}
        self.base.revoke();original=self.store._load
        def load(digest,*args,**kwargs):
            if digest in forbidden:raise AssertionError('Revoked private artifact must not be loaded')
            return original(digest,*args,**kwargs)
        with patch.object(self.store,'_load',side_effect=load):value=self.call()
        self.assertEqual(len(value['snapshots'][0]['experiment']['cases']),1)

    def test_source_revoked_during_postflight_hides_previously_loaded_scores(self):
        original=self.store._load;revoked=False
        def load(*args,**kwargs):
            nonlocal revoked
            value=original(*args,**kwargs)
            if not revoked and isinstance(value,dict) and isinstance(value.get('result'),dict):revoked=True;self.base.revoke()
            return value
        with patch.object(self.store,'_load',side_effect=load):value=self.call()
        self.assertIsNone(value['snapshots'][0]['experiment']['cases'][0]['results'][0]['score'])

    def test_targeted_list_filters_experiment_and_task_before_loading_unrelated_metadata(self):
        self.assertEqual(self.call(experiment_id='unknown')['snapshots'],[])
        self.assertEqual(self.call(task_id='unknown')['snapshots'],[])
        self.assertEqual([value['experiment']['id'] for value in self.call(experiment_id='exp',task_id='a'*32)['snapshots']],['exp'])

    def test_quarantined_selection_is_failed_without_loading_machine_packet_or_review(self):
        with self.base.control.transaction() as con:
            hashes={con.execute('SELECT content_hash FROM result_receipts').fetchone()[0],con.execute("SELECT payload_hash FROM experiment_annotations WHERE kind='review'").fetchone()[0]}
            con.execute("UPDATE result_receipts SET state='quarantined'")
        original=self.store._load
        def load(digest,*args,**kwargs):
            if digest in hashes:raise AssertionError('Quarantined machine/review must not be loaded')
            return original(digest,*args,**kwargs)
        with patch.object(self.store,'_load',side_effect=load):value=self.call()
        result=value['snapshots'][0]['experiment']['cases'][0]['results'][0]
        self.assertEqual(result['status'],'failed');self.assertIsNone(result['score']);self.assertIsNone(result['humanScore']);self.assertEqual(result['errorMessage'],'机器结果暂不可用')
        self.base.revoke();result=self.call()['snapshots'][0]['experiment']['cases'][0]['results'][0];self.assertIsNone(result['errorMessage'])


if __name__=='__main__':unittest.main()
