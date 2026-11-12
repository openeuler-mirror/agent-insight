"""Explicit-schema PostgreSQL/openGauss control adapters using DB-API connections."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import time

from .control import ControlOperations, Conflict, StorageError
from .migrations import apply, plan, validate_history, MigrationError


class StorageRow:
    def __init__(self, names, values):
        self._names = tuple(names)
        self._values = tuple(values)
        self._positions = {name: index for index, name in enumerate(names)}

    def keys(self):
        return self._names

    def __getitem__(self, key):
        return self._values[key if isinstance(key, int) else self._positions[key]]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)


_SQL_TOKENS = re.compile(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|--[^\n]*|/\*.*?\*/|\$(?P<tag>[A-Za-z_][A-Za-z_0-9]*)?\$.*?\$(?P=tag)\$|\?", re.S)


def qmark_sql(sql):
    return _SQL_TOKENS.sub(lambda match: '%s' if match[0] == '?' else match[0], sql.replace('%', '%%'))


class _Result:
    def __init__(self, cursor):
        self._cursor = cursor
        self.rowcount = cursor.rowcount
        self._names = tuple(column[0] for column in cursor.description) if cursor.description else ()

    def fetchone(self):
        row = self._cursor.fetchone()
        return None if row is None else StorageRow(self._names, row)

    def fetchall(self):
        return [StorageRow(self._names, row) for row in self._cursor.fetchall()]

    def __iter__(self):
        while True:
            row = self.fetchone()
            if row is None:
                return
            yield row


class _Connection:
    def __init__(self, raw):
        self.raw = raw
        self._cursors = []

    def execute(self, sql, parameters=None):
        cursor = self.raw.cursor()
        self._cursors.append(cursor)
        if parameters:
            cursor.execute(qmark_sql(sql), tuple(parameters))
        else:
            cursor.execute(sql)
        return _Result(cursor)

    def executemany(self, sql, parameters):
        cursor = self.raw.cursor()
        self._cursors.append(cursor)
        cursor.executemany(qmark_sql(sql), parameters)
        return _Result(cursor)

    def close(self):
        for cursor in self._cursors:
            cursor.close()
        self.raw.close()


class PostgreSQLControlStore(ControlOperations):
    backend = 'postgresql'

    def __init__(self, connection_factory, *, schema, artifact_directory, clock=None):
        if (not isinstance(schema, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', schema)
                or schema == 'public' or schema.startswith('pg_') or schema == 'information_schema'):
            raise ValueError('an explicit non-system isolated schema is required')
        if not callable(connection_factory):
            raise ValueError('an explicit connection factory is required')
        if not artifact_directory:
            raise ValueError('an explicit artifact directory is required')
        self.connection_factory = connection_factory
        self.schema = schema
        self.artifact_directory = Path(artifact_directory).absolute()
        self.clock = clock or (lambda: time.time_ns() // 1_000_000)

    @classmethod
    def from_dsn(cls, dsn, *, schema, artifact_directory, clock=None):
        if not isinstance(dsn, str) or not dsn.strip():
            raise ValueError('an explicit DSN is required')
        def connect():
            try:
                import psycopg2
            except ImportError as exc:
                raise StorageError('install the optional pinned relational driver') from exc
            return psycopg2.connect(dsn)
        return cls(connect, schema=schema, artifact_directory=artifact_directory, clock=clock)

    @contextmanager
    def _connect(self):
        connection = None
        raw = None
        try:
            try:
                raw = self.connection_factory()
            except Exception:
                raise StorageError('relational database connection failed') from None
            raw.autocommit = False
            connection = _Connection(raw)
            yield connection
        except StorageError:
            if connection is not None:
                connection.raw.rollback()
            raise
        except MigrationError:
            if connection is not None:
                connection.raw.rollback()
            raise StorageError('relational migration violates the known atomic migration contract') from None
        except Exception as exc:
            if connection is not None:
                connection.raw.rollback()
            code = getattr(exc, 'pgcode', None) or getattr(exc, 'sqlstate', None)
            if code and (code.startswith('23') or code == 'P0001'):
                raise Conflict('relational storage constraint violation') from None
            if code or type(exc).__module__.split('.')[0] in {'psycopg', 'psycopg2', 'opengauss'}:
                raise StorageError('relational storage operation failed') from None
            raise
        finally:
            if connection is not None:
                connection.close()
            elif raw is not None:
                raw.close()

    def _set_schema(self, connection):
        connection.execute('SET search_path TO "' + self.schema + '"')
        connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')

    def _validate_schema(self, connection):
        try:
            return validate_history(connection, self.backend)
        except MigrationError as exc:
            raise StorageError('unsupported relational schema history or checksum mismatch') from exc

    def initialize(self):
        with self._connect() as connection:
            exists = connection.execute('SELECT schema_name FROM information_schema.schemata WHERE schema_name=?', (self.schema,)).fetchone()
            if exists is None:
                connection.execute('CREATE SCHEMA "' + self.schema + '"')
            self._set_schema(connection)
            tables = connection.execute('SELECT table_name FROM information_schema.tables WHERE table_schema=?', (self.schema,)).fetchall()
            if tables:
                self._validate_schema(connection)
            else:
                apply(connection, self.backend, clock=self.clock)
                self._validate_schema(connection)
            connection.raw.commit()

    @contextmanager
    def read_transaction(self):
        with self._connect() as connection:
            connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            connection.execute('SET search_path TO "' + self.schema + '"')
            self._validate_schema(connection)
            yield connection
            connection.raw.commit()

    @contextmanager
    def transaction(self):
        with self._connect() as connection:
            self._set_schema(connection)
            # Baseline serializes business transactions across all clients, not just one process.
            connection.execute('SELECT version FROM schema_meta WHERE version=1 FOR UPDATE').fetchone()
            self._validate_schema(connection)
            yield connection
            connection.raw.commit()

    def _assert_initialized(self):
        with self.read_transaction():
            pass

    def migration_plan(self):
        with self.read_transaction() as connection:
            return plan(connection, self.backend)

    def _source_evidence(self, connection):
        from .legacy import _encode_value, _json_bytes
        _, applied = self._validate_schema(connection)
        history = [dict(row) for row in connection.execute('SELECT version,name,checksum,applied_at_ms FROM schema_meta ORDER BY version')]
        identity = connection.execute('SELECT current_database() AS database_name,inet_server_addr() AS server_address,inet_server_port() AS server_port').fetchone()
        root = Path(__file__).parent / 'schema'
        catalogs = [json.loads((root / 'core-catalog.json').read_text())]
        if applied >= 2:
            catalogs.append(json.loads((root / 'iam-catalog.json').read_text()))
        tables = []
        for name in sorted(table['name'] for catalog in catalogs for table in catalog['tables']):
            if not re.fullmatch(r'[a-z][a-z0-9_]*', name):
                raise StorageError('invalid managed table identifier')
            columns = [dict(row) for row in connection.execute(
                'SELECT column_name,data_type,is_nullable,column_default,ordinal_position FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',
                (self.schema, name))]
            if not columns:
                raise StorageError('managed source table is missing')
            quoted = [chr(34) + column['column_name'].replace(chr(34), chr(34)*2) + chr(34) for column in columns]
            query = 'SELECT ' + ','.join(quoted) + ' FROM "' + name + '" ORDER BY ' + ','.join(quoted)
            digest = hashlib.sha256()
            count = 0
            for row in connection.execute(query):
                values = [_encode_value(bytes(value) if isinstance(value, memoryview) else value) for value in row]
                digest.update(_json_bytes(values) + b'\n'); count += 1
            tables.append({'name': name, 'columns': columns, 'row_count': count, 'rows_sha256': digest.hexdigest()})
        content = {'history': history, 'tables': tables}
        return {'format_version': 1, 'backend': self.backend, 'schema': self.schema,
                'database_identity': dict(identity), 'history': history, 'tables': tables,
                'content_sha256': hashlib.sha256(_json_bytes(content)).hexdigest()}

    def source_evidence(self):
        with self.read_transaction() as connection:
            return self._source_evidence(connection)

    def migrate(self, *, backup_manifest):
        if not isinstance(backup_manifest, dict):
            raise StorageError('an externally verified backup manifest is required')
        if (backup_manifest.get('backend') != self.backend or backup_manifest.get('schema') != self.schema
                or backup_manifest.get('restore_verified') is not True):
            raise StorageError('backup must identify this backend/schema and a verified restore exercise')
        if (backup_manifest.get('writers_stopped') is not True
                or not isinstance(backup_manifest.get('operator'), str) or not backup_manifest['operator'].strip()
                or type(backup_manifest.get('created_at_ms')) is not int or backup_manifest['created_at_ms'] <= 0
                or not isinstance(backup_manifest.get('source_evidence'), dict)):
            raise StorageError('backup requires source evidence, stopped-writer and operator attestation')
        path = Path(backup_manifest.get('path', ''))
        expected = backup_manifest.get('sha256')
        if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
            raise StorageError('backup must be an existing private regular file')
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(65536), b''):
                digest.update(block)
        if digest.hexdigest() != expected:
            raise StorageError('backup artifact checksum mismatch')
        with self._connect() as connection:
            connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            connection.execute('SET search_path TO "' + self.schema + '"')
            # Acquire the writer barrier before the first MVCC snapshot can be established.
            connection.execute('LOCK TABLE "' + self.schema + '".schema_meta IN EXCLUSIVE MODE')
            current = self._source_evidence(connection)
            if backup_manifest['source_evidence'] != current:
                raise StorageError('backup source identity, history or content differs from the current locked source')
            _, applied = self._validate_schema(connection)
            apply(connection, self.backend, clock=self.clock, applied=applied)
            self._validate_schema(connection)
            connection.raw.commit()
        return self.migration_plan() | {'backup_sha256': expected, 'backup_path': str(path.absolute())}


class OpenGaussControlStore(PostgreSQLControlStore):
    backend = 'opengauss'
