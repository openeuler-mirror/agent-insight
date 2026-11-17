import unittest
from unittest.mock import patch
from services.storage.control import Conflict
from services.storage.tests import test_trace_service as http_fixture

class TriggerReadTransportTests(unittest.TestCase):
    setUp=http_fixture.TraceHTTPTests.setUp
    request=http_fixture.TraceHTTPTests.request

    def test_only_experiments_returns_the_whitelisted_transient_trigger_code(self):
        changed=Conflict('private transient detail');changed.code='TRIGGER_READ_CHANGED'
        with patch('services.storage.experiments.ExperimentStore.dispatch',side_effect=changed):
            status,body,_=self.request('/v1/compat/experiments?workspace_id=w',self.token,body={'action':'trigger_list','skill_name':'checking'})
        self.assertEqual(status,409);self.assertEqual(body.get('code'),'TRIGGER_READ_CHANGED');self.assertNotIn('private',body['error'])
        with patch('services.storage.evaluator_assets.EvaluatorAssets.dispatch',side_effect=changed):
            status,body,_=self.request('/v1/compat/evaluators?workspace_id=w',self.token,body={'action':'list'})
        self.assertEqual(status,409);self.assertNotIn('code',body)
        ordinary=Conflict('private corruption');ordinary.code='UNSAFE_OTHER_CODE'
        with patch('services.storage.experiments.ExperimentStore.dispatch',side_effect=ordinary):
            status,body,_=self.request('/v1/compat/experiments?workspace_id=w',self.token,body={'action':'trigger_list','skill_name':'checking'})
        self.assertEqual(status,409);self.assertNotIn('code',body)
