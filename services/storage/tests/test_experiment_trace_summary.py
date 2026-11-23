import unittest
from services.storage.tests import test_trace_transfer as fixture
node=fixture.node
bundle=fixture.bundle
from services.storage.compatibility_list import LegacyTraceList

class ExperimentTraceSummaryTests(unittest.TestCase):
    setUp=fixture.TraceTransferTests.setUp
    drain=fixture.TraceTransferTests.drain
    def test_original_execution_scalars_survive_summary_without_loading_full_trace(self):
        source=node();source['execution'].update(cost=0.125,latency=2.75,toolCallCount=11,toolCallErrorCount=2,isAnswerCorrect=False,failures='[{"type":"original"}]')
        self.transfer.import_bundle(self.token,'w',bundle([source]));self.drain()
        self.authorized.read_payload=lambda *a,**kw:(_ for _ in ()).throw(AssertionError('summary never expands Span payload'))
        row=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{})[0]
        self.assertEqual((row['cost'],row['latency'],row['tool_call_count'],row['tool_call_error_count'],row['is_answer_correct'],row['has_failures']),(0.125,2.75,11,2,False,True))
    def test_unknown_original_metrics_remain_null_instead_of_invented_success_or_zero(self):
        source=node();source['execution']['isAnswerCorrect']=None
        self.transfer.import_bundle(self.token,'w',bundle([source]));self.drain()
        row=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{})[0]
        self.assertIsNone(row['is_answer_correct']);self.assertIsNone(row['latency']);self.assertIsNone(row['tool_call_count'])

    def test_watch_summary_preserves_captured_session_start_and_explicit_unfinished_end(self):
        source=node();source['session']['startTime']='2026-11-12T00:00:01Z';source['session']['endTime']=None
        self.transfer.import_bundle(self.token,'w',bundle([source]));self.drain()
        row=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{})[0]
        self.assertEqual(row['trace_started_at'],'2026-11-12T00:00:01Z');self.assertIsNone(row['trace_completed_at'])
