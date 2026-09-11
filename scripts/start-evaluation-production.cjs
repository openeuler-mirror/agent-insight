#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { prepareProductionBuild, runLogged, withProjectLock } = require('./lib/evaluation-production-build.cjs');
const { assertCanStart, startManaged, stopManaged } = require('./lib/managed-production-runtime.cjs');

function parseArgs(args) {
  const options = { project: path.resolve(__dirname, '..'), dataRoot: process.env.AGENT_INSIGHT_DATA_DIR || path.join(os.homedir(), '.agent-insight-nh-demo'), port: process.env.AGENT_INSIGHT_DEV_PORT || '3019' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '--rebuild', '--check', '--stop'].includes(arg)) { options[arg.slice(2)] = true; continue; }
    if (!['--project', '--data-dir', '--port'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`未知选项或缺少参数：${arg}`);
    options[arg === '--data-dir' ? 'dataRoot' : arg.slice(2)] = args[++i];
  }
  options.port = Number(options.port);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('端口必须是 1 到 65535 的整数。');
  return options;
}

async function run(options) {
  const project = await fs.realpath(path.resolve(options.project));
  const dataRoot = path.resolve(options.dataRoot);
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const identity = { project, dataRoot, port: options.port };
  if (options.stop) { await withProjectLock(project, () => stopManaged(identity)); console.log('对应演示平台已停止，数据库保留。'); return; }
  await assertCanStart(identity);
  if (options.check) { console.log('平台端口可用，或由本演示实例占用。'); return; }
  const projectRequire = createRequire(path.join(project, 'package.json'));
  const dotenv = projectRequire('dotenv');
  const configured = {};
  for (const filename of ['.env', '.env.production', '.env.local', '.env.production.local'].map(name => path.join(project, name)).concat(path.join(dataRoot, '.env'))) {
    try { Object.assign(configured, dotenv.parse(await fs.readFile(filename))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const env = { ...configured, ...process.env, AGENT_INSIGHT_DATA_DIR: dataRoot, NEXT_PUBLIC_EVALUATION_DEMO: 'true', NODE_ENV: 'production', HOSTNAME: '127.0.0.1' };
  env.DATABASE_URL ||= `file:${path.join(dataRoot, 'data/witty_insight.db')}`;
  if (env.DATABASE_URL === 'file:../data/witty_insight.db') env.DATABASE_URL = `file:${path.join(dataRoot, 'data/witty_insight.db')}`;
  if (env.DB_HOST || !env.DATABASE_URL.startsWith('file:')) throw new Error('此演示启动入口使用 SQLite 数据库。');
  await fs.mkdir(path.join(dataRoot, 'data'), { recursive: true, mode: 0o700 });
  const logFile = path.join(dataRoot, `production-${options.port}.log`);
  await withProjectLock(project, async () => {
    await assertCanStart(identity);
    const databasePath = env.DATABASE_URL.slice(5);
    if (!path.isAbsolute(databasePath) || databasePath.includes('?')) throw new Error('请使用绝对路径的 SQLite DATABASE_URL。');
    await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    await (await fs.open(databasePath, 'a', 0o600)).close();
    const commandOptions = { cwd: project, env, logFile };
    await runLogged(process.execPath, ['scripts/prepare-ras-sqlite-schema.js'], commandOptions);
    await runLogged(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], commandOptions);
    const runtime = await prepareProductionBuild({ project, dataRoot, env, rebuild: options.rebuild });
    console.log(runtime.reused ? '代码与构建配置未变化，复用生产产物。' : '生产编译完成，启动预编译版本。');
    const prefix = env.NEXT_PUBLIC_URL_PREFIX || '';
    const state = await startManaged({ ...identity, ...runtime, env, logFile, readyPath: `${prefix}/`, startupTimeoutMs: 60000 });
    console.log(`演示平台：http://127.0.0.1:${options.port}${prefix}/experiments`);
    console.log(`生产进程：${state.serverPid}；日志：${logFile}`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node scripts/start-evaluation-production.cjs [--port 3019] [--data-dir /path/to/demo-home] [--rebuild|--check|--stop]\n首次编译生产版本，源码或公开构建配置变化时重新编译；相同命令重启自己的实例。\n--rebuild 强制重新编译；--check 只检查端口归属；--stop 只停止匹配的演示实例。\n数据快照通过仓库外的演示数据包导入。');
    return;
  }
  await run(options);
}

if (require.main === module) main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
module.exports = { parseArgs, run };
