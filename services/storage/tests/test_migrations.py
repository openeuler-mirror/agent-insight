from contextlib import closing
import hashlib
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from services.storage.control import SQLiteControlStore, StorageError


class MigrationTests(unittest.TestCase):
    def setUp(self):
        import importlib.util
        self.assertIsNotNone(importlib.util.find_spec('services.storage.migrations'), 'versioned migrations are missing')
        from services.storage import migrations
        self.api = migrations
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.schema = self.directory / 'schema'
        (self.schema / 'sqlite').mkdir(parents=True)
        source = Path(__file__).resolve().parents[1] / 'schema/sqlite/001_core.sql'
        shutil.copyfile(source, self.schema / 'sqlite/001_core.sql')
        self.patcher = patch.object(migrations, 'SCHEMA_ROOT', self.schema)
        self.patcher.start(); self.addCleanup(self.patcher.stop)
        self.path = self.directory / 'core.db'
        self.store = SQLiteControlStore(self.path, clock=lambda: 1000)

    def add_002(self, sql='CREATE TABLE migration_probe(id TEXT PRIMARY KEY);'):
        (self.schema / 'sqlite/002_probe.sql').write_text(sql)

    def test_new_initialization_applies_latest_known_prefix(self):
        self.add_002()
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as con:
            self.assertEqual(con.execute('SELECT version,name FROM schema_meta ORDER BY version').fetchall(), [(1,'core'),(2,'probe')])

    def test_existing_001_remains_readable_without_implicit_upgrade(self):
        self.store.initialize()
        self.add_002()
        self.store.initialize()
        self.store.create_workspace('w','Workspace')
        self.assertEqual(self.store.migration_plan()['current_version'],1)
        self.assertEqual(self.store.migration_plan()['target_version'],2)

    def test_explicit_migration_takes_verified_private_backup(self):
        self.store.initialize(); self.store.create_workspace('w','Workspace'); self.add_002()
        backup = self.directory / 'pre-002.db'
        result = self.store.migrate(backup_path=backup)
        self.assertEqual(result['current_version'],2)
        self.assertEqual(result['backup_sha256'],hashlib.sha256(backup.read_bytes()).hexdigest())
        self.assertEqual(backup.stat().st_mode & 0o777,0o600)
        with closing(sqlite3.connect(backup)) as con:
            self.assertEqual(con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],1)
            self.assertEqual(con.execute('SELECT name FROM workspaces').fetchone()[0],'Workspace')
        self.store.create_workspace('new','New')

    def test_backup_destination_cannot_be_overwritten(self):
        self.store.initialize(); self.add_002()
        backup=self.directory/'backup.db'; backup.write_bytes(b'keep')
        with self.assertRaises((FileExistsError,StorageError)):
            self.store.migrate(backup_path=backup)
        self.assertEqual(backup.read_bytes(),b'keep')
        self.assertEqual(self.store.migration_plan()['current_version'],1)

    def test_all_pending_migrations_are_atomic_on_failure(self):
        self.store.initialize(); self.add_002()
        (self.schema/'sqlite/003_broken.sql').write_text('CREATE TABLE partial(id TEXT); INSERT INTO missing VALUES(1);')
        with self.assertRaises(StorageError):
            self.store.migrate(backup_path=self.directory/'backup.db')
        with closing(sqlite3.connect(self.path)) as con:
            self.assertEqual(con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],1)
            self.assertIsNone(con.execute("SELECT name FROM sqlite_master WHERE name IN ('partial','migration_probe')").fetchone())

    def test_checksum_drift_and_future_or_gap_refuse_writes(self):
        self.store.initialize(); self.add_002()
        with closing(sqlite3.connect(self.path)) as con:
            con.execute("UPDATE schema_meta SET checksum='bad'");con.commit()
        with self.assertRaises(StorageError): self.store.migration_plan()
        with self.assertRaises(StorageError): self.store.create_workspace('w','Workspace')

    def test_migration_source_directory_gap_is_rejected(self):
        self.store.initialize()
        (self.schema/'sqlite/003_gap.sql').write_text('CREATE TABLE gap(id TEXT);')
        with self.assertRaises(StorageError): self.store.migration_plan()

    def test_database_history_gap_or_future_is_rejected(self):
        self.store.initialize(); self.add_002()
        with closing(sqlite3.connect(self.path)) as con:
            con.execute("INSERT INTO schema_meta VALUES (3,'future','x',1000)");con.commit()
        with self.assertRaises(StorageError): self.store.migration_plan()

    def test_transaction_control_is_not_allowed_inside_migration(self):
        self.store.initialize(); self.add_002('COMMIT; CREATE TABLE unsafe(id TEXT);')
        with self.assertRaises(StorageError):
            self.store.migrate(backup_path=self.directory/'backup.db')
        self.assertEqual(self.store.migration_plan()['current_version'],1)

    def test_source_changes_after_backup_block_upgrade(self):
        from services.storage import legacy
        self.store.initialize(); self.add_002()
        original=legacy.inventory_database
        injected=False
        def inventory(path):
            nonlocal injected
            result=original(path)
            if Path(path).name=='backup.db' and not injected:
                injected=True
                self.store.create_workspace('late','Concurrent write')
            return result
        with patch.object(legacy,'inventory_database',side_effect=inventory):
            with self.assertRaises(StorageError):
                self.store.migrate(backup_path=self.directory/'backup.db')
        self.assertTrue(injected)
        self.assertEqual(self.store.migration_plan()['current_version'],1)
        with closing(sqlite3.connect(self.path)) as con:
            self.assertEqual(con.execute('SELECT name FROM workspaces').fetchone()[0],'Concurrent write')

    def test_cli_plans_and_explicit_upgrade_report_actual_version(self):
        from contextlib import redirect_stdout
        import io
        import json
        from services.storage.__main__ import main
        self.store.initialize(); self.add_002()
        out=io.StringIO()
        with redirect_stdout(out):
            code=main(['migration-plan','--backend','sqlite','--database',str(self.path)])
        self.assertEqual(code,0)
        self.assertEqual(json.loads(out.getvalue())['current_version'],1)
        out=io.StringIO()
        with redirect_stdout(out):
            code=main(['migrate-sqlite','--database',str(self.path),'--backup',str(self.directory/'backup.db')])
        self.assertEqual(code,0)
        self.assertEqual(json.loads(out.getvalue())['current_version'],2)

    def test_cli_missing_target_does_not_initialize_and_dsn_is_private(self):
        from contextlib import redirect_stderr
        import io
        from services.storage.__main__ import main
        error=io.StringIO()
        with redirect_stderr(error):
            code=main(['migration-plan','--backend','sqlite','--database',str(self.path)])
        self.assertEqual(code,1); self.assertFalse(self.path.exists())
        dsn=self.directory/'dsn';dsn.write_text('password=HIDDEN');dsn.chmod(0o644)
        error=io.StringIO()
        with redirect_stderr(error):
            code=main(['init-relational','--backend','postgresql','--dsn-file',str(dsn),'--schema','storage_test','--artifacts',str(self.directory/'artifacts')])
        self.assertEqual(code,1);self.assertNotIn('HIDDEN',error.getvalue())

    def test_read_transaction_is_readonly_and_does_not_block_wal_writer(self):
        import concurrent.futures
        self.store.initialize(); self.store.create_workspace('before','Before')
        self.assertTrue(callable(getattr(self.store,'read_transaction',None)),'read-only transaction context is missing')
        with self.store.read_transaction() as reader:
            self.assertEqual(reader.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],1)
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future=pool.submit(self.store.create_workspace,'after','After')
                future.result(timeout=2)
            self.assertEqual(reader.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],1)
        with self.store.read_transaction() as reader:
            self.assertEqual(reader.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],2)
        with self.assertRaises(StorageError):
            with self.store.read_transaction() as reader:
                reader.execute("INSERT INTO workspaces VALUES('bad','Bad','active',1,1)")

    def test_read_transaction_accepts_old_known_prefix_without_upgrade(self):
        self.store.initialize();self.add_002()
        self.assertTrue(callable(getattr(self.store,'read_transaction',None)),'read-only transaction context is missing')
        with self.store.read_transaction() as reader:
            self.assertEqual(reader.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],1)
        self.assertEqual(self.store.migration_plan()['current_version'],1)

    def test_server_migration_rejects_top_level_commit_but_allows_function_body(self):
        from services.storage.migrations import apply, MigrationError
        directory=self.schema/'postgresql';directory.mkdir()
        (directory/'001_probe.sql').write_text("CREATE FUNCTION f() RETURNS VOID AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql; COMMIT; CREATE TABLE bad(id TEXT);")
        class Connection:
            def __init__(self): self.statements=[]
            def execute(self,sql,params=None): self.statements.append(sql)
        connection=Connection()
        with self.assertRaises(MigrationError): apply(connection,'postgresql',clock=lambda:1)
        self.assertEqual(connection.statements,[])
        (directory/'001_probe.sql').write_text("CREATE FUNCTION f() RETURNS VOID AS $body$ BEGIN PERFORM 1; END; $body$ LANGUAGE plpgsql; -- COMMIT;\nCREATE TABLE good(id TEXT);")
        apply(connection,'postgresql',clock=lambda:1)
        self.assertEqual(len(connection.statements),2)

    def test_server_guard_cannot_hide_commit_behind_nested_comments(self):
        from services.storage.migrations import guard_server_transaction, MigrationError
        with self.assertRaises(MigrationError):
            guard_server_transaction('/* outside /* inside */ harmless */ COMMIT;')

    def test_declared_backup_must_be_sibling_of_source(self):
        self.store.initialize(); self.add_002()
        other=self.directory/'other';other.mkdir()
        with self.assertRaises(StorageError): self.store.migrate(backup_path=other/'backup.db')



