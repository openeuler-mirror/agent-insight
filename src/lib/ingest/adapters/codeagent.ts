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
};
