from contextlib import closing
import concurrent.futures
import importlib
import sqlite3
import tempfile
import unittest
from pathlib import Path


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'control.db'
        try:
            self.api = importlib.import_module('services.storage.control')
        except ModuleNotFoundError:
            self.fail('SQLite control repository is not implemented')
        self.now = 100_000
        self.store = self.api.SQLiteControlStore(self.path, clock=lambda: self.now)
        self.store.initialize()
        self.store.create_workspace('w1', 'One')
        self.store.create_workspace('w2', 'Two')

    def release(self, workspace='w1', asset='a', release='r', content=None):
        self.store.create_identity(workspace, asset, 'skill', asset)
        return self.store.publish_release(workspace, asset, release, '1.0', content or {'prompt': 'hello'})

    def test_refuses_legacy_database_without_mutating_it(self):
        legacy = Path(self.temp.name) / 'old.db'
        con = sqlite3.connect(legacy)
        con.execute('CREATE TABLE Execution(id TEXT)')
        con.commit(); con.close()
        before = legacy.read_bytes()
        with self.assertRaises(self.api.StorageError):
            self.api.SQLiteControlStore(legacy).initialize()
        self.assertEqual(legacy.read_bytes(), before)

    def test_initialization_validates_migration_checksum(self):
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as con:
            con.execute("UPDATE schema_meta SET checksum='bad'")
            con.commit()
        with self.assertRaises(self.api.StorageError):
            self.store.initialize()

    def test_release_is_immutable_and_alias_is_scoped_and_cas(self):
        r = self.release()
        self.assertEqual(r['release_id'], 'r')
        self.assertEqual(self.store.publish_release('w1', 'a', 'r', '1.0', {'prompt': 'hello'})['content_hash'], r['content_hash'])
        with self.assertRaises(self.api.Conflict):
            self.store.publish_release('w1', 'a', 'r', '1.0', {'prompt': 'changed'})
        self.release('w1', 'b', 'rb')
        self.store.move_alias('w1', 'a', 'stable', 'r', expected_etag=0)
        with self.assertRaises(self.api.Conflict):
            self.store.move_alias('w1', 'a', 'stable', 'r', expected_etag=0)
        with self.assertRaises(self.api.StorageError):
            self.store.move_alias('w1', 'a', 'stable', 'rb', expected_etag=1)
        with self.assertRaises(self.api.StorageError):
            self.store.move_alias('w2', 'a', 'stable', 'r', expected_etag=0)
        with closing(sqlite3.connect(self.path)) as con:
            with self.assertRaises(sqlite3.IntegrityError):
                con.execute("UPDATE asset_releases SET content_hash=? WHERE workspace_id='w1' AND release_id='r'", ('0'*64,))

    def test_draft_compare_and_swap(self):
        self.release()
        self.store.create_draft('w1', 'd', 'a', {'prompt': 'one'}, base_release_id='r')
        self.assertEqual(self.store.edit_draft('w1', 'd', {'prompt': 'two'}, expected_revision=1), 2)
        with self.assertRaises(self.api.Conflict):
            self.store.edit_draft('w1', 'd', {'prompt': 'lost'}, expected_revision=1)

    def prepare_item(self):
        self.release()
        self.store.create_identity('w1', 'agent', 'agent', 'test-agent')
        self.store.publish_release('w1', 'agent', 'ar', '1', {'runtime': 'test'})
        self.store.create_run('w1', 'run', {'agent': 'ar'}, {'seed': 4}, expected_case_count=1)
        self.store.enqueue('w1', 'item', 'run', 'case-1')

    def test_concurrent_claim_has_one_winner(self):
        self.prepare_item()
        def claim(i):
            return self.api.SQLiteControlStore(self.path, clock=lambda: self.now).claim('w1', f'worker{i}', lease_ms=1000)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            claims = list(pool.map(claim, range(8)))
        self.assertEqual(sum(c is not None for c in claims), 1)

    def test_expired_fence_and_result_outbox_atomicity(self):
        self.prepare_item()
        digest, artifact = self.store.persist_artifact({'score': '50'})
        first = self.store.claim('w1', 'old', lease_ms=1000)
        self.now += 1001
        second = self.store.claim('w1', 'new', lease_ms=1000)
        self.assertGreater(second['fence'], first['fence'])
        with self.assertRaises(self.api.Conflict):
            self.store.complete('w1', first['attempt_id'], first['fence'], 'rc', 'result', digest, artifact)
        receipt = self.store.complete('w1', second['attempt_id'], second['fence'], 'rc', 'result', digest, artifact)
        self.assertEqual(receipt['state'], 'accepted')
        self.store.complete('w1', second['attempt_id'], second['fence'], 'rc', 'result', digest, artifact)
        with self.assertRaises(self.api.Conflict):
            self.store.complete('w1', second['attempt_id'], second['fence'], 'rc', 'result', 'b'*64, artifact)
        with closing(sqlite3.connect(self.path)) as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0], 1)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM outbox_events').fetchone()[0], 1)
            self.assertEqual(con.execute('SELECT status FROM work_items').fetchone()[0], 'done')

    def test_cancellation_prevents_late_completion(self):
        self.prepare_item()
        digest, artifact = self.store.persist_artifact({'score': '50'})
        attempt = self.store.claim('w1', 'worker', lease_ms=1000)
        self.assertTrue(self.store.cancel('w1', 'item'))
        with self.assertRaises(self.api.Conflict):
            self.store.complete('w1', attempt['attempt_id'], attempt['fence'], 'rc', 'result', digest, artifact)

    def test_completion_rejects_non_durable_artifact(self):
        self.prepare_item()
        attempt=self.store.claim('w1','worker')
        with self.assertRaises(self.api.StorageError):
            self.store.complete('w1',attempt['attempt_id'],attempt['fence'],'rc','result','a'*64,'artifact:missing')

    def test_run_slot_requires_matching_asset_kind(self):
        self.release()
        with self.assertRaises(self.api.StorageError):
            self.store.create_run('w1','bad',{'agent':'r'},{},expected_case_count=1)

    def test_renew_requires_current_unexpired_fence(self):
        self.prepare_item()
        attempt=self.store.claim('w1','worker',lease_ms=1000)
        self.now+=500
        self.assertEqual(self.store.renew('w1',attempt['attempt_id'],attempt['fence'],lease_ms=1000),self.now+1000)
        self.now+=1001
        with self.assertRaises(self.api.Conflict):
            self.store.renew('w1',attempt['attempt_id'],attempt['fence'],lease_ms=1000)

    def test_evaluator_callback_cannot_change_frozen_slot(self):
        self.prepare_item()
        digest,artifact=self.store.persist_artifact({'score':'50'})
        attempt=self.store.claim('w1','worker')
        with self.assertRaises(self.api.Conflict):
            self.store.complete('w1',attempt['attempt_id'],attempt['fence'],'rc','result',digest,artifact,evaluator_slot='another')
        with closing(sqlite3.connect(self.path)) as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0],0)
