import json
import os
from pathlib import Path
import re
import secrets
import time

from services.storage.clickhouse import ClickHouseStore
from services.storage.control import SQLiteControlStore
from services.storage.migrations import load_migrations


ROOT = Path('/core')
DATABASE = ROOT / 'core.db'
CONFIG = ROOT / 'trace-service.json'
CONTROLLER = ROOT / 'controller-key'
CLICKHOUSE_DATABASE = 'agent_insight_core_docker'


def private_file(path, content):
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError(f'{path.name} must be a private regular file')
        if path.read_text() != content:
            raise ValueError(f'{path.name} differs from the existing isolated configuration')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)


def wait_for_clickhouse(facts):
    for attempt in range(60):
        try:
            facts._request('SELECT 1 FORMAT TabSeparated', database='default')
            return
        except Exception:
            if attempt == 59:
                raise RuntimeError('ClickHouse was unavailable for 60 seconds') from None
            time.sleep(1)


def initialize_clickhouse(facts):
    schema = Path(__file__).resolve().parents[1] / 'services' / 'storage' / 'schema' / 'clickhouse'
    expected = set()
    for migration in sorted(schema.glob('*.sql')):
        expected.update(re.findall(r'(?im)^CREATE TABLE\s+([a-z][a-z0-9_]*)', migration.read_text()))
    databases = facts._request('SELECT name FROM system.databases WHERE name={target:String} FORMAT TabSeparated',
                               parameters={'target': CLICKHOUSE_DATABASE}, database='default').decode().splitlines()
    if not databases:
        facts.initialize_new_database()
        facts.initialize_analytics_schema()
        facts.initialize_infra_schema()
        facts.initialize_semantic_usage_schema()
    tables = set(facts._request('SELECT name FROM system.tables WHERE database={target:String} FORMAT TabSeparated',
                                parameters={'target': CLICKHOUSE_DATABASE}, database='default').decode().splitlines())
    if tables != expected:
        raise ValueError(f'ClickHouse schema differs from the expected {len(expected)} tables')


def main():
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if CONFIG.exists():
        from services.storage.trace_service import runtime_from_config
        runtime, _ = runtime_from_config(CONFIG)
        runtime.close()
        print('Existing Core configuration verified; no database initialization performed', flush=True)
        return
    if DATABASE.exists() or DATABASE.is_symlink():
        if DATABASE.is_symlink() or not DATABASE.is_file():
            raise ValueError('Existing core database must be a regular file')
        plan = SQLiteControlStore(DATABASE).migration_plan()
        if plan['pending'] or plan['current_version'] != len(load_migrations('sqlite')):
            raise ValueError('Existing core database needs an explicit, backup-checked migration')
    else:
        SQLiteControlStore(DATABASE).initialize()

    password = os.environ.get('CLICKHOUSE_PASSWORD')
    if not password:
        raise ValueError('CLICKHOUSE_PASSWORD is required')
    facts = ClickHouseStore(os.environ.get('CLICKHOUSE_ENDPOINT', 'http://clickhouse:8123'),
                            database=CLICKHOUSE_DATABASE, password=password)
    wait_for_clickhouse(facts)
    initialize_clickhouse(facts)

    if not CONTROLLER.exists():
        private_file(CONTROLLER, secrets.token_hex(32))
    elif CONTROLLER.is_symlink() or not CONTROLLER.is_file() or CONTROLLER.stat().st_mode & 0o077:
        raise ValueError('Existing controller key must be a private regular file')
    config = {
        'control': {'backend': 'sqlite', 'database': str(DATABASE)},
        'clickhouse': {'endpoint': facts.endpoint, 'database': facts.database,
                       'user': facts.user, 'password': facts.password},
        'cursor_secret_hex': secrets.token_hex(32),
        'controller_key_file': str(CONTROLLER),
        'default_workspace': 'default',
        'port': 4319,
        'worker_enabled': True,
    }
    if CONFIG.exists():
        if CONFIG.is_symlink() or not CONFIG.is_file() or CONFIG.stat().st_mode & 0o077:
            raise ValueError('Existing service config must be a private regular file')
        prior = json.loads(CONFIG.read_text())
        config['cursor_secret_hex'] = prior['cursor_secret_hex']
    private_file(CONFIG, json.dumps(config, sort_keys=True, separators=(',', ':')))
    print(f"Storage core ready: SQLite migration {len(load_migrations('sqlite')):03d} and ClickHouse 004", flush=True)


if __name__ == '__main__':
    main()
