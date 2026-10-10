import { extractSkillsWithVersionsFromOpencodeSession } from '@/lib/shared/interaction-utils';
import type { FrameworkAdapter } from './types';

export const actrailAdapter: FrameworkAdapter = {
  descriptor: {
    id: 'actrail',
    label: 'AcTrail',
    onboard: 'plugin',
    platform: 'actrail',
  },
  capabilities: {
    skills: true,
    subagentTree: true,
  },
  sessionMergeStrategy: 'snapshot-replace',
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
};
