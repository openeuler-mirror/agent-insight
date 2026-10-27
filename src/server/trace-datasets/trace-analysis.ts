import { normalizeSource, type Source, type NormalizedUnit, type Exclusion } from './normalizer';

export function normalizeSourceUnits(source: Source): { units: NormalizedUnit[]; exclusions: Exclusion[] } {
  const starts = source.events.flatMap((event, index) => event.role === 'user' ? [index] : []);
  const reject = (code: string) => ({ units: [], exclusions: [{ code, turnCount: starts.length }] });
  if (!source.completed || source.failed) return reject('EXECUTION_NOT_SUCCESSFUL');
  if (source.isSubagent || !starts.length) return reject('INPUT_UNATTRIBUTED');
  const units: NormalizedUnit[] = [], exclusions: Exclusion[] = [];
  for (const [turn, start] of starts.entries()) {
    const next = starts[turn + 1];
    const events = source.events.slice(start, next);
    const user = events[0];
    const traceIds = new Set(events.filter(e => e.role === 'assistant' && e.traceId).map(e => e.traceId));
    const nextTime = next === undefined ? NaN : Date.parse(source.events[next].timestamp || '');
    let reason: string | undefined;
    if (traceIds.size > 1 || (user.traceId && [...traceIds].some(id => id !== user.traceId))) reason = 'INPUT_UNATTRIBUTED';
    else if (events.some(e => e.role === 'subagent' || e.subagent)) reason = 'INPUT_UNATTRIBUTED';
    else if (Number.isFinite(nextTime) && events.some(e => e !== user && (Date.parse(e.timestamp || '') >= nextTime || Date.parse(e.completedAt || '') > nextTime))) reason = 'ANSWER_UNATTRIBUTED';
    else {
      const result = normalizeSource({
        ...source, events,
        query: turn === 0 ? source.query : user.content || '',
        finalResult: next === undefined ? source.finalResult : '',
      });
      if (result.unit) units.push(result.unit);
      else reason = result.reason;
    }
    if (reason) exclusions.push({ code: reason, turnCount: 1 });
  }
  return { units, exclusions };
}
