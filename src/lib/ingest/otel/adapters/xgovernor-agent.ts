/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { aggregatePiAgentTraceEvents } from './pi-agent';
import type { OtelTraceAdapter } from './types';

export const xgovernorAgentOtelTraceAdapter: OtelTraceAdapter = {
  id: 'xgovernor-agent',
  matches: events => events.some(event => event.sessionId.startsWith('xgovernor:') && Boolean(event.attributes?.['xgovernor.runtime_id'])),
  aggregate(sessionId, events) {
    const framework = String(events[0]?.attributes?.['agent.insight.framework'] || events[0]?.serviceName || '');
    if (!/^[a-z][a-z0-9-]*$/.test(framework) || events.some(event => String(event.attributes?.['agent.insight.framework'] || event.serviceName) !== framework)) return null;
    const record = aggregatePiAgentTraceEvents(sessionId, events);
    if (!record) return null;
    return {
      ...record, framework, label: framework, agent: framework, agentName: framework, agents: [framework],
      interactions: record.interactions?.map((interaction: Record<string, unknown>) => ({ ...interaction, agent: framework })),
      failures: record.failures?.map(failure => ({ ...failure, failure_type: 'agent-process-exit', description: 'xGovernor Agent 执行未正常完成', recovery: '查看本次 Agent 与工具执行轨迹。' })),
    };
  },
};
