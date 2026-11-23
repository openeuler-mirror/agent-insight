import unittest
from services.storage.builtin_demo import AGENT_NAME, AGENT_DESCRIPTION, SKILL_NAME, SKILL_DESCRIPTION, DATASET_NAME
from services.storage.datasets import DatasetStore
from services.storage.iam import Forbidden
from services.storage.trace_metadata import TraceMetadata
from services.storage.tests.test_datasets import record
from services.storage.tests import test_platform_controls


class BuiltinDemoTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_platform_controls.PlatformControlTests('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.control = self.fixture.control

    def cleanup(self, **kwargs):
        return self.fixture.service().dispatch(self.fixture.api, 'w', 'builtin_demo_cleanup', {}, **kwargs)

    def test_exact_demo_cleanup_preserves_other_records_and_source_artifacts(self):
        operations = []
        for identity, name, description in [('demo', AGENT_NAME, AGENT_DESCRIPTION), ('same', AGENT_NAME, 'User created')]:
            operations.append({'kind': 'registeredAgent', 'method': 'create', 'data': {'id': identity, 'name': name, 'description': description, 'platform': 'opencode' if identity == 'demo' else 'pi-agent', 'user': 'alice'}})
        for identity, description in [('demo-skill', SKILL_DESCRIPTION), ('same-skill', 'User created')]:
            operations.append({'kind': 'skill', 'method': 'create', 'data': {'id': identity, 'name': SKILL_NAME if identity == 'demo-skill' else 'user-skill', 'description': description, 'author': None, 'isUploaded': False, 'user': 'alice'}})
        self.fixture.write(operations, operation_key='demo-fixture')
        datasets = DatasetStore(self.control)
        datasets.save(self.fixture.api, 'w', record('demo-dataset', DATASET_NAME), operation_key='demo-dataset')
        datasets.save(self.fixture.api, 'w', record('real-dataset'), operation_key='real-dataset')
        source = self.fixture.fixture
        reserved = source.reserve()
        source.commit(reserved)
        source.drain()
        trace = source.service().status(source.api, 'w', {'task_id': 'task', 'operation_key': 'one'})['trace_id']
        TraceMetadata(self.control).register_aliases_for_provisioning('w', trace, task_id='builtin_msg_demo')
        self.assertEqual(self.cleanup(trusted=True), dict(executions=1, sessions=1, agents=1, datasets=1, skills=1))
        self.assertEqual(self.cleanup(trusted=True), dict(executions=0, sessions=0, agents=0, datasets=0, skills=0))
        self.assertEqual([row['record_id'] for row in self.fixture.read('registeredAgent')['rows']], ['same'])
        self.assertEqual([row['record_id'] for row in self.fixture.read('skill')['rows']], ['same-skill'])
        self.assertEqual(datasets.get(self.fixture.api, 'w', 'real-dataset')['dataset']['id'], 'real-dataset')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM trace_locators WHERE trace_id=?', (trace,)).fetchone()[0], 'deleting')
            self.assertGreater(con.execute('SELECT COUNT(*) FROM obs_entity_heads WHERE trace_id=?', (trace,)).fetchone()[0], 0)

    def test_cleanup_requires_private_proof_and_owner_permissions(self):
        with self.assertRaises(Forbidden):
            self.cleanup()
        with self.assertRaises(Forbidden):
            self.fixture.service().dispatch(self.fixture.readonly, 'w', 'builtin_demo_cleanup', {}, trusted=True)
        self.fixture.write([{'kind': 'registeredAgent', 'method': 'create', 'data': {'id': 'demo', 'name': AGENT_NAME, 'description': AGENT_DESCRIPTION, 'platform': 'opencode', 'user': 'alice'}}], operation_key='alice-demo')
        bob = self.fixture.iam.issue_api_credential(self.fixture.fixture.tokens['bob'], 'w', ['read', 'write', 'delete'])
        self.assertEqual(self.fixture.service().dispatch(bob, 'w', 'builtin_demo_cleanup', {}, trusted=True)['agents'], 0)
        self.assertEqual(len(self.fixture.read('registeredAgent')['rows']), 1)
