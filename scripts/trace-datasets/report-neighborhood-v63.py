"""Publish the v6.3 evidence alongside the unchanged historical reports."""
import csv
import gzip
import hashlib
import json
from pathlib import Path
from statistics import mean
import shutil
import sys

root, output = map(Path, sys.argv[1:3])
out = output/'examples'/'budgeted-v63'
out.mkdir(parents=True, exist_ok=True)
names = ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']
ms = dict(zip(names[:6], [44.8, 5.7, 44.5, 55.7, 86.3, 49.3]))
methods = ['B0', 'B4', 'C', 'V6', 'V61', 'V62', 'FAST', 'V63']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
audit = json.loads((root/'verification.json').read_text())
assert audit['passed'] and audit['datasets'] == 8
reports = {n: json.loads((root/f'{n}.json').read_text()) for n in names}
for name, r in reports.items():
    assert r['finishedAt'] and not r['plan']['smoke']
    for f, h in r['plan']['codeHashes'].items(): assert sha(f) == h
    with (out/f'{name}.json.gz').open('wb') as handle:
        with gzip.GzipFile(fileobj=handle, mode='wb', filename='', mtime=0) as z: z.write((root/f'{name}.json').read_bytes())
for f in ['plan.json', 'verification.json', 'test-status.json', 'full-failure-names.json', 'bound-verification.json', 'toy-bound-verification.json']:
    shutil.copyfile(root/f, out/f)
primary, quality, flat, sizes, budgets = [], [], [], [], []
for name, report in reports.items():
    grouped = {}
    for s in report['scenarios']:
        for m, run in s['methods'].items():
            flat.append(dict(dataset=name, stratum=s['stratum'], population=s['population'], k=s['k'], seed=s['seed'], method=m, vocabulary=run['metrics']['vocabulary'], tokens=run['metrics']['tokens'], quality=json.dumps(run['metrics']['quality']), selection_ms=run['selectionMs']))
        if s['k'] == 100: grouped.setdefault((s['stratum'], s['population']), []).append(s)
        elif s['population'] == 'all': sizes.append(dict(dataset=name, **s))
        if s['k'] == 100 and s['seed'] == 42 and s['population'] == 'all': budgets.append(dict(dataset=name, **s))
    for (stratum, population), trials in grouped.items():
        assert sorted(t['seed'] for t in trials) == [42, 100, 101, 102, 103]
        equal = [e for e in audit['equalBudget'] if (e['dataset'], e['stratum'], e['population'], e['k']) == (name, stratum, population, 100)]
        assert len(equal) == 5
        primary.append(dict(dataset=name, stratum=stratum, population=population, methods={m: {k: mean(t['methods'][m]['metrics'][k] for t in trials) for k in ['vocabulary', 'tokens']} for m in methods}, equal={m: mean(e[m] for e in equal) for m in methods if m != 'FAST'}, feasible=sum(t['methods']['V63']['optimization']['feasible'] for t in trials)))
        for axis in trials[0]['methods']['V63']['metrics']['quality']:
            quality.append(dict(dataset=name, stratum=stratum, population=population, axis=axis, **{m: mean(t['methods'][m]['metrics']['quality'][axis]['mean'] for t in trials) for m in methods}))
