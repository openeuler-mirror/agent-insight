import concurrent.futures
import json
import socket
import threading
import time
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import patch

from services.storage.trace_service import create_server, request_capacity


class CapacityTests(unittest.TestCase):
    def server(self, runtime):
        server=create_server(runtime)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def request(self, server):
        try:
            response=urllib.request.urlopen('http://127.0.0.1:'+str(server.server_port)+'/v1/health',timeout=10)
        except urllib.error.HTTPError as exc:
            response=exc
        with response:
            return response.status,dict(response.headers),json.load(response)

    def test_all_64_slots_accept_then_overflow_is_typed_and_recovers(self):
        release=threading.Event()
        self.addCleanup(release.set)
        entered=threading.Condition()
        count=0
        def readiness():
            nonlocal count
            with entered:
                count+=1
                entered.notify_all()
            release.wait(10)
            return 200,{'ready':True}
        server=self.server(SimpleNamespace(readiness=readiness))
        self.assertEqual(server.request_queue_size,64)
        with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:
            pending=[pool.submit(self.request,server) for _ in range(64)]
            try:
                with entered:self.assertTrue(entered.wait_for(lambda:count==64,timeout=8))
                status,headers,body=self.request(server)
                self.assertEqual(status,503)
                self.assertEqual(body['code'],'CORE_BUSY')
                self.assertEqual(headers['Retry-After'],'1')
                self.assertEqual(server.http_metrics()['active'],64)
                self.assertEqual(server.http_metrics()['rejected'],1)
            finally:
                release.set()
            self.assertTrue(all(job.result()[0]==200 for job in pending))
        self.assertEqual(self.request(server)[0],200)
        deadline=time.monotonic()+2
        while server.http_metrics()['active'] and time.monotonic()<deadline:time.sleep(.01)
        metrics=server.http_metrics()
        self.assertEqual(metrics['active'],0)
        self.assertEqual(metrics['peak'],64)
        self.assertEqual(metrics['completed'],65)
        self.assertGreater(metrics['duration_ms_total'],0)

    def test_slot_released_on_handler_error_disconnect_and_thread_start_failure(self):
        runtime=SimpleNamespace(max_concurrent_requests=1,readiness=lambda:(_ for _ in ()).throw(RuntimeError('failure')))
        server=self.server(runtime)
        server.handle_error=lambda *args:None
        self.assertEqual(self.request(server)[0],503)
        deadline=time.monotonic()+2
        while server.http_metrics()['active'] and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(server.http_metrics()['active'],0)
        runtime.readiness=lambda:(200,{'ready':True})
        with socket.create_connection(server.server_address) as conn:conn.sendall(b'GET /v1/health HTTP/1.1\r\n')
        deadline=time.monotonic()+2
        while server.http_metrics()['completed']<2 and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(server.http_metrics()['active'],0)
        with patch('threading.Thread.start',side_effect=RuntimeError('cannot create thread')):
            with self.assertRaises(RuntimeError):server.process_request(None,None)
        self.assertEqual(server.http_metrics()['active'],0)
        self.assertEqual(self.request(server)[0],200)

    def test_health_reports_effective_capacity(self):
        for value, expected in [(96, 96), ('96', 64)]:
            runtime = SimpleNamespace(readiness=lambda: (200, {}), max_concurrent_requests=value)
            with self.subTest(value=value):
                if value == expected:
                    server = self.server(runtime)
                else:
                    with self.assertLogs('services.storage.trace_service', 'WARNING'):
                        server = self.server(runtime)
                status, _, body = self.request(server)
                self.assertEqual(status, 200)
                self.assertEqual(body['http']['capacity'], expected)

    def test_capacity_is_bounded_integer(self):
        for value in (0, -1, 257, True, '96', 64.5, None, [], {}):
            with self.subTest(value=value), self.assertLogs('services.storage.trace_service', 'WARNING') as log:
                self.assertEqual(request_capacity(value), 64)
                self.assertEqual(len(log.output), 1)
                self.assertRegex(log.output[0], 'max_concurrent_requests.*64')
        with self.assertNoLogs('services.storage.trace_service', 'WARNING'):
            for value in (1, 32, 64, 96, 96.0, 256):
                self.assertEqual(request_capacity(value), value)
