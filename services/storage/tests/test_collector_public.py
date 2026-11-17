import json
import unittest
from services.storage.tests.test_collector_graphs import CollectorGraphTests
from services.storage.iam import Forbidden

class CollectorPublicTests(unittest.TestCase):
    def setUp(self):
        self.graph=CollectorGraphTests('runTest');self.graph.setUp();self.addCleanup(self.graph.doCleanups)
        self.prep=self.graph.prep;self.fixture=self.graph.fixture;self.control=self.graph.control;self.api=self.graph.api
    def service(self):
        from services.storage.collector_public import CollectorPublic
        return CollectorPublic(self.control,self.graph.ingest)
    def test_original_session_json_and_headless_completion_are_readable_with_read_only_capability(self):
        entry=self.prep.plan(self.prep.capture(self.prep.begin()));self.prep.commit(entry);self.fixture.drain()
        key=self.fixture.iam.issue_api_credential(self.fixture.tokens['alice'],'w',['read'],ttl_ms=86400000)
        value=self.service().session(key,'w','task')
        self.assertTrue(value['collector']);self.assertEqual(json.loads(value['session_json']),self.fixture.snapshot()['session'] | {'user':'legacy-alice'})
        self.assertNotIn('spanId',json.loads(value['session_json'])['interactions'][0]);self.assertFalse(value['can_write'])
        writer=self.fixture.iam.issue_api_credential(self.fixture.tokens['alice'],'w',['read','write'],ttl_ms=86400000)
        writable=self.service().session(writer,'w','task');self.assertTrue(writable['can_write']);self.assertFalse(writable['can_execute'])
        empty=self.prep.capture(self.prep.begin('empty',operation='complete',task='empty',execution='empty',completion_at_ms=self.fixture.now))
        session={'taskId':'empty','label':'opencode','query':None,'user':'legacy-alice','model':None,'startTime':'2026-11-17T00:00:00.000Z','endTime':'2026-11-17T00:00:00.000Z','interactions':[]}
        plan={'binding':json.loads(empty['capture_json'])['binding'],'snapshot':None,'session':session,'children':[],'thread':None,'serialized_session_json':json.dumps(session)}
        empty=self.prep.service().seal_plan(self.api,'w',{**self.graph.ref(empty),'capture_hash':empty['capture_hash'],'plan_json':json.dumps(plan)})
        self.prep.commit(empty);value=self.service().session(key,'w','empty');self.assertEqual(json.loads(value['session_json']),session);self.assertIsNone(value['execution'])
    def test_source_reader_current_scope_and_owner_are_not_body_user(self):
        entry=self.prep.plan(self.prep.capture(self.prep.begin()));self.prep.commit(entry);self.fixture.drain()
        bob=self.fixture.iam.issue_api_credential(self.fixture.tokens['bob'],'w',['read'],ttl_ms=86400000)
        with self.assertRaises(Forbidden):self.service().session(bob,'w','task')
        admin=self.fixture.iam.issue_api_credential(self.fixture.tokens['admin'],'w',['read'],ttl_ms=86400000)
        value=self.service().session(admin,'w','task');self.assertEqual(json.loads(value['session_json'])['user'],'legacy-alice');self.assertFalse(value['can_write'])
    def test_root_delete_cancels_uncommitted_derived_reservations_without_resurrection(self):
        child=self.graph.child();entry=self.graph.graph_capture(self.prep.begin(),[child]);self.fixture.metadata.delete(self.fixture.token,'w',entry['scope_key'])
        body=self.fixture.body('independent',task='child',execution='execution__sub__child',raw={'independent':True})
        result=self.prep.service().begin_preparation(self.api,'w',{'reservation':body,'operation_request_json':json.dumps(body.pop('operation_request'))})
        self.assertEqual(result['reservation']['operation_key'],'independent')
        with self.assertRaises(Exception):self.graph.graph_plan(entry,[child])

