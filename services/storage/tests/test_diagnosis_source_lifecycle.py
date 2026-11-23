import unittest
from unittest.mock import patch

from services.storage.control import Conflict
from services.storage.iam import Forbidden, Unauthorized
from services.storage.tests import test_diagnosis_runs as fixture


class DiagnosisSourceLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.base=fixture.DiagnosisRunTests();self.base.setUp();self.addCleanup(self.base.doCleanups)
        self.base.prepare();self.run=self.base.submit()

    def delete_source(self):
        trace=self.base.metadata.resolve(self.base.token,'w','root','execution')['trace_id']
        self.base.metadata.delete(self.base.token,'w',trace)

    def test_deleted_source_blocks_private_read_and_submit_receipt_replay(self):
        self.delete_source()
        with self.assertRaises(Conflict):self.base.call('read',diagnosis_id=self.run['id'])
        with self.assertRaises(Conflict):self.base.call('submit',**self.base.source(),request_key='request',expected_input_hash=self.run['input_hash'])
        with self.assertRaises(Conflict):self.base.call('lookup_submission',source_kind='experiment',experiment_id='exp',case_id='case',result_ids=[self.base.result_id],request_key='request',expected_input_hash=self.run['input_hash'])

    def test_metadata_list_does_not_return_source_body_or_fail_on_deleted_source(self):
        self.delete_source();rows=self.base.call('list')
        self.assertEqual(rows[0]['id'],self.run['id']);self.assertIsNone(rows[0].get('snapshot'));self.assertIsNone(rows[0].get('report'));self.assertIsNone(rows[0].get('progress'))
        self.base.iam.revoke_credential(self.base.token)
        with self.assertRaises(Unauthorized):self.base.call('list')

    def test_source_content_update_does_not_hide_legal_frozen_history(self):
        before=self.base.call('read',diagnosis_id=self.run['id'])
        trace=self.base.metadata.resolve(self.base.token,'w','root','execution')['trace_id']
        self.base.metadata.patch(self.base.token,'w',trace,{'label':'new current label'})
        after=self.base.call('read',diagnosis_id=self.run['id']);self.assertEqual(after['snapshot'],before['snapshot'])
        receipt=self.base.call('lookup_submission',source_kind='experiment',experiment_id='exp',case_id='case',result_ids=[self.base.result_id],request_key='request',expected_input_hash=self.run['input_hash'])
        self.assertEqual(receipt['result']['snapshot'],before['snapshot'])

    def test_source_deleted_during_private_read_fails_postflight(self):
        service=self.base.service();original=service._view_tx
        def view(*args,**kwargs):
            result=original(*args,**kwargs);self.delete_source();return result
        with patch.object(service,'_view_tx',side_effect=view),self.assertRaises(Conflict):service.dispatch('read',self.base.token,'w',{'diagnosis_id':self.run['id']})

    def test_deleted_source_still_allows_cancellation_without_returning_private_snapshot(self):
        self.delete_source();cancelled=self.base.call('cancel',diagnosis_id=self.run['id'])
        self.assertEqual(cancelled['status'],'cancelled');self.assertIsNone(cancelled.get('snapshot'))

    def test_admin_metadata_does_not_read_private_plan_before_owner_gate(self):
        service=self.base.service()
        with patch.object(service,'_plan',side_effect=AssertionError('Administrator cannot parse private source')):
            row=service.dispatch('read',self.base.admin,'w',{'diagnosis_id':self.run['id']})
        self.assertTrue(row['gold_redacted']);self.assertIsNone(row['snapshot'])

    def test_shared_trace_revocation_blocks_diagnosis_owner_without_hiding_metadata_list(self):
        from services.storage.tests import test_experiment_source_lifecycle as source_fixture
        from services.storage.diagnosis_runs import DiagnosisRuns
        source=source_fixture.ExperimentSourceLifecycleTests();source.setUp();self.addCleanup(source.doCleanups)
        item=source.claim();source.call('complete',**source.base.handle(item),result={'score':80},operation_key='done')
        service=DiagnosisRuns(source.control,source.store,frozen_assets_verifier=lambda *_:True)
        request={'experiment_id':'exp','case_id':'case','result_ids':[item['result_id']],'frozen_skills':[],'model_selection':None}
        preview=service.dispatch('preview',source.base.token,'w',request)
        run=service.dispatch('submit',source.base.token,'w',request|{'request_key':'diagnosis','expected_input_hash':preview['input_hash']});source.revoke()
        with self.assertRaises(Forbidden):service.dispatch('read',source.base.token,'w',{'diagnosis_id':run['id']})
        rows=service.dispatch('list',source.base.token,'w',{});self.assertEqual(rows[0]['id'],run['id']);self.assertIsNone(rows[0]['snapshot'])


if __name__=='__main__':unittest.main()
