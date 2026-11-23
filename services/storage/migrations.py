"""Checked migration prefixes and atomic application, without touching default databases."""
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import sqlite3

SCHEMA_ROOT = Path(__file__).parent / 'schema'


class MigrationError(ValueError):
    pass


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    checksum: str
    sql: str


def load_migrations(backend):
    if backend not in {'sqlite', 'postgresql', 'opengauss'}:
        raise MigrationError('unsupported transaction backend')
    migrations = []
    for path in sorted((SCHEMA_ROOT / backend).glob('*.sql')):
        match = re.fullmatch(r'(\d{3})_([a-z][a-z0-9_]*)\.sql', path.name)
        if match is None:
            raise MigrationError('invalid migration filename')
        data = path.read_bytes()
        migrations.append(Migration(int(match[1]), match[2], hashlib.sha256(data).hexdigest(), data.decode('utf-8')))
    if not migrations or [m.version for m in migrations] != list(range(1, len(migrations) + 1)):
        raise MigrationError('migration files must be a consecutive known prefix')
    return migrations


def validate_history(connection, backend):
    known = load_migrations(backend)
    rows = connection.execute('SELECT version,name,checksum FROM schema_meta ORDER BY version').fetchall()
    actual = [tuple(row) for row in rows]
    expected = [(m.version, m.name, m.checksum) for m in known[:len(actual)]]
    if not actual or len(actual) > len(known) or actual != expected:
        raise MigrationError('unsupported schema version, history gap or migration checksum mismatch')
    return known, len(actual)


def plan(connection, backend):
    known, applied = validate_history(connection, backend)
    return {'backend': backend, 'current_version': applied, 'target_version': len(known),
            'pending': [{'version': m.version, 'name': m.name, 'checksum': m.checksum} for m in known[applied:]]}


def sqlite_statements(sql):
    buffer = []
    for char in sql:
        buffer.append(char)
        if char == ';' and sqlite3.complete_statement(''.join(buffer)):
            statement = ''.join(buffer).strip()
            buffer = []
            content = re.sub(r'--[^\n]*|/\*.*?\*/', '', statement, flags=re.S).strip()
            if not content:
                continue
            word = content.split(None, 1)[0].rstrip(';').upper()
            if word in {'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ATTACH', 'DETACH', 'VACUUM'}:
                raise MigrationError('migration cannot control the transaction or attach databases')
            if word == 'PRAGMA' and not re.fullmatch(r'PRAGMA\s+foreign_keys\s*=\s*ON\s*;', content, re.I):
                raise MigrationError('unsupported migration pragma')
            yield statement
    remaining = re.sub(r'--[^\n]*|/\*.*?\*/', '', ''.join(buffer), flags=re.S).strip()
    if remaining:
        raise MigrationError('migration contains an incomplete SQL statement')


def _leading_keyword(statement):
    index = 0
    while index < len(statement):
        if statement[index].isspace():
            index += 1
        elif statement.startswith('--', index):
            newline = statement.find('\n', index + 2)
            index = len(statement) if newline < 0 else newline + 1
        elif statement.startswith('/*', index):
            index += 2
            depth = 1
            while index < len(statement) and depth:
                if statement.startswith('/*', index): depth += 1; index += 2
                elif statement.startswith('*/', index): depth -= 1; index += 2
                else: index += 1
            if depth: raise MigrationError('unterminated migration comment')
        else:
            match = re.match(r'[A-Za-z_]+', statement[index:])
            return match[0].upper() if match else ''
    return ''


def guard_server_transaction(sql):
    statements = []
    start = 0
    index = 0
    state = None
    block_depth = 0
    dollar = None
    while index < len(sql):
        pair = sql[index:index + 2]
        char = sql[index]
        if state == 'line':
            if char == '\n': state = None
        elif state == 'block':
            if pair == '/*': block_depth += 1; index += 1
            elif pair == '*/':
                block_depth -= 1; index += 1
                if block_depth == 0: state = None
        elif state in ("'", '"'):
            if char == state:
                if index + 1 < len(sql) and sql[index + 1] == state: index += 1
                else: state = None
        elif state == 'dollar':
            if sql.startswith(dollar, index):
                index += len(dollar) - 1; state = None
        elif pair == '--': state = 'line'; index += 1
        elif pair == '/*': state = 'block'; block_depth = 1; index += 1
        elif char in ("'", '"'): state = char
        elif char == '$':
            match = re.match(r'\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$', sql[index:])
            if match:
                dollar = match[0]; state = 'dollar'; index += len(dollar) - 1
        elif char == ';':
            statements.append(sql[start:index + 1]); start = index + 1
        index += 1
    if state not in (None, 'line'):
        raise MigrationError('unterminated migration literal or comment')
    statements.append(sql[start:])
    for statement in statements:
        first = _leading_keyword(statement)
        if not first: continue
        if first in {'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT', 'VACUUM'}:
            raise MigrationError('server migration cannot control the transaction')
        if first in {'SET', 'RESET', 'PREPARE'}:
            raise MigrationError('server migration cannot alter session or transaction state')


def apply(connection, backend, *, clock, applied=0):
    known = load_migrations(backend)
    for migration in known[applied:]:
        if backend == 'sqlite':
            for statement in sqlite_statements(migration.sql):
                connection.execute(statement)
        else:
            guard_server_transaction(migration.sql)
            connection.execute(migration.sql)
        connection.execute('INSERT INTO schema_meta(version,name,checksum,applied_at_ms) VALUES(?,?,?,?)',
                           (migration.version, migration.name, migration.checksum, clock()))
    return len(known)
