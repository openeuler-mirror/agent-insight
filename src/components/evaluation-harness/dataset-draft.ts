import type {EvalCase} from '@/lib/evaluation-harness/domain';
export type CaseDrafts = Record<string, EvalCase | null>;
export function applyCaseDrafts(base: EvalCase[], drafts: CaseDrafts): EvalCase[] {
  return base.flatMap(c => Object.hasOwn(drafts,c.id) ? drafts[c.id] ? [drafts[c.id]!] : [] : [c])
    .concat(Object.values(drafts).filter((c): c is EvalCase => !!c && !base.some(b=>b.id===c.id)));
}
export function updateCaseDraft(base: EvalCase[], drafts: CaseDrafts, id: string, value: EvalCase | null): CaseDrafts {
  const next={...drafts};
  if (JSON.stringify(base.find(c=>c.id===id)) === JSON.stringify(value) || (!value && !base.some(c=>c.id===id))) delete next[id];
  else next[id]=value;
  return next;
}
export function caseSummary(c: EvalCase) {
  return {input:c.turns[0]?.input || '',output:c.turns.at(-1)?.expectedOutput || ''};
}
