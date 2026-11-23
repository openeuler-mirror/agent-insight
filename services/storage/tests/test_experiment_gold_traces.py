import unittest
from services.storage.tests import test_experiments as fixture
from services.storage.iam import Forbidden

class ExperimentGoldTraceTests(unittest.TestCase):
    make_control=fixture.ExperimentTests.make_control
    setUp=fixture.ExperimentTests.setUp
    service=fixture.ExperimentTests.service
    call=fixture.ExperimentTests.call
    create=fixture.ExperimentTests.create
    start=fixture.ExperimentTests.start
    claim=fixture.ExperimentTests.claim
    handle=staticmethod(fixture.ExperimentTests.handle)

    def gold_trace(self):
        self.create();self.start();claimed=self.claim();now=self.control.clock()
        with self.control.transaction() as con:
            con.execute('INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)',('w','gold-trace','test','1'*32,'2026-11-12',now,now))
            self.iam._record_resource(con,'w','trace','gold-trace','alice','group')
            self.service().register_judge_trace_tx(con,self.token,'w',self.handle(claimed),'gold-trace')
        return claimed

    def test_judge_gold_trace_owner_reads_but_group_admin_and_shared_member_cannot(self):
        self.gold_trace();self.iam.authorize(self.token,'w','read','trace','gold-trace')
        for token in (self.admin,self.bob):
            with self.subTest(token_owner='admin' if token==self.admin else 'member'),self.assertRaises(Forbidden):self.iam.authorize(token,'w','read','trace','gold-trace')

    def test_trace_candidate_selection_filters_other_actors_gold_before_fact_reads(self):
        from services.storage.trace_service import TraceQueries
        self.gold_trace();queries=TraceQueries(self.control,None,cursor_secret=b'isolated-private-test-cursor')
        self.assertEqual([row['trace_id'] for row in queries._candidates(self.token,'w',None,10)[1]],['gold-trace'])
        self.assertEqual(queries._candidates(self.admin,'w',None,10)[1],[])

    def test_workspace_aggregation_excludes_other_actors_gold_trace(self):
        from services.storage.authorized import AuthorizedStorage
        self.gold_trace();authorized=AuthorizedStorage(self.iam,None)
        _,excluded=authorized._summary_scope(self.admin,['w'],'2026-11-12','2026-11-13',None)
        self.assertEqual(excluded,{'w':['gold-trace']})
        self.assertEqual(authorized.list_resources(self.admin,'w','trace')['items'],[])

    def test_original_agent_recorder_registers_gold_route_in_the_creation_transaction(self):
        from services.storage.agent_traces import AgentTraceRecorder
        from services.storage.observations import ObservationIngest
        from services.storage.tests.test_agent_traces import snapshot
        self.create();self.start();claimed=self.claim();payload=snapshot(task='actual-judge-session')
        payload['context']={'experiment_id':'exp','experiment_attempt_id':claimed['attempt_id'],'experiment_fence':claimed['fence'],'experiment_lease_owner':claimed['lease_owner']}
        recorder=AgentTraceRecorder(self.control,ObservationIngest(self.control,None));receipt=recorder.record(self.token,'w',payload)
        with self.control.read_transaction() as con:
            row=con.execute('SELECT * FROM experiment_judge_traces WHERE workspace_id=? AND trace_id=?',('w',receipt['trace_id'])).fetchone()
            self.assertIsNotNone(row);self.assertEqual(row['attempt_id'],claimed['attempt_id'])
        with self.assertRaises(Forbidden):self.iam.authorize(self.admin,'w','read','trace',receipt['trace_id'])

    def test_local_business_execution_trace_uses_execute_fence_without_judge_gold_restriction(self):
        from services.storage.agent_traces import AgentTraceRecorder
        from services.storage.observations import ObservationIngest
        from services.storage.tests.test_agent_traces import snapshot
        self.create();self.call('execute_start',experiment_id='exp',execution_request={'kind':'local'},frozen_evaluators={'judge':{'id':'judge'}},operation_key='local-start')
        item=self.call('claim',experiment_id='exp',phase='execute',worker_id='local')
        value=snapshot(task='local-business-session');value['context']={'experiment_id':'exp','experiment_attempt_id':item['attempt_id'],'experiment_fence':item['fence'],'experiment_lease_owner':item['lease_owner'],'experiment_recording_kind':'execution'}
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        facts=MemoryFacts();ingest=ObservationIngest(self.control,facts)
        receipt=AgentTraceRecorder(self.control,ingest).record(self.token,'w',value)
        while ingest.work_once('worker'):pass
        evidence=TraceEvidence(TraceQueries(self.control,facts,cursor_secret=b'local-business-evidence-secret'),AuthorizedStorage(self.iam,facts)).read(self.token,'w',task_id='local-business-session')
        self.assertIs(evidence['execution']['isSubagent'],False);self.assertEqual(evidence['execution']['agentOwnership'],'user');self.assertEqual(evidence['execution']['sourceKind'],'experiment')
        self.iam.authorize(self.admin,'w','read','trace',receipt['trace_id'])
        with self.control.read_transaction() as con:self.assertIsNone(con.execute('SELECT 1 FROM experiment_judge_traces WHERE trace_id=?',(receipt['trace_id'],)).fetchone())

    def test_judge_attempt_cannot_downgrade_its_trace_to_a_public_execution(self):
        from services.storage.agent_traces import AgentTraceRecorder
        from services.storage.observations import ObservationIngest
        from services.storage.tests.test_agent_traces import snapshot
        self.create();self.start();item=self.claim();value=snapshot(task='do-not-expose-gold');value['context']={'experiment_id':'exp','experiment_attempt_id':item['attempt_id'],'experiment_fence':item['fence'],'experiment_lease_owner':item['lease_owner'],'experiment_recording_kind':'execution'}
        with self.assertRaises(Forbidden):AgentTraceRecorder(self.control,ObservationIngest(self.control,None)).record(self.token,'w',value)