class CollectorMutationTests(CollectorPublicTests):
    def test_proxy_session_append_is_atomic_idempotent_and_has_no_fake_execution(self):
        service=self.service();base={'operation_key':'proxy-start','task_id':'proxy','legacy_username':'legacy-alice','mode':'create','changes':{'label':'proxy label','query':'q','model':'m'}}
        first=service.mutate_session(self.api,'w',base);self.assertEqual(first['state'],'indexed');self.assertIsNone(self.service().session(self.fixture.token,'w','proxy')['execution'])
        append={'operation_key':'proxy-append','task_id':'proxy','legacy_username':'legacy-alice','mode':'append','changes':{'interaction':{'requestMessages':[{'role':'user','content':'raw'}],'responseMessage':{'role':'assistant','content':'answer'},'timestamp':0,'opaque':None}}}
        service.mutate_session(self.api,'w',append);service.mutate_session(self.api,'w',append)
        value=json.loads(service.session(self.fixture.token,'w','proxy')['session_json']);self.assertEqual(len(value['interactions']),1);self.assertEqual(value['interactions'][0]['timestamp'],0);self.assertEqual(value['startTime'],first['session']['startTime'])
    def test_analysis_intent_is_durable_and_publication_is_fenced_by_source_and_manual_annotation(self):
        entry=self.prep.plan(self.prep.capture(self.prep.begin()));plan=json.loads(entry['plan_json'])
        # A separate receipt seals the public handler intent, rather than modifying a sealed plan.
        entry=self.prep.capture(self.prep.begin('public',task='public',execution='public',raw={'public':True}));snapshot=self.fixture.snapshot();snapshot['execution'].update(id='public',taskId='public',user='legacy-alice',clientId=None);snapshot['session'].update(taskId='public',user='legacy-alice')
        plan={'binding':json.loads(entry['capture_json'])['binding'],'snapshot':snapshot,'children':[],'thread':None,'serialized_session_json':json.dumps(snapshot['session']),'collector_entry':{'analysis_requested':True,'debounce_ms':0}}
        entry=self.prep.service().seal_plan(self.api,'w',{**self.graph.ref(entry),'capture_hash':entry['capture_hash'],'plan_json':json.dumps(plan)});self.prep.commit(entry);self.fixture.drain()
        executor=self.fixture.iam.issue_api_credential(self.fixture.tokens['alice'],'w',['read','write','execute'],ttl_ms=86400000);jobs=self.service().jobs(executor,'w','claim',{'worker_id':'worker'});self.assertEqual(len(jobs),1);job=jobs[0]
        self.service().jobs(executor,'w','check',job['handle'])
        self.fixture.metadata.patch(self.fixture.token,'w',entry['scope_key'],{'query':'manual'})
        with self.assertRaises(Exception):self.service().jobs(executor,'w','check',job['handle'])

class CollectorLogReceiptTests(unittest.TestCase):
    setUp=CollectorPublicTests.setUp
    service=CollectorPublicTests.service
    def test_authenticated_log_cursor_requires_matching_actual_indexed_receipt(self):
        service=self.service();packet={'raw_json':'{"resourceLogs":[]}','groups':[{'channel':'claude','session_id':'client-session','events':[{'sessionId':'client-session','eventName':'prompt'}]}],'legacy_username':'legacy-alice'}
        first=service.logs(self.api,'w','accept',packet)
        self.assertEqual(service.logs(self.api,'w','accept',packet),first)
        work=service.logs(self.api,'w','claim',{'worker_id':'worker'})[0]
        entry=self.prep.plan(self.prep.capture(self.prep.begin(raw={'data':{'task_id':'task'},'source_proof':work['source_proof']})))
        self.prep.commit(entry)
        ack={**work['handle'],'disposition':'indexed','receipt':self.graph.ref(entry)}
        with self.assertRaises(Exception):service.logs(self.api,'w','ack',ack)
        self.fixture.drain();self.assertTrue(service.logs(self.api,'w','ack',ack)['acknowledged'])
        self.assertEqual(service.logs(self.api,'w','claim',{'worker_id':'worker'}),[])
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT COUNT(*) FROM inbox_receipts WHERE source_id='collector.logs.packet.v1'").fetchone()[0],1)
    def test_unrelated_receipt_and_foreign_actor_cannot_ack_authenticated_logs(self):
        service=self.service();service.logs(self.api,'w','accept',{'raw_json':'{}','groups':[{'channel':'traces','session_id':'s','events':[]}],'legacy_username':'legacy-alice'})
        work=service.logs(self.api,'w','claim',{'worker_id':'worker'})[0]
        entry=self.prep.plan(self.prep.capture(self.prep.begin()));self.prep.commit(entry);self.fixture.drain()
        with self.assertRaises(Exception):service.logs(self.api,'w','ack',{**work['handle'],'disposition':'indexed','receipt':self.graph.ref(entry)})
        bob=self.fixture.iam.issue_api_credential(self.fixture.tokens['bob'],'w',['write'],ttl_ms=86400000)
        self.assertEqual(service.logs(bob,'w','claim',{'worker_id':'foreign'}),[])
        with self.assertRaises(Forbidden):service.logs(bob,'w','renew',work['handle'])
        service.logs(self.api,'w','retry',work['handle'])
    def test_proxy_analysis_intent_needs_execute_and_keeps_first_session_input(self):
        service=self.service();service.mutate_session(self.api,'w',{'operation_key':'start','task_id':'proxy','legacy_username':'legacy-alice','mode':'create','changes':{'query':'original'}})
        request={'task_id':'proxy','operation_key':'end','body':{},'model_selection':None}
        with self.assertRaises(Forbidden):service.jobs(self.api,'w','enqueue_proxy',request)
        executor=self.fixture.iam.issue_api_credential(self.fixture.tokens['alice'],'w',['read','write','execute'],ttl_ms=86400000)
        work=service.jobs(executor,'w','enqueue_proxy',request);self.assertEqual(service.jobs(executor,'w','enqueue_proxy',request),work)
        job=service.jobs(executor,'w','claim',{'worker_id':'worker'})[0]
        self.assertEqual(job['plan']['session']['query'],'original')
        service.jobs(executor,'w','finish',{**job['handle'],'response':{'status':200,'body':{'status':'ok'}}})
        self.assertEqual(service.jobs(executor,'w','result',work)['response']['body'],{'status':'ok'})
