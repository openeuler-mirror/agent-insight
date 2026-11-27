import concurrent.futures
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from services.storage.control import Conflict, StorageError
from services.storage.iam import IAMStore
from services.storage.mariadb import MariaDBControlStore, mariadb_options
from services.storage.migrations import load_migrations
from services.storage.tests import test_authorized, test_iam
from services.storage.tests.test_storage_e2e import EndToEndFixture


REQUIRED_MODES = set(
    'PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ORACLE,NO_KEY_OPTIONS,NO_TABLE_OPTIONS,'
    'NO_FIELD_OPTIONS,STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER,SIMULTANEOUS_ASSIGNMENT'.split(',')
)
SOCKET = os.environ.get('STORAGE_MARIADB_TEST_SOCKET')
REASON = 'provide the admin socket of a dedicated MariaDB test instance running the required sql_mode'


class MariaDBConfigurationTests(unittest.TestCase):
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
        self.assertEqual(self.store.migration_plan()['current_version'], 20)
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
            cursor.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {self.mariadb_name}.* TO %s@'127.0.0.1'", (runtime_user,))
        runtime_dsn = f'mariadb://{runtime_user}:{runtime_password}@127.0.0.1:{self.mariadb_port}/{self.mariadb_name}?sslmode=disable'
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
        with patch('services.storage.mariadb.load_migrations', return_value=known[:12]):
            self.store.initialize()
        self.store.create_workspace('history', '历史记录🙂')
        self.store.create_identity('history', 'agent-1', 'agent', 'Saved Agent')
        self.store.publish_release('history', 'agent-1', 'release-1', 'v1', {'enabled': True})
        self.assertEqual(self.store.migration_plan()['current_version'], 12)
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
        self.assertEqual(self.store.migrate(backup_manifest=manifest)['current_version'], 20)
        with self.store.read_transaction() as con:
            self.assertEqual(tuple(con.execute('SELECT * FROM workspaces WHERE workspace_id=?', ('history',)).fetchone()), tuple(row))
            self.assertEqual(con.execute('SELECT release_id FROM asset_releases').fetchone()[0], 'release-1')

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
class MariaDBIAMTests(MariaDBFixture, test_iam.IAMTests):
    pass


@unittest.skipUnless(SOCKET, REASON)
class MariaDBAuthorizedTests(MariaDBFixture, test_authorized.AuthorizedTests):
    pass


@unittest.skipUnless(SOCKET and os.environ.get('STORAGE_TEST_CLICKHOUSE_URL'), REASON + ' and a test ClickHouse origin')
class MariaDBEndToEndTests(MariaDBFixture, EndToEndFixture, unittest.TestCase):
    pass