class ProjectMigrationTests(unittest.TestCase):
    def setUp(self):
        from services.storage import migrations
        self.api=migrations
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name)
        self.root=Path(migrations.__file__).parent/'schema'

    def old_store(self, version):
        path=self.directory/f'old-{version}.db';path.touch(mode=0o600)
        with closing(sqlite3.connect(path,isolation_level=None)) as con:
            con.execute('PRAGMA foreign_keys=ON');con.execute('PRAGMA journal_mode=WAL');con.execute('BEGIN')
            for migration in self.api.load_migrations('sqlite')[:version]:
                for statement in self.api.sqlite_statements(migration.sql): con.execute(statement)
                con.execute('INSERT INTO schema_meta VALUES(?,?,?,?)',(migration.version,migration.name,migration.checksum,1000))
            con.commit()
        store=SQLiteControlStore(path,clock=lambda:1000)
        store.create_workspace('w','Existing')
        store.create_identity('w','agent','agent','Agent')
        store.publish_release('w','agent','release','v1',{'prompt':'preserved'})
        store.create_run('w','run',{'agent':'release'},{'seed':1},expected_case_count=1)
        return store

    def test_new_workspace_mapping_and_disabled_default_are_atomic(self):
        store=SQLiteControlStore(self.directory/'new.db');store.initialize();store.create_workspace('w','Workspace')
        with store.read_transaction() as con:
            self.assertEqual(tuple(con.execute('SELECT workspace_id,project_id FROM project_workspaces').fetchone()),('w','default'))
        with store.transaction() as con: con.execute("UPDATE projects SET status='disabled' WHERE project_id='default'")
        with self.assertRaises(StorageError): store.create_workspace('blocked','Blocked')
        with store.read_transaction() as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM workspaces WHERE workspace_id='blocked'").fetchone()[0],0)

    def test_001_and_002_upgrade_backfills_and_preserves_old_data(self):
        from services.storage.iam import IAMStore
        for version in (1,2):
            with self.subTest(version=version):
                store=self.old_store(version)
                tables=['workspaces','asset_releases','runs','schema_meta']
                if version>=2:
                    import json
                    parameters=json.dumps({'iterations':600000,'salt':'00'*32})
                    password_hash=hashlib.pbkdf2_hmac('sha256',b'test migration passphrase 2026',bytes(32),600000).hex()
                    with store.transaction() as con:
                        con.execute("INSERT INTO iam_principals VALUES(?,?,?,'active',2,?,?)",('owner','owner','Owner',1000,1000))
                        con.execute('INSERT INTO iam_password_credentials VALUES(?,?,?,?,1,?)',('owner',password_hash,'pbkdf2-sha256',parameters,1000))
                        con.execute("INSERT INTO iam_workspace_bindings VALUES(?,'personal',NULL,?,1,?,?)",('w','owner',1000,1000))
                        con.execute("INSERT INTO iam_resource_access VALUES(?,'trace',?,?,'private',1,?,?)",('w','trace','owner',1000,1000))
                    tables+=['iam_principals','iam_password_credentials','iam_workspace_bindings','iam_resource_access']
                with store.read_transaction() as con: before={name:[tuple(r) for r in con.execute('SELECT * FROM '+name)] for name in tables}
                store.initialize()
                self.assertEqual(store.migration_plan()['current_version'],version)
                result=store.migrate(backup_path=self.directory/f'before-{version}.db')
                self.assertEqual(result['current_version'],len(self.api.load_migrations('sqlite')))
                with store.read_transaction() as con:
                    for name,rows in before.items():
                        actual=[tuple(r) for r in con.execute('SELECT * FROM '+name)]
                        self.assertEqual(actual[:version] if name=='schema_meta' else actual,rows,name)
                    self.assertEqual(con.execute("SELECT project_id FROM project_workspaces WHERE workspace_id='w'").fetchone()[0],'default')
                if version >= 2:
                    iam=IAMStore(store)
                    token=iam.login('owner','test migration passphrase 2026')
                    iam.authorize(token,'w','read','trace','trace')
                with closing(sqlite3.connect(result['backup_path'])) as con:
                    self.assertEqual(con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],version)

    def test_failed_003_rolls_back_projects_and_backfill(self):
        store=self.old_store(2)
        broken=self.directory/'broken'/'sqlite';broken.mkdir(parents=True)
        for filename in ('001_core.sql','002_iam.sql'): shutil.copyfile(self.root/'sqlite'/filename,broken/filename)
        (broken/'003_projects.sql').write_text((self.root/'sqlite/003_projects.sql').read_text()+'\nINSERT INTO missing_project_target VALUES(1);')
        with patch.object(self.api,'SCHEMA_ROOT',broken.parent):
            with self.assertRaises(StorageError): store.migrate(backup_path=self.directory/'failed-003.db')
            self.assertEqual(store.migration_plan()['current_version'],2)
        with store.read_transaction() as con:
            self.assertIsNone(con.execute("SELECT name FROM sqlite_master WHERE name IN ('projects','project_workspaces')").fetchone())
            self.assertEqual(con.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],1)

    def test_workspace_creation_rolls_back_if_project_mapping_write_fails(self):
        store=SQLiteControlStore(self.directory/'mapping-failure.db');store.initialize()
        with store.transaction() as con:
            con.execute("CREATE TRIGGER reject_mapping BEFORE INSERT ON project_workspaces BEGIN SELECT RAISE(ABORT,'injected mapping failure'); END;")
        with self.assertRaises(StorageError): store.create_workspace('orphan','Orphan')
        with store.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0],0)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM project_workspaces').fetchone()[0],0)

    def test_legacy_workspace_identifier_backfills_without_rewriting(self):
        store=self.old_store(2);store.create_workspace(' padded ','Legacy padded ID')
        result=store.migrate(backup_path=self.directory/'preserved-id.db')
        self.assertEqual(result['current_version'],len(self.api.load_migrations('sqlite')))
        with store.read_transaction() as con:
            self.assertEqual(con.execute("SELECT workspace_id FROM workspaces WHERE name='Legacy padded ID'").fetchone()[0],' padded ')
            self.assertEqual(tuple(con.execute("SELECT workspace_id,project_id FROM project_workspaces WHERE workspace_id=' padded '").fetchone()),(' padded ','default'))

    def test_runtime_without_003_refuses_latest_database_without_modifying_it(self):
        from services.storage.legacy import inventory_database
        store=SQLiteControlStore(self.directory/'latest.db');store.initialize()
        self.assertEqual(store.migration_plan()['current_version'],len(self.api.load_migrations('sqlite')))
        fingerprint=inventory_database(store.path)['source_content_sha256']
        old=self.directory/'runtime-old'/'sqlite';old.mkdir(parents=True)
        for filename in ('001_core.sql','002_iam.sql'): shutil.copyfile(self.root/'sqlite'/filename,old/filename)
        with patch.object(self.api,'SCHEMA_ROOT',old.parent):
            with self.assertRaises(StorageError): store.initialize()
        self.assertEqual(inventory_database(store.path)['source_content_sha256'],fingerprint)

if __name__=='__main__': unittest.main()
