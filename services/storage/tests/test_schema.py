import json
import os
import re
import subprocess
import uuid
import sqlite3
import unittest
from pathlib import Path

SCHEMA = Path(__file__).resolve().parents[1] / 'schema'


class CoreSchemaTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        migration = SCHEMA / 'sqlite/001_core.sql'
        self.assertTrue(migration.exists(), 'baseline migration required')
        self.db.executescript(migration.read_text())
        self.db.execute("INSERT INTO workspaces VALUES ('w','Workspace','active',0,0)")
        self.db.execute("INSERT INTO workspaces VALUES ('other','Other','active',0,0)")

    def tearDown(self):
        self.db.close()

    def identity(self, asset='a', workspace='w'):
        self.db.execute('INSERT INTO asset_identities(workspace_id,asset_id,kind,name,created_at_ms,updated_at_ms) VALUES (?,?,?,?,0,0)', (workspace, asset, 'skill', asset))

    def release(self, release='r', asset='a', workspace='w', version='1'):
        self.db.execute('INSERT INTO asset_releases VALUES (?,?,?,?,?,?,1,?,0)', (workspace, release, asset, version, 'a'*64, 'artifact:manifest', 'publisher'))

    def seal(self, release='r', asset='a'):
        count = self.db.execute('SELECT COUNT(*) FROM asset_release_dependencies WHERE workspace_id=? AND release_id=?', ('w',release)).fetchone()[0]
        self.db.execute('INSERT INTO asset_release_seals VALUES (?,?,?,?,0)', ('w',release,asset,count))

    def test_table_catalog_matches_sql(self):
        expected={t['name'] for t in json.loads((SCHEMA/'core-catalog.json').read_text())['tables']}
        actual={r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(expected, actual)
        self.assertEqual([], list(self.db.execute('PRAGMA foreign_key_check')))

    def test_release_and_dependencies_are_immutable(self):
        self.identity(); self.release()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE asset_releases SET manifest_ref='changed' WHERE release_id='r'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM asset_releases WHERE release_id='r'")
        self.release('r2',version='2')
        self.db.execute("INSERT INTO asset_release_dependencies VALUES ('w','r','skill','r2',0)")
        self.seal()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO asset_release_dependencies VALUES ('w','r','another-role','r2',0)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE asset_release_dependencies SET role='changed'")

    def test_catalog_columns_and_foreign_keys_match_database(self):
        for table in json.loads((SCHEMA/'core-catalog.json').read_text())['tables']:
            actual=list(self.db.execute('PRAGMA table_info('+table['name']+')'))
            self.assertEqual([c['name'] for c in table['columns']], [r[1] for r in actual])
            self.assertEqual([c['nullable'] for c in table['columns']], [not bool(r[3]) for r in actual])
            for foreign in table['foreign_keys']:
                parent=foreign['table']
                self.assertIn(parent, {r[2] for r in self.db.execute('PRAGMA foreign_key_list('+table['name']+')')})

    def test_receipt_cannot_mix_another_run_or_attempt(self):
        for run in ('one','two'):
            self.db.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,created_at_ms,updated_at_ms) VALUES ('w',?,?,?,'manifest',1,0,0)",(run,run,'a'*64))
        self.db.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,created_at_ms,updated_at_ms) VALUES ('w','item','one','case','evaluate',0,0)")
        self.db.execute("INSERT INTO work_attempts VALUES ('w','attempt','item',1,1,'worker','running',10,0,NULL,NULL)")
        sql="INSERT INTO result_receipts(workspace_id,receipt_id,run_id,case_key,work_item_id,attempt_id,receipt_key,result_id,content_hash,artifact_ref,created_at_ms) VALUES ('w',?,?,'case','item','attempt','receipt-key',?,?,'artifact',0)"
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql,('receipt-bad','two','result-bad','a'*64))
        self.db.execute(sql,('receipt','one','result','a'*64))
        for run, case, slot in [('two','case','default'), ('one','another-case','default'), ('one','case','other-judge')]:
            with self.subTest(run=run,case=case,slot=slot), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("INSERT INTO result_selections VALUES ('w',?,?,?,'result',1,0)", (run,case,slot))
        self.db.execute("INSERT INTO result_selections VALUES ('w','one','case','default','result',1,0)")

    def test_dataset_input_cannot_reference_unsealed_release(self):
        self.identity(); self.release()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,dataset_release_id,expected_case_count,created_at_ms,updated_at_ms) VALUES ('w','run','Run',?,'manifest','r',1,0,0)", ('a'*64,))
        self.db.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,created_at_ms,updated_at_ms) VALUES ('w','run','Run',?,'manifest',1,0,0)", ('a'*64,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO run_inputs VALUES ('w','run','skill','r',?,0)", ('b'*64,))

    def test_queued_run_plan_cannot_change_or_reopen_draft(self):
        self.db.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,status,created_at_ms,updated_at_ms) VALUES ('w','run','Run',?,'manifest',1,'queued',0,0)", ('a'*64,))
        for assignment in ("plan_hash='"+'b'*64+"'", "plan_manifest_ref='other'", "expected_case_count=2", "status='draft'"):
            with self.subTest(assignment=assignment), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute('UPDATE runs SET '+assignment)
        self.db.execute("UPDATE runs SET status='running', etag=2")

    def test_multiple_evaluator_slots_can_share_one_case(self):
        self.db.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,created_at_ms,updated_at_ms) VALUES ('w','run','Run',?,'manifest',1,0,0)", ('a'*64,))
        sql="INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,created_at_ms,updated_at_ms) VALUES ('w',?,'run','case','evaluate',?,0,0)"
        self.db.execute(sql,('judge-a','judge-a'))
        self.db.execute(sql,('judge-b','judge-b'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql,('duplicate','judge-a'))

    def test_trace_ids_cannot_be_reused_after_deletion(self):
        self.db.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES ('w','trace','native','n1','2026-11-11',0,0)")
        self.db.execute("UPDATE trace_locators SET state='deleted'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE trace_locators SET state='active'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE trace_locators SET trace_bucket='2026-12-01'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM trace_locators")

    def test_portable_integer_fields_reject_noninteger_values(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE workspaces SET created_at_ms='not-an-integer'")

    def test_alias_requires_same_asset_and_workspace_and_sealed_release(self):
        self.identity(); self.release()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO asset_aliases VALUES ('w','a','latest','r',1,0,0)")
        self.seal()
        self.db.execute("INSERT INTO asset_aliases VALUES ('w','a','latest','r',1,0,0)")
        self.identity('b')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO asset_aliases VALUES ('w','b','latest','r',1,0,0)")
        self.identity('a','other')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO asset_aliases VALUES ('other','a','latest','r',1,0,0)")

    def test_unique_version_is_scoped_to_asset(self):
        self.identity(); self.release()
        with self.assertRaises(sqlite3.IntegrityError):
            self.release('different')
        self.identity('b'); self.release('rb','b')

    def test_frozen_run_inputs_reference_real_release(self):
        self.identity(); self.release(); self.seal()
        self.db.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,created_at_ms,updated_at_ms) VALUES ('w','run','Run',?,'manifest:run',1,0,0)", ('b'*64,))
        self.db.execute("INSERT INTO run_inputs VALUES ('w','run','skill','r',?,0)", ('c'*64,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE run_inputs SET config_hash=?", ('d'*64,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO run_inputs VALUES ('w','run','agent','missing',?,0)", ('c'*64,))

    def test_negative_revisions_and_invalid_status_rejected(self):
        self.identity()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE asset_identities SET etag=0")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE workspaces SET state='mystery'")

    def test_claim_and_outbox_queries_have_indexes(self):
        names={r[1] for r in self.db.execute("PRAGMA index_list('work_items')")}
        self.assertIn('idx_work_items_1', names)
        plan=list(self.db.execute("EXPLAIN QUERY PLAN SELECT event_id FROM outbox_events WHERE state='pending' AND next_attempt_at_ms<=1 ORDER BY created_at_ms"))
        self.assertTrue(any('idx_outbox_events_1' in str(row) for row in plan),plan)


class BaselineFilesTest(unittest.TestCase):
    def test_clickhouse_catalog_and_sql_table_sets_match(self):
        catalog=json.loads((SCHEMA/'clickhouse-catalog.json').read_text())
        sql=(SCHEMA/'clickhouse/001_core.sql').read_text()
        actual=set(re.findall(r'^CREATE TABLE ([a-z_]+)',sql,re.M))
        expected={table['name'] for table in catalog['tables']}
        self.assertEqual(actual,expected)
        manifest=next(t for t in catalog['tables'] if t['name']=='obs_payload_manifests')
        self.assertEqual(manifest['key'],['workspace_id','trace_bucket','trace_id','span_id','payload_revision'])
        self.assertIn('manifest_json',{c['name'] for c in manifest['columns']})

    def test_schema_baseline_files_exist(self):
        for dialect in ('sqlite','postgresql','opengauss','clickhouse'):
            self.assertTrue((SCHEMA/dialect/'001_core.sql').exists(), dialect)


@unittest.skipUnless(os.environ.get('STORAGE_TEST_PG_CONTAINER'), 'set STORAGE_TEST_PG_CONTAINER to run real PostgreSQL constraints')
class PostgresSchemaTest(unittest.TestCase):
    def test_postgres_baseline_constraints(self):
        container = os.environ['STORAGE_TEST_PG_CONTAINER']
        self.assertRegex(container, r'^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')
        schema = 'storage_contract_' + uuid.uuid4().hex
        migration = (SCHEMA/'postgresql/001_core.sql').read_text()
        assertions = r"""
CREATE FUNCTION assert_rejected(statement TEXT, expected_state TEXT) RETURNS void AS $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_state THEN rejected := true; ELSE RAISE; END IF;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'statement unexpectedly succeeded'; END IF;
END; $$ LANGUAGE plpgsql;
INSERT INTO workspaces VALUES ('w','Workspace','active',0,0), ('other','Other','active',0,0);
INSERT INTO asset_identities(workspace_id,asset_id,kind,name,created_at_ms,updated_at_ms) VALUES ('w','a','skill','a',0,0), ('w','b','skill','b',0,0), ('other','a','skill','a',0,0);
INSERT INTO asset_releases VALUES ('w','r','a','1', repeat('a',64),'artifact:r',1,'publisher',0);
SELECT assert_rejected($s$INSERT INTO asset_aliases VALUES ('w','a','latest','r',1,0,0)$s$, '23503');
INSERT INTO asset_release_seals VALUES ('w','r','a',0,0);
INSERT INTO asset_aliases VALUES ('w','a','latest','r',1,0,0);
SELECT assert_rejected($s$INSERT INTO asset_aliases VALUES ('w','b','latest','r',1,0,0)$s$, '23503');
SELECT assert_rejected($s$INSERT INTO asset_aliases VALUES ('other','a','latest','r',1,0,0)$s$, '23503');
SELECT assert_rejected($s$UPDATE asset_releases SET manifest_ref='changed'$s$, 'P0001');
SELECT assert_rejected($s$DELETE FROM asset_releases$s$, 'P0001');
SELECT assert_rejected($s$INSERT INTO asset_releases VALUES ('w','r2','a','1', repeat('a',64),'artifact:r',1,'publisher',0)$s$, '23505');
INSERT INTO asset_releases VALUES ('w','r2','a','2', repeat('b',64),'artifact:r2',1,'publisher',0);
SELECT assert_rejected($s$INSERT INTO asset_release_dependencies VALUES ('w','r','skill','r2',0)$s$, 'P0001');
INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,created_at_ms,updated_at_ms) VALUES ('w','run','Run', repeat('c',64),'manifest:run',1,0,0);
INSERT INTO run_inputs VALUES ('w','run','skill','r',repeat('a',64),0);
SELECT assert_rejected($s$INSERT INTO run_inputs VALUES ('w','run','agent','r2',repeat('a',64),0)$s$, '23503');
UPDATE runs SET status='queued' WHERE run_id='run';
SELECT assert_rejected($s$UPDATE runs SET expected_case_count=2$s$, 'P0001');
SELECT assert_rejected($s$UPDATE runs SET plan_hash=repeat('d',64)$s$, 'P0001');
SELECT assert_rejected($s$UPDATE runs SET status='draft'$s$, 'P0001');
SELECT assert_rejected($s$INSERT INTO run_inputs VALUES ('w','run','judge','r',repeat('a',64),0)$s$, 'P0001');
INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,created_at_ms,updated_at_ms) VALUES ('w','item','run','case','evaluate',0,0);
INSERT INTO work_attempts VALUES ('w','attempt','item',1,1,'worker','running',10,0,NULL,NULL);
INSERT INTO result_receipts(workspace_id,receipt_id,run_id,case_key,work_item_id,attempt_id,receipt_key,result_id,content_hash,artifact_ref,created_at_ms) VALUES ('w','receipt','run','case','item','attempt','receipt-key','result',repeat('e',64),'artifact:result',0);
SELECT assert_rejected($s$INSERT INTO result_selections VALUES ('w','run','other-case','default','result',1,0)$s$, '23503');
SELECT assert_rejected($s$INSERT INTO result_selections VALUES ('w','run','case','other-judge','result',1,0)$s$, '23503');
INSERT INTO result_selections VALUES ('w','run','case','default','result',1,0);
INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES ('w','trace','native','n1','2026-11-11',0,0);
UPDATE trace_locators SET state='deleted';
SELECT assert_rejected($s$UPDATE trace_locators SET state='active'$s$, 'P0001');
SELECT assert_rejected($s$DELETE FROM trace_locators$s$, 'P0001');
SELECT assert_rejected($s$UPDATE asset_identities SET etag=0$s$, '23514');
SELECT 'storage core PostgreSQL contracts passed';
"""
        script = 'BEGIN;\nCREATE SCHEMA '+schema+';\nSET LOCAL search_path TO '+schema+';\n'+migration+'\n'+assertions+'\nROLLBACK;\n'
        result = subprocess.run(['docker','exec','-i',container,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'], input=script, text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('storage core PostgreSQL contracts passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
