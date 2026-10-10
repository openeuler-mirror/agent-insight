export const DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS = 600;
export const TRIGGER_STARTUP_TIMEOUT_SECONDS = 120;
export const MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS = 30;
export const MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS = 3_600;

export function isValidExperimentAgentTimeoutSeconds(value: number): boolean {
  return Number.isInteger(value)
    && value >= MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS
    && value <= MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS;
}
