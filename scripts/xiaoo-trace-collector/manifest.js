const path = require('path')

const RUNTIME_FILES = [
  'hooker_main.py',
  'otel_trace.py',
  'otel_spans.py',
  'otlp_http.py',
  'session_ids.py',
]

const HOOKS = [
  ['insight_xiaoo_chat_received', '*.Chat.message.received', 'chat_received'],
  ['insight_xiaoo_tool_post', '*.Tool.*.post', 'tool_post'],
  ['insight_xiaoo_llm_complete_post', '*.Llm.complete.post', 'llm_complete_post'],
  ['insight_xiaoo_session_state', '*.Session.lifecycle.state', 'session_state'],
]

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function buildPlugin(collectorRoot) {
  const hookerMain = path.join(collectorRoot, 'hooker_main.py')
  return HOOKS.map(([id, hook_point, op]) => ({
    id,
    hook_point,
    command: `exec python3 ${shellSingleQuote(hookerMain)} ${op}`,
  }))
}

module.exports = {
  HOOKS,
  RUNTIME_FILES,
  buildPlugin,
}
