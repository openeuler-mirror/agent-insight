'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const {fork, spawn} = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function location(config) {
  const project = fs.realpathSync(config.project);
  const dataRoot = fs.realpathSync(config.dataRoot);
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1 到 65535 的整数');
  const identity = crypto.createHash('sha256').update(JSON.stringify({project, dataRoot, port})).digest('hex');
  const stateFile = path.join(dataRoot, '.production-runtime', `${identity}.json`);
  return {project, dataRoot, port, identity, stateFile};
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error(`服务管理目录不属于当前用户：${directory}`);
  fs.chmodSync(directory, 0o700);
}
function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}
function portBusy(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(true);
      else if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve(false);
      else reject(error);
    });
    probe.listen({port, host, ipv6Only: host === '::1'}, () => probe.close(() => resolve(false)));
  });
}
async function occupied(port) {
  return (await Promise.all([portBusy(port, '127.0.0.1'), portBusy(port, '::1')])).some(Boolean);
}
function httpReady(config) {
  return new Promise(resolve => {
    const request = http.get({hostname: '127.0.0.1', port: config.port, path: config.readyPath || '/', agent: false}, response => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.setTimeout(1000, () => request.destroy());
    request.once('error', () => resolve(false));
  });
}
function request(state, action, timeout = 1200) {
  return new Promise((resolve, reject) => {
    let data = '', done = false;
    const socket = net.createConnection(state.socketPath);
    const finish = (error, value) => {
      if (done) return;
      done = true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(timeout, () => finish(new Error('服务管理连接超时')));
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('服务管理连接已关闭')));
    socket.once('connect', () => socket.write(JSON.stringify({action, token: state.token, identity: state.identity}) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.length > 8192) return finish(new Error('服务管理响应无效'));
      if (!data.includes('\n')) return;
      try { finish(null, JSON.parse(data.split('\n')[0])); } catch (error) { finish(error); }
    });
  });
}
function authorized(state, info, identity) {
  return state && state.identity === identity && info && info.ok === true && info.identity === identity && info.pid === state.pid && info.serverPid === state.serverPid;
}
async function inspectManaged(config) {
  const info = location(config);
  const state = readState(info.stateFile);
  if (state && state.identity === info.identity && typeof state.socketPath === 'string' && typeof state.token === 'string') {
    try {
      const reply = await request(state, 'inspect');
      if (authorized(state, reply, info.identity)) return {...info, status: 'owned', pid: reply.pid, serverPid: reply.serverPid, socketPath: state.socketPath};
    } catch {}
  }
  return {...info, status: await occupied(info.port) ? 'foreign' : 'stopped'};
}
async function assertCanStart(config) {
  const info = await inspectManaged(config);
  if (info.status === 'foreign') throw new Error(`端口 ${info.port} 被其他服务占用，或无法验证现有进程归属；未停止任何进程。请先停止该服务或选择其他端口。`);
  return info;
}
async function stopManaged(config) {
  const info = await assertCanStart(config);
  if (info.status !== 'owned') return info;
  const state = readState(info.stateFile);
  if (!state) return inspectManaged(config);
  const reply = await request(state, 'stop');
  if (!authorized(state, reply, info.identity)) throw new Error('无法验证服务归属，未停止进程');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const current = readState(info.stateFile);
    if (!current || current.token !== state.token) return inspectManaged(config);
    await delay(50);
  }
  throw new Error('旧服务停止超时，请检查服务日志后重试');
}
async function startManaged(config) {
  if (!path.isAbsolute(config.entry) || !fs.statSync(config.entry).isFile()) throw new Error('生产启动入口不存在');
  await assertCanStart(config);
  await stopManaged(config);
  const info = await assertCanStart(config);
  privateDirectory(path.dirname(info.stateFile));
  const socketDirectory = path.join(os.tmpdir(), `ai-runtime-${process.getuid ? process.getuid() : 'user'}`);
  privateDirectory(socketDirectory);
  const token = crypto.randomBytes(32).toString('hex');
  const socketPath = path.join(socketDirectory, `${info.identity.slice(0, 12)}-${crypto.randomBytes(5).toString('hex')}.sock`);
  const startupTimeoutMs = config.startupTimeoutMs || 60000;
  return new Promise((resolve, reject) => {
    const daemon = fork(__filename, [], {detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    let complete = false;
    const finish = (error, result) => {
      if (complete) return;
      complete = true; clearTimeout(timer);
      if (daemon.connected) daemon.disconnect();
      daemon.unref();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      if (daemon.connected) daemon.send({cancel: true});
      finish(new Error('生产服务启动超时，请检查服务日志'));
    }, startupTimeoutMs + 5000);
    daemon.once('error', error => finish(error));
    daemon.once('exit', code => finish(new Error(`生产服务管理进程退出 (${code})，请检查服务日志`)));
    daemon.on('message', message => {
      if (message.error) finish(new Error(message.error));
      else if (message.ready) finish(null, {...info, status: 'owned', pid: daemon.pid, serverPid: message.serverPid, socketPath});
    });
    daemon.send({config: {...config, ...info, token, socketPath, startupTimeoutMs}});
  });
}

async function runDaemon(config) {
  let child, control, stopping, ready = false;
  const state = {version: 1, identity: config.identity, token: config.token, socketPath: config.socketPath, pid: process.pid, serverPid: null};
  const shutdown = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => {
          const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
          child.once('exit', () => {clearTimeout(timeout); resolve();});
          child.kill('SIGTERM');
        });
      }
      if (control) await new Promise(resolve => control.close(resolve));
      if (readState(config.stateFile)?.token === config.token) fs.rmSync(config.stateFile, {force: true});
      fs.rmSync(config.socketPath, {force: true});
    })();
    return stopping;
  };
  const end = () => shutdown().finally(() => process.exit(0));
  process.on('SIGTERM', end); process.on('SIGINT', end);
  process.on('disconnect', () => { if (!ready) end(); });
  process.on('message', message => { if (message.cancel) end(); });
  try {
    const log = fs.openSync(config.logFile, 'a', 0o600); fs.fchmodSync(log, 0o600);
    child = spawn(process.execPath, [config.entry], {cwd: config.cwd, env: {...config.env, PORT: String(config.port)}, stdio: ['ignore', log, log]});
    fs.closeSync(log);
    let failed;
    child.once('error', error => {failed = error; if (ready) end();});
    child.once('exit', code => {failed = new Error(`生产服务启动后退出 (${code})，请查看 ${config.logFile}`); if (ready) end();});
    state.serverPid = child.pid;
    const deadline = Date.now() + config.startupTimeoutMs;
    let serving = false;
    while (!failed && !stopping && Date.now() < deadline) {
      if (await httpReady(config)) {
        await delay(100);
        if (!failed) {serving = true; break;}
      }
      await delay(100);
    }
    if (failed) throw failed;
    if (stopping || !serving) throw new Error(`生产服务启动超时，请查看 ${config.logFile}`);
    control = net.createServer(socket => {
      let data = '';
      socket.setTimeout(1200, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', chunk => {
        data += chunk.toString();
        if (data.length > 8192) return socket.destroy();
        if (!data.includes('\n')) return;
        let message;
        try { message = JSON.parse(data.split('\n')[0]); } catch { return socket.destroy(); }
        const suppliedToken = typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0);
        const validToken = suppliedToken.length === Buffer.byteLength(config.token) && crypto.timingSafeEqual(suppliedToken, Buffer.from(config.token));
        if (!validToken || message.identity !== config.identity) return socket.end(JSON.stringify({ok: false}) + '\n');
        socket.end(JSON.stringify({ok: true, identity: config.identity, pid: process.pid, serverPid: child.pid}) + '\n');
        if (message.action === 'stop') socket.once('close', end);
      });
    });
    await new Promise((resolve, reject) => {control.once('error', reject); control.listen(config.socketPath, resolve);});
    const temporary = `${config.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), {mode: 0o600, flag: 'wx'}); fs.renameSync(temporary, config.stateFile);
    ready = true;
    if (process.connected) process.send({ready: true, serverPid: child.pid}); else end();
  } catch (error) {
    await shutdown();
    if (process.connected) process.send({error: `生产服务启动失败：${error.message}`}, () => process.exit(1));
    else process.exit(1);
  }
}

module.exports = {inspectManaged, assertCanStart, stopManaged, startManaged};
if (require.main === module) {
  let configured = false;
  process.once('message', message => {if (message.config) {configured = true; runDaemon(message.config);} else process.exit(1);});
  process.once('disconnect', () => {if (!configured) process.exit(1);});
}
