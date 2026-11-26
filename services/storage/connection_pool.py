"""Bounded, process-local leases for transactional DB-API connections."""
import collections
import logging
import math
import os
import threading
import time

from .control import StorageError


LOG = logging.getLogger(__name__)
DEFAULTS = dict(enabled=True, min_idle=2, max_size=16, acquire_timeout_seconds=2,
                connect_timeout_seconds=3, idle_timeout_seconds=300,
                max_lifetime_seconds=1800, health_check_idle_seconds=30)


def pool_options(value=None):
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - set(DEFAULTS):
        raise ValueError('invalid connection_pool options')
    options = {**DEFAULTS, **value}
    if type(options['enabled']) is not bool:
        raise ValueError('connection_pool.enabled must be boolean')
    for key in ('min_idle', 'max_size', 'connect_timeout_seconds'):
        if type(options[key]) is not int:
            raise ValueError('connection pool size and connect timeout must be integers')
    if not 0 <= options['min_idle'] <= options['max_size'] <= 128 or options['max_size'] < 1:
        raise ValueError('invalid connection pool capacity')
    for key in DEFAULTS.keys() - {'enabled', 'min_idle', 'max_size'}:
        if type(options[key]) not in (int, float) or not math.isfinite(options[key]) or not 0 < options[key] <= 86400:
            raise ValueError('invalid connection pool timeout')
    return options


class PoolUnavailable(StorageError):
    status = 503


class _Lease:
    def __init__(self, pool, entry, owner):
        object.__setattr__(self, '_pool', pool)
        object.__setattr__(self, '_entry', entry)
        object.__setattr__(self, '_owner', owner)
        object.__setattr__(self, '_returned', False)
        object.__setattr__(self, '_broken', False)

    def __getattr__(self, name):
        if self._returned:
            raise PoolUnavailable('database lease already returned')
        return getattr(self._entry[0], name)

    def __setattr__(self, name, value):
        if name.startswith('_'):
            object.__setattr__(self, name, value)
        else:
            setattr(self._entry[0], name, value)

    def discard(self):
        self._broken = True

    def close(self):
        if not self._returned:
            self._returned = True
            self._pool.release(self._entry, self._owner, self._broken)


class ConnectionPool:
    def __init__(self, factory, options=None, *, clock=time.monotonic):
        self.options = pool_options(options)
        self.factory = factory
        self.clock = clock
        self.pid = os.getpid()
        self.condition = threading.Condition()
        self.idle = []
        self.owners = collections.Counter()
        self.metrics = collections.Counter()
        self.total = 0
        self.creating = 0
        self.stopping = False

    @staticmethod
    def _close(raw):
        try:
            raw.close()
        except BaseException:
            LOG.warning('database_pool close_failed')

    def snapshot(self):
        with self.condition:
            return dict(self.metrics, total=self.total, idle=len(self.idle),
                        active=sum(self.owners.values()), creating=self.creating)

    def acquire(self):
        if os.getpid() != self.pid:
            raise PoolUnavailable('database pool cannot cross processes')
        owner = threading.get_ident()
        started = self.clock()
        deadline = started + self.options['acquire_timeout_seconds']
        for attempt in range(2):
            entry = None
            expired = []
            with self.condition:
                now = self.clock()
                for candidate in list(self.idle):
                    if (now - candidate[1] >= self.options['max_lifetime_seconds'] or
                            len(self.idle) > self.options['min_idle'] and now - candidate[2] >= self.options['idle_timeout_seconds']):
                        self.idle.remove(candidate)
                        self.total -= 1
                        expired.append(candidate[0])
                self.metrics['expired'] += len(expired)
            for raw in expired:
                self._close(raw)
            with self.condition:
                while True:
                    if self.stopping:
                        raise PoolUnavailable('database pool is closing')
                    if self.idle:
                        entry = self.idle.pop()
                        break
                    if self.total < self.options['max_size']:
                        self.total += 1
                        self.creating += 1
                        break
                    remaining = deadline - self.clock()
                    if self.owners.get(owner,0) or remaining <= 0:
                        self.metrics['exhausted'] += 1
                        raise PoolUnavailable('database pool exhausted')
                    self.metrics['waits'] += 1
                    self.condition.wait(remaining)
                self.owners[owner] += 1
            fresh = entry is None
            try:
                if fresh:
                    raw = self.factory()
                    entry = (raw, self.clock(), self.clock())
                    with self.condition:
                        self.creating -= 1
                        self.metrics['created'] += 1
                raw = entry[0]
                if raw.closed:
                    raise PoolUnavailable('closed database connection')
                if not fresh and self.clock() - entry[2] >= self.options['health_check_idle_seconds']:
                    cursor = raw.cursor()
                    try:
                        cursor.execute('SET LOCAL statement_timeout = 2000')
                        cursor.execute('SELECT 1')
                        cursor.fetchone()
                    finally:
                        cursor.close()
                        raw.rollback()
                with self.condition:
                    if self.stopping:
                        raise PoolUnavailable('database pool is closing')
                    self.metrics['acquired'] += 1
                return _Lease(self, entry, owner)
            except BaseException as error:
                with self.condition:
                    self.total -= 1
                    self.owners[owner] -= 1
                    if not self.owners[owner]:del self.owners[owner]
                    if fresh and entry is None:
                        self.creating -= 1
                    self.metrics['connection_failed'] += 1
                    self.condition.notify_all()
                if entry is not None:
                    self._close(entry[0])
                if not isinstance(error, Exception):
                    raise
                LOG.warning('database_pool connection_failed error_type=%s', type(error).__name__)
                if fresh or attempt or self.clock() >= deadline or self.stopping:
                    raise PoolUnavailable('database connection unavailable') from None
        raise PoolUnavailable('database connection unavailable')

    def release(self, entry, owner, broken=False):
        raw, born, _ = entry
        try:
            if not broken and not raw.closed:
                raw.rollback()
                raw.reset()
                raw.autocommit = False
                if raw.get_transaction_status() != 0:
                    raise PoolUnavailable('database transaction did not reset')
            else:
                broken = True
        except BaseException:
            broken = True
            LOG.warning('database_pool cleanup_failed')
        with self.condition:
            self.owners[owner] -= 1
            if not self.owners[owner]:del self.owners[owner]
            discard = broken or self.stopping or self.clock() - born >= self.options['max_lifetime_seconds']
            if discard:
                self.total -= 1
                self.metrics['discarded'] += 1
            else:
                self.idle.append((raw, born, self.clock()))
            self.condition.notify_all()
        if discard:
            self._close(raw)

    def close(self, timeout=5):
        deadline = self.clock() + timeout
        with self.condition:
            self.stopping = True
            idle, self.idle = self.idle, []
            self.total -= len(idle)
            self.condition.notify_all()
        for raw, _, _ in idle:
            self._close(raw)
        with self.condition:
            while self.total and self.clock() < deadline:
                self.condition.wait(max(0, deadline - self.clock()))
