const path = require('node:path');
const storage = require('./project-storage.cjs');

function prepare(file) {
  const config = storage.readConfig(file);
  const home = config.runtime.home;
  if (home !== process.env.AGENT_INSIGHT_HOME) throw Error('runtime.home 必须指向项目容器的持久运行目录');
  if (Number(process.env.PORT || 3000) !== config.runtime.webPort) throw Error('runtime.webPort 必须与容器 PORT 一致；宿主机端口可通过 WEB_HOST_PORT 指定');
  storage.legacyGuard(config, process.env);
  const state = path.join(home, 'storage/core/external-initialization.json');
  storage.probe(config, 'python3', true, state);
  storage.configurationFile(config, home);
}

try {
  prepare(process.argv[2]);
} catch (error) {
  console.error('[配置失败]', process.env.AGENT_INSIGHT_STORAGE_CONFIG_SOURCE || process.argv[2], error.message);
  process.exitCode = 1;
}
