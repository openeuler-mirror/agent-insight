import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.storage.control import SQLiteControlStore
from services.storage.clickhouse import ClickHouseStore
from services.storage.migrations import load_migrations

SCHEMA = Path(__file__).resolve().parents[1] / 'services/storage/schema/clickhouse'


def private_json(file):
    target = Path(file)
    if target.is_symlink() or not target.is_file() or target.stat().st_mode & 0o077:
        raise ValueError('配置必须为权限 0600 的普通文件')
    return json.loads(target.read_text())


def schema_plan(facts):
    expected = {}
    for file in sorted(SCHEMA.glob('*.sql')):
        for name, body in re.findall(r'CREATE TABLE (\w+)\s*\((.*?)\)\s*ENGINE', file.read_text(), re.S):
            expected[name] = {c for c, _ in re.findall(r'(?:^|,)\s*(\w+)\s+(\w+)', body) if c != 'CONSTRAINT'}
    actual = {}
    for line in facts._request('SELECT table, name FROM system.columns WHERE database={db:String} FORMAT JSONEachRow', parameters={'db': facts.database}).splitlines():
        row = json.loads(line)
        actual.setdefault(row['table'], set()).add(row['name'])
    incompatible = [name for name in actual if name not in expected or not expected[name] <= actual[name]]
    if incompatible:
        raise ValueError('ClickHouse 存在未知表或不兼容字段，需人工审核迁移计划')
    return sorted(set(expected) - set(actual))


def create_missing_tables(facts):
    missing = schema_plan(facts)
    for file in sorted(SCHEMA.glob('*.sql')):
        for sql in file.read_text().split(';'):
            match = re.search(r'CREATE TABLE (\w+)', sql)
            if match and match[1] in missing:
                facts._request(sql)
    facts.check_schema()


def initialize_sqlite(database):
    if database.is_symlink():
        raise ValueError('事务库不能是符号链接')
    if database.exists():
        return
    with tempfile.TemporaryDirectory(prefix='.core-init-', dir=database.parent) as directory:
        staged_database = Path(directory) / 'core.db'
        SQLiteControlStore(staged_database).initialize()
        if Path(str(staged_database) + '-wal').exists():
            raise ValueError('SQLite 初始化尚未完成')
        os.link(staged_database, database)


def prepare(config_file):
    config = private_json(config_file)
    marker = Path(str(config_file) + '.initializing')
    if not marker.exists():
        from services.storage.trace_service import runtime_from_config
        runtime, _ = runtime_from_config(config_file)
        runtime.close()
        print('Core 配置与表结构已验证')
        return
    state = private_json(marker)
    if state != config or config['control']['backend'] != 'sqlite':
        raise ValueError('初始化记录不匹配，拒绝自动修改已有环境')
    database = Path(config['control']['database'])
    initialize_sqlite(database)
    plan = SQLiteControlStore(database).migration_plan()
    if plan['pending'] or plan['current_version'] != len(load_migrations('sqlite')):
        raise ValueError('事务库需要显式升级，运行 bash scripts/storage_upgrade.sh --plan')
    facts = ClickHouseStore(**config['clickhouse'])
    databases = facts._request('SELECT name FROM system.databases WHERE name={db:String} FORMAT TabSeparated', parameters={'db': facts.database}, database='default').decode().splitlines()
    if not databases:
        facts._request(f'CREATE DATABASE {facts.database}', database='default')
    create_missing_tables(facts)
    marker.unlink()
    print('Core 新环境初始化完成；SQLite 020 + ClickHouse 004')


def upgrade(config_file, backup):
    config = private_json(config_file)
    if config['control']['backend'] != 'sqlite':
        raise ValueError('PG/openGauss 请使用 migration-plan / migrate-relational 及外部备份证据')
    store = SQLiteControlStore(config['control']['database'])
    plan = store.migration_plan()
    facts = ClickHouseStore(**config['clickhouse'])
    missing = schema_plan(facts)
    if backup:
        if plan['pending']:
            store.migrate(backup_path=backup)
        create_missing_tables(facts)
        plan = store.migration_plan()
    print(json.dumps({'transaction': plan, 'clickhouse_missing_tables': missing, 'applied': bool(backup)}, ensure_ascii=False))


def prepare_server_clickhouse(config_file, verify_only):
    from services.storage.clickhouse import ClickHouseError

    config = private_json(config_file)
    target = {'endpoint': config['endpoint'], 'database': config['database'], 'timeout': 5}
    runtime = ClickHouseStore(**target, **config['runtime'])
    if verify_only:
        facts = runtime
        version_database = runtime.database
    else:
        facts = ClickHouseStore(**target, **config['bootstrap'])
        version_database = 'default'
    for attempt in range(12):
        try:
            version = facts._request('SELECT version() FORMAT TabSeparated', database=version_database).decode().strip()
            break
        except ClickHouseError:
            if attempt == 11:
                raise ValueError('ClickHouse 未就绪或部署账号无法认证，请检查服务日志') from None
            time.sleep(2)
    if version != config['version']:
        raise ValueError('运行中的 ClickHouse 版本与选定的正式包不匹配')
    if not verify_only:
        databases = facts._request('SELECT name FROM system.databases WHERE name={db:String} FORMAT TabSeparated',
                                   parameters={'db': facts.database}, database='default').decode().splitlines()
        if not databases:
            facts._request(f'CREATE DATABASE {facts.database}', database='default')
        create_missing_tables(facts)
    runtime.check_schema()
    print(f'ClickHouse {version} 服务就绪，分析结构已通过校验')


def prepare_server_core(config_file):
    config = private_json(config_file)
    control = config['control']
    database = Path(control['database'])
    if (control['backend'] != 'sqlite' or not database.is_absolute() or database.is_symlink() or
            database.parent != Path(config_file).parent or database.name != 'core.db'):
        raise ValueError('服务器自动初始化仅适用于部署目录中的 SQLite 事务库')
    ClickHouseStore(**config['clickhouse']).check_schema()
    initialize_sqlite(database)
    plan = SQLiteControlStore(database).migration_plan()
    if plan['pending'] or plan['current_version'] != len(load_migrations('sqlite')):
        raise ValueError('事务库需要显式升级')
    print(f"服务器事务库 SQLite schema {plan['current_version']:03d} 与 ClickHouse 已就绪")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'upgrade', 'prepare-server-clickhouse', 'prepare-server-core'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--backup')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.config)
    elif args.action == 'prepare-server-clickhouse':
        prepare_server_clickhouse(args.config, args.verify_only)
    elif args.action == 'prepare-server-core':
        prepare_server_core(args.config)
    else:
        upgrade(args.config, args.backup)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Database exceptions can contain SQL or credentials; expose only reviewed diagnostics.
        safe = isinstance(exc, ValueError) and any(word in str(exc) for word in ('配置', '初始化', '事务库', 'ClickHouse', 'PG/openGauss'))
        print(str(exc) if safe else f'存储检查失败 ({type(exc).__name__})；请检查服务状态、权限及迁移版本', file=sys.stderr)
        sys.exit(1)
