const fs = require('node:fs');
const path = require('node:path');
const install = require('./local-runtime-install.cjs');
async function upgrade(home, env, args, runtime) {
  if (args.length !== 1 || !['--plan', '--apply'].includes(args[0])) throw new Error('Usage: bash scripts/storage_upgrade.sh --plan|--apply');
  const release = await runtime.lock(home);
  const started = [];
  try {
    const file = env.AGENT_INSIGHT_STORAGE_CORE_CONFIG || path.join(home, 'storage/core/trace-service.json');
    const cfg = runtime.readPrivate(file);
    if (fs.existsSync(file + '.initializing')) throw new Error('首次初始化尚未完成，请重试启动流程，不要执行版本升级');
    const managedFile = path.join(path.dirname(file), 'managed-clickhouse.json');
    if (cfg.control.backend !== 'sqlite' || !fs.existsSync(managedFile)) throw new Error('此入口仅自动升级托管 SQLite + ClickHouse；外部数据库请使用显式迁移与外部备份证据');
    const managed = runtime.readPrivate(managedFile);
    if (!path.isAbsolute(cfg.control.database) || managed.endpoint !== cfg.clickhouse.endpoint) throw new Error('数据库路径或 ClickHouse 托管记录与 Core 配置不一致');
    require('./storage-core-preflight.cjs').validateConfiguration(runtime.coreEnvironment(cfg, env));
    const python = install.python(home, env);
    const binary = await install.clickhouse(home, env);
    async function startCH() {
      if (!runtime.alive(runtime.record(home, 'clickhouse'))) {
        await runtime.assertFree(runtime.port(new URL(managed.endpoint).port, 8123));
        await runtime.launch(home, 'clickhouse', binary, ['server', `--config-file=${managed.config}`], env);
        started.push('clickhouse');
      }
      await runtime.waitReady(home, 'clickhouse', () => runtime.healthy(managed.endpoint + '/ping'));
    }
    if (args[0] === '--plan') {
      await startCH();
      install.command(python, [path.join(__dirname, 'local-storage.py'), 'upgrade', '--config', file]);
      return;
    }
    await runtime.stop(home, 'web');
    await runtime.stop(home, 'core');
    await runtime.assertFree(cfg.port);
    await runtime.stop(home, 'clickhouse');
    await runtime.assertFree(runtime.port(new URL(managed.endpoint).port, 8123));
    const backup = path.join(home, 'backups', `storage-${new Date().toISOString().replaceAll(':', '-')}`);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    console.log(`[备份] ${backup}`);
    // Both services are stopped: the SQLite snapshot and analytical files share a quiescent boundary.
    install.command(python, ['-c', 'import sqlite3,sys,pathlib; s=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()', cfg.control.database, path.join(backup, 'core.db')]);
    fs.chmodSync(path.join(backup, 'core.db'), 0o600);
    const artifacts = cfg.control.database + '.artifacts';
    if (fs.existsSync(artifacts)) fs.cpSync(artifacts, path.join(backup, 'core.db.artifacts'), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    fs.cpSync(managed.data, path.join(backup, 'clickhouse-data'), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    fs.copyFileSync(file, path.join(backup, 'trace-service.json'));
    fs.copyFileSync(cfg.controller_key_file, path.join(backup, 'controller-key'));
    fs.copyFileSync(managedFile, path.join(backup, 'managed-clickhouse.json'));
    fs.copyFileSync(managed.config, path.join(backup, 'clickhouse-config.xml'));
    const migrationBackup = path.join(path.dirname(cfg.control.database), `${path.basename(cfg.control.database)}.${path.basename(backup)}.backup`);
    runtime.privateWrite(path.join(backup, 'manifest.json'), { status: 'backup-complete', config: file, database: cfg.control.database, clickhouseData: managed.data, migrationBackup });
    await startCH();
    install.command(python, [path.join(__dirname, 'local-storage.py'), 'upgrade', '--config', file, '--backup', migrationBackup]);
    if (fs.existsSync(migrationBackup)) fs.copyFileSync(migrationBackup, path.join(backup, 'before-transaction-migration.db'));
    runtime.privateWrite(path.join(backup, 'upgrade-complete.json'), { status: 'complete', completedAt: new Date().toISOString() });
    console.log(`[完成] 升级检查通过，备份：${backup}。请重新执行启动脚本；回滚必须协调恢复事务库、ClickHouse 和制品。`);
  } finally {
    try {
      for (const name of [...new Set(started)].reverse()) await runtime.stop(home, name);
    } finally { release(); }
  }
}
module.exports = { upgrade };
