export function canonicalExperimentAgentName(platform: string, agent: string): string {
  const normalizedPlatform = platform.trim().toLowerCase();
  const normalizedAgent = agent.trim();
  if (normalizedPlatform === 'xiaoo' && normalizedAgent.toLowerCase() === 'defaultagent') {
    return 'xiaoo';
  }
  if (['pi-mcts', 'xiao-mcts'].includes(normalizedPlatform) && normalizedAgent.toLowerCase() === normalizedPlatform) {
    return 'mcts-coordinator';
  }
  return normalizedAgent;
}
