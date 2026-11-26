import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from services.storage.compatibility import LegacyTraceReads
from services.storage.trace_service import TraceQueries, CursorExpired
from services.storage.control import Conflict
from services.storage.tests.test_compatibility import Authorized, span


class SessionPagingTests(unittest.TestCase):
    def setUp(self):
        self.summary={'trace_id':'trace','span_count':120,'revision':1,'started_at_ms':1000}
        self.source_namespace='otlp'
        self.queries=object.__new__(TraceQueries)
        self.queries.secret=b'test-paging-secret-00000000'
        self.queries.control=None
        self.queries.iam=SimpleNamespace(scope=lambda token:SimpleNamespace(fingerprint=token))
        self.queries.route=lambda *args:{'trace_id':args[-1],'trace_bucket':'2026-11-12','source_namespace':self.source_namespace}
        self.queries.summary=lambda *args:{'trace':dict(self.summary)}
        self.rows=[span(i,started_at_ms=1000+i//3) for i in range(120)]
        self.authorized=SimpleNamespace(read_spans=Mock(side_effect=self.read))
        self.reader=LegacyTraceReads(self.queries,self.authorized)

    def read(self,*args,**options):
        if 'time_after' not in options:
            return [row for row in self.rows if row['span_id']>options.get('after_span_id','')][:options['limit']]
        return [row for row in self.rows if (row['started_at_ms'],row['span_id'])>tuple(options['time_after'])][:options['limit']]

    def test_batches_are_50_and_complete_without_payload_reads(self):
        first=self.reader.session_page('alice','w','trace')
        second=self.reader.session_page('alice','w','trace',first['nextCursor'],index=50)
        third=self.reader.session_page('alice','w','trace',second['nextCursor'],index=100)
        self.assertEqual([len(page['interactions']) for page in [first,second,third]],[50,50,20])
        self.assertIsNone(third['nextCursor'])
        ids=[row['spanId'] for page in [first,second,third] for row in page['interactions']]
        self.assertEqual(ids,[row['span_id'] for row in self.rows])
        self.assertEqual(second['interactions'][0]['_interactionIndex'],50)
        self.assertEqual(self.authorized.read_spans.call_count,3)
        self.assertEqual([call.kwargs['limit'] for call in self.authorized.read_spans.call_args_list],[51,51,51])

    def test_first_page_boundary(self):
        rows = self.rows
        for count in (49, 50, 51):
            with self.subTest(count=count):
                self.rows = rows[:count]
                self.summary['span_count'] = count
                first = self.reader.session_page('alice','w','trace')
                self.assertEqual(len(first['interactions']), min(count, 50))
                if count <= 50:
                    self.assertIsNone(first['nextCursor'])
                else:
                    last = self.reader.session_page('alice','w','trace',first['nextCursor'],index=50)
                    self.assertEqual(len(last['interactions']), count - 50)
                    self.assertIsNone(last['nextCursor'])

    def test_legacy_structure_pages_keep_converted_indices_and_payload(self):
        self.source_namespace = 'agent.record.sample'
        self.authorized.read_payload = Mock(side_effect=Authorized(self.rows).read_payload)
        structure = self.reader.session('alice','w','trace',view='structure')
        first = self.reader.session_page('alice','w','trace')
        second = self.reader.session_page('alice','w','trace',first['nextCursor'])
        third = self.reader.session_page('alice','w','trace',second['nextCursor'])
        self.assertEqual([len(page['interactions']) for page in (first,second,third)], [50,50,20])
        self.assertIsNone(third['nextCursor'])
        self.assertFalse(first['paged'])
        self.assertEqual(first['interactionCount'],120)
        self.assertEqual(first['interactions'] + second['interactions'] + third['interactions'], structure['interactions'])
        self.authorized.read_payload.assert_not_called()
        selected = second['interactions'][0]
        detail = self.reader.session('alice','w','trace',view='interaction',index=50)['interaction']
        self.assertEqual(detail['spanId'], selected['spanId'])
        self.assertEqual(detail['_payloadVersion'], selected['_payloadVersion'])
        self.assertEqual(detail['content'],'answer')

    def test_legacy_langfuse_pages_preserve_nodes_and_scope(self):
        self.source_namespace = 'trace.bundle.sample.lf'
        nodes = [
            {'spanId': row['span_id'], 'parentSpanId': self.rows[0]['span_id'] if index else None}
            for index, row in enumerate(self.rows)
        ]
        metadata = {
            'format':'agent-insight.trace-bundle-node','primary_count':len(nodes),
            'session':{'taskId':'trace','startTime':'2026-11-12T00:00:00Z','interactions':[{'role':'assistant'}]},
            'execution':{},
        }

        def section(token,workspace,route,row,name):
            index = int(row['span_id'],16)
            if name == 'legacy_trace':
                return json.dumps(metadata) if index == 0 else None
            return json.dumps({'format':'agent-insight.trace-item','version':1,'kind':'langfuse_node','index':index,'value':nodes[index]})

        self.reader._section = Mock(side_effect=section)
        first = self.reader.session_page('alice','w','trace')
        second = self.reader.session_page('alice','w','trace',first['nextCursor'])
        third = self.reader.session_page('alice','w','trace',second['nextCursor'])
        self.assertEqual([len(page['langfuseTraceNodes']) for page in (first,second,third)], [50,50,20])
        self.assertEqual(first['langfuseTraceNodes'] + second['langfuseTraceNodes'] + third['langfuseTraceNodes'], nodes)
        self.assertEqual(first['interactions'], [])
        self.assertIsNone(third['nextCursor'])
        with self.assertRaises(CursorExpired):
            self.reader.session_page('bob','w','trace',first['nextCursor'])
        self.summary['revision'] = 2
        with self.assertRaises(CursorExpired):
            self.reader.session_page('alice','w','trace',first['nextCursor'])
        self.assertEqual(self.reader.session('alice','w','trace',view='interactions')['langfuseTraceNodes'],nodes)

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
