import { extractSkillsWithVersionsFromOpencodeSession } from '@/lib/shared/interaction-utils';
import type { FrameworkAdapter } from './types';

export const llamaIndexAdapter: FrameworkAdapter = {
  descriptor: {
    id: 'llamaindex',
    aliases: ['llama-index'],
    label: 'LlamaIndex',
    onboard: 'plugin',
    platform: 'llamaindex',
  },
  capabilities: {
    skills: true,
    subagentTree: true,
  },
  // The OTel consumer re-aggregates the complete session spool on every pass.
  // Replacing the snapshot prevents corrected or disappeared spans from being
  // retained forever by the generic monotonic interaction merge.
  sessionMergeStrategy: 'snapshot-replace',
  extractSkills(normalized) {
    return extractSkillsWithVersionsFromOpencodeSession(
      normalized.map((interaction) => ({ responseMessage: interaction })),
    );
  },
};
