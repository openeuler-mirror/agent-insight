'use strict'

const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const executeFile = promisify(execFile)

async function desktopSpace(paths, execute = executeFile) {
  // VirtioFS 的 f_bsize 可能是 I/O 单位；空间块数必须乘 f_frsize。
  const script = 'import os,json,sys; print(json.dumps([dict(path=p,free=(s:=os.statvfs(p)).f_bavail*s.f_frsize,files=s.f_files,ffree=s.f_ffree) for p in sys.argv[1:]]))'
  const { stdout } = await execute('python3', ['-c', script, ...paths], { timeout: 5000, maxBuffer: 16 * 1024 })
  const rows = JSON.parse(stdout)
  if (!Array.isArray(rows) || rows.length !== paths.length || rows.some((row, index) => row.path !== paths[index]
    || !Number.isSafeInteger(row.free) || row.free < 0 || !Number.isSafeInteger(row.files) || row.files < 0
    || !Number.isSafeInteger(row.ffree) || row.ffree < 0)) throw new Error('磁盘统计不合法')
  return rows
}

function poolError(code, message, retryable = true) {
  return Object.assign(new Error(message), { code, status: 503, retryable })
}

function pullError(message) {
  if (/\bENOSPC\b|no space left on device|disk quota exceeded/i.test(message)) {
    return poolError('IMAGE_POOL_SPACE_LOW', `镜像准备空间不足：${message.slice(-1000)}`, false)
  }
  return poolError('IMAGE_POOL_PULL_FAILED', message)
}

class DockerImageStore {
  constructor(options = {}) {
    this.socketPath = options.socketPath || '/var/run/docker.sock'
    this.diskPath = options.diskPath || process.env.IMAGE_POOL_DISK_PATH
    this.diskMode = options.diskMode || process.env.IMAGE_POOL_DISK_MODE || 'linux'
    this.hostDiskPath = options.hostDiskPath || process.env.IMAGE_POOL_HOST_DISK_PATH
    this.containerdPath = options.containerdPath || process.env.IMAGE_POOL_CONTAINERD_PATH
    this.checkManagers = options.checkManagers !== false
    this.readDesktopSpace = options.readDesktopSpace || desktopSpace
    this.access = options.access || fs.access
    this.controllerId = options.controllerId || process.env.EVALUATOR_CONTROLLER_CONTAINER_ID || process.env.HOSTNAME
    this.info = null
    this.stats = null
  }

