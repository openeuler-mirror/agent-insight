import unittest
from unittest.mock import patch

from services.storage.control import Conflict
from services.storage.experiments import ExperimentStore
from services.storage.trace_evidence import TraceEvidence
from services.storage.compatibility_list import LegacyTraceList
from services.storage.tests import test_trace_analytics as analytics_fixture
from services.storage.tests import test_trace_outcome as outcome_fixture


class OutcomeConsumerTests(unittest.TestCase):
    setUp=analytics_fixture.TraceAnalyticsTests.setUp
    make_control=analytics_fixture.TraceAnalyticsTests.make_control
    drain=analytics_fixture.TraceAnalyticsTests.drain
    service=analytics_fixture.TraceAnalyticsTests.service
    prepare_source=analytics_fixture.TraceAnalyticsTests.prepare_source
    projection=staticmethod(analytics_fixture.TraceAnalyticsTests.projection)
    publish=analytics_fixture.TraceAnalyticsTests.publish
    begin=outcome_fixture.OutcomeTests.begin
    finish=outcome_fixture.OutcomeTests.finish

    def ready(self):
        trace=self.prepare_source();analytics,*_=self.publish(trace)
        outcome=ExperimentStore(self.control,evidence=TraceEvidence(self.queries,self.authorized),frozen_assets_verifier=lambda *_:True)
        run=self.begin(outcome);self.finish(outcome,run)
        return trace,analytics,outcome

    def test_trace_list_and_statistics_read_the_same_real_zero_outcome_without_full_evidence(self):
        trace,analytics,outcome=self.ready()
        with patch.object(TraceEvidence,'read',side_effect=AssertionError('consumer loaded full Trace')),patch.object(ExperimentStore,'_plan',side_effect=AssertionError('consumer loaded RunPlan')):
            page=analytics.read(self.token,'w')
            rows=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{})
        selected=page['outcomes'][trace]
        self.assertEqual(selected['outcome']['value']['answer_score'],0)
        self.assertEqual(rows[0]['answer_score'],0);self.assertFalse(rows[0]['is_answer_correct']);self.assertEqual(rows[0]['judgment_reason'],'actual result')
        self.assertEqual(analytics.validate_outcomes(self.token,'w',[page['outcome_read_token']])['scope_fingerprint'],page['scope_fingerprint'])

    def test_pending_and_cancel_keep_prior_real_score_and_invalidate_old_selection_tokens(self):
        trace,analytics,outcome=self.ready();before=analytics.read(self.token,'w')
        self.begin(outcome,'replace')
        with self.assertRaises(Conflict):analytics.validate_outcomes(self.token,'w',[before['outcome_read_token']])
        current=analytics.read(self.token,'w')['outcomes'][trace]
        self.assertTrue(current['is_evaluating']);self.assertEqual(current['outcome']['value']['answer_score'],0)
        rows=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{});self.assertTrue(rows[0]['is_evaluating'])
        outcome.dispatch('outcome_cancel',self.token,'w',{'trace_ref':'task','operation_key':'cancel'})
        rows=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{});self.assertFalse(rows[0]['is_evaluating']);self.assertEqual(rows[0]['answer_score'],0)

    def test_trace_list_rechecks_current_outcome_before_returning(self):
        _,_,outcome=self.ready();reader=LegacyTraceList(self.queries,self.metadata);original=reader._recheck;changed=[False]
        def change(*args,**kwargs):
            if not changed[0]:changed[0]=True;self.begin(outcome,'changed-during-read')
            return original(*args,**kwargs)
        with patch.object(reader,'_recheck',side_effect=change):
            with self.assertRaises(Conflict):reader.read(self.token,'w',{})

    def test_unknown_ingestion_score_is_not_filled_from_unrelated_experiment(self):
        trace=self.prepare_source();analytics,*_=self.publish(trace)
        page=analytics.read(self.token,'w');self.assertIsNone(page['outcomes'][trace]['outcome'])
        rows=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{});self.assertNotIn('answer_score',rows[0])

    def test_query_reset_clears_the_same_old_answer_across_consumers_until_a_new_success(self):
        from services.storage.trace_outcome import patch_query
        trace,analytics,outcome=self.ready()
        with self.control.transaction() as con:patch_query(outcome,con,self.token,'w',trace,' changed question ')
        self.publish(trace)
        current=analytics.read(self.token,'w')['outcomes'][trace];self.assertIn('answer_reset',current);self.assertFalse(current['is_evaluating'])
        rows=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{});self.assertIsNone(rows[0]['answer_score']);self.assertEqual(rows[0]['judgment_reason'],'结果评估中...')
        started=self.begin(outcome,'new-question');self.finish(outcome,started,1)
        current=analytics.read(self.token,'w')['outcomes'][trace];self.assertNotIn('answer_reset',current)
        rows=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{});self.assertEqual(rows[0]['answer_score'],1)

    def test_query_reset_without_an_outcome_cannot_reveal_ingestion_correctness(self):
        from services.storage.trace_outcome import patch_query
        trace=self.prepare_source();outcome=ExperimentStore(self.control)
        with self.control.transaction() as con:patch_query(outcome,con,self.token,'w',trace,'changed question')
        rows=LegacyTraceList(self.queries,self.metadata).read(self.token,'w',{});self.assertIsNone(rows[0]['answer_score']);self.assertFalse(rows[0]['is_answer_correct']);self.assertFalse(rows[0]['is_evaluating'])
