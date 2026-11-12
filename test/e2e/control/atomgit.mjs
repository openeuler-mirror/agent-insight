import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class AtomGit {
  constructor({ token = process.env.ATOMGIT_TOKEN, baseUrl = 'https://api.atomgit.com/api/v5', localTest = false } = {}) {
    if (!token || /[\r\n"\\]/.test(token)) throw Error('Invalid ATOMGIT_TOKEN');
    const url = new URL(baseUrl);
    if (url.username || url.password || baseUrl !== 'https://api.atomgit.com/api/v5' && !(localTest && url.hostname === '127.0.0.1' && url.protocol === 'http:')) throw Error('Untrusted API endpoint');
    this.token = token;this.baseUrl = baseUrl;this.localTest = localTest;
  }
  async #curl(method, route, body, { apiVersion = 5, binary = false, downloadUrl } = {}) {
    if (!/^\/[a-zA-Z0-9_./?=&%-]+$/.test(route) || ![5, 8].includes(apiVersion)) throw Error('Invalid API route or version');
    const base = apiVersion === 5 ? this.baseUrl : this.baseUrl.replace(/\/api\/v5$/, '') + '/api/v8';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-atomgit-'));fs.chmodSync(dir, 0o700);
    try {
      const config = path.join(dir, 'curl.cfg'), headers = path.join(dir, 'headers');
      fs.writeFileSync(config, downloadUrl ? `url = "${downloadUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n` : `header = "Authorization: Bearer ${this.token}"\n`, { mode: 0o600 });fs.writeFileSync(headers, '', { mode: 0o600 });
      const args = ['--silent', '--show-error', '--max-time', '30', '-K', config, '--request', method, '--dump-header', headers, '--write-out', '\n%{http_code}', ...(downloadUrl ? [] : [base + route])];
      if (body !== undefined) { const payload = path.join(dir, 'body.json');fs.writeFileSync(payload, JSON.stringify(body), { mode: 0o600 });args.push('--header', 'Content-Type: application/json', '--data-binary', '@' + payload); }
      const result = await new Promise((resolve, reject) => {
        const child = spawn('curl', args, { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });const chunks = [];let size = 0;
        child.stdout.on('data', chunk => { size += chunk.length;if (size > (binary ? 8 : 4) * 1024 * 1024 + 8) child.kill();else chunks.push(chunk); });
        child.stderr.resume();child.once('error', reject);child.once('close', code => resolve({ code, output: Buffer.concat(chunks) }));
      });
      const split = result.output.lastIndexOf(10), status = Number(result.output.subarray(split + 1).toString());
      if (result.code !== 0 || status < 200 || status >= (binary ? 400 : 300)) throw Error(`AtomGit ${method} ${downloadUrl ? 'artifact CDN' : `/api/v${apiVersion}${route.split('?')[0]}`} failed (HTTP ${status || 'unknown'})`);
      const locations = [...fs.readFileSync(headers, 'utf8').matchAll(/^location:\s*(.+)\r?$/gim)];
      return { status, bytes: result.output.subarray(0, split), location: locations.at(-1)?.[1].trim() };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  async request(method, route, body, options) {
    const result = await this.#curl(method, route, body, options);
    return result.bytes.length ? JSON.parse(result.bytes.toString('utf8')) : null;
  }
  async downloadArtifact(repository, id) {
    if (!/^\d{1,24}$/.test(String(id))) throw Error('Invalid artifact ID');
    const first = await this.#curl('GET', this.repoPath(repository) + '/actions/artifacts/' + id + '/zip', undefined, { apiVersion: 8, binary: true });
    if (first.status === 200) return first.bytes;
    let location = first.location;
    for (let hop = 0; hop < 3; hop++) {
      const url = new URL(location);
      const local = this.localTest && url.hostname === '127.0.0.1' && url.protocol === 'http:';
      if (url.username || url.password || !local && (url.protocol !== 'https:' || url.hostname !== 'actions-artifacts-cdn.atomgit.com')) throw Error('Untrusted artifact download destination');
      // The signed CDN request must never inherit the API authorization header.
      const response = await this.#curl('GET', '/download', undefined, { binary: true, downloadUrl: url.href });
      if (response.status >= 300) { location = new URL(response.location, url).href;continue; }
      return response.bytes;
    }
    throw Error('Too many artifact redirects');
  }
  repoPath(repository) { if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error('Invalid repository');return '/repos/' + repository; }
  readPull(repository, number) { if (!Number.isSafeInteger(number) || number < 1) throw Error('Invalid PR number');return this.request('GET', this.repoPath(repository) + '/pulls/' + number); }
  createComment(repository, number, body) { if (!Number.isSafeInteger(number) || number < 1) throw Error('Invalid PR number');return this.request('POST', this.repoPath(repository) + '/pulls/' + number + '/comments', { body }); }
}
