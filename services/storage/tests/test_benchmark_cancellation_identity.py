import copy
import json
import unittest
from unittest.mock import patch

from services.storage.experiments import ExperimentStore
from services.storage.tests import test_benchmark_core as fixture


class BenchmarkCancellationIdentityTests(unittest.TestCase):
    def setUp(self):
        self.base = fixture.BenchmarkCoreTests()
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)

    def test_global_cancel_covers_a_new_unclaimed_supplemental_run(self):
        base = self.base
        _, intent = base.supplemental_ready(evaluators=['judge'])
        continued = base.invoke('finish_intent', **intent['handle'], operation='prepare_continuation', operation_key='continue')
        store = ExperimentStore(base.control, base.evidence)
        handle = store.dispatch('claim', base.token, 'w', {'experiment_id': 'bexp', 'run_id': continued['run_id'], 'worker_id': 'first'})
        store.dispatch('complete', base.token, 'w', handle | {'result': {'score': 55}, 'operation_key': 'complete-first'})
        first = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-first')['cancellation']
        repeated = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-first-again')['cancellation']
        self.assertEqual(first['id'], repeated['id'])
        retry = store.dispatch('retry', base.token, 'w', {'experiment_id': 'bexp', 'result_id': handle['result_id'], 'operation_key': 'explicit-new-run'})
        second = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-second')['cancellation']
        self.assertNotEqual(first['id'], second['id'])
        self.assertIsNone(store.dispatch('claim', base.token, 'w', {'experiment_id': 'bexp', 'run_id': retry['current_run_id'], 'worker_id': 'after-second-cancel'}))
        repeated = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-second-again')['cancellation']
        self.assertEqual(second['id'], repeated['id'])

    def test_same_work_cancel_remains_stable_through_native_cleanup(self):
        base = self.base
        _, intent = base.supplemental_ready()
        continued = base.invoke('finish_intent', **intent['handle'], operation='prepare_continuation', operation_key='continue-native')
        store = ExperimentStore(base.control, base.evidence)
        store.dispatch('claim', base.token, 'w', {'experiment_id': 'bexp', 'run_id': continued['run_id'], 'worker_id': 'native'})
        first = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-native')['cancellation']
        second = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-native-again')['cancellation']
        self.assertEqual(first['id'], second['id'])
        target = json.loads(first['targetsJson'])[0]
        proof = {key: target[key] for key in ('workspace_id', 'experiment_id', 'attempt_id', 'work_item_id', 'run_id', 'fence', 'lease_owner', 'actor_principal_id')}
        proof.update(transport='native-worker', cleanup='confirmed')
        done = base.invoke('cleanup_confirm', experiment_id='bexp', cancellation_id=first['id'], expected_revision=first['revision'], target_id=target['jobId'], proof=proof, operation_key='cleanup')
        repeated = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-after-cleanup')['cancellation']
        self.assertEqual(repeated['id'], first['id'])
        self.assertEqual(repeated['status'], done['status'])

    def test_case_cancel_ignores_an_unrelated_case_new_run(self):
        base = self.base
        data = base.dataset()
        second = copy.deepcopy(data['cases'][0])
        second.update(id='dc2', externalCaseId='external2', ordinal=1)
        data['cases'].append(second)
        data['public_dataset']['cases'].append(data['public_dataset']['cases'][0] | {'id': 'dc2'})
        with patch.object(base, 'dataset', return_value=data):
            base.create()
        with base.control.read_transaction() as con:
            case_id = con.execute("SELECT case_id FROM experiment_cases WHERE experiment_id='bexp' ORDER BY ordinal LIMIT 1").fetchone()[0]
        first = base.invoke('cancel_request', experiment_id='bexp', mode='case_remove', case_id=case_id, operation_key='remove-first')['cancellation']
        base.invoke('start', experiment_id='bexp', public_callback_origin='http://localhost:3000', executor_callback_origin='http://localhost:3000', operation_key='start-other-case')
        repeated = base.invoke('cancel_request', experiment_id='bexp', mode='case_remove', case_id=case_id, operation_key='remove-first-again')['cancellation']
        self.assertEqual(first['id'], repeated['id'])

    def test_natural_failed_cleanup_can_confirm_only_the_exact_frozen_native_attempt(self):
        base = self.base
        _, intent = base.supplemental_ready()
        continued = base.invoke('finish_intent', **intent['handle'], operation='prepare_continuation', operation_key='continue-natural-failure')
        store = ExperimentStore(base.control, base.evidence)
        handle = store.dispatch('claim', base.token, 'w', {'experiment_id': 'bexp', 'run_id': continued['run_id'], 'worker_id': 'natural-failure-worker'})
        store.dispatch('fail', base.token, 'w', handle | {'error': {'code': 'EVALUATION_CLEANUP_UNCONFIRMED', 'message': 'native cleanup remains unknown'}, 'operation_key': 'natural-failed-cleanup'})
        with base.control.read_transaction() as con:
            item = con.execute('SELECT cancel_requested,etag FROM work_items WHERE work_item_id=?', (handle['work_item_id'],)).fetchone()
            self.assertFalse(item['cancel_requested'])
            self.assertEqual(str(item['etag']), str(handle['fence']))
            receipts = [dict(row) for row in con.execute('SELECT * FROM result_receipts')]
        record = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-natural-failed')['cancellation']
        targets = json.loads(record['targetsJson'])
        self.assertEqual(len(targets), 1)
        target = targets[0]
        self.assertEqual(target['kind'], 'native-evaluate')
        self.assertEqual(target['attempt_id'], handle['attempt_id'])
        with base.control.read_transaction() as con:
            item = con.execute('SELECT cancel_requested,etag FROM work_items WHERE work_item_id=?', (handle['work_item_id'],)).fetchone()
            self.assertTrue(item['cancel_requested'])
            self.assertGreater(item['etag'], int(handle['fence']))
        proof = {key: target[key] for key in ('workspace_id', 'experiment_id', 'attempt_id', 'work_item_id', 'run_id', 'fence', 'lease_owner', 'actor_principal_id')}
        proof.update(transport='native-worker', cleanup='confirmed')
        from services.storage.control import Conflict
        for key, wrong in [('fence', '999'), ('attempt_id', 'different-attempt'), ('lease_owner', 'different-worker')]:
            with self.assertRaises(Conflict):
                base.invoke('cleanup_confirm', experiment_id='bexp', cancellation_id=record['id'], expected_revision=record['revision'], target_id=target['jobId'], proof=proof | {key: wrong}, operation_key='wrong-natural-' + key)
        done = base.invoke('cleanup_confirm', experiment_id='bexp', cancellation_id=record['id'], expected_revision=record['revision'], target_id=target['jobId'], proof=proof, operation_key='confirm-natural-failed')
        self.assertEqual(done['status'], 'completed')
        with base.control.read_transaction() as con:
            self.assertEqual([dict(row) for row in con.execute('SELECT * FROM result_receipts')], receipts)
            checkpoint = con.execute('SELECT * FROM experiment_attempt_checkpoints WHERE attempt_id=?', (handle['attempt_id'],)).fetchone()
            from services.storage.benchmark_cancellation import native_confirmed
            self.assertTrue(native_confirmed(base.service(), con, 'w', 'bexp', checkpoint))
            self.assertEqual(con.execute("SELECT COUNT(*) FROM benchmark_operation_receipts WHERE operation_kind='cleanup-confirmed-native'").fetchone()[0], 1)

    def test_successful_native_work_cannot_be_forged_into_a_cleanup_target(self):
        base = self.base
        _, intent = base.supplemental_ready()
        continued = base.invoke('finish_intent', **intent['handle'], operation='prepare_continuation', operation_key='continue-clean-native')
        store = ExperimentStore(base.control, base.evidence)
        handle = store.dispatch('claim', base.token, 'w', {'experiment_id': 'bexp', 'run_id': continued['run_id'], 'worker_id': 'clean-worker'})
        store.dispatch('complete', base.token, 'w', handle | {'result': {'score': 55}, 'operation_key': 'clean-native-complete'})
        record = base.invoke('cancel_request', experiment_id='bexp', mode='cancel', operation_key='cancel-clean-native')['cancellation']
        self.assertEqual(record['status'], 'completed')
        self.assertEqual(json.loads(record['targetsJson']), [])
        from services.storage.control import Conflict
        proof = {key: handle[key] for key in ('experiment_id', 'attempt_id', 'work_item_id', 'run_id', 'fence', 'lease_owner')}
        proof.update(workspace_id='w', actor_principal_id='alice', transport='native-worker', cleanup='confirmed')
        with self.assertRaises(Conflict):
            base.invoke('cleanup_confirm', experiment_id='bexp', cancellation_id=record['id'], expected_revision=record['revision'], target_id='native:' + handle['attempt_id'], proof=proof, operation_key='cannot-confirm-success')
