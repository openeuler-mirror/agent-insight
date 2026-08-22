import path from 'node:path';

import { getExistingInsightDir } from '@/lib/agent-insight-paths';

export {
  appendOtelTraceEvents,
  getOtelTraceSpoolDir,
  listOtelTraceSpoolFiles,
  readOtelTraceEventsForSession,
} from '@/lib/ingest/claude-otel/spool';

export function getActrailOtelTraceSpoolDir(): string {
  return process.env.AGENT_INSIGHT_ACTRAIL_OTEL_SPOOL_DIR ||
    path.join(getExistingInsightDir(), 'otel_data', 'actrail');
}
