"""Publish the frozen v6.2 regression evidence without rewriting previous results."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean
import shutil
import sys

root, output = map(Path, sys.argv[1:3])
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V6', 'V61', 'REPLAY', 'BOUND', 'PRICED', 'V62']
audit = json.loads((root/'verification.json').read_text())
assert audit['passed'] and audit['datasets'] == 8
reports = {name: json.loads((root/f'{name}.json').read_text()) for name in names}
out = output/'examples'/'budgeted-v62'
out.mkdir(parents=True, exist_ok=True)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
for name, report in reports.items():
    assert report.get('finishedAt') and not report['plan']['smoke']
    for file, expected in report['plan']['codeHashes'].items(): assert sha(file) == expected
    with (out/f'{name}.json.gz').open('wb') as handle:
        with gzip.GzipFile(filename='', mode='wb', fileobj=handle, mtime=0) as z: z.write((root/f'{name}.json').read_bytes())
files = ['plan.json', 'verification.json', 'test-status.json', 'quality-diagnostic.json', 'full-failure-names.json']
files += [f'performance-{s}{v}.json' for s in ['', 'long-'] for v in ['v5', 'v61', 'v62']]
files += [f'performance-repeat{repeat}-{v}.json' for repeat in [2, 3] for v in ['v5', 'v62']]
for file in files: shutil.copyfile(root/file, out/file)
primary, quality, flat, sizes, budgets = [], [], [], [], []
for name, report in reports.items():
    groups = {}
    for s in report['scenarios']:
        for m, run in s['methods'].items():
            flat.append(dict(dataset=name, stratum=s['stratum'], population=s['population'], seed=s['seed'], k=s['k'], method=m, vocabulary=run['metrics']['vocabulary'], tokens=run['metrics']['tokens'], quality=json.dumps(run['metrics']['quality']), selection_ms=run['selectionMs'], optimization=json.dumps(run.get('optimization'))))
        if s['k'] == 100: groups.setdefault((s['stratum'], s['population']), []).append(s)
        elif s['population'] == 'all': sizes.append(dict(dataset=name, **s))
        if s['seed'] == 42 and s['k'] == 100 and s['population'] == 'all': budgets.append(dict(dataset=name, **s))
    for (stratum, population), trials in groups.items():
        assert sorted(t['seed'] for t in trials) == [42, 100, 101, 102, 103]
        equal = [e for e in audit['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(equal) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(t['methods'][m]['metrics'][k] for t in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in equal) for m in ['B0', 'B4', 'C', 'V6', 'V61', 'V62']}, feasible=sum(t['methods']['V62']['optimization']['feasible'] for t in trials)))
        for axis in trials[0]['methods']['V62']['metrics']['quality']:
            quality.append(dict(dataset=name, stratum=stratum, population=population, axis=axis, **{m: mean(t['methods'][m]['metrics']['quality'][axis]['mean'] for t in trials) for m in methods}))

def label(r): return r['dataset'] + (' / '+r['stratum'] if r['stratum'] != 'all' else '')
def gain(r, m): return 100*(r['methods'][m]['vocabulary']/r['methods']['B0']['vocabulary']-1)
def pct(v): return f'{v:+.2f}%'
def table(headers, rows): return '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |'] + ['| '+' | '.join(map(str, row))+' |' for row in rows])
coverage = [r for r in primary if r['population'] == 'all' and r['dataset'] in ms]
mainq = [r for r in quality if (r['dataset'] == 'OASST2' and r['population'] == 'quality-annotated' and r['axis'] == 'quality') or (r['dataset'] == 'HelpSteer2' and r['axis'] == 'helpfulness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] == 'overall')]
gates = []
for r in coverage:
    value, target, reasons = gain(r, 'V62'), max(ms[r['dataset']]+5, gain(r, 'C')), []
    if value < target: reasons.append('覆盖不足')
    if r['equal']['V62'] < r['equal']['C']: reasons.append('同 token 覆盖低于 v5')
    if r['feasible'] < 5: reasons.append('存在不可行回退')
    gates.append(dict(condition=label(r)+' / 词汇', value=value, target=target, passed=not reasons, reason='；'.join(reasons) or '覆盖及成本条件通过'))
for r in mainq:
    target = max(r['B0'], r['B4']) if r['dataset'] == 'HelpSteer2' else max(1.1*r['B0'], r['C'])
    gates.append(dict(condition=label(r)+' / '+r['axis'], value=r['V62'], target=target, passed=r['V62'] >= target, reason='人工评分不足' if r['V62'] < target else '人工评分条件通过'))
assert len(gates) == 11
summary = dict(status='offline_not_enabled', default='trace-coverage-v4', candidate='trace-coverage-v6.2', primary=primary, quality=quality, gates=gates, passed=sum(g['passed'] for g in gates), independentConfirmation='not_run')
(out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (out/'metrics.csv').open('w', newline='') as handle:
    w = csv.DictWriter(handle, fieldnames=flat[0]); w.writeheader(); w.writerows(flat)
ct = table(['数据集', '微软公开', '默认 v4', 'v5', 'v6', 'v6.1', 'v6.2', 'v6.2 − 微软（百分点）'], [[r['dataset'], pct(ms[r['dataset']]), *[pct(gain(r, m)) for m in ['B4', 'C', 'V6', 'V61', 'V62']], f"{gain(r, 'V62')-ms[r['dataset']]:+.3f}"] for r in coverage])
qt = table(['数据 / 评分', '随机', 'v4', 'v5', 'v6', 'v6.1', 'v6.2', 'v6.2 − v6.1'], [[label(r)+' / '+r['axis'], *[f'{r[m]:.3f}' for m in ['B0', 'B4', 'C', 'V6', 'V61', 'V62']], f"{r['V62']-r['V61']:+.3f}"] for r in mainq])
gt = table(['条件', 'v6.2 实测', '目标下限', '状态 / 原因'], [[g['condition'], f"{g['value']:.3f}", f"{g['target']:.3f}", ('通过：' if g['passed'] else '未通过：')+g['reason']] for g in gates])
at = table(['数据及分层', 'v6.1 覆盖增幅', 'BOUND', 'PRICED', 'v6.2', '同 token：v6.2 对 v5', '同 token：v6.2 对 v6.1'], [[label(r), *[pct(gain(r, m)) for m in ['V61', 'BOUND', 'PRICED', 'V62']], pct(100*(r['equal']['V62']/r['equal']['C']-1)), pct(100*(r['equal']['V62']/r['equal']['V61']-1))] for r in primary if r['population'] == 'all'])
aq = table(['质量轴', 'BOUND', 'PRICED', 'v6.2'], [[label(r)+' / '+r['axis'], *[f'{r[m]:.3f}' for m in ['BOUND', 'PRICED', 'V62']]] for r in mainq])
cost = table(['数据及分层', 'v5 token / 随机', 'v6.1', 'v6.2'], [[label(r), *[f"{r['methods'][m]['tokens']/r['methods']['B0']['tokens']:.3f}×" for m in ['C', 'V61', 'V62']]] for r in primary if r['population'] == 'all'])
st = table(['数据及分层', 'K，seed=42', 'v6.1 覆盖增幅', 'v6.2', 'v6.2 可行'], [[label(s), s['k'], *[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in ['V61', 'V62']], s['methods']['V62']['optimization']['feasible']] for s in sizes])
bt = table(['数据及分层', '预算倍率', '覆盖增幅', 'token / B_ref', '可行'], [[label(s), ratio, pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)), f"{s['methods'][m]['metrics']['tokens']/s['methods'][m]['optimization']['baseTokens']:.3f}×", s['methods'][m]['optimization']['feasible']] for s in budgets for ratio, m in [(1, 'V62_1'), (1.1, 'V62'), (1.2, 'V62_1.2')]])
guards = [r for r in quality if (r['dataset'] == 'HelpSteer2' and r['axis'] == 'correctness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] in ['accuracy', 'coverage', 'coherence'])]
guard = table(['质量防退步轴', '随机', 'v4', 'v5', 'v6', 'v6.1', 'v6.2'], [[label(r)+' / '+r['axis'], *[f'{r[m]:.3f}' for m in ['B0', 'B4', 'C', 'V6', 'V61', 'V62']]] for r in guards])
perf = []
for suffix, scenario in [('', 'N=10k 短输入'), ('long-', 'N=1k 长输入')]:
    runs = {v: json.loads((root/f'performance-{suffix}{v}.json').read_text()) for v in ['v5', 'v61', 'v62']}
    assert runs['v5']['hardware'] == runs['v61']['hardware'] == runs['v62']['hardware']
    for run in runs.values():
        for f, h in run['codeHashes'].items(): assert sha(f) == h
    for i in range(3):
        measured = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(m['count'] == min(m['k'], m['n']) for m in measured.values())
        ratio = measured['v62']['selectionMs']/measured['v5']['selectionMs']
        memory = measured['v62']['additionalHighWaterKiB']/max(1, measured['v5']['additionalHighWaterKiB'])
        perf.append(dict(scenario=scenario, k=measured['v5']['k'], runs=measured, ratioToV5=ratio, highWaterRatioToV5=memory, timeGate=ratio <= 3, highWaterGate=memory <= 1.5))
(out/'performance-summary.json').write_text(json.dumps(perf, indent=2))
pt = table(['场景', 'K', 'v5', 'v6.1', 'v6.2', 'v6.2 / v5', '3 倍耗时门槛'], [[p['scenario'], p['k'], *[f"{p['runs'][v]['selectionMs']/1000:.3f}s" for v in ['v5', 'v61', 'v62']], f"{p['ratioToV5']:.2f}×", '通过' if p['timeGate'] else '未通过'] for p in perf])
mt = table(['场景', 'K', 'v5 / v6.1 / v6.2 峰值 RSS MiB', '相应高水位增量 MiB', '增量 1.5 倍门槛（代理）'], [[p['scenario'], p['k'], ' / '.join(f"{p['runs'][v]['maxRssKiB']/1024:.1f}" for v in ['v5', 'v61', 'v62']), ' / '.join(f"{p['runs'][v]['additionalHighWaterKiB']/1024:.1f}" for v in ['v5', 'v61', 'v62']), '通过' if p['highWaterGate'] else '未通过'] for p in perf])
repeats = [{v: json.loads((root/f'performance-{v}.json').read_text()) for v in ['v5', 'v62']}]
for repeat in [2, 3]:
    runs = {v: json.loads((root/f'performance-repeat{repeat}-{v}.json').read_text()) for v in ['v5', 'v62']}
    for run in runs.values():
        assert run['hardware'] == repeats[0]['v5']['hardware']
        for f, h in run['codeHashes'].items(): assert sha(f) == h
    repeats.append(runs)
repeat_rows = []
for i in range(3):
    timing = {v: [r[v]['measurements'][i]['selectionMs']/1000 for r in repeats] for v in ['v5', 'v62']}
    ratios = [b/a for a, b in zip(timing['v5'], timing['v62'])]
    repeat_rows.append([repeats[0]['v5']['measurements'][i]['k'], *[f'{min(timing[v]):.3f}–{max(timing[v]):.3f}s' for v in ['v5', 'v62']], f'{min(ratios):.2f}–{max(ratios):.2f}×', '三轮均通过' if max(ratios) <= 3 else '存在未通过轮次'])
rt = table(['短输入 K', 'v5 三轮范围', 'v6.2 三轮范围', '对应轮次耗时比范围', '3 倍门槛'], repeat_rows)
diag = json.loads((root/'quality-diagnostic.json').read_text())
diagnosis = []
for r in diag['reports']:
    a = 'quality' if r['dataset'] == 'OASST2' else 'helpfulness' if r['dataset'] == 'HelpSteer2' else 'overall'
    diagnosis.append([label(r), f"{r['poolQuality'][a]:.3f}", *[f"{mean(t['quality'][a][key] for t in r['trials']):.3f}" for key in ['actual', 'inputMean']], ' / '.join(f"{q['quality'][a]:.3f}" for q in r['quartiles'])])
dt = table(['数据及分层', '全池质量均值', 'v6.1 实际均值', '所选输入的池内回答均值', '按输入长度四分位的质量均值（短→长）'], diagnosis)
fallbacks = sum(not c['feasible'] for c in audit['constraints'] if c['method'] == 'V62')
status = json.loads((root/'test-status.json').read_text())
assert status['typecheckPassed'] and status['scriptTypecheckPassed']
assert sha('scripts/trace-datasets/audit-exchange-v62.ts') == audit['auditorSha256']
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots(figsize=(14, 8), layout='constrained')
y = np.arange(6)
for offset, m, color, name in [(-.3, 'MS', '#b45309', 'Microsoft (published)'), (-.1, 'C', '#4f46e5', 'v5'), (.1, 'V61', '#0f766e', 'v6.1'), (.3, 'V62', '#0369a1', 'v6.2 (offline)')]:
    values = [ms[r['dataset']] if m == 'MS' else gain(r, m) for r in coverage]
    bars = ax.barh(y+offset, values, height=.19, color=color, label=name)
    ax.bar_label(bars, labels=[f'{v:+.2f}%' for v in values], padding=3, fontsize=8)
ax.set_yticks(y, [r['dataset'] for r in coverage]); ax.invert_yaxis(); ax.grid(axis='x', alpha=.2); ax.set_axisbelow(True); ax.margins(x=.15)
ax.set_xlabel('Distinct input vocabulary uplift over each random baseline (%)')
ax.set_title('Microsoft vs v5 / v6.1 / v6.2\nDifferent Microsoft pool/protocol: numerical targets, not a head-to-head comparison')
ax.legend(loc='lower right', fontsize=8)
fig.savefig(out/'comparison.png', dpi=170); fig.savefig(out/'comparison.svg', metadata={'Date': None}); plt.close(fig)
text = f'''<!-- V62-REPORT-START -->
## v6.2：保持原门槛，继续优化预算搜索与性能

**当前默认仍为 v4，v6.2 仅为离线候选。11 项主要效果条件通过 {summary['passed']} 项，整体目标尚未完成。** 本轮没有放宽“微软公开增幅 +5 个百分点”、不低于 v5、同 token 覆盖、质量或性能要求；不使用 LLM、人工标签选样、数据源专用规则或新增生产存储。

本轮覆盖及成本通过项为 { '、'.join(g['condition'].split(' / ')[0] for g in gates[:6] if g['passed']) }。WildChat 的同 token 覆盖恢复到 v5 以上；Dolly 的原始覆盖虽提高，同 token 覆盖却退步，失去上一轮的通过状态。CNN-DM 质量也下降，因此不能将 v6.2 视为全面替代 v6.1 的版本。

### 微软与本地各版本直接对照

{ct}

本表是原始词汇覆盖增幅的效果对照；下方门槛表前六行在这些数值上进一步检查同 token 成本和可行性。微软来自[公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)，本地为同一冻结池 K=100、五种子均值；双方池和协议不同，不能据此宣称算法严格优于微软。

![微软与本地候选直接对照](examples/budgeted-v62/comparison.png)

### 质量与逐项门槛

{qt}

{gt}

门槛表前六行的单位为覆盖增幅百分数，要求至少 `max(微软公开增幅+5个百分点, v5增幅)`，同 token 覆盖不低于 v5，且五次都满足预算与分布条件。后五行为人工评分均值：OASST2 和三个摘要分层至少为随机的 1.10 倍且不低于 v5；HelpSteer2 至少恢复到随机及 v4。人工标签始终只用于选样后的评分，不能把原始覆盖提高视为质量达标。

### 改动与消融

1. **BOUND**：计算覆盖上界 `min(全池词项数, 最大K组词项数之和, 共享词项数+最大K组独占词项数之和)`。可行结果达到上界时结束搜索；上界未达到时仍按约束搜索。它只证明当前输入词项目标的最优值，不证明语义或质量最优，也不要求保留同分时旧版的 ID。
2. **PRICED**：保留完整 v6.1 改善后的解，再补三条构造路径，按 `新增词项数−价格×输入token数` 选择。价格为 v5 起点经已执行修复及交换后的覆盖/预算基准的 0.25、0.5、1 倍，全数据源使用同一规则；最终仍按原始覆盖、分布偏移和成本选优。
3. **v6.2**：最多尝试四组先节省预算、再做正收益替换的组合。单个中间步骤允许降低覆盖；最终必须提高覆盖且满足全部约束，否则恢复原选择及路径计数。未找到可行解仍显式回退 v4。

关闭三项新增能力的 REPLAY 分支在全部 {audit['scenarios']} 个场景逐项复现冻结 v6.1 ID。v6.1 原本可行时，v6.2 的最终原始覆盖不低于它；这不保证同 token 指标或质量不退步，仍按实际结果验收。

{at}

{aq}

{cost}

同 token 指每次试验六个方法 `min(B0,B4,C,V6,V61,V62)` 的总输入词法 token 数，按固定哈希顺序读取，最后一个输入只在统计中截断；原文和生成样本均不改变。它不是模型计费 token。主预算继续为 `floor(1.10×min(K,N)×独立输入平均词法token数)`；随机样本成本不等于全池均值，token/随机不能当作预算利用率。

### 质量下降诊断

{dt}

此处仅分析上一轮 v6.1：同输入不同回答先按规范化问答聚合评分，再对池内回答取均值。多数分层中，实际选中回答均值高于所选输入的回答均值；质量下降不能简单归咎于挑到了较差的回答变体。HelpSteer2 与部分摘要分层的长输入对应较低评分，OASST2 则没有同样方向。因此不能把“越短越好”实现为通用质量规则。这些是已知回归池内的相关性诊断，未用于质量预测或来源专用选样。

### 三版本同机串行性能

{pt}

{mt}

特征与 MinHash 计算耗时另列原始 JSON，表中为完整选样路径耗时。上界提前结束属于被测算法本身。六次测试在公开实验和全仓测试完成后串行执行；同机服务可能存在背景负载，一轮基准不代表所有生产负载。RSS 增量是特征构造后跨 K 累计的进程高水位差，不能替代精确分配量或四 Worker 压力验证。资源代理通过也不代表完整工程放行。

因首轮短输入计时存在波动，追加两轮独立进程交替测量 v5/v6.2，保留全部三轮结果，不挑最快值：

{rt}

### K、预算与质量防退步

{st}

全部 {audit['scenarios']} 个主/尺寸场景中，v6.2 显式回退 {fallbacks} 次。K=20/500 只运行 seed=42，不能当作独立来源确认。

{bt}

预算曲线只运行 seed=42；1.20 倍预算收益不计作主门槛通过。

{guard}

### 验证与边界

算法专项 {status['targeted']['pass']}/{status['targeted']['tests']} 通过；SQLite/Worker 集成复跑 {status['integration']['pass']}/{status['integration']['tests']} 通过。首次并行专项曾遇到集成进程 SIGABRT，复跑情况保留在测试记录中。全仓 {status['full']['tests']} 项，{status['full']['pass']} 通过、{status['full']['fail']} 失败、{status['full']['skipped']} 跳过。最终全项目与研究脚本严格类型检查通过，见[测试记录](examples/budgeted-v62/test-status.json)。独立审计从原文复算 {audit['selectedItems']:,} 个入选项及 {audit['qualityMeans']:,} 个人工均值，检查输入哈希、预算、分布、上界、回退和旧版 ID。

本轮按冻结源文件和映射 SHA 恢复八源原始数据，未将下载后的新版本混入旧池。仍是已知回归证据，尚未完成新来源组独立确认、微软算法同池运行或完整四 Worker/生产链路验证。v6.2 未接入 Worker/API，本轮未在浏览器中验证；历史 v4 UI 证据不能替代新版验收，用户指南仍描述当前生产操作。

[汇总](examples/budgeted-v62/summary.json) · [逐次 CSV](examples/budgeted-v62/metrics.csv) · [独立审计](examples/budgeted-v62/verification.json) · [冻结协议](examples/budgeted-v62/plan.json) · [性能](examples/budgeted-v62/performance-summary.json) · [质量诊断](examples/budgeted-v62/quality-diagnostic.json) · [源码](../../../src/lib/trace-datasets/sampling/budgeted-exchange.ts)

复现：`restore-frozen-data.py <data目录>` 恢复并校验输入；`compare-exchange-v62.ts <data> <v4> <v5> <v6> <v6.1> <新输出目录>` 运行比较，之后用相同路径执行 `audit-exchange-v62.ts`；`benchmark-exchange.ts --v5/--v61` 或不加版本参数测三版，`--long` 测长输入。最后执行 `report-exchange-v62.py <新输出目录> docs/design/trace-eval-dataset`。Python 研究依赖安装在临时目录，项目依赖未变更。

以下保留此前轮次的结果，当前状态以上述章节为准。
<!-- V62-REPORT-END -->
'''
file = output/'eight-datasets-comparison-report.md'
old = file.read_text()
if '<!-- V62-REPORT-START -->' in old:
    a, b = old.index('<!-- V62-REPORT-START -->'), old.index('<!-- V62-REPORT-END -->')+len('<!-- V62-REPORT-END -->')
    old = old[:a]+old[b:].lstrip('\n')
first, rest = old.split('\n', 1)
file.write_text(first+'\n\n'+text+'\n'+rest.lstrip('\n'))
sources = ['src/lib/trace-datasets/sampling/budgeted-exchange.ts', 'test/trace-datasets-budgeted-exchange.test.ts', 'test/trace-datasets-integration.test.ts'] + ['scripts/trace-datasets/'+f for f in ['restore-frozen-data.py', 'compare-exchange-v62.ts', 'audit-exchange-v62.ts', 'diagnose-quality-v62.ts', 'benchmark-exchange.ts', 'report-exchange-v62.py']]
(out/'implementation.json').write_text(json.dumps({f: sha(f) for f in sources}, indent=2))
print(json.dumps({'passed': summary['passed'], 'total': 11, 'fallbacks': fallbacks}))
