import unittest

from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_experiments as experiments
from services.storage.tests import test_benchmark_core as benchmark
from services.storage.legacy_history import INERT_SOURCE, control_history_key
from services.storage.tests import test_platform_controls as controls
from services.storage.tests import test_infra as infra
from services.storage.tests import test_fault_injection_core as fi


def mark(control, kind, identity, workspace='w'):
    with control.transaction() as con:
        con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)',
                    (workspace, INERT_SOURCE, control_history_key(kind, identity), 'a' * 64, control.clock()))


class LegacyRuntimeFenceTests(unittest.TestCase):
    def fixture(self, cls):
        value = cls('runTest')
        value.setUp()
        self.addCleanup(value.doCleanups)
        return value

    def test_original_task_remains_readable_but_cannot_be_resumed(self):
        f = self.fixture(controls.PlatformControlTests)
        f.write([{'kind': 'skillWorkbenchSession', 'method': 'create', 'data': {'id': 's', 'user': 'alice'}},
                 {'kind': 'skillWorkbenchTask', 'method': 'create', 'data': {'id': 't', 'sessionId': 's', 'type': 'evaluation', 'idempotencyKey': 'old'}}])
        mark(f.control, 'skillWorkbenchTask', 't')
        self.assertEqual(f.read('skillWorkbenchTask', body=True)['rows'][0]['data']['status'], 'pending')
        hidden = f.service().dispatch(f.api, 'w', 'records_read',
                                     {'kind': 'skillWorkbenchTask', 'body': True, 'required_capabilities': ['execute']}, trusted=True)
        self.assertEqual(hidden['rows'], [])
        with self.assertRaises(Conflict):
            f.write([{'kind': 'skillWorkbenchTask', 'method': 'update', 'record_id': 't', 'data': {'status': 'running'}}], operation_key='resume')
        f.write([{'kind': 'skillWorkbenchTask', 'method': 'create', 'data': {'id': 'new', 'sessionId': 's', 'type': 'evaluation', 'idempotencyKey': 'new'}}], operation_key='new')

    def test_imported_device_never_authenticates(self):
        f = self.fixture(controls.PlatformControlTests)
        capability = f.client_capability()
        self.assertEqual(f.service().capability_dispatch({'action': 'identity', 'capability': capability})['principal'], 'alice')
        mark(f.control, 'reliabilityClient', 'client')
        with self.assertRaises(Forbidden):
            f.service().capability_dispatch({'action': 'identity', 'capability': capability})

    def test_legacy_username_uses_the_explicit_existing_principal(self):
        f = self.fixture(controls.PlatformControlTests)
        service = f.service()
        service.dispatch(f.api, 'w', 'records_batch', {'legacy_username': 'Old.Name', 'operation_key': 'mapped', 'operations': [
            {'kind': 'user', 'method': 'create', 'data': {'id': 'legacy-user', 'username': 'Old.Name', 'apiKey': f.api}}]}, trusted=True)
        user = service.bootstrap_login({'action': 'login', 'mode': 'standalone', 'username': 'Old.Name'})
        self.assertEqual(user['apiKey'], f.api)
        self.assertFalse(user['_created'])
        self.assertEqual(f.iam.scope(user['apiKey']).principal_id, 'alice')
        with f.control.read_transaction() as con:
            self.assertIsNone(con.execute("SELECT 1 FROM iam_principals WHERE normalized_login_name='old.name'").fetchone())

    def test_historical_infra_enabled_value_does_not_enable_polling(self):
        f = self.fixture(infra.InfraTests)
        source = f.source()
        mark(f.control, 'infraSource', source['id'])
        self.assertTrue(f.store.list_sources(f.token, 'w')[0]['enabled'])
        self.assertEqual(f.store.list_sources(f.token, 'w', own_only=True, live_only=True), [])
        with self.assertRaises(Conflict):
            f.store.assert_pollable(f.token, 'w', source['id'])

    def test_fi_historical_queued_run_is_visible_but_not_claimed(self):
        f = self.fixture(fi.FaultInjectionCoreTests)
        f.create()
        mark(f.control, 'faultInjectionRun', 'run-id')
        self.assertEqual(f.call('read_run', {'runKey': 'run-id'})['run']['status'], 'queued')
        f.call('heartbeat', {'workerId': 'current-worker'})
        self.assertEqual(f.call('claim', {'workerId': 'current-worker'})['runs'], [])

    def test_historical_experiment_cannot_start_or_claim_but_keeps_status(self):
        f = self.fixture(experiments.ExperimentTests)
        f.create()
        f.start()
        before = f.call('read', experiment_id='exp')['experiment']['status']
        mark(f.control, 'experiment', 'exp')
        self.assertEqual(f.call('read', experiment_id='exp')['experiment']['status'], before)
        with self.assertRaisesRegex(Conflict, 'historical control is inert'):
            f.claim()
        with self.assertRaisesRegex(Conflict, 'historical control is inert'):
            f.call('start', experiment_id='exp', operation_key='late-start')

    def test_historical_benchmark_does_not_issue_live_work(self):
        f = self.fixture(benchmark.BenchmarkCoreTests)
        f.create()
        mark(f.control, 'experiment', 'bexp')
        with self.assertRaisesRegex(Conflict, 'historical control is inert'):
            f.invoke('start', experiment_id='bexp', operation_key='late-start')
        mark(f.control, 'benchmarkJob', 'old-job')
        with f.control.read_transaction() as con, self.assertRaises(Conflict):
            f.service()._active(con, {'workspace_id': 'w', 'experiment_id': 'bexp', 'job_id': 'old-job'}, {}, None)
