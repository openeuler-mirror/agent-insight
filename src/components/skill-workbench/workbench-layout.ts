export const COPILOT_DEFAULT_WIDTH = 410;
export const COPILOT_MIN_WIDTH = 320;
export const WORKSPACE_MIN_WIDTH = 640;
export const WORKBENCH_DIVIDER_WIDTH = 8;

export function clampCopilotWidth(requestedWidth: number, availableWidth: number): number {
  const requested = Number.isFinite(requestedWidth) ? requestedWidth : COPILOT_DEFAULT_WIDTH;
  const available = Number.isFinite(availableWidth)
    ? availableWidth
    : COPILOT_DEFAULT_WIDTH + WORKSPACE_MIN_WIDTH + WORKBENCH_DIVIDER_WIDTH;
  const maxWidth = Math.max(
    COPILOT_MIN_WIDTH,
    available - WORKSPACE_MIN_WIDTH - WORKBENCH_DIVIDER_WIDTH,
  );
  return Math.min(maxWidth, Math.max(COPILOT_MIN_WIDTH, requested));
}
