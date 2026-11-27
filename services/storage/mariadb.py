"""MariaDB adapter for a pre-provisioned, dedicated Storage Core database."""
from contextlib import contextmanager
import hashlib
from pathlib import Path
import re
from urllib.parse import parse_qsl, unquote, urlsplit

from .control import Conflict, StorageError
from .migrations import load_migrations, validate_history
from .relational import PostgreSQLControlStore


SYSTEM_DATABASES = {'mysql', 'information_schema', 'performance_schema', 'sys', 'test'}
STATEMENT_SEPARATOR = '\n-- next statement\n'
DDL_PREFIXES = ('CREATE TABLE ', 'CREATE INDEX ', 'CREATE UNIQUE INDEX ', 'CREATE TRIGGER ', 'ALTER TABLE ')


def _valid_database(database):
    return (isinstance(database, str) and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_$-]{0,63}', database)
            and database.lower() not in SYSTEM_DATABASES)


def mariadb_options(dsn):
    if not isinstance(dsn, str) or not dsn.strip():
        raise ValueError('an explicit MariaDB URI is required')
    url = urlsplit(dsn)
    database = unquote(url.path[1:])
    if (url.scheme != 'mariadb' or not url.hostname or not url.username or not url.password
            or url.fragment or not _valid_database(database)):
        raise ValueError('MariaDB URI requires a host, business account and dedicated database')
    try:
        parameters = parse_qsl(url.query, keep_blank_values=True, strict_parsing=True)
        port = 3306 if url.port is None else url.port
    except ValueError:
        raise ValueError('invalid MariaDB URI port or query') from None
    if port == 0:
        raise ValueError('MariaDB URI requires a nonzero port')
    query = dict(parameters)
    if len(query) != len(parameters) or set(query) - {'connect_timeout', 'sslmode', 'sslrootcert'}:
        raise ValueError('unsupported MariaDB connection options')
    timeout = query.get('connect_timeout', '10')
    if not re.fullmatch(r'[0-9]{1,2}', timeout) or not 1 <= int(timeout) <= 60:
        raise ValueError('MariaDB connect_timeout must be between 1 and 60 seconds')
    sslmode = query.get('sslmode', 'verify-full')
    if sslmode not in {'verify-full', 'disable'} or (sslmode == 'disable' and 'sslrootcert' in query):
        raise ValueError('MariaDB sslmode must be verify-full or disable')
    options = dict(host=url.hostname, port=port, user=unquote(url.username),
                   password=unquote(url.password).encode('utf-8'), database=database, charset='utf8mb4',
                   connect_timeout=int(timeout),
                   ssl_disabled=sslmode=='disable')
    if sslmode == 'verify-full':
        options.update(ssl_ca=query.get('sslrootcert'), ssl_verify_cert=True, ssl_verify_identity=True)
    return options


def migration_statements(migration):
    for raw in migration.sql.split(STATEMENT_SEPARATOR):
        statement = raw.strip()
        if not statement.endswith(';') or not statement.startswith((*DDL_PREFIXES, 'INSERT INTO ')):
            raise StorageError('unsupported MariaDB migration statement')
        yield statement[:-1]


