import unittest
from services.storage.tests.test_trace_service import TraceQueryTests


class CompatibilityListTests(TraceQueryTests):
    def test_exact_trace_selection_never_scans_other_trace_summaries(self):
        from unittest.mock import patch
        api=self.compatible();baseline=api.read(self.tokens['admin'],'w',{})
        expected=next(row for row in baseline if row['task_id']=='a')
        for params in ({'taskId':'a'},{'executionId':'a'},{'taskIds':'a,a'},{'taskId':'a','facet':'unknown'}):
            with self.subTest(params=params):
                self.facts.calls=[]
                with patch.object(self.queries,'list_traces',side_effect=AssertionError('exact lookup scanned all traces')):
                    self.assertEqual(api.read(self.tokens['admin'],'w',params),[expected])
                queried={value for _,values in self.facts.calls for key,value in values.items() if key.startswith('trace_')}
                self.assertEqual(queried,{'a'})

    def test_exact_alias_intersections_keep_original_rows_statistics_and_pagination(self):
        from unittest.mock import patch
        from services.storage.trace_metadata import TraceMetadata
        from services.storage.compatibility_list import LegacyTraceList
        metadata=TraceMetadata(self.store)
        metadata.register_aliases_for_provisioning('w','a',task_id='old-task-a',execution_id='old-exec-a')
        api=LegacyTraceList(self.queries,metadata);all_rows=api.read(self.tokens['admin'],'w',{})
        wanted=[row for row in all_rows if row['task_id']=='old-task-a']
        both=[row for row in all_rows if row['task_id'] in {'old-task-a','c'}]
        with patch.object(self.queries,'list_traces',side_effect=AssertionError('exact aliases scanned all traces')):
            for params in [
                {'taskId':'old-task-a','executionId':'a','taskIds':'old-task-a,c'},
                {'taskId':'a','executionId':'old-exec-a','taskIds':'a,old-task-a'},
            ]:self.assertEqual(api.read(self.tokens['admin'],'w',params),wanted)
            self.assertEqual(api.read(self.tokens['admin'],'w',{'taskId':'old-task-a','executionId':'b'}),[])
            page=api.read(self.tokens['admin'],'w',{'taskIds':'old-task-a,c','paginated':'1','pageSize':'1','page':'2'})
            self.assertEqual(page['records'],both[1:]);self.assertEqual(page['total'],2);self.assertEqual(page['stats']['total'],2)
            self.assertFalse(page['hasMore']);self.assertTrue(page['canViewAllTraces'])

    def test_empty_exact_selection_is_authorized_and_still_validates_filters(self):
        from unittest.mock import patch
        from services.storage.iam import Forbidden,Unauthorized
        api=self.compatible()
        with patch.object(self.queries,'list_traces',side_effect=AssertionError('empty exact lookup scanned all traces')):
            for params in ({'taskId':'missing'},{'executionId':'b'},{'taskId':'a','taskIds':'c'}):
                self.assertEqual(api.read(self.tokens['alice'],'w',params),[])
            with self.assertRaises(ValueError):api.read(self.tokens['alice'],'w',{'taskId':'missing','filters':'[{"column":"private_gold","operator":"=","value":0}]'})
            with self.assertRaises(Forbidden):api.read(self.tokens['alice'],'foreign',{'taskId':'missing'})
            self.iam.revoke_credential(self.tokens['alice'])
            with self.assertRaises(Unauthorized):api.read(self.tokens['alice'],'w',{'taskId':'missing'})
        self.assertEqual(self.facts.calls,[])

    def test_exact_selection_does_not_narrow_original_global_facets(self):
        api=self.compatible()
        for params in ({'facet':'values','column':'user'},{'facet':'skills'},{'facet':'tags'}):
            self.assertEqual(api.read(self.tokens['admin'],'w',{**params,'taskId':'a'}),api.read(self.tokens['admin'],'w',params))

    def test_exact_trace_postflight_rejects_revocation_and_deletion(self):
        from unittest.mock import patch
        from services.storage.iam import Forbidden
        api=self.compatible()
        self.facts.before_return=lambda:self.iam.set_membership(self.tokens['admin'],'g','alice','member',status='disabled',expected_etag=1)
        with patch.object(self.queries,'list_traces',side_effect=AssertionError('exact lookup scanned all traces')):
            with self.assertRaises(Forbidden):api.read(self.tokens['alice'],'w',{'taskId':'a'})
        self.facts.before_return=None
        def remove():
            with self.store.transaction() as con:con.execute("UPDATE trace_locators SET state='deleting' WHERE trace_id='b'")
        self.facts.before_return=remove
        with patch.object(self.queries,'list_traces',side_effect=AssertionError('exact lookup scanned all traces')):
            with self.assertRaises(Forbidden):api.read(self.tokens['admin'],'w',{'executionId':'b'})

    def test_exact_trace_without_indexed_facts_matches_original_empty_result(self):
        from unittest.mock import patch
        self.facts.rows=[row for row in self.facts.rows if row['trace_id']!='a']
        with patch.object(self.queries,'list_traces',side_effect=AssertionError('exact lookup scanned all traces')):
            self.assertEqual(self.compatible().read(self.tokens['alice'],'w',{'taskId':'a'}),[])

    def test_exact_lookup_rechecks_a_shared_trace_after_its_grant_is_revoked(self):
        from unittest.mock import patch
        from services.storage.iam import Forbidden
        self.iam.share_resource(self.tokens['bob'],'w','trace','b','alice')
        self.facts.before_return=lambda:self.iam.unshare_resource(self.tokens['bob'],'w','trace','b','alice')
        with patch.object(self.queries,'list_traces',side_effect=AssertionError('exact lookup scanned all traces')),self.assertRaises(Forbidden):
            self.compatible().read(self.tokens['alice'],'w',{'taskId':'b'})

    def test_internal_trace_identity_is_opt_in_and_preserves_original_public_aliases(self):
        default=self.compatible().read(self.tokens['alice'],'w',{})
        internal=self.compatible().read(self.tokens['alice'],'w',{'includeCoreIdentity':'1'})
        self.assertTrue(default)
        self.assertTrue(all('core_trace_id' not in row for row in default))
        self.assertEqual([row['task_id'] for row in internal],[row['task_id'] for row in default])
        self.assertTrue(all(row['core_trace_id'] for row in internal))

    def compatible(self):
        from services.storage.compatibility_list import LegacyTraceList
        return LegacyTraceList(self.queries)

    def test_existing_list_records_and_stats_keep_their_contract(self):
        api=self.compatible()
        page=api.read(self.tokens['admin'],'w',{'paginated':'1','databasePagination':'1','listPart':'records','page':'1','pageSize':'2'})
        self.assertEqual(len(page['records']),2);self.assertTrue(page['hasMore']);self.assertTrue(page['canViewAllTraces'])
        self.assertEqual(set(page['records'][0]) & {'task_id','upload_id','agentName','user','timestamp','execution_status'},{'task_id','upload_id','agentName','user','timestamp','execution_status'})
        stats=api.read(self.tokens['admin'],'w',{'paginated':'1','databasePagination':'1','listPart':'stats'})['stats']
        self.assertEqual(stats['total'],3);self.assertEqual(stats['failedCount'],1)
        self.assertIsInstance(stats['avgLatencyMs'],(float,int));self.assertIsInstance(stats['toolErrorRate'],(float,int))

    def test_member_scope_precedes_filters_and_a_spoofed_user_cannot_expand_it(self):
        rows=self.compatible().read(self.tokens['alice'],'w',{'user':'bob','traceUser':'bob'})
        self.assertEqual(rows,[])
        own=self.compatible().read(self.tokens['alice'],'w',{})
        self.assertEqual({r['task_id'] for r in own},{'a','c'})
        self.assertEqual({r['user'] for r in own},{'alice'})

    def test_original_status_facets_sorting_and_filter_ast_are_applied(self):
        api=self.compatible()
        failed=api.read(self.tokens['admin'],'w',{'status':'failed'})
        self.assertEqual([r['task_id'] for r in failed],['b'])
        self.assertEqual(api.read(self.tokens['admin'],'w',{'summary':'traceIds','agentName':'fixture'}),{'traceIds':['c','b','a']})
        self.assertEqual(api.read(self.tokens['admin'],'w',{'facet':'values','column':'user'}),[{'value':'alice','count':2},{'value':'bob','count':1}])
        found=api.read(self.tokens['admin'],'w',{'filters':'[{"column":"agentName","operator":"contains","value":"fix"}]','sort':'agent','dir':'asc'})
        self.assertEqual(len(found),3)
        with self.assertRaises(ValueError):api.read(self.tokens['admin'],'w',{'filters':'[{"column":"private_gold","operator":"contains","value":"x"}]'})

    def test_unknown_tokens_are_not_fabricated_as_zero(self):
        self.facts.rows[0].update(input_tokens='0',output_tokens=None)
        row=next(r for r in self.compatible().read(self.tokens['admin'],'w',{}) if r['task_id']=='a')
        self.assertIsNone(row['tokens']);self.assertEqual(row['input_tokens'],0)

    def test_original_single_execution_and_page_selection(self):
        api=self.compatible()
        self.assertEqual([r['task_id'] for r in api.read(self.tokens['admin'],'w',{'executionId':'b'})],['b'])
        self.assertEqual(api.read(self.tokens['alice'],'w',{'executionId':'b'}),[])
        p=api.read(self.tokens['admin'],'w',{'paginated':'1','pageSize':'2','page':'2'})
        self.assertEqual(len(p['records']),1);self.assertEqual(p['total'],3)

    def test_tool_error_rate_uses_the_existing_percentage_unit(self):
        self.facts.rows[0].update(tool_call_count='10',attributes_json='{"tool_error_count":1}')
        stats=self.compatible().read(self.tokens['admin'],'w',{'paginated':'1','listPart':'stats'})['stats']
        self.assertEqual(stats['toolErrorRate'],10)

    def test_final_result_and_statistics_recheck_deletion_after_page_io(self):
        from services.storage.iam import Forbidden
        original=self.queries.list_traces
        calls=0
        def pages(token,workspace,**options):
            nonlocal calls
            calls+=1
            page=original(token,workspace,limit=1,cursor=options.get('cursor'))
            if calls==2:
                with self.store.transaction() as con:con.execute("UPDATE trace_locators SET state='deleting' WHERE trace_id='c'")
            return page
        self.queries.list_traces=pages
        with self.assertRaises(Forbidden):self.compatible().read(self.tokens['admin'],'w',{'paginated':'1','listPart':'stats'})

    def test_nullable_negative_filters_and_missing_latency_match_original_contract(self):
        api=self.compatible()
        for operator,value in [('none of',['x']),('does not contain','x')]:
            self.assertTrue(api._matches({'model':None},{'column':'model','operator':operator,'value':value}))
        self.facts.rows[0].update(started_at_ms=10,ended_at_ms=40)
        stats=api.read(self.tokens['admin'],'w',{'paginated':'1','listPart':'stats'})['stats']
        self.assertEqual(stats['avgLatencyMs'],10)

    def test_original_aliases_and_internal_bookmarks_select_the_same_trace(self):
        from services.storage.trace_metadata import TraceMetadata
        from services.storage.compatibility_list import LegacyTraceList
        metadata=TraceMetadata(self.store)
        metadata.register_aliases_for_provisioning('w','a',task_id='old-task-a',execution_id='old-exec-a')
        api=LegacyTraceList(self.queries,metadata)
        for key,reference in [('taskId','a'),('taskId','old-task-a'),('executionId','a'),('executionId','old-exec-a'),('taskIds','a,old-task-a')]:
            rows=api.read(self.tokens['alice'],'w',{key:reference})
            self.assertEqual([r['task_id'] for r in rows],['old-task-a'])
        self.assertEqual(api.read(self.tokens['bob'],'w',{'taskId':'old-task-a'}),[])

    def test_observed_agents_and_subagent_facets_use_the_preserved_projection(self):
        self.facts.rows[0]['attributes_json']='{"agents":["worker-agent"],"subagent_name":"reviewer","subagent_type":"worker","agent_session_id":"session-a"}'
        api=self.compatible()
        rows=api.read(self.tokens['alice'],'w',{'filters':'[{"column":"agents","operator":"any of","value":["worker-agent"]}]'})
        self.assertEqual([r['task_id'] for r in rows],['a']);self.assertEqual(rows[0]['subagent_name'],'reviewer')
        self.assertEqual(rows[0]['subagent_type'],'worker');self.assertEqual(rows[0]['agent_session_id'],'session-a')
