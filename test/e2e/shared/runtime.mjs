import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const activeCommands = new Set();
export async function stopCommands({graceMs=1500}={}) {
  if(!Number.isSafeInteger(graceMs)||graceMs<0||graceMs>90000)throw Error('Invalid cleanup grace');
  const children = [...activeCommands];
  for (const child of children) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  let graceTimer;
  try{await Promise.race([Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once('close', resolve)))), new Promise(resolve => {graceTimer=setTimeout(resolve,graceMs);})]);}finally{clearTimeout(graceTimer);}
  for (const child of children) if (activeCommands.has(child)) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

export function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export async function command(bin, args, { env = process.env, cwd, log, timeout = 120000, maxOutputChars = 16384, maxLogBytes = Infinity, terminationGraceMs = 10000 } = {}) {
  let output = '';
  const fd = log ? fs.openSync(log, 'a', 0o600) : null;
  let loggedBytes = fd === null ? 0 : fs.fstatSync(fd).size, logTruncated = loggedBytes > maxLogBytes;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    activeCommands.add(child);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-maxOutputChars); if (fd !== null) { const kept = data.subarray(0, Math.max(0, maxLogBytes - loggedBytes)); if(kept.length){fs.writeSync(fd, kept);loggedBytes += kept.length;} if(kept.length < data.length && !logTruncated){fs.writeSync(fd, '\n[LOG TRUNCATED: size limit reached; output continues to drain]\n');logTruncated = true;} } });
    let expired = false;
    let forceTimer, closed = false;
    const timer = setTimeout(() => {
      expired = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, terminationGraceMs);
    }, timeout);
    const release = () => { if (closed) return; closed = true; activeCommands.delete(child); clearTimeout(timer); clearTimeout(forceTimer); if (fd !== null) fs.closeSync(fd); };
    child.on('error', error => { release(); reject(error); });
    child.on('close', (code, signal) => { release(); resolve({ code, signal, output, expired }); });
  });
}

export async function poll(read, accept, timeout = 90000, interval = 1500) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Timed out waiting for business condition');
}

export function runtimeEnv(root, binaryDir) {
  const host = path.join(root, 'host');
  const insight = path.join(root, 'insight');
  for (const dir of [host, insight, path.join(host, '.config'), path.join(host, '.local/share')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(root, 'tmp');fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: host, AGENT_INSIGHT_USER_HOME: host, AGENT_INSIGHT_HOME: insight, AGENT_INSIGHT_RAS_HOME: path.join(insight, 'ras'), XDG_CONFIG_HOME: path.join(host, '.config'), XDG_DATA_HOME: path.join(host, '.local/share'), XDG_CACHE_HOME: path.join(host, '.cache'), PATH: `${binaryDir}${path.delimiter}/usr/bin:/bin:/usr/sbin:/sbin`, OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.AGENT_INSIGHT_DATA_DIR;
  env.TMPDIR = temp;env.TMP = temp;env.TEMP = temp;
  return env;
}
