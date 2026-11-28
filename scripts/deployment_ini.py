"""Read the operator's INI and translate it into the existing Storage Core contract."""
import configparser
import json
from pathlib import Path
import sys
from urllib.parse import quote, urlencode
from ipaddress import IPv6Address
import re

DEFAULT_INI = Path(__file__).resolve().parents[1] / 'config/deployment/storage.ini'
PASSWORD = {'postgresql': 'PG_PASSWORD', 'opengauss': 'OG_PASSWORD', 'sqlite': 'SQLITE_TOKEN'}
SERVICE = {'postgresql': 'postgres', 'opengauss': 'opengauss', 'sqlite': 'sqlite'}
RELATIONAL = {'host', 'port', 'user', 'password', 'database', 'schema', 'sslmode', 'sslrootcert'}
FIELDS = {'transaction': {'backend'}, 'postgresql': RELATIONAL, 'opengauss': RELATIONAL,
          'sqlite': {'endpoint', 'token'}, 'clickhouse': {'endpoint', 'database', 'user', 'password'}}


def read_app_config(file, instance=None, *, source=False):
    parser = configparser.ConfigParser(interpolation=None, empty_lines_in_values=False)
    try:
        with file.open(encoding='utf-8') as stream:
            parser.read_file(stream)
    except (configparser.Error, UnicodeError):
        raise ValueError(f'{file}：INI 格式无效，请检查重复字段、段名与等号') from None
    if parser.defaults() or set(parser.sections()) - FIELDS.keys():
        raise ValueError(f'{file}：含不支持的配置段')
    for section in parser.sections():
        if set(parser[section]) - FIELDS[section]:
            raise ValueError(f'{file}：[{section}] 含未知字段')

    def field(section, key, *, allow_empty=False):
        value = parser.get(section, key, fallback=None)
        if value is None or (not value and not allow_empty) or '\n' in value:
            raise ValueError(f'{file}：请填写 [{section}].{key}')
        return value

    def credential(section, key, instance_key, matches):
        value = field(section, key, allow_empty=section == 'clickhouse')
        if value != '@instance':
            return value
        if not instance or not matches or instance_key not in instance['environment']:
            raise ValueError(f'{file}：[{section}].{key} 无匹配实例凭据，请填写实际值')
        return instance['environment'][instance_key]

    backend = field('transaction', 'backend')
    managed = instance['backend'] if instance else None
    if backend == '@instance':
        backend = managed
    if backend not in PASSWORD:
        raise ValueError(f'{file}：[transaction].backend 请指定 postgresql、opengauss 或 sqlite')
    home = '~/.agent-insight' if source else '/data/agent-insight'
    control = {'backend': backend, 'artifacts': home + '/artifacts'}
    if backend == 'sqlite':
        endpoint = field(backend, 'endpoint')
        control.update(endpoint=endpoint, token=credential(backend, 'token', PASSWORD[backend],
                       managed == backend and endpoint == 'http://sqlite:8080'))
    else:
        host = field(backend, 'host')
        if ':' in host:
            try:
                host = '[' + str(IPv6Address(host)) + ']'
            except ValueError:
                raise ValueError(f'{file}：[{backend}].host 无效') from None
        elif not re.fullmatch(r'[a-zA-Z0-9_.-]+', host):
            raise ValueError(f'{file}：[{backend}].host 无效')
        port = field(backend, 'port')
        if not re.fullmatch(r'[0-9]{1,5}', port) or not 1 <= int(port) <= 65535:
            raise ValueError(f'{file}：[{backend}].port 应为 1–65535 的整数')
        user, db = field(backend, 'user'), field(backend, 'database')
        matches = managed == backend and host == SERVICE[backend] and port == '5432' and user == db == 'agent_insight'
        password = credential(backend, 'password', PASSWORD[backend], matches)
        options = {'sslmode': field(backend, 'sslmode'), 'connect_timeout': '10'}
        if parser.has_option(backend, 'sslrootcert'):
            options['sslrootcert'] = field(backend, 'sslrootcert')
        control['dsn'] = (f'postgresql://{quote(user, safe="")}:{quote(password, safe="")}@'
                          f'{host}:{port}/{quote(db, safe="")}?{urlencode(options)}')
        control['schema'] = field(backend, 'schema')
    ch = {key: field('clickhouse', key) for key in ('endpoint', 'database', 'user')}
    matches = ch['endpoint'] == 'http://clickhouse:8123' and ch['user'] == ch['database'] == 'agent_insight'
    ch['password'] = credential('clickhouse', 'password', 'CLICKHOUSE_PASSWORD', matches)
    return {'control': control, 'clickhouse': {**ch, 'timeout': 15},
            'runtime': {'home': home, 'webPort': 3000, 'corePort': 4319}}


if __name__ == '__main__':
    try:
        print(json.dumps(read_app_config(Path(sys.argv[1]), source=True)))
    except (ValueError, OSError) as exc:
        sys.exit(str(exc))
