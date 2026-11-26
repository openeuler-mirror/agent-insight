import threading
import time
import unittest

from services.storage.connection_pool import ConnectionPool, PoolUnavailable, pool_options


class Connection:
    def __init__(self):
        self.closed = False
        self.autocommit = False
        self.rollbacks = 0
        self.resets = 0
        self.fail_reset = False
        self.fail_probe = False
        self.session = {}

    def close(self):self.closed = True
    def rollback(self):self.rollbacks += 1
    def reset(self):
        if self.fail_reset:raise OSError('reset failed')
        self.resets += 1
        self.session = {}
    def get_transaction_status(self):return 0
    def cursor(self):return Cursor(self)


class Cursor:
    def __init__(self, connection):self.connection = connection
    def execute(self, _):
        if self.connection.fail_probe:raise OSError('probe failed')
    def fetchone(self):return (1,)
    def close(self):pass


class ConnectionPoolTests(unittest.TestCase):
    def pool(self, **options):
        self.connections = []
        def create():
            connection = Connection();self.connections.append(connection);return connection
        pool = ConnectionPool(create,options)
        self.addCleanup(lambda:pool.close(timeout=0))
        return pool

    def test_transaction_leases_reuse_and_clear_session(self):
        pool = self.pool()
        first = pool.acquire();first.session['schema'] = 'alice';first.close()
        second = pool.acquire()
        self.assertEqual(second.session,{})
        self.assertEqual(len(self.connections),1)
        second.close();second.close()
        self.assertEqual(pool.snapshot()['active'],0)
        self.assertEqual(self.connections[0].resets,2)
        with self.assertRaises(PoolUnavailable):second.cursor()

    def test_nested_transactions_get_distinct_connections_and_fail_without_deadlock(self):
        pool = self.pool(min_idle=0,max_size=2)
        outer,inner = pool.acquire(),pool.acquire()
        self.assertIsNot(outer._entry[0],inner._entry[0])
        with self.assertRaises(PoolUnavailable):pool.acquire()
        inner.close();outer.close()
        self.assertEqual(pool.snapshot()['active'],0)

    def test_capacity_wait_is_bounded_and_waiter_wakes(self):
        pool = self.pool(min_idle=0,max_size=1,acquire_timeout_seconds=.04)
        held = pool.acquire();errors=[]
        def wait():
            try:pool.acquire()
            except PoolUnavailable:errors.append('exhausted')
        thread=threading.Thread(target=wait);thread.start();thread.join(1)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,['exhausted'])
        held.close()
        lease=pool.acquire();lease.close()

    def test_creation_counts_toward_capacity(self):
        entered=threading.Event();proceed=threading.Event();connections=[]
        def create():
            entered.set();proceed.wait(1);raw=Connection();connections.append(raw);return raw
        pool=ConnectionPool(create,dict(min_idle=0,max_size=1,acquire_timeout_seconds=.03))
        def work():
            lease=pool.acquire();lease.close()
        thread=threading.Thread(target=work);thread.start();self.assertTrue(entered.wait(1))
        try:
            with self.assertRaises(PoolUnavailable):pool.acquire()
            self.assertEqual(pool.snapshot()['creating'],1)
        finally:proceed.set();thread.join(1);pool.close()
        self.assertEqual(len(connections),1)

    def test_bad_idle_connection_is_replaced(self):
        pool=self.pool();lease=pool.acquire();lease.close();self.connections[0].closed=True
        replacement=pool.acquire();replacement.close()
        self.assertEqual(len(self.connections),2)
        self.assertEqual(pool.snapshot()['active'],0)

    def test_cleanup_failure_does_not_turn_committed_work_into_error(self):
        pool=self.pool();lease=pool.acquire();lease.fail_reset=True;lease.close()
        self.assertTrue(self.connections[0].closed)
        self.assertEqual(pool.snapshot()['total'],0)
        replacement=pool.acquire();replacement.close()

    def test_health_check_and_expiration_do_not_interrupt_active_lease(self):
        pool=self.pool(min_idle=0,max_lifetime_seconds=10,health_check_idle_seconds=2)
        now=[0.];pool.clock=lambda:now[0]
        lease=pool.acquire();lease.close();self.connections[0].fail_probe=True
        now[0]=3
        lease=pool.acquire();self.assertEqual(len(self.connections),2)
        now[0]=20;self.assertFalse(lease.closed);lease.close()
        self.assertEqual(pool.snapshot()['total'],0)

    def test_close_rejects_new_work_but_does_not_close_active_connection(self):
        pool=self.pool();lease=pool.acquire();pool.close(timeout=0)
        self.assertFalse(self.connections[0].closed)
        with self.assertRaises(PoolUnavailable):pool.acquire()
        lease.close();self.assertTrue(self.connections[0].closed)

    def test_failed_factory_releases_capacity_and_does_not_replay(self):
        calls=[]
        def create():calls.append(1);raise OSError('no database')
        pool=ConnectionPool(create)
        with self.assertRaises(PoolUnavailable):pool.acquire()
        self.assertEqual(len(calls),1)
        self.assertEqual(pool.snapshot()['total'],0)
        self.assertEqual(pool.snapshot()['creating'],0)

    def test_invalid_options_and_cross_process_use_are_rejected(self):
        for options in ({'max_size':0},{'min_idle':17},{'enabled':1},{'other':3},{'acquire_timeout_seconds':float('nan')}):
            with self.assertRaises(ValueError):pool_options(options)
        pool=self.pool();pool.pid=-1
        with self.assertRaises(PoolUnavailable):pool.acquire()


if __name__ == '__main__':unittest.main()
