import base64
import copy
import json
import time
import unittest
from unittest.mock import patch

from services.storage.control import Conflict
from services.storage.tests import test_ras_reads as fixtures
from services.storage.tests import test_trace_transfer as transfer
from services.storage.trace_analytics import _hash
from services.storage.trace_evidence import TraceEvidence


class RasReadTransitionTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.RasReadTests('runTest'); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.trace = self.f.prepare_source(); self.api = self.f.service()
        self.api.ras_ingest(self.f.token, 'w', [self.f.event('event', 'task')])

    def read(self, token=None, **selection):
        return self.api.ras_read(token or self.f.token, 'w', ['task'], selection or None)

    @staticmethod
    def decode(token):
        return json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))[:-32])

    def error_code(self, call, code):
        with self.assertRaises(Exception) as caught: call()
        self.assertEqual(getattr(caught.exception, 'code', None), code, str(caught.exception))
        return caught.exception

    def source_update(self):
        with self.f.control.read_transaction() as con:
            ref = con.execute('SELECT packet_ref FROM ingest_batches ORDER BY accepted_at_ms LIMIT 1').fetchone()[0]
        packet = json.loads(self.f.ingest._load(ref)['json']); span = packet['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['attributes'].append({'key': 'agent_insight.revision', 'value': {'intValue': '2'}})
        span['name'] = 'updated span'; self.f.ingest.accept(self.f.token, 'w', packet); self.f.drain()

    def test_annotation_update_after_second_evidence_is_retryable_and_token_is_opaque(self):
        page = self.read(); before = self.decode(page['read_token'])
        TraceEvidence(self.f.queries, self.f.authorized).read(self.f.token, 'w', trace_ref=self.trace)
        self.f.metadata.patch(self.f.token, 'w', self.trace, {'label': 'updated after evidence'})
        self.error_code(lambda: self.api.validate_ras_read(self.f.token, 'w', page['read_token']), 'TRACE_READ_CHANGED')
        current = self.read(); after = self.decode(current['read_token'])
        self.assertEqual(before['identity_hash'], after['identity_hash'])
        self.assertNotEqual(before['snapshot_hash'], after['snapshot_hash'])
        self.assertEqual(current['events'], page['events'])
        self.assertEqual(set(current), set(page))
        self.assertEqual(self.api.validate_ras_read(self.f.token, 'w', current['read_token'])['scope_fingerprint'], current['scope_fingerprint'])

    def test_indexed_source_head_update_is_retryable_with_same_signed_identity(self):
        page = self.read(); self.source_update()
        self.error_code(lambda: self.api.validate_ras_read(self.f.token, 'w', page['read_token']), 'TRACE_READ_CHANGED')
        self.assertEqual(self.decode(page['read_token'])['identity_hash'], self.decode(self.read()['read_token'])['identity_hash'])

    def test_source_or_annotation_during_final_single_page_postflight_is_retryable(self):
        original = self.f.facts.read_ras_events
        for change in ('annotation', 'source'):
            with self.subTest(change=change):
                changed = False
                def during_facts(*args, **kwargs):
                    nonlocal changed
                    result = original(*args, **kwargs)
                    if not changed:
                        changed = True
                        if change == 'source': self.source_update()
                        else: self.f.metadata.patch(self.f.token, 'w', self.trace, {'label': 'changed during RAS facts'})
                    return result
                with patch.object(self.f.facts, 'read_ras_events', side_effect=during_facts):
                    self.error_code(lambda: self.read(), 'TRACE_READ_CHANGED')

    def test_new_changed_or_deleted_receipts_are_not_retryable(self):
        for mutation in ('new', 'changed', 'deleted'):
            with self.subTest(mutation=mutation):
                page = self.read()
                self.f.metadata.patch(self.f.token, 'w', self.trace, {'label': 'receipt ' + mutation})
                if mutation == 'new': self.api.ras_ingest(self.f.token, 'w', [self.f.event('new-event', 'task')])
                elif mutation == 'changed': self.api.ras_ingest(self.f.token, 'w', [self.f.event('event', 'task') | {'summary': 'new receipt content'}])
                else: self.api.ras_delete(self.f.token, 'w', ['task'])
                self.error_code(lambda: self.api.validate_ras_read(self.f.token, 'w', page['read_token']), None)

    def test_alias_route_owner_and_authorization_changes_are_not_retryable(self):
        for mutation in ('alias', 'route', 'owner'):
            with self.subTest(mutation=mutation):
                page = self.read(self.f.admin)
                self.f.metadata.patch(self.f.token, 'w', self.trace, {'label': 'identity ' + mutation})
                if mutation == 'alias': self.f.metadata.register_aliases_for_provisioning('w', self.trace, execution_id='extra-execution')
                elif mutation == 'route':
                    with self.f.control.transaction() as con: con.execute('UPDATE trace_locators SET route_epoch=route_epoch+1 WHERE trace_id=?', (self.trace,))
                else:
                    with self.f.control.transaction() as con: con.execute("UPDATE iam_resource_access SET owner_principal_id='bob',etag=etag+1 WHERE resource_kind='trace' AND resource_id=?", (self.trace,))
                self.error_code(lambda: self.api.validate_ras_read(self.f.admin, 'w', page['read_token']), None)
        page = self.read(self.f.admin); self.f.iam.revoke_credential(self.f.admin)
        self.error_code(lambda: self.api.validate_ras_read(self.f.admin, 'w', page['read_token']), None)

    def test_signed_old_five_field_token_validates_unchanged_but_never_grants_retry(self):
        page = self.read(); value = self.decode(page['read_token']); value.pop('identity_hash', None)
        with self.f.control.read_transaction() as con:
            old = copy.deepcopy(self.api._ras_read_snapshot(con, self.f.token, 'w', value['selection'], time.monotonic()+60))
        old.pop('read_identity', None)
        for root in old['roots'].values():
            if root: root.pop('read_identity', None)
        value['snapshot_hash'] = _hash(old); token = self.f.queries._encode(value)
        self.assertEqual(len(value), 5)
        self.api.validate_ras_read(self.f.token, 'w', token)
        self.f.metadata.patch(self.f.token, 'w', self.trace, {'label': 'old token update'})
        self.error_code(lambda: self.api.validate_ras_read(self.f.token, 'w', token), None)

    def test_identity_field_is_signed_validated_and_only_allowed_for_ras_read_purpose(self):
        page = self.read(); value = self.decode(page['read_token']); value['identity_hash'] = 'f'*64
        raw = base64.urlsafe_b64decode(page['read_token'] + '=' * (-len(page['read_token']) % 4))
        tampered = base64.urlsafe_b64encode(json.dumps(value).encode() + raw[-32:]).decode().rstrip('=')
        self.error_code(lambda: self.api.validate_ras_read(self.f.token, 'w', tampered), None)
        value['identity_hash'] = 'invalid'
        self.error_code(lambda: self.api.validate_ras_read(self.f.token, 'w', self.f.queries._encode(value)), None)
        scope = self.f.iam.scope(self.f.token)
        for purpose in ('analytics-outcome/v1', 'analytics-enrichment/v1', 'analytics-ras/v1'):
            token = self.f.queries._encode({'purpose': purpose, 'workspace_id': 'w', 'scope': scope.fingerprint, 'trace_ids': [self.trace], 'snapshot_hash': 'f'*64, 'identity_hash': 'f'*64})
            self.error_code(lambda: self.api._read_snapshot_token(token, 'w', scope, purpose), None)

    def test_final_single_page_identity_or_receipt_change_never_gets_retry_code(self):
        original = self.f.facts.read_ras_events
        for mutation in ('alias', 'receipt'):
            with self.subTest(mutation=mutation):
                changed = False
                def during_facts(*args, **kwargs):
                    nonlocal changed
                    result = original(*args, **kwargs)
                    if not changed:
                        changed = True; self.f.metadata.patch(self.f.token, 'w', self.trace, {'label': 'postflight ' + mutation})
                        if mutation == 'alias': self.f.metadata.register_aliases_for_provisioning('w', self.trace, execution_id='postflight-alias')
                        else: self.api.ras_ingest(self.f.token, 'w', [self.f.event('postflight-event', 'task')])
                    return result
                with patch.object(self.f.facts, 'read_ras_events', side_effect=during_facts):
                    self.error_code(lambda: self.read(), None)

    def test_bounded_scan_rechecks_versions_only_when_complete_receipts_stay_identical(self):
        rows = [self.f.event('scan-' + str(index).zfill(3), 'task') | {'type': 'actions'} for index in range(199)]
        self.api.ras_ingest(self.f.token, 'w', rows)
        original = self.f.facts.read_ras_events; changed = False
        def during_scan(*args, **kwargs):
            nonlocal changed
            result = original(*args, **kwargs)
            if not changed:
                changed = True; self.f.metadata.patch(self.f.token, 'w', self.trace, {'label': 'bounded scan annotation'})
            return result
        with patch.object(self.f.facts, 'read_ras_events', side_effect=during_scan):
            self.error_code(lambda: self.read(limit=1, types=['never-matches']), 'TRACE_READ_CHANGED')
        self.api.ras_ingest(self.f.token, 'w', [self.f.event('scan-more', 'task') | {'type': 'actions'}])
        changed = False
        def during_expanded_scan(*args, **kwargs):
            nonlocal changed
            result = original(*args, **kwargs)
            if not changed:
                changed = True; self.f.metadata.patch(self.f.token, 'w', self.trace, {'label': 'expanded scan annotation'})
            return result
        with patch.object(self.f.facts, 'read_ras_events', side_effect=during_expanded_scan):
            self.error_code(lambda: self.read(limit=1, types=['never-matches']), None)

    def test_empty_ras_only_deletion_barrier_is_not_hidden_by_unchanged_roots(self):
        page = self.api.ras_read(self.f.token, 'w', ['ras-only'], {'limit': 0})
        self.api.ras_ingest(self.f.token, 'w', [self.f.event('ras-only-event', 'ras-only')])
        self.api.ras_delete(self.f.token, 'w', ['ras-only'])
        self.error_code(lambda: self.api.validate_ras_read(self.f.token, 'w', page['read_token']), None)
