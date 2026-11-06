import path from 'node:path';

export const requiredStages = ['application', 'login', 'model', 'ordinary-client', 'ras-client', 'fixtures', 'cleanup'];
export function requiredStagesFor(caseId = '001') {
  if (caseId === '001') return requiredStages;
  if (caseId === '002') return ['application', 'fixture', 'native-task', 'ingest', 'trace-ui', 'agent-ui', 'cleanup'];
  if (caseId === '003') return ['application', 'login', 'model', 'ordinary-client', 'upload', 'generation', 'static', 'baseline-publish', 'dataset-ui', 'baseline', 'trace-ui', 'diagnosis', 'optimization', 'candidate', 'publish', 'published-run', 'persistence', 'cleanup'];
  if (caseId === '004') return ['application', 'login', 'model', 'ordinary-client', 'trace-fixture', 'baseline-run', 'skill-binding', 'trace-ui', 'baseline-evaluation', 'diagnosis', 'skill-verification', 'optimization', 'candidate-run', 'candidate-evaluation', 'persistence', 'cleanup'];
  if (caseId === '006') return ['application','login','model','ras-client','ras-config','fault-fixture','injection','ras-evidence','reliability-evaluation','fault-trace-ui','recovery','persistence','cleanup'];
  throw new Error(`Scenario ${caseId} is not implemented`);
}

export function stageFailureStatus(error) { return error?.code === 'E2E_BLOCKED' ? 'BLOCKED' : 'FAIL'; }

export function scenarioResult(stages, caseId = '001') {
  const required = requiredStagesFor(caseId);
  const failed = stages.find(s => s.status === 'FAIL');
  const blocked = stages.find(s => s.status === 'BLOCKED');
  const complete = required.every(id => stages.some(s => s.id === id && s.status === 'PASS'));
  return { status: failed ? 'FAIL' : blocked ? 'BLOCKED' : complete ? 'PASS' : 'PARTIAL', firstProblem: failed?.id || blocked?.id || required.find(id => !stages.some(s => s.id === id && s.status === 'PASS')) || null };
}

export function assertRunRoot(project, root) {
  const allowed = path.join(path.resolve(project), 'exclude', 'core-e2e') + path.sep;
  if (!path.resolve(root).startsWith(allowed)) throw new Error('An isolated run root inside exclude/core-e2e is required');
}

