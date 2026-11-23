import importlib.util
import json
import unittest
from unittest.mock import patch

from services.storage.tests import test_trace_transfer as fixture
from services.storage.tests.test_trace_transfer import bundle
from services.storage.control import Conflict
from services.storage.iam import Forbidden, Unauthorized


class TraceReportTests(unittest.TestCase):
    setUp = fixture.TraceTransferTests.setUp
    drain = fixture.TraceTransferTests.drain

    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.trace_reports'), 'core reports must persist independently of legacy Prisma')
        from services.storage.trace_reports import TraceReports
        return TraceReports(self.queries, self.authorized)

    def prepared(self):
        self.transfer.import_bundle(self.token, 'w', bundle()); self.drain()
        from services.storage.trace_evidence import TraceEvidence
        return TraceEvidence(self.queries, self.authorized).read(self.token, 'w', execution_id='root')

    def begin(self, service, evidence=None, **options):
        evidence = evidence or self.prepared()
        return service.begin(self.token, 'w', 'root', 'agent-debug', expected_snapshot_hash=evidence['snapshot_hash'],
                             interactions_hash='a'*64, generator='fixture@1', **options)

    def test_real_report_persists_frozen_evidence_and_terminal_payload_across_reopen(self):
        service=self.service();start=self.begin(service,request_key='request')
        self.assertEqual(start['row']['status'],'running');self.assertTrue(start['leaseToken'])
        payload={'stats':{'stepCount':2,'issueCount':1,'llmCallCount':1,'durationMs':120},'findings':[{'opaque':'完整扩展'}]}
        done=service.update(self.token,'w',start['row']['id'],start['row']['revision'],start['leaseToken'],status='done',payload=payload)
        self.assertEqual(done['payload'],payload)
        saved=self.service().read(self.token,'w','task','agent-debug')
        self.assertEqual(saved['payload'],payload);self.assertEqual(saved['row']['stepCount'],2)
        self.assertNotIn(self.token,json.dumps(saved));self.assertNotIn(str(self.control.artifact_directory),json.dumps(saved))
        self.assertNotIn('leaseToken',saved)

    def test_cache_request_receipt_and_busy_are_stable_without_exposing_lease(self):
        service=self.service();evidence=self.prepared();first=self.begin(service,evidence,request_key='same')
        busy=self.begin(service,evidence,request_key='same');self.assertTrue(busy['busy']);self.assertNotIn('leaseToken',busy)
        service.update(self.token,'w',first['row']['id'],first['row']['revision'],first['leaseToken'],status='done',payload={'stats':{}})
        cached=self.begin(service,evidence);self.assertTrue(cached['cached']);self.assertEqual(cached['row']['id'],first['row']['id'])
        with self.assertRaises(Conflict):service.begin(self.token,'w','root','agent-debug',expected_snapshot_hash=evidence['snapshot_hash'],interactions_hash='b'*64,generator='fixture@1',request_key='same')

    def test_force_and_delete_fence_stale_background_updates(self):
        service=self.service();evidence=self.prepared();first=self.begin(service,evidence)
        service.update(self.token,'w',first['row']['id'],1,first['leaseToken'],status='done',payload={'stats':{}})
        second=self.begin(service,evidence,force=True);self.assertNotEqual(first['row']['id'],second['row']['id'])
        with self.assertRaises(Conflict):service.update(self.token,'w',first['row']['id'],2,first['leaseToken'],status='done',payload={'changed':True})
        service.delete(self.token,'w','root')
        with self.assertRaises(Conflict):service.update(self.token,'w',second['row']['id'],1,second['leaseToken'],status='done',payload={'late':True})
        self.assertIsNone(service.read(self.token,'w','root','agent-debug')['row'])

    def test_progress_cas_lease_and_revocation_reject_without_legacy_fallback(self):
        service=self.service();start=self.begin(service);rid=start['row']['id'];lease=start['leaseToken']
        progress={'runId':rid,'events':[{'seq':1,'title':'分析中'}]}
        updated=service.update(self.token,'w',rid,1,lease,progress=progress)
        self.assertEqual(updated['progress'],progress)
        with self.assertRaises(Conflict):service.update(self.token,'w',rid,1,lease,progress=progress)
        with self.assertRaises(Forbidden):service.update(self.token,'w',rid,updated['row']['revision'],'wrong-lease',status='done',payload={})
        self.iam.revoke_credential(self.token)
        with self.assertRaises(Unauthorized):service.update(self.token,'w',rid,updated['row']['revision'],lease,status='done',payload={})

    def test_cross_actor_private_trace_and_wrong_snapshot_are_rejected(self):
        service=self.service();evidence=self.prepared()
        with self.assertRaises(Forbidden):service.read(self.bob,'w','root','agent-debug')
        with self.assertRaises(Forbidden):service.begin(self.bob,'w','root','agent-debug',expected_snapshot_hash=evidence['snapshot_hash'],interactions_hash='a'*64,generator='fixture')
        with self.assertRaises(Conflict):service.begin(self.token,'w','root','agent-debug',expected_snapshot_hash='f'*64,interactions_hash='a'*64,generator='fixture')

    def test_annotation_change_between_evidence_and_begin_transaction_is_rejected(self):
        service=self.service();evidence=self.prepared();original=service.evidence.read
        def changed(*args,**kwargs):
            value=original(*args,**kwargs);self.metadata.patch(self.token,'w',value['manifest']['trace_id'],{'label':'changed'});return value
        with patch.object(service.evidence,'read',side_effect=changed),self.assertRaises(Conflict):self.begin(service,evidence)

    def test_payload_budget_and_artifact_corruption_do_not_return_empty_success(self):
        service=self.service();start=self.begin(service)
        with patch('services.storage.trace_reports.MAX_REPORT_BYTES',64),self.assertRaises(service.too_large):service.update(self.token,'w',start['row']['id'],1,start['leaseToken'],status='done',payload={'text':'大'*100})
        service.update(self.token,'w',start['row']['id'],1,start['leaseToken'],status='done',payload={'text':'完整'})
        with self.control.read_transaction() as con:ref=con.execute('SELECT payload_ref FROM diagnostic_report_runs').fetchone()[0]
        from pathlib import Path
        Path(ref).write_text('corrupt')
        with self.assertRaises(service.unavailable):service.read(self.token,'w','root','agent-debug')

    def test_wrong_lease_is_rejected_before_writing_any_artifact(self):
        service=self.service();start=self.begin(service)
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('unauthorized artifact write')),self.assertRaises(Forbidden):
            service.update(self.token,'w',start['row']['id'],1,'wrong',status='done',payload={'value':'must not be persisted'})

    def test_report_delete_during_begin_or_publish_response_is_not_returned(self):
        service=self.service();evidence=self.prepared();original=service._view
        def deleted(row):
            value=original(row);service.delete(self.token,'w','root');return value
        with patch.object(service,'_view',side_effect=deleted),self.assertRaises(Conflict):self.begin(service,evidence)
        start=self.begin(service,evidence)
        with patch.object(service,'_view',side_effect=deleted),self.assertRaises(Conflict):
            service.update(self.token,'w',start['row']['id'],1,start['leaseToken'],status='done',payload={'stats':{}})

    def test_direct_sql_rejects_half_artifact_pairs(self):
        service=self.service();start=self.begin(service)
        for column in ('payload_hash','progress_hash'):
            with self.subTest(column=column),self.assertRaises(Conflict),self.control.transaction() as con:
                con.execute('UPDATE diagnostic_report_runs SET '+column+'=?,revision=revision+1 WHERE report_id=?',('a'*64,start['row']['id']))

    def test_direct_sql_rejects_wrong_report_kind_head_and_frozen_input_changes(self):
        service=self.service();start=self.begin(service)
        with self.control.read_transaction() as con:trace=con.execute('SELECT trace_id FROM diagnostic_report_runs WHERE report_id=?',(start['row']['id'],)).fetchone()[0]
        with self.assertRaises(Conflict),self.control.transaction() as con:
            con.execute('INSERT INTO diagnostic_report_heads VALUES(?,?,?,?)',('w',trace,'skills-analysis',start['row']['id']))
        with self.assertRaises(Conflict),self.control.transaction() as con:
            con.execute('UPDATE diagnostic_report_runs SET evidence_hash=?,revision=revision+1 WHERE report_id=?',('f'*64,start['row']['id']))

    def test_read_only_credential_cannot_write_evidence_artifacts_when_reserving(self):
        service=self.service();evidence=self.prepared();credential=self.iam.issue_api_credential(self.token,'w',{'read'})
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('write before execute authorization')),self.assertRaises(Forbidden):
            service.begin(credential,'w','root','agent-debug',expected_snapshot_hash=evidence['snapshot_hash'],interactions_hash='a'*64,generator='fixture')

    def test_unknown_reference_authenticates_workspace_before_returning_not_found(self):
        service=self.service();self.prepared()
        with self.assertRaises(Unauthorized):service.read('session_'+'X'*43,'w','unknown','agent-debug')
        with self.assertRaises(Forbidden):service.read(self.token,'wrong-workspace','unknown','agent-debug')

    def test_revocation_during_artifact_failure_takes_precedence_over_data_error(self):
        service=self.service();start=self.begin(service)
        service.update(self.token,'w',start['row']['id'],1,start['leaseToken'],status='done',payload={'stats':{}})
        def failed(*args,**kwargs):
            self.iam.revoke_credential(self.token);raise service.unavailable('artifact broken')
        with patch.object(service,'_load',side_effect=failed),self.assertRaises(Unauthorized):service.read(self.token,'w','root','agent-debug')

    def test_begin_recovers_ambiguous_commit_with_caller_held_secret_and_same_receipt(self):
        service=self.service();evidence=self.prepared();secret='L'*43
        first=self.begin(service,evidence,request_key='begin-operation',lease_token=secret)
        self.metadata.patch(self.token,'w',evidence['manifest']['trace_id'],{'label':'source advanced after commit'})
        with patch.object(service.evidence,'read',side_effect=AssertionError('receipt recovery must use already frozen input')):
            recovered=self.begin(service,evidence,request_key='begin-operation',lease_token=secret)
        self.assertEqual(first['row']['id'],recovered['row']['id']);self.assertEqual(recovered['leaseToken'],secret);self.assertFalse(recovered['busy'])
        other=self.begin(service,evidence,request_key='begin-operation',lease_token='Z'*43)
        self.assertTrue(other['busy']);self.assertNotIn('leaseToken',other)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM diagnostic_report_runs').fetchone()[0],1)

    def test_terminal_update_exact_operation_replays_without_writes_or_mutation(self):
        service=self.service();start=self.begin(service);rid=start['row']['id'];secret=start['leaseToken'];payload={'stats':{},'complete':'final body'}
        saved=service.update(self.token,'w',rid,1,secret,status='done',payload=payload,request_key='publish-operation')
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('duplicate terminal publication wrote again')):
            replay=service.update(self.token,'w',rid,1,secret,status='done',payload=payload,request_key='publish-operation')
        self.assertEqual(saved,replay);self.assertEqual(replay['row']['revision'],2)
        for change in ({'payload':{'different':True},'request_key':'publish-operation'},{'payload':payload,'request_key':'different-operation'}):
            with self.assertRaises(Conflict):service.update(self.token,'w',rid,1,secret,status='done',**change)
        with self.assertRaises(Conflict):service.update(self.token,'w',rid,1,secret,status='failed',request_key='publish-operation')
        self.begin(service,force=True)
        with self.assertRaises(Conflict):service.update(self.token,'w',rid,1,secret,status='done',payload=payload,request_key='publish-operation')

    def test_progress_replay_advances_once_and_private_operation_never_leaks(self):
        service=self.service();start=self.begin(service);rid=start['row']['id'];secret=start['leaseToken'];progress={'runId':rid,'events':[]}
        saved=service.update(self.token,'w',rid,1,secret,progress=progress,request_key='private-progress-operation')
        replay=service.update(self.token,'w',rid,1,secret,progress=progress,request_key='private-progress-operation')
        self.assertEqual(replay,saved);self.assertEqual(replay['row']['revision'],2)
        done=service.update(self.token,'w',rid,2,secret,status='done',payload={},request_key='private-done-operation')
        self.assertEqual(done['row']['revision'],3);self.assertEqual(done['progress'],progress)
        self.assertNotIn('private-progress-operation',json.dumps(done));self.assertNotIn('private-done-operation',json.dumps(done));self.assertNotIn(secret,json.dumps(done))
        with self.assertRaises(Conflict):service.update(self.token,'w',rid,1,secret,progress=progress,request_key='private-progress-operation')

    def test_duplicate_update_committing_during_artifact_io_replays_exactly(self):
        service=self.service();start=self.begin(service);rid=start['row']['id'];secret=start['leaseToken'];payload={'stats':{}}
        original=service._persist;entered=False;inner=None
        def committing(*args,**kwargs):
            nonlocal entered,inner
            value=original(*args,**kwargs)
            if not entered:
                entered=True;inner=service.update(self.token,'w',rid,1,secret,status='done',payload=payload,request_key='same-inflight-operation')
            return value
        with patch.object(service,'_persist',side_effect=committing):
            outer=service.update(self.token,'w',rid,1,secret,status='done',payload=payload,request_key='same-inflight-operation')
        self.assertEqual(inner,outer);self.assertEqual(outer['row']['revision'],2)

    def test_execute_without_workspace_write_cannot_reserve_mandatory_self_trace(self):
        service=self.service();evidence=self.prepared();credential=self.iam.issue_api_credential(self.token,'w',{'read','execute'})
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('write before recording authorization')),self.assertRaises(Forbidden):
            service.begin(credential,'w','root','agent-debug',expected_snapshot_hash=evidence['snapshot_hash'],interactions_hash='a'*64,generator='fixture')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM diagnostic_report_runs').fetchone()[0],0)
