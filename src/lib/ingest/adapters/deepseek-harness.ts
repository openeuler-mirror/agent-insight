import { extractSkillsWithVersionsFromOpencodeSession } from '@/lib/shared/interaction-utils';
import type { FrameworkAdapter } from './types';

export const deepSeekHarnessAdapter: FrameworkAdapter = {
  descriptor: {
    id: 'deepseek-harness',
    aliases: ['dsh'],
    label: 'DeepSeek Harness',
    onboard: 'plugin',
    platform: 'deepseek-harness',
  },
  capabilities: {
    skills: true,
    subagentTree: true,
    skillScope: 'agent-tree',
  },
  sessionMergeStrategy: 'snapshot-replace',
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
};
