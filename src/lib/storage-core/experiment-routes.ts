import { prisma } from '@/lib/storage/prisma';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { addEvalExperimentCase, startEvalExperimentCases, startExperimentRun, retryResultRow } from '@/lib/engine/experiment/run-experiment';
import { assertTraceGenerationTarget, collectTraceGenerationCases, loadTraceGenerationRetryRequest, generateExperimentTraces, TraceGenerationError, type TraceGenerationRequest } from '@/lib/engine/experiment/trace-generation';
import { assertFiExecutionTarget, collectFiCasesFromExperiment, FiOrchestrateError, type FiOrchestrateRequest } from '@/lib/engine/experiment/fi-orchestrate';
import { DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS } from '@/lib/engine/experiment/constants';
import { parseExecutionConcurrency } from '@/lib/engine/experiment/execution-concurrency';
import { prepareCoreTraceRun } from './experiment-trace-worker';
import { orchestrateCoreFi, prepareCoreFiDispatch } from './experiment-fi-worker';
import { requireCoreExperimentContext, withCoreExperimentMutationRoute } from './experiments';
type Value = Record<string, unknown>;
type Case = Value & {
    id: string;
    input: string;
    results?: Array<{
        id: string;
        status: string;
        evaluatorId?: string;
    }>;
    traceAttempts?: Array<Value>;
};
type Experiment = Value & {
    id: string;
    status: string;
    scope: string;
    type: string;
    agentName: string;
    cases: Case[];
    evaluatorIdsJson: string;
    configSnapshotJson: string | null;
};
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {};
function parse(value: unknown): Value {
    try {
        return object(typeof value === 'string' ? JSON.parse(value) : value);
    }
    catch {
        return {};
    }
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
function missing(): never { throw Object.assign(new Error('Experiment or Case not found'), { status: 404 }); }
async function read(id: string) {
    const result = await requireCoreExperimentContext().rpc('read', { experiment_id: id }) as {
        experiment: Experiment;
        revision: string;
    };
    if (!result?.experiment)
        missing();
    return result;
}
function background(completion: Promise<unknown>) { void completion.catch(error => console.error('[core-experiment]', error)); }
function usage(eventKey: string) { recordUsageEvent({ user: requireCoreExperimentContext().actor.username, featureKey: 'experiments', eventKey }); }
export async function coreExperimentWriteRoute(request: Request, action: () => Promise<Response>): Promise<Response> {
    return withCoreExperimentMutationRoute(request, async () => {
        try {
            return await action();
        }
        catch (error) {
            if (error instanceof TraceGenerationError)
                return json({ error: error.message, code: error.code }, error.httpStatus);
            if (error instanceof FiOrchestrateError)
                return json({ error: error.message, code: error.code, fiOrchestrate: { skipped: false, reason: error.code } }, error.httpStatus);
            throw error;
        }
    });
}
export async function patchCoreExperimentRoute(id: string): Promise<Response> {
    const context = requireCoreExperimentContext();
    const body = context.body;
    let changes: Value;
    let response: Value;
    if (Object.hasOwn(body, 'name')) {
        if (body.watchMode !== undefined)
            return json({ error: '一次只能修改一个实验字段' }, 400);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 120)
            return json({ error: '实验名称须为 1～120 个字符' }, 400);
        changes = { name };
        response = { success: true, name };
    }
    else {
        if (body.watchMode !== false)
            return json({ error: 'only supports watchMode:false (stop watching)' }, 400);
        changes = { watchMode: false };
        response = { success: true, watchMode: false };
    }
    const current = await read(id);
    await context.rpc('update', { experiment_id: id, expected_revision: current.revision, changes });
    if (changes.watchMode === false)
        usage('experiment.watch.stop');
    return json(response);
}
export async function deleteCoreExperimentRoute(request: Request, id: string, caseId?: string): Promise<Response> {
    const context = requireCoreExperimentContext();
    const { cancelCoreExperimentExecution,coreCancellationKind } = await import('./experiment-cancellation');
    const stop = new URL(request.url).searchParams.get('stop') === 'true';
    if (!caseId && !stop) {
        if(await coreCancellationKind(context,{experiment_id:id,mode:'remove'})==='benchmark'){
            await cancelCoreExperimentExecution(context,id,{deleteExperiment:true,draftOnly:true});return json({deleted:true});
        }
        const current = await read(id);
        if (current.experiment.status !== 'draft')
            return json({ error: 'experiment has already started', status: current.experiment.status }, 409);
        await cancelCoreExperimentExecution(context, id, { deleteExperiment: true, draftOnly: true });
        return json({ deleted: true });
    }
    const cancellation = await cancelCoreExperimentExecution(context, id, { ...(caseId ? { caseId } : { deleteExperiment: true }) });
    if (caseId) {
        const deleted=(cancellation as typeof cancellation&{coreExperimentDeleted?:boolean}).coreExperimentDeleted;
        if(typeof deleted==='boolean')return json({deleted:true,experimentDeleted:deleted,cancellation},cancellation.status==='completed'?200:202);
        let experimentDeleted = false;
        try {
            const current = await read(id);
            experimentDeleted = Boolean(current.experiment.deletedAt);
        }
        catch (error) {
            if ((error as {
                status?: number;
            }).status !== 404)
                throw error;
            experimentDeleted = true;
        }
        return json({ deleted: true, experimentDeleted, cancellation }, cancellation.status === 'completed' ? 200 : 202);
    }
    return json({ deleted: true, cancellation }, cancellation.status === 'completed' ? 200 : 202);
}
export async function appendCoreExperimentCasesRoute(id: string): Promise<Response> {
    const context = requireCoreExperimentContext();
    const body = context.body;
    const cases = Array.isArray(body.cases) ? body.cases.map(object) : [];
    if (!cases.length)
        return json({ error: 'at least one case is required' }, 400);
    if (cases.length > 200)
        return json({ error: '一次最多追加 200 条 case' }, 400);
    const autoRun = body.autoRun !== false;
    const { experiment } = await read(id);
    if (experiment.scope === 'benchmark')
        return json({ error: 'Benchmark Case 输入已固定，请重新选择数据集创建实验' }, 409);
    let evaluatorIds: unknown = [];
    try {
        evaluatorIds = JSON.parse(experiment.evaluatorIdsJson || '[]');
    }
    catch { }
    if (autoRun && (!Array.isArray(evaluatorIds) || !evaluatorIds.length))
        return json({ error: '该实验未配置评估器，无法评测新增 case' }, 409);
    const oldTaskIds = new Set(experiment.cases.map(row => row.taskId).filter(Boolean));
    const incoming = cases.map(row => row.taskId ? String(row.taskId) : '').filter(Boolean);
    const caseIds: string[] = [];
    for (const row of cases)
        caseIds.push(await addEvalExperimentCase(id, { executionId: row.executionId ? String(row.executionId) : null, taskId: row.taskId ? String(row.taskId) : null, input: String(row.input ?? ''), datasetInput: row.datasetInput != null && String(row.datasetInput).trim() ? String(row.datasetInput) : null, actualOutput: String(row.actualOutput ?? ''), referenceOutput: row.referenceOutput != null && String(row.referenceOutput).trim() ? String(row.referenceOutput) : null }));
    if (autoRun) {
        const started = await startEvalExperimentCases(id, caseIds, context.actor.username);
        if (!started)
            missing();
        background(started.completion);
    }
    usage('experiment.case.create');
    const reused = incoming.filter(task => oldTaskIds.has(task)).length;
    return json({ added: caseIds.length - reused, reused, caseIds, evaluating: autoRun });
}
async function updateExecutionTarget(id: string, snapshot: Value, target: Value) {
    const context = requireCoreExperimentContext();
    const current = await read(id);
    const changes = { configSnapshotJson: JSON.stringify({ ...snapshot, executionTarget: target }) };
    const payload = { experiment_id: id, expected_revision: current.revision, changes };
    await context.rpc('update', { ...payload, operation_key: context.operationKey + ':execution-target', operation_request: payload });
}
export async function runCoreExperimentRoute(id: string): Promise<Response> {
    const context = requireCoreExperimentContext();
    const { experiment } = await read(id);
    const username = context.actor.username;
    if (experiment.scope === 'benchmark') {
        const { startBenchmarkExperiment } = await import('@/lib/benchmark/scheduler');
        const { defaultEvaluatorRuntimeConfigProvider } = await import('@/lib/benchmark/evaluator-runtime-config');
        const runtime = defaultEvaluatorRuntimeConfigProvider.snapshot();
        const request = context.request;
        const url = new URL(request.url);
        const host = request.headers.get('x-forwarded-host') || url.host;
        const protocol = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
        const prefix = String(process.env.NEXT_PUBLIC_URL_PREFIX || '').replace(/^\/?/, '/').replace(/\/$/, '');
        const publicCallbackOrigin = `${protocol}://${host}${prefix}`;
        const result = await startBenchmarkExperiment({ experimentId: id, user: username, publicCallbackOrigin, executorCallbackOrigin: runtime.executorCallbackBaseUrl || publicCallbackOrigin });
        if (!result)
            missing();
        if (result.completion)
            background(result.completion);
        if (!result.alreadyRunning)
            usage('experiment.run');
        return json({ status: result.status, runId: result.runId, ...(result.alreadyRunning ? { alreadyRunning: true } : {}) }, 202);
    }
    if (experiment.status === 'running')
        return json({ status: 'running', alreadyRunning: true });
    if (experiment.type === 'llm') {
        const { startComparisonRun } = await import('@/lib/engine/experiment/comparison-runner');
        const result = await startComparisonRun(id, username);
        if (!result)
            missing();
        if (result.completion)
            background(result.completion);
        if (!result.alreadyRunning)
            usage('experiment.run');
        return json({ status: result.status, ...(result.alreadyRunning ? { alreadyRunning: true } : {}) });
    }
    const snapshot = parse(experiment.configSnapshotJson);
    let body = context.body;
    const savedTarget = object(snapshot.executionTarget);
    if (!body.generateTrace && snapshot.traceSource === 'generate' && Object.keys(savedTarget).length)
        body = { ...body, traceSource: 'generate', fiOrchestrate: snapshot.fiOrchestrate === true, generateTrace: { ...savedTarget, agent: savedTarget.agent || snapshot.agentName, model: savedTarget.model || null, timeoutSeconds: Number(savedTarget.timeoutSeconds) || DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS } };
    const generate = object(body.generateTrace);
    const wantGenerate = body.traceSource === 'generate' || Boolean(body.generateTrace);
    const wantFi = body.fiOrchestrate === true;
    if (wantGenerate && !wantFi) {
        const cases = await collectTraceGenerationCases(id);
        if (!cases.length)
            return json({ error: '没有可生成 Trace 的 Case，未启动评估' }, 409);
        const workerId = String(generate.workerId || '').trim();
        const platform = String(generate.platform || body.platform || 'opencode').trim();
        const agent = String(generate.agent || experiment.agentName || '').trim();
        const savedOptions = savedTarget.workerId === workerId && savedTarget.platform === platform && savedTarget.agent === agent ? savedTarget.agentOptions : undefined;
        const resolved = await assertTraceGenerationTarget({ user: username, workerId, platform, agent, agentOptions: generate.agentOptions ?? savedOptions });
        let executionConcurrency: number;
        try {
            executionConcurrency = experiment.scope === 'skill-workbench' ? 1 : parseExecutionConcurrency(snapshot.executionConcurrency);
        }
        catch {
            return json({ error: '执行并发必须为正整数' }, 400);
        }
        if (executionConcurrency > 1) {
            const client = await prisma.reliabilityClient.findFirst({ where: { clientId: workerId, user: username }, select: { capabilitiesJson: true } });
            if (object(object(parse(client?.capabilitiesJson).components)['concurrent-execution/v1']).ready !== true)
                return json({ error: '执行并发大于 1 需要升级客户端' }, 400);
        }
        const timeoutSeconds = typeof generate.timeoutSeconds === 'number' ? generate.timeoutSeconds : DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS;
        const model = generate.model != null ? String(generate.model) : null;
        await updateExecutionTarget(id, snapshot, { ...savedTarget, workerId, platform, agent, model, timeoutSeconds, agentOptions: resolved.agentOptions, agentParameterDefinition: resolved.definition });
        const request: TraceGenerationRequest = { user: username, experimentId: id, workerId, platform, agent, agentOptions: resolved.agentOptions, model, timeoutSeconds, cases, executionConcurrency };
        const runId = await prepareCoreTraceRun(context, request);
        background(generateExperimentTraces(request, { reservedAttemptIds: Object.fromEntries(cases.map(row => [row.caseId, runId])) }));
        usage('experiment.run');
        return json({ status: 'running', awaitingTraceGeneration: true, traceGeneration: { total: cases.length } });
    }
    if (wantFi) {
        const cases = await collectFiCasesFromExperiment(id);
        if (!cases.length)
            return json({ error: '没有可生成 Trace 的 Case，未启动评估' }, 409);
        const request: FiOrchestrateRequest = { user: username, experimentId: id, platform: String(generate.platform || body.platform || 'opencode'), agent: String(generate.agent || experiment.agentName || 'default'), model: generate.model != null ? String(generate.model) : null, targetWorkerId: generate.workerId != null ? String(generate.workerId) : null, workspace: generate.workspace != null ? String(generate.workspace) : null, timeoutSeconds: typeof generate.timeoutSeconds === 'number' ? generate.timeoutSeconds : DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS, cases };
        await assertFiExecutionTarget(request);
        const prepared = await prepareCoreFiDispatch(context, request);
        background(orchestrateCoreFi(context, request, { reservedRunId: prepared.runId, reservedHandles: prepared.handles, reservedTargets: prepared.targets }));
        usage('experiment.run');
        return json({ status: 'running', awaitingFiSession: true, fiOrchestrate: prepared.result });
    }
    const result = await startExperimentRun(id, username);
    if (!result)
        missing();
    if (result.completion)
        background(result.completion);
    if (!result.alreadyRunning)
        usage('experiment.run');
    return json({ status: result.status, ...(result.alreadyRunning ? { alreadyRunning: true } : {}) });
}
export async function retryCoreExperimentResultRoute(id: string, resultId: string): Promise<Response> {
    const context = requireCoreExperimentContext();
    const { experiment } = await read(id);
    const result = experiment.cases.flatMap(row => row.results || []).find(row => row.id === resultId);
    if (!result)
        return json({ error: 'result not found' }, 404);
    if (result.evaluatorId?.startsWith('benchmark:')){
        const {retryCoreBenchmarkEvaluation}=await import('@/lib/benchmark/core-retry');const status=await retryCoreBenchmarkEvaluation({experimentId:id,resultId,user:context.actor.username});usage('experiment.retry');return json(status);
    }
    const status = await retryResultRow(id, resultId, context.actor.username);
    if (!status)
        return json({ error: 'result not found' }, 404);
    usage('experiment.retry');
    return json({ status });
}
export async function retryCoreExperimentCaseRoute(id: string, caseId: string): Promise<Response> {
    const context = requireCoreExperimentContext();
    const key = JSON.stringify([context.actor.workspace, context.actor.principal, id, caseId]);
    const symbol = Symbol.for('agent-insight.storage-core.case-retries');
    const state = globalThis as unknown as Record<symbol, Set<string>>;
    const active = state[symbol] ||= new Set<string>();
    if (active.has(key))
        return json({ error: '该 Case 正在重试', code: 'case_retry_in_progress' }, 409);
    active.add(key);
    let backgroundOwnsLock = false;
    const launch = (completion: Promise<unknown>) => { backgroundOwnsLock = true; background(completion.finally(() => active.delete(key))); };
    try {
        const { experiment } = await read(id);
        const row = experiment.cases.find(item => item.id === caseId);
        if (!row)
            return json({ error: 'case not found' }, 404);
        if (row.results?.some(result => ['pending', 'running'].includes(result.status)))
            return json({ error: '该 Case 正在评估' }, 409);
        if (experiment.scope === 'benchmark') {
            const {retryCoreBenchmarkCase} = await import('@/lib/benchmark/core-retry');
            const started = await retryCoreBenchmarkCase({experimentId:id,caseId,user:context.actor.username});
            launch(started.completion);
            usage('experiment.retry');
            return json({kind:'benchmark',status:started.status,runId:started.runId},202);
        }
        const attempts = row.traceAttempts || [];
        const latest = attempts[0];
        if (latest && ['queued', 'dispatching', 'running', 'waiting_trace', 'retry_wait'].includes(String(latest.status)))
            return json({ error: '该 Case 正在生成 Trace' }, 409);
        if (latest?.kind === 'fi' || row.fiRunId) {
            const plan = await context.rpc('runplan', { experiment_id: id, ...(latest?.runId ? { run_id: latest.runId } : {}) }) as {
                runplan: {
                    config?: {
                        execution_request?: FiOrchestrateRequest & {
                            kind?: string;
                        };
                    };
                };
            };
            const frozen = plan.runplan?.config?.execution_request;
            if (!frozen || frozen.kind !== 'fi')
                throw Object.assign(new Error('Frozen FI execution request is unavailable'), { status: 409 });
            const spec = frozen.cases.find(item => item.caseId === caseId);
            if (!spec)
                return json({ error: '找不到上次 Trace 生成配置' }, 409);
            const request = { ...frozen, user: context.actor.username, experimentId: id, cases: [{ ...spec, input: row.input }] };
            const prepared = await prepareCoreFiDispatch(context, request, { forceNewTrace: true, ...(latest?.id ? { retryFromAttemptId: String(latest.id) } : {}) });
            launch(orchestrateCoreFi(context, request, { reservedRunId: prepared.runId, reservedHandles: prepared.handles, reservedTargets: prepared.targets }));
            return json({ kind: 'trace', status: 'running' });
        }
        const genericRequest = latest || row.traceGenerationCommandId ? await loadTraceGenerationRetryRequest({ user: context.actor.username, experimentId: id, caseId }) : null;
        if (genericRequest) {
            const runId = await prepareCoreTraceRun(context, genericRequest, true);
            launch(generateExperimentTraces(genericRequest, { forceNewTrace: true, reservedAttemptIds: { [caseId]: runId } }));
            return json({ kind: 'trace', status: 'running', attemptId: runId });
        }
        const failed = row.results?.filter(result => result.status === 'failed') || [];
        if (!failed.length)
            return json({ error: '该 Case 没有可重试的失败项' }, 409);
        const statuses = [];
        for (const result of failed)
            statuses.push(await retryResultRow(id, result.id, context.actor.username));
        return json({ kind: 'evaluation', status: statuses.every(status => status === 'done') ? 'done' : 'failed' });
    }
    finally {
        if (!backgroundOwnsLock)
            active.delete(key);
    }
}
