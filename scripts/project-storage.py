"""Read-only inspection and explicit first-install initialization of external stores."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import importlib.util
import tempfile
from contextlib import closing
from urllib.parse import urlsplit

from services.storage.clickhouse import ClickHouseStore
from services.storage.control import SQLiteControlStore
from services.storage.mariadb import MariaDBControlStore, MariaDBPreflightError
from services.storage.migrations import load_migrations
spec = importlib.util.spec_from_file_location('local_storage', Path(__file__).with_name('local-storage.py'))
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


def transaction(config):
    c = config['control']
    backend = c['backend']
    if backend == 'sqlite':
        database = Path(c['database'])
        if database.is_symlink():
            raise ValueError('SQLite 路径不能为符号链接')
        store = SQLiteControlStore(database)
        if not database.exists():
            parent = database.parent
            while not parent.exists():
                parent = parent.parent
            if not os.access(parent, os.W_OK | os.X_OK):
                raise ValueError('SQLite 父目录不可写')
            return store, 'empty'
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
            tables = [r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        if not tables:
            raise ValueError('已有 SQLite 空文件未经本安装器初始化，请核实并选择新文件路径')
        if not os.access(database, os.W_OK) or not os.access(database.parent, os.W_OK):
            raise ValueError('SQLite 文件或父目录不可写')
    elif backend == 'mariadb':
        store = MariaDBControlStore.from_dsn(c['dsn'], artifact_directory=c['artifacts'])
        if store.inspect() == 'empty':
            return store, 'empty'
    else:
        from services.storage.relational import PostgreSQLControlStore, OpenGaussControlStore
        cls = PostgreSQLControlStore if backend == 'postgresql' else OpenGaussControlStore
        store = cls.from_dsn(c['dsn'], schema=c['schema'], artifact_directory=c['artifacts'])
        with store._connect() as connection:
            connection.execute('SET TRANSACTION READ ONLY')
            if backend == 'postgresql':
                version = int(connection.execute('SHOW server_version_num').fetchone()[0])
                if version < 160000:
                    raise ValueError('PostgreSQL 需要 16 或以上；当前验收基线为 16')
            schema = connection.execute('SELECT schema_name FROM information_schema.schemata WHERE schema_name=?', (c['schema'],)).fetchone()
            if not schema:
                if not connection.execute("SELECT has_database_privilege(current_database(), 'CREATE')").fetchone()[0]:
                    raise ValueError('事务库缺少创建应用 schema 的权限')
                return store, 'empty'
            tables = connection.execute('SELECT table_name FROM information_schema.tables WHERE table_schema=?', (c['schema'],)).fetchall()
            if not tables:
                if not connection.execute("SELECT has_schema_privilege(?, 'CREATE')", (c['schema'],)).fetchone()[0]:
                    raise ValueError('事务库缺少应用 schema CREATE 权限')
                return store, 'empty'
            if not connection.execute("SELECT has_schema_privilege(?, 'USAGE')", (c['schema'],)).fetchone()[0]:
                raise ValueError('事务库缺少应用 schema USAGE 权限')
            for row in tables:
                name = c['schema'] + '.' + row[0]
                for permission in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'):
                    if not connection.execute('SELECT has_table_privilege(?, ?)', (name, permission)).fetchone()[0]:
                        raise ValueError('事务库缺少应用表读写权限')
    plan = store.migration_plan()
    if plan['pending'] or plan['current_version'] != len(load_migrations(backend)):
        raise ValueError('事务库需要显式备份升级；安装和启动不会自动迁移历史数据')
    return store, 'ready'


def inspect(config):
    facts = ClickHouseStore(**config['clickhouse'])
    version = facts._request('SELECT version() FORMAT TabSeparated').decode().strip()
    if tuple(int(p) for p in version.split('.')[:2]) < (26, 8):
        raise ValueError('ClickHouse 需要 26.8 或以上；当前验收基线为 26.8')
    missing = local.schema_plan(facts)
    actual = facts._request('SHOW TABLES FORMAT TabSeparated').decode().splitlines()
    status = 'empty' if not actual else 'partial' if missing else 'ready'
    if status == 'ready':
        facts.check_schema()
        for name in actual:
            if facts._request(f'CHECK GRANT SELECT, INSERT ON {facts.database}.{name}').strip() != b'1':
                raise ValueError('ClickHouse 缺少分析表 SELECT/INSERT 权限')
    else:
        if facts._request(f'CHECK GRANT CREATE TABLE ON {facts.database}.*').strip() != b'1':
            raise ValueError('ClickHouse 缺少首次建表 CREATE TABLE 权限')
    store, state = transaction(config)
    return store, facts, {'transaction': state, 'clickhouse': status, 'clickhouseVersion': version}


def initialize(config, *, apply=False):
    store, facts, report = inspect(config)
    state_file = Path(config['stateFile']) if config.get('stateFile') else None
    control = config['control']
    target = {'backend': control['backend'], 'database': control.get('database'), 'schema': control.get('schema')}
    if control.get('dsn'):
        url = urlsplit(control['dsn'])
        target['address'] = [url.hostname, url.port or (3306 if control['backend'] == 'mariadb' else 5432), url.path]
    identity = hashlib.sha256(json.dumps({'control': target, 'clickhouse': {k: config['clickhouse'][k] for k in ('endpoint', 'database')}}, sort_keys=True).encode()).hexdigest()
    state = local.private_json(state_file) if state_file and state_file.exists() else None
    if state and state['identity'] != identity:
        raise ValueError('初始化记录与当前连接配置不同；请恢复原配置或使用独立 runtime.home，不能自动切换数据库')
    if report['clickhouse'] == 'partial' and (not state or state['complete']):
        raise ValueError('ClickHouse 表结构不完整；需要显式备份迁移，不能自动补建历史环境')
    if state and state['complete'] and 'empty' in (report['transaction'], report['clickhouse']):
        raise ValueError('已安装环境数据库缺失；请恢复数据，拒绝重新建空库')
    if not state and report['transaction'] != report['clickhouse']:
        raise ValueError('两类存储状态不匹配；请迁移或恢复成配套数据库，不能用空库替换一侧数据')
    if not apply:
        return report
    if not state_file:
        raise ValueError('缺少初始化状态文件')
    if not state:
        state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        write_state(state_file, {'identity': identity, 'complete': False}, exclusive=True)
    if report['transaction'] == 'empty':
        if config['control']['backend'] == 'sqlite':
            database = Path(config['control']['database'])
            database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            local.initialize_sqlite(database)
        else:
            store.initialize()
    if report['clickhouse'] != 'ready':
        local.create_missing_tables(facts)
    _, _, verified = inspect(config)
    write_state(state_file, {'identity': identity, 'complete': True})
    return verified


def write_state(target, value, exclusive=False):
    fd, temporary = tempfile.mkstemp(prefix='.initialize-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            os.link(temporary, target)
        else:
            os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    try:
        config = json.load(sys.stdin)
        print(json.dumps(initialize(config, apply=sys.argv[1] == 'initialize')))
    except Exception as exc:
        safe = isinstance(exc, MariaDBPreflightError) or (isinstance(exc, ValueError) and any('\u4e00' <= c <= '\u9fff' for c in str(exc)))
        print(str(exc) if safe else f'数据库检查失败 ({type(exc).__name__})：检查数据库是否已创建、地址、凭据、TLS、权限和 schema 版本；不会回退旧存储', file=sys.stderr)
        sys.exit(1)