  request(method, endpoint, streaming = false, payload) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path: endpoint, method,
        ...(payload ? { headers: { 'content-type': 'application/json' } } : {}) }, (res) => {
        let body = ''
        let streamError
        res.on('data', (chunk) => {
          body += chunk.toString()
          if (streaming && res.statusCode < 300) {
            const lines = body.split('\n')
            body = lines.pop()
            for (const line of lines) {
              try {
                const event = JSON.parse(line)
                if (event.error) streamError = event.error
              } catch {}
            }
          }
          if (body.length > 32 * 1024 * 1024) req.destroy(new Error('Docker response exceeds limit'))
        })
        res.on('aborted', () => reject(poolError('IMAGE_POOL_DOCKER_UNCERTAIN', 'Docker 连接中断，操作结果需对账')))
        res.on('error', (error) => reject(poolError('IMAGE_POOL_DOCKER_UNCERTAIN', error.message)))
        res.on('end', () => {
          if (res.statusCode >= 300) {
            const message = `Docker ${method} ${endpoint}: ${body.slice(-1000)}`
            const error = streaming ? pullError(message) : poolError('IMAGE_POOL_DOCKER_ERROR', message)
            error.dockerStatus = res.statusCode
            return reject(error)
          }
          if (streaming) {
            try { streamError ||= JSON.parse(body).error } catch {}
            if (streamError) return reject(pullError(String(streamError)))
            return resolve(null)
          }
          try { resolve(body ? JSON.parse(body) : null) } catch { reject(poolError('IMAGE_POOL_DOCKER_INVALID', 'Docker 响应不合法')) }
        })
      })
      req.on('error', (error) => reject(poolError('IMAGE_POOL_DOCKER_UNCERTAIN', error.message)))
      if (!streaming) req.setTimeout(30_000, () => req.destroy(new Error('Docker request timed out')))
      req.end(payload ? JSON.stringify(payload) : undefined)
    })
  }

  async initialize() {
    this.info = await this.request('GET', '/info')
    if (!this.info.ID || !this.info.DockerRootDir) throw poolError('IMAGE_POOL_DOCKER_INVALID', 'Docker 缺少 ID 或数据目录')
    this.containerd = (this.info.DriverStatus || []).some((item) => item.some((value) => String(value).includes('snapshotter')))
    if (!['linux', 'desktop-mac'].includes(this.diskMode)) throw poolError('IMAGE_POOL_DISK_UNSUPPORTED', '不支持的磁盘检测模式', false)
    if (this.diskMode === 'desktop-mac' && (this.info.OperatingSystem !== 'Docker Desktop' || this.info.OSType !== 'linux')) {
      throw poolError('IMAGE_POOL_DISK_UNSUPPORTED', 'Mac 模式只支持 Docker Desktop Linux VM', false)
    }
    if (this.containerd && this.diskMode !== 'desktop-mac') {
      throw poolError('IMAGE_POOL_DISK_UNSUPPORTED', '第一版不支持 containerd image store 的独立数据盘，请保持镜像池关闭', false)
    }
    if (this.diskPath) {
      const controller = await this.request('GET', `/containers/${encodeURIComponent(this.controllerId)}/json`)
      const mount = (controller.Mounts || []).find((item) => item.Destination === this.diskPath)
      if (mount?.Type !== 'bind' || mount.RW !== false || path.resolve(mount.Source) !== path.resolve(this.info.DockerRootDir)) {
        throw poolError('IMAGE_POOL_DISK_INVALID', 'IMAGE_POOL_DISK_PATH 必须绑定 DockerRootDir，不能使用 Controller 根分区')
      }
      if (this.diskMode === 'desktop-mac') {
        const hostMount = (controller.Mounts || []).find((item) => item.Destination === this.hostDiskPath)
        if (!this.hostDiskPath || hostMount?.Type !== 'bind' || hostMount.RW !== false || this.hostDiskPath === this.diskPath) {
          throw poolError('IMAGE_POOL_DISK_INVALID', 'Mac 模式必须只读挂载经过同盘校验的宿主探测目录')
        }
        if (this.containerd) {
          const dataMount = (controller.Mounts || []).find((item) => item.Destination === this.containerdPath)
          if (!this.containerdPath || dataMount?.Type !== 'bind' || dataMount.RW !== false
            || dataMount.Source !== '/var/lib/desktop-containerd' || [this.diskPath, this.hostDiskPath].includes(this.containerdPath)) {
            throw poolError('IMAGE_POOL_DISK_INVALID', 'Docker Desktop containerd 数据目录未正确只读挂载')
          }
          await this.access(path.join(this.containerdPath, 'daemon/io.containerd.content.v1.content'))
        }
      }
      if (this.checkManagers) {
        const managers = await this.request('GET', `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['agent-insight.image-pool=true'] }))}`)
        if (managers.some((item) => item.Id !== controller.Id)) throw poolError('IMAGE_POOL_ALREADY_RUNNING', '同一 daemon 已有其他镜像池 Controller', false)
      }
    } else {
      if (this.diskMode === 'desktop-mac') throw poolError('IMAGE_POOL_DISK_INVALID', 'Mac 模式必须通过启动脚本挂载数据盘')
      try {
        await fs.access('/.dockerenv')
        throw poolError('IMAGE_POOL_DISK_INVALID', '容器内启用镜像池必须挂载 Docker 数据目录并设置 IMAGE_POOL_DISK_PATH')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      this.diskPath = this.info.DockerRootDir
    }
    await this.freeSpace()
    await this.refresh()
    return { daemonId: this.info.ID, arch: this.info.Architecture }
  }

  async freeSpace() {
    if (this.diskMode === 'desktop-mac') {
      try {
        const paths = [this.diskPath, ...(this.containerd ? [this.containerdPath] : []), this.hostDiskPath]
        const rows = await this.readDesktopSpace(paths)
        for (const row of rows.slice(0, -1)) {
          if (row.files > 0 && row.ffree / row.files < 0.05) throw poolError('IMAGE_POOL_INODES_LOW', 'Docker 数据盘 inode 空间不足')
        }
        const vmFreeBytes = Math.min(...rows.slice(0, -1).map((row) => row.free))
        const hostFreeBytes = rows[rows.length - 1].free
        const freeBytes = Math.min(vmFreeBytes, hostFreeBytes)
        this.diskStatus = { mode: this.diskMode, vmFreeBytes, hostFreeBytes, freeBytes, measuredAt: new Date().toISOString() }
        return freeBytes
      } catch (error) {
        this.diskStatus = { mode: this.diskMode, error: error.code || 'IMAGE_POOL_DISK_INVALID' }
        throw poolError(error.code === 'IMAGE_POOL_INODES_LOW' ? error.code : 'IMAGE_POOL_DISK_INVALID', `Mac 镜像池空间检测失败：${error.message}`)
      }
    }
    const stat = await fs.statfs(this.diskPath)
    if (!Number.isSafeInteger(stat.bavail * stat.bsize) || stat.bavail < 0) throw poolError('IMAGE_POOL_DISK_INVALID', '无法读取 Docker 数据盘空间')
    if (stat.files > 0 && stat.ffree / stat.files < 0.05) throw poolError('IMAGE_POOL_INODES_LOW', 'Docker 数据盘 inode 空间不足')
    const freeBytes = stat.bavail * stat.bsize
    this.diskStatus = { mode: this.diskMode, freeBytes, measuredAt: new Date().toISOString() }
    return freeBytes
  }

  async refresh() {
    const usage = await this.request('GET', '/system/df')
    if (!Array.isArray(usage.Images)) throw poolError('IMAGE_POOL_STATS_INVALID', 'Docker 镜像占用统计不可用')
    this.stats = new Map(usage.Images.map((item) => [item.Id, item]))
    return this.stats
  }

  async inspect(reference) {
    try {
      const value = await this.request('GET', `/images/${encodeURIComponent(reference)}/json`)
      return { id: value.Id, size: value.Size, arch: value.Architecture, references: value.RepoTags || [], digests: value.RepoDigests || [] }
    } catch (error) { if (error.dockerStatus === 404) return null; throw error }
  }

  async referenced(id) {
    const containers = await this.request('GET', '/containers/json?all=1')
    return containers.some((container) => container.ImageID === id)
  }

  pull(reference) { return this.request('POST', `/images/create?fromImage=${encodeURIComponent(reference)}`, true) }
  remove(reference) { return this.request('DELETE', `/images/${encodeURIComponent(reference)}?force=false&noprune=true`) }
}

module.exports = { DockerImageStore, poolError, desktopSpace, pullError }
