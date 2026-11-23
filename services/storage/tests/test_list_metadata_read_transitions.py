import copy
import unittest
from pathlib import Path
from unittest.mock import patch

from services.storage.compatibility_list import LegacyTraceList
from services.storage.control import Conflict
from services.storage.dataset_generation_sources import GenerationSources
from services.storage.iam import Unauthorized
from services.storage.tests import test_collector_sources as fixtures
from services.storage.trace_analytics import TraceAnalytics
from services.storage.trace_evidence import EvidenceUnavailable


class ListMetadataReadTransitionTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.CollectorSourceTests('runTest'); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.receipt = self.f.commit(self.f.reserve()); self.f.drain(); self.trace = self.receipt['trace_id']
        self.api = LegacyTraceList(self.f.queries, self.f.metadata, analytics=TraceAnalytics(self.f.queries, self.f.authorized))

    def read(self, token=None):
        return self.api.read(token or self.f.token, 'w', {'taskId': 'task'})

    def update_source(self):
        snapshot = self.f.snapshot(query='current query', finalResult='current body'); snapshot['session']['query'] = 'current query'
        self.f.commit(self.f.reserve('new-version'), snapshot)
        self.f.drain()

    def error_code(self, call, code, status):
        with self.assertRaises(Exception) as caught: call()
        self.assertEqual(getattr(caught.exception, 'code', None), code, str(caught.exception))
        self.assertEqual(getattr(caught.exception, 'status', None), status, str(caught.exception))
        return caught.exception

    def captured(self, callback, token=None):
        original = GenerationSources._capture; calls = 0
        def during_capture(reader, *args, **kwargs):
            nonlocal calls
            result = original(reader, *args, **kwargs)
            if calls == 0: callback(result)
            calls += 1
            return result
        with patch.object(GenerationSources, '_capture', new=during_capture):
            value = self.read(token)
        return value

    def test_source_advance_after_capture_rechecks_the_real_generation_summary_failure(self):
        error = self.error_code(lambda: self.captured(lambda _: self.update_source()), 'TRACE_READ_CHANGED', 409)
        self.assertIsInstance(error.__context__, EvidenceUnavailable)
        self.assertEqual(str(error.__context__), 'Generation source summary is not indexed')
        row = self.read()[0]
        self.assertEqual(row['query'], 'current query'); self.assertEqual(row['final_result'], 'current body')

    def test_source_advance_before_span_io_rechecks_the_real_generation_span_failure(self):
        original = self.f.authorized.read_spans; changed = False
        def during_scan(*args, **kwargs):
            nonlocal changed
            if not changed: changed = True; self.update_source()
            return original(*args, **kwargs)
        with patch.object(self.f.authorized, 'read_spans', side_effect=during_scan):
            error = self.error_code(lambda: self.read(), 'TRACE_READ_CHANGED', 409)
        self.assertIsInstance(error.__context__, EvidenceUnavailable)
        self.assertEqual(str(error.__context__), 'Generation Span vector is not indexed')

    def test_stable_missing_span_and_corrupt_artifact_remain_original_503(self):
        original_spans = copy.deepcopy(self.f.facts.spans)
        for mutation in ('missing-span', 'corrupt-artifact'):
            with self.subTest(mutation=mutation):
                original_bytes = None; artifact = None
                def unavailable(begin):
                    nonlocal original_bytes, artifact
                    if mutation == 'missing-span': self.f.facts.spans.pop(next(iter(self.f.facts.spans)))
                    else:
                        artifact = Path(next(head for head in begin['heads'] if head['entity_kind'] == 'trace')['artifact_ref'])
                        original_bytes = artifact.read_bytes(); artifact.write_bytes(b'corrupt')
                try:
                    error = self.error_code(lambda: self.captured(unavailable), None, 503)
                    self.assertIsInstance(error, EvidenceUnavailable)
                finally:
                    self.f.facts.spans = copy.deepcopy(original_spans)
                    if artifact: artifact.write_bytes(original_bytes)
        self.assertEqual(len(self.read()), 1)

    def test_stable_missing_summary_remains_nonretryable_503(self):
        def missing_summary(_): self.f.facts.summaries.clear()
        self.error_code(lambda: self.captured(missing_summary), None, 503)

    def test_source_advance_plus_alias_change_keeps_identity_conflict(self):
        def alias_change(_):
            self.update_source(); self.f.metadata.register_aliases_for_provisioning('w', self.trace, task_id='extra-task')
        with self.assertRaises(Conflict) as caught: self.captured(alias_change)
        self.assertIsNone(getattr(caught.exception, 'code', None))

    def test_source_advance_plus_owner_change_keeps_identity_conflict(self):
        def owner_change(_):
            self.update_source()
            with self.f.control.transaction() as con:
                con.execute("UPDATE iam_resource_access SET owner_principal_id='bob',etag=etag+1 WHERE resource_kind='trace' AND resource_id=?", (self.trace,))
        with self.assertRaises(Conflict) as caught: self.captured(owner_change, self.f.tokens['admin'])
        self.assertIsNone(getattr(caught.exception, 'code', None))

    def test_source_advance_plus_revocation_keeps_authorization_failure(self):
        def revoke(_): self.update_source(); self.f.iam.revoke_credential(self.f.token)
        with self.assertRaises(Unauthorized) as caught: self.captured(revoke)
        self.assertIsNone(getattr(caught.exception, 'code', None))
