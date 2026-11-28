"""Single-database transport for Storage Core. Closing a socket rolls back its transaction."""
import hmac
import json
import os
import secrets
import sqlite3
import ssl
import tempfile
import threading
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .control import SQLiteControlStore, StorageError
from .sqlite_network import pack, unpack


def authorize(action, table, column, database, trigger):
    allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_INSERT,
               sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}
    if action not in allowed or action == sqlite3.SQLITE_FUNCTION and column.lower() == 'load_extension':
        return sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE) and table in ('schema_meta', 'sqlite_master'):
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, database, token):
        if len(token) < 24 or any(not 33 <= ord(c) <= 126 for c in token):
            raise ValueError('SQLITE_TOKEN must have at least 24 printable non-space ASCII characters')
        self.token = token.encode()
        self.store = SQLiteControlStore(database)
        self.slots = threading.BoundedSemaphore(128)
        self.init_lock = threading.Lock()
        super().__init__(address, Handler)

    def process_request(self, request, address):
        if self.slots.acquire(blocking=False):
            super().process_request(request, address)
        else:
            self.shutdown_request(request)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def initialize(self):
        path = self.store.path
        with self.init_lock:
            if path.exists():
                self.store._assert_initialized()
                return
            with tempfile.TemporaryDirectory(dir=path.parent) as tmp:
                staged = Path(tmp) / 'core.db'
                SQLiteControlStore(staged).initialize()
                os.link(staged, path)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    disable_nagle_algorithm = True
    timeout = 30
    transaction = None
    session = ''
    deadline = 0

    def log_message(self, *_):
        pass

    def finish(self):
        try:
            if self.transaction is not None:
                self.transaction.close()
        finally:
            super().finish()

    def dispatch(self, data):
        store = self.server.store
        if self.transaction is None:
            if self.headers.get('X-Transaction'):
                raise ValueError('stale transaction')
            if self.path == '/plan':
                return store.migration_plan() if store.path.exists() else {'state': 'empty'}
            if self.path == '/initialize':
                self.server.initialize()
                return {}
            if self.path != '/begin' or type(data.get('write')) is not bool:
                raise ValueError('expected transaction start')
            write = data['write']
            self.transaction = sqlite3.connect(store.path.as_uri() + ('?mode=rw' if write else '?mode=ro'),
                                               uri=True, isolation_level=None, timeout=10)
            con = self.transaction
            con.execute('PRAGMA foreign_keys=ON')
            con.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            store._validate_schema(con)
            self.deadline = time.monotonic() + 120
            con.set_progress_handler(lambda: int(time.monotonic() > self.deadline), 10000)
            con.set_authorizer(authorize)
            self.session = secrets.token_hex(24)
            return {'session': self.session}
        if not hmac.compare_digest(self.session, self.headers.get('X-Transaction', '')) or time.monotonic() > self.deadline:
            raise ValueError('invalid or expired session')
        con = self.transaction
        if self.path == '/finish':
            con.set_authorizer(None)
            con.commit()
            con.close()
            self.transaction = None
            self.close_connection = True
            return {}
        if self.path not in ('/query', '/many'):
            raise ValueError('unknown operation')
        execute = con.execute if self.path == '/query' else con.executemany
        cursor = execute(data['sql'], data['parameters'])
        return {'columns': [col[0] for col in cursor.description or ()], 'rows': cursor.fetchall(), 'count': cursor.rowcount}

    def do_POST(self):
        status = 200
        try:
            if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), b'Bearer ' + self.server.token):
                status, result = 401, {}
            else:
                length = int(self.headers['Content-Length'])
                if not 0 < length <= 16 * 1024 * 1024:
                    raise ValueError('invalid request size')
                data = json.loads(self.rfile.read(length), object_hook=unpack)
                if not isinstance(data, dict):
                    raise ValueError('invalid request')
                result = self.dispatch(data)
        except sqlite3.IntegrityError:
            status, result = 409, {}
        except (sqlite3.Error, StorageError, ValueError, TypeError, KeyError, OSError):
            status, result = 400, {}
        if status != 200:
            self.close_connection = True
        payload = json.dumps(result, default=pack).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    path = Path(os.environ['SQLITE_DATABASE']).resolve()
    if args.backup:
        with tempfile.TemporaryDirectory(dir=args.backup.parent) as tmp:
            staged = Path(tmp) / 'backup.db'
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(staged)) as target:
                source.backup(target)
            os.link(staged, args.backup)
        return
    host, port = os.getenv('SQLITE_LISTEN', '127.0.0.1:8080').rsplit(':', 1)
    with Server((host, int(port)), path, os.environ['SQLITE_TOKEN']) as server:
        if os.getenv('SQLITE_TLS_CERT') or os.getenv('SQLITE_TLS_KEY'):
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(os.environ['SQLITE_TLS_CERT'], os.environ['SQLITE_TLS_KEY'])
            server.socket = ctx.wrap_socket(server.socket, server_side=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
