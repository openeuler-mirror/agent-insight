import copy
import importlib
import json
import os
import uuid
import tempfile
import unittest
from pathlib import Path

from services.storage.control import SQLiteControlStore, Conflict, StorageError
from services.storage.iam import IAMStore, Forbidden
from services.storage.contracts import content_hash


def packet(span='1'*16, revision=1, tokens=None, trace='a'*32):
    attrs=[{'key':'agent_insight.revision','value':{'intValue':str(revision)}},
           {'key':'gen_ai.input','value':{'stringValue':'hello'}},
           {'key':'gen_ai.output','value':{'stringValue':'world'}}]
    if tokens is not None: attrs.append({'key':'gen_ai.usage.input_tokens','value':{'intValue':str(tokens)}})
    return {'resourceSpans':[{'resource':{'attributes':[{'key':'service.name','value':{'stringValue':'test-agent'}}]},
        'scopeSpans':[{'spans':[{'traceId':trace,'spanId':span,'name':'chat','kind':3,
            'startTimeUnixNano':'1794441600000000000','endTimeUnixNano':'1794441601000000000',
            'attributes':attrs,'status':{'code':1}}]}]}]}


class Facts:
    def __init__(self): self.spans=[]; self.summaries=[]; self.bundles=[]; self.fail_summary=False
    def write_payload_bundle(self,*args):
        self.bundles.append(copy.deepcopy(args)); return {}
    def write_spans(self,rows): self.spans.extend(copy.deepcopy(rows))
    def _insert(self,table,rows):
        if self.fail_summary:
            self.fail_summary=False
            raise OSError('sink unavailable')
        assert table=='obs_trace_current'
        self.summaries.extend(copy.deepcopy(rows))


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.now=200000
        self.control=self.make_control()
        self.control.initialize(); self.iam=IAMStore(self.control)
        for name in ('admin','alice','bob'): self.iam.create_principal(name,name,name)
        self.iam.create_group('g','team','Team','admin')
        for name in ('alice','bob'): self.iam.set_membership_for_provisioning('g',name,'member')
        self.control.create_workspace('w','Workspace'); self.iam.bind_workspace('w',group_id='g')
        self.tokens={name:self.iam.issue_session_for_provisioning(name) for name in ('admin','alice','bob')}
        self.facts=Facts()
        self.cls=importlib.import_module('services.storage.observations').ObservationIngest
        self.service=self.cls(self.control,self.facts)

    def make_control(self):
        return SQLiteControlStore(Path(self.tmp.name)/'db',clock=lambda:self.now)

    def rows(self,table):
        with self.control.read_transaction() as con: return [dict(row) for row in con.execute('SELECT * FROM '+table)]

    def test_pending_limit_rejects_new_batches_but_keeps_idempotent_receipts(self):
        self.control.max_pending_ingest_batches=1
        first=self.service.accept(self.tokens['alice'],'w',packet(),receipt_key='first')
        duplicate=self.service.accept(self.tokens['alice'],'w',packet(),receipt_key='first')
        self.assertEqual(first['batch_id'],duplicate['batch_id'])
        self.assertTrue(duplicate['duplicate'])
        with self.assertRaises(Conflict) as caught:
            self.service.accept(self.tokens['alice'],'w',packet(span='2'*16),receipt_key='second')
        self.assertEqual(caught.exception.code,'QUEUE_LIMIT')
        self.assertEqual(len(self.rows('ingest_batches')),1)
        self.service.work_once('worker')
        accepted=self.service.accept(self.tokens['alice'],'w',packet(span='2'*16),receipt_key='second')
        self.assertFalse(accepted['duplicate'])

    def test_explicit_tool_role_with_usage_does_not_invent_llm_or_tool_name(self):
        for key in ('legacy.role','role'):
            with self.subTest(key=key):
                body=packet(span=('2' if key=='role' else '1')*16)
                span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
                span['attributes'].extend([{'key':key,'value':{'stringValue':'tool'}},
                    {'key':'gen_ai.usage.output_tokens','value':{'intValue':'3'}}])
                span['status']['code']=2
                self.service.accept(self.tokens['alice'],'w',body)
                self.assertTrue(self.service.work_once('worker'))
                row=self.facts.spans[-1]
                self.assertEqual(row['kind'],'tool');self.assertEqual(row['tool_name'],'')
                self.assertEqual(row['output_tokens'],3)
        self.assertEqual(self.facts.summaries[-1]['tool_call_count'],2)
        self.assertEqual(self.facts.summaries[-1]['llm_call_count'],0)
        self.assertEqual(json.loads(self.facts.summaries[-1]['attributes_json'])['tool_error_count'],2)

    def test_accept_is_durable_before_ack_and_worker_indexes_after_restart(self):
        accepted=self.service.accept(self.tokens['alice'],'w',packet())
        self.assertEqual(accepted['state'],'accepted'); self.assertFalse(accepted['duplicate'])
        row=self.rows('ingest_batches')[0]
        self.assertTrue(Path(row['packet_ref']).is_file())
        self.assertEqual(len(self.rows('trace_locators')),1)
        self.assertEqual(len(self.rows('iam_resource_access')),1)
        self.assertEqual(self.facts.spans,[])
        self.assertTrue(self.cls(self.control,self.facts).work_once('worker'))
        state=self.service.batch_status(self.tokens['alice'],'w',accepted['batch_id'])
        self.assertEqual(state['state'],'indexed')
        self.assertEqual(self.rows('outbox_events')[0]['state'],'sent')
        self.assertEqual(len(self.facts.spans),1)
        self.assertEqual(self.facts.summaries[0]['span_count'],1)
        self.assertIsNone(self.facts.summaries[0]['input_tokens'])

    def test_invalid_whole_packet_has_no_partial_metadata(self):
        body=packet(); body['resourceSpans'][0]['scopeSpans'][0]['spans'].append({'traceId':'bad'})
        with self.assertRaises(ValueError): self.service.accept(self.tokens['alice'],'w',body)
        for table in ('trace_locators','iam_resource_access','ingest_batches','outbox_events'):
            self.assertEqual(self.rows(table),[])

    def test_receipt_idempotency_and_hash_collision_rejection(self):
        first=self.service.accept(self.tokens['alice'],'w',packet(),receipt_key='receipt')
        again=self.service.accept(self.tokens['alice'],'w',packet(),receipt_key='receipt')
        self.assertTrue(again['duplicate']); self.assertEqual(first['batch_id'],again['batch_id'])
        with self.assertRaises(Conflict): self.service.accept(self.tokens['alice'],'w',packet(tokens=9),receipt_key='receipt')
        self.assertEqual(len(self.rows('ingest_batches')),1)

    def test_fsync_artifact_failure_never_acknowledges_or_creates_trace(self):
        def fail(_): raise OSError('disk full')
        self.control.persist_artifact=fail
        with self.assertRaises(OSError): self.service.accept(self.tokens['alice'],'w',packet())
        self.assertEqual(self.rows('trace_locators'),[])
        self.assertEqual(self.rows('ingest_batches'),[])

    def test_cross_owner_append_and_batch_status_are_denied(self):
        first=self.service.accept(self.tokens['alice'],'w',packet())
        with self.assertRaises(Forbidden): self.service.accept(self.tokens['bob'],'w',packet(span='2'*16))
        with self.assertRaises(Forbidden): self.service.batch_status(self.tokens['bob'],'w',first['batch_id'])
        self.assertEqual(len(self.rows('ingest_batches')),1)

    def test_partial_sink_retry_reuses_plan_and_every_revision(self):
        first=self.service.accept(self.tokens['alice'],'w',packet()); self.facts.fail_summary=True
        self.assertTrue(self.service.work_once('one'))
        batch=self.rows('ingest_batches')[0]; self.assertEqual(batch['state'],'prepared')
        frozen=batch['plan_ref']; heads=self.rows('obs_entity_heads')
        first_span=copy.deepcopy(self.facts.spans[0])
        self.now+=10000
        self.assertTrue(self.cls(self.control,self.facts).work_once('two'))
        self.assertEqual(self.rows('ingest_batches')[0]['plan_ref'],frozen)
        self.assertEqual(self.rows('obs_entity_heads'),heads)
        self.assertEqual(self.facts.spans[-1],first_span)
        self.assertEqual(self.service.batch_status(self.tokens['alice'],'w',first['batch_id'])['state'],'indexed')

    def test_source_stale_ignored_conflict_quarantined_and_new_span_accumulates(self):
        self.service.accept(self.tokens['alice'],'w',packet(revision=2,tokens=5)); self.service.work_once('w')
        self.service.accept(self.tokens['alice'],'w',packet(revision=1,tokens=1)); self.service.work_once('w')
        self.assertEqual(len(self.facts.spans),1)
        bad=self.service.accept(self.tokens['alice'],'w',packet(revision=2,tokens=6)); self.service.work_once('w')
        self.assertEqual(self.service.batch_status(self.tokens['alice'],'w',bad['batch_id'])['state'],'failed')
        self.assertEqual(len(self.facts.spans),1)
        self.service.accept(self.tokens['alice'],'w',packet(span='2'*16,tokens=7)); self.service.work_once('w')
        self.assertEqual(self.facts.summaries[-1]['span_count'],2)
        self.assertEqual(self.facts.summaries[-1]['input_tokens'],12)
        self.assertIsNone(self.facts.summaries[-1]['output_tokens'])

    def test_higher_revision_uses_delta_counts_and_unknown_coverage(self):
        self.service.accept(self.tokens['alice'],'w',packet(tokens=3)); self.service.work_once('w')
        self.service.accept(self.tokens['alice'],'w',packet(revision=2,tokens=8)); self.service.work_once('w')
        summary=self.facts.summaries[-1]
        self.assertEqual(summary['span_count'],1); self.assertEqual(summary['input_tokens'],8)
        self.assertEqual(summary['revision'],2)
        self.assertEqual(json.loads(summary['attributes_json'])['output_missing_count'],1)

    def test_active_global_lease_blocks_newer_batches(self):
        self.service.accept(self.tokens['alice'],'w',packet())
        self.service.accept(self.tokens['alice'],'w',packet(span='2'*16))
        with self.control.transaction() as con:
            first=con.execute('SELECT event_id FROM outbox_events ORDER BY created_at_ms,event_id LIMIT 1').fetchone()[0]
            con.execute("UPDATE outbox_events SET state='dispatching',lease_owner='other',lease_until_ms=? WHERE event_id=?",(self.now+30000,first))
        self.assertFalse(self.service.work_once('mine'))
        self.assertEqual(self.facts.spans,[])

    def test_worker_preserves_accepted_data_after_actor_revocation(self):
        self.service.accept(self.tokens['alice'],'w',packet())
        self.iam.set_membership(self.tokens['admin'],'g','alice','member',status='disabled',expected_etag=1)
        self.assertTrue(self.service.work_once('trusted'))
        self.assertEqual(len(self.facts.spans),1)

    def test_completed_status_and_error_delta_use_ui_contract(self):
        body=packet()
        body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['status']['code']=2
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(self.facts.spans[-1]['execution_status'],'failed')
        self.assertEqual(self.facts.summaries[-1]['execution_status'],'failed')
        self.assertEqual(json.loads(self.facts.summaries[-1]['attributes_json'])['error_count'],1)
        self.service.accept(self.tokens['alice'],'w',packet(revision=2));self.service.work_once('worker')
        self.assertEqual(self.facts.summaries[-1]['execution_status'],'done')
        self.assertEqual(json.loads(self.facts.summaries[-1]['attributes_json'])['error_count'],0)

    def test_write_only_api_key_can_read_own_receipt_but_not_other_receipt(self):
        token=self.iam.issue_api_credential(self.tokens['alice'],'w',capabilities=['write'])
        accepted=self.service.accept(token,'w',packet())
        self.assertEqual(self.service.batch_status(token,'w',accepted['batch_id'])['state'],'accepted')
        other=self.service.accept(self.tokens['bob'],'w',packet(trace='b'*32))
        with self.assertRaises(Forbidden): self.service.batch_status(token,'w',other['batch_id'])

    def test_private_ingest_does_not_change_scope_fingerprint(self):
        before=self.iam.scope(self.tokens['alice']).fingerprint
        self.service.accept(self.tokens['alice'],'w',packet())
        self.assertEqual(self.iam.scope(self.tokens['alice']).fingerprint,before)

    def test_negative_attribute_and_non_ascii_keys_survive_full_payload(self):
        body=packet()
        body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'].extend([
            {'key':'温度','value':{'intValue':'-12'}},
            {'key':'ratio','value':{'doubleValue':0.125}}])
        self.service.accept(self.tokens['alice'],'w',body)
        self.service.work_once('worker')
        self.assertEqual(len(self.facts.spans),1)
        attributes=json.loads(self.facts.bundles[0][-1]['attributes'])
        self.assertEqual(attributes['span']['温度'],-12)
        self.assertEqual(attributes['span']['ratio'],0.125)

    def test_large_exact_token_sum_survives_artifact_serialization(self):
        maximum=2**53-1
        for span in ('1'*16,'2'*16):
            self.service.accept(self.tokens['alice'],'w',packet(span=span,tokens=maximum))
            self.service.work_once('worker')
        self.assertEqual(self.facts.summaries[-1]['span_count'],2)
        self.assertEqual(self.facts.summaries[-1]['input_tokens'],maximum*2)
        self.assertEqual({b['state'] for b in self.rows('ingest_batches')},{'indexed'})

    def test_bucket_is_frozen_on_first_accept_even_when_next_span_is_other_day(self):
        first=self.service.accept(self.tokens['alice'],'w',packet());self.service.work_once('worker')
        body=packet(span='2'*16)
        span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['startTimeUnixNano']='1794528000000000000';span['endTimeUnixNano']='1794528001000000000'
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(self.facts.spans[0]['trace_bucket'],self.facts.spans[1]['trace_bucket'])
        self.assertEqual(len(self.rows('trace_locators')),1)

    def test_lease_fence_prevents_old_worker_finishing_after_reclaim(self):
        self.service.accept(self.tokens['alice'],'w',packet())
        old=self.service._claim('old',1000)
        self.now+=1001
        replacement=self.service._claim('new',1000)
        self.assertIsNotNone(replacement)
        from services.storage.observations import _LeaseLost
        with self.assertRaises(_LeaseLost): self.service._prepare(old)
        self.assertEqual(self.rows('obs_entity_heads'),[])

    def test_deleted_trace_is_never_reactivated_by_accepted_work(self):
        accepted=self.service.accept(self.tokens['alice'],'w',packet())
        with self.control.transaction() as con: con.execute("UPDATE trace_locators SET state='deleting'")
        self.service.work_once('worker')
        self.assertEqual(self.rows('ingest_batches')[0]['state'],'failed')
        self.assertEqual(self.facts.spans,[])
        with self.assertRaises(Forbidden): self.service.accept(self.tokens['alice'],'w',packet(span='2'*16))

    def test_schema_rejects_cross_workspace_head_and_bad_metadata(self):
        self.service.accept(self.tokens['alice'],'w',packet());self.service.work_once('worker')
        for statement in (
            "UPDATE obs_entity_heads SET revision=0",
            "UPDATE obs_entity_heads SET source_revision='bad'",
            "UPDATE obs_entity_heads SET content_hash='"+'G'*64+"'",
            "UPDATE obs_entity_heads SET workspace_id='missing'",
            "UPDATE ingest_batches SET state='other'",
            "UPDATE ingest_batches SET accepted_at_ms=-1",
            "UPDATE ingest_batches SET indexed_at_ms=NULL"):
            with self.subTest(statement=statement),self.assertRaises(StorageError):
                with self.control.transaction() as con: con.execute(statement)
        with self.control.read_transaction() as con:
            if isinstance(self.control,SQLiteControlStore):
                self.assertEqual(con.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_receipt_plan_and_entity_version_ledgers_cannot_be_rewritten(self):
        self.service.accept(self.tokens['alice'],'w',packet());self.service.work_once('worker')
        statements=[
            "UPDATE ingest_batches SET principal_id='bob'",
            "UPDATE ingest_batches SET packet_ref='/tmp/other'",
            "UPDATE ingest_batches SET receipt_key='changed'",
            "UPDATE ingest_batches SET plan_ref='/tmp/other'",
            "UPDATE ingest_batches SET state='accepted'",
            "UPDATE obs_entity_heads SET revision=revision-1",
            "UPDATE obs_entity_heads SET source_revision=source_revision-1 WHERE entity_kind='span'",
            "UPDATE obs_entity_heads SET entity_id='other' WHERE entity_kind='span'",
            "DELETE FROM obs_entity_heads",
            "DELETE FROM ingest_batches"]
        for statement in statements:
            with self.subTest(statement=statement),self.assertRaises(StorageError):
                with self.control.transaction() as con: con.execute(statement)

    def test_corrected_boundary_timestamps_reflect_latest_span_revisions(self):
        self.service.accept(self.tokens['alice'],'w',packet());self.service.work_once('worker')
        body=packet(revision=2)
        row=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        row['startTimeUnixNano']='1794441600200000000'
        row['endTimeUnixNano']='1794441600800000000'
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        summary=self.facts.summaries[-1]
        self.assertEqual(summary['started_at_ms'],1794441600200)
        self.assertEqual(summary['ended_at_ms'],1794441600800)

    def test_corrupt_durable_packet_is_quarantined_before_any_sink(self):
        self.service.accept(self.tokens['alice'],'w',packet())
        ref=self.rows('ingest_batches')[0]['packet_ref']
        Path(ref).write_text('{}')
        self.service.work_once('worker')
        self.assertEqual(self.rows('ingest_batches')[0]['state'],'failed')
        self.assertEqual(self.rows('outbox_events')[0]['state'],'dead')
        self.assertEqual(self.facts.spans,[])

    def test_worker_clock_regression_cannot_break_durable_indexed_ack(self):
        self.service.accept(self.tokens['alice'],'w',packet())
        self.now-=1000
        self.service.work_once('worker')
        batch=self.rows('ingest_batches')[0]
        self.assertEqual(batch['state'],'indexed')
        self.assertGreaterEqual(batch['indexed_at_ms'],batch['accepted_at_ms'])

    def test_prepared_retry_cannot_resume_into_retired_trace_route(self):
        self.service.accept(self.tokens['alice'],'w',packet());self.facts.fail_summary=True
        self.service.work_once('first');written=len(self.facts.spans)
        with self.control.transaction() as con: con.execute("UPDATE trace_locators SET state='deleting'")
        self.now+=10000
        self.service.work_once('retry')
        self.assertEqual(len(self.facts.spans),written)
        self.assertEqual(self.rows('ingest_batches')[0]['state'],'failed')
        self.assertEqual(self.rows('outbox_events')[0]['state'],'dead')

    def test_slow_prepare_renews_lease_before_publishing_to_sink(self):
        self.service.accept(self.tokens['alice'],'w',packet())
        persist=self.control.persist_artifact
        def slow(value):
            result=persist(value);self.now+=1100;return result
        self.control.persist_artifact=slow
        self.service.work_once('worker',lease_ms=1000)
        self.assertEqual(self.rows('ingest_batches')[0]['state'],'indexed')
        self.assertEqual(len(self.facts.spans),1)

    def test_shared_resource_attributes_cannot_expand_packet_without_bound(self):
        from unittest.mock import patch
        body=packet()
        body['resourceSpans'][0]['resource']['attributes'].append({'key':'large','value':{'stringValue':'x'*3000}})
        second=copy.deepcopy(body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]);second['spanId']='2'*16
        body['resourceSpans'][0]['scopeSpans'][0]['spans'].append(second)
        with patch('services.storage.observations.MAX_NORMALIZED_BYTES',5000,create=True):
            with self.assertRaises(ValueError): self.service.accept(self.tokens['alice'],'w',body)
        self.assertEqual(self.rows('trace_locators'),[])

    def test_cross_service_otlp_preserves_one_trace_and_parent_child_relationship(self):
        body=packet()
        child=packet(span='2'*16)['resourceSpans'][0]
        child['resource']['attributes'][0]['value']['stringValue']='child-service'
        child['scopeSpans'][0]['spans'][0]['parentSpanId']='1'*16
        body['resourceSpans'].append(child)
        accepted=self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(len(accepted['trace_ids']),1)
        self.assertEqual({row['source_namespace'] for row in self.facts.spans},{'otlp'})
        self.assertEqual(self.facts.spans[1]['parent_span_id'],'1'*16)
        self.assertEqual(self.facts.summaries[0]['span_count'],2)

    def test_explicit_source_namespace_separates_same_native_trace(self):
        first=packet();second=packet(span='2'*16)
        for body,namespace in [(first,'integration-a'),(second,'integration-b')]:
            body['resourceSpans'][0]['resource']['attributes'].append({'key':'agent_insight.source_namespace','value':{'stringValue':namespace}})
        body={'resourceSpans':first['resourceSpans']+second['resourceSpans']}
        accepted=self.service.accept(self.tokens['alice'],'w',body)
        self.assertEqual(len(accepted['trace_ids']),2)

    def test_trace_bucket_must_fit_clickhouse_date_before_durable_accept(self):
        body=packet();span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['startTimeUnixNano']=str(2**64-2);span['endTimeUnixNano']=str(2**64-1)
        with self.assertRaises(ValueError): self.service.accept(self.tokens['alice'],'w',body)
        self.assertEqual(self.rows('trace_locators'),[])

    def test_cross_service_child_does_not_replace_root_agent_display(self):
        self.service.accept(self.tokens['alice'],'w',packet());self.service.work_once('worker')
        child=packet(span='2'*16)
        child['resourceSpans'][0]['resource']['attributes'][0]['value']['stringValue']='child-service'
        child['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['parentSpanId']='1'*16
        self.service.accept(self.tokens['alice'],'w',child);self.service.work_once('worker')
        self.assertEqual(self.facts.summaries[-1]['agent_name'],'test-agent')

    def test_tool_input_output_does_not_count_as_llm_call(self):
        body=packet()
        body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'].append({'key':'gen_ai.tool.name','value':{'stringValue':'search'}})
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(self.facts.spans[-1]['kind'],'tool')
        self.assertEqual(self.facts.summaries[-1]['tool_call_count'],1)
        self.assertEqual(self.facts.summaries[-1]['llm_call_count'],0)

    def test_worker_uses_128_span_bulk_payload_calls_and_frozen_retry_plan(self):
        from services.storage.observations import _payload_revision
        class BulkFacts(Facts):
            def __init__(self): super().__init__();self.bulk_calls=[];self.fail_once=True
            def write_payload_bundles(self,payloads):
                self.bulk_calls.append(copy.deepcopy(payloads))
                if self.fail_once:
                    self.fail_once=False
                    raise OSError('partial chunk write')
                return [{'payload_revision':_payload_revision(p['sections'])} for p in payloads]
            def write_payload_bundle(self,*args): raise AssertionError('single Span path bypassed bulk')
        facts=BulkFacts();service=self.cls(self.control,facts)
        body=packet();spans=body['resourceSpans'][0]['scopeSpans'][0]['spans']
        seed=copy.deepcopy(spans[0]);spans[:]=[]
        for n in range(1,130):
            span=copy.deepcopy(seed);span['spanId']=format(n,'016x');spans.append(span)
        service.accept(self.tokens['alice'],'w',body);service.work_once('first')
        frozen=self.rows('ingest_batches')[0]['plan_ref']
        self.assertEqual(len(facts.bulk_calls[0]),128)
        self.assertEqual(facts.spans,[])
        self.now+=10000;service.work_once('retry')
        self.assertEqual([len(p) for p in facts.bulk_calls],[128,128,1])
        self.assertEqual(facts.bulk_calls[0],facts.bulk_calls[1])
        self.assertEqual(self.rows('ingest_batches')[0]['plan_ref'],frozen)
        self.assertEqual(self.rows('ingest_batches')[0]['state'],'indexed')
        self.assertEqual(len(facts.spans),129)

    def test_bulk_missing_frozen_hash_cannot_publish_span_rows(self):
        class IncompleteBulk(Facts):
            def write_payload_bundles(self,payloads): return [{} for _ in payloads]
        facts=IncompleteBulk();service=self.cls(self.control,facts)
        service.accept(self.tokens['alice'],'w',packet());service.work_once('worker')
        self.assertEqual(facts.spans,[])
        self.assertEqual(self.rows('ingest_batches')[0]['state'],'prepared')
        self.assertEqual(self.rows('outbox_events')[0]['state'],'pending')

    def test_bounded_projection_preserves_source_hash_and_full_payload(self):
        body=packet();attrs=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes']
        attrs.extend([
            {'key':'legacy.role','value':{'stringValue':'assistant'}},
            {'key':'legacy.session_query','value':{'stringValue':'Original question'}},
            {'key':'legacy.session_label','value':{'stringValue':'Original label'}},
            {'key':'gen_ai.response.model','value':{'stringValue':'model-v1'}},
            {'key':'observed_ip','value':{'stringValue':'127.0.0.2'}},
            {'key':'source_kind','value':{'stringValue':'session'}},
            {'key':'call_ids','value':{'arrayValue':{'values':[{'stringValue':'call-one'}]}}},
            {'key':'skills','value':{'arrayValue':{'values':[{'stringValue':'testing'}]}}},
        ])
        accepted=self.service.accept(self.tokens['alice'],'w',body,receipt_key='first');self.service.work_once('worker')
        row=self.facts.spans[-1];projection=json.loads(row['attributes_json']);summary=json.loads(self.facts.summaries[-1]['attributes_json'])
        self.assertEqual(projection['legacy.role'],'assistant');self.assertEqual(projection['content_preview'],'world')
        self.assertEqual(projection['call_ids'],['call-one'])
        self.assertEqual(summary['query'],'Original question');self.assertEqual(summary['label'],'Original label')
        self.assertEqual(summary['model'],'model-v1');self.assertEqual(summary['observed_ip'],'127.0.0.2')
        self.assertEqual(summary['skills'],['testing']);self.assertEqual(summary['source_kind'],'session')
        head=next(h for h in self.rows('obs_entity_heads') if h['entity_kind']=='span')
        snapshot=self.service._load(head['artifact_ref'])
        self.assertEqual(snapshot['row']['attributes_json'],'{}')
        self.assertEqual(len(json.loads(snapshot['sections']['attributes'])['span']['skills']),1)
        frozen=copy.deepcopy(self.rows('obs_entity_heads'))
        repeated=self.service.accept(self.tokens['alice'],'w',body,receipt_key='second');self.service.work_once('worker')
        self.assertEqual(self.service.batch_status(self.tokens['alice'],'w',repeated['batch_id'])['state'],'indexed')
        self.assertEqual(self.rows('obs_entity_heads'),frozen);self.assertEqual(len(self.facts.spans),1)

    def test_long_content_is_preview_only_and_never_a_truncated_full_field(self):
        body=packet();attrs=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes']
        attrs[1]['value']['stringValue']='问题'*3000;attrs[2]['value']['stringValue']='answer'*3000
        attrs.append({'key':'legacy.session_query','value':{'stringValue':'question'*3000}})
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        row=self.facts.spans[-1];meta=json.loads(row['attributes_json']);summary=json.loads(self.facts.summaries[-1]['attributes_json'])
        self.assertLessEqual(len(row['attributes_json'].encode()),2048)
        self.assertLessEqual(len(self.facts.summaries[-1]['attributes_json'].encode()),2048)
        self.assertLessEqual(len(meta['content_preview']),240)
        self.assertNotIn('legacy.session_query',meta);self.assertNotIn('query',summary);self.assertNotIn('final_result',summary)
        self.assertIn('query_preview',summary);self.assertIn('final_result_preview',summary)
        sections=self.facts.bundles[-1][-1]
        self.assertEqual(sections['input'],'问题'*3000);self.assertEqual(sections['output'],'answer'*3000)

    def test_root_projection_wins_over_child_and_root_revision_can_correct_it(self):
        root=packet();attrs=root['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes']
        attrs.append({'key':'gen_ai.response.model','value':{'stringValue':'root-model'}})
        self.service.accept(self.tokens['alice'],'w',root);self.service.work_once('worker')
        child=packet(span='2'*16);span=child['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['parentSpanId']='1'*16;span['attributes'][1]['value']['stringValue']='child input'
        span['attributes'].append({'key':'gen_ai.response.model','value':{'stringValue':'child-model'}})
        self.service.accept(self.tokens['alice'],'w',child);self.service.work_once('worker')
        summary=json.loads(self.facts.summaries[-1]['attributes_json'])
        self.assertEqual(summary['query'],'hello');self.assertEqual(summary['model'],'root-model')
        root['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'][0]['value']['intValue']='2'
        root['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'][1]['value']['stringValue']='corrected root'
        self.service.accept(self.tokens['alice'],'w',root);self.service.work_once('worker')
        self.assertEqual(json.loads(self.facts.summaries[-1]['attributes_json'])['query'],'corrected root')

    def test_json_message_projection_uses_real_user_and_assistant_text(self):
        body=packet();attrs=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes']
        attrs[1]['value']['stringValue']=json.dumps([{'role':'system','content':'instruction'},{'role':'user','content':[{'type':'text','text':'你好'}]}])
        attrs[2]['value']['stringValue']=json.dumps([{'role':'assistant','content':'回复'}])
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        summary=json.loads(self.facts.summaries[-1]['attributes_json'])
        self.assertEqual(summary['query'],'你好');self.assertEqual(summary['final_result'],'回复')
        self.assertEqual(json.loads(self.facts.spans[-1]['attributes_json'])['content_preview'],'回复')

    def test_tool_error_count_delta_and_old_heads_remain_unknown(self):
        body=packet();span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['attributes'].append({'key':'gen_ai.tool.name','value':{'stringValue':'search'}});span['status']['code']=2
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(json.loads(self.facts.summaries[-1]['attributes_json'])['tool_error_count'],1)
        span['attributes'][0]['value']['intValue']='2';span['status']['code']=1
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(json.loads(self.facts.summaries[-1]['attributes_json'])['tool_error_count'],0)
        head=next(h for h in self.rows('obs_entity_heads') if h['entity_kind']=='trace')
        state=self.service._load(head['artifact_ref']);state.pop('tool_error_count')
        _,ref=self.service._persist(state)
        with self.control.transaction() as con:con.execute("UPDATE obs_entity_heads SET revision=revision+1,artifact_ref=? WHERE entity_kind='trace'",(ref,))
        self.service.accept(self.tokens['alice'],'w',packet(span='2'*16));self.service.work_once('worker')
        summary=json.loads(self.facts.summaries[-1]['attributes_json'])
        self.assertIsNone(summary['tool_error_count']);self.assertFalse(summary['tool_error_count_known'])

    def test_import_over_four_mib_stores_raw_legacy_interaction_once(self):
        raw={'role':'assistant','content':'大正文🙂'*(350000),'requestMessages':[{'role':'user','content':'question'}],
             'call_ids':['call-original'],'tool_calls':[{'id':'tool-call','function':{'name':'search','arguments':'{}'},'output':'found'}]}
        body=packet();span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['agent_insight_legacy_interaction']=raw
        span['agent_insight_legacy_trace']={'execution':{'query':'original query','label':'Import','model':'original-model'},'session':{'taskId':'old-task'}}
        span['attributes'][2]['value']['stringValue']=raw['content']
        self.assertGreater(len(json.dumps(raw,ensure_ascii=False).encode()),4*1024*1024)
        self.assertGreater(len(json.dumps(body,ensure_ascii=False).encode()),4*1024*1024)
        with self.assertRaises(ValueError):self.service.accept(self.tokens['alice'],'w',body)
        from services.storage.observations import normalize_import
        normalized=normalize_import(body,'w');sections=normalized[0]['sections']
        self.assertEqual(json.loads(sections['legacy_interaction']),raw)
        self.assertNotIn('agent_insight_legacy_interaction',json.loads(sections['otlp_span']))
        self.assertNotIn('input',sections);self.assertNotIn('output',sections)
        self.assertLess(sum(len(v.encode()) for v in sections.values()),len(sections['legacy_interaction'].encode())+4096)
        ack=self.service.accept_import(self.tokens['alice'],'w',body,receipt_key='import-one');self.service.work_once('worker')
        self.assertEqual(self.service.batch_status(self.tokens['alice'],'w',ack['batch_id'])['state'],'indexed')
        self.assertEqual(json.loads(self.facts.bundles[-1][-1]['legacy_interaction']),raw)
        self.assertLessEqual(len(self.facts.spans[-1]['attributes_json'].encode()),2048)
        self.assertEqual(json.loads(self.facts.summaries[-1]['attributes_json'])['query'],'original query')
        self.service.accept_import(self.tokens['alice'],'w',body,receipt_key='import-two');self.service.work_once('worker')
        self.assertEqual(len(self.facts.spans),1)

    def test_attribute_legacy_body_uses_separate_section_and_plain_source_hash_is_frozen(self):
        from services.storage.observations import _normalize,_json
        import hashlib
        self.assertEqual(hashlib.sha256(_json(_normalize(packet(),'w')).encode()).hexdigest(),'84d5b1010934083a1771f5e9888b427eef335b9f37e8dcca641d2ca9d613092e')
        body=packet();span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        raw={'role':'user','content':'question','extra':{'preserved':True}}
        span['attributes'].append({'key':'agent_insight.raw_interaction','value':{'stringValue':json.dumps(raw)}})
        normalized=_normalize(body,'w')[0]
        self.assertEqual(json.loads(normalized['sections']['legacy_interaction']),raw)
        self.assertNotIn('agent_insight.raw_interaction',json.loads(normalized['sections']['attributes'])['span'])
        self.assertEqual(json.loads(normalized['sections']['attributes'])['span']['gen_ai.input'],'hello')

    def test_tool_compact_projection_preserves_task_skill_structure_without_payloads_or_source_changes(self):
        from services.storage.observations import _normalize,_source_projection,_json
        import hashlib
        raw={'role':'assistant','tool_calls':[
            {'id':'task-id','type':'function','function':{'name':'task','arguments':json.dumps({'subagent_type':'research','session_id':'child-session','description':'research facts','prompt':'private prompt'*1000})},
             'output':{'result':{'session_id':'child-session','body':'private result'*1000}},'trace_split_parallel_task':True,'state':'completed','timing':{'started_at':1000,'completed_at':2000}},
            {'id':'skill-id','function':{'name':'skill','arguments':json.dumps({'name':'research-skill','version':2,'secret':'private'*1000})}},
            {'id':'bash-id','function':{'name':'bash','arguments':'private command'*1000},'output':'private body'*1000}]}
        body=packet();body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['agent_insight_legacy_interaction']=raw
        source=_normalize(body,'w')[0];before=hashlib.sha256(_json(source).encode()).hexdigest()
        compact,_=_source_projection(source)
        self.assertIn('legacy.tool_calls',compact);calls=compact['legacy.tool_calls']
        self.assertEqual(json.loads(calls[0]['function']['arguments']),{'subagent_type':'research','session_id':'child-session','description':'research facts'})
        self.assertEqual(calls[0]['output'],{'result':{'session_id':'child-session'}})
        self.assertTrue(calls[0]['trace_split_parallel_task']);self.assertEqual(calls[0]['id'],'task-id')
        self.assertEqual(json.loads(calls[1]['function']['arguments']),{'name':'research-skill','version':2})
        self.assertEqual(calls[2]['function']['arguments'],'{}');self.assertNotIn('output',calls[2])
        self.assertNotIn('private',json.dumps(compact));self.assertLessEqual(len(_json(compact).encode()),2048)
        self.assertEqual(hashlib.sha256(_json(source).encode()).hexdigest(),before)
        self.service.accept_import(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(json.loads(self.facts.spans[-1]['attributes_json'])['legacy.tool_calls'],calls)
        before_count=len(self.facts.spans)
        self.service.accept_import(self.tokens['alice'],'w',body,receipt_key='tool-projection-replay');self.service.work_once('worker')
        self.assertEqual(len(self.facts.spans),before_count)

    def test_core_tool_projection_is_per_carrier_instead_of_whole_assistant_array(self):
        from services.storage.observations import _normalize,_source_projection
        body=packet();body['resourceSpans'][0]['resource']['attributes'].append({'key':'agent_insight.source_namespace','value':{'stringValue':'agent.record.v1'}})
        original=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        call={'id':'provider-call','function':{'name':'task','arguments':'{"subagent_type":"research","session_id":"child"}'},'output':{'session_id':'child'}}
        original['agent_insight_legacy_interaction']={'role':'assistant','tool_calls':[call]*200}
        parent=_normalize(body,'w')[0];compact,_=_source_projection(parent)
        self.assertNotIn('legacy.tool_calls',compact);self.assertNotIn('legacy.tool_structure_oversized',compact)
        original['agent_insight_legacy_interaction']={'format':'agent-insight.trace-item','version':1,'kind':'carrier','value':call}
        original['attributes'] += [{'key':'legacy.transfer_kind','value':{'stringValue':'carrier'}},{'key':'legacy.role','value':{'stringValue':'tool'}},{'key':'gen_ai.tool.name','value':{'stringValue':'task'}}]
        compact,_=_source_projection(_normalize(body,'w')[0])
        self.assertEqual(compact['legacy.tool_call']['id'],'provider-call')
        self.assertEqual(json.loads(compact['legacy.tool_call']['function']['arguments'])['session_id'],'child')

    def test_oversized_tool_structure_retains_full_source_with_explicit_bounded_marker(self):
        from services.storage.observations import _normalize,_source_projection,_json
        raw={'role':'assistant','tool_calls':[{'id':str(i),'function':{'name':'bash','arguments':'{}'}} for i in range(200)]}
        body=packet();body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['agent_insight_legacy_interaction']=raw
        source=_normalize(body,'w')[0];compact,_=_source_projection(source)
        self.assertTrue(compact.get('legacy.tool_structure_oversized'));self.assertNotIn('legacy.tool_calls',compact)
        self.assertLessEqual(len(_json(compact).encode()),2048)
        self.assertEqual(json.loads(source['sections']['legacy_interaction']),raw)

    def test_new_tool_projection_does_not_rewrite_existing_source_revision(self):
        from unittest.mock import patch
        from services.storage.observations import _source_projection
        body=packet();body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['agent_insight_legacy_interaction']={'role':'assistant','tool_calls':[{'id':'original','function':{'name':'skill','arguments':'{"name":"research"}'}}]}
        def old_projection(source):
            compact,fields=_source_projection(source);compact.pop('legacy.tool_calls',None)
            return compact,fields
        self.service.accept_import(self.tokens['alice'],'w',body,receipt_key='before-projection')
        with patch('services.storage.observations._source_projection',side_effect=old_projection):self.service.work_once('worker')
        previous=copy.deepcopy(self.facts.spans);heads=copy.deepcopy(self.rows('obs_entity_heads'))
        self.assertNotIn('legacy.tool_calls',json.loads(previous[0]['attributes_json']))
        self.service.accept_import(self.tokens['alice'],'w',body,receipt_key='after-projection');self.service.work_once('worker')
        self.assertEqual(self.facts.spans,previous);self.assertEqual(self.rows('obs_entity_heads'),heads)

    def test_stale_source_revision_cannot_change_projected_metadata(self):
        body=packet(revision=2);body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'][1]['value']['stringValue']='current query'
        self.service.accept(self.tokens['alice'],'w',body);self.service.work_once('worker')
        before=self.facts.summaries[-1]
        self.service.accept(self.tokens['alice'],'w',packet(revision=1),receipt_key='older');self.service.work_once('worker')
        self.assertEqual(self.facts.summaries[-1],before)
        self.assertEqual(json.loads(before['attributes_json'])['query'],'current query')

    def test_import_capsule_preserves_extensions_and_nullable_legacy_session(self):
        raw={'role':'user','content':'original question','future_extension':{'anything':[1,2,3]}}
        capsule={'format':'agent-insight.trace-item','version':1,'kind':'interaction','index':0,'value':raw}
        body=packet();span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['agent_insight_legacy_interaction']=capsule
        span['agent_insight_legacy_trace']={'format':'agent-insight.trace-bundle-node','version':1,'execution':{'query':'Original'},'session':None}
        self.service.accept_import(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(self.rows('ingest_batches')[0]['state'],'indexed')
        self.assertEqual(json.loads(self.facts.bundles[-1][-1]['legacy_interaction']),capsule)
        metadata=json.loads(self.facts.spans[-1]['attributes_json'])
        self.assertEqual(metadata['role'],'user');self.assertEqual(metadata['content_preview'],'original question')
        self.assertEqual(json.loads(self.facts.summaries[-1]['attributes_json'])['query'],'Original')

    def test_raw_dedup_removes_only_actual_duplicate_attributes_at_each_scope(self):
        from services.storage.observations import normalize_import
        body=packet();resource=body['resourceSpans'][0]
        resource['resource']['attributes'].append({'key':'gen_ai.output','value':{'stringValue':'independent resource output'}})
        resource['scopeSpans'][0]['spans'][0]['agent_insight_legacy_interaction']={'role':'assistant','content':'world'}
        sections=normalize_import(body,'w')[0]['sections'];attrs=json.loads(sections['attributes'])
        self.assertEqual(attrs['resource']['gen_ai.output'],'independent resource output')
        self.assertNotIn('gen_ai.output',attrs['span'])

    def test_new_otlp_trace_registers_native_public_aliases_atomically(self):
        from services.storage.trace_metadata import TraceMetadata
        metadata=TraceMetadata(self.control)
        ack=self.service.accept(self.tokens['alice'],'w',packet())
        expected={'trace_id':ack['trace_ids'][0],'task_id':'a'*32,'execution_id':'a'*32}
        self.assertEqual(metadata.resolve(self.tokens['alice'],'w','a'*32),expected)
        self.assertEqual(metadata.resolve(self.tokens['alice'],'w','a'*32,'execution'),expected)
        self.assertEqual(metadata.resolve(self.tokens['alice'],'w',ack['trace_ids'][0]),expected)
        self.service.accept(self.tokens['alice'],'w',packet(),receipt_key='second')
        self.assertEqual(len(self.rows('trace_legacy_ids')),2)
        with self.assertRaises(Forbidden):self.service.accept(self.tokens['bob'],'w',packet(span='2'*16))
        self.assertEqual(len(self.rows('trace_legacy_ids')),2)

    def test_native_alias_collision_rolls_back_entire_packet_without_stealing(self):
        from services.storage.authorized import AuthorizedStorage
        from services.storage.trace_metadata import TraceMetadata
        AuthorizedStorage(self.iam,self.facts).create_trace(self.tokens['bob'],'w','other','2026-11-12',source_namespace='custom',native_trace_id='b'*32)
        TraceMetadata(self.control).register_aliases_for_provisioning('w','other',execution_id='a'*32)
        before={table:self.rows(table) for table in ['trace_locators','iam_resource_access','trace_legacy_ids','ingest_batches','outbox_events']}
        with self.assertRaises(Conflict):self.service.accept(self.tokens['alice'],'w',packet())
        for table,rows in before.items():self.assertEqual(self.rows(table),rows)

    def test_custom_namespace_never_guesses_public_legacy_ids(self):
        body=packet();body['resourceSpans'][0]['resource']['attributes'].append({'key':'agent_insight.source_namespace','value':{'stringValue':'custom.integration'}})
        self.service.accept(self.tokens['alice'],'w',body)
        self.assertEqual(self.rows('trace_legacy_ids'),[])

    def test_prefix_four_without_alias_table_still_accepts_and_indexes(self):
        from unittest.mock import patch
        from services.storage.migrations import load_migrations
        known=load_migrations('sqlite')
        store=SQLiteControlStore(Path(self.tmp.name)/'prefix-four.db',clock=lambda:self.now)
        with patch('services.storage.migrations.load_migrations',return_value=known[:4]):store.initialize()
        iam=IAMStore(store);iam.create_principal('old','old','Old');store.create_workspace('w','W');iam.bind_workspace('w',principal_id='old')
        token=iam.issue_session_for_provisioning('old');facts=Facts();service=self.cls(store,facts)
        ack=service.accept(token,'w',packet());self.assertTrue(service.work_once('worker'))
        self.assertEqual(service.batch_status(token,'w',ack['batch_id'])['state'],'indexed')
        with store.read_transaction() as con:
            self.assertIsNone(con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trace_legacy_ids'").fetchone())
            self.assertEqual(con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],4)

    def test_trace_level_import_metadata_is_authoritative_over_later_span_inputs(self):
        first=packet();span=first['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['parentSpanId']='f'*16
        span['agent_insight_legacy_trace']={'execution':{'query':'original Trace query','model':'original Trace model'},'session':None}
        self.service.accept_import(self.tokens['alice'],'w',first);self.service.work_once('worker')
        second=packet(span='2'*16)
        second['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'].append({'key':'gen_ai.response.model','value':{'stringValue':'later-model'}})
        self.service.accept(self.tokens['alice'],'w',second);self.service.work_once('worker')
        summary=json.loads(self.facts.summaries[-1]['attributes_json'])
        self.assertEqual(summary['query'],'original Trace query');self.assertEqual(summary['model'],'original Trace model')

    def test_transfer_structure_keys_preserve_zero_payload_carrier_index(self):
        body=packet();span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['agent_insight_legacy_interaction']={'format':'agent-insight.trace-item','version':1,'kind':'carrier','index':-1,'value':None}
        span['agent_insight_legacy_trace']={'execution':{'query':'empty session'},'session':None}
        span['attributes'].extend([{'key':'legacy.transfer_kind','value':{'stringValue':'carrier'}},
            {'key':'legacy.transfer_index','value':{'intValue':'-1'}},
            {'key':'legacy.transfer_has_session','value':{'boolValue':False}},
            {'key':'legacy.original_parent_span_id','value':{'stringValue':'original-parent'}}])
        self.service.accept_import(self.tokens['alice'],'w',body);self.service.work_once('worker')
        self.assertEqual(self.rows('ingest_batches')[0]['state'],'indexed')
        metadata=json.loads(self.facts.spans[-1]['attributes_json'])
        self.assertEqual(metadata['legacy.transfer_kind'],'carrier');self.assertEqual(metadata['legacy.transfer_index'],-1)
        self.assertEqual(metadata['legacy.original_parent_span_id'],'original-parent')
        self.assertFalse(metadata['legacy.transfer_has_session']);self.assertEqual(metadata['legacy.interaction_section'],'legacy_interaction')
        self.assertIsNone(json.loads(self.facts.bundles[-1][-1]['legacy_interaction'])['value'])

    def test_subagent_name_and_type_are_projected_from_trace_metadata_and_attributes(self):
        first=packet();first['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['agent_insight_legacy_trace']={
            'execution':{'subagentName':'Worker','subagentType':'validator','isSubagent':True},'session':None}
        self.service.accept_import(self.tokens['alice'],'w',first);self.service.work_once('worker')
        summary=json.loads(self.facts.summaries[-1]['attributes_json'])
        self.assertEqual(summary['subagent_name'],'Worker');self.assertEqual(summary['subagent_type'],'validator')
        self.assertTrue(summary['is_subagent'])
        second=packet(trace='b'*32)
        second['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'].extend([
            {'key':'legacy.subagent_name','value':{'stringValue':'Activity'}},
            {'key':'legacy.subagent_type','value':{'stringValue':'testing'}}])
        self.service.accept(self.tokens['alice'],'w',second);self.service.work_once('worker')
        summary=json.loads(self.facts.summaries[-1]['attributes_json'])
        self.assertEqual(summary['subagent_name'],'Activity');self.assertEqual(summary['subagent_type'],'testing')

    def test_catalog_and_schema_columns_match(self):
        root=Path(__file__).parents[1]/'schema'
        catalog=json.loads((root/'ingest-catalog.json').read_text())
        self.assertEqual(catalog['version'],4)
        self.assertEqual({t['name'] for t in catalog['tables']},{'ingest_batches','obs_entity_heads'})
        with self.control.read_transaction() as con:
            for table in catalog['tables']:
                if isinstance(self.control,SQLiteControlStore):
                    actual=[r['name'] for r in con.execute('PRAGMA table_info('+table['name']+')')]
                else:
                    actual=[r[0] for r in con.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',(self.control.schema,table['name']))]
                self.assertEqual(actual,[c['name'] for c in table['columns']])
        for dialect in ('sqlite','postgresql','opengauss'):
            self.assertTrue((root/dialect/'004_observations.sql').is_file())


class BulkPayloadKernelTests(unittest.TestCase):
    def payloads(self,count=2,text='中文🙂'):
        return [dict(workspace_id='w',trace_bucket='2026-11-12',trace_id='trace',span_id=str(i),sections={'input':text,'output':'answer'}) for i in range(count)]

    def test_bulk_equals_single_hashes_rows_and_publishes_all_manifests_last(self):
        from services.storage.clickhouse import ClickHouseStore
        from unittest.mock import patch
        client=ClickHouseStore('http://127.0.0.1:8123',database='isolated')
        payloads=self.payloads(128)
        single=[]
        with patch.object(client,'_insert') as insert:
            for p in payloads:
                single.append(client.write_payload_bundle(p['workspace_id'],p['trace_bucket'],p['trace_id'],p['span_id'],p['sections']))
            old_chunks=[row for c in insert.call_args_list if c.args[0]=='obs_payload_chunks' for row in c.args[1]]
            old_manifests=[row for c in insert.call_args_list if c.args[0]=='obs_payload_manifests' for row in c.args[1]]
        with patch.object(client,'_request',return_value=b'') as request:
            actual=client.write_payload_bundles(payloads)
        self.assertEqual(actual,single)
        self.assertEqual(len(request.call_args_list),2)
        self.assertIn('obs_payload_chunks',request.call_args_list[0].args[0])
        self.assertIn('obs_payload_manifests',request.call_args_list[-1].args[0])
        self.assertEqual(request.call_args_list[0].kwargs['rows'],old_chunks)
        self.assertEqual(request.call_args_list[-1].kwargs['rows'],old_manifests)

    def test_bulk_requests_remain_below_four_mib_including_json_escapes(self):
        from services.storage.clickhouse import ClickHouseStore
        from unittest.mock import patch
        client=ClickHouseStore('http://127.0.0.1:8123',database='isolated')
        with patch.object(client,'_request',return_value=b'') as request:
            client.write_payload_bundles(self.payloads(20,'"\\中文🙂'*30000))
        self.assertGreater(len(request.call_args_list),2)
        published=False
        for call in request.call_args_list:
            sql=call.args[0];rows=call.kwargs['rows']
            size=len(sql.encode())+1+sum(len(json.dumps(row,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode()) for row in rows)+len(rows)-1
            self.assertLessEqual(size,4*1024*1024)
            if 'obs_payload_manifests' in sql: published=True
            else: self.assertFalse(published)

    def test_bulk_invalid_last_payload_or_wrong_revision_never_writes(self):
        from services.storage.clickhouse import ClickHouseStore
        from unittest.mock import patch
        client=ClickHouseStore('http://127.0.0.1:8123',database='isolated')
        for payloads in ([],self.payloads(129),[self.payloads()[0],dict(self.payloads()[1],sections={'input':42})],[dict(self.payloads()[0],payload_revision='f'*64)]):
            with self.subTest(payloads=len(payloads)),patch.object(client,'_request') as request:
                with self.assertRaises(ValueError): client.write_payload_bundles(payloads)
                request.assert_not_called()

    def test_bulk_chunk_failure_publishes_no_manifest(self):
        from services.storage.clickhouse import ClickHouseStore
        from unittest.mock import patch
        client=ClickHouseStore('http://127.0.0.1:8123',database='isolated')
        with patch.object(client,'_request',side_effect=OSError('partial chunk write')) as request:
            with self.assertRaises(OSError): client.write_payload_bundles(self.payloads())
        self.assertTrue(all('obs_payload_chunks' in c.args[0] for c in request.call_args_list))


@unittest.skipUnless(os.environ.get('STORAGE_OBSERVATIONS_PG_CONFIG'),'optional isolated PostgreSQL configuration required')
class PostgreSQLObservationTests(ObservationTests):
    def make_control(self):
        import psycopg2
        from services.storage.relational import PostgreSQLControlStore
        config=json.loads(Path(os.environ['STORAGE_OBSERVATIONS_PG_CONFIG']).read_text())
        schema='obs_test_'+uuid.uuid4().hex
        factory=lambda:psycopg2.connect(config['dsn']) if 'dsn' in config else psycopg2.connect(**config)
        def clean():
            with factory() as con:
                with con.cursor() as cursor: cursor.execute('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')
        self.addCleanup(clean)
        return PostgreSQLControlStore(factory,schema=schema,artifact_directory=Path(self.tmp.name)/'artifacts',clock=lambda:self.now)


@unittest.skipUnless(os.environ.get('STORAGE_TEST_CLICKHOUSE_URL'),'optional real ClickHouse origin required')
class ClickHouseObservationTests(unittest.TestCase):
    def test_real_chunks_span_summary_and_retry_use_identical_versions(self):
        from services.storage.clickhouse import ClickHouseStore
        from services.storage.observations import ObservationIngest
        with tempfile.TemporaryDirectory() as directory:
            store=SQLiteControlStore(Path(directory)/'db');store.initialize();iam=IAMStore(store)
            iam.create_principal('alice','alice','Alice');store.create_workspace('w','W');iam.bind_workspace('w',principal_id='alice')
            credential=iam.issue_session_for_provisioning('alice')
            facts=ClickHouseStore(os.environ['STORAGE_TEST_CLICKHOUSE_URL'],database='obs_test_'+uuid.uuid4().hex,
                user=os.environ.get('STORAGE_TEST_CLICKHOUSE_USER','default'),password=os.environ.get('STORAGE_TEST_CLICKHOUSE_PASSWORD',''))
            facts.initialize_new_database()
            try:
                service=ObservationIngest(store,facts)
                accepted=service.accept(credential,'w',packet(tokens=9))
                original=facts._insert
                def once(table,rows):
                    if table=='obs_trace_current':
                        facts._insert=original
                        raise OSError('test interruption after Span insert')
                    return original(table,rows)
                facts._insert=once
                self.assertTrue(service.work_once('one'))
                with store.transaction() as con: con.execute('UPDATE outbox_events SET next_attempt_at_ms=0')
                self.assertTrue(ObservationIngest(store,facts).work_once('two'))
                trace=accepted['trace_ids'][0]
                with store.read_transaction() as con: bucket=con.execute('SELECT trace_bucket FROM trace_locators').fetchone()[0]
                rows=facts.read_spans('w',bucket,trace)
                self.assertEqual(len(rows),1);self.assertEqual(int(rows[0]['revision']),1)
                payload=facts.read_payload('w',bucket,trace,'1'*16,rows[0]['payload_revision'],'output')
                self.assertEqual(''.join(c['body'] for c in payload['chunks']),'world')
                summary=[json.loads(line) for line in facts._request('SELECT * FROM obs_trace_current FINAL FORMAT JSONEachRow').splitlines()]
                self.assertEqual(len(summary),1);self.assertEqual(int(summary[0]['span_count']),1)
                self.assertEqual(int(summary[0]['input_tokens']),9);self.assertIsNone(summary[0]['output_tokens'])
                self.assertEqual(service.batch_status(credential,'w',accepted['batch_id'])['state'],'indexed')
                child=packet(span='2'*16)
                child['resourceSpans'][0]['resource']['attributes'][0]['value']['stringValue']='child-service'
                child['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['parentSpanId']='1'*16
                followup=service.accept(credential,'w',child);self.assertTrue(service.work_once('three'))
                self.assertEqual(followup['trace_ids'],accepted['trace_ids'])
                children=facts.read_spans('w',bucket,trace)
                self.assertEqual(len(children),2)
                self.assertEqual(next(row for row in children if row['span_id']=='2'*16)['parent_span_id'],'1'*16)
                summary=[json.loads(line) for line in facts._request('SELECT * FROM obs_trace_current FINAL FORMAT JSONEachRow').splitlines()]
                self.assertEqual(len(summary),1);self.assertEqual(int(summary[0]['span_count']),2)
                self.assertEqual(int(summary[0]['revision']),2);self.assertIsNone(summary[0]['input_tokens'])
                from services.storage.clickhouse import IncompletePayload
                from services.storage.observations import _payload_revision
                bundles=[dict(workspace_id='w',trace_bucket=bucket,trace_id='bulk',span_id=format(i,'016x'),
                              sections={'input':'中文🙂','output':'answer'}) for i in range(1,129)]
                expected=[_payload_revision(p['sections']) for p in bundles]
                original_insert=facts._insert
                def interrupt_publication(table,rows):
                    if table=='obs_payload_manifests': raise OSError('test manifest publication interruption')
                    return original_insert(table,rows)
                facts._insert=interrupt_publication
                with self.assertRaises(OSError): facts.write_payload_bundles(bundles)
                facts._insert=original_insert
                with self.assertRaises(IncompletePayload): facts.read_payload('w',bucket,'bulk',bundles[0]['span_id'],expected[0],'output')
                original_request=facts._request;requests=[]
                def count_requests(sql,**kwargs):
                    requests.append(sql);return original_request(sql,**kwargs)
                facts._request=count_requests
                restored=facts.write_payload_bundles(bundles)
                facts._request=original_request
                self.assertEqual(len(requests),2)
                self.assertEqual([m['payload_revision'] for m in restored],expected)
                direct=facts.write_payload_bundle('w',bucket,'bulk','single',bundles[0]['sections'])
                self.assertEqual(direct['payload_revision'],expected[0])
                read=facts.read_payload('w',bucket,'bulk',bundles[0]['span_id'],expected[0],'input')
                self.assertEqual(''.join(c['body'] for c in read['chunks']),'中文🙂')
                count=facts._request("SELECT count() AS n FROM obs_payload_manifests FINAL WHERE trace_id='bulk' FORMAT JSONEachRow")
                self.assertEqual(int(json.loads(count)['n']),129)
                raw={'role':'assistant','content':'保真🙂'*450000,'future_extension':{'keep':True}}
                self.assertGreater(len(json.dumps(raw,ensure_ascii=False).encode()),4*1024*1024)
                imported=packet(trace='d'*32)
                imported['resourceSpans'][0]['resource']['attributes'].append({'key':'agent_insight.source_namespace','value':{'stringValue':'legacy.bundle.real-test'}})
                original_span=imported['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
                original_span['agent_insight_legacy_interaction']={'format':'agent-insight.trace-item','version':1,'kind':'interaction','index':0,'value':raw}
                original_span['attributes'][2]['value']['stringValue']=raw['content']
                with self.assertRaises(ValueError):service.accept(credential,'w',imported)
                imported_ack=service.accept_import(credential,'w',imported);self.assertTrue(service.work_once('importer'))
                imported_trace=imported_ack['trace_ids'][0]
                imported_row=facts.read_span('w',bucket,imported_trace,'1'*16)
                self.assertIsNotNone(imported_row)
                after=-1;parts=[]
                while True:
                    page=facts.read_payload('w',bucket,imported_trace,'1'*16,imported_row['payload_revision'],'legacy_interaction',after_chunk=after,limit=4)
                    parts.extend(c['body'] for c in page['chunks'])
                    if page['next_chunk'] is None:break
                    after=page['next_chunk']
                restored=json.loads(''.join(parts))
                self.assertEqual(restored['value'],raw)
                self.assertEqual(service.batch_status(credential,'w',imported_ack['batch_id'])['state'],'indexed')
            finally:
                facts._request('DROP DATABASE '+facts.database,database='default')


if __name__=='__main__': unittest.main()
