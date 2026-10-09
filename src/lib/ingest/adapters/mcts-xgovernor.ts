import type { FrameworkAdapter } from './types';

export const mctsXgovernorAdapter: FrameworkAdapter = {
  descriptor: {
    id: 'mcts-xgovernor',
    label: 'MCTS xGovernor',
    onboard: 'plugin',
    platform: 'mcts-xgovernor',
  },
  capabilities: {
    subagentTree: true,
    allowSnapshotShrink: true,
  },
  sessionMergeStrategy: 'snapshot-replace',
};