class MariaDBControlStore(PostgreSQLControlStore):
    backend = 'mariadb'

    _valid_schema = staticmethod(_valid_database)

    def __init__(self, connection_factory, *, database, artifact_directory, clock=None):
        super().__init__(connection_factory, schema=database, artifact_directory=artifact_directory, clock=clock)

    @classmethod
    def from_dsn(cls, dsn, *, artifact_directory, clock=None):
        options = mariadb_options(dsn)

        def connect():
            import pymysql
            return pymysql.connect(**options, client_flag=pymysql.constants.CLIENT.FOUND_ROWS)

        return cls(connect, database=options['database'], artifact_directory=artifact_directory, clock=clock)

    def _begin_connection(self, raw):
        version = re.match(r'(?:5\.5\.5-)?(\d+)\.(\d+)\.\d+.*MariaDB', raw.get_server_info(), re.I)
        if not version or tuple(map(int, version.groups())) < (11, 4):
            raise StorageError('MariaDB 11.4 or newer is required')
        raw.autocommit(False)
        # The longest ordered identifiers can occupy 4096 bytes in utf8mb4.
        with raw.cursor() as cursor:
            cursor.execute('SET SESSION max_sort_length = GREATEST(@@SESSION.max_sort_length, 4096)')

    @staticmethod
    def _database_error(exc):
        if type(exc).__module__.split('.')[0] != 'pymysql':
            return None
        code = exc.args[0] if exc.args else None
        if code in {1022, 1048, 1062, 1169, 1216, 1217, 1264, 1406, 1451, 1452, 1644, 4025}:
            return Conflict('relational storage constraint violation')
        return StorageError('MariaDB storage operation failed')

    def _set_schema(self, connection):
        connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')

    def _database_identity(self, connection):
        return connection.execute('SELECT DATABASE() AS database_name, @@hostname AS server_address, @@port AS server_port').fetchone()

    @staticmethod
    def _quote_identifier(name):
        return '`' + name.replace('`', '``') + '`'

    def _evidence_order(self, connection, table, columns):
        keys = connection.execute(
            "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE "
            "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION", (table,)
        ).fetchall()
        if not keys:
            raise StorageError('managed source table is missing its primary key')
        return [self._quote_identifier(key[0]) for key in keys]

    def _validate_schema(self, connection):
        if connection.execute('SELECT version FROM mariadb_schema_pending LIMIT 1').fetchone() is not None:
            raise StorageError('a MariaDB migration was interrupted; restore the verified backup before retrying')
        return super()._validate_schema(connection)

    @contextmanager
    def read_transaction(self):
        with self._connect() as connection:
            connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            self._validate_schema(connection)
            yield connection
            connection.raw.commit()

    def inspect(self):
        with self._connect() as connection:
            connection.execute('SET TRANSACTION READ ONLY')
            objects = self._objects(connection)
            if not objects:
                if self._empty_database_defaults(connection) != ('utf8mb4', 'utf8mb4_unicode_ci'):
                    raise StorageError('new MariaDB database requires utf8mb4 and utf8mb4_unicode_ci')
                return 'empty'
            self._validate_schema(connection)
            return 'ready'

    @staticmethod
    def _empty_database_defaults(connection):
        row = connection.execute(
            'SELECT DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()'
        ).fetchone()
        return tuple(row) if row else ()

    @staticmethod
    def _objects(connection):
        for catalog, name in (('TABLES', 'TABLE_SCHEMA'), ('ROUTINES', 'ROUTINE_SCHEMA'), ('EVENTS', 'EVENT_SCHEMA')):
            if connection.execute(f'SELECT 1 FROM information_schema.{catalog} WHERE {name}=DATABASE() LIMIT 1').fetchone():
                return True
        return False

    def _apply(self, connection, known, applied):
        if applied == len(known):
            return
        # Keep the fence committed across all DDL, including gaps between migration versions.
        connection.execute('INSERT INTO mariadb_schema_pending VALUES(?)', (len(known),))
        connection.raw.commit()
        for migration in known[applied:]:
            for statement in migration_statements(migration):
                connection.execute(statement)
            connection.execute('INSERT INTO schema_meta(version,name,checksum,applied_at_ms) VALUES(?,?,?,?)',
                               (migration.version, migration.name, migration.checksum, self.clock()))
            connection.raw.commit()
        validate_history(connection, self.backend)
        connection.execute('DELETE FROM mariadb_schema_pending WHERE version=?', (len(known),))
        connection.raw.commit()

    def _acquire_migration_lock(self, connection):
        name = 'agent_insight:' + hashlib.sha256(self.schema.lower().encode()).hexdigest()[:48]
        if connection.execute('SELECT GET_LOCK(?,10)', (name,)).fetchone()[0] != 1:
            raise StorageError('another MariaDB schema operation is active')

    def initialize(self):
        self.inspect()
        with self._connect() as connection:
            self._acquire_migration_lock(connection)
            if self._objects(connection):
                self._validate_schema(connection)
                return
            connection.execute('CREATE TABLE mariadb_schema_pending (version BIGINT NOT NULL PRIMARY KEY) ENGINE=InnoDB')
            self._apply(connection, load_migrations(self.backend), 0)

    def migrate(self, *, backup_manifest):
        path, expected = self._check_backup(backup_manifest)
        with self._connect() as connection:
            self._set_schema(connection)
            self._acquire_migration_lock(connection)
            # Drain business writers already holding the schema row before setting the fence.
            connection.execute('SELECT version FROM schema_meta WHERE version=1 FOR UPDATE').fetchone()
            current = self._source_evidence(connection)
            if backup_manifest['source_evidence'] != current:
                raise StorageError('backup source identity, history or content differs from the current locked source')
            known, applied = self._validate_schema(connection)
            self._apply(connection, known, applied)
        return self.migration_plan() | {'backup_sha256': expected, 'backup_path': str(path.absolute())}
