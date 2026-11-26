import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from services.storage.control import SQLiteControlStore

SPEC = importlib.util.spec_from_file_location('local_storage_bootstrap', Path(__file__).resolve().parents[3] / 'scripts/local-storage.py')
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class LocalStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.file = self.root / 'trace-service.json'
        self.config = {'control': {'backend': 'sqlite', 'database': str(self.root / 'core.db')},
                       'clickhouse': {'endpoint': 'http://127.0.0.1:8123', 'database': 'isolated'}}
        self.write(self.file, self.config)
        self.write(Path(str(self.file) + '.initializing'), self.config)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, file, value):
        file.write_text(json.dumps(value))
        file.chmod(0o600)

    def test_interrupted_initialization_retries_without_losing_transaction_data(self):
        with patch.object(bootstrap, 'ClickHouseStore') as cls, patch.object(bootstrap, 'create_missing_tables', side_effect=RuntimeError('offline')):
            cls.return_value._request.return_value = b''
            with self.assertRaises(RuntimeError):
                bootstrap.prepare(self.file)
        store = SQLiteControlStore(self.config['control']['database'])
        store.create_workspace('existing', 'Keep this workspace')
        self.assertTrue(Path(str(self.file) + '.initializing').exists())
        with patch.object(bootstrap, 'ClickHouseStore') as cls, patch.object(bootstrap, 'create_missing_tables'):
            cls.return_value._request.return_value = b'isolated\n'
            bootstrap.prepare(self.file)
        self.assertFalse(Path(str(self.file) + '.initializing').exists())
        import sqlite3
        with sqlite3.connect(self.config['control']['database']) as db:
            self.assertEqual(db.execute("SELECT name FROM workspaces WHERE workspace_id='existing'").fetchone()[0], 'Keep this workspace')

    def test_changed_configuration_cannot_resume_initialization(self):
        modified = dict(self.config, control={'backend': 'sqlite', 'database': '/different/core.db'})
        self.write(self.file, modified)
        with self.assertRaisesRegex(ValueError, '初始化记录不匹配'):
            bootstrap.prepare(self.file)
        self.assertFalse((self.root / 'core.db').exists())

    def test_unknown_clickhouse_tables_are_not_accepted_as_upgrade(self):
        from unittest.mock import Mock
        facts = Mock(database='isolated')
        facts._request.return_value = b'{"table":"unexpected","name":"id"}\n'
        with self.assertRaisesRegex(ValueError, '未知表'):
            bootstrap.schema_plan(facts)

    def test_existing_configuration_never_initializes_database_without_intent(self):
        Path(str(self.file) + '.initializing').unlink()
        with patch('services.storage.trace_service.runtime_from_config', side_effect=ValueError('existing database not ready')):
            with self.assertRaisesRegex(ValueError, 'existing database'):
                bootstrap.prepare(self.file)
        self.assertFalse((self.root / 'core.db').exists())

    def test_server_initialization_publishes_sqlite_after_analytical_check_and_reuses_data(self):
        with patch.object(bootstrap, 'ClickHouseStore') as store:
            store.return_value.check_schema.side_effect = RuntimeError('analytical store offline')
            with self.assertRaisesRegex(RuntimeError, 'analytical store offline'):
                bootstrap.prepare_server_core(self.file)
            self.assertFalse((self.root / 'core.db').exists())
            store.return_value.check_schema.side_effect = None
            bootstrap.prepare_server_core(self.file)
            control = SQLiteControlStore(self.root / 'core.db')
            control.create_workspace('existing', 'Preserved')
            bootstrap.prepare_server_core(self.file)
            with control.read_transaction() as db:
                self.assertEqual(db.execute("SELECT name FROM workspaces WHERE workspace_id='existing'").fetchone()[0], 'Preserved')
            self.assertFalse(list(self.root.glob('.core-init-*')))

    def test_server_initialization_keeps_partial_sqlite_out_of_final_path(self):
        def interrupted(store):
            store.path.write_bytes(b'incomplete')
            raise RuntimeError('interrupted')
        with patch.object(bootstrap, 'ClickHouseStore'), patch.object(SQLiteControlStore, 'initialize', interrupted):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                bootstrap.prepare_server_core(self.file)
        self.assertFalse((self.root / 'core.db').exists())
        self.assertFalse(list(self.root.glob('.core-init-*')))

    def test_managed_initialization_keeps_interrupted_sqlite_private_and_can_retry(self):
        def interrupted(store):
            store.path.write_bytes(b'incomplete')
            raise RuntimeError('interrupted')
        with patch.object(SQLiteControlStore, 'initialize', interrupted):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                bootstrap.prepare(self.file)
        self.assertFalse((self.root / 'core.db').exists())
        self.assertTrue(Path(str(self.file) + '.initializing').exists())
        with patch.object(bootstrap, 'ClickHouseStore') as cls, patch.object(bootstrap, 'create_missing_tables'):
            cls.return_value._request.return_value = b'isolated\n'
            bootstrap.prepare(self.file)
        self.assertTrue((self.root / 'core.db').exists())
        self.assertFalse(Path(str(self.file) + '.initializing').exists())
