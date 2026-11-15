import { newTaskKey, newRunId } from '@/lib/fault-injection/store';
import { createFiCaseTask, findFiRunByKey, cancelFiExecution, isCoreFiBusinessTraceReady, assertFiExecutionTarget, type FiOrchestrateRequest, type FiOrchestrateResult } from '@/lib/engine/experiment/fi-orchestrate';
import { prepareCoreExperimentStart } from './experiment-assets';
import { activateExperimentWork, type ExperimentWorkHandle } from './experiment-worker';
import type { CoreExperimentContext } from './experiments';
import {submitCoreExecutionReceipt,isCoreDeliveryUncertain} from './execution-delivery';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type CleanupTarget = {
    kind: 'ordinary' | 'fi';
    runId: string;
    clientId?: string | null;
    fiTaskKey?: string;
};
type FiWork = {
    cleanup_target?: CleanupTarget;
    execution_request: FiOrchestrateRequest;
    raw_case: {
        id: string;
        input: string;
        faultInjectionType?: string;
    };
    checkpoint: {
        command_id?: string;
        fi_task_key?: string;
        fi_run_id?: string;
        cleanup_confirmed?: boolean;
        cleanup_required?: boolean;
    };
    cleanup_required?: boolean;
};
async function stopExternalTarget(context: CoreExperimentContext, target: CleanupTarget) {
    if (target.kind === 'fi')
        return cancelFiExecution(context.actor.username, target.runId);
    if (target.kind === 'ordinary' && target.clientId) {
        const { cancelTraceGenerationCommand } = await import('@/lib/engine/experiment/trace-generation');
        return cancelTraceGenerationCommand(context.actor.username, target.clientId, target.runId);
    }
    throw Object.assign(new Error('Previous execution cleanup target is unavailable'), { status: 409 });
}
export async function runCoreFiWork(original: ExperimentWorkHandle, context: CoreExperimentContext, prestartedTarget?: CleanupTarget): Promise<{
    ready: boolean;
    taskId?: string;
    runId?: string;
    fault?: string;
}> {
    let handle = { ...original };
    let runId: string | undefined;
    let started = false;
    let cleanupUncertain = Boolean(prestartedTarget);
    let externalTarget: CleanupTarget | undefined = prestartedTarget;
    let heartbeat: Promise<void> | undefined;
    const controller = new AbortController();
    const renew = () => heartbeat ||= context.rpc('renew', { ...handle, lease_ms: 30000 }).then(() => { }, error => controller.abort(error)).finally(() => { heartbeat = undefined; });
    const timer = setInterval(() => { void renew(); }, 500);
    timer.unref?.();
    const mutation = (action: string, values: Record<string, unknown>) => { const payload = { ...handle, ...values, ...(action === 'checkpoint' ? { checkpoint: { ...(values.checkpoint as Record<string, unknown>), stage: values.stage } } : {}) }; const key=`fi:${handle.attempt_id}:${handle.fence}:${action}:${String(values.command_id || values.trace_id || '')}:${String(values.stage || '')}`;return action==='execute_complete'?submitCoreExecutionReceipt(context,handle,values,key,payload):context.rpc(action, { ...payload, operation_key:key, operation_request: payload }); };
    try {
        const work = await context.rpc('load_work', { ...handle }) as FiWork;
        cleanupUncertain = Boolean(prestartedTarget || work.cleanup_required || work.checkpoint.cleanup_required);
        const request = { ...work.execution_request, user: context.actor.username, experimentId: handle.experiment_id };
        const spec = request.cases.find(row => row.caseId === handle.case_id);
        if (!spec)
            throw Error('Frozen FI specification is unavailable');
        const item = { caseId: handle.case_id, input: work.raw_case.input, fault: spec.fault, submode: spec.submode };
        runId = work.checkpoint.fi_run_id || newRunId();
        let taskKey = work.checkpoint.fi_task_key || newTaskKey();
        if (work.cleanup_required || work.checkpoint.cleanup_required) {
            externalTarget = work.cleanup_target;
            if (!work.cleanup_target)
                throw Object.assign(new Error('Previous execution cleanup target is unavailable'), { status: 409 });
            await stopExternalTarget(context, work.cleanup_target);
            cleanupUncertain = false;
            externalTarget = undefined;
            const next = await mutation('checkpoint', { expected_revision: handle.checkpoint_revision, command_id: work.checkpoint.command_id, stage: 'cleanup_confirmed', checkpoint: { ...work.checkpoint, cleanup_confirmed: true } }) as ExperimentWorkHandle;
            handle = { ...handle, ...next };
            runId = newRunId();
            taskKey = newTaskKey();
            work.checkpoint = {};
        }
        if (work.checkpoint.cleanup_confirmed) {
            runId = newRunId();
            taskKey = newTaskKey();
            work.checkpoint = {};
        }
        if (!work.checkpoint.fi_run_id) {
            const next = await mutation('checkpoint', { expected_revision: handle.checkpoint_revision, command_id: `fi:${runId}`, stage: 'dispatching', checkpoint: { command_id: `fi:${runId}`, fi_run_id: runId, fi_task_key: taskKey, status: 'dispatching', platform: request.platform, agent: request.agent, model: request.model, timeoutSeconds: request.timeoutSeconds || 180 } }) as ExperimentWorkHandle;
            handle = { ...handle, ...next };
        }
        controller.signal.throwIfAborted();
        await context.rpc('check_work', { ...handle });
        externalTarget = { kind: 'fi', runId, clientId: request.targetWorkerId, fiTaskKey: taskKey };
        cleanupUncertain = true;
        const task = await createFiCaseTask(request, item, { taskKey, runIds: [runId] });
        started = true;
        const deadline = Date.now() + ((request.timeoutSeconds || 180) + 240) * 1000;
        let observedTrace: string | undefined;
        for (;;) {
            controller.signal.throwIfAborted();
            const run = await findFiRunByKey(runId);
            if (!run || run.user !== context.actor.username)
                throw Error('FI execution identity is unavailable');
            if (run.sessionTaskId) {
                if (observedTrace !== run.sessionTaskId) {
                    const waiting = await mutation('checkpoint', { expected_revision: handle.checkpoint_revision, command_id: `fi:${runId}`, stage: 'waiting_trace', checkpoint: { command_id: `fi:${runId}`, fi_run_id: runId, fi_task_key: taskKey, observed_trace_id: run.sessionTaskId, status: 'waiting_trace' } }) as ExperimentWorkHandle;
                    handle = { ...handle, ...waiting };
                    observedTrace = run.sessionTaskId;
                }
                if (!await isCoreFiBusinessTraceReady({ sessionTaskId: run.sessionTaskId, platform: request.platform, agent: request.agent })) {
                    if (Date.now() >= deadline)
                        throw Object.assign(new Error('FI业务Trace尚未完成'), { code: 'TRACE_INGEST_TIMEOUT' });
                    await sleep(1000);
                    continue;
                }
                try {
                    await mutation('execute_complete', { trace_id: run.sessionTaskId, fi_run_id: runId, fi_task_id: task.task.id, fault_injection_type: item.fault });
                    return { ready: true, taskId: task.task.id, runId, fault: item.fault };
                }
                catch (error) {
                    if(isCoreDeliveryUncertain(error))throw error;
                    if (![404, 422, 503].includes((error as {
                        status?: number;
                    }).status || 0))
                        throw error;
                }
            }
            if (['failed', 'stopped'].includes(run.status) && !run.sessionTaskId)
                throw Object.assign(new Error(run.error || 'FI执行没有产生可用业务Trace'), { code: 'FI_TRACE_UNAVAILABLE' });
            if (Date.now() >= deadline)
                throw Object.assign(new Error('FI业务Trace等待超时'), { code: 'TRACE_INGEST_TIMEOUT' });
            await sleep(1000);
        }
    }
    catch (error) {
        if(isCoreDeliveryUncertain(error))throw error;
        let failure = error as {
            code?: string;
            message?: string;
        };
        let confirmed = !started && !cleanupUncertain;
        if (externalTarget) {
            try {
                await stopExternalTarget(context, externalTarget);
                confirmed = true;
            }
            catch (cleanup) {
                failure = cleanup as typeof failure;
                confirmed = false;
            }
        }
        try {
            await mutation('execute_fail', { error: { code: failure.code || 'FI_EXECUTION_FAILED', message: failure.message || 'FI execution failed' }, cleanup_confirmed: confirmed, retryable: false });
        }
        catch (write) {
            if (![409, 410].includes((write as {
                status?: number;
            }).status || 0))
                throw write;
        }
        return { ready: false, runId };
    }
    finally {
        clearInterval(timer);
        if (heartbeat)
            await heartbeat;
    }
}
export async function prepareCoreFiRun(context: CoreExperimentContext, request: FiOrchestrateRequest, options: {
    forceNewTrace?: boolean;
    retryFromAttemptId?: string;
} = {}): Promise<string> {
    if (!request.cases.length)
        throw Object.assign(new Error('FI RunPlan requires Cases'), { status: 409 });
    await assertFiExecutionTarget({ ...request, user: context.actor.username });
    const prepared = await prepareCoreExperimentStart(context, request.experimentId, { caseIds: request.cases.map(row => row.caseId) });
    const { operation_key: _key, operation_request: _request, ...frozen } = prepared.payload;
    const payload = { ...frozen, ...(options.forceNewTrace ? { force_new_trace: true } : {}), ...(options.retryFromAttemptId ? { retry_from_attempt_id: options.retryFromAttemptId } : {}), execution_request: { kind: 'fi', experimentId: request.experimentId, platform: request.platform, agent: request.agent, model: request.model || null, targetWorkerId: request.targetWorkerId, workspace: request.workspace, timeoutSeconds: request.timeoutSeconds, cases: request.cases.map(row => ({ caseId: row.caseId, fault: row.fault, submode: row.submode })) } };
    const started = await context.rpc('execute_start', { ...payload, operation_key: `${context.operationKey}:fi-start`, operation_request: payload }) as {
        run_id: string;
    };
    return started.run_id;
}
export async function prepareCoreFiDispatch(context: CoreExperimentContext, request: FiOrchestrateRequest, options: {
    forceNewTrace?: boolean;
    retryFromAttemptId?: string;
} = {}): Promise<{
    runId: string;
    handles: ExperimentWorkHandle[];
    targets: Record<string, CleanupTarget>;
    result: FiOrchestrateResult;
}> {
    const runId = await prepareCoreFiRun(context, request, options);
    const handles: ExperimentWorkHandle[] = [];
    const targets: Record<string, CleanupTarget> = {};
    const result: FiOrchestrateResult = { skipped: false, taskIds: [], runIds: [], caseFaults: [] };
    const prepared: Array<{
        handle: ExperimentWorkHandle;
        target?: CleanupTarget;
        cleanupUncertain?: boolean;
    }> = [];
    let renewing = false;
    let leaseError: unknown;
    const timer = setInterval(() => {
        if (renewing)
            return;
        renewing = true;
        void Promise.all(handles.map(handle => context.rpc('renew', { ...handle, lease_ms: 30000 }))).catch(error => { leaseError = error; }).finally(() => { renewing = false; });
    }, 500);
    timer.unref?.();
    try {
        for (const item of request.cases) {
            if (leaseError)
                throw leaseError;
            let handle = await context.rpc('claim', { phase: 'execute', experiment_id: request.experimentId, run_id: runId, case_id: item.caseId, worker_id: `fi:${newRunId()}`, lease_ms: 30000 }) as ExperimentWorkHandle | null;
            if (!handle)
                throw Object.assign(new Error('FI execution was already claimed or superseded'), { status: 409 });
            const entry: {
                handle: ExperimentWorkHandle;
                target?: CleanupTarget;
                cleanupUncertain?: boolean;
            } = { handle };
            prepared.push(entry);
            handles.push(handle);
            const work = await context.rpc('load_work', { ...handle }) as FiWork;
            entry.cleanupUncertain = Boolean(work.cleanup_required || work.checkpoint.cleanup_required);
            if (work.cleanup_required || work.checkpoint.cleanup_required) {
                if (!work.cleanup_target)
                    throw Object.assign(new Error('Previous execution cleanup target is unavailable'), { status: 409 });
                entry.target = work.cleanup_target;
                await stopExternalTarget(context, work.cleanup_target);
                const payload = { ...handle, expected_revision: handle.checkpoint_revision, command_id: work.checkpoint.command_id, stage: 'cleanup_confirmed', checkpoint: { ...work.checkpoint, cleanup_confirmed: true, stage: 'cleanup_confirmed' } };
                handle = await context.rpc('checkpoint', { ...payload, operation_key: `fi:${handle.attempt_id}:${handle.fence}:checkpoint:${work.checkpoint.command_id}:cleanup_confirmed`, operation_request: payload }) as ExperimentWorkHandle;
                entry.handle = handle;
                handles[handles.length - 1] = handle;
                work.checkpoint = {};
            }
            if (work.checkpoint.cleanup_confirmed)
                work.checkpoint = {};
            const frozen = { ...work.execution_request, user: context.actor.username, experimentId: handle.experiment_id };
            const spec = frozen.cases.find(row => row.caseId === handle!.case_id);
            if (!spec)
                throw Object.assign(new Error('Frozen FI Case is unavailable'), { status: 409 });
            const physicalRunId = work.checkpoint.fi_run_id || newRunId();
            const taskKey = work.checkpoint.fi_task_key || newTaskKey();
            entry.target = { kind: 'fi', runId: physicalRunId, clientId: frozen.targetWorkerId, fiTaskKey: taskKey };
            if (!work.checkpoint.fi_run_id) {
                const payload = { ...handle, expected_revision: handle.checkpoint_revision, command_id: `fi:${physicalRunId}`, stage: 'dispatching', checkpoint: { command_id: `fi:${physicalRunId}`, fi_run_id: physicalRunId, fi_task_key: taskKey, status: 'dispatching', stage: 'dispatching', platform: frozen.platform, agent: frozen.agent, model: frozen.model, timeoutSeconds: frozen.timeoutSeconds || 180 } };
                handle = await context.rpc('checkpoint', { ...payload, operation_key: `fi:${handle.attempt_id}:${handle.fence}:checkpoint:fi:${physicalRunId}:dispatching`, operation_request: payload }) as ExperimentWorkHandle;
                entry.handle = handle;
                handles[handles.length - 1] = handle;
            }
            if (leaseError)
                throw leaseError;
            await context.rpc('check_work', { ...handle });
            const task = await createFiCaseTask(frozen, { caseId: handle.case_id, input: work.raw_case.input, fault: spec.fault, submode: spec.submode }, { taskKey, runIds: [physicalRunId] });
            targets[handle.attempt_id] = entry.target;
            result.taskIds.push(task.task.id);
            result.runIds.push(physicalRunId);
            result.caseFaults.push({ caseId: handle.case_id, fault: spec.fault, taskId: task.task.id, runId: physicalRunId });
        }
        if (leaseError)
            throw leaseError;
        return { runId, handles, targets, result };
    }
    catch (error) {
        for (const entry of prepared) {
            let confirmed = !entry.target && !entry.cleanupUncertain;
            if (entry.target) {
                try {
                    await stopExternalTarget(context, entry.target);
                    confirmed = true;
                }
                catch {
                    confirmed = false;
                }
            }
            const payload = { ...entry.handle, error: { code: 'FI_DISPATCH_FAILED', message: error instanceof Error ? error.message : 'FI dispatch failed' }, cleanup_confirmed: confirmed, retryable: false };
            try {
                await context.rpc('execute_fail', { ...payload, operation_key: `fi:${entry.handle.attempt_id}:${entry.handle.fence}:prepare-failed`, operation_request: payload });
            }
            catch (failure) {
                if (![409, 410].includes((failure as {
                    status?: number;
                }).status || 0))
                    throw failure;
            }
        }
        throw error;
    }
    finally {
        clearInterval(timer);
    }
}
export async function orchestrateCoreFi(context: CoreExperimentContext, request: FiOrchestrateRequest, options: {
    reservedRunId?: string;
    reservedHandles?: ExperimentWorkHandle[];
    reservedTargets?: Record<string, CleanupTarget>;
} = {}): Promise<FiOrchestrateResult> {
    if (!request.cases.length)
        return { skipped: true, reason: 'no_fi_cases', taskIds: [], runIds: [], caseFaults: [] };
    const runId = options.reservedRunId || await prepareCoreFiRun(context, request);
    const result: FiOrchestrateResult = { skipped: false, taskIds: [], runIds: [], caseFaults: [] };
    const waiting = new Set(options.reservedHandles || []);
    let renewal: Promise<void> | undefined;
    const timer = waiting.size ? setInterval(() => {
        if (renewal)
            return;
        renewal = Promise.all([...waiting].map(handle => context.rpc('renew', { ...handle, lease_ms: 30000 }))).then(() => { }).finally(() => { renewal = undefined; });
        void renewal.catch(() => { });
    }, 10000) : undefined;
    timer?.unref?.();
    try {
        for (const item of request.cases) {
            const handle = options.reservedHandles ? options.reservedHandles.find(handle => handle.run_id === runId && handle.case_id === item.caseId) : await context.rpc('claim', { phase: 'execute', experiment_id: request.experimentId, run_id: runId, case_id: item.caseId, worker_id: `fi:${newRunId()}`, lease_ms: 30000 }) as ExperimentWorkHandle | null;
            if (!handle)
                continue;
            waiting.delete(handle);
            const outcome = await runCoreFiWork(handle, context, options.reservedTargets?.[handle.attempt_id]);
            if (outcome.taskId)
                result.taskIds.push(outcome.taskId);
            if (outcome.runId)
                result.runIds.push(outcome.runId);
            result.caseFaults.push({ caseId: item.caseId, fault: item.fault, taskId: outcome.taskId, runId: outcome.runId });
        }
        await activateExperimentWork(context, request.experimentId);
        return result;
    }
    finally {
        if (timer)
            clearInterval(timer);
        if (renewal)
            await renewal.catch(() => { });
    }
}
