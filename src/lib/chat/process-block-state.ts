export type ProcessOutcome = 'complete' | 'error';
export type ProcessState = 'running' | 'complete' | 'error';

interface ProcessBlockLike {
  kind?: string;
  status?: string;
  done?: boolean;
}

export function resolveProcessState(status: string | undefined, parentStatus?: string): ProcessState {
  const value = status || '';
  if (/(error|failed|cancel|incomplete|timeout)/i.test(value)) return 'error';
  if (!/(running|pending|started)/i.test(value)) return 'complete';
  if (/(failed|cancelled)/i.test(parentStatus || '')) return 'error';
  if (/(done|complete|completed|success|passed)/i.test(parentStatus || '')) return 'complete';
  return 'running';
}

export function settleProcessBlocks<T extends ProcessBlockLike>(
  blocks: readonly T[],
  outcome: ProcessOutcome,
): T[] {
  return blocks.map((block) => {
    if (block.kind === 'thinking') {
      const state = resolveProcessState(block.status);
      const unfinished = state === 'running' || (!block.status && block.done !== true);
      if (!unfinished) return block;
      return {
        ...block,
        done: true,
        status: outcome === 'complete' ? 'done' : 'error',
      } as T;
    }
    if (block.kind === 'tool' && resolveProcessState(block.status) === 'running') {
      return {
        ...block,
        status: outcome === 'complete' ? 'complete' : 'error',
      } as T;
    }
    return block;
  });
}
