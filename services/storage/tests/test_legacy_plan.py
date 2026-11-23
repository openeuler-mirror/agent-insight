import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]


class LegacyPlanTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.find_spec('services.storage.legacy_plan')
        self.assertIsNotNone(spec, 'strict read-only legacy semantic planner is missing')
        from services.storage.legacy_plan import plan_database, load_catalog
        self.plan = plan_database
        self.catalog = load_catalog()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'source.sqlite'
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)

    def model(self, name):
        return next(m for m in self.catalog['models'] if m['model'] == name)

    def table(self, name):
        model = self.model(name)
        q = lambda s: '"' + s.replace('"', '""') + '"'
        columns = [q(c['column']) + ' ' + c['sqlite_type'] + (' NOT NULL' if c['required'] else '') for c in model['columns']]
        columns.append('PRIMARY KEY (' + ','.join(q(c) for c in model['primary_key']) + ')')
        columns.extend('UNIQUE (' + ','.join(q(c) for c in key) + ')' for key in model['unique_keys'])
        self.db.execute('CREATE TABLE ' + q(model['table']) + '(' + ','.join(columns) + ')')
        return model

    def row(self, name, **values):
        model = self.model(name)
        record = {}
        for c in model['columns']:
            if c['required']:
                record[c['column']] = 1 if c['sqlite_type'] in {'INTEGER', 'BIGINT', 'BOOLEAN', 'REAL', 'DATETIME'} else 'fixture-' + c['column']
        record.update(values)
        q = lambda s: '"' + s.replace('"', '""') + '"'
        self.db.execute('INSERT INTO ' + q(model['table']) + '(' + ','.join(q(k) for k in record) + ') VALUES (' + ','.join('?' for _ in record) + ')', tuple(record.values()))
        self.db.commit()

    def run_plan(self, **kwargs):
        self.db.commit()
        return self.plan(self.path, source_id='stable-source', **kwargs)

    def codes(self, plan):
        return {i['code'] for i in plan['issues']}

    def test_catalog_matches_installed_prisma_dmmf_and_physical_aliases(self):
        node = shutil.which('node')
        self.assertIsNotNone(node)
        result = subprocess.run([node, str(ROOT / 'scripts/generate-legacy-catalog.cjs'), '--check'], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.catalog['models']), 96)
        self.assertEqual(self.model('SkillGeneratorSession')['table'], 'PlaygroundSession')
        self.assertEqual(next(c for c in self.model('CollaborationEvent')['columns'] if c['field'] == 'eventBodyJson')['column'], 'bodyJson')
        self.table('SkillGeneratorSession')
        self.table('CollaborationEvent')
        plan = self.run_plan()
        self.assertNotIn('unknown_table', self.codes(plan))
        self.assertEqual(plan['mode'], 'planning-only')
        self.assertFalse(plan['full_migration_ready'])

    def test_real_prisma_96_table_fixture_has_no_schema_drift(self):
        result = subprocess.run([
            shutil.which('node'), str(ROOT / 'node_modules/prisma/build/index.js'),
            'db', 'push', '--schema', str(ROOT / 'prisma/schema.prisma'), '--skip-generate',
        ], cwd=ROOT, env={**os.environ, 'DATABASE_URL': 'file:' + str(self.path),
                          'AGENT_INSIGHT_HOME': self.temp.name, 'CHECKPOINT_DISABLE': '1'},
            capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = self.run_plan()
        self.assertTrue(plan['scan_complete'])
        self.assertEqual(len(plan['tables']), 96)
        self.assertEqual(plan['issue_counts'], {})
        self.assertFalse(plan['full_migration_ready'])

    def test_stale_catalog_binding_is_rejected_before_source_scan(self):
        from services.storage.legacy import LegacyValidationError
        from services.storage.legacy_plan import load_catalog
        stale = {**self.catalog, 'schema_sha256': '0' * 64}
        with patch('services.storage.legacy_plan.Path.read_text', return_value=json.dumps(stale)):
            with self.assertRaisesRegex(LegacyValidationError, 'catalog'):
                load_catalog()

    def test_source_native_identity_is_not_an_execution_fk_but_duplicates_block(self):
        self.table('User'); self.table('Execution')
        self.row('User', id='u', username='alice')
        self.row('Execution', id='first', user='alice', framework='opencode', sourceExecutionId='native-turn')
        first = self.run_plan(bindings={'alice': {'principal_id': 'p', 'workspace_id': 'w'}})
        self.assertNotIn('ambiguous_native_source_identity', self.codes(first))
        self.row('Execution', id='second', user='alice', framework='opencode', sourceExecutionId='native-turn')
        self.assertIn('ambiguous_native_source_identity', self.codes(self.run_plan()))

    def test_runtime_value_types_and_private_schema_defaults_do_not_escape(self):
        self.table('User')
        self.row('User', id='u', username='alice', createdAt=b'PRIVATE-BLOB')
        self.db.execute("CREATE TABLE SecretDefaults(v TEXT DEFAULT 'PRIVATE-SCHEMA-DEFAULT')")
        plan = self.run_plan()
        self.assertIn('row_value_type_mismatch', self.codes(plan))
        self.assertNotIn('PRIVATE-', json.dumps(plan))

    def test_large_schema_and_row_budgets_stop_with_no_complete_content_fingerprint(self):
        self.db.execute('CREATE TABLE BigSchema(v TEXT DEFAULT ' + "'" + 'x' * 10000 + "')")
        result = self.run_plan(max_row_bytes=1024)
        self.assertFalse(result['scan_complete'])
        self.assertIsNone(result['source_content_sha256'])
        self.assertIn('schema_byte_budget_exceeded', self.codes(result))

    def test_cross_owner_and_parent_cycles_are_not_silently_accepted(self):
        self.table('User'); self.table('Execution')
        self.row('User', id='a', username='alice', apiKey='key-a')
        self.row('User', id='b', username='bob', apiKey='key-b')
        self.row('Execution', id='a', user='alice', parentExecutionId='b')
        self.row('Execution', id='b', user='bob', parentExecutionId='a')
        plan = self.run_plan()
        self.assertIn('cross_owner_reference', self.codes(plan))
        self.assertIn('execution_parent_cycle', self.codes(plan))

    def test_unknown_columns_missing_columns_type_and_primary_key_drift_block(self):
        self.db.executescript('CREATE TABLE User(id INTEGER, username TEXT, apiKey TEXT, futureSecret TEXT); CREATE TABLE UnrecognizedThing(v BLOB);')
        plan = self.run_plan()
        self.assertTrue({'unknown_table', 'unknown_column', 'missing_column', 'column_type_drift', 'primary_key_drift'} <= self.codes(plan))
        self.assertEqual(plan['status'], 'blocked')

    def test_owner_mapping_normalization_collisions_and_no_secrets(self):
        self.table('User'); self.table('Execution')
        self.row('User', id='user-one', username='Alice', apiKey='TOP-SECRET-ONE')
        self.row('User', id='user-two', username='Ａlice', apiKey='TOP-SECRET-TWO')
        self.row('Execution', id='trace-one', user='MissingOwner', query='PRIVATE-QUERY')
        plan = self.run_plan(bindings={'Alice': {'principal_id': 'p', 'workspace_id': 'w'}})
        self.assertTrue({'login_collision', 'owner_not_registered', 'owner_unmapped'} <= self.codes(plan))
        serialized = json.dumps(plan)
        for secret in ('Alice', 'Ａlice', 'MissingOwner', 'TOP-SECRET', 'PRIVATE-QUERY', 'trace-one'):
            self.assertNotIn(secret, serialized)

    def test_declared_and_logical_orphans_are_reported_without_changing_export_policy(self):
        self.table('Execution'); self.table('TraceThread'); self.table('User')
        self.row('User', id='u', username='alice')
        self.row('Execution', id='orphan-trace', user='alice', parentExecutionId='absent', rootExecutionId='absent', sourceExecutionId='absent', traceThreadId='absent')
        self.db.executescript('CREATE TABLE ExtraParent(id TEXT PRIMARY KEY); CREATE TABLE ExtraChild(id TEXT REFERENCES ExtraParent(id)); INSERT INTO ExtraChild VALUES ("orphan");')
        plan = self.run_plan(bindings={'alice': {'principal_id': 'p', 'workspace_id': 'w'}})
        self.assertTrue({'foreign_key_orphan', 'logical_reference_orphan'} <= self.codes(plan))
        self.assertTrue({'parentExecutionId', 'rootExecutionId'} <= {i.get('field') for i in plan['issues'] if i['code'] == 'logical_reference_orphan'})
        self.assertIn('traceThreadId', {i.get('field') for i in plan['issues'] if i['code'] == 'declared_reference_orphan'})
        self.assertNotIn('sourceExecutionId', {i.get('field') for i in plan['issues'] if i['code'] in {'logical_reference_orphan', 'declared_reference_orphan'}})
        from services.storage.legacy import inventory_database, LegacyValidationError
        with self.assertRaises(LegacyValidationError): inventory_database(self.path)

    def test_unknown_json_is_private_and_row_accounting_preserves_every_row(self):
        self.table('UserSettings')
        self.row('UserSettings', id='setting', user='alice', settingsJson='{"token":"private-token"}')
        plan = self.run_plan()
        table = next(t for t in plan['tables'] if t.get('model') == 'UserSettings')
        column = next(c for c in table['field_coverage'] if c['field'] == 'settingsJson')
        self.assertEqual(column['handling'], 'private_pending_conversion')
        self.assertEqual(sum(plan['row_accounting'][k] for k in ('limited_trace_candidate', 'pending_conversion', 'raw_retained')), plan['row_accounting']['scanned_rows'])
        self.assertNotIn('private-token', json.dumps(plan))

    def test_wal_snapshot_is_deterministic_and_preserves_source_bytes_and_mtime(self):
        self.db.execute('PRAGMA journal_mode=WAL')
        self.table('User'); self.row('User', id='u', username='alice')
        paths = [self.path, Path(str(self.path) + '-wal')]
        before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in paths]
        bindings = {'alice': {'principal_id': 'p', 'workspace_id': 'w'}}
        first = self.run_plan(bindings=bindings); second = self.run_plan(bindings=bindings)
        self.assertEqual(first['plan_sha256'], second['plan_sha256'])
        self.assertEqual(before, [(p.read_bytes(), p.stat().st_mtime_ns) for p in paths])
        self.assertEqual(first['row_accounting']['scanned_rows'], 1)
        self.assertNotEqual(first['mapping_sha256'], self.run_plan()['mapping_sha256'])

    def test_mapping_hash_ignores_json_object_key_order(self):
        self.table('User'); self.row('User', id='u', username='alice')
        first = self.run_plan(bindings={'alice': {'principal_id': 'p', 'workspace_id': 'w'}})
        second = self.run_plan(bindings={'alice': {'workspace_id': 'w', 'principal_id': 'p'}})
        self.assertEqual(first['mapping_sha256'], second['mapping_sha256'])
        self.assertEqual(first['plan_sha256'], second['plan_sha256'])

    def test_budgets_produce_incomplete_blocked_plan_and_bounded_issues(self):
        self.table('User')
        self.row('User', id='u1', username='alice', apiKey='key1'); self.row('User', id='u2', username='bob', apiKey='key2')
        plan = self.run_plan(max_rows=1, max_issues=2)
        self.assertFalse(plan['scan_complete'])
        self.assertEqual(plan['status'], 'blocked')
        self.assertLessEqual(len(plan['issues']), 2)
        self.assertGreater(plan['issue_count'], len(plan['issues']))

    def test_incomplete_snapshot_does_not_invent_semantic_orphans_from_unscanned_parents(self):
        self.table('Execution');self.table('User')
        self.row('Execution',id='e',user='alice');self.row('User',id='u',username='alice')
        plan=self.run_plan(max_rows=1)
        self.assertFalse(plan['scan_complete'])
        self.assertNotIn('owner_not_registered',plan['issue_counts'])
        self.assertNotIn('logical_reference_orphan',plan['issue_counts'])
        self.assertEqual(plan['coverage']['semantic_diagnostics'],'not_run_incomplete_snapshot')

    def test_final_analysis_deadline_is_checked_after_the_last_row(self):
        from services.storage import legacy_plan
        self.table('User');self.row('User',id='u',username='alice')
        clock=[0.0];original=legacy_plan._valid_value
        def slow_column(column,value):
            clock[0]=2.0
            return original(column,value)
        with patch.object(legacy_plan.time,'monotonic',lambda:clock[0]),patch.object(legacy_plan,'_valid_value',slow_column):
            plan=self.run_plan(max_seconds=1)
        self.assertFalse(plan['scan_complete']);self.assertIsNone(plan['source_content_sha256'])
        self.assertIn('analysis_time_budget_exceeded',plan['issue_counts'])

    def test_cli_requires_explicit_source_and_does_not_leak_bindings(self):
        self.table('User'); self.row('User', id='u', username='alice', apiKey='DO-NOT-PRINT')
        args = [sys.executable, '-m', 'services.storage', 'plan-legacy', '--database', str(self.path)]
        missing = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        result = subprocess.run(args + ['--source-id', 'explicit-source'], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan['mode'], 'planning-only')
        self.assertFalse(plan['full_migration_ready'])
        self.assertNotIn('DO-NOT-PRINT', result.stdout + result.stderr)
