import copy
import json
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from services.storage.control import Conflict
from services.storage.tests import test_collector_sources as fixtures
from services.storage.collector_sources import indexed_boundary, current_rows, current_boundary
from services.storage.compatibility import LegacyTraceReads
from services.storage.compatibility_list import LegacyTraceList
from services.storage.trace_evidence import TraceEvidence
from services.storage.trace_analytics import TraceAnalytics
from services.storage.trace_service import TraceRuntime, create_server


class TraceReadTransitionTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.CollectorSourceTests('runTest'); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.receipt = None

    def publish(self):
        self.receipt = self.f.commit(self.f.reserve()); self.f.drain()
        return self.receipt['trace_id']

    def changed_source(self):
        self.f.commit(self.f.reserve('changed'), self.f.snapshot(query='new query', finalResult='new answer'))
        self.f.drain()

    def error_code(self, call, code):
        with self.assertRaises(Exception) as raised: call()
        self.assertEqual(getattr(raised.exception, 'code', None), code, str(raised.exception))
        return raised.exception

    def route(self):
        return self.f.queries.route(self.f.token, 'w', self.receipt['trace_id'])

    def test_committed_accepted_and_prepared_are_indexing_not_generic_unavailable(self):
        self.receipt = self.f.commit(self.f.reserve()); route = self.route()
        self.error_code(lambda: indexed_boundary(self.f.control, 'w', [route]), 'TRACE_INDEXING')
        with patch.object(self.f.facts, 'write_spans', side_effect=RuntimeError('isolated publication interruption')):
            self.f.ingest.work_once('prepare')
        self.error_code(lambda: indexed_boundary(self.f.control, 'w', [route]), 'TRACE_INDEXING')
        self.f.now += 10000; self.f.drain()
        self.assertTrue(indexed_boundary(self.f.control, 'w', [route]))

    def test_pending_missing_mismatched_and_failed_receipts_are_not_retryable(self):
        self.receipt = self.f.commit(self.f.reserve()); route = self.route()
        ref = self.receipt['batch_refs'][0]['batch_id']
        with self.f.control.read_transaction() as con: original = json.loads(con.execute('SELECT extra_json FROM trace_annotations WHERE trace_id=?', (route['trace_id'],)).fetchone()[0])
        for field, value in (('batch_id', 'missing-batch'), ('packet_hash', 'f' * 64)):
            with self.subTest(field=field):
                extra = copy.deepcopy(original); state = extra['collector_source_v1']
                state['operations'][state['pending']]['batch_refs'][0][field] = value
                with self.f.control.transaction() as con: con.execute('UPDATE trace_annotations SET extra_json=? WHERE trace_id=?', (json.dumps(extra), route['trace_id']))
                self.error_code(lambda: indexed_boundary(self.f.control, 'w', [route]), None)
        with self.f.control.transaction() as con:
            con.execute('UPDATE trace_annotations SET extra_json=? WHERE trace_id=?', (json.dumps(original), route['trace_id']))
            con.execute("UPDATE ingest_batches SET state='failed' WHERE batch_id=?", (ref,))
        self.error_code(lambda: indexed_boundary(self.f.control, 'w', [route]), None)

    def test_summary_source_change_is_retryable_but_route_change_is_not(self):
        trace = self.publish(); original = self.f.facts._request; changed = False
        def during_read(*args, **kwargs):
            nonlocal changed
            rows = original(*args, **kwargs)
            if not changed: changed = True; self.changed_source()
            return rows
        with patch.object(self.f.facts, '_request', side_effect=during_read):
            self.error_code(lambda: self.f.queries.summary(self.f.token, 'w', trace), 'TRACE_READ_CHANGED')
        def reincarnated(*args, **kwargs):
            rows = original(*args, **kwargs)
            with self.f.control.transaction() as con: con.execute('UPDATE trace_locators SET route_epoch=route_epoch+1 WHERE trace_id=?', (trace,))
            return rows
        with patch.object(self.f.facts, '_request', side_effect=reincarnated):
            self.error_code(lambda: self.f.queries.summary(self.f.token, 'w', trace), None)

    def test_list_capture_gap_keeps_the_identity_from_before_summary_io(self):
        trace = self.publish(); listing = LegacyTraceList(self.f.queries, self.f.metadata, analytics=TraceAnalytics(self.f.queries, self.f.authorized))
        original = self.f.queries.summary
        def after_summary(*args, **kwargs):
            value = original(*args, **kwargs); self.changed_source(); return value
        with patch.object(self.f.queries, 'summary', side_effect=after_summary):
            self.error_code(lambda: listing.read(self.f.token, 'w', {'taskId':'task'}), 'TRACE_READ_CHANGED')

    def test_list_capture_gap_does_not_retry_alias_rebinding(self):
        trace = self.publish(); listing = LegacyTraceList(self.f.queries, self.f.metadata, analytics=TraceAnalytics(self.f.queries, self.f.authorized))
        original = self.f.queries.summary
        def after_summary(*args, **kwargs):
            value = original(*args, **kwargs); self.changed_source(); self.f.metadata.register_aliases_for_provisioning('w',trace,task_id='new-alias'); return value
        with patch.object(self.f.queries, 'summary', side_effect=after_summary):
            self.error_code(lambda: listing.read(self.f.token, 'w', {'taskId':'task'}), None)

    def test_paginated_list_capture_gap_keeps_the_identity_from_before_summary_io(self):
        self.publish(); listing = LegacyTraceList(self.f.queries, self.f.metadata, analytics=TraceAnalytics(self.f.queries, self.f.authorized))
        original = self.f.queries.list_traces
        def after_page(*args, **kwargs):
            value = original(*args, **kwargs); self.changed_source(); return value
        with patch.object(self.f.queries, 'list_traces', side_effect=after_page):
            self.error_code(lambda: listing.read(self.f.token, 'w', {'paginated':'1','listPart':'records'}), 'TRACE_READ_CHANGED')

    def test_structure_scan_captures_boundary_before_facts_io(self):
        trace = self.publish(); reader = LegacyTraceReads(self.f.queries, self.f.authorized)
        original = self.f.authorized.read_spans; changed = False
        def during_scan(*args, **kwargs):
            nonlocal changed
            rows = original(*args, **kwargs)
            if not changed: changed = True; self.changed_source()
            return rows
        with patch.object(self.f.authorized, 'read_spans', side_effect=during_scan):
            self.error_code(lambda: reader.session(self.f.token, 'w', trace, 'structure'), 'TRACE_READ_CHANGED')
        self.assertTrue(reader.session(self.f.token, 'w', trace, 'structure')['interactions'])

    def test_stable_missing_summary_facts_and_corrupt_source_are_not_retryable(self):
        trace = self.publish(); summary = self.f.facts.summaries.pop(('w', trace))
        self.error_code(lambda: self.f.queries.summary(self.f.token, 'w', trace), None)
        self.f.facts.summaries[('w', trace)] = summary
        rows = list(self.f.facts.read_spans('w', self.route()['trace_bucket'], trace))
        self.error_code(lambda: current_rows(self.f.control, self.f.token, 'w', self.route(), rows[:-1]), None)
        head = next(iter(self.f.heads(trace).values())); Path(head['artifact_ref']).write_text('corrupt')
        self.error_code(lambda: TraceEvidence(self.f.queries, self.f.authorized).read(self.f.token, 'w', trace_ref=trace), None)

    def test_evidence_pending_uses_indexing_guard_before_source_capture(self):
        self.receipt = self.f.commit(self.f.reserve())
        self.error_code(lambda: TraceEvidence(self.f.queries, self.f.authorized).read(self.f.token, 'w', trace_ref=self.receipt['trace_id']), 'TRACE_INDEXING')

    def test_evidence_annotation_change_has_code_but_alias_change_does_not(self):
        trace = self.publish(); reader = TraceEvidence(self.f.queries, self.f.authorized)
        before = reader._capture(self.f.token, 'w', None, None, trace)
        self.f.metadata.patch(self.f.token, 'w', trace, {'query': 'new annotation'})
        self.error_code(lambda: reader._verify_end(self.f.token, 'w', None, None, before, trace), 'TRACE_READ_CHANGED')
        before = reader._capture(self.f.token, 'w', None, None, trace)
        self.f.metadata.register_aliases_for_provisioning('w', trace, task_id='extra-task')
        self.error_code(lambda: reader._verify_end(self.f.token, 'w', None, None, before, trace), None)

    def test_evidence_deletion_and_revocation_are_not_retryable(self):
        trace = self.publish(); reader = TraceEvidence(self.f.queries, self.f.authorized)
        before = reader._capture(self.f.token, 'w', None, None, trace)
        self.f.metadata.delete(self.f.token, 'w', trace)
        self.error_code(lambda: reader._verify_end(self.f.token, 'w', None, None, before, trace), None)
        self.f.iam.revoke_credential(self.f.token)
        self.error_code(lambda: reader._capture(self.f.token, 'w', None, None, trace), None)

    def test_list_records_recheck_annotations_with_and_without_analytics(self):
        trace = self.publish(); original = self.f.metadata.properties
        for use_analytics in (False, True):
            changed = False
            def during_properties(*args, **kwargs):
                nonlocal changed
                value = original(*args, **kwargs)
                if not changed:
                    changed = True; self.f.metadata.patch(self.f.token, 'w', trace, {'label': 'new-' + str(use_analytics)})
                return value
            analytics = TraceAnalytics(self.f.queries, self.f.authorized) if use_analytics else None
            api = LegacyTraceList(self.f.queries, self.f.metadata, analytics=analytics)
            with patch.object(self.f.metadata, 'properties', side_effect=during_properties):
                self.error_code(lambda: api.read(self.f.token, 'w', {'taskId': 'task'}), 'TRACE_READ_CHANGED')
            self.assertEqual(api.read(self.f.token, 'w', {'taskId': 'task'})[0]['label'], 'new-' + str(use_analytics))

    def test_list_final_outcome_recheck_keeps_identity_baseline(self):
        trace = self.publish()
        from services.storage.experiments import ExperimentStore
        store = ExperimentStore(self.f.control); changed = False
        class DuringFilter(LegacyTraceList):
            def _matches(inner, row, clause):
                nonlocal changed
                if not changed:
                    changed = True; store.dispatch('outcome_cancel', self.f.token, 'w', {'trace_ref': trace, 'operation_key': 'new-outcome'})
                return super()._matches(row, clause)
        api = DuringFilter(self.f.queries, self.f.metadata)
        self.error_code(lambda: api.read(self.f.token, 'w', {'filters': '[{"column":"taskId","operator":"=","value":"task"}]'}), 'TRACE_READ_CHANGED')

    def test_unbound_analytics_boundary_and_old_payload_revision_are_not_retryable(self):
        trace = self.publish(); analytics = TraceAnalytics(self.f.queries, self.f.authorized)
        with self.f.control.read_transaction() as con: boundary, _ = analytics._boundary(con, self.f.token, 'w', trace)
        self.f.metadata.patch(self.f.token, 'w', trace, {'query': 'updated'})
        self.error_code(lambda: analytics.validate(self.f.token, 'w', [{'trace_id': trace, 'boundary': boundary}]), None)
        from services.storage.clickhouse import ClickHouseStore
        sink = object.__new__(ClickHouseStore)
        with patch.object(sink, '_request', return_value=b''):
            self.error_code(lambda: sink.read_payload('w', self.route()['trace_bucket'], trace, next(iter(self.f.heads(trace))), 'f'*64, 'input'), None)

    def test_session_source_identity_hash_excludes_updates_and_fences_aliases_and_incarnation(self):
        from services.storage.collector_public import CollectorPublic
        trace = self.publish(); api = CollectorPublic(self.f.control, self.f.ingest)
        original = api.session(self.f.token, 'w', 'task'); identity = original.get('identity_hash')
        self.assertRegex(identity or '', '^[0-9a-f]{64}$')
        self.changed_source()
        self.assertNotEqual(api.session(self.f.token, 'w', 'task')['source_revision'], original['source_revision'])
        self.assertEqual(api.session(self.f.token, 'w', 'task')['identity_hash'], identity)
        self.f.metadata.patch(self.f.token, 'w', trace, {'label': 'current label'})
        self.assertEqual(api.session(self.f.token, 'w', 'task')['identity_hash'], identity)
        self.f.metadata.register_aliases_for_provisioning('w', trace, task_id='extra-task')
        alias_identity = api.session(self.f.token, 'w', 'task')['identity_hash']
        self.assertNotEqual(alias_identity, identity)
        with self.f.control.read_transaction() as con:
            route = self.route(); reincarnated = dict(route, incarnation=route['incarnation']+1)
            self.assertNotEqual(api._identity_hash(con, 'w', reincarnated, 'alice'), alias_identity)
        with self.f.control.transaction() as con: con.execute('UPDATE trace_locators SET route_epoch=route_epoch+1 WHERE trace_id=?', (trace,))
        self.assertNotEqual(api.session(self.f.token, 'w', 'task')['identity_hash'], alias_identity)

    def test_graph_indexing_requires_all_valid_receipts_and_never_failed_or_corrupt(self):
        from services.storage.tests.test_collector_graphs import CollectorGraphTests
        graph = CollectorGraphTests('runTest'); graph.setUp(); self.addCleanup(graph.doCleanups)
        child = graph.child(); entry = graph.graph_plan(graph.graph_capture(graph.prep.begin(), [child]), [child])
        graph.prep.commit(entry); f = graph.fixture; route = f.queries.route(f.token, 'w', entry['scope_key'])
        self.error_code(lambda: indexed_boundary(f.control, 'w', [route]), 'TRACE_INDEXING')
        self.assertTrue(graph.ingest.work_once('root-only'))
        self.error_code(lambda: indexed_boundary(f.control, 'w', [route]), 'TRACE_INDEXING')
        with f.control.read_transaction() as con:
            _, _, state = graph.service().sources._state(con, 'w', route['trace_id'])
            op = state['operations'][state['pending']]; graph_path = Path(op['graph_ref'])
            batch = con.execute("SELECT batch_id FROM ingest_batches WHERE state='accepted' LIMIT 1").fetchone()[0]
        original = graph_path.read_bytes(); graph_path.write_bytes(b'corrupt')
        self.error_code(lambda: indexed_boundary(f.control, 'w', [route]), None)
        graph_path.write_bytes(original)
        with f.control.transaction() as con: con.execute("UPDATE ingest_batches SET state='failed' WHERE batch_id=?", (batch,))
        self.error_code(lambda: indexed_boundary(f.control, 'w', [route]), None)

    def test_source_or_annotation_change_with_revocation_or_alias_change_is_not_retryable(self):
        trace = self.publish(); reader = LegacyTraceList(self.f.queries, self.f.metadata)
        original = self.f.metadata.properties; changed = False
        def during_properties(*args, **kwargs):
            nonlocal changed
            result = original(*args, **kwargs)
            if not changed:
                changed = True
                self.f.metadata.patch(self.f.token, 'w', trace, {'label': 'new label'})
                self.f.metadata.register_aliases_for_provisioning('w', trace, task_id='extra-task')
            return result
        with patch.object(self.f.metadata, 'properties', side_effect=during_properties):
            self.error_code(lambda: reader.read(self.f.token, 'w', {'taskId': 'task'}), None)
        original_request = self.f.facts._request; changed = False
        def revoke(*args, **kwargs):
            nonlocal changed
            result = original_request(*args, **kwargs)
            if not changed:
                changed = True; self.changed_source(); self.f.iam.revoke_credential(self.f.token)
            return result
        with patch.object(self.f.facts, '_request', side_effect=revoke):
            self.error_code(lambda: self.f.queries.summary(self.f.token, 'w', trace), None)

    def test_structure_pending_transition_and_pending_identity_changes_are_distinct(self):
        trace = self.publish(); reader = LegacyTraceReads(self.f.queries, self.f.authorized)
        original = self.f.authorized.read_spans; changed = False
        def pending_during_scan(*args, **kwargs):
            nonlocal changed
            rows = original(*args, **kwargs)
            if not changed:
                changed = True; self.f.commit(self.f.reserve('pending-change'), self.f.snapshot(query='pending'))
            return rows
        with patch.object(self.f.authorized, 'read_spans', side_effect=pending_during_scan):
            self.error_code(lambda: reader.session(self.f.token, 'w', trace, 'structure'), 'TRACE_INDEXING')
        self.f.drain(); evidence = TraceEvidence(self.f.queries, self.f.authorized)
        before = evidence._capture(self.f.token, 'w', None, None, trace)
        self.f.commit(self.f.reserve('pending-alias'), self.f.snapshot(query='pending alias'))
        self.f.metadata.register_aliases_for_provisioning('w', trace, task_id='pending-extra-alias')
        self.error_code(lambda: evidence._verify_end(self.f.token, 'w', None, None, before, trace), None)
        self.f.drain(); original_request = self.f.facts._request; changed = False
        def during_query(*args, **kwargs):
            nonlocal changed
            rows = original_request(*args, **kwargs)
            if not changed:
                changed = True; self.f.commit(self.f.reserve('next-pending'), self.f.snapshot(query='next pending'))
                self.f.metadata.register_aliases_for_provisioning('w', trace, task_id='next-extra-alias')
            return rows
        with patch.object(self.f.facts, '_request', side_effect=during_query):
            self.error_code(lambda: self.f.queries.summary(self.f.token, 'w', trace), None)

    def test_http_only_serializes_the_two_exact_transition_codes(self):
        self.receipt = self.f.commit(self.f.reserve())
        runtime = TraceRuntime(self.f.control, self.f.facts, cursor_secret=b'trace-transition-private-test-cursor')
        server = create_server(runtime, port=0); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(runtime.close); self.addCleanup(thread.join); self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        url = 'http://127.0.0.1:' + str(server.server_port)
        def request(suffix):
            try:
                with urlopen(Request(url + suffix, headers={'authorization': 'Bearer ' + self.f.token}), timeout=5) as response: return response.status, json.load(response)
            except HTTPError as error: return error.code, json.load(error)
        for suffix in ('/v1/compat/observe/data?workspace_id=w', '/v1/compat/observe/session-source?workspace_id=w&taskId=task', '/v1/compat/observe/evidence?workspace_id=w&taskId=task'):
            status, body = request(suffix); self.assertEqual(status, 503); self.assertEqual(body.get('code'), 'TRACE_INDEXING')
        self.f.drain(); changed = False; original = self.f.facts._request
        def during_query(*args, **kwargs):
            nonlocal changed
            rows = original(*args, **kwargs)
            if not changed: changed = True; self.changed_source()
            return rows
        with patch.object(self.f.facts, '_request', side_effect=during_query):
            status, body = request('/v1/compat/observe/data?workspace_id=w'); self.assertEqual((status, body.get('code')), (409, 'TRACE_READ_CHANGED'))
        self.f.facts.summaries.clear()
        status, body = request('/v1/compat/observe/data?workspace_id=w'); self.assertEqual(status, 503); self.assertNotIn('code', body)
