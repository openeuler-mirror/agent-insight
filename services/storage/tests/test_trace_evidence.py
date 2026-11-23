import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from services.storage.tests import test_trace_transfer as fixture
from services.storage.tests.test_trace_transfer import bundle, node
from services.storage.control import Conflict
from services.storage.iam import Forbidden, Unauthorized


class TraceEvidenceTests(unittest.TestCase):
    setUp=fixture.TraceTransferTests.setUp
    drain=fixture.TraceTransferTests.drain

    def evidence(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.trace_evidence'))
        from services.storage.trace_evidence import TraceEvidence
        return TraceEvidence(self.queries,self.authorized)

    def prepared(self,source=None):
        result=self.transfer.import_bundle(self.token,'w',source or bundle());self.drain()
        trace=self.metadata.resolve(self.token,'w',result['rootExecutionId'],'execution')['trace_id']
        return trace

    def test_execution_view_preserves_missing_original_session_without_changing_default(self):
        from services.storage.compatibility import TraceNotFound
        from services.storage.trace_evidence import _hash
        source=bundle();source['executions'][0]['session']=None
        source['executions'][0]['execution'].update(finalResult='完整输出',agentId='registered-agent')
        self.prepared(source);reader=self.evidence()
        with self.assertRaises(TraceNotFound):reader.read(self.token,'w',execution_id='root')
        value=reader.read_execution(self.token,'w',execution_id='root')
        self.assertEqual(value['format'],'agent-insight.trace-execution');self.assertNotIn('session',value)
        self.assertEqual(value['execution']['finalResult'],'完整输出');self.assertEqual(value['execution']['agentId'],'registered-agent')
        self.assertEqual(value['snapshot_hash'],_hash({key:item for key,item in value.items() if key not in ('snapshot_hash','captured_at')}))
        self.assertEqual(reader.read_execution(self.token,'w',execution_id='root')['snapshot_hash'],value['snapshot_hash'])
        with self.assertRaises(Forbidden):reader.read_execution(self.bob,'w',execution_id='root')
        with self.assertRaises(TraceNotFound):reader.read(self.token,'w',execution_id='root')

    def test_full_original_extensions_aliases_owner_and_no_secret_paths_in_manifest(self):
        source=bundle();source['executions'][0]['execution']['query']='完整查询'*2000
        raw=source['executions'][0]['session']['interactions'][0];raw.update(temperature=0.4,request_id='request',_collaboration={'ids':['x']},large=2**62)
        self.prepared(source);value=self.evidence().read(self.token,'w',execution_id='root')
        self.assertEqual(value['format'],'agent-insight.trace-evidence');self.assertEqual(value['execution']['query'],source['executions'][0]['execution']['query'])
        for key in ('temperature','request_id','_collaboration','large'):self.assertEqual(value['session']['interactions'][0][key],raw[key])
        self.assertEqual(value['execution']['id'],'root');self.assertEqual(value['session']['taskId'],'task')
        text=json.dumps(value);self.assertNotIn(self.token,text);self.assertNotIn(str(self.control.artifact_directory),text)
        self.assertEqual(value['manifest']['owner_principal_id'],'alice');self.assertEqual(len(value['snapshot_hash']),64)

    def test_untyped_fault_reference_resolves_task_execution_and_internal_but_rejects_ambiguity(self):
        trace=self.prepared()
        for ref in ('task','root',trace):
            self.assertEqual(self.evidence().read(self.token,'w',trace_ref=ref)['execution']['id'],'root')
        other=bundle([node('another','root',root='another')]);other['rootExecutionId']='another'
        result=self.transfer.import_bundle(self.token,'w',other);self.drain()
        other_trace=self.metadata.resolve(self.token,'w',result['rootExecutionId'],'execution')['trace_id']
        self.metadata.register_aliases_for_provisioning('w',other_trace,task_id='root')
        with self.assertRaises(Conflict):self.evidence().read(self.token,'w',trace_ref='root')

    def test_explicit_root_client_and_skill_origin_fields_are_preserved_for_deployment(self):
        from services.storage.tests.test_observations import packet
        source=packet();span=source['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span.setdefault('attributes',[]).extend([{'key':'agent.insight.client_id','value':{'stringValue':'deployment-client'}},{'key':'skill_origins','value':{'stringValue':'[{"skillName":"skill","clientId":"deployment-client","platform":"opencode","targetMode":"execution_origin","originRef":"origin_0123456789abcdef01234567"}]'}}])
        accepted=self.ingest.accept(self.token,'w',source);self.ingest.work_once('deployment-ingest')
        value=self.evidence().read(self.token,'w',trace_ref=accepted['trace_ids'][0])
        self.assertEqual(value['execution']['clientId'],'deployment-client')
        origins=json.loads(value['execution']['skillOrigins']);self.assertEqual(origins[0]['originRef'],'origin_0123456789abcdef01234567')

    def test_native_root_agent_id_is_preserved_in_full_and_execution_views(self):
        from services.storage.tests.test_observations import packet
        for index,name in enumerate(('agent.id','legacy.agent_id','agentId'),start=1):
            with self.subTest(attribute=name):
                source=packet(trace=str(index)*32);spans=source['resourceSpans'][0]['scopeSpans'][0]['spans']
                spans[0].setdefault('attributes',[]).append({'key':name,'value':{'stringValue':'root-agent-'+str(index)}})
                child=copy.deepcopy(spans[0]);child.update(spanId='2222222222222222',parentSpanId=spans[0]['spanId'])
                child['attributes']=[item for item in child['attributes'] if item['key']!=name]
                child['attributes'].append({'key':name,'value':{'stringValue':'child-agent'}});spans.append(child)
                trace=self.ingest.accept(self.token,'w',source)['trace_ids'][0];self.drain()
                for read in (self.evidence().read,self.evidence().read_execution):
                    self.assertEqual(read(self.token,'w',trace_ref=trace)['execution'].get('agentId'),'root-agent-'+str(index))

    def test_native_raw_skills_without_primary_or_invocation_are_preserved(self):
        from services.storage.tests.test_observations import packet
        cases=[('legacy.skills',{'arrayValue':{'values':[{'stringValue':'raw-only'}]}},['raw-only']),
               ('skills',{'stringValue':'["raw-only"]'},'["raw-only"]')]
        for index,(alias,attribute,expected) in enumerate(cases,start=4):
            with self.subTest(attribute=alias):
                source=packet(trace=str(index)*32)
                source['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'].append({'key':alias,'value':attribute})
                trace=self.ingest.accept(self.token,'w',source)['trace_ids'][0];self.drain()
                metadata=json.loads(self.queries.summary(self.token,'w',trace)['trace']['attributes_json'])
                self.assertEqual(metadata.get('skills'),['raw-only'])
                for read in (self.evidence().read,self.evidence().read_execution):
                    execution=read(self.token,'w',trace_ref=trace)['execution']
                    self.assertEqual(execution.get('skills'),expected)
                    self.assertIsNone(execution.get('skill'));self.assertIsNone(execution.get('invokedSkills'))

    def test_descendant_agent_id_cannot_be_presented_as_root_execution_identity(self):
        from services.storage.tests.test_observations import packet
        source=packet();spans=source['resourceSpans'][0]['scopeSpans'][0]['spans']
        child=copy.deepcopy(spans[0]);child.update(spanId='2222222222222222',parentSpanId=spans[0]['spanId'])
        child.setdefault('attributes',[]).append({'key':'agent.id','value':{'stringValue':'child-agent'}});spans.append(child)
        trace=self.ingest.accept(self.token,'w',source)['trace_ids'][0];self.drain()
        self.assertNotIn('agentId',self.evidence().read(self.token,'w',trace_ref=trace)['execution'])
        self.assertNotIn('agentId',self.evidence().read_execution(self.token,'w',trace_ref=trace)['execution'])

    def test_deployment_identity_is_not_inferred_from_a_descendant_span(self):
        from services.storage.tests.test_observations import packet
        source=packet();spans=source['resourceSpans'][0]['scopeSpans'][0]['spans'];child=copy.deepcopy(spans[0]);child.update(spanId='2222222222222222',parentSpanId=spans[0]['spanId']);child.setdefault('attributes',[]).append({'key':'agent.insight.client_id','value':{'stringValue':'descendant-client'}});spans.append(child)
        accepted=self.ingest.accept(self.token,'w',source);self.ingest.work_once('deployment-ingest')
        value=self.evidence().read(self.token,'w',trace_ref=accepted['trace_ids'][0]);self.assertNotIn('clientId',value['execution'])

    def test_hash_is_stable_across_credentials_and_read_times_but_annotations_change_it(self):
        self.prepared();first=self.evidence().read(self.token,'w',task_id='task')
        second=self.evidence().read(self.iam.issue_session_for_provisioning('alice'),'w',task_id='task')
        self.assertEqual(first['snapshot_hash'],second['snapshot_hash'])
        trace=first['manifest']['trace_id'];self.metadata.patch(self.token,'w',trace,{'query':None,'final_result':None})
        edited=self.evidence().read(self.token,'w',task_id='task');self.assertIsNone(edited['execution']['query']);self.assertIsNone(edited['execution']['finalResult'])
        self.assertNotEqual(first['snapshot_hash'],edited['snapshot_hash'])

    def test_other_owner_forged_workspace_and_conflicting_aliases_rejected(self):
        self.prepared();reader=self.evidence()
        with self.assertRaises(Forbidden):reader.read(self.bob,'w',task_id='task')
        with self.assertRaises(Forbidden):reader.read(self.token,'other',task_id='task')
        second=bundle([node('different','different-task',root='different')]);second['rootExecutionId']='different'
        self.transfer.import_bundle(self.token,'w',second);self.drain()
        with self.assertRaises(ValueError):reader.read(self.token,'w',task_id='task',execution_id='different')

    def test_structural_set_and_revision_mismatch_refuses_before_any_body_read(self):
        self.prepared();reader=self.evidence();original=copy.deepcopy(self.facts.spans)
        for change in ('missing','extra','older','newer'):
            with self.subTest(change=change):
                self.facts.spans=copy.deepcopy(original);key=next(iter(self.facts.spans));row=self.facts.spans[key]
                if change=='missing':self.facts.spans={}
                elif change=='extra':
                    extra=copy.deepcopy(row);extra['span_id']='f'*16;self.facts.spans[(key[0],key[1],extra['span_id'])]=extra
                else:row['revision']+=-1 if change=='older' else 1
                with patch.object(self.authorized,'read_payload',side_effect=AssertionError('body before structure accepted')):
                    with self.assertRaises(reader.unavailable):reader.read(self.token,'w',task_id='task')
        self.facts.spans=original

    def test_summary_lag_and_prepared_without_facts_are_unavailable(self):
        self.prepared();reader=self.evidence();summary=next(iter(self.facts.summaries.values()));summary['revision']-=1
        with self.assertRaises(reader.unavailable):reader.read(self.token,'w',task_id='task')
        self.facts.summaries={}
        with self.assertRaises(reader.unavailable):reader.read(self.token,'w',task_id='task')

    def test_changed_annotation_during_io_is_conflict_and_never_returns_mixed_value(self):
        trace=self.prepared();reader=self.evidence();original=self.authorized.read_payload;once=False
        def changing(*args,**kw):
            nonlocal once
            result=original(*args,**kw)
            if not once:once=True;self.metadata.patch(self.token,'w',trace,{'label':'changed'})
            return result
        with patch.object(self.authorized,'read_payload',side_effect=changing),self.assertRaises(Conflict):reader.read(self.token,'w',task_id='task')

    def test_new_head_during_structure_is_conflict_instead_of_storage_unavailable(self):
        self.prepared();reader=self.evidence();original=self.authorized.read_spans;once=False
        def changing(*args,**kw):
            nonlocal once
            if not once:
                once=True
                with self.control.transaction() as con:
                    con.execute("UPDATE obs_entity_heads SET revision=revision+1,source_revision=source_revision+1 WHERE entity_kind='span'")
            return original(*args,**kw)
        with patch.object(self.authorized,'read_spans',side_effect=changing),self.assertRaises(Conflict):reader.read(self.token,'w',task_id='task')

    def test_revocation_during_io_wins_over_data_failure(self):
        self.prepared();reader=self.evidence();original=self.authorized.read_payload
        def revoke(*args,**kw):
            result=original(*args,**kw);self.iam.revoke_credential(self.token);return result
        with patch.object(self.authorized,'read_payload',side_effect=revoke),self.assertRaises(Unauthorized):reader.read(self.token,'w',task_id='task')

    def test_body_corruption_and_missing_sections_are_not_empty_success(self):
        self.prepared();reader=self.evidence();key=next(iter(self.facts.payloads));self.facts.payloads[key]['legacy_interaction']='{}'
        with self.assertRaises(reader.unavailable):reader.read(self.token,'w',task_id='task')
        self.facts.payloads[key].pop('legacy_interaction')
        with self.assertRaises(reader.unavailable):reader.read(self.token,'w',task_id='task')

    def test_corrupt_or_oversized_artifact_is_bounded_and_refused(self):
        self.prepared();reader=self.evidence()
        with self.control.read_transaction() as con:ref=con.execute("SELECT artifact_ref FROM obs_entity_heads WHERE entity_kind='span'").fetchone()[0]
        Path(ref).write_bytes(b'corrupt')
        with self.assertRaises(reader.unavailable):reader.read(self.token,'w',task_id='task')

    def test_budget_covers_source_and_final_evidence_without_truncation(self):
        source=bundle();source['executions'][0]['session']['interactions'][0]['content']='字'*4000;self.prepared(source);reader=self.evidence()
        with patch('services.storage.trace_evidence.MAX_EVIDENCE_BYTES',1024),self.assertRaises(reader.too_large):reader.read(self.token,'w',task_id='task')

    def test_full_langfuse_nodes_secondary_raw_and_valid_empty_session_preserved(self):
        nodes=[{'traceId':'old','spanId':'s','parentSpanId':None,'kind':'llm','startedAt':1794441600000,'completedAt':1794441601000,'input':'question','output':'body','opaque':{'float':0.7}}]
        source=bundle([node(nodes=nodes)]);self.prepared(source);value=self.evidence().read(self.token,'w',task_id='task')
        self.assertEqual(value['session']['langfuseTraceNodes'],nodes);self.assertEqual(value['session']['interactions'],source['executions'][0]['session']['interactions'])

    def test_empty_session_and_null_session_are_distinct(self):
        self.prepared(bundle([node(interactions=[])]));reader=self.evidence()
        self.assertEqual(reader.read(self.token,'w',task_id='task')['session']['interactions'],[])

    def test_null_session_cannot_be_presented_as_empty_trajectory(self):
        source=bundle();source['executions'][0]['session']=None;self.prepared(source);reader=self.evidence()
        from services.storage.compatibility import TraceNotFound
        with self.assertRaises(TraceNotFound):reader.read(self.token,'w',task_id='task')

    def test_control_writer_can_complete_while_ch_read_is_blocked(self):
        self.prepared();reader=self.evidence();original=self.authorized.read_spans
        def with_writer(*args,**kw):
            self.control.create_workspace('parallel','Parallel')
            return original(*args,**kw)
        with patch.object(self.authorized,'read_spans',side_effect=with_writer):reader.read(self.token,'w',task_id='task')

    def test_native_source_uses_full_query_and_output_without_compact_preview_loss(self):
        from services.storage.tests.test_observations import packet
        body=packet();attrs=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes']
        attrs.extend([{'key':'legacy.session_query','value':{'stringValue':'原始输入'*2000}},
                      {'key':'legacy.final_result','value':{'stringValue':'真实输出'*2000}}])
        trace=self.ingest.accept(self.token,'w',body)['trace_ids'][0];self.drain()
        value=self.evidence().read(self.token,'w',task_id=trace)
        self.assertEqual(value['execution']['query'],'原始输入'*2000);self.assertEqual(value['execution']['finalResult'],'真实输出'*2000)
        self.assertEqual(value['session']['interactions'][0]['content'],'world')

    def test_summary_status_and_compact_structure_corruption_are_unavailable(self):
        self.prepared();reader=self.evidence();summary=next(iter(self.facts.summaries.values()));summary['execution_status']='failed'
        with self.assertRaises(reader.unavailable):reader.read(self.token,'w',task_id='task')
        summary['execution_status']='done';row=next(iter(self.facts.spans.values()));row['attributes_json']='{"agent":"invented"}'
        with self.assertRaises(reader.unavailable):reader.read(self.token,'w',task_id='task')

    def test_capture_uses_portable_bounded_queries(self):
        from contextlib import contextmanager
        self.prepared();reader=self.evidence();original=self.control.read_transaction
        class Result:
            def __init__(self,row):self.row=row
            def fetchone(self):return self.row.fetchone()
            def fetchall(self):return self.row.fetchall()
            def __iter__(self):return iter(self.row)
        class Connection:
            def __init__(self,con):self.con=con
            def execute(self,sql,args=()):
                if 'FROM obs_entity_heads' in sql:self_outer.assertIn('LIMIT',sql.upper())
                return Result(self.con.execute(sql,args))
        self_outer=self
        @contextmanager
        def portable():
            with original() as con:yield Connection(con)
        with patch.object(self.control,'read_transaction',portable):reader.read(self.token,'w',task_id='task')

    def test_alias_annotation_and_head_capture_share_one_read_snapshot(self):
        from contextlib import contextmanager
        import sqlite3
        trace=self.prepared();reader=self.evidence()
        con=sqlite3.connect(self.control.path)
        try:con.execute('PRAGMA journal_mode=WAL')
        finally:con.close()
        original=self.control.read_transaction;changed=False
        class Connection:
            def __init__(self,con):self.con=con
            def execute(inner,sql,args=()):
                nonlocal changed
                result=inner.con.execute(sql,args)
                if not changed and 'SELECT * FROM trace_annotations' in sql:
                    changed=True
                    self.metadata.patch(self.token,'w',trace,{'query':'new'})
                    with self.control.transaction() as writer:writer.execute("UPDATE obs_entity_heads SET revision=revision+1,source_revision=source_revision+1 WHERE entity_kind='span'")
                return result
        @contextmanager
        def during_capture():
            with original() as con:yield Connection(con)
        with patch.object(self.control,'read_transaction',during_capture):before=reader._capture(self.token,'w','task',None)
        self.assertIsNotNone(before['annotation']);self.assertNotIn('query',json.loads(before['annotation']['extra_json']).get('override_fields',[]))
        self.assertEqual(next(head['revision'] for head in before['heads'] if head['entity_kind']=='span'),1)
        after=reader._capture(self.token,'w','task',None)
        self.assertEqual(after['annotation']['query_override'],'new');self.assertEqual(next(head['revision'] for head in after['heads'] if head['entity_kind']=='span'),2)

    def test_deleted_route_during_structure_read_is_conflict(self):
        trace=self.prepared();reader=self.evidence();original=self.authorized.read_spans
        def deleted(*args,**kw):
            rows=original(*args,**kw);self.metadata.delete(self.token,'w',trace);return rows
        with patch.object(self.authorized,'read_spans',side_effect=deleted),self.assertRaises(Conflict):reader.read(self.token,'w',task_id='task')

    def test_artifact_stat_budget_and_span_count_limit_refuse_before_full_read(self):
        self.prepared();reader=self.evidence()
        with patch('services.storage.trace_evidence.MAX_SPANS',0),self.assertRaises(reader.too_large):reader.read(self.token,'w',task_id='task')
        with self.control.read_transaction() as con:ref=con.execute("SELECT artifact_ref FROM obs_entity_heads WHERE entity_kind='span'").fetchone()[0]
        with open(ref,'r+b') as out:out.truncate(16*1024*1024*6+4097)
        with self.assertRaises(reader.too_large):reader.read(self.token,'w',task_id='task')
