import concurrent.futures
import hashlib
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
from urllib.parse import urlsplit

from services.storage.control import Conflict, StorageError
from services.storage.iam import IAMStore
from services.storage.mariadb import MariaDBControlStore, MariaDBPreflightError, mariadb_options
from services.storage.migrations import load_migrations
from services.storage.tests import test_authorized, test_iam, test_ingest_delivery
from services.storage.tests.test_storage_e2e import EndToEndFixture


REQUIRED_MODES = set(
    'PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ORACLE,NO_KEY_OPTIONS,NO_TABLE_OPTIONS,'
    'NO_FIELD_OPTIONS,STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER,SIMULTANEOUS_ASSIGNMENT'.split(',')
)
SOCKET = os.environ.get('STORAGE_MARIADB_TEST_SOCKET')
REASON = 'provide the admin socket of a dedicated MariaDB test instance running the required sql_mode'
ROOT = Path(__file__).resolve().parents[3]


class MariaDBConfigurationTests(unittest.TestCase):
    def test_invalid_dsn_cli_does_not_echo_password(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'connection.txt'
            file.touch(mode=0o600)
            password = 'synthetic-mariadb-password'
            file.write_text(f'mariadb://business:{password}@localhost：3306/insight')
            result = subprocess.run([sys.executable, '-B', '-m', 'services.storage', 'migration-plan',
                                     '--backend', 'mariadb', '--dsn-file', str(file), '--artifacts', directory],
                                    cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('invalid MariaDB URI', result.stderr)
        self.assertNotIn(password, result.stderr)

    def test_dsn_preserves_explicit_database_and_uses_verified_tls_by_default(self):
        options = mariadb_options('mariadb://business:p%40ss@db.example/Insight_UAT')
        self.assertEqual(options['database'], 'Insight_UAT')
        self.assertEqual(options['password'], b'p@ss')
        self.assertEqual(options['port'], 3306)
        self.assertTrue(options['ssl_verify_identity'])
        for dsn in ('mariadb://a:b@host/mysql', 'mariadb://a:b@host/db?sql_mode=',
                    'mariadb://a:b@host/db?sslmode=disable&sslmode=verify-full'):
            with self.subTest(dsn=dsn), self.assertRaises(ValueError):
                mariadb_options(dsn)


class MariaDBFixture:
    def make_store(self):
        import pymysql
        suffix = uuid.uuid4().hex
        database = 'insight_test_' + suffix
        account = 'insight_' + suffix
        secret = uuid.uuid4().hex

        def admin():
            return pymysql.connect(unix_socket=SOCKET, user='root', autocommit=True)

        def cleanup():
            with admin() as connection, connection.cursor() as cur:
                cur.execute(f'DROP DATABASE IF EXISTS {database}')
                cur.execute("DROP USER IF EXISTS %s@'127.0.0.1'", (account,))

        self.addCleanup(cleanup)
        with admin() as connection, connection.cursor() as cur:
            cur.execute('SELECT @@GLOBAL.sql_mode, @@SESSION.sql_mode, @@port')
            global_mode, session_mode, port = cur.fetchone()
            self.assertEqual(set(global_mode.split(',')), REQUIRED_MODES)
            self.assertEqual(set(session_mode.split(',')), REQUIRED_MODES)
            cur.execute(f'CREATE DATABASE {database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
            cur.execute("CREATE USER %s@'127.0.0.1' IDENTIFIED BY %s", (account, secret))
            cur.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, TRIGGER, REFERENCES ON {database}.* TO %s@'127.0.0.1'", (account,))

        self.mariadb_admin = admin
        self.mariadb_port = port
        self.mariadb_name = database
        self.mariadb_dsn = f'mariadb://{account}:{secret}@127.0.0.1:{port}/{database}?sslmode=disable'
        return MariaDBControlStore.from_dsn(self.mariadb_dsn, artifact_directory=Path(self.temp.name) / 'artifacts',
                                             clock=lambda: getattr(self, 'now', 100000))


@unittest.skipUnless(SOCKET, REASON)
class MariaDBMigrationTests(MariaDBFixture, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = self.make_store()

    def test_first_install_preserves_name_mode_and_relational_constraints(self):
        self.assertEqual(self.store.inspect(), 'empty')
        self.store.initialize()
        self.store.initialize()
        self.assertEqual(self.store.inspect(), 'ready')
        self.assertEqual(self.store.migration_plan()['current_version'], 21)
        with self.store.read_transaction() as con:
            row = con.execute('SELECT DATABASE(), @@GLOBAL.sql_mode, @@SESSION.sql_mode').fetchone()
            self.assertEqual(row[0], self.mariadb_name)
            self.assertEqual(set(row[1].split(',')), REQUIRED_MODES)
            self.assertEqual(set(row[2].split(',')), REQUIRED_MODES)
        runtime_user, runtime_password = 'runtime_' + uuid.uuid4().hex, uuid.uuid4().hex
        def cleanup_runtime():
            with self.mariadb_admin() as connection, connection.cursor() as cursor:
                cursor.execute("DROP USER IF EXISTS %s@'127.0.0.1'", (runtime_user,))

        self.addCleanup(cleanup_runtime)
        with self.mariadb_admin() as connection, connection.cursor() as cursor:
            cursor.execute("CREATE USER %s@'127.0.0.1' IDENTIFIED BY %s", (runtime_user, runtime_password))
            cursor.execute(f"GRANT SELECT ON {self.mariadb_name}.* TO %s@'127.0.0.1'", (runtime_user,))
        runtime_dsn = f'mariadb://{runtime_user}:{runtime_password}@127.0.0.1:{self.mariadb_port}/{self.mariadb_name}?sslmode=disable'
        preflight = runpy.run_path(str(ROOT / 'scripts/project-storage.py'))['transaction']
        config = {'control': {'backend': 'mariadb', 'dsn': runtime_dsn, 'artifacts': self.store.artifact_directory}}
        with self.assertRaisesRegex(MariaDBPreflightError, 'runtime account is missing privileges: DELETE, INSERT, UPDATE'):
            preflight(config)
        with self.mariadb_admin() as connection, connection.cursor() as cursor:
            cursor.execute(f"GRANT INSERT, UPDATE, DELETE ON {self.mariadb_name}.* TO %s@'127.0.0.1'", (runtime_user,))
        self.assertEqual(preflight(config)[1], 'ready')
        runtime = MariaDBControlStore.from_dsn(runtime_dsn, artifact_directory=self.store.artifact_directory)
        self.assertEqual(runtime.inspect(), 'ready')
        prefix = '😀' * 511
        workspace, asset = prefix + 'A', prefix + 'B'
        runtime.create_workspace(prefix + 'a', 'Case-sensitive key')
        runtime.create_workspace(workspace, '中文🙂')
        runtime.create_identity(workspace, asset, 'agent', '长键')
        runtime.publish_release(workspace, asset, prefix + 'C', 'v1', {'skill': '长键'})
        with self.assertRaises(Conflict):
            runtime.create_identity('missing workspace', 'asset', 'agent', 'invalid foreign key')
        with self.assertRaises(Conflict), runtime.transaction() as con:
            con.execute('DELETE FROM asset_releases WHERE workspace_id=? AND asset_id=?', (workspace, asset))
        with runtime.read_transaction() as con:
            count = con.execute('SELECT COUNT(*) FROM asset_releases').fetchone()[0]
            ordered = con.execute('SELECT workspace_id FROM workspaces ORDER BY workspace_id').fetchall()
        self.assertEqual(count, 1)
        self.assertEqual([item[0] for item in ordered], [workspace, prefix + 'a'])

    def test_upgrade_preserves_old_rows_and_checks_backup_evidence(self):
        known = load_migrations('mariadb')
        with patch('services.storage.mariadb.load_migrations', return_value=known[:20]):
            self.store.initialize()
        self.store.create_workspace('history', '历史记录🙂')
        self.store.create_identity('history', 'agent-1', 'agent', 'Saved Agent')
        self.store.publish_release('history', 'agent-1', 'release-1', 'v1', {'enabled': True})
        self.assertEqual(self.store.migration_plan()['current_version'], 20)
        IAMStore(self.store).create_principal('p', 'p', 'Principal')
        with self.store.transaction() as con:
            con.execute("INSERT INTO trace_locators(workspace_id,trace_id,source_namespace,native_trace_id,trace_bucket,created_at_ms,updated_at_ms) VALUES('history','trace-1','fixture','trace-1','2026-11-28',1,1)")
            con.execute("INSERT INTO ingest_batches(workspace_id,batch_id,principal_id,receipt_key,packet_hash,packet_ref,trace_ids_json,accepted_at_ms) VALUES('history','batch-1','p','receipt',?, 'payload', ?, 1)", ('a'*64, '["trace-1"]'))
            con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES('history','event-1','batch-1',1,'observability.otlp.accepted.v1','{}',1,1)")
        path = Path(self.temp.name) / 'verified-test-dump.sql'
        path.touch(mode=0o600)
        with self.store.read_transaction() as con:
            row = con.execute('SELECT * FROM workspaces WHERE workspace_id=?', ('history',)).fetchone()
            snapshot = repr(tuple(row)).encode()
        path.write_bytes(snapshot)
        manifest = dict(backend='mariadb', schema=self.mariadb_name, restore_verified=True, writers_stopped=True,
                        operator='integration fixture', path=str(path), sha256=hashlib.sha256(snapshot).hexdigest(),
                        created_at_ms=100000, source_evidence=self.store.source_evidence())
        self.store.create_workspace('after-backup', 'Changed after backup')
        with self.assertRaisesRegex(StorageError, 'locked source'):
            self.store.migrate(backup_manifest=manifest)
        manifest['source_evidence'] = self.store.source_evidence()
        self.assertEqual(self.store.migrate(backup_manifest=manifest)['current_version'], 21)
        with self.store.read_transaction() as con:
            self.assertEqual(tuple(con.execute('SELECT * FROM workspaces WHERE workspace_id=?', ('history',)).fetchone()), tuple(row))
            self.assertEqual(con.execute('SELECT release_id FROM asset_releases').fetchone()[0], 'release-1')
            self.assertEqual(tuple(con.execute('SELECT batch_id,event_id FROM ingest_deliveries').fetchone()), ('batch-1', 'event-1'))
            self.assertEqual(tuple(con.execute('SELECT batch_id,trace_id FROM ingest_batch_traces').fetchone()), ('batch-1', 'trace-1'))

    def test_empty_database_requires_migration_grants_before_fencing(self):
        account = urlsplit(self.mariadb_dsn).username
        with self.mariadb_admin() as connection, connection.cursor() as cursor:
            cursor.execute(f"REVOKE CREATE ON {self.mariadb_name}.* FROM %s@'127.0.0.1'", (account,))
        with self.assertRaisesRegex(MariaDBPreflightError, 'migration account is missing privileges: CREATE'):
            self.store.initialize()
        with self.store._connect() as connection:
            self.assertFalse(self.store._objects(connection))

    def test_failed_ddl_fences_a_partial_schema(self):
        def fail(migration):
            yield 'CREATE TABLE partial_install (id INT)'
            yield 'ALTER TABLE missing_table ADD bad_column INT'

        with patch('services.storage.mariadb.migration_statements', side_effect=fail):
            with self.assertRaises(StorageError):
                self.store.initialize()
        for operation in (self.store.inspect, self.store.initialize, self.store.migration_plan):
            with self.assertRaisesRegex(StorageError, 'migration was interrupted'):
                operation()

    def test_concurrent_claims_and_rollback(self):
        self.store.initialize()
        self.store.create_workspace('w', 'Workspace')
        self.store.create_identity('w', 'agent', 'agent', 'Test Agent')
        self.store.publish_release('w', 'agent', 'release', 'v1', {'enabled': True})
        self.store.create_run('w', 'run', {'agent': 'release'}, {}, expected_case_count=1)
        self.store.enqueue('w', 'item', 'run', 'case')
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            claims = list(pool.map(lambda n: self.store.claim('w', f'worker-{n}', lease_ms=1000), range(4)))
        self.assertEqual(sum(value is not None for value in claims), 1)
        iam = IAMStore(self.store)
        iam.create_principal('alice', 'alice', 'Alice')
        iam.set_password('alice', 'test password for local instance')
        self.assertTrue(iam.login('ALICE', 'test password for local instance'))


@unittest.skipUnless(SOCKET, REASON)
class MariaDBBinlogTests(MariaDBFixture, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = self.make_store()
        with self.mariadb_admin() as connection, connection.cursor() as cursor:
            cursor.execute('SELECT @@GLOBAL.log_bin, @@GLOBAL.binlog_format, @@GLOBAL.log_bin_trust_function_creators')
            self.logging, self.format, self.trust = cursor.fetchone()

    def test_requires_dba_for_triggers_without_writing_migration_marker(self):
        if not self.logging or self.trust or self.format == 'STATEMENT':
            self.skipTest('requires log_bin ON, trust OFF and ROW or MIXED')
        for operation in (self.store.inspect, self.store.initialize):
            with self.assertRaisesRegex(MariaDBPreflightError, 'requires DBA privileges \\(SUPER\\)'):
                operation()
        with self.store._connect() as connection:
            self.assertFalse(self.store._objects(connection))
        account = urlsplit(self.mariadb_dsn).username
        with self.mariadb_admin() as connection, connection.cursor() as cursor:
            cursor.execute("GRANT SUPER ON *.* TO %s@'127.0.0.1'", (account,))
        self.store.initialize()
        with self.mariadb_admin() as connection, connection.cursor() as cursor:
            cursor.execute("REVOKE SUPER ON *.* FROM %s@'127.0.0.1'", (account,))
        self.assertEqual(self.store.inspect(), 'ready')
        self.store.create_workspace('workspace', 'Workspace')
        IAMStore(self.store).create_principal('principal', 'principal', 'Principal')
        self.assertEqual(self.store.migration_plan()['current_version'], 21)

    def test_statement_binlog_is_rejected_before_ddl(self):
        if not self.logging or self.format != 'STATEMENT':
            self.skipTest('requires log_bin ON and STATEMENT')
        for operation in (self.store.inspect, self.store.initialize):
            with self.assertRaisesRegex(MariaDBPreflightError, 'binlog_format=STATEMENT'):
                operation()
        with self.store._connect() as connection:
            self.assertFalse(self.store._objects(connection))


@unittest.skipUnless(SOCKET, REASON)
class MariaDBIAMTests(MariaDBFixture, test_iam.IAMTests):
    pass


@unittest.skipUnless(SOCKET, REASON)
class MariaDBAuthorizedTests(MariaDBFixture, test_authorized.AuthorizedTests):
    pass


@unittest.skipUnless(SOCKET, REASON)
class MariaDBIngestDeliveryTests(MariaDBFixture, test_ingest_delivery.DeliveryTests):
    def make_control(self):
        self.temp = self.tmp
        return self.make_store()


@unittest.skipUnless(SOCKET and os.environ.get('STORAGE_TEST_CLICKHOUSE_URL'), REASON + ' and a test ClickHouse origin')
class MariaDBEndToEndTests(MariaDBFixture, EndToEndFixture, unittest.TestCase):
    pass
