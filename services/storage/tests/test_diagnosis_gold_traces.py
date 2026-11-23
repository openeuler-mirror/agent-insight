import unittest
from services.storage.tests import test_diagnosis_runs as fixture
from services.storage.iam import Forbidden

class DiagnosisGoldTraceTests(unittest.TestCase):
    make_control=fixture.DiagnosisRunTests.make_control
    setUp=fixture.DiagnosisRunTests.setUp
    drain=fixture.DiagnosisRunTests.drain
    service=fixture.DiagnosisRunTests.service
    prepare=fixture.DiagnosisRunTests.prepare
    call=fixture.DiagnosisRunTests.call
    source=fixture.DiagnosisRunTests.source
    submit=fixture.DiagnosisRunTests.submit
    handle=fixture.DiagnosisRunTests.handle

    def test_recorder_atomically_registers_private_diagnosis_trace_and_all_read_paths_hide_gold(self):
        from services.storage.agent_traces import AgentTraceRecorder
        from services.storage.tests.test_agent_traces import snapshot
        self.prepare();run=self.submit();claimed=self.call('claim',diagnosis_id=run['id'],worker_id='judge')
        payload=snapshot(task='actual-diagnosis-judge-session')
        payload['context']={'diagnosis_run_id':run['id'],'diagnosis_attempt_id':claimed['attempt_id'],'diagnosis_fence':claimed['fence'],'diagnosis_lease_owner':claimed['lease_owner']}
        receipt=AgentTraceRecorder(self.control,self.ingest).record(self.token,'w',payload)
        with self.control.read_transaction() as con:
            row=con.execute('SELECT * FROM diagnosis_judge_traces WHERE workspace_id=? AND trace_id=?',('w',receipt['trace_id'])).fetchone()
            self.assertIsNotNone(row);self.assertEqual(row['attempt_id'],claimed['attempt_id'])
        self.iam.authorize(self.token,'w','read','trace',receipt['trace_id'])
        for token in (self.admin,self.bob):
            with self.assertRaises(Forbidden):self.iam.authorize(token,'w','read','trace',receipt['trace_id'])
            self.assertNotIn(receipt['trace_id'],[row['trace_id'] for row in self.queries._candidates(token,'w',None,100)[1]])
            self.assertNotIn(receipt['trace_id'],[row['trace_id'] for row in self.authorized.list_resources(token,'w','trace')['items']])
        with self.control.read_transaction() as con:bucket=con.execute('SELECT trace_bucket FROM trace_locators WHERE workspace_id=? AND trace_id=?',('w',receipt['trace_id'])).fetchone()[0]
        self.assertIn(receipt['trace_id'],self.authorized._summary_scope(self.admin,['w'],bucket,bucket,None)[1]['w'])

    def test_recorder_rejects_mixed_or_partial_diagnosis_handle(self):
        from services.storage.agent_traces import AgentTraceRecorder
        from services.storage.tests.test_agent_traces import snapshot
        recorder=AgentTraceRecorder(self.control,self.ingest)
        for context in ({'diagnosis_run_id':'d'},{'diagnosis_run_id':'d','diagnosis_attempt_id':'a','diagnosis_fence':'2','diagnosis_lease_owner':'w','experiment_id':'e','experiment_attempt_id':'a','experiment_fence':'2','experiment_lease_owner':'w'}):
            payload=snapshot();payload['context']=context
            with self.assertRaises(ValueError):recorder._input(payload)
