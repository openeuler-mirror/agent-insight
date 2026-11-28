import json
import os
import secrets
import sqlite3
import subprocess
import sys
import threading
import tempfile
import unittest
from pathlib import Path
from contextlib import closing

from services.storage.control import StorageError, Conflict
from services.storage.sqlite_network import NetworkSQLiteStore
from services.storage.sqlite_server import Server


class SQLiteNetworkTests(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        path = Path(root.name)
        token = secrets.token_hex(32)
        self.database = path / 'core.db'
        server = Server(('127.0.0.1', 0), self.database, token)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.config = {'endpoint': f'http://127.0.0.1:{server.server_port}', 'token': token,
                       'artifacts': str(path / 'artifacts')}
        self.store = NetworkSQLiteStore(self.config)
        self.assertEqual(self.store.migration_plan(), {'state': 'empty'})
        self.store.initialize()

    def test_business_operations_and_conflict(self):
        self.store.create_workspace('w1', 'One')
        self.store.create_identity('w1', 'a', 'skill', 'a')
        release = self.store.publish_release('w1', 'a', 'r', '1.0', {'text': 'hello'})
        self.assertEqual(json.loads(Path(release['manifest_ref']).read_text())['content'], {'text': 'hello'})
        with self.assertRaises(Conflict):
            self.store.create_workspace('w1', 'Two')
        self.store.initialize()
        with self.store.read_transaction() as con:
            self.assertEqual(con.execute('select name from workspaces where workspace_id=?', ['w1']).fetchone()['name'], 'One')

    def test_disconnect_rolls_back_and_keeps_read_snapshot(self):
        self.store.create_workspace('w1', 'One')
        with self.store.read_transaction() as reader:
            query = 'select name from workspaces where workspace_id=?'
            self.assertEqual(reader.execute(query, ['w1']).fetchone()[0], 'One')
            with self.store.transaction() as writer:
                writer.execute('update workspaces set name=? where workspace_id=?', ['Two', 'w1'])
            self.assertEqual(reader.execute(query, ['w1']).fetchone()[0], 'One')
        with self.assertRaises(RuntimeError):
            with self.store.transaction() as writer:
                writer.execute('update workspaces set name=? where workspace_id=?', ['Lost', 'w1'])
                raise RuntimeError('simulate client disconnect')
        with self.store.transaction() as check:
            self.assertEqual(check.execute(query, ['w1']).fetchone()[0], 'Two')

    def test_credentials_and_database_boundary(self):
        with self.assertRaises(StorageError):
            NetworkSQLiteStore({**self.config, 'token': 'wrong'}).migration_plan()
        with self.assertRaises(StorageError):
            with self.store.transaction() as con:
                con.execute('PRAGMA writable_schema=ON')

    def test_online_backup_preserves_rows_and_refuses_overwrite(self):
        self.store.create_workspace('w1', 'One')
        backup = self.database.with_name('backup.db')
        cmd = [sys.executable, '-m', 'services.storage.sqlite_server', '--backup', str(backup)]
        env = {**os.environ, 'SQLITE_DATABASE': str(self.database)}
        subprocess.run(cmd, env=env, check=True)
        self.store.create_workspace('w2', 'Two')
        self.assertNotEqual(subprocess.run(cmd, env=env, capture_output=True).returncode, 0)
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute('select name from workspaces order by name').fetchall(), [('One',)])
