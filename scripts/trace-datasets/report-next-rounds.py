"""Publish three frozen rounds, including unsuccessful gates and earlier evidence."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean, median
import shutil
import sys

root, docs = map(Path, sys.argv[1:3])
out = docs/'examples'/'next-three-rounds-v68-v610'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
rounds = {'V68': 'v68', 'V69': 'v69', 'V610': 'v610'}
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V67', 'V68', 'V69', 'V610']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
table = lambda headers, rows: '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(map(str, row))+' |' for row in rows])
label = lambda r: r['dataset']+(' / '+r['stratum'] if r['stratum'] != 'all' else '')
pct = lambda n: f'{n:+.2f}%'
audits, reports = {}, {}
for method, directory in rounds.items():
    current = root/directory
    audits[method] = json.loads((current/'verification.json').read_text())
    assert audits[method]['passed'] and audits[method]['scenarios'] == 77
    assert audits[method]['auditorSha256'] == sha('scripts/trace-datasets/audit-next-rounds.ts')
    target = out/method.lower(); target.mkdir(exist_ok=True)
    for name in names:
        data = (current/f'{name}.json').read_bytes()
        report = json.loads(data); assert report['finishedAt']
        for file, digest in report['plan']['codeHashes'].items(): assert sha(file) == digest
        with (target/f'{name}.json.gz').open('wb') as handle:
            with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write(data)
        if method == 'V610': reports[name] = report
    for file in ['plan.json', 'verification.json']: shutil.copyfile(current/file, target/file)
primary, quality, flat, sizes, sensitivities = [], [], [], [], []
for name, report in reports.items():
    grouped = {}
    for s in report['scenarios']:
        for m, run in s['methods'].items():
            flat.append(dict(dataset=name, stratum=s['stratum'], population=s['population'], k=s['k'], seed=s['seed'], method=m, vocabulary=run['metrics']['vocabulary'], tokens=run['metrics']['tokens'], quality=json.dumps(run['metrics']['quality']), selection_ms=run['selectionMs']))
        if s['k'] == 100: grouped.setdefault((s['stratum'], s['population']), []).append(s)
        elif s['population'] == 'all': sizes.append(dict(dataset=name, **s))
        if s['k'] == 100 and s['seed'] == 42 and s['population'] == 'all': sensitivities.append(dict(dataset=name, **s))
    for (stratum, population), trials in grouped.items():
        assert sorted(s['seed'] for s in trials) == [42, 100, 101, 102, 103]
        eq = [e for e in audits['V610']['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(eq) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(s['methods'][m]['metrics'][k] for s in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in eq) for m in methods}, fixedEqual={m: mean(e['fixed'][m] for e in eq) for m in methods}, feasible={m: sum(s['methods'][m]['optimization']['feasible'] for s in trials) for m in rounds}, recallReplacements=mean(s['methods']['V69']['agreement']['recallReplacements'] for s in trials), tabuSteps=mean(s['methods']['V610']['tabu']['steps'] for s in trials), tabuBestUpdates=mean(s['methods']['V610']['tabu']['bestUpdates'] for s in trials), tabuNegativeMoves=mean(s['methods']['V610']['tabu']['negativeMoves'] for s in trials)))
        for axis in trials[0]['methods']['V610']['metrics']['quality']:
            quality.append(dict(dataset=name, stratum=stratum, population=population, axis=axis, **{m: mean(s['methods'][m]['metrics']['quality'][axis]['mean'] for s in trials) for m in methods}))
gain = lambda r, m: 100*(r['methods'][m]['vocabulary']/r['methods']['B0']['vocabulary']-1)
coverage = [r for r in primary if r['dataset'] in ms and r['population'] == 'all']
mainq = [r for r in quality if (r['dataset'] == 'OASST2' and r['population'] == 'quality-annotated' and r['axis'] == 'quality') or (r['dataset'] == 'HelpSteer2' and r['axis'] == 'helpfulness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] == 'overall')]
gates = {}
for m in rounds:
    gates[m] = []
    for r in coverage:
        target = max(ms[r['dataset']]+5, gain(r, 'C')); reasons = []
        if gain(r, m) < target: reasons.append('原始覆盖不足')
        eq = [e for e in audits[m]['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (r['dataset'], r['stratum'], r['population'], 100)]
        if mean(e[m] for e in eq) < mean(e['C'] for e in eq): reasons.append('同 token 低于 v5')
        if r['feasible'][m] < 5: reasons.append('不可行回退')
        gates[m].append(dict(condition=label(r)+' / 词汇', value=gain(r, m), target=target, passed=not reasons, reason='；'.join(reasons) or '通过'))
    for r in mainq:
        target = max(r['B0'], r['B4']) if r['dataset'] == 'HelpSteer2' else max(r['B0']*1.1, r['C'])
        gates[m].append(dict(condition=label(r)+' / '+r['axis'], value=r[m], target=target, passed=r[m] >= target, reason='通过' if r[m] >= target else '人工评分不足'))
    assert len(gates[m]) == 11
status = json.loads((root/'test-status.json').read_text())
assert status['focusedPassed'] and status['scriptTypecheckPassed']
for file in ['test-status.json', 'full-failure-names.json']: shutil.copyfile(root/file, out/file)
perf = []
for name in names:
    runs = {v: json.loads((root/'performance-final'/f'{name}-{v}.json').read_text()) for v in ['v5', 'v67', 'v68', 'v69', 'v610']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['sourceSha256'] == reports[name]['dataSha256']
        assert run['resultsSha256'] == sha(root/'v610'/f'{name}.json')
        assert run['hardware'] == runs['v5']['hardware']
        shutil.copyfile(root/'performance-final'/f'{name}-{v}.json', out/f'performance-{name}-{v}.json')
    for i in range(len(runs['v5']['measurements'])):
        selected = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(r['idsMatchFrozen'] for r in selected.values())
        ratios = {m: selected[m.lower()]['selectionMs']/selected['v5']['selectionMs'] for m in rounds}
        memory = {m: selected[m.lower()]['additionalHighWaterKiB']/selected['v5']['additionalHighWaterKiB'] if selected[m.lower()]['additionalHighWaterKiB'] and selected['v5']['additionalHighWaterKiB'] else None for m in rounds}
        perf.append(dict(dataset=name, stratum=selected['v5']['stratum'], runs=selected, ratios=ratios, memoryRatios=memory))
synthetic = []
for long in [False, True]:
    runs = {v: json.loads((root/'performance-final'/f'synthetic-{long}-{v}.json').read_text()) for v in ['v5', 'v68', 'v69', 'v610']}
    for v, run in runs.items():
        for file, digest in run['codeHashes'].items(): assert sha(file) == digest
        assert run['cacheKey'] == runs['v5']['cacheKey']
        shutil.copyfile(root/'performance-final'/f'synthetic-{long}-{v}.json', out/f'synthetic-{long}-{v}.json')
    for i in range(3):
        measurements = {v: r['measurements'][i] for v, r in runs.items()}
        assert all(r['count'] == r['k'] for r in measurements.values())
        synthetic.append(dict(scenario='N1k 长输入' if long else 'N10k 短输入', k=measurements['v5']['k'], runs=measurements, ratios={m: measurements[m.lower()]['selectionMs']/measurements['v5']['selectionMs'] for m in rounds}))
summary = dict(status='offline_not_enabled', default='trace-coverage-v4', roundsCompleted=3, earlyStopped=False, primary=primary, quality=quality, gates=gates, passed={m: sum(g['passed'] for g in gs) for m, gs in gates.items()}, performance=perf, synthetic=synthetic, independentConfirmation='not_run', browserValidated=False)
(out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (out/'metrics.csv').open('w', newline='') as h:
    writer = csv.DictWriter(h, fieldnames=flat[0]); writer.writeheader(); writer.writerows(flat)
ct = table(['数据集', '微软公开', 'v5', 'v6.7 / v6.8 / v6.9', 'v6.10', 'v6.10 − 微软（百分点）', '原目标', '距原目标（百分点）'], [[r['dataset'], pct(ms[r['dataset']]), pct(gain(r, 'C')), pct(gain(r, 'V67')), pct(gain(r, 'V610')), f"{gain(r, 'V610')-ms[r['dataset']]:+.2f}", pct(max(ms[r['dataset']]+5, gain(r, 'C'))), f"{gain(r, 'V610')-max(ms[r['dataset']]+5, gain(r, 'C')):+.2f}"] for r in coverage])
qt = table(['人工质量轴', '随机', 'v6.7 / v6.8', 'v6.9', 'v6.10', '原目标', 'v6.10 − v6.7'], [[label(r)+' / '+r['axis'], f"{r['B0']:.3f}", f"{r['V67']:.3f}", f"{r['V69']:.3f}", f"{r['V610']:.3f}", f"{gates['V610'][6+i]['target']:.3f}", f"{r['V610']-r['V67']:+.3f}"] for i, r in enumerate(mainq)])
gt = table(['原验收条件', '原目标', '第一轮 v6.8', '第二轮 v6.9', '第三轮 v6.10', 'v6.10 判定'], [[g['condition'], f"{g['target']:.3f}", *[f"{gates[m][i]['value']:.3f} / {'通过' if gates[m][i]['passed'] else '未通过'}" for m in rounds], g['reason']] for i, g in enumerate(gates['V610'])])
rt = table(['轮次', '调整', '主效果门槛', '真实池 3 倍耗时门槛', '提前停止条件'], [[m.replace('V6', 'v6.'), change, f"{summary['passed'][m]}/11", f"{sum(p['ratios'][m] <= 3 for p in perf)}/10", '未满足'] for m, change in zip(rounds, ['分块等价加速', '召回优先的回答共识', '有界禁忌搜索'])])
pt = table(['真实池 / K100 seed42', 'v5', 'v6.7', 'v6.8', 'v6.9', 'v6.10', 'v6.10 / v5'], [[label(p), *[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5', 'v67', 'v68', 'v69', 'v610']], f"{p['ratios']['V610']:.2f}×"] for p in perf])
mt = table(['真实池', 'v5 / v6.8 / v6.9 / v6.10 峰值 RSS MiB', '对应高水位增量 MiB', 'v6.10 增量 1.5 倍门槛'], [[label(p), ' / '.join(f"{p['runs'][m]['maxRssKiB']/1024:.1f}" for m in ['v5', 'v68', 'v69', 'v610']), ' / '.join(f"{p['runs'][m]['additionalHighWaterKiB']/1024:.1f}" for m in ['v5', 'v68', 'v69', 'v610']), '数据不足' if p['memoryRatios']['V610'] is None else '通过' if p['memoryRatios']['V610'] <= 1.5 else '未通过'] for p in perf])
synthetic_table = table(['合成边界场景', 'K', 'v5', 'v6.8', 'v6.9', 'v6.10', 'v6.10 / v5'], [[p['scenario'], p['k'], *[f"{p['runs'][m]['selectionMs']/1000:.3f}s" for m in ['v5', 'v68', 'v69', 'v610']], f"{p['ratios']['V610']:.2f}×"] for p in synthetic])
et = table(['数据及分层', 'v6.8 / v6.9 / v6.10 同 token 相对 v5', 'v6.9 回答替换数', 'v6.10 搜索步数 / 最好结果更新数 / 负收益步数'], [[label(r), ' / '.join(pct(100*(r['equal'][m]/r['equal']['C']-1)) for m in rounds), f"{r['recallReplacements']:.1f}", f"{r['tabuSteps']:.1f} / {r['tabuBestUpdates']:.1f} / {r['tabuNegativeMoves']:.1f}"] for r in primary if r['population'] == 'all'])

guards = [r for r in quality if (r['dataset'] == 'HelpSteer2' and r['axis'] == 'correctness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] in ['accuracy', 'coverage', 'coherence'])]
guard_table = table(['质量防退步轴', '随机', 'v4', 'v6.7 / v6.8', 'v6.9', 'v6.10'], [[label(r)+' / '+r['axis'], *[f'{r[m]:.3f}' for m in ['B0', 'B4', 'V67', 'V69', 'V610']]] for r in guards])
size_table = table(['数据及分层', 'K / seed42', 'v6.8', 'v6.9', 'v6.10', '三轮均可行'], [[label(s), s['k'], *[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds], all(s['methods'][m]['optimization']['feasible'] for m in rounds)] for s in sizes])
budget_table = table(['数据及分层', '预算', 'v6.8', 'v6.9', 'v6.10', '三轮均可行'], [[label(s), ratio, *[pct(100*(s['methods'][m+suffix]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in rounds], all(s['methods'][m+suffix]['optimization']['feasible'] for m in rounds)] for s in sensitivities for ratio, suffix in [(1, '_1'), (1.1, ''), (1.2, '_1.2')]])
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig, axes = plt.subplots(1, 2, figsize=(15, 7), layout='constrained')
y = np.arange(6)
for offset, values, color, title in [(-.22, [ms[r['dataset']] for r in coverage], '#b45309', 'Microsoft published'), (0, [gain(r, 'V67') for r in coverage], '#64748b', 'v6.7 / v6.8 / v6.9'), (.22, [gain(r, 'V610') for r in coverage], '#0369a1', 'v6.10')]:
    bars = axes[0].barh(y+offset, values, height=.2, color=color, label=title); axes[0].bar_label(bars, fmt='%.1f', padding=3, fontsize=8)
axes[0].scatter([max(ms[r['dataset']]+5, gain(r, 'C')) for r in coverage], y, marker='|', s=200, color='#dc2626', label='Original target')
axes[0].set_yticks(y, [r['dataset'] for r in coverage]); axes[0].invert_yaxis(); axes[0].set_xlabel('Vocabulary uplift over random (%)'); axes[0].set_title('Coverage: public numerical targets\nMicrosoft uses a different pool/protocol'); axes[0].legend(fontsize=8, loc='lower right'); axes[0].margins(x=.16)
yq = np.arange(5)
for offset, m, color in [(-.22, 'V67', '#64748b'), (0, 'V69', '#0f766e'), (.22, 'V610', '#0369a1')]:
    values = [100*r[m]/gates['V610'][6+i]['target'] for i, r in enumerate(mainq)]
    bars = axes[1].barh(yq+offset, values, height=.2, color=color, label=m.replace('V6', 'v6.')); axes[1].bar_label(bars, fmt='%.1f%%', padding=3, fontsize=8)
axes[1].axvline(100, color='#dc2626', linestyle='--', label='Original target'); axes[1].set_yticks(yq, ['OASST2 quality', 'HelpSteer2 helpfulness', 'CNN-DM overall', 'TLDR valid2 overall', 'TLDR valid1 overall']); axes[1].invert_yaxis(); axes[1].set_xlim(0, 117); axes[1].set_title('Human quality: percentage of target reached\nFrozen K100, five seeds; labels only after selection'); axes[1].legend(fontsize=8, loc='upper center', bbox_to_anchor=(.5, -.06), ncol=4)
for ax in axes: ax.grid(axis='x', alpha=.2); ax.set_axisbelow(True)
fig.savefig(out/'comparison.png', dpi=170); fig.savefig(out/'comparison.svg', metadata={'Date': None}); plt.close(fig)
text = f'''<!-- NEXT-THREE-ROUNDS-REPORT-START -->
## 再三轮优化完成：v6.8 / v6.9 / v6.10

**已完成本次授权的 3 轮，未提前停止；整体目标仍未达成，默认继续 v4。** 三轮主要效果门槛分别通过 {summary['passed']['V68']}/11、{summary['passed']['V69']}/11、{summary['passed']['V610']}/11。第二轮新增通过 OASST2 quality 与 CNN-DM overall；第三轮小幅提高覆盖，但没有新增通过项，TLDR/valid2 的人工质量反而小幅下降。

{rt}

### 与微软的差距，以及原要求的差距

{ct}

微软列沿用[既有公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)的冻结数值。各列是相对各自随机基线的词汇增幅；双方候选池、协议不同，这只是公开数值参照，不能据此宣称同池算法胜出。原目标仍为 max(微软公开增幅 + 5 个百分点, v5 增幅)，还要求同 token 覆盖、预算、分布等同时通过。NoRobots 和 OASST2 两项仍低于微软公开数值，也未达到原目标。

![三轮优化与微软、原目标的差距](examples/next-three-rounds-v68-v610/comparison.png)

### 人工质量与全部 11 项主条件

{qt}

第一张表是五种子 K100 人工评分均值，下面逐项表将六项覆盖条件与这五项质量条件合并验收，二者是同一批实验。OASST2 人工质量使用原来的 quality-annotated 池，输入覆盖使用 all 池，不能混用。HelpSteer2 要求不低于随机和 v4；其余质量轴要求不低于随机的 1.10 倍且不低于 v5。评分只在采样返回 ID 后读取。

{gt}

v6.9 的 F2 共识偏重保留其他回答的词项，使非等长双回答可以得到不同分数，但词项包含关系不等于正确性或有用性。HelpSteer2 仍低于随机基线，TLDR/valid2 仍不足目标，不能将 OASST2/CNN-DM 的改善推广为所有数据集的质量保证。第三轮主要优化输入覆盖，仅对新输入选择共识回答，所以仍可能使人工评分回落。

质量防退步轴全部披露：

{guard_table}

### 三轮实际修改与代价

1. **v6.8 分块等价加速**：数值热循环在普通函数内成块处理，保留协作式让出执行权，缓存分层排序键；不减少起点、候选或搜索步数。77 主场景与 22 预算敏感性完整回放 v6.7 有序 ID、真实路径、原因和诊断（策略名除外）。本轮真实池选样耗时相对 v6.7 的中位变化为 {pct(100*(median(p['runs']['v68']['selectionMs']/p['runs']['v67']['selectionMs'] for p in perf)-1))}，单次测量不代表稳定加速比。
2. **v6.9 召回优先的参考回答共识**：同输入规范化去重回答，固定最多 32 个其他回答支持；计算平均 F2 = 5×共有词项/(4×支持回答词项数+候选回答词项数)。只接受分数严格提高、保留真实路径格子且不重复问答的替换，输入顺序、输入词汇与成本保持 v6.8。无需 LLM、人工标签、来源分支或额外生产存储；可能偏好长回答，不能验证事实正确性。
3. **v6.10 有界禁忌搜索**：从 v6.9 起点进行两条确定性轨迹，各最多 min(24,K) 步。允许搜索中暂时减少覆盖，最近移出输入禁入 7 步；超过全局最好覆盖时可破禁。第一条按覆盖净收益与节省成本排序，第二条使用稳定散列处理净收益平局。每步守住预算、TV、独立输入数、起点任务与真实路径；最终只返回覆盖更高或等覆盖更便宜的结果，否则保留起点。覆盖上界与成本下界同时达到时安全跳过。小幅收益需要更多扫描，仍不保证全局最优或人工质量提升。

{et}

表中同 token 沿用所有对照共同预算与原问答 ID 排序；换回答会改变 QA ID，因而即便输入集合相同，截断计量仍可能变化。未针对这个散列顺序选样；各轮审计还保留固定 v6.4 预算结果。每轮主要门槛按该轮的共同预算判断，表格使用最终全对照预算便于横向比较。

### 性能与资源门槛

以下为同机串行运行、每个数据集和算法独立进程的 K100/seed42 采样耗时；摘要三分层共享一个进程。原始数据与结果 SHA256 均校验，重跑 ID 与冻结结果一致。输入 MinHash 来自校验后的临时研究缓存，加载和输入准备单列；各新算法的回答特征计算计入选样耗时。这些数字不是生产端到端耗时。

{pt}

真实池 v6.10 的 3 倍 v5 耗时门槛通过 {sum(p['ratios']['V610'] <= 3 for p in perf)}/10，仍不能放行。单次串行测量受运行时和同机常驻服务影响，不能当作置信区间。

{mt}

RSS 是进程高水位及相对选样前高水位的增量，包含 V8/GC 和之前准备的影响；零增量时判为数据不足，不视为通过。高水位增量只是增量内存代理，不是准确分配量；完整四 Worker 并发和端到端资源门槛仍未验证。

{synthetic_table}

短输入 N=10,000 与长输入 N=1,000 均验证 K=20/100/500；相同 fixture 与 checksum 校验缓存复用输入特征，各文件保留原特征冷准备耗时及本次缓存加载耗时。合成数据的达标不能代替真实池或真实 Worker。

### 固定规模、预算敏感性与验证

每轮使用原八源池，K100 的种子 42/100/101/102/103，seed42 的 K20/K500 及预算倍率 1.00/1.10/1.20。每轮 77 主场景加 22 预算敏感性，本次共 297 次候选运行；没有根据失败项修改阈值、池或数据分层。

{size_table}

{budget_table}

三轮独立审计均通过，逐轮重算来源哈希、历史与新候选 ID、输入覆盖、全部人工质量、预算、TV、真实路径和有效上界。审计计数包含各文件保留的历史对照，不能把它误读为新候选运行数。

新增 10 项测试覆盖等价回放、F2 去重和双回答边界、路径与输入不变性、需要负收益探索的构造案例、失败轨迹回退、上界提前停止、混合预算/分布、取消及默认策略。完整专项 {status['focused']['pass']}/{status['focused']['tests']} 通过，新采样器和研究脚本严格类型检查通过。

全仓测试 {status['fullSuite']['tests']} 项：{status['fullSuite']['pass']} 通过、{status['fullSuite']['fail']} 失败、{status['fullSuite']['skipped']} 跳过；失败名称与上一轮完全相同，未新增失败名称，但全仓仍未通过，也未据此确认全部失败的原因。全仓类型检查仍被 dev 生成 routes.d.ts 的四处语法错误阻断。本次新候选未接入生产 Worker，**未在浏览器中验证**；旧版 Web UI 验证不替代本轮验证。

这些池已经用于多轮开发，当前结果属于回归证据。新来源独立确认、完整 Worker 并发及新版 UI 仍待完成。主效果 7/11 也不是全部放行条件；本次三轮额度已用完，保留失败结果，默认继续 v4。

完整证据：[汇总](examples/next-three-rounds-v68-v610/summary.json)、[逐场景指标](examples/next-three-rounds-v68-v610/metrics.csv)、[源码哈希](examples/next-three-rounds-v68-v610/implementation.json)、[测试记录](examples/next-three-rounds-v68-v610/test-status.json)、[全仓失败名称](examples/next-three-rounds-v68-v610/full-failure-names.json)、[证据校验](examples/next-three-rounds-v68-v610/report-verification.json)。三个版本目录保存全部 24 份压缩原始实验及各轮 plan/verification，性能 JSON 保留硬件、来源和代码哈希。以下历史报告与证据保持原样。

<!-- NEXT-THREE-ROUNDS-REPORT-END -->

'''
report = docs/'eight-datasets-comparison-report.md'
old = report.read_text()
if old.startswith('<!-- NEXT-THREE-ROUNDS-REPORT-START -->'): old = old.split('<!-- NEXT-THREE-ROUNDS-REPORT-END -->\n\n', 1)[1]
report.write_text(text+old)
files = ['src/lib/trace-datasets/sampling/'+n+'.ts' for n in ['budgeted-block', 'budgeted-accelerated', 'answer-recall', 'budgeted-tabu']]+['scripts/trace-datasets/'+n for n in ['compare-next-rounds.ts', 'audit-next-rounds.ts', 'benchmark-next-rounds.ts', 'benchmark-next-rounds-synthetic.ts', 'report-next-rounds.py']]+['test/trace-datasets-budgeted-block.test.ts', 'test/trace-datasets-recall-tabu.test.ts']
(out/'implementation.json').write_text(json.dumps({f: sha(f) for f in files}, indent=2))
print(json.dumps({'rounds': 3, 'passed': summary['passed'], 'report': str(report)}, ensure_ascii=False))