def label(r): return r['dataset'] + (' / '+r['stratum'] if r['stratum'] != 'all' else '')
def gain(r, m): return 100*(r['methods'][m]['vocabulary']/r['methods']['B0']['vocabulary']-1)
def pct(v): return f'{v:+.2f}%'
def table(headers, rows): return '\n'.join(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |'] + ['| '+' | '.join(map(str, row))+' |' for row in rows])
coverage = [r for r in primary if r['population'] == 'all' and r['dataset'] in ms]
mainq = [r for r in quality if (r['dataset'] == 'OASST2' and r['population'] == 'quality-annotated' and r['axis'] == 'quality') or (r['dataset'] == 'HelpSteer2' and r['axis'] == 'helpfulness') or (r['dataset'] == 'SummarizeFeedback' and r['axis'] == 'overall')]
gates = []
for r in coverage:
    target = max(ms[r['dataset']]+5, gain(r, 'C')); reasons = []
    if gain(r, 'V63') < target: reasons.append('覆盖不足')
    if r['equal']['V63'] < r['equal']['C']: reasons.append('同 token 覆盖低于 v5')
    if r['feasible'] < 5: reasons.append('存在不可行回退')
    gates.append(dict(condition=label(r)+' / 词汇', value=gain(r, 'V63'), target=target, passed=not reasons, reason='；'.join(reasons) or '覆盖及成本条件通过'))
for r in mainq:
    target = max(r['B0'], r['B4']) if r['dataset'] == 'HelpSteer2' else max(r['B0']*1.1, r['C'])
    gates.append(dict(condition=label(r)+' / '+r['axis'], value=r['V63'], target=target, passed=r['V63'] >= target, reason='人工评分不足' if r['V63'] < target else '人工评分条件通过'))
assert len(gates) == 11
summary = dict(status='offline_not_enabled', default='trace-coverage-v4', candidate='trace-coverage-v6.3', primary=primary, quality=quality, gates=gates, passed=sum(g['passed'] for g in gates), independentConfirmation='not_run')
(out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (out/'metrics.csv').open('w', newline='') as h:
    w = csv.DictWriter(h, fieldnames=flat[0]); w.writeheader(); w.writerows(flat)
ct = table(['数据集', '微软公开', 'v4 默认', 'v5', 'v6', 'v6.1', 'v6.2', 'v6.3', 'v6.3 − 微软（百分点）'], [[r['dataset'], pct(ms[r['dataset']]), *[pct(gain(r, m)) for m in ['B4', 'C', 'V6', 'V61', 'V62', 'V63']], f"{gain(r,'V63')-ms[r['dataset']]:+.2f}"] for r in coverage])
qt = table(['数据 / 质量轴', '随机', 'v4', 'v5', 'v6.2', 'v6.3', 'v6.3 − v6.2'], [[label(r)+' / '+r['axis'], *[f'{r[m]:.3f}' for m in ['B0','B4','C','V62','V63']], f"{r['V63']-r['V62']:+.3f}"] for r in mainq])
gt = table(['条件', 'v6.3 实测', '原目标下限', '结果'], [[g['condition'], f"{g['value']:.3f}", f"{g['target']:.3f}", ('通过：' if g['passed'] else '未通过：')+g['reason']] for g in gates])
at = table(['数据及分层', 'FAST（等价 v6.2）覆盖增幅', 'v6.3 覆盖增幅', '同 token：v6.3 对 v5', '同 token：v6.3 对 v6.2', 'v6.3 token / 随机'], [[label(r), pct(gain(r,'FAST')), pct(gain(r,'V63')), pct(100*(r['equal']['V63']/r['equal']['C']-1)), pct(100*(r['equal']['V63']/r['equal']['V62']-1)), f"{r['methods']['V63']['tokens']/r['methods']['B0']['tokens']:.3f}×"] for r in primary if r['population']=='all'])
st = table(['数据及分层', 'K（seed=42）', 'v6.2 覆盖增幅', 'v6.3 覆盖增幅', '可行'], [[label(s), s['k'], *[pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)) for m in ['V62','V63']], s['methods']['V63']['optimization']['feasible']] for s in sizes])
bt = table(['数据及分层', '预算倍率', 'v6.3 覆盖增幅', 'token / B_ref', '可行'], [[label(s), ratio, pct(100*(s['methods'][m]['metrics']['vocabulary']/s['methods']['B0']['metrics']['vocabulary']-1)), f"{s['methods'][m]['metrics']['tokens']/s['methods'][m]['optimization']['baseTokens']:.3f}×", s['methods'][m]['optimization']['feasible']] for s in budgets for ratio,m in [(1,'V63_1'),(1.1,'V63'),(1.2,'V63_1.2')]])
guards = [r for r in quality if (r['dataset']=='HelpSteer2' and r['axis']=='correctness') or (r['dataset']=='SummarizeFeedback' and r['axis'] in ['accuracy','coverage','coherence'])]
guard = table(['防退步质量轴', '随机', 'v4', 'v5', 'v6.2', 'v6.3'], [[label(r)+' / '+r['axis'], *[f'{r[m]:.3f}' for m in ['B0','B4','C','V62','V63']]] for r in guards])
perf=[]
for suffix,scenario in [('', 'N=10k 短输入'),('long-', 'N=1k 长输入')]:
    runs={v:json.loads((root/f'performance-{suffix}{v}.json').read_text()) for v in ['v5','v62','v63']}
    assert runs['v5']['hardware']==runs['v62']['hardware']==runs['v63']['hardware']
    for v,run in runs.items():
        for f,h in run['codeHashes'].items():assert sha(f)==h
        shutil.copyfile(root/f'performance-{suffix}{v}.json',out/f'performance-{suffix}{v}.json')
    for i in range(3):
        measures={v:r['measurements'][i] for v,r in runs.items()}
        ratio=measures['v63']['selectionMs']/measures['v5']['selectionMs']; memory=measures['v63']['additionalHighWaterKiB']/max(1,measures['v5']['additionalHighWaterKiB'])
        perf.append(dict(scenario=scenario,k=measures['v5']['k'],runs=measures,ratioToV5=ratio,highWaterRatioToV5=memory,timeGate=ratio<=3,highWaterGate=memory<=1.5))
