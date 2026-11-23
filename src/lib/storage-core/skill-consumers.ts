import { readTraceExecution } from './evidence';

export async function readCoreSkillOutputs(request: Request, executions: {id: string; taskId: string}[]) {
    const rows = [...new Map(executions.map(row => [row.id, row])).values()];
    const outputs = new Map<string, {agentId: string | null; finalResult: string | null}>();
    let next = 0;
    let outputBytes = 0;
    await Promise.all(Array.from({length: Math.min(4, rows.length)}, async () => {
        for (;;) {
            const row = rows[next++];
            if (!row) return;
            const {evidence} = await readTraceExecution(request, {executionId: row.id});
            if (evidence.execution.id !== row.id || evidence.execution.taskId !== row.taskId) {
                throw Object.assign(new Error('Skill execution identity changed'), {status: 409});
            }
            const finalResult = evidence.execution.finalResult ?? null;
            outputBytes += Buffer.byteLength(finalResult ?? '', 'utf8');
            if (outputBytes > 128 * 1024 * 1024) {
                throw Object.assign(new Error('Skill execution output exceeds byte budget'), {status: 413});
            }
            outputs.set(row.id, {
                agentId: typeof evidence.execution.agentId === 'string' ? evidence.execution.agentId : null,
                finalResult,
            });
        }
    }));
    return outputs;
}
