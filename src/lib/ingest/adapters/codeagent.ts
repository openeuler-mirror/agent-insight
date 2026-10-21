import { extractSkillsWithVersionsFromOpencodeSession } from '@/lib/shared/interaction-utils';
import type { FrameworkAdapter } from './types';

export const codeagentAdapter: FrameworkAdapter = {
  descriptor: {
    id: 'codeagent',
    label: 'CodeAgent',
    onboard: 'env',
    platform: 'codeagent',
  },
  capabilities: {
    skills: true,
    subagentTree: true,
    skillScope: 'agent-tree',
  },
  sessionMergeStrategy: 'snapshot-replace',
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
  isPlaceholderQuery: (query) => /^CodeAgent Session [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query),
};