(out/'performance-summary.json').write_text(json.dumps(perf,indent=2))
pt=table(['场景','K','v5','v6.2','v6.3','v6.3 / v5','3 倍耗时门槛'],[[p['scenario'],p['k'],*[f"{p['runs'][v]['selectionMs']/1000:.3f}s" for v in ['v5','v62','v63']],f"{p['ratioToV5']:.2f}×",'通过' if p['timeGate'] else '未通过'] for p in perf])
mt=table(['场景','K','v5 / v6.2 / v6.3 峰值 RSS MiB','对应高水位增量 MiB','增量 1.5 倍门槛（代理）'],[[p['scenario'],p['k'],' / '.join(f"{p['runs'][v]['maxRssKiB']/1024:.1f}" for v in ['v5','v62','v63']),' / '.join(f"{p['runs'][v]['additionalHighWaterKiB']/1024:.1f}" for v in ['v5','v62','v63']),'通过' if p['highWaterGate'] else '未通过'] for p in perf])
bounds=json.loads((root/'bounds'/'summary.json').read_text())
shutil.copytree(root/'bounds',out/'bounds',dirs_exist_ok=True)
shutil.copytree(root/'distribution-bounds',out/'distribution-bounds',dirs_exist_ok=True)
tight={b['name']: b for b in json.loads((root/'distribution-bounds'/'summary.json').read_text())}
assert json.loads((root/'bound-verification.json').read_text())['certificates']==12
for b in bounds+list(tight.values()):
    assert b['exporterSha256']==sha('scripts/trace-datasets/coverage-bound-input-v63.ts')
    assert b['solverSha256']==sha('scripts/trace-datasets/coverage-upper-bound-v63.py')
br=[]
for b in bounds:
    r=next(r for r in coverage if r['dataset']==b['name'])
    target=r['methods']['B0']['vocabulary']*(1+max(ms[b['name']]+5,gain(r,'C'))/100)
    br.append([b['name'],f"{r['methods']['V63']['vocabulary']:.1f}",f'{target:.1f}',f"{b['upperBound']:.1f}",f"{tight[b['name']]['upperBound']:.1f}",'上界低于目标' if tight[b['name']]['upperBound']<target else '不能据此排除可达性'])
boundtable=table(['数据集','v6.3 五种子平均词汇量','目标词汇量','只保留预算的上界','加回分布约束的上界','能得出的结论'],br)
status=json.loads((root/'test-status.json').read_text())
assert sha('scripts/trace-datasets/audit-neighborhood-v63.ts')==audit['auditorSha256']
assert status['focusedPassed'] and status['scriptTypecheckPassed']
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
fig,ax=plt.subplots(figsize=(14,8),layout='constrained'); y=np.arange(6)
for offset,m,color,name in [(-.27,'MS','#b45309','Microsoft (published)'),(-.09,'C','#4f46e5','v5'),(.09,'V62','#0f766e','v6.2'),(.27,'V63','#0369a1','v6.3 (offline)')]:
    vals=[ms[r['dataset']] if m=='MS' else gain(r,m) for r in coverage]
    bars=ax.barh(y+offset,vals,height=.17,color=color,label=name)
    ax.bar_label(bars,labels=[f'{v:+.2f}%' for v in vals],padding=3,fontsize=8)
