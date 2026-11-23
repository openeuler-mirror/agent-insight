import copy
import json
import unittest
from unittest.mock import patch

from services.storage.authorized import AuthorizedStorage
from services.storage.experiments import ExperimentStore
from services.storage.observations import ObservationIngest
from services.storage.tests import test_experiments as fixture
from services.storage.tests.test_observations import packet
from services.storage.tests.test_trace_transfer import MemoryFacts
from services.storage.trace_evidence import TraceEvidence
from services.storage.trace_service import TraceQueries


class ExperimentReadinessTests(unittest.TestCase):
    def setUp(self):
        self.base=fixture.ExperimentTests();self.base.setUp();self.addCleanup(self.base.doCleanups)
        facts=MemoryFacts();ingest=ObservationIngest(self.base.control,facts)
        self.store=ExperimentStore(self.base.control,evidence=TraceEvidence(TraceQueries(self.base.control,facts,cursor_secret=b'experiment-readiness-tests'),AuthorizedStorage(self.base.iam,facts)),frozen_assets_verifier=lambda *_:True)
        self.store.dispatch('create',self.base.token,'w',{'experiment':fixture.experiment(),'operation_key':'create'})
        self.base.execution_start();handle=self.base.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
        accepted=ingest.accept(self.base.token,'w',packet());ingest.work_once('ingest-worker')
        self.store.dispatch('execute_complete',self.base.token,'w',self.base.handle(handle)|{'trace_id':accepted['trace_ids'][0],'operation_key':'execute-complete'})

    def snapshot(self):return self.store.dispatch('read',self.base.token,'w',{'experiment_id':'exp'})

    def changed_source(self,change):
        original=self.store._plan
        def plan(*args):
            row,value=original(*args);value=copy.deepcopy(value)
            for evidence in value.get('frozen_trace_evidence',{}).values():change(evidence)
            return row,value
        return patch.object(self.store,'_plan',plan)

    def test_real_source_readiness_does_not_rewrite_the_frozen_session_or_redacted_gold(self):
        before=self.snapshot();metadata=before['business_trace_readiness']['case']
        self.assertTrue(metadata['hasInteractions']);self.assertTrue(metadata['hasBusinessResponse']);self.assertFalse(metadata['hasEndTime'])
        after=self.store.dispatch('read',self.base.admin,'w',{'experiment_id':'exp'})
        self.assertIsNone(after['sessions'][0]['interactions']);self.assertEqual(after['business_trace_readiness'],before['business_trace_readiness'])
        self.assertEqual(self.snapshot()['sessions'],before['sessions'])
        self.assertEqual(set(metadata),{'executionId','taskId','hasInteractions','hasBusinessResponse','hasEndTime','executionAgent'})

    def test_readiness_keeps_the_original_nonempty_and_business_response_predicates(self):
        for messages,nonempty,business in [(None,False,False),('invalid',False,False),('[]',False,False),([],False,False),([None],True,False),([{'role':'user','content':'prompt'}],True,False),([{'role':'assistant','content':' '}],True,False),([{'role':'opencode','parts':[{'type':'tool-call','callID':'real'}]}],True,True),([{'role':'assistant','toolCalls':[{}]}],True,True),(json.dumps([{'role':'assistant','content':'answer'}]),True,True)]:
            with self.subTest(messages=messages),self.changed_source(lambda ev:ev['session'].update(interactions=messages,endTime='2026-11-14T00:00:00Z')):
                metadata=self.snapshot()['business_trace_readiness']['case']
                self.assertEqual(metadata['hasInteractions'],nonempty);self.assertEqual(metadata['hasBusinessResponse'],business);self.assertTrue(metadata['hasEndTime'])

    def test_an_unrelated_historical_execution_or_task_cannot_supply_current_readiness(self):
        for object_name,key in [('session','taskId'),('execution','id')]:
            with self.subTest(field=key),self.changed_source(lambda ev:ev[object_name].update({key:'other-source'})):
                self.assertEqual(self.snapshot()['business_trace_readiness'],{})

    def test_nonstandard_python_json_constants_remain_invalid_to_the_original_js_predicate(self):
        for messages in ('[NaN]','[Infinity]','[-Infinity]'):
            with self.subTest(messages=messages),self.changed_source(lambda ev:ev['session'].update(interactions=messages)):
                self.assertFalse(self.snapshot()['business_trace_readiness']['case']['hasInteractions'])


if __name__=='__main__':unittest.main()
