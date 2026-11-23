import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from services.storage.compatibility import LegacyTraceReads
from services.storage.trace_service import TraceQueries, CursorExpired
from services.storage.control import Conflict
from services.storage.tests.test_compatibility import span


class SessionPagingTests(unittest.TestCase):
    def setUp(self):
        self.summary={'trace_id':'trace','span_count':1001,'revision':1,'started_at_ms':1000}
        self.queries=object.__new__(TraceQueries)
        self.queries.secret=b'test-paging-secret-00000000'
        self.queries.control=None
        self.queries.iam=SimpleNamespace(scope=lambda token:SimpleNamespace(fingerprint=token))
        self.queries.route=lambda *args:{'trace_id':args[-1],'trace_bucket':'2026-11-12'}
        self.queries.summary=lambda *args:{'trace':dict(self.summary)}
        self.rows=[span(i,started_at_ms=1000+i//3) for i in range(1001)]
        self.authorized=SimpleNamespace(read_spans=Mock(side_effect=self.read))
        self.reader=LegacyTraceReads(self.queries,self.authorized)

    def read(self,*args,**options):
        return [row for row in self.rows if (row['started_at_ms'],row['span_id'])>tuple(options['time_after'])][:options['limit']]

    def test_batches_are_500_and_complete_without_payload_reads(self):
        first=self.reader.session_page('alice','w','trace')
        second=self.reader.session_page('alice','w','trace',first['nextCursor'],index=500)
        third=self.reader.session_page('alice','w','trace',second['nextCursor'],index=1000)
        self.assertEqual([len(page['interactions']) for page in [first,second,third]],[500,500,1])
        self.assertIsNone(third['nextCursor'])
        ids=[row['spanId'] for page in [first,second,third] for row in page['interactions']]
        self.assertEqual(len(set(ids)),1001)
        self.assertEqual(second['interactions'][0]['_interactionIndex'],500)
        self.assertEqual(self.authorized.read_spans.call_count,3)

    def test_cursor_binds_actor_trace_and_revision(self):
        cursor=self.reader.session_page('alice','w','trace')['nextCursor']
        for token,trace in [('bob','trace'),('alice','other')]:
            with self.assertRaises(CursorExpired):self.reader.session_page(token,'w',trace,cursor)
        self.summary['revision']=2
        with self.assertRaises(CursorExpired):self.reader.session_page('alice','w','trace',cursor)

    def test_change_during_page_is_rejected(self):
        def changed(*args,**kwargs):
            self.summary['revision']+=1
            return self.read(*args,**kwargs)
        self.authorized.read_spans.side_effect=changed
        with self.assertRaises(Conflict):self.reader.session_page('alice','w','trace')