ax.set_yticks(y,[r['dataset'] for r in coverage]);ax.invert_yaxis();ax.grid(axis='x',alpha=.2);ax.set_axisbelow(True);ax.margins(x=.15)
ax.set_xlabel('Distinct input vocabulary uplift over each random baseline (%)');ax.set_title('Microsoft vs v5 / v6.2 / v6.3\nDifferent Microsoft pool/protocol: numerical targets, not a head-to-head comparison');ax.legend(loc='lower right',fontsize=8)
fig.savefig(out/'comparison.png',dpi=170);fig.savefig(out/'comparison.svg',metadata={'Date':None});plt.close(fig)
validation=table(['验证项','结果'],[['采样与 SQLite/Worker 专项',f"{status['focused']['pass']}/{status['focused']['tests']} 通过（含 19 项 v6.3 测试）"],['新增采样器/研究脚本严格类型检查','通过' if status['scriptTypecheckPassed'] else '未通过'],['全仓 npm run test',f"{status['fullSuite']['pass']} 通过，{status['fullSuite']['fail']} 失败，{status['fullSuite']['skipped']} 跳过"],['全仓类型检查','未通过：运行中的 dev server 生成 routes.d.ts 存在 4 处语法错误；未编辑其缓存'],['Web UI / 四 Worker 压力 / 新来源确认','本轮未执行，新候选未接入生产']])
text=f'''<!-- V63-REPORT-START -->
## v6.3：预算内组合重选与特征处理优化

**默认仍为 v4，v6.3 为离线候选。原有 11 项主要效果条件通过 {summary['passed']} 项，整体目标未完成。** v6.2 的通过项为 2 项，本轮下降到 1 项：WildChat 的原始覆盖提高，但同 token 覆盖比 v5 低约 0.48%，因此失去通过状态。v6.3 不是全面优于 v6.2 的替代版。

本轮保持全部原门槛；未使用 LLM、人工评分选样、数据源专用规则或新增生产存储。以下全部八源、五种子结果均保留，不能因某一指标改善而认定整体放行。

### 微软与本地各版本直接对照

{ct}

这张表只比较原始词汇覆盖增幅。“比微软公开数值高”只是数值对照；验收还要求超过微软公开值 5 个百分点、不低于 v5、同 token 覆盖不低于 v5，以及满足成本和分布约束。完整判定见下方 11 行门槛表。

微软参照来自[公开报告](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/intelligent-sampling-in-microsoft-foundry-the-science-behind-selecting-better-pr/4523722)。本地使用冻结池 K=100 的五种子均值；双方池、分词和协议不同，不能据此宣称算法严格优于微软。

![微软与本地各版本对照](examples/budgeted-v63/comparison.png)

### 质量与逐项门槛

{qt}

{gt}

前六行是覆盖百分数，后五行是原量纲人工评分。OASST2 和三个摘要分层至少为随机评分的 1.10 倍且不低于 v5；HelpSteer2 至少恢复到随机及 v4。微软对摘要仅披露总体质量变化，不能伪造其分层评分。本轮仍没有通过所有质量条件，原始覆盖提高不能替代回答质量证据。

### 改动、消融与同 token 对照

- **FAST**：同输入特征改为集合校验，避免重复排序；词项和倒排使用紧凑整数数组；先判断 v5 可行初解是否达到有效覆盖上界，达到时不创建搜索倒排。对全部 {audit['scenarios']} 个原场景回放检查，FAST 入选 ID 与 v6.2 完全一致；这部分是等价计算优化。
- **v6.3**：保留完整 v6.2 可行解，最多两轮、每轮三个固定移除顺序，每次移除不超过 min(32,ceil(K×0.20)) 个可替换样本。必要任务和真实路径格子始终保留；分别用 0/0.5/1 成本指数填回，在完整可行且原始覆盖严格增加时接受。最多 18 个重构分支，不按质量分数决定是否接受。
- 没有找到可行构造时仍显式回退 v4；不把启发式未找到解称为数学上不可行。v6.2 可行时，本轮原始覆盖不低于 v6.2；同 token 和人工质量不作保证，按实测判定。

{at}

同 token 使用七方法 `min(B0,B4,C,V6,V61,V62,V63)` 的总输入词法 token，按固定哈希顺序读入，最后一个输入只在计量时截断；原文与样本不改变。所有旧版本在相同截止点重新计量，不直接拼接不同预算口径的旧数字。主约束仍为 1.10 倍独立输入池均值成本。

### 覆盖目标是否被预算限制

{boundtable}

“只保留预算”诊断把每个独立输入的选取变量与每个词项的覆盖变量放宽到 [0,1]，只保留 K 和原 token 预算，进一步放宽任务、路径与 TV 约束。因此它一定不小于受约束整数最优值。使用 SciPy/HiGHS 求解后，将非负对偶乘子按 10⁹ 缩放取整，以 Python 整数独立核验 `b·λ + Σ max(0,c−Aᵀλ)` 证书；未依赖求解器浮点可行性声明。求解超时时保留全词典的平凡上界并注明状态。

另一个独立求解加入本实验已核验的 K=100 个不同输入，以及原长度 TV≤0.10、任务 TV≤0.20 约束；用辅助变量线性化绝对值，仍放宽任务/路径保底和整数约束。辅助变量上界为 K，证书中的正剩余系数相应乘 K。该列仅适用于这些固定池的 100 个独立输入试验，不推广为含重复回答变体场景的上界。12 份证书由不依赖 SciPy 的独立检查器复算；另用 3 个小池、两种约束模型做穷举验证。

上界高于目标只表示不能排除可达性，不证明存在满足全部分布条件的样本，也不证明人工质量可达。该诊断是离线研究工具，未加入生产依赖或采样评分。

### 同机串行性能

本次 {sum(p["timeGate"] for p in perf)}/{len(perf)} 个场景通过相对 v5 的 3 倍耗时门槛；{sum(not p["highWaterGate"] for p in perf)} 个场景未通过增量 RSS 门槛。长输入 K=500 的峰值 RSS 从本轮 v6.2 的 {perf[-1]["runs"]["v62"]["maxRssKiB"]/1024:.1f} MiB 降至 v6.3 的 {perf[-1]["runs"]["v63"]["maxRssKiB"]/1024:.1f} MiB，但性能代理改善不代表整体放行。

{pt}

{mt}

主实验和上界诊断完成后，各版本在独立进程串行测量；特征/签名构造另列原始 JSON。后台服务可能引入计时波动。RSS 增量仍是特征准备后跨 K 的累计进程高水位差，只是代理；没有把纯函数基准当作四 Worker 或 Web UI 验收。

### K、预算敏感性与质量防退步

{st}

{bt}

{guard}

### 验证与保留的边界

{validation}

全仓失败的名称均在先前运行记录中出现，但本轮未逐项证明失败原因。详情保留在验证状态与失败名称清单中，不能将专项通过写成全仓通过。

独立审计通过 {audit['scenarios']} 个场景、{audit['selectedItems']} 个入选记录和 {audit['qualityMeans']} 个人工评分均值；所有原始数据/历史结果/实现代码指纹都核验。算法、研究脚本和证书均保存，默认仍为 v4。v6.3 未接入 Worker，本轮未在浏览器中验证；历史 v4 的 UI 证据不能替代新候选验收。已知回归池不是新来源组独立确认，未以其结果宣布“全部数据集超过微软”。

复跑入口：`compare-neighborhood-v63.ts` → `audit-neighborhood-v63.ts` → `report-neighborhood-v63.py`；预算上界：`coverage-bound-input-v63.ts` → `coverage-upper-bound-v63.py`。使用 `/tmp/trace-v62/data` 的原冻结数据；临时文件缺失时仍由 `restore-frozen-data.py` 按历史 SHA 恢复。

证据：[汇总](examples/budgeted-v63/summary.json) · [指标 CSV](examples/budgeted-v63/metrics.csv) · [独立审计](examples/budgeted-v63/verification.json) · [预算上界](examples/budgeted-v63/bounds/summary.json) · [性能](examples/budgeted-v63/performance-summary.json) · [验证状态](examples/budgeted-v63/test-status.json)。历史结果如下原样保留。

<!-- V63-REPORT-END -->

'''
report=output/'eight-datasets-comparison-report.md'
old=report.read_text()
if '<!-- V63-REPORT-START -->' in old:
    old=old.split('<!-- V63-REPORT-END -->',1)[1].lstrip('\n')
report.write_text(text+old)
(out/'implementation.json').write_text(json.dumps({**reports[names[0]]['plan']['codeHashes'],'scripts/trace-datasets/audit-neighborhood-v63.ts':sha('scripts/trace-datasets/audit-neighborhood-v63.ts'),'scripts/trace-datasets/report-neighborhood-v63.py':sha(__file__), **{f:sha(f) for f in ['scripts/trace-datasets/coverage-bound-input-v63.ts','scripts/trace-datasets/coverage-upper-bound-v63.py','scripts/trace-datasets/audit-coverage-bound-v63.py','test/trace-datasets-budgeted-neighborhood.test.ts']}},indent=2))
print(json.dumps({'passed':summary['passed'],'total':11,'report':str(report)},ensure_ascii=False))
