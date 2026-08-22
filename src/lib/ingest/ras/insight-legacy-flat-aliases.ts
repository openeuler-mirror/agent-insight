/**
 * Frozen IF-N10 overrideDiff aliases. New domains do not add entries here.
 */
export const INSIGHT_LEGACY_FLAT_ALIASES: Record<string, string> = {
  'textLoop.enabled': 'detectors.llm_thinking_loop.enabled',
  'textLoop.detectionStartChars': 'detectors.llm_thinking_loop.detection_start_chars',
  'textLoop.windowMaxChars': 'detectors.llm_thinking_loop.window_max_chars',
  'textLoop.repeatThreshold': 'detectors.llm_thinking_loop.loop_repeat_threshold',
  'toolRepeat.enabled': 'detectors.repeat_tool.enabled',
  'toolRepeat.warningThreshold': 'detectors.repeat_tool.warning_threshold',
  'toolRepeat.criticalThreshold': 'detectors.repeat_tool.critical_threshold',
  notifyUserOnWarning: 'recovery.notify_user_on_warning',
}