export function redact(text, secrets = []) {
  let safe = String(text);
  for (const value of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const encoded of new Set([value, encodeURIComponent(value)])) safe = safe.split(encoded).join('[REDACTED]');
  }
  return safe.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/([?&](?:key|token|apiKey)=)[^\s"&<>]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function renderReport(report) {
  const boundaries = report.coverageNotes?.length ? `<h2>未覆盖与边界</h2><ul>${report.coverageNotes.map(note => `<li>${escape(note)}</li>`).join('')}</ul>` : '';
  const findings = report.findings?.length ? `<h2>本轮问题</h2>${report.findings.map(item => `<p>${escape(item.summary)}。分类：${escape(item.classification)}；独立复现：${item.confirmedByRealExecution ? '已确认' : '未确认'}。</p>`).join('')}` : '';
  const evidence = `<h2>证据与复现</h2><p>${(report.artifacts || []).map(file => `<a href="${escape(file)}">${escape(file)}</a>`).join(' · ')}</p><pre>${escape(report.reproduction || '')}</pre>`;
  const statusLabel = { PASS: '通过', FAIL: '未通过', BLOCKED: '阻塞', PARTIAL: '不完整', NOT_RUN: '未执行', RUNNING: '进行中' };
  const stageLabel = { 'ras-config':'RAS 配置与同步','fault-fixture':'可靠性单题与故障夹具','injection':'真实故障注入','ras-evidence':'真实检测、处置与原生中断','reliability-evaluation':'可靠性三维评估','fault-trace-ui':'故障 Trace 页面','recovery':'同客户端恢复探测', 'builtin-fixture':'历史内置原题与 v0 快照', 'dataset-fixture':'私有 Skill 与原日志', 'dataset-ui':'页面构建并保存数据集', 'skill-binding': '原生 Skill 与版本关联', 'skill-verification': 'Skills 关键动作核验', 'trace-fixture': '独立基线与日志', 'baseline-run': '已有真实 Trace', 'baseline-evaluation': '已有 Trace 无数据集评测', diagnosis: '真实智能诊断与证据', 'candidate-run': '候选原任务直接重跑', 'candidate-evaluation': '候选 Trace 无数据集评测', persistence: '刷新、旧版保留与依赖审计', upload: '原包上传与文件保真', generation: '真实 Skill 生成', static: '静态质量评估', 'baseline-publish': '发布基线', baseline: '基线行为实验', optimization: '定向优化与候选', candidate: '最终候选行为验证', publish: '发布优化版', 'published-run': '发布版复跑与刷新', application: '隔离应用与数据库', login: '登录', model: 'DeepSeek 配置', 'ordinary-client': '普通 OpenCode 客户端', 'ras-client': 'RAS 兼容客户端', fixtures: '后续测试数据', cleanup: '清理', fixture: '独立采集前置', 'native-task': '真实日志读取', ingest: '上报、入库与内容', 'trace-ui': 'Trace 页面验证', 'agent-ui': 'Agent 页面与链路回跳' };
  const diagnostic = report.diagnostics ? `<h2>当前问题</h2><p>RAS 客户端能力发现超时，Agent / 模型清单尚未就绪。Python 进程内桥接：${report.diagnostics.currentRunRasBridgeHello ? '已通过' : '未验证'}。根因仍需定位，尚未认定产品缺陷。</p><details><summary>客户端最后上报证据</summary><pre>${escape(JSON.stringify(report.diagnostics.lastClientInventory, null, 2))}</pre></details>` : '';
  const npm = renderNpmResult(report.npmTest);
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>核心 E2E ${escape(report.runId)}</title><style>body{font:15px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:10px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}a{color:#4338ca}</style><h1>核心 E2E：${escape(report.runId)}</h1><p>模式：${escape(report.mode)}；本轮仅执行 ${escape(report.selectedCase || "001")}。未执行项不能算通过。</p><table><tr><th>例子</th><th>结果</th><th>首个问题阶段</th></tr>${report.scenarios.map(s => `<tr><td>${escape(s.id)} ${escape(s.title)}</td><td>${escape(statusLabel[s.status] || s.status)}</td><td>${escape(stageLabel[s.firstProblem] || s.firstProblem || '—')}</td></tr>`).join('')}</table>${boundaries}${findings}${report.scenarios.filter(s => s.stages?.length).map(s => `<h2>${escape(s.id)} 阶段结果</h2>${s.stages.map(t => `<details ${['FAIL', 'BLOCKED'].includes(t.status) ? 'open' : ''}><summary>${escape(stageLabel[t.id] || t.id)}：${escape(statusLabel[t.status] || t.status)}</summary><p>预期：${escape(t.expected)}</p><pre>实际：${escape(typeof t.actual === 'object' ? JSON.stringify(t.actual, null, 2) : t.actual)}</pre></details>`).join('')}`).join('')}${diagnostic}${npm}${evidence}<p>报告由代码生成，不调用模型。原始浏览器记录可能包含凭证，仅在 private 目录受限保存。</p></html>`;
}

export function renderNpmResult(result) {
  const counts = result?.observedSummary;
  return counts
    ? `<h2>npm test（独立统计）</h2><p>${result.interrupted ? '已中断；非完整结果，以下为日志已观测计数，不能视为完整套件结论。' : result.fullSuiteComplete ? '结果完整。' : '非完整结果。'}</p><p>总数 ${escape(counts.tests)}；通过 ${escape(counts.pass)}；失败 ${escape(counts.fail)}；跳过 ${escape(counts.skipped)}；取消 ${escape(counts.cancelled ?? 0)}。</p><p>${escape(result.reason || '')}</p>`
    : result
      ? `<h2>npm test（独立统计）</h2><p>${result.interrupted ? '已中断；' : ''}未取得完整汇总，总数、通过、失败和跳过均未知，不能视为完整套件结论。</p><p>${escape(result.reason || '')}</p>`
      : '<h2>npm test（独立统计）</h2><p>此报告尚未附加 npm test 结果。</p>';
}
