#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [insightHome, projectRoot] = process.argv.slice(2);
if (!insightHome || !projectRoot) {
  console.error('Usage: stop-orphan-trace-consumer.cjs <agent-insight-home> <project-root>');
  process.exit(2);
}

const lockPath = path.join(insightHome, 'otel_data', 'traces', 'consumer-owner.lock');
if (!fs.existsSync(lockPath)) process.exit(0);

let owner;
try {
  owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
} catch {
  process.exit(0);
}
const pid = owner?.pid;
if (!Number.isSafeInteger(pid) || pid <= 0) process.exit(0);

try {
  process.kill(pid, 0);
} catch (error) {
  if (error.code === 'ESRCH') process.exit(0);
  console.error(`无法检查 Trace 消费锁进程 ${pid}: ${error.message}`);
  process.exit(1);
}

function lsof(args) {
  try {
    return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.status === 1) return error.stdout?.toString() || '';
    throw error;
  }
}

try {
  const cwd = lsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n').find(line => line.startsWith('n'))?.slice(1);
  const expected = path.join(fs.realpathSync(projectRoot), '.next', 'standalone');
  const relativeCwd = path.relative(expected, (cwd || '').replace(/ \(deleted\)$/, ''));
  const sameRuntime = relativeCwd === ''
    || (relativeCwd !== '..' && !relativeCwd.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeCwd) && !relativeCwd.includes(path.sep));
  if (!sameRuntime) {
    throw new Error(`Trace 消费锁由其他进程 ${pid} 持有（cwd: ${cwd || '未知'}），拒绝误杀`);
  }

  const listeners = lsof(['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fp']);
  if (listeners.split('\n').some(line => line === `p${pid}`)) {
    throw new Error(`Trace 消费锁进程 ${pid} 仍在监听端口，请先停止该服务`);
  }

  const currentOwner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (currentOwner.pid !== pid || currentOwner.token !== owner.token) {
    throw new Error('Trace 消费锁归属已变化，拒绝终止进程');
  }

  console.log(`Stopping orphan Agent Insight Trace consumer process ${pid}...`);
  process.kill(pid, 'SIGKILL');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
