import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[3] / 'scripts' / 'storage-core-docker-bootstrap.py'
spec = importlib.util.spec_from_file_location('storage_core_docker_bootstrap', SCRIPT)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class FakeClickHouse:
    tables = set()
    exists = False

    def __init__(self, endpoint, *, database, password, user='default'):
        self.endpoint = endpoint
        self.database = database
        self.password = password
        self.user = 'default'

    def check_schema(self):
        if len(self.tables) != 19:
            raise ValueError('schema differs')
        return {'schema_version': 4, 'tables': 19}

    def _request(self, sql, *, parameters=None, database=None):
        if sql.startswith('SELECT 1'):
            return b'1\n'
        if 'system.databases' in sql:
            return b'agent_insight_core_docker\n' if self.exists else b''
        if 'system.tables' in sql:
            return ('\n'.join(sorted(self.tables)) + '\n').encode()
        raise AssertionError(sql)

    def _add(self, name):
        source = SCRIPT.parents[1] / 'services' / 'storage' / 'schema' / 'clickhouse' / name
        self.tables.update(re.findall(r'(?im)^CREATE TABLE\s+([a-z][a-z0-9_]*)', source.read_text()))

    def initialize_new_database(self):
        type(self).exists = True
        self._add('001_core.sql')

    def initialize_analytics_schema(self):
        self._add('002_trace_analytics.sql')

    def initialize_infra_schema(self):
        self._add('003_infra.sql')

    def initialize_semantic_usage_schema(self):
        self._add('004_semantic_usage.sql')


class DockerBootstrapTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.patches = [
            patch.object(bootstrap, 'ROOT', self.root),
            patch.object(bootstrap, 'DATABASE', self.root / 'core.db'),
            patch.object(bootstrap, 'CONFIG', self.root / 'trace-service.json'),
            patch.object(bootstrap, 'CONTROLLER', self.root / 'controller-key'),
            patch.object(bootstrap, 'ClickHouseStore', FakeClickHouse),
            patch('services.storage.clickhouse.ClickHouseStore', FakeClickHouse),
            patch.dict(os.environ, {'CLICKHOUSE_PASSWORD': 'isolated-test-password', 'CLICKHOUSE_ENDPOINT': 'http://clickhouse:8123'}),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        FakeClickHouse.tables = set()
        FakeClickHouse.exists = False

    def test_first_start_and_restart_preserve_data_and_secrets(self):
        bootstrap.main()
        config = bootstrap.CONFIG.read_bytes()
        controller = bootstrap.CONTROLLER.read_bytes()
        assert len(FakeClickHouse.tables) == 19
        assert bootstrap.DATABASE.is_file()
        assert bootstrap.CONFIG.stat().st_mode & 0o077 == 0
        assert bootstrap.CONTROLLER.stat().st_mode & 0o077 == 0
        bootstrap.main()
        self.assertEqual(bootstrap.CONFIG.read_bytes(), config)
        self.assertEqual(bootstrap.CONTROLLER.read_bytes(), controller)

    def test_capacity_in_private_config_and_health(self):
        from services.storage.trace_service import create_server, runtime_from_config
        bootstrap.main()
        cfg = json.loads(bootstrap.CONFIG.read_text())
        self.assertEqual(cfg['max_concurrent_requests'], 64)
        for value, expected in [(96, 96), ('96', 64)]:
            with self.subTest(value=value):
                cfg['max_concurrent_requests'] = value
                bootstrap.CONFIG.write_text(json.dumps(cfg))
                original = bootstrap.CONFIG.read_bytes()
                with self.assertNoLogs('services.storage.trace_service', 'WARNING'):
                    bootstrap.main()
                logs = (self.assertLogs('services.storage.trace_service', 'WARNING') if value != expected
                        else self.assertNoLogs('services.storage.trace_service', 'WARNING'))
                with logs:
                    runtime, _ = runtime_from_config(bootstrap.CONFIG)
                try:
                    with create_server(runtime) as server:
                        self.assertEqual(server.http_metrics()['capacity'], expected)
                finally:
                    runtime.close()
                self.assertEqual(bootstrap.CONFIG.read_bytes(), original)

    def test_partial_clickhouse_schema_is_rejected(self):
        FakeClickHouse.exists = True
        FakeClickHouse.tables = {'obs_trace_current'}
        with self.assertRaisesRegex(ValueError, 'schema differs'):
            bootstrap.main()


if __name__ == '__main__':
    unittest.main()
