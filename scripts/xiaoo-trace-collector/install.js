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
const { RUNTIME_FILES, buildPlugin } = require('./manifest')

const SRC = __dirname
const HOME = process.env.HOME || os.homedir()
const DEST = path.join(
  process.env.AGENT_INSIGHT_DATA_DIR || path.join(HOME, '.agent-insight'),
  'xiaoo-trace-collector',
)

function copyTree() {
  fs.mkdirSync(DEST, { recursive: true })
  for (const name of RUNTIME_FILES) {
    const src = path.join(SRC, name)
    if (!fs.existsSync(src)) {
      throw new Error(`missing ${src}`)
    }
    fs.copyFileSync(src, path.join(DEST, name))
  }
  const pluginPath = path.join(DEST, 'plugin.json')
  const plugin = buildPlugin(DEST)
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
