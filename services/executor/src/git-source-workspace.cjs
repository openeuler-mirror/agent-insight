'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { setTimeout: delay } = require('node:timers/promises')

const LOCAL_FAILURE = /no space left|disk quota|permission denied|read-only file system|unable to write|cannot create|could not write/i

class GitSourceWorkspace {
  constructor({ run, ErrorType, log = () => {} }) {
    this.run = run
    this.ErrorType = ErrorType
    this.log = log
  }

  async prepare(provider, spec, workspace, sources, signal) {
    const git = async (cwd, args) => {
      signal?.throwIfAborted()
      return this.run('git', args, {
        cwd, signal, killProcessGroup: true,
        timeoutMs: provider.fetchTimeoutMs,
        errorCode: 'WORKSPACE_PREPARE_FAILED',
        timeoutErrorCode: 'PROCESS_TIMEOUT',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LANG: 'C', LC_ALL: 'C' },
      })
    }
    const complete = async (directory) => {
      try {
        await git(directory, ['cat-file', '-e', `${spec.revision}^{commit}`])
        const objects = await git(directory, ['rev-list', '--objects', '--missing=print', spec.revision])
        if (/^\?/m.test(objects.stdout)) return false
        await git(directory, ['fsck', '--no-dangling', spec.revision])
        return true
      } catch (error) {
        signal?.throwIfAborted()
        if (LOCAL_FAILURE.test(`${error.message} ${error.stderr || ''}`) || error.code === 'ENOENT') throw error
        return false
      }
    }
    const fetchRemote = async (directory, bare) => {
      const failures = []
      for (const remote of sources.remotes) {
        signal?.throwIfAborted()
        this.log(`Git source: ${remote.name}`)
        try {
          if (bare) {
            await fs.rm(directory, { recursive: true, force: true })
            await fs.mkdir(directory, { recursive: true, mode: 0o700 })
            await git(directory, ['init', '--bare', '--quiet'])
          } else {
            await provider.initializeWorkspace(directory, spec.repository)
          }
          await git(directory, ['fetch', '--quiet', '--no-tags', '--depth=1', remote.url, spec.revision])
          const head = await git(directory, ['rev-parse', 'FETCH_HEAD'])
          if (head.stdout.trim().toLowerCase() !== spec.revision.toLowerCase()) {
            throw new this.ErrorType('WORKSPACE_REVISION_MISMATCH', 'Git HEAD 与 baseCommit 不一致')
          }
          if (!(await complete(directory))) throw new Error('Downloaded Git objects are incomplete')
          if (bare) await git(directory, ['update-ref', `refs/benchmark/${spec.revision}`, spec.revision])
          return remote.name
        } catch (error) {
          signal?.throwIfAborted()
          if (['ENOSPC', 'EACCES', 'EROFS', 'ENOENT'].includes(error.code)
            || LOCAL_FAILURE.test(`${error.message} ${error.stderr || ''}`)) throw error
          failures.push(`${remote.name}: ${String(error.message).slice(-500)}`)
          this.log(`Git source failed: ${remote.name}`)
        }
      }
      throw new this.ErrorType('WORKSPACE_PREPARE_FAILED', `Git 来源均失败：${failures.join('；')}`, 503, true)
    }

    if (!sources.cachePath) {
      await fetchRemote(workspace, false)
      return
    }

    const cache = sources.cachePath
    await fs.mkdir(path.dirname(cache), { recursive: true, mode: 0o700 })
    const lock = `${cache}.lock`
    const deadline = Date.now() + provider.fetchTimeoutMs * (sources.remotes.length + 1)
    while (true) {
      signal?.throwIfAborted()
      try {
        await fs.mkdir(lock, { mode: 0o700 })
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (Date.now() >= deadline) {
          throw new this.ErrorType('WORKSPACE_PREPARE_FAILED', `等待 Git 缓存锁超时：${lock}`, 503, true)
        }
        await delay(100, undefined, { signal })
      }
    }
    let staging
    try {
      let existing = false
      try {
        const stat = await fs.lstat(cache)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Git 缓存必须是普通目录：${cache}`)
        existing = true
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (existing) {
        const bare = await git(cache, ['rev-parse', '--is-bare-repository'])
        if (bare.stdout.trim() !== 'true') throw new Error(`Git 缓存必须是 Bare 仓库：${cache}`)
      }
      if (!existing || !(await complete(cache))) {
        staging = await fs.mkdtemp(path.join(path.dirname(cache), '.git-download-'))
        await fetchRemote(staging, true)
        if (!existing) {
          await fs.rename(staging, cache)
          staging = undefined
        } else {
          await git(cache, ['fetch', '--quiet', '--no-tags', '--depth=1', '--update-shallow',
            pathToFileURL(staging).href, `refs/benchmark/${spec.revision}:refs/benchmark/${spec.revision}`])
          if (!(await complete(cache))) throw new Error(`Git 缓存对象不完整：${cache}`)
        }
      } else {
        this.log('Git source: local-cache')
      }
      await provider.initializeWorkspace(workspace, spec.repository)
      // A depth-one transfer avoids alternates and other cases' refs/history.
      await git(workspace, ['fetch', '--quiet', '--no-tags', '--depth=1', '--update-shallow',
        pathToFileURL(cache).href, spec.revision])
    } finally {
      try {
        if (staging) await fs.rm(staging, { recursive: true, force: true })
      } finally {
        await fs.rmdir(lock)
      }
    }
  }
}

module.exports = { GitSourceWorkspace }
