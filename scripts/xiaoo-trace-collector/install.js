#!/usr/bin/env node
/**
 * Install Insight-owned xiaoO Trace collector (⓪) into ~/.agent-insight/xiaoo-trace-collector
 * and append its plugin.json to ~/.config/xiaoo/config.toml [hooker].plugins.
 *
 * Usage: node scripts/xiaoo-trace-collector/install.js
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const SRC = __dirname
const HOME = process.env.HOME || os.homedir()
const DEST = path.join(
  process.env.AGENT_INSIGHT_DATA_DIR || path.join(HOME, '.agent-insight'),
  'xiaoo-trace-collector',
)

const COPY_FILES = [
  'hooker_main.py',
  'otel_trace.py',
  'otel_spans.py',
  'otlp_http.py',
  'session_ids.py',
]

function copyTree() {
  fs.mkdirSync(DEST, { recursive: true })
  for (const name of COPY_FILES) {
    const src = path.join(SRC, name)
    if (!fs.existsSync(src)) {
      throw new Error(`missing ${src}`)
    }
    fs.copyFileSync(src, path.join(DEST, name))
  }
  const hookerMain = path.join(DEST, 'hooker_main.py')
  const pluginPath = path.join(DEST, 'plugin.json')
  const entries = [
    ['insight_xiaoo_chat_received', '*.Chat.message.received', 'chat_received'],
    ['insight_xiaoo_tool_post', '*.Tool.*.post', 'tool_post'],
    ['insight_xiaoo_session_state', '*.Session.lifecycle.state', 'session_state'],
  ]
  const plugin = entries.map(([id, hook_point, op]) => ({
    id,
    hook_point,
    command: `python3 "${hookerMain}" ${op}`,
  }))
  fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`, 'utf8')
  return pluginPath
}

function appendPlugin(pluginPath) {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')
  const configPath = path.join(xdg, 'xiaoo', 'config.toml')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  let toml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
  const normalized = pluginPath.replace(/\\/g, '/')
  const pluginLine = `"${normalized}"`
  if (toml.includes(normalized) || toml.includes(pluginPath)) {
    return { configPath, appended: false }
  }
  if (!/\[hooker\]/.test(toml)) {
    toml += `\n[hooker]\nplugins = [${pluginLine}]\n`
  } else if (/plugins\s*=\s*\[/.test(toml)) {
    toml = toml.replace(/plugins\s*=\s*\[/, (m) => `${m}${pluginLine}, `)
  } else {
    toml = toml.replace(/\[hooker\]/, `[hooker]\nplugins = [${pluginLine}]`)
  }
  fs.writeFileSync(configPath, toml, 'utf8')
  return { configPath, appended: true }
}

function main() {
  const pluginPath = copyTree()
  const { configPath, appended } = appendPlugin(pluginPath)
  console.log(`[xiaoo-trace-collector] installed → ${DEST}`)
  console.log(`[xiaoo-trace-collector] plugin → ${pluginPath}`)
  console.log(
    `[xiaoo-trace-collector] config ${appended ? 'updated' : 'already listed'} → ${configPath}`,
  )
}

main()
