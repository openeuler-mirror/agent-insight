import copy
import hashlib
import importlib.util
import json
from types import SimpleNamespace
import unittest

from services.storage.control import Conflict
from services.storage.experiments import ExperimentStore
from services.storage.iam import Forbidden
from services.storage.tests import test_datasets as dataset_fixture


class Facts:
    def __init__(self): self.rows = {}
    def _insert(self, table, rows): self.rows.setdefault(table, []).extend(copy.deepcopy(rows))


class LegacyExperimentTests(unittest.TestCase):
    make_control = dataset_fixture.DatasetTests.make_control
    setUp = dataset_fixture.DatasetTests.setUp

    def row(self, model, data):
        source = json.dumps([model, data], sort_keys=True, ensure_ascii=False)
        return {'model': model, 'table': model, 'data': copy.deepcopy(data),
                'content_hash': hashlib.sha256(source.encode()).hexdigest(),
                'entity_key': hashlib.sha256((model + ':' + data.get('id', data.get('experimentId', ''))).encode()).hexdigest()}

    def service(self, rows):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.legacy_import_experiments'),
                             'A fixed inert history importer must exist')
        from services.storage.legacy_import_experiments import ExperimentHistory
        return ExperimentHistory(SimpleNamespace(control=self.control, rows=rows,
            actors={'alice': self.token, 'bob': self.bob}, source_id='legacy-test',
            bindings={'alice': {'workspace_id': 'w', 'principal_id': 'alice'}},
            facts=Facts(), _owner=lambda row: row['data'].get('user', 'alice')))

    def head(self, **changes):
        return self.row('Experiment', {'id': 'exp', 'user': 'alice', 'name': '旧实验',
            'type': 'single', 'scope': '', 'status': 'running', 'watchMode': True,
            'evaluatorIdsJson': '["judge"]', 'evaluatorConfigsJson': '{}',
            'createdAt': '2020-01-01T00:00:00.000Z', 'updatedAt': '2020-01-02T00:00:00.000Z',
            **changes})

    def write(self, service, row):
        with self.control.transaction() as con:
            scope = self.iam._scope(con, self.token)
            proof = service.write(con, row, scope, 'w', 'alice')
            self.assertTrue(service.verify(con, row, 'w', proof))
            return proof

    def test_original_head_status_times_groups_and_no_executable_work(self):
        head = self.head(); group = self.row('ExperimentGroup', {'id': 'g', 'experimentId': 'exp',
            'key': 'A', 'variableValue': 'model', 'createdAt': '2020-01-01T01:00:00.000Z'})
        service = self.service([head, group]); self.write(service, head); self.write(service, group)
        value = ExperimentStore(self.control).dispatch('read', self.token, 'w', {'experiment_id': 'exp'})['experiment']
        self.assertEqual(value['status'], 'running'); self.assertTrue(value['watchMode'])
        self.assertEqual(value['createdAt'], head['data']['createdAt']); self.assertEqual(value['groups'], [group['data']])
        self.assertIsNone(self.control.claim('w', 'real-worker'))

        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM outbox_events').fetchone()[0], 0)

    def test_selected_machine_and_human_score_stay_separate_with_exact_dates(self):
        head = self.head(status='done'); case = self.row('ExperimentCase', {'id': 'case', 'experimentId': 'exp',
            'input': '中文', 'actualOutput': '完整输出', 'referenceOutput': 'gold',
            'createdAt': '2020-01-01T00:00:01.000Z'})
        result = self.row('ExperimentEvalResult', {'id': 'result', 'experimentId': 'exp', 'caseId': 'case',
            'evaluatorId': 'judge', 'status': 'done', 'score': 20.5, 'humanScore': 88.25,
            'humanReason': '人工理由', 'humanBy': 'alice', 'humanAt': '2020-01-02T00:00:00.000Z',
            'pointsJson': '[{"中文":0}]', 'evidenceJson': '{"md":"证据"}', 'attempts': 3,
            'createdAt': '2020-01-01T00:00:02.000Z', 'updatedAt': '2020-01-02T00:00:00.000Z'})
        service = self.service([head, case, result])
        for row in [head, case, result]: proof = self.write(service, row)
        value = ExperimentStore(self.control).dispatch('read', self.token, 'w', {'experiment_id': 'exp'})['experiment']['cases'][0]['results'][0]
        for key in ['score', 'humanScore', 'humanReason', 'humanAt', 'pointsJson', 'evidenceJson', 'attempts', 'createdAt', 'updatedAt']:
            self.assertEqual(value[key], result['data'][key], key)
        self.assertIsNone(self.control.claim('w', 'real-worker'))
        self.assertEqual(service.importer.facts.rows['eval_metric_facts'][0]['value_float'], 20.5)
        self.assertTrue(any(v['metric_key'] == 'human_score' and v['value_float'] == 88.25
                            for v in service.importer.facts.rows['eval_metric_facts']))
        with self.control.read_transaction() as con:
            attempt = con.execute('SELECT * FROM work_attempts').fetchone()
            self.assertEqual(attempt['started_at_ms'], self.now)
            self.assertEqual(attempt['finished_at_ms'], self.now)
            self.assertEqual(attempt['status'], 'done')
        service.importer.facts.rows.clear()
        with self.control.read_transaction() as con: self.assertFalse(service.verify(con, result, 'w', proof))

    def test_foreign_case_trace_and_existing_target_never_adopted(self):
        head = self.head(); service = self.service([head]); self.write(service, head)
        with self.assertRaises(Conflict): self.write(service, head)
        case = self.row('ExperimentCase', {'id': 'case', 'experimentId': 'exp', 'executionId': 'missing',
                                        'createdAt': '2020-01-01T00:00:00.000Z'})
        with self.assertRaises(Conflict): self.write(service, case)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_cases').fetchone()[0], 0)
        with self.control.transaction() as con:
            with self.assertRaises(Forbidden): service.write(con, self.head(id='other'), self.iam._scope(con, self.bob), 'w', 'alice')

    def test_proof_detects_manual_change_and_facts_not_present(self):
        head = self.head(); service = self.service([head]); proof = self.write(service, head)
        with self.control.transaction() as con:
            con.execute("UPDATE experiment_heads SET name='changed',revision=revision+1 WHERE experiment_id='exp'")
        with self.control.read_transaction() as con:
            with self.assertRaises(Conflict): service.verify(con, head, 'w', proof)

    def test_fact_proof_only_reads_fixed_tables_in_its_workspace(self):
        from services.storage.legacy import LegacyValidationError
        head = self.head(); service = self.service([head]); proof = self.write(service, head)
        for table, value in [('not_a_fact_table', {'workspace_id': 'w', 'result_id': 'r'}),
                             ('eval_result_facts', {'workspace_id': 'foreign', 'result_id': 'r'})]:
            changed = copy.deepcopy(proof); changed['facts'] = {table: [value]}
            with self.control.read_transaction() as con, self.assertRaises(LegacyValidationError):
                service.verify(con, head, 'w', changed)

    def test_trajectory_and_metric_rows_become_real_private_typed_results(self):
        from services.storage.tests.test_collector_sources import CurrentFacts
        from services.storage.tests.test_trace_transfer import node
        from services.storage.observations import ObservationIngest
        from services.storage.collector_sources import CollectorSources
        source_facts = CurrentFacts(); ingest = ObservationIngest(self.control, source_facts)
        api = self.iam.issue_api_credential(self.token, 'w', ['write'])
        sources = CollectorSources(self.control, ingest)
        reserved = sources.reserve(api, 'w', {'operation_key': 'trace', 'operation': 'snapshot',
            'task_id': 'task', 'execution_id': 'execution', 'legacy_username': 'alice',
            'framework': 'pi-agent', 'operation_request': {'original': True}})
        snapshot = node(identity='execution', task='task', interactions=[{'role': 'assistant', 'content': 'answer'}])
        snapshot['execution'].update(user='alice', framework='pi-agent'); snapshot['session']['user'] = 'alice'
        sources.commit(api, 'w', {'task_id': 'task', 'operation_key': 'trace', 'expected_revision': reserved['base_revision'], 'snapshot': snapshot})
        for _ in range(20):
            if not ingest.work_once('test'): break
        execution = self.row('Execution', snapshot['execution'])
        trajectory = self.row('TrajectoryEvalResult', {'id': 'trajectory', 'user': 'alice',
            'evaluatorRunId': 'old-run', 'datasetId': 'old-dataset', 'caseId': 'old-case',
            'executionId': 'execution', 'taskId': 'task', 'status': 'done', 'trajectoryScore': 0.72,
            'rawAnalysisJson': '{"中文":0.2}', 'dimensionScoresJson': '{"toolChoice":0.5}',
            'createdAt': '2020-01-01T00:00:00.000Z', 'updatedAt': '2020-01-02T00:00:00.000Z'})
        metric = self.row('TraceEvaluation', {'id': 'metric', 'executionId': 'execution', 'evaluatorId': 'metric-eval',
            'evaluatorVersion': '1', 'dimension': 'quality', 'metricKey': 'score', 'status': 'done', 'score': None,
            'method': 'model', 'confidence': 0, 'interactionsHash': 'original', 'ranAt': '2020-01-01T00:00:00.000Z',
            'updatedAt': '2020-01-02T00:00:00.000Z'})
        match = self.row('ExecutionMatch', {'id': 'match', 'executionId': 'execution', 'user': 'alice',
            'mode': 'dynamic', 'skillId': None, 'skillVersion': None, 'matchJson': '{"matches":[]}',
            'dynamicMermaid': 'graph TD; A-->B', 'staticMermaid': None, 'analysisText': '原分析',
            'extractedSteps': '[{"tool":"read"}]', 'interactionCount': 1, 'matchedAt': '2020-01-02T00:00:00.000Z'})
        service = self.service([execution, trajectory, metric, match])
        for row in [trajectory, metric, match]: self.write(service, row)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM result_receipts').fetchone()[0], 3)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM experiment_heads WHERE scope='trajectory-direct'").fetchone()[0], 1)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM work_items WHERE phase<>'migrate'").fetchone()[0], 0)
        facts = service.importer.facts.rows['eval_metric_facts']
        self.assertTrue(any(value['value_float'] == 72 for value in facts))
        self.assertTrue(any(value['value_type'] == 'missing' for value in facts))
        selected = ExperimentStore(self.control).dispatch('flow_lookup', self.token, 'w', {'trace_ref': 'execution'})
        self.assertEqual(selected['match']['value']['matchJson'], match['data']['matchJson'])
        self.assertEqual(selected['match']['value']['analysisText'], '原分析')
        listed = ExperimentStore(self.control).dispatch('read_view', self.token, 'w', {})['snapshots']
        self.assertTrue(all(value['experiment']['scope'] not in {'legacy-flow-analysis', 'trace-metrics-history'} for value in listed))

    def test_dynamic_evaluation_issues_keep_original_resolution_and_live_skill_scope(self):
        from services.storage.platform_controls import PlatformControls
        controls = PlatformControls(self.control)
        with self.control.transaction() as con:
            scope = self.iam._scope(con, self.token); grant = self.iam._workspace(scope, 'w', 'write')
            controls._put(con, scope, grant, 'w', 'alice', {'kind': 'skill', 'method': 'create',
                'data': {'id': 'skill', 'name': 'my-skill', 'user': 'alice'}})
            controls._put(con, scope, grant, 'w', 'alice', {'kind': 'skillVersion', 'method': 'create',
                'data': {'id': 'version', 'skillId': 'skill', 'version': 0, 'content': '# Original'},
                'file_bundle': [{'path': 'SKILL.md', 'content': __import__('base64').b64encode(b'# Original').decode(), 'mode': 0o644}]})
        evaluation = self.row('Evaluation', {'id': 'evaluation', 'type': 'dynamic', 'skillId': 'skill', 'version': 0,
            'user': 'alice', 'executionId': None, 'status': 'ok', 'runId': 'old-evaluator-run',
            'ranAt': '2020-01-01T00:00:00.000Z', 'generator': 'old-judge'})
        issue = self.row('SkillIssue', {'id': 'issue', 'evaluationId': 'evaluation', 'source': 'dynamic',
            'skillId': 'skill', 'version': 0, 'user': 'alice', 'dedupKey': 'same', 'severity': 'high',
            'summary': '历史问题', 'reasoning': '原始理由', 'suggestedFix': '修复',
            'resolvedAt': '2020-01-02T00:00:00.000Z', 'resolvedRunId': 'old-thread',
            'createdAt': '2020-01-01T00:00:00.000Z'})
        service = self.service([evaluation, issue]); self.write(service, evaluation); self.write(service, issue)
        value = ExperimentStore(self.control).dispatch('derived_lookup', self.token, 'w', {'kind': 'issue', 'id': 'issue'})
        self.assertEqual(value['resolvedAt'], issue['data']['resolvedAt']); self.assertEqual(value['resolvedRunId'], 'old-thread')
        self.assertEqual(value['reasoning'], '原始理由')
        trigger = self.row('SkillTriggerEvalRun', {'id': 'old-trigger', 'user': 'alice', 'skillName': 'my-skill',
            'skillVersion': 0, 'triggerSetId': 'old-set', 'resultsJson': '[{"itemId":"q","pass":true}]',
            'passRate': 0.8, 'truePositiveRate': 0.75, 'falsePositiveRate': 0.1, 'runsPerQuery': 3,
            'triggerThreshold': 0.5, 'timeoutMs': 30000, 'durationMs': 1234, 'status': 'done',
            'createdAt': '2020-01-01T00:00:00.000Z', 'updatedAt': '2020-01-02T00:00:00.000Z'})
        service.importer.rows.append(trigger); self.write(service, trigger)
        trigger_view = ExperimentStore(self.control).dispatch('trigger_read', self.token, 'w', {'run_id': 'old-trigger'})['run']
        self.assertEqual(trigger_view['results'], json.loads(trigger['data']['resultsJson']))
        self.assertEqual(trigger_view['durationMs'], 1234)
        listed = ExperimentStore(self.control).dispatch('trigger_list', self.token, 'w', {'skill_name': 'my-skill'})
        self.assertEqual(listed['runs'][0]['id'], 'old-trigger')
        with self.control.transaction() as con:
            con.execute("UPDATE platform_control_records SET state='deleted',revision=revision+1 WHERE kind='skill' AND record_id='skill'")
        with self.assertRaises(Forbidden):
            ExperimentStore(self.control).dispatch('derived_lookup', self.token, 'w', {'kind': 'issue', 'id': 'issue'})

    def test_historical_attempts_and_local_execution_use_the_original_read_contract(self):
        head = self.head(); case = self.row('ExperimentCase', {'id': 'case', 'experimentId': 'exp',
            'createdAt': '2020-01-01T00:00:01.000Z'})
        attempt = self.row('ExperimentTraceAttempt', {'id': 'attempt', 'experimentId': 'exp',
            'caseId': 'case', 'attemptNo': 3, 'workerId': 'old-client', 'platform': 'opencode', 'agent': 'build',
            'status': 'waiting_trace', 'traceId': None, 'createdAt': '2020-01-01T00:00:02.000Z',
            'updatedAt': '2020-01-01T00:00:03.000Z', 'startedAt': None, 'finishedAt': None})
        local = self.row('ExperimentLocalExecution', {'id': 'local', 'experimentId': 'exp', 'caseKey': 'logical',
            'createdAt': '2020-01-01T00:00:01.000Z'})
        service = self.service([head, case, attempt, local])
        for row in [head, case, attempt, local]: self.write(service, row)
        value = ExperimentStore(self.control).dispatch('read', self.token, 'w', {'experiment_id': 'exp'})
        self.assertEqual(value['local_executions'], [local['data']])
        self.assertEqual(value['experiment']['traceAttempts'], [attempt['data']])
        self.assertIsNone(self.control.claim('w', 'real-worker'))
        with self.control.transaction() as con:
            con.execute("UPDATE experiment_heads SET name='current',revision=revision+1 WHERE experiment_id='exp'")
        updated = ExperimentStore(self.control).dispatch('read', self.token, 'w', {'experiment_id': 'exp'})
        self.assertEqual(updated['experiment']['name'], 'current')
        self.assertEqual(updated['experiment']['traceAttempts'], [])

    def test_benchmark_private_dataset_jobs_and_dispatch_remain_inert_and_readable(self):
        from services.storage.datasets import DatasetStore
        public = dataset_fixture.record('public', 'Benchmark'); public['datasetKind'] = 'benchmark'
        datasets = DatasetStore(self.control); prepared = datasets._prepare_record(public)
        with self.control.transaction() as con:
            datasets._save_tx(con, self.token, 'w', prepared, operation_key='public', allow_readonly=True)
        dataset = self.row('BenchmarkDataset', {'id': 'bench', 'agentEvalDatasetId': 'public', 'user': 'alice',
            'name': 'Benchmark', 'adapterKey': 'adapter', 'contentHash': 'a'*64, 'status': 'ready',
            'caseCount': 1, 'sourceJson': '{}', 'createdAt': '2020-01-01T00:00:00.000Z', 'updatedAt': '2020-01-02T00:00:00.000Z'})
        dc = self.row('BenchmarkDatasetCase', {'id': 'dc', 'datasetId': 'bench', 'externalCaseId': 'external',
            'ordinal': 0, 'rawCaseJson': '{"secret":1}', 'publicPayloadJson': '{"input":"问题"}',
            'privatePayloadJson': '{"gold":"secret"}', 'sourceFingerprint': 'a'*64,
            'publicFingerprint': 'b'*64, 'privateFingerprint': 'c'*64, 'createdAt': '2020-01-01T00:00:00.000Z'})
        head = self.head(scope='benchmark', status='done')
        case = self.row('ExperimentCase', {'id': 'case', 'experimentId': 'exp', 'input': '问题',
            'createdAt': '2020-01-01T00:00:00.000Z'})
        binding = self.row('BenchmarkExperimentBinding', {'experimentId': 'exp', 'datasetId': 'bench',
            'datasetContentHash': 'a'*64, 'adapterKey': 'adapter', 'selectionJson': '{"mode":"all"}',
            'runConfigJson': '{}', 'schedulerStatus': 'running', 'expectedCaseCount': 1,
            'createdAt': '2020-01-01T00:00:00.000Z', 'updatedAt': '2020-01-02T00:00:00.000Z'})
        run = self.row('BenchmarkCaseRun', {'id': 'job', 'experimentId': 'exp', 'experimentCaseId': 'case',
            'datasetCaseId': 'dc', 'ordinal': 0, 'status': 'running_agent', 'adapterKey': 'adapter',
            'clientId': 'old-client', 'publicPayloadJson': dc['data']['publicPayloadJson'],
            'privatePayloadJson': dc['data']['privatePayloadJson'], 'runFactsJson': '{}',
            'createdAt': '2020-01-01T00:00:01.000Z', 'updatedAt': '2020-01-02T00:00:00.000Z'})
        dispatch = self.row('BenchmarkDispatchOutbox', {'id': 'dispatch', 'runId': 'job', 'status': 'pending',
            'requestJson': '{"private":"request"}', 'requestDigest': 'd'*64, 'attemptCount': 2,
            'nextAttemptAt': '2020-01-02T00:00:00.000Z', 'createdAt': '2020-01-01T00:00:00.000Z',
            'updatedAt': '2020-01-02T00:00:00.000Z'})
        service = self.service([dataset, dc, head, case, binding, run, dispatch])
        for row in [dataset, dc, head, case, binding, run, dispatch]: self.write(service, row)
        from services.storage.benchmark_core import BenchmarkStore
        with self.control.read_transaction() as con:
            scope = self.iam._scope(con, self.token)
            record = dict(con.execute('SELECT * FROM experiment_heads WHERE experiment_id=?', ('exp',)).fetchone())
            snapshot = ExperimentStore(self.control)._snapshot(con, 'w', record)
            jobs = [dict(row) for row in con.execute('SELECT * FROM benchmark_jobs')]
            value = BenchmarkStore(self.control)._result_view(con, record, snapshot, jobs, scope)
            self.assertEqual(value['benchmark_runs'][0]['status'], 'running_agent')
            self.assertEqual(value['benchmark_runs'][0]['clientId'], 'old-client')
            self.assertEqual(value['benchmark_runs'][0]['privatePayloadJson'], dc['data']['privatePayloadJson'])
            self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox_events WHERE event_type LIKE 'benchmark.%'").fetchone()[0], 0)
        self.assertIsNone(self.control.claim('w', 'real-worker'))
        public_view = BenchmarkStore(self.control).dispatch('read_view', self.token, 'w', {'experiment_id': 'exp'})
        self.assertEqual(public_view['snapshots'][0]['benchmark_runs'][0]['status'], 'running_agent')
        plan = ExperimentStore(self.control).dispatch('runplan', self.token, 'w', {'experiment_id': 'exp'})['runplan']
        self.assertEqual(set(plan['releases']), {'dataset', 'benchmark'})
        admin_view = BenchmarkStore(self.control).dispatch('read_view', self.admin, 'w', {'experiment_id': 'exp'})
        self.assertNotIn('privatePayloadJson', admin_view['snapshots'][0]['benchmark_runs'][0])
        with self.assertRaises(Forbidden): BenchmarkStore(self.control).dispatch('read_view', self.bob, 'w', {'experiment_id': 'exp'})
        evaluation = self.row('BenchmarkEvaluation', {'id': 'eval', 'caseRunId': 'job', 'attemptNo': 2,
            'status': 'normalizing', 'adapterKey': 'adapter', 'evaluatorKey': 'official', 'requestJson': '{}',
            'requestDigest': 'e'*64, 'callbackBaseUrl': 'http://old.invalid', 'timeoutSeconds': 120,
            'normalizedResultJson': '{"score":0.75}', 'continuationStatus': 'pending',
            'createdAt': '2020-01-01T00:00:04.000Z', 'updatedAt': '2020-01-02T00:00:00.000Z'})
        service.importer.rows.append(evaluation); self.write(service, evaluation)
        artifact_bytes = '历史证据'.encode(); encoded = __import__('base64').b64encode(artifact_bytes).decode()
        artifact = self.row('BenchmarkEvaluationArtifact', {'id': 'artifact', 'evaluationId': 'eval', 'name': 'answer.txt',
            'kind': 'evidence', 'mediaType': 'text/plain', 'sha256': hashlib.sha256(artifact_bytes).hexdigest(),
            'sizeBytes': len(artifact_bytes), 'storagePath': '/old/private/path', 'createdAt': '2020-01-02T00:00:00.000Z'})
        self.assertEqual(service.issues(artifact), ['benchmark_artifact_bytes_required'])
        service.importer.files = {artifact['entity_key']: {'content': encoded}}
        service.importer.rows.append(artifact); self.write(service, artifact)
        view = BenchmarkStore(self.control).dispatch('read_view', self.token, 'w', {'experiment_id': 'exp'})['snapshots'][0]
        self.assertEqual(view['benchmark_runs'][0]['evaluations'][0]['normalizedResultJson'], '{"score":0.75}')
        self.assertEqual(view['benchmark_runs'][0]['evaluations'][0]['continuationStatus'], 'pending')
        downloaded = BenchmarkStore(self.control).dispatch('artifact_read', self.token, 'w', {'job_id': 'eval', 'artifact_id': 'artifact'})
        self.assertEqual(downloaded['bytes_base64'], encoded)


if __name__ == '__main__': unittest.main()
