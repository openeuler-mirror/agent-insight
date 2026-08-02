#!/usr/bin/env node

const commands = {
  start: () => require('../scripts/start.js'),
  stop: () => require('../scripts/stop.js'),
  restart: () => require('../scripts/restart.js'),
  status: () => require('../scripts/status.js'),
  logs: () => require('../scripts/logs.js'),
  install: () => require('../scripts/install.js')
}

const INSTALLABLE_FRAMEWORKS = new Set([
  'opencode', 'openclaw', 'claude', 'codeagent', 'hermes', 'jiuwen', 'codex',
])

function parseOptions(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      const port = parseInt(args[i + 1])
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('Invalid port number. Port must be between 1 and 65535.')
        process.exit(1)
      }
      options.port = port
      i++
    } else if (args[i] === '--frameworks') {
      const frameworks = args[i + 1]
      if (!frameworks || frameworks.startsWith('-')) {
        console.error('Missing framework list. Use --frameworks <comma-list>.')
        process.exit(1)
      }
      const selected = frameworks.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
      const invalid = selected.filter((item) => !INSTALLABLE_FRAMEWORKS.has(item))
      if (selected.length === 0 || invalid.length > 0) {
        console.error(`Invalid framework list: ${invalid.join(',') || frameworks}`)
        process.exit(1)
      }
      options.frameworks = [...new Set(selected)].join(',')
      i++
    } else if (args[i] === '--help' || args[i] === '-h') {
      options.help = true
    }
  }
  return options
}

function showHelp() {
  console.log(`
Agent-insight CLI

Usage:
  agent-insight <command> [options]

Commands:
  start [--port <port>]    Start the service (default port: 3000)
  stop [--port <port>]     Stop the service
  restart [--port <port>]  Restart the service
  status [--port <port>]   Show service status
  logs                     Show service logs
  install [--frameworks <comma-list>]
                           One-click install: npm install, start service, setup plugins, add skill

Options:
  --port, -p <port>       Specify port number
  --frameworks <list>     Preselect comma-separated telemetry frameworks
  --help, -h              Show help

Examples:
  agent-insight start
  agent-insight start --port 3001
  agent-insight restart --port 3001
  agent-insight status
  agent-insight stop
  `)
}

function showCommandHelp(command) {
  const helps = {
    start: 'Start the Agent-insight service\n\nOptions:\n  --port, -p <port>  Specify port (default: 3000)',
    stop: 'Stop the Agent-insight service\n\nOptions:\n  --port, -p <port>  Specify port (default: 3000)',
    restart: 'Restart the Agent-insight service\n\nOptions:\n  --port, -p <port>  Specify port (default: 3000)',
    status: 'Show Agent-insight service status\n\nOptions:\n  --port, -p <port>  Specify port (default: 3000)',
    logs: 'Show Agent-insight service logs',
    install: 'One-click install Agent-insight\n\nOptions:\n  --port, -p <port>       Specify port (default: 3000)\n  --frameworks <list>     Preselect comma-separated telemetry frameworks\n\nThis command will:\n  1. npm install agent-insight when needed\n  2. Start the service\n  3. Create admin user and get API Key\n  4. Install telemetry plugins\n  5. Add skill to your agent'
  }
  console.log(`\nagent-insight ${command}\n\n${helps[command] || ''}`)
}

const args = process.argv.slice(2)
const command = args[0]
const options = parseOptions(args.slice(1))

if (!command || command === '--help' || command === '-h') {
  showHelp()
  process.exit(0)
}

if (options.help) {
  showCommandHelp(command)
  process.exit(0)
}

if (commands[command]) {
  try {
    const commandModule = commands[command]()
    if (typeof commandModule.run !== 'function') {
      console.error(`Command module for '${command}' is missing run() function`)
      process.exit(1)
    }
    const result = commandModule.run(options)
    if (result && typeof result.then === 'function') {
      result.catch((error) => {
        console.error(`Error executing command '${command}':`, error.message)
        process.exit(1)
      })
    }
  } catch (error) {
    console.error(`Error executing command '${command}':`, error.message)
    process.exit(1)
  }
} else {
  console.error(`Unknown command: ${command}`)
  showHelp()
  process.exit(1)
}
