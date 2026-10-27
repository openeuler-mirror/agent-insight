export function createProgressSummary(write: (fields: Record<string, unknown>) => void, now = Date.now) {
  let lastLoggedAt: number | undefined;
  let firstAt = 0, lastAt = 0, ticks = 0, discovered = 0, parseErrors = 0;
  let latest: Record<string, unknown> = {};
  const flush = () => {
    if (!ticks) return;
    try { write({ ...latest, ticks, discovered, parseErrors, firstAt: new Date(firstAt).toISOString(), lastAt: new Date(lastAt).toISOString() }); } catch {}
    lastLoggedAt = now();
    ticks = discovered = parseErrors = 0;
  };
  const flushIfDue = () => { if (lastLoggedAt === undefined || now() - lastLoggedAt >= 60_000) flush(); };
  return {
    record(fields: Record<string, unknown>) {
      if (!ticks) firstAt = now();
      lastAt = now(); ticks++;
      discovered += Number(fields.discovered) || 0;
      parseErrors += Number(fields.parseErrors) || 0;
      latest = fields;
      flushIfDue();
    },
    flushIfDue, flush,
  };
}
