"""Authenticated SQLite client. A transaction owns one persistent HTTP connection."""
import base64
import http.client
import json
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from .control import Conflict, ControlOperations, StorageError
from .relational import StorageRow


def pack(value):
    if isinstance(value, bytes):
        return {'base64': base64.b64encode(value).decode('ascii')}
    raise TypeError('unsupported SQLite value')


def unpack(value):
    if set(value) == {'base64'}:
        return base64.b64decode(value['base64'], validate=True)
    return value


class Result:
    def __init__(self, response):
        self.rowcount = response['count']
        self.rows = (StorageRow(response['columns'], row) for row in response['rows'])

    def fetchone(self):
        return next(self.rows, None)

    def fetchall(self):
        return list(self.rows)

    def __iter__(self):
        return self.rows


class Connection:
    def __init__(self, endpoint, token):
        url = urlsplit(endpoint)
        cls = {'http': http.client.HTTPConnection, 'https': http.client.HTTPSConnection}[url.scheme]
        self.http = cls(url.hostname, url.port, timeout=35)
        self.token = token
        self.session = ''

    def request(self, action, **fields):
        data = json.dumps(fields, default=pack, ensure_ascii=False).encode()
        self.http.request('POST', '/' + action, data, {'Authorization': 'Bearer ' + self.token,
                          'X-Transaction': self.session, 'Content-Type': 'application/json'})
        response = self.http.getresponse()
        result = json.loads(response.read(), object_hook=unpack)
        if response.status == 409:
            raise Conflict('SQLite transaction constraint conflict')
        if response.status != 200:
            raise StorageError('SQLite service ' + action + ' failed (HTTP ' + str(response.status) + ')')
        return result

    def execute(self, sql, parameters=()):
        return Result(self.request('query', sql=sql, parameters=parameters))

    def executemany(self, sql, parameters):
        return Result(self.request('many', sql=sql, parameters=list(parameters)))


class NetworkSQLiteStore(ControlOperations):
    def __init__(self, config):
        self.endpoint = config['endpoint']
        self.token = config['token']
        self.artifact_directory = Path(config['artifacts'])
        self.clock = lambda: time.time_ns() // 1_000_000

    def _single(self, action):
        connection = Connection(self.endpoint, self.token)
        try:
            return connection.request(action)
        finally:
            connection.http.close()

    def migration_plan(self):
        return self._single('plan')

    def initialize(self):
        self._single('initialize')

    def _assert_initialized(self):
        if self.migration_plan().get('state') == 'empty':
            raise StorageError('initialize SQLite service before writing artifacts')

    @contextmanager
    def _transaction(self, write):
        connection = Connection(self.endpoint, self.token)
        try:
            connection.session = connection.request('begin', write=write)['session']
            yield connection
            connection.request('finish')
        finally:
            connection.http.close()

    def read_transaction(self):
        return self._transaction(False)

    def transaction(self, *resources, shared=()):
        return self._transaction(True)
