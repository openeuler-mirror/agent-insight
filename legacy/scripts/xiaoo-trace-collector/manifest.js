/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
