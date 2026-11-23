const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Prisma } = require('@prisma/client');

const root = path.resolve(__dirname, '..');
const groups = {
  identity: 'User UserSettings UserGuideState',
  assets: 'Skill SkillVersion Config CustomEvaluatorList AgentEvalDataset RegisteredAgent SkillTriggerEvalSet',
  trace: 'Execution Session TraceThread TraceThreadEvent ExecutionSkill ExecutionSkillOrigin Tag ExecutionTag',
  evaluation: 'TraceEvaluation Evaluation SkillIssue ParsedFlow ExecutionMatch SkillSnapshotEvaluation DebugHistory DebugJobResult TrajectoryEvalResult SkillTriggerEvalRun',
  workbench: 'SkillGeneratorSession SkillGeneratorMessage SkillOptSession SkillOptPlan SkillOptPlanItem SkillOptMessage SkillOptIteration SkillWorkbenchSession SkillWorkbenchMessage SkillWorkbenchTask SkillOptimizationRecord',
  diagnosis: 'FaultDiagnosisSession FaultDiagnosisMessage DiagnosisRun AgentDebugReport AgentDebugSkillsAnalysis',
  experiment: 'BatchEvalTask GrayscaleTask Experiment ExperimentCancellation ExperimentLocalExecution ExperimentGroup ExperimentCase ExperimentTraceAttempt ExperimentEvalResult ExperimentEvalComment',
  benchmark: 'BenchmarkDataset BenchmarkDatasetCase BenchmarkExperimentBinding BenchmarkCaseRun BenchmarkArtifact BenchmarkDispatchOutbox BenchmarkEvaluation BenchmarkEvaluationArtifact BenchmarkEvaluationDispatchOutbox',
  infra: 'SessionInfraLink InfraSource InfraMetricSample',
  fi: 'FaultInjectionTask FaultInjectionRun FaultInjectionWorker RasAnomalyEvent',
  reliability: 'ReliabilityInstallToken ReliabilityClient SkillDeployment SkillDeploymentEvent ReliabilityClientCredential ReliabilityCommand ReliabilityClientConfig ReliabilityConfigSnapshot ReliabilityConfigDelivery ReliabilityConfigLoad',
  goal: 'GoalPlusSource GoalPlusGoal GoalPlusRun GoalPlusCandidate GoalPlusIteration GoalPlusAgentSession GoalPlusExecutionLink GoalPlusSemanticSnapshot',
  collaboration: 'Collaboration CollaborationEvent CollaborationEndpointResolution CollaborationSessionBinding',
  usage: 'PlatformUsageEvent PlatformUsageDaily',
  generation: 'TraceDatasetGenerationJob TraceDatasetOperationReceipt',
};
const targets = {
  User: 'iam_principal_and_external_identity', UserSettings: 'principal_configuration_and_secret_references', UserGuideState: 'principal_guide_state',
  Skill: 'asset_identity', SkillVersion: 'skill_release_and_artifacts', Config: 'routing_outcome_dataset_private_gold', CustomEvaluatorList: 'evaluator_release', AgentEvalDataset: 'dataset_release_members_and_private_gold', RegisteredAgent: 'agent_identity_and_release', SkillTriggerEvalSet: 'trigger_dataset_release',
  Execution: 'trace_summary_relations_and_lifecycle', Session: 'trace_spans_and_payload', TraceThread: 'thread_identity_and_relations', TraceThreadEvent: 'trace_event_facts', ExecutionSkill: 'skill_usage_relations', ExecutionSkillOrigin: 'skill_source_locator_evidence', Tag: 'editable_tag_definition', ExecutionTag: 'editable_tag_link',
  TraceEvaluation: 'machine_result_facts_and_selection', Evaluation: 'skill_evaluation_facts', SkillIssue: 'issue_facts_and_resolution_annotation', ParsedFlow: 'release_bound_analysis_artifact', ExecutionMatch: 'snapshot_bound_analysis_artifact', SkillSnapshotEvaluation: 'draft_snapshot_evaluation_facts', DebugHistory: 'comparison_history_artifact', DebugJobResult: 'job_terminal_state_and_output', TrajectoryEvalResult: 'trajectory_evaluation_facts', SkillTriggerEvalRun: 'trigger_evaluation_run_facts',
  SkillGeneratorSession: 'generator_session_and_file_snapshot', SkillGeneratorMessage: 'generator_message_history', SkillOptSession: 'optimization_session', SkillOptPlan: 'optimization_plan', SkillOptPlanItem: 'plan_item_decision_state', SkillOptMessage: 'optimization_message_history', SkillOptIteration: 'candidate_snapshot_and_iteration_history', SkillWorkbenchSession: 'workbench_orchestration_state', SkillWorkbenchMessage: 'workbench_presentation_history', SkillWorkbenchTask: 'idempotent_task_control', SkillOptimizationRecord: 'candidate_experiment_publication_links',
  FaultDiagnosisSession: 'trace_diagnosis_sessions', FaultDiagnosisMessage: 'trace_diagnosis_messages', DiagnosisRun: 'diagnosis_run_and_private_artifacts', AgentDebugReport: 'diagnostic_report_runs_and_head', AgentDebugSkillsAnalysis: 'skills_analysis_report_runs_and_head',
  BatchEvalTask: 'evaluation_task_control', GrayscaleTask: 'comparison_task_and_run_plan', Experiment: 'experiment_heads_and_runs', ExperimentCancellation: 'cancellation_annotation', ExperimentLocalExecution: 'execution_control_marker', ExperimentGroup: 'frozen_group_configuration', ExperimentCase: 'experiment_cases_and_payload', ExperimentTraceAttempt: 'attempt_checkpoint', ExperimentEvalResult: 'machine_facts_selection_and_human_review', ExperimentEvalComment: 'experiment_comment_annotation',
  BenchmarkDataset: 'public_private_benchmark_releases', BenchmarkDatasetCase: 'ordered_public_private_raw_case_artifacts', BenchmarkExperimentBinding: 'benchmark_experiment_binding', BenchmarkCaseRun: 'benchmark_job_and_execution_result', BenchmarkArtifact: 'artifact_metadata_and_bytes', BenchmarkDispatchOutbox: 'inert_execution_dispatch_history', BenchmarkEvaluation: 'evaluation_job_and_result', BenchmarkEvaluationArtifact: 'artifact_metadata_and_bytes', BenchmarkEvaluationDispatchOutbox: 'inert_evaluation_dispatch_history',
  SessionInfraLink: 'editable_authoritative_infra_override', InfraSource: 'source_configuration_and_secret_reference', InfraMetricSample: 'metric_facts', FaultInjectionTask: 'fault_injection_task_control', FaultInjectionRun: 'fault_injection_run_and_judgment_facts', FaultInjectionWorker: 'worker_registration_no_active_lease', RasAnomalyEvent: 'anomaly_event_facts',
  ReliabilityInstallToken: 'quarantined_expired_install_credential', ReliabilityClient: 'client_registration_no_live_status', SkillDeployment: 'deployment_control', SkillDeploymentEvent: 'deployment_event_facts', ReliabilityClientCredential: 'quarantined_credential_reissue_required', ReliabilityCommand: 'inert_command_history', ReliabilityClientConfig: 'client_configuration_head', ReliabilityConfigSnapshot: 'private_configuration_release', ReliabilityConfigDelivery: 'configuration_delivery_history', ReliabilityConfigLoad: 'configuration_load_facts',
  GoalPlusSource: 'source_and_sync_checkpoint', GoalPlusGoal: 'goal_current_state', GoalPlusRun: 'goal_run_and_frozen_specification', GoalPlusCandidate: 'candidate_state', GoalPlusIteration: 'iteration_facts', GoalPlusAgentSession: 'agent_session_and_transcript_reference', GoalPlusExecutionLink: 'trace_link_resolution_state', GoalPlusSemanticSnapshot: 'immutable_source_snapshot',
  Collaboration: 'collaboration_identity_and_summary', CollaborationEvent: 'collaboration_event_facts', CollaborationEndpointResolution: 'endpoint_resolution_and_history', CollaborationSessionBinding: 'session_binding', PlatformUsageEvent: 'usage_event_facts', PlatformUsageDaily: 'derived_daily_summary_not_new_events', TraceDatasetGenerationJob: 'dataset_generation_job_no_active_lease', TraceDatasetOperationReceipt: 'dataset_operation_receipt',
};
const traceFields = {
  Session: new Set('id taskId user startTime endTime interactions query label model langfuseTraceNodes'.split(' ')),
  Execution: new Set('id taskId user timestamp latency query finalResult agentName framework model inputTokens outputTokens executionStatus isSubagent parentExecutionId rootExecutionId'.split(' ')),
};
const sensitive = new Set(['User.apiKey', 'UserSettings.settingsJson', 'InfraSource.authHeaders', 'ReliabilityInstallToken.tokenHash', 'ReliabilityClientCredential.credentialHash']);
const types = {String: 'TEXT', Int: 'INTEGER', BigInt: 'BIGINT', Float: 'REAL', Boolean: 'BOOLEAN', DateTime: 'DATETIME', Bytes: 'BLOB', Json: 'JSONB'};
const models = Prisma.dmmf.datamodel.models;
const byName = new Map(models.map(m => [m.name, m]));
const physical = (model, field) => byName.get(model).fields.find(f => f.name === field).dbName || field;
const domain = new Map(Object.entries(groups).flatMap(([g, names]) => names.split(' ').map(n => [n, g])));
if (models.length !== 96 || domain.size !== 96 || models.some(m => !domain.has(m.name) || !targets[m.name])) throw new Error('Review legacy domain mapping for changed Prisma model set');
const catalog = {
  version: 1,
  schema_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'prisma/schema.prisma'))).digest('hex'),
  mode: 'planning-only',
  models: models.map(m => {
    const relations = m.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length).map(f => ({field: f.name, target_model: f.type, from: f.relationFromFields.map(n => physical(m.name, n)), to: f.relationToFields.map(n => physical(f.type, n)), on_delete: f.relationOnDelete || null}));
    const own = m.name === 'User' ? 'username' : m.fields.find(f => f.kind === 'scalar' && ['user', 'owner'].includes(f.name))?.name;
    const logical = [];
    const add = (field, target, to = 'id') => logical.push({field, target_model: target, from: [physical(m.name, field)], to: [physical(target, to)]});
    if (m.name === 'Execution') {add('parentExecutionId', 'Execution'); add('rootExecutionId', 'Execution');}
    if (m.name === 'ExperimentLocalExecution') add('experimentId', 'Experiment');
    if (m.name === 'SessionInfraLink') {add('rootExecutionId', 'Execution'); add('sourceId', 'InfraSource');}
    return {
      model: m.name, table: m.dbName || m.name, domain: domain.get(m.name), target: targets[m.name],
      migration_status: traceFields[m.name] ? 'limited_trace_conversion' : 'pending_conversion',
      credentials: ['User', 'ReliabilityInstallToken', 'ReliabilityClientCredential'].includes(m.name) ? 'quarantine_and_reissue_no_direct_copy' : 'private_review_required',
      owner: own ? {kind: 'direct', column: physical(m.name, own)} : {kind: relations.length ? 'inherited' : 'unresolved', relations: relations.map(r => r.field)},
      primary_key: (m.primaryKey?.fields || m.fields.filter(f => f.isId).map(f => f.name)).map(n => physical(m.name, n)),
      unique_keys: [...m.uniqueFields.map(fields => fields.map(n => physical(m.name, n))), ...m.fields.filter(f => f.isUnique).map(f => [f.dbName || f.name])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      columns: m.fields.filter(f => f.kind !== 'object').map(f => ({field: f.name, column: f.dbName || f.name, prisma_type: f.type, sqlite_type: types[f.type], required: f.isRequired,
        handling: sensitive.has(m.name + '.' + f.name) && m.name !== 'UserSettings' ? 'credential_quarantine_no_direct_copy' : traceFields[m.name]?.has(f.name) ? 'limited_trace_allowlist' : 'private_pending_conversion',
        sensitivity: sensitive.has(m.name + '.' + f.name) ? 'contains_or_may_contain_credentials' : 'private_source_data',
        structured_content: /json|settings|files|interactions|blocks|payload|config|request|result/i.test(f.name) ? 'opaque_private_untransformed' : null})),
      relations, logical_relations: logical,
      native_identity: m.name === 'Execution' ? ['user', 'framework', 'traceThreadId', 'sourceExecutionId'] : [],
    };
  }),
};
const output = JSON.stringify(catalog, null, 2) + '\n';
const filename = path.join(root, 'services/storage/schema/legacy-catalog.json');
if (process.argv.slice(2).some(a => a !== '--check')) throw new Error('Only --check is supported; omit to generate catalog');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== output) {console.error('Legacy catalog differs from installed Prisma DMMF or reviewed policy'); process.exitCode = 1;}
} else fs.writeFileSync(filename, output);
