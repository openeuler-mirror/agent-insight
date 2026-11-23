import json
import unittest
from unittest.mock import patch
from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_trace_analytics as fixtures
from services.storage.tests import test_trace_transfer as transfer


class RasReadTests(unittest.TestCase):
    setUp=fixtures.AnalyticsGroupAuthorizationTests.setUp
    make_control=fixtures.TraceAnalyticsTests.make_control
    drain=fixtures.TraceAnalyticsTests.drain
    service=fixtures.TraceAnalyticsTests.service
    prepare_source=fixtures.TraceAnalyticsTests.prepare_source

    def event(self,identity,task='no-trace'):
        return {'id':identity,'type':'anomaly','taskId':task,'deliveryId':identity,'framework':'opencode','platform':'opencode','anomalyKind':'timeout','severity':'high','summary':'real event','actionTypes':None,'payloadJson':'{}','ts':'2026-11-12T00:00:00Z'}

    def read(self,token=None,tasks=None):
        service=self.service();self.assertTrue(callable(getattr(service,'ras_read',None)),'authorized RAS read source is required')
        return service.ras_read(token or self.token,'w',tasks)

    def test_standalone_events_are_readable_only_in_real_owner_or_admin_scope(self):
        self.service().ras_ingest(self.token,'w',[self.event('alice-event')]);self.service().ras_ingest(self.bob,'w',[self.event('bob-event')])
        self.assertEqual([row['id'] for row in self.read()['events']],['alice-event'])
        self.assertEqual({row['id'] for row in self.read(self.admin)['events']},{'alice-event','bob-event'})
        self.assertEqual(self.read(self.viewer)['events'],[])

    def test_shared_trace_events_follow_revocation_and_real_owner_task_pairs(self):
        source=transfer.bundle([transfer.node('bob-root','bob-task',root='bob-root')]);source['rootExecutionId']='bob-root';self.transfer.import_bundle(self.bob,'w',source);self.drain()
        trace=self.metadata.resolve(self.bob,'w','bob-task')['trace_id'];service=self.service();service.ras_ingest(self.bob,'w',[self.event('bob-event','bob-task')])
        self.assertEqual(self.read()['events'],[])
        self.iam.share_resource(self.bob,'w','trace',trace,'alice');first=self.read();self.assertEqual(first['events'][0]['id'],'bob-event')
        self.iam.unshare_resource(self.bob,'w','trace',trace,'alice')
        with self.assertRaises((Forbidden,Conflict)):service.validate_ras_read(self.token,'w',first['read_token'])
        self.assertEqual(self.read()['events'],[])

    def test_event_revision_and_fact_hash_are_verified_without_trace_body_reads(self):
        service=self.service();service.ras_ingest(self.token,'w',[self.event('event')]);first=self.read()
        service.ras_ingest(self.token,'w',[self.event('event')|{'summary':'updated'}])
        with self.assertRaises(Conflict):service.validate_ras_read(self.token,'w',first['read_token'])
        row=self.read()['events'][0];self.assertEqual(row['summary'],'updated');self.assertEqual(row['user'],'alice')

    def test_task_filter_and_read_only_capability_remain_exact(self):
        service=self.service();service.ras_ingest(self.token,'w',[self.event('a','one'),self.event('b','two')])
        token=self.iam.issue_api_credential(self.token,'w',['read'])
        self.assertEqual([row['id'] for row in self.read(token,['one'])['events']],['a'])
        with self.assertRaises(ValueError):service.ras_read(token,'w',['one']*501)

    def test_event_before_trace_links_later_without_losing_receipt_or_accepting_old_token(self):
        service=self.service();service.ras_ingest(self.token,'w',[self.event('event','task')]);before=self.read(tasks=['task'])
        self.assertIsNone(before['events'][0]['executionId']);self.assertIsNone(before['execution_ids']['task'])
        self.transfer.import_bundle(self.token,'w',transfer.bundle());self.drain()
        current=self.read(tasks=['task']);self.assertEqual(current['events'][0]['executionId'],'root');self.assertEqual(current['execution_ids']['task'],'root')
        with self.assertRaises(Conflict):service.validate_ras_read(self.token,'w',before['read_token'])

    def test_corrupt_ras_fact_is_not_an_empty_success(self):
        from services.storage.trace_analytics import AnalyticsUnavailable
        self.service().ras_ingest(self.token,'w',[self.event('event')])
        for row in self.facts.ras.values():row['event_json']='{}'
        with self.assertRaises(AnalyticsUnavailable):self.read()

    def test_group_admin_cannot_read_other_owners_private_judge_events(self):
        trace=self.prepare_source();service=self.service()
        from services.storage.experiments import ExperimentStore
        from services.storage.tests.test_experiments import experiment,ExperimentTests
        experiments=ExperimentStore(self.control);experiments.dispatch('create',self.token,'w',{'experiment':experiment(),'operation_key':'create'})
        experiments.dispatch('start',self.token,'w',{'experiment_id':'exp','operation_key':'start','frozen_evaluators':{'judge':{'id':'judge'}}})
        handle=experiments.dispatch('claim',self.token,'w',{'experiment_id':'exp','worker_id':'worker'})
        with self.control.transaction() as con:experiments.register_judge_trace_tx(con,self.token,'w',ExperimentTests.handle(handle),trace)
        service.ras_ingest(self.token,'w',[self.event('private','task')])
        self.assertEqual(self.read(self.admin)['events'],[]);self.assertEqual(self.read(self.admin,['task'])['execution_ids']['task'],None)
        self.assertEqual(self.read()['events'][0]['id'],'private')

    def test_direct_task_scope_binds_the_visible_trace_owner(self):
        self.transfer.import_bundle(self.token,'w',transfer.bundle());self.drain();service=self.service()
        service.ras_ingest(self.token,'w',[self.event('alice','task')]);service.ras_ingest(self.bob,'w',[self.event('bob','task')])
        value=self.read(self.admin,['task']);self.assertEqual([row['id'] for row in value['events']],['alice'])
        self.assertEqual({row['id'] for row in self.read(self.admin)['events']},{'alice','bob'})

    def test_child_task_keeps_events_but_does_not_claim_root_execution_identity(self):
        source=transfer.bundle([transfer.node(),transfer.node('child','child-task','root')]);self.transfer.import_bundle(self.token,'w',source);self.drain()
        self.assertIsNone(self.read(tasks=['child-task'])['execution_ids']['child-task'])
        self.service().ras_ingest(self.token,'w',[self.event('child','child-task')]);row=self.read(tasks=['child-task'])['events'][0];self.assertIsNone(row['executionId'])

    def test_small_event_page_does_not_depend_on_total_history_size(self):
        import services.storage.trace_analytics as module
        service=self.service();service.ras_ingest(self.token,'w',[self.event('one'),self.event('two'),self.event('three')])
        with patch.object(module,'MAX_RAS_EVENTS',2):
            self.assertEqual(len(service.ras_read(self.token,'w',selection={'limit':1})['events']),1)

    def test_metadata_projection_does_not_return_or_budget_unselected_payload_fields(self):
        import services.storage.trace_analytics as module
        service=self.service();service.ras_ingest(self.token,'w',[self.event('event')|{'payloadJson':'x'*800}])
        with patch.object(module,'MAX_PAGE_BYTES',600):
            value=service.ras_read(self.token,'w',selection={'limit':1,'view':'metadata'})
        self.assertEqual(set(value['events'][0]),{'taskId','platform','framework','ts','user'})
        self.assertEqual(value['events'][0]['taskId'],'no-trace')
        self.assertEqual(value['events'][0]['user'],'alice')

    def test_child_identity_survives_lossy_compact_projection(self):
        child=transfer.node('child','child-task','root')
        for key in ('query','label','model','observedIp'):child['execution'][key]='x'*495
        for key in ('query','label'):child['session'][key]='x'*495
        self.transfer.import_bundle(self.token,'w',transfer.bundle([transfer.node(),child]));self.drain()
        self.assertIsNone(self.read(tasks=['child-task'])['execution_ids']['child-task'])

    def test_satisfied_type_page_does_not_scan_older_history_for_unneeded_lookahead(self):
        import services.storage.trace_analytics as module
        service=self.service();service.ras_ingest(self.token,'w',[self.event('z-anomaly'),self.event('y-actions')|{'type':'actions'},self.event('x-actions')|{'type':'actions'}])
        with patch.object(module,'MAX_RAS_SCAN',2):page=service.ras_read(self.token,'w',selection={'limit':1,'types':['anomaly']})
        self.assertEqual([row['id'] for row in page['events']],['z-anomaly'])

    def test_recent_task_selection_accepts_more_than_500_distinct_tasks(self):
        service=self.service();rows=[self.event('event-'+str(index),'task-'+str(index)) for index in range(501)]
        for start in range(0,len(rows),400):service.ras_ingest(self.token,'w',rows[start:start+400])
        page=service.ras_read(self.token,'w',[row['taskId'] for row in rows],{'limit':501})
        self.assertEqual(len(page['events']),501)

    def test_long_task_selection_can_validate_its_issued_read_token(self):
        service=self.service();tasks=['x'*495+str(index) for index in range(501)]
        value=service.ras_read(self.token,'w',tasks,{'limit':0})
        self.assertGreater(len(value['read_token']),256*1024)
        self.assertEqual(service.validate_ras_read(self.token,'w',value['read_token'])['scope_fingerprint'],value['scope_fingerprint'])

    def test_fact_read_cannot_return_success_after_the_shared_deadline(self):
        service=self.service();service.ras_ingest(self.token,'w',[self.event('event')]);clock=[0.0];original=self.facts.read_ras_events
        def slow(*args):
            rows=original(*args);clock[0]=61.0;return rows
        from services.storage.trace_analytics import AnalyticsTooLarge
        with patch('time.monotonic',side_effect=lambda:clock[0]),patch.object(self.facts,'read_ras_events',side_effect=slow):
            with self.assertRaises(AnalyticsTooLarge):service.ras_read(self.token,'w',selection={'limit':1})

    def test_ascending_event_window_keeps_the_original_oldest_200(self):
        service=self.service();rows=[self.event('event-'+str(index).zfill(3)) for index in range(240)]
        service.ras_ingest(self.token,'w',rows)
        page=service.ras_read(self.token,'w',['no-trace'],{'limit':200,'order':'asc'})
        self.assertEqual([row['id'] for row in page['events']],[row['id'] for row in rows[:200]])
        self.assertEqual(service.validate_ras_read(self.token,'w',page['read_token'])['scope_fingerprint'],page['scope_fingerprint'])

    def test_targeted_ras_read_token_binds_execution_annotations(self):
        self.transfer.import_bundle(self.token,'w',transfer.bundle());self.drain();service=self.service()
        page=service.ras_read(self.token,'w',['task'],{'limit':200,'order':'asc'})
        trace=self.metadata.resolve(self.token,'w','task')['trace_id'];self.metadata.patch(self.token,'w',trace,{'final_result':'edited'})
        with self.assertRaises(Conflict):service.validate_ras_read(self.token,'w',page['read_token'])

    def test_trace_selection_can_skip_unrequested_ras_payloads(self):
        self.transfer.import_bundle(self.token,'w',transfer.bundle());self.drain();trace=self.metadata.resolve(self.token,'w','task')['trace_id'];service=self.service()
        prepared=service.prepare(self.token,'w',trace);service.publish(self.token,'w',trace,prepared['boundary'],fixtures.TraceAnalyticsTests.projection(prepared))
        service.ras_ingest(self.token,'w',[self.event('event','task')])
        with patch.object(self.facts,'read_ras_events',side_effect=AssertionError('Unrequested RAS payloads were read')):
            page=service.read(self.token,'w',include_ras=False)
        self.assertEqual(len(page['items']),1);self.assertEqual(page['ras_events'],[]);self.assertIsNone(page['ras_read_token'])

    def test_type_filtered_first_page_reads_past_unrelated_history_without_returning_it(self):
        import services.storage.trace_analytics as module
        service=self.service();rows=[self.event('z'+str(index))|{'type':'actions','payloadJson':'x'*800} for index in range(3)]
        rows.append(self.event('a-anomaly'));service.ras_ingest(self.token,'w',rows)
        with patch.object(module,'MAX_RAS_EVENTS',2),patch.object(module,'MAX_PAGE_BYTES',600):
            page=service.ras_read(self.token,'w',selection={'limit':1,'types':['anomaly']})
        self.assertEqual([row['id'] for row in page['events']],['a-anomaly'])
