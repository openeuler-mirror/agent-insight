import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from services.storage.control import SQLiteControlStore, Conflict
from services.storage.iam import IAMStore
from services.storage.legacy import export_database, LegacyValidationError


class LegacyImportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.legacy_import'), 'semantic importer is missing')
        from services.storage.legacy_import import LegacyImport
        self.Importer = LegacyImport
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source.db'
        self.control = SQLiteControlStore(self.root / 'target.db')
        self.control.initialize()
        self.iam = IAMStore(self.control)
        self.iam.create_principal('alice', 'alice', 'Alice')
        self.iam.create_principal('bob', 'bob', 'Bob')
        self.control.create_workspace('w', 'Workspace')
        self.iam.bind_workspace('w', principal_id='alice')
        self.token = self.iam.issue_session_for_provisioning('alice')
        self.bindings = {'old-alice': {'principal_id': 'alice', 'workspace_id': 'w'}}

    def snapshot(self, value='{"endpoint":"private","k":1}', owner='old-alice'):
        with sqlite3.connect(self.source) as con:
            con.executescript('CREATE TABLE UserSettings(id TEXT PRIMARY KEY,user TEXT NOT NULL,settingsJson TEXT NOT NULL,createdAt DATETIME NOT NULL,updatedAt DATETIME NOT NULL)')
            con.execute('INSERT INTO UserSettings VALUES(?,?,?,?,?)', ('settings-1', owner, value, 1700000000000, 1700000123456))
        export = self.root / 'export'
        export_database(self.source, export)
        return export

    def importer(self, export, **kwargs):
        return self.Importer(self.control, export, source_id='deployment-1', bindings=self.bindings, actors={'old-alice': self.token}, **kwargs)

    def legacy_rows(self, model, rows):
        from services.storage.legacy_plan import load_catalog
        spec = next(item for item in load_catalog()['models'] if item['model'] == model)
        with sqlite3.connect(self.source) as con:
            cols = spec['columns']
            con.execute('CREATE TABLE "' + spec['table'] + '"(' + ','.join('"' + c['column'] + '" ' + c['sqlite_type'] for c in cols) + ')')
            for value in rows:
                con.execute('INSERT INTO "' + spec['table'] + '" VALUES(' + ','.join('?' for c in cols) + ')',
                    [value.get(c['field']) for c in cols])

    def test_trace_import_keeps_original_metadata_and_session_representation_until_indexed(self):
        self.legacy_rows('Execution', [{'id': 'execution', 'taskId': 'task', 'user': 'old-alice',
            'timestamp': 1700000000000, 'isSubagent': 0, 'skills': '["skill"]', 'invokedSkills': '[]',
            'observedAgents': '[]', 'clientId': 'historic-device', 'sourceKind': 'diagnosis',
            'answerScore': 77.0, 'isAnswerCorrect': 0, 'cost': 0.4}])
        self.legacy_rows('Session', [{'id': 'session-id', 'taskId': 'task', 'user': 'old-alice',
            'startTime': 1700000000000, 'interactions': '[{"z":1,"a":2,"content":"历史正文","role":"assistant","big":9007199254740993,"small":1e-7}]'}])
        export = self.root / 'export'
        export_database(self.source, export)
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        from services.storage.collector_public import CollectorPublic
        facts = CurrentFacts()
        ingest = ObservationIngest(self.control, facts)
        tool = self.importer(export, ingest=ingest)
        first = tool.apply(migration_id='trace')
        self.assertEqual(first['pending'], 2)
        self.assertEqual(first['imported'], 0)
        for _ in range(20):
            if not ingest.work_once('legacy-test'): break
        second = tool.apply(migration_id='trace')
        self.assertEqual(second['imported'], 2)
        self.assertEqual(second['pending'], 0)
        with self.control.read_transaction() as con:
            source, state = CollectorPublic(self.control, ingest)._read(con, self.token, 'w', 'task')
        self.assertEqual(source['execution']['sourceKind'], 'diagnosis')
        self.assertEqual(source['execution']['clientId'], 'historic-device')
        self.assertEqual(source['execution']['answerScore'], 77.0)
        self.assertIn('"z":1,"a":2', source['session_json'])
        self.assertIn('"big":9007199254740992', source['session_json'])
        self.assertIn('"small":1e-7', source['session_json'])
        self.assertEqual(tool.verify(migration_id='trace')['verified'], 2)

    def test_session_without_execution_does_not_fabricate_trace_facts(self):
        self.legacy_rows('Session', [{'id': 'headless', 'taskId': 'headless-task', 'user': 'old-alice',
            'startTime': 1700000000000, 'interactions': '[]'}])
        export = self.root / 'export'
        export_database(self.source, export)
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        from services.storage.collector_public import CollectorPublic
        facts = CurrentFacts()
        ingest = ObservationIngest(self.control, facts)
        tool = self.importer(export, ingest=ingest)
        self.assertEqual(tool.apply(migration_id='headless')['imported'], 1)
        self.assertEqual(facts.spans, {})
        with self.control.read_transaction() as con:
            source, state = CollectorPublic(self.control, ingest)._read(con, self.token, 'w', 'headless-task')
        self.assertIsNone(source['execution'])
        self.assertEqual(json.loads(source['session_json'])['id'], 'headless')

    def test_thread_events_and_exact_skill_origin_resolve_to_real_imported_trace(self):
        self.legacy_rows('TraceThread', [{'id': 'thread', 'framework': 'pi-agent', 'sourceThreadId': 'native-thread',
            'user': 'old-alice', 'startedAt': 1700000000000, 'updatedAt': 1700000001000, 'metadataJson': '{"keep":true}'}])
        self.legacy_rows('Execution', [{'id': 'execution', 'taskId': 'task', 'user': 'old-alice', 'framework': 'pi-agent',
            'timestamp': 1700000000000, 'isSubagent': 0, 'traceThreadId': 'thread', 'sourceExecutionId': 'turn-one'}])
        self.legacy_rows('ExecutionSkill', [{'id': 'skill-link', 'executionId': 'execution', 'skillName': 'skill',
            'skillVersion': 0, 'isPrimary': 1, 'user': 'old-alice', 'createdAt': 1700000000000}])
        self.legacy_rows('ExecutionSkillOrigin', [{'id': 'origin', 'executionSkillId': 'skill-link', 'clientId': 'client',
            'platform': 'pi', 'targetMode': 'execution_origin', 'originRef': 'opaque', 'locatorVersion': 1, 'observedAt': 1700000000000}])
        self.legacy_rows('TraceThreadEvent', [{'id': 'event', 'eventKey': 'event-key', 'traceThreadId': 'thread',
            'executionId': 'execution', 'kind': 'turn', 'startedAt': 1700000000000, 'payloadJson': '{"untouched":1}'}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        ingest = ObservationIngest(self.control, CurrentFacts())
        tool = self.importer(export, ingest=ingest)
        tool.apply(migration_id='relations')
        while ingest.work_once('legacy-relations'): pass
        result = tool.apply(migration_id='relations')
        self.assertEqual(result['pending'], 0)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM collector_trace_thread_executions').fetchone()[0], 1)
            self.assertIsNotNone(con.execute('SELECT execution_trace_id FROM collector_trace_thread_events').fetchone()[0])
            from services.storage.collector_public import CollectorPublic
            source, _ = CollectorPublic(self.control, ingest)._read(con, self.token, 'w', 'task')
            self.assertEqual(source['execution_skills'][0]['origin']['originRef'], 'opaque')
        self.assertEqual(tool.verify(migration_id='relations')['verified'], 5)

    def test_evaluator_and_dataset_assets_keep_private_gold_and_original_dates(self):
        self.legacy_rows('CustomEvaluatorList', [{'user': 'old-alice', 'itemsJson': '[{"id":"eval","name":"Evaluator","apiKey":"private-key","prompt":"judge"}]', 'updatedAt': 1700000001000}])
        self.legacy_rows('AgentEvalDataset', [{'id': 'dataset', 'user': 'old-alice', 'name': 'Dataset',
            'description': '', 'targetAgent': '', 'targetSkill': '', 'tagsJson': '[]', 'fieldsJson': '[]',
            'casesJson': '[{"id":"case","input":"question","expectedOutput":"private gold"}]',
            'caseCount': 1, 'referenceCasesJson': '[]', 'projectionReady': 0, 'datasetKind': 'ideal_output',
            'createdAt': 1700000000000, 'updatedAt': 1700000002000}])
        export = self.root / 'export'; export_database(self.source, export)
        tool = self.importer(export)
        result = tool.apply(migration_id='assets')
        self.assertEqual(result['imported'], 1)
        self.assertEqual(result['pending'], 1)
        from services.storage.evaluator_assets import EvaluatorAssets
        from services.storage.datasets import DatasetStore
        evaluators = EvaluatorAssets(self.control).read(self.token, 'w')
        self.assertEqual(evaluators['evaluators'][0]['apiKey'], 'private-key')
        self.assertNotIn('apiKey', EvaluatorAssets(self.control).freeze(self.token, 'w', ['eval'])['cards']['eval'])
        dataset = DatasetStore(self.control).get(self.token, 'w', 'dataset')['dataset']
        self.assertEqual(dataset['cases'][0]['expectedOutput'], 'private gold')
        self.assertEqual(dataset['createdAt'], '2023-11-14T22:13:20.000Z')
        self.assertEqual(dataset['updatedAt'], '2023-11-14T22:13:22.000Z')
        class Facts:
            def _insert(self, table, rows): pass
        self.assertTrue(DatasetStore(self.control).project_once(Facts(), 'legacy-dataset'))
        self.assertEqual(tool.apply(migration_id='assets')['pending'], 0)
        self.assertEqual(tool.verify(migration_id='assets')['verified'], 2)

    def test_original_tag_and_trace_binding_are_imported_with_real_authorization(self):
        self.legacy_rows('Execution', [{'id': 'execution', 'taskId': 'task', 'user': 'old-alice',
            'timestamp': 1700000000000, 'isSubagent': 0}])
        self.legacy_rows('Tag', [{'id': 'tag', 'name': 'Business', 'kind': 'business', 'color': '#ABCDEF',
            'user': 'old-alice', 'createdAt': 1700000000000, 'updatedAt': 1700000002000}])
        self.legacy_rows('ExecutionTag', [{'id': 'link', 'executionId': 'execution', 'tagId': 'tag',
            'user': 'old-alice', 'createdAt': 1700000001000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        ingest = ObservationIngest(self.control, CurrentFacts())
        tool = self.importer(export, ingest=ingest)
        tool.apply(migration_id='tags')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT color FROM trace_tags').fetchone()[0], '#abcdef')
            self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_tag_links').fetchone()[0], 1)

    def test_ras_history_is_a_real_fact_with_original_delivery_identity(self):
        self.legacy_rows('RasAnomalyEvent', [{'id': 'ras-id', 'deliveryId': 'delivery', 'type': 'anomaly',
            'taskId': 'ras-task', 'payloadJson': '{"opaque":1}', 'ts': 1700000000000,
            'user': 'old-alice', 'createdAt': 1700000001000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_trace_analytics import AnalyticsFacts
        facts = AnalyticsFacts()
        tool = self.importer(export, facts=facts)
        self.assertEqual(tool.apply(migration_id='ras')['imported'], 1)
        self.assertEqual(tool.verify(migration_id='ras')['verified'], 1)
        with self.control.read_transaction() as con:
            row = con.execute('SELECT * FROM ras_event_receipts').fetchone()
            self.assertEqual(row['event_id'], 'ras-id')
            self.assertEqual(row['event_key'], 'delivery')
            self.assertEqual(row['created_at_ms'], 1700000001000)

    def test_ownerless_infra_requires_explicit_row_binding_and_keeps_inert_enabled_flag(self):
        self.legacy_rows('InfraSource', [{'id': 'source', 'endpoint': 'http://fixture.invalid', 'scrapeUrl': 'http://fixture.invalid/metrics',
            'kind': 'pull', 'authHeaders': '{"Authorization":"private"}', 'scrapeIntervalMs': 1000, 'enabled': 1,
            'createdAt': 1700000000000, 'updatedAt': 1700000001000}])
        self.legacy_rows('InfraMetricSample', [{'id': 'sample', 'sourceId': 'source', 'tsMs': -0.25,
            'via': None, 'gauges': '{}', 'counters': '{}', 'histograms': '{"h":{"buckets":[{"le":null}]}}', 'createdAt': 1700000001000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_infra import InfraFacts
        from services.storage.infra import InfraStore
        from unittest.mock import patch
        facts = InfraFacts()
        missing = self.importer(export, facts=facts)
        self.assertIn('owner_mapping_missing', missing.plan()['issue_counts'])
        key = next(item['entity_key'] for item in missing.plan()['entities'] if item['model'] == 'InfraSource')
        with patch('services.storage.legacy_history.HISTORY_FENCE_VERSION', 1):
            tool = self.importer(export, facts=facts, row_bindings={key: 'old-alice'})
            result = tool.apply(migration_id='infra')
            self.assertEqual(result['pending'], 1)
            self.assertTrue(InfraStore(self.control, facts).project_once('legacy-infra'))
            self.assertEqual(tool.apply(migration_id='infra')['pending'], 0)
        from services.storage.legacy_history import is_historical_control
        with self.control.read_transaction() as con:
            self.assertTrue(is_historical_control(con, 'w', 'infraSource', 'source'))
            self.assertEqual(con.execute('SELECT enabled FROM infra_sources').fetchone()[0], 1)
        self.assertEqual(next(iter(facts.rows.values()))['ts_ms'], -0.25)

    def test_skill_version_zero_import_materializes_content_only_release(self):
        self.legacy_rows('Skill', [{'id': 'skill', 'name': 'fixture', 'category': 'Other', 'visibility': 'private',
            'user': 'old-alice', 'createdAt': 1700000000000, 'updatedAt': 1700000001000,
            'activeVersion': 0, 'isUploaded': 0}])
        self.legacy_rows('SkillVersion', [{'id': 'version', 'skillId': 'skill', 'version': 0,
            'content': '# Skill\n原正文', 'verificationStatus': 'not_required', 'createdAt': 1700000000000}])
        export = self.root / 'export'; export_database(self.source, export)
        tool = self.importer(export)
        self.assertEqual(tool.apply(migration_id='skill')['imported'], 2)
        from services.storage.platform_controls import PlatformControls
        with self.control.read_transaction() as con:
            row = dict(con.execute("SELECT * FROM platform_control_records WHERE kind='skillVersion'").fetchone())
            files = PlatformControls(self.control)._file_bundle(row)
            self.assertEqual(files[0]['path'], 'SKILL.md')
            self.assertEqual(con.execute("SELECT alias FROM asset_aliases").fetchone()[0], 'version:0')
        import base64
        self.assertEqual(base64.b64decode(files[0]['content']).decode(), '# Skill\n原正文')

    def test_cli_requires_explicit_private_inputs_and_does_not_start_service(self):
        export = self.snapshot()
        config = self.root / 'runtime.json'
        config.write_text(json.dumps({'control': {'backend': 'sqlite', 'database': str(self.root / 'target.db')},
            'clickhouse': {'endpoint': 'http://127.0.0.1:1', 'database': 'unused_isolated'}, 'cursor_secret_hex': '00'*32}))
        binding = self.root / 'bindings.json'; binding.write_text(json.dumps(self.bindings))
        actors = self.root / 'actors.json'; actors.write_text(json.dumps({'old-alice': self.token}))
        for path in (config, binding, actors): path.chmod(0o600)
        from services.storage.__main__ import main
        from contextlib import redirect_stdout
        import io
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(['apply-legacy-import', '--directory', str(export), '--source-id', 'deployment-1',
                '--bindings-file', str(binding), '--actors-file', str(actors), '--config', str(config), '--migration-id', 'cli'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())['imported'], 1)
        self.assertNotIn(self.token, output.getvalue())

    def test_diagnosis_conversation_keeps_message_order_and_external_session_without_lease(self):
        self.legacy_rows('Execution', [{'id': 'execution', 'taskId': 'task', 'user': 'old-alice', 'timestamp': 1700000000000, 'isSubagent': 0}])
        self.legacy_rows('FaultDiagnosisSession', [{'id': 'chat', 'executionId': 'execution', 'user': 'old-alice',
            'opencodeSessionId': 'external-session', 'createdAt': 1700000000000, 'updatedAt': 1700000002000}])
        self.legacy_rows('FaultDiagnosisMessage', [
            {'id': 'message-a', 'sessionId': 'chat', 'role': 'user', 'content': 'question', 'createdAt': 1700000001000},
            {'id': 'message-b', 'sessionId': 'chat', 'role': 'assistant', 'content': 'historical answer', 'createdAt': 1700000002000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        from services.storage.diagnosis import TraceDiagnosis
        tool = self.importer(export, ingest=ObservationIngest(self.control, CurrentFacts()))
        tool.apply(migration_id='conversation')
        result = TraceDiagnosis(self.control).get_session(self.token, 'w', 'execution')
        self.assertEqual([message['id'] for message in result['messages']], ['message-a', 'message-b'])
        self.assertEqual(result['session']['opencodeSessionId'], 'external-session')
        with self.control.read_transaction() as con:
            self.assertIsNone(con.execute('SELECT active_request_key FROM trace_diagnosis_sessions').fetchone()[0])

    def test_historical_pending_report_reads_original_state_and_cannot_publish(self):
        self.legacy_rows('Execution', [{'id': 'execution', 'taskId': 'task', 'user': 'old-alice', 'timestamp': 1700000000000, 'isSubagent': 0}])
        self.legacy_rows('AgentDebugReport', [{'id': 'report', 'executionId': 'execution', 'user': 'old-alice',
            'interactionsHash': 'a'*64, 'status': 'pending', 'stepCount': 7, 'issueCount': 2, 'llmCallCount': 0,
            'generator': 'old-generator', 'ranAt': 1700000000000, 'updatedAt': 1700000001000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        from services.storage.trace_reports import TraceReports
        from unittest.mock import patch
        facts = CurrentFacts(); ingest = ObservationIngest(self.control, facts)
        with patch('services.storage.legacy_history.HISTORY_FENCE_VERSION', 1):
            tool = self.importer(export, ingest=ingest)
            tool.apply(migration_id='report')
        reports = TraceReports(TraceQueries(self.control, facts, cursor_secret=b'private-history-test-secret'), AuthorizedStorage(self.iam, facts))
        value = reports.read(self.token, 'w', 'execution', 'agent-debug')
        self.assertEqual(value['row']['status'], 'pending')
        self.assertEqual(value['row']['stepCount'], 7)
        with self.control.read_transaction() as con:
            row = dict(con.execute('SELECT * FROM diagnostic_report_runs').fetchone())
            with self.assertRaises(Conflict):
                reports._publication(con, self.token, 'w', 'report', 1, 'not-a-live-lease')

    def test_historical_pending_diagnosis_keeps_snapshot_and_never_claims_work(self):
        self.legacy_rows('Execution', [{'id': 'execution', 'taskId': 'task', 'user': 'old-alice', 'timestamp': 1700000000000, 'isSubagent': 0}])
        snapshot = {'schemaVersion': 1, 'execution': {'id': 'execution'}, 'interactions': [], 'skills': []}
        self.legacy_rows('DiagnosisRun', [{'id': 'diagnosis', 'user': 'old-alice', 'executionId': 'execution',
            'requestKey': 'old-request', 'inputHash': 'b'*64, 'inputSnapshotJson': json.dumps(snapshot),
            'generatorVersion': 'old-generator', 'status': 'pending', 'createdAt': 1700000000000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        from services.storage.diagnosis_runs import DiagnosisRuns
        from unittest.mock import patch
        with patch('services.storage.legacy_history.HISTORY_FENCE_VERSION', 1):
            tool = self.importer(export, ingest=ObservationIngest(self.control, CurrentFacts()))
            tool.apply(migration_id='diagnosis')
        service = DiagnosisRuns(self.control)
        value = service.dispatch('read', self.token, 'w', {'diagnosis_id': 'diagnosis'})
        self.assertEqual(value['status'], 'queued')
        self.assertEqual(value['snapshot'], snapshot)
        self.assertTrue(value['historical_inert'])
        with self.assertRaises(Conflict): service.dispatch('claim', self.token, 'w', {'diagnosis_id': 'diagnosis', 'worker_id': 'worker'})

    def test_completed_history_retest_checks_real_receipts_trace_and_asset_bytes(self, with_attempt=False, source_change=None):
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        from services.storage.trace_service import TraceQueries
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.authorized import AuthorizedStorage
        from services.storage.diagnosis_runs import DiagnosisRuns
        from services.storage.datasets import DatasetStore
        from unittest.mock import patch
        import copy
        class Facts(CurrentFacts):
            def __init__(self): super().__init__(); self.rows = {}
            def _insert(self, table, rows):
                if table == 'obs_trace_current': return super()._insert(table, rows)
                self.rows.setdefault(table, []).extend(copy.deepcopy(rows))
            def _request(self, sql, *, parameters):
                if 'workspace_id' in parameters: return super()._request(sql, parameters=parameters)
                table = sql.split('FROM ')[1].split()[0]
                return b'\n'.join(json.dumps(row).encode() for row in self.rows.get(table, []) if row['workspace_id'] == parameters['w'] and row['result_id'] == parameters['r'])
        self.legacy_rows('Skill', [{'id': 'skill', 'name': 'fixture', 'category': 'Other', 'visibility': 'private',
            'user': 'old-alice', 'createdAt': 1700000000000, 'updatedAt': 1700000001000, 'activeVersion': 0, 'isUploaded': 0}])
        self.legacy_rows('SkillVersion', [{'id': 'version', 'skillId': 'skill', 'version': 0,
            'content': '# Skill', 'verificationStatus': 'not_required', 'createdAt': 1700000000000}])
        self.legacy_rows('Execution', [{'id': 'execution', 'taskId': 'task', 'user': 'old-alice', 'timestamp': 1700000000000,
            'isSubagent': 0, 'invokedSkills': '[{"name":"fixture","version":0}]'}])
        self.legacy_rows('Session', [{'id': 'session', 'taskId': 'task', 'user': 'old-alice', 'startTime': 1700000000000,
            'interactions': '[{"role":"assistant","content":"answer"}]'}])
        self.legacy_rows('AgentEvalDataset', [{'id': 'dataset', 'user': 'old-alice', 'name': 'Dataset', 'description': '',
            'targetAgent': '', 'targetSkill': '', 'tagsJson': '[]', 'fieldsJson': '[]',
            'casesJson': '[{"id":"dataset-case","input":"question","expectedOutput":"gold"}]', 'caseCount': 1,
            'referenceCasesJson': '[]', 'projectionReady': 0, 'datasetKind': 'ideal_output',
            'createdAt': 1700000000000, 'updatedAt': 1700000002000}])
        self.legacy_rows('Experiment', [{'id': 'experiment', 'user': 'old-alice', 'name': 'Historic', 'type': 'single',
            'agentName': '', 'evaluatorIdsJson': '["judge"]', 'evaluatorConfigsJson': '{}', 'status': 'done',
            'configSnapshotJson': '{"datasetId":"dataset","caseIds":["dataset-case"]}', 'scope': '', 'skillName': '',
            'watchMode': 0, 'createdAt': 1700000000000, 'updatedAt': 1700000001000}])
        self.legacy_rows('ExperimentCase', [{'id': 'case', 'experimentId': 'experiment', 'input': 'question',
            'referenceOutput': 'gold', 'actualOutput': 'answer', 'executionId': 'execution', 'taskId': 'task', 'createdAt': 1700000000000}])
        self.legacy_rows('ExperimentEvalResult', [{'id': 'result', 'experimentId': 'experiment', 'caseId': 'case',
            'evaluatorId': 'judge', 'status': 'done', 'score': 82.0, 'attempts': 1,
            'createdAt': 1700000000000, 'updatedAt': 1700000001000}])
        if with_attempt:
            self.legacy_rows('ExperimentTraceAttempt', [{'id': 'attempt-1', 'experimentId': 'experiment', 'caseId': 'case',
                'attemptNo': 1, 'workerId': 'old-client', 'platform': 'opencode', 'agent': 'build', 'timeoutSeconds': 180,
                'traceId': 'task', 'status': 'ready', 'startedAt': 1700000000000, 'finishedAt': 1700000000500,
                'createdAt': 1700000000000, 'updatedAt': 1700000000500}])
        export = self.root / 'seed-export'; export_database(self.source, export)
        def import_to(control, token, directory, selected_models=None):
            facts = Facts(); ingest = ObservationIngest(control, facts)
            tool = self.Importer(control, directory, source_id='deployment-1', bindings=self.bindings,
                actors={'old-alice': token}, ingest=ingest, selected_models=selected_models)
            tool.apply(migration_id='history')
            for _ in range(30):
                if not ingest.work_once('fixture'): break
            DatasetStore(control).project_once(facts, 'dataset-fixture')
            tool.apply(migration_id='history')
            evidence = TraceEvidence(TraceQueries(control, facts, cursor_secret=b'private-retest-fixture-secret'), AuthorizedStorage(IAMStore(control), facts))
            return DiagnosisRuns(control, evidence=evidence), tool
        with patch('services.storage.legacy_history.HISTORY_FENCE_VERSION', 1):
            seed, _ = import_to(self.control, self.token, export)
            plan, preview, _ = seed._prepare(self.token, 'w', {'experiment_id': 'experiment', 'case_id': 'case',
                'result_ids': ['result'], 'frozen_skills': [{'name': 'fixture', 'versions': [{'version': 0, 'files': {'SKILL.md': '# Skill'}}]}]}, trusted=True)
            self.legacy_rows('DiagnosisRun', [{'id': 'diagnosis', 'user': 'old-alice', 'experimentId': 'experiment', 'caseId': 'case',
                'executionId': 'execution', 'requestKey': 'old-request', 'inputHash': 'b'*64,
                'inputSnapshotJson': json.dumps(preview['snapshot']), 'generatorVersion': 'old-generator', 'status': 'done',
                'createdAt': 1700000000000, 'completedAt': 1700000001000}])
            if source_change and source_change not in {'head', 'unimported'}:
                with sqlite3.connect(self.source) as con:
                    if source_change == 'superseded':
                        con.row_factory = sqlite3.Row
                        newer = dict(con.execute('SELECT * FROM ExperimentTraceAttempt').fetchone())
                        newer.update(id='attempt-2', attemptNo=2, startedAt=1700000000500, finishedAt=1700000000800,
                            createdAt=1700000000500, updatedAt=1700000000800)
                        con.execute('INSERT INTO ExperimentTraceAttempt(' + ','.join(newer) + ') VALUES(' + ','.join('?' for _ in newer) + ')', tuple(newer.values()))
                    elif source_change == 'missing': con.execute('DELETE FROM ExperimentTraceAttempt')
                    else: con.execute("UPDATE ExperimentTraceAttempt SET status='failed'")
            final = self.root / 'final-export'; export_database(self.source, final)
            target = SQLiteControlStore(self.root / 'retest-target.db'); target.initialize(); iam = IAMStore(target)
            iam.create_principal('alice', 'alice', 'Alice'); target.create_workspace('w', 'Workspace'); iam.bind_workspace('w', principal_id='alice')
            token = iam.issue_session_for_provisioning('alice')
            from services.storage.legacy_import import supported_legacy_models
            selection = sorted(supported_legacy_models() - {'ExperimentTraceAttempt'}) if source_change == 'unimported' else None
            service, tool = import_to(target, token, final, selection)
            if source_change == 'head':
                with target.transaction() as con: con.execute("UPDATE experiment_heads SET revision=revision+1 WHERE experiment_id='experiment'")
            if source_change:
                with self.assertRaises(Conflict): service.dispatch('verify_source', token, 'w', {'diagnosis_id': 'diagnosis'})
                return
            if with_attempt:
                self.assertEqual(service.dispatch('read', token, 'w', {'diagnosis_id': 'diagnosis'})['snapshot']['attempt'],
                    {'id': 'attempt-1', 'attemptNo': 1, 'traceId': 'task'})
                for changed, restored, parameters in [
                    ("UPDATE migration_checkpoints SET state='running' WHERE source_table LIKE 'ExperimentTraceAttempt:%'", "UPDATE migration_checkpoints SET state='verified' WHERE source_table LIKE 'ExperimentTraceAttempt:%'", ()),
                ]:
                    with target.transaction() as con: con.execute(changed, parameters)
                    try:
                        with self.assertRaises((Conflict, LookupError)): service.dispatch('verify_source', token, 'w', {'diagnosis_id': 'diagnosis'})
                    finally:
                        with target.transaction() as con: con.execute(restored, parameters)
                with target.read_transaction() as con:
                    self.assertEqual(con.execute("SELECT COUNT(*) FROM work_items WHERE phase!='migrate'").fetchone()[0], 0)
            verified = service.dispatch('verify_source', token, 'w', {'diagnosis_id': 'diagnosis'})
            self.assertTrue(verified['valid']); self.assertTrue(verified['historical_origin'])
            self.assertFalse(verified['source_model_selection_consistent'])
            self.assertIsNone(verified['source_model_selection'])
            with self.assertRaises(Conflict): service.dispatch('claim', token, 'w', {'diagnosis_id': 'diagnosis', 'worker_id': 'worker'})
            with target.transaction() as con:
                con.execute("UPDATE dataset_compat_heads SET revision=revision+1 WHERE dataset_id='dataset'")
            with self.assertRaises(Conflict): service.dispatch('verify_source', token, 'w', {'diagnosis_id': 'diagnosis'})

    def test_verified_historical_trace_attempt_retest_preserves_identity_and_rejects_receipt_drift(self):
        self.test_completed_history_retest_checks_real_receipts_trace_and_asset_bytes(with_attempt=True)

    def test_unimported_historical_attempt_receipt_retest_is_rejected(self):
        self.test_completed_history_retest_checks_real_receipts_trace_and_asset_bytes(with_attempt=True, source_change='unimported')

    def test_changed_historical_attempt_head_retest_is_rejected(self):
        self.test_completed_history_retest_checks_real_receipts_trace_and_asset_bytes(with_attempt=True, source_change='head')

    def test_superseded_historical_trace_attempt_retest_is_rejected(self):
        self.test_completed_history_retest_checks_real_receipts_trace_and_asset_bytes(with_attempt=True, source_change='superseded')

    def test_non_ready_historical_trace_attempt_retest_is_rejected(self):
        self.test_completed_history_retest_checks_real_receipts_trace_and_asset_bytes(with_attempt=True, source_change='failed')

    def test_missing_historical_trace_attempt_retest_is_rejected(self):
        self.test_completed_history_retest_checks_real_receipts_trace_and_asset_bytes(with_attempt=True, source_change='missing')

    def test_semantic_and_usage_history_uses_fixed_helper_without_recounting_daily(self):
        self.legacy_rows('GoalPlusSource', [{'id': 'source', 'user': 'old-alice', 'sourceId': 'native-source',
            'workspaceFingerprint': 'fingerprint', 'firstSeenAt': 1700000000000, 'lastSeenAt': 1700000001000}])
        self.legacy_rows('PlatformUsageEvent', [{'id': 'usage-row', 'eventId': 'event', 'occurredAt': 1700000000000,
            'dateKey': '2023-11-14', 'user': 'old-alice', 'featureKey': 'trace', 'eventKey': 'trace.view', 'source': 'client', 'createdAt': 1700000000000}])
        self.legacy_rows('PlatformUsageDaily', [{'dateKey': '2023-11-14', 'user': 'old-alice', 'featureKey': 'trace', 'eventKey': 'trace.view',
            'count': 37, 'firstOccurredAt': 1700000000000, 'lastOccurredAt': 1700000000000, 'updatedAt': 1700000001000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_semantic_usage import SemanticFacts
        from services.storage.semantic_usage import SemanticUsageStore
        facts = SemanticFacts(); tool = self.importer(export, facts=facts)
        self.assertEqual(tool.apply(migration_id='semantic')['imported'], 3)
        self.assertEqual(tool.apply(migration_id='semantic')['replayed'], 3)
        self.assertEqual(SemanticUsageStore(self.control, facts).usage_daily(self.token, 'w', to='2023-11-14')[0]['count'], 37)
        self.assertEqual(tool.verify(migration_id='semantic')['verified'], 3)

    def test_generation_history_progress_never_resumes_old_worker_and_retains_receipt(self):
        self.legacy_rows('AgentEvalDataset', [{'id': 'dataset', 'user': 'old-alice', 'name': 'Dataset',
            'description': '', 'targetAgent': '', 'targetSkill': '', 'tagsJson': '[]', 'fieldsJson': '[]', 'casesJson': '[]',
            'caseCount': 0, 'referenceCasesJson': '[]', 'projectionReady': 0, 'datasetKind': 'ideal_output',
            'generationSource': 'trace', 'generationStatus': 'generating', 'createdAt': 1700000000000, 'updatedAt': 1700000001000}])
        self.legacy_rows('TraceDatasetGenerationJob', [{'id': 'generation-job', 'datasetId': 'dataset', 'owner': 'old-alice',
            'configJson': '{"name":"Legacy"}', 'status': 'running', 'stage': 'sample', 'stageIndex': 3, 'generatedCount': 2,
            'leaseEpoch': 4, 'leaseOwner': 'old-worker', 'leaseUntil': 1700000100000, 'cancelRequested': 0,
            'requestId': 'old-request', 'requestHash': 'a'*64, 'captureState': 'pending', 'attemptCount': 1,
            'cleanupPending': 0, 'createdAt': 1700000000000, 'updatedAt': 1700000001000}])
        self.legacy_rows('TraceDatasetOperationReceipt', [{'id': 'generation-receipt', 'ownerKey': 'explicit-old-owner-key',
            'kind': 'create', 'operationKey': 'old-request', 'requestHash': 'a'*64, 'datasetId': 'dataset',
            'jobId': 'generation-job', 'outcome': 'accepted', 'expiresAt': 1700100000000}])
        export = self.root / 'export'; export_database(self.source, export)
        tool = self.importer(export)
        receipt_key = next(row['entity_key'] for row in tool.plan()['entities'] if row['model'] == 'TraceDatasetOperationReceipt')
        from unittest.mock import patch
        with patch('services.storage.legacy_history.HISTORY_FENCE_VERSION', 1):
            tool = self.importer(export, row_bindings={receipt_key: 'old-alice'})
            result = tool.apply(migration_id='generation')
        self.assertEqual(result['imported'], 2)
        from services.storage.dataset_generation import DatasetGeneration
        from services.storage.datasets import DatasetStore
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        service = DatasetGeneration(self.control, DatasetStore(self.control),
            TraceQueries(self.control, None, cursor_secret=b'private-generation-history-secret'), AuthorizedStorage(self.iam, None))
        progress = service.progress(self.token, 'w', 'dataset')
        self.assertEqual(progress['stage'], 'sample')
        self.assertEqual(progress['generatedCount'], 2)
        self.assertTrue(progress['historical_inert'])
        self.assertIsNone(service.claim(self.token, 'w', 'dataset', 'new-worker'))
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM dataset_generation_jobs').fetchone()[0], 0)
        removed = service.remove(self.token, 'w', 'dataset')
        self.assertEqual(removed['status'], 'deleted')
        self.assertEqual(service.deletion(self.token, 'w', removed['deletionId'])['status'], 'deleted')

    def test_all_reviewed_models_have_a_fixed_converter_without_claiming_cutover_ready(self):
        from services.storage.legacy_import import supported_legacy_models
        from services.storage.legacy_plan import load_catalog
        self.assertEqual(supported_legacy_models(), {model['model'] for model in load_catalog()['models']})
        self.assertEqual(len(supported_legacy_models()), 96)

    def test_experiment_runner_orders_result_before_foreign_author_comment_and_keeps_original_scores(self):
        self.legacy_rows('Experiment', [{'id': 'experiment', 'user': 'old-alice', 'name': 'Historic', 'type': 'single',
            'agentName': '', 'evaluatorIdsJson': '["judge"]', 'evaluatorConfigsJson': '{}', 'status': 'running',
            'scope': '', 'skillName': '', 'watchMode': 1, 'createdAt': 1700000000000, 'updatedAt': 1700000001000}])
        self.legacy_rows('ExperimentCase', [{'id': 'case', 'experimentId': 'experiment', 'input': 'question',
            'actualOutput': 'answer', 'createdAt': 1700000000000}])
        self.legacy_rows('ExperimentEvalResult', [{'id': 'result', 'experimentId': 'experiment', 'caseId': 'case',
            'evaluatorId': 'judge', 'status': 'done', 'score': 82.0, 'humanScore': 90.0, 'humanReason': 'review',
            'humanBy': 'old-bob', 'humanAt': 1700000001000, 'attempts': 1,
            'createdAt': 1700000000000, 'updatedAt': 1700000001000}])
        self.legacy_rows('ExperimentEvalComment', [{'id': 'comment', 'experimentId': 'experiment', 'resultId': 'result',
            'user': 'old-bob', 'body': 'historical comment', 'createdAt': 1700000001000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_legacy_import_experiments import Facts
        from services.storage.experiments import ExperimentStore
        from unittest.mock import patch
        self.bindings['old-bob'] = {'principal_id': 'bob', 'workspace_id': 'w'}
        with patch('services.storage.legacy_history.HISTORY_FENCE_VERSION', 1):
            tool = self.importer(export, facts=Facts())
            self.assertEqual(tool.apply(migration_id='experiment')['imported'], 4)
            self.assertEqual(tool.verify(migration_id='experiment')['verified'], 4)
        value = ExperimentStore(self.control).dispatch('read', self.token, 'w', {'experiment_id': 'experiment'})['experiment']
        self.assertEqual(value['status'], 'running')
        self.assertTrue(value['watchMode'])
        result = value['cases'][0]['results'][0]
        self.assertEqual(result['score'], 82.0)
        self.assertEqual(result['humanScore'], 90.0)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute("SELECT actor_principal_id FROM experiment_annotations WHERE annotation_id='comment'").fetchone()[0], 'bob')
            self.assertEqual(con.execute("SELECT COUNT(*) FROM work_items WHERE phase!='migrate'").fetchone()[0], 0)

    def test_target_rows_and_receipts_roll_back_together_on_interruption(self):
        tool = self.importer(self.snapshot())
        from unittest.mock import patch
        with patch.object(tool, '_checkpoint', side_effect=RuntimeError('isolated interruption')):
            with self.assertRaises(RuntimeError): tool.apply(migration_id='interrupted')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM platform_control_records').fetchone()[0], 0)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM migration_checkpoints').fetchone()[0], 0)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM inbox_receipts').fetchone()[0], 0)
        self.assertEqual(tool.apply(migration_id='interrupted')['imported'], 1)

    def test_message_timestamp_ties_need_explicit_order_before_any_target_write(self):
        self.legacy_rows('Execution', [{'id': 'execution', 'taskId': 'task', 'user': 'old-alice', 'timestamp': 1700000000000, 'isSubagent': 0}])
        self.legacy_rows('FaultDiagnosisSession', [{'id': 'chat', 'executionId': 'execution', 'user': 'old-alice',
            'createdAt': 1700000000000, 'updatedAt': 1700000001000}])
        self.legacy_rows('FaultDiagnosisMessage', [
            {'id': 'message-a', 'sessionId': 'chat', 'role': 'user', 'content': 'question', 'createdAt': 1700000001000},
            {'id': 'message-b', 'sessionId': 'chat', 'role': 'assistant', 'content': 'answer', 'createdAt': 1700000001000}])
        export = self.root / 'export'; export_database(self.source, export)
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.observations import ObservationIngest
        tool = self.importer(export, ingest=ObservationIngest(self.control, CurrentFacts()))
        self.assertIn('diagnosis_message_order_mapping_required', tool.plan()['issue_counts'])
        with self.assertRaises(LegacyValidationError): tool.apply(migration_id='ties')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_locators').fetchone()[0], 0)
        fixed = self.importer(export, ingest=tool.ingest, message_order={'chat': ['message-b', 'message-a']})
        fixed.apply(migration_id='ties')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT message_id FROM trace_diagnosis_messages ORDER BY seq').fetchall()[0][0], 'message-b')

    def test_static_import_is_atomic_resumable_preserves_time_and_keeps_secrets_private(self):
        export = self.snapshot()
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        tool = self.importer(export)
        first = tool.apply(migration_id='migration-one')
        self.assertEqual(first['imported'], 1)
        self.assertEqual(first['blocked'], 0)
        self.assertNotIn('private', json.dumps(first))
        second = tool.apply(migration_id='migration-one')
        self.assertEqual(second['replayed'], 1)
        self.assertEqual(second['imported'], 0)
        from services.storage.platform_controls import PlatformControls
        with self.control.read_transaction() as con:
            rows = con.execute("SELECT * FROM platform_control_records WHERE kind='userSettings'").fetchall()
            self.assertEqual(len(rows), 1)
            record = dict(rows[0])
            self.assertEqual(record['owner_principal_id'], 'alice')
            self.assertEqual(record['created_at_ms'], 1700000000000)
            self.assertEqual(record['updated_at_ms'], 1700000123456)
            data = PlatformControls(self.control)._data(record)
            self.assertEqual(data['settingsJson'], '{"endpoint":"private","k":1}')
            self.assertEqual(data['updatedAt'], '2023-11-14T22:15:23.456Z')
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), before)
        self.assertEqual(tool.verify(migration_id='migration-one')['verified'], 1)

    def test_unmapped_owner_and_unknown_tables_block_without_guessing(self):
        export = self.snapshot(owner='unknown')
        tool = self.importer(export)
        result = tool.plan()
        self.assertFalse(result['full_migration_ready'])
        self.assertEqual(result['issue_counts']['owner_mapping_missing'], 1)
        with self.assertRaises(LegacyValidationError):
            tool.apply(migration_id='blocked')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM platform_control_records').fetchone()[0], 0)

    def test_current_actor_must_match_explicit_mapping(self):
        tool = self.importer(self.snapshot())
        tool.actors['old-alice'] = self.iam.issue_session_for_provisioning('bob')
        with self.assertRaises(Exception):
            tool.apply(migration_id='bad-actor')
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM platform_control_records').fetchone()[0], 0)

    def test_existing_target_is_not_overwritten_and_receipt_does_not_accept_source_edits(self):
        export = self.snapshot()
        tool = self.importer(export)
        tool.apply(migration_id='one')
        with sqlite3.connect(self.source) as con:
            con.execute('UPDATE UserSettings SET settingsJson=?', ('{"changed":true}',))
        new_export = self.root / 'export-new'
        export_database(self.source, new_export)
        changed = self.importer(new_export)
        with self.assertRaises(Conflict):
            changed.apply(migration_id='one')
        with self.assertRaises(Conflict):
            changed.apply(migration_id='two')

    def test_same_entity_key_survives_changed_content(self):
        first = self.importer(self.snapshot())
        a = first.plan()['entities'][0]
        with sqlite3.connect(self.source) as con:
            con.execute('UPDATE UserSettings SET settingsJson=?', ('{}',))
        changed = self.root / 'export-new'
        export_database(self.source, changed)
        b = self.importer(changed).plan()['entities'][0]
        self.assertEqual(a['entity_key'], b['entity_key'])
        self.assertNotEqual(a['content_hash'], b['content_hash'])

    def pending_batch_export(self):
        self.legacy_rows('BatchEvalTask', [{'id': 'task', 'taskName': 'historic', 'user': 'old-alice',
            'configJson': '{}', 'caseStatesJson': '[{"status":"running"}]', 'traceEvalStatesJson': '[]',
            'createdAt': 1700000000000}])
        export = self.root / 'export'
        export_database(self.source, export)
        return export

    def test_historical_pending_jobs_require_installed_runtime_fences(self):
        from unittest.mock import patch
        export = self.pending_batch_export()
        with patch('services.storage.legacy_history.HISTORY_FENCE_VERSION', 0):
            plan = self.importer(export).plan()
        self.assertEqual(plan['issue_counts']['inert_history_guard_required'], 1)
        self.assertFalse(plan['full_migration_ready'])

    def test_reviewed_runtime_fences_allow_explicit_inert_history_import(self):
        from services.storage.platform_controls import PlatformControls
        from services.storage.legacy_history import is_historical_control
        source = self.pending_batch_export()
        source_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        tool = self.importer(source)
        self.assertEqual(tool.plan()['blocked'], 0)
        self.assertEqual(tool.apply(migration_id='reviewed-history')['imported'], 1)
        self.assertEqual(tool.verify(migration_id='reviewed-history')['verified'], 1)
        self.assertEqual(tool.apply(migration_id='reviewed-history')['replayed'], 1)
        controls = PlatformControls(self.control)
        value = controls.dispatch(self.token, 'w', 'records_read', {'kind': 'batchEvalTask', 'body': True}, trusted=True)
        self.assertEqual(value['rows'][0]['data']['caseStatesJson'], '[{"status":"running"}]')
        executable = controls.dispatch(self.token, 'w', 'records_read',
                                       {'kind': 'batchEvalTask', 'body': True, 'required_capabilities': ['execute']}, trusted=True)
        self.assertEqual(executable['rows'], [])
        self.assertIsNone(self.control.claim('w', 'migration-replay-probe'))
        with self.control.read_transaction() as con:
            self.assertTrue(is_historical_control(con, 'w', 'batchEvalTask', 'task'))
            self.assertEqual(con.execute('SELECT COUNT(*) FROM outbox_events').fetchone()[0], 0)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), source_hash)


if __name__ == '__main__':
    unittest.main()
