import json
import unittest
from unittest.mock import patch

from services.storage.tests.test_trace_service import TraceQueryTests
from services.storage.compatibility_list import LegacyTraceList
from services.storage.trace_metadata import TraceMetadata
from services.storage.trace_list_query import BatchSnapshot, ListPlan, UseCompatibility, optimized_read
from services.storage.trace_list_sql import query_trace_list
from services.storage.iam import Forbidden
from services.storage.control import Conflict
from services.storage.read_transitions import TraceReadChanged


class TraceListQueryTests(unittest.TestCase):
    def setUp(self):
        self.fixture=TraceQueryTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.api=LegacyTraceList(self.fixture.queries,TraceMetadata(self.fixture.store))
        self.fixture.queries.optimize_lists=True
        self.token=self.fixture.tokens['admin']

    def test_snapshot_only_contains_authorized_traces(self):
        snapshot=BatchSnapshot(self.api,self.fixture.tokens['alice'],'w')
        self.assertEqual(set(snapshot.routes),{'a','c'})
        with self.assertRaises(Forbidden):BatchSnapshot(self.api,self.fixture.tokens['alice'],'w',['b'])

    def test_snapshot_rechecks_annotations_deletion_and_scope(self):
        snapshot=BatchSnapshot(self.api,self.token,'w',['a'])
        self.api.metadata.patch(self.token,'w','a',{'label':'changed'})
        with self.assertRaises(TraceReadChanged):snapshot.recheck()
        snapshot=BatchSnapshot(self.api,self.token,'w',['a'])
        self.api.metadata.delete(self.token,'w','a')
        with self.assertRaises(Forbidden):snapshot.recheck()

    def test_revoked_credential_cannot_reuse_snapshot(self):
        snapshot=BatchSnapshot(self.api,self.token,'w')
        self.fixture.iam.revoke_credential(self.token)
        from services.storage.iam import Unauthorized
        with self.assertRaises(Unauthorized):snapshot.recheck()

    def test_legacy_sources_use_compatibility(self):
        from services.storage.authorized import AuthorizedStorage
        AuthorizedStorage(self.fixture.iam,self.fixture.facts).create_trace(self.token,'w','legacy','2026-11-25',source_namespace='collector.source.v1',native_trace_id='legacy')
        with self.assertRaises(UseCompatibility):BatchSnapshot(self.api,self.token,'w')

    def test_page_enriches_only_selected_ids_and_preserves_record_fields(self):
        snapshot_ids=[]
        original=BatchSnapshot._capture
        def capture(obj,con):
            if obj.enrich:snapshot_ids.extend(obj.routes)
            return original(obj,con)
        expected=self.api.read(self.token,'w',{'paginated':'1','listPart':'records','pageSize':'1'})
        row=next(r for r in self.fixture.facts.rows if r['trace_id']==expected['records'][0]['task_id'])
        with patch.object(self.fixture.facts,'query_trace_list',return_value={'rows':[row]},create=True),patch.object(BatchSnapshot,'_capture',capture):
            result=optimized_read(self.api,self.token,'w',{'paginated':'1','listPart':'records','pageSize':'1'})
        self.assertEqual(result['records'],expected['records'])
        self.assertEqual(snapshot_ids,[row['trace_id']])

    def test_complex_filters_do_not_silently_drop_conditions(self):
        for extra in ({'filters':'[]'},{'query':'hello'},{'skill':'x'},{'anomaly':'error'},{'sort':'cost'}):
            with self.assertRaises(UseCompatibility):ListPlan.parse({'paginated':'1','listPart':'stats',**extra},1000)

    def test_plan_keeps_facet_scope_and_time_boundaries(self):
        plan=ListPlan.parse({'paginated':'1','listPart':'stats','time':'1h','status':'failed','onlySubagents':'1'},4000000)
        self.assertEqual(plan.filters,{'status':'failed','subagents':'only','from':400000})
        plan=ListPlan.parse({'facet':'values','column':'framework'},100)
        self.assertEqual(plan.filters,{'subagents':'all'})

    def test_batched_stats_merge_sums_not_averages(self):
        class Facts:
            def _scope(self,*_):pass
            def _request(self,sql,**_):
                if 'incompatible' in sql:return b'{"incompatible":0}'
                if "'t200'" in sql:return b'{"total":1,"failedCount":1,"latencySum":0,"toolCalls":1,"toolErrors":1}'
                return b'{"total":200,"failedCount":2,"latencySum":1000,"toolCalls":99,"toolErrors":0}'
        routes=[dict(trace_id='t'+str(i),trace_bucket='2026-11-25',created_at_ms=1) for i in range(201)]
        result=query_trace_list(Facts(),'w',routes,ListPlan('stats',filters={'subagents':'main'}))['stats']
        self.assertEqual(result,{'total':201,'failedCount':3,'avgLatencyMs':1000/201,'toolErrorRate':1.0})

    def test_empty_aggregate_is_zero(self):
        self.assertEqual(query_trace_list(None,'w',[],ListPlan('stats')),{'stats':{'total':0,'failedCount':0,'avgLatencyMs':0,'toolErrorRate':0}})

    def test_metadata_shape_guard_prevents_incorrect_aggregation(self):
        class Facts:
            def _scope(self,*_):pass
            def _request(self,sql,**_):return b'{"incompatible":1}'
        with self.assertRaises(UseCompatibility):query_trace_list(Facts(),'w',[dict(trace_id='t',trace_bucket='2026-11-25',created_at_ms=1)],ListPlan('stats'))


    def test_root_batch_checks_payload_integrity_and_metadata(self):
        import hashlib
        from services.storage.contracts import content_hash
        from services.storage.trace_list_sql import read_root_executions
        from services.storage.clickhouse import IncompletePayload
        body=json.dumps({'resource':{},'span':{'legacy.skill':'example'}})
        digest=hashlib.sha256(body.encode()).hexdigest()
        manifest={'schema_version':1,'sections':{'attributes':{'chunk_count':1,'uncompressed_bytes':len(body.encode()),'content_hash':digest,'chunk_hashes':[digest]}}}
        root=dict(trace_id='t',trace_bucket='2026-11-25',span_id='s',payload_revision=content_hash(manifest))
        class Facts:
            corrupt=False
            def _scope(self,*_):pass
            def _request(self,sql,**_):
                if 'obs_span_current' in sql:row=root
                elif 'obs_payload_manifests' in sql:row=dict(root,manifest_json=json.dumps(manifest))
                else:row=dict(root,chunk_no=0,chunk_count=1,uncompressed_bytes=len(body.encode()),content_hash=digest,body=body+'bad' if self.corrupt else body)
                return json.dumps(row).encode()
        facts=Facts();routes=[dict(trace_id='t',trace_bucket='2026-11-25')]
        self.assertEqual(read_root_executions(facts,'w',routes),{'t':{'skill':'example'}})
        facts.corrupt=True
        with self.assertRaises(IncompletePayload):read_root_executions(facts,'w',routes)

    def test_nonfinite_time_is_rejected_before_sql(self):
        with self.assertRaises(ValueError):ListPlan.parse({'paginated':'1','listPart':'stats','timeFrom':float('nan')},0)


if __name__ == '__main__':unittest.main()
