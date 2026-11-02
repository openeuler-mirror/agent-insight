/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';

const home = mkdtempSync(path.join(os.tmpdir(), 'evaluator-skill-tests-'));
process.env.AGENT_INSIGHT_HOME = home;
process.env.DATABASE_URL = process.env.AGENT_INSIGHT_TEST_DATABASE_URL || 'file:/tmp/agent-insight-evaluator-skills-test.db';

import { EvaluatorSkillStore, normalizeSkillPackage, readSkillZip, skillRelativePath, type SkillPackageFile } from '@/lib/evaluators/evaluator-skill-store';
import { normalizeEvaluatorSkillCards, freezeCustomEvaluators, resolveFrozenCustomEvaluator, customEvaluatorsForReuse } from '@/lib/evaluators/evaluator-skill-service';
import { runCustomEvaluatorWithSkills, CustomEvaluatorExecutionError, setCustomEvaluatorSkillCallerForTest } from '@/lib/engine/evaluation/custom-evaluator-runtime';
import { normalizeEvaluatorPoints, type EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { prismaRaw } from '@/lib/storage/prisma';
import { writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { POST as importSkill } from '@/app/api/user-evaluators/skill-imports/route';
import { GET as getEvaluators, PUT as saveEvaluators } from '@/app/api/user-evaluators/route';
import { GET as previewImport } from '@/app/api/user-evaluators/skill-imports/[importToken]/files/route';
import { GET as previewBinding } from '@/app/api/user-evaluators/[evaluatorId]/skills/[name]/files/route';
import { GET as libraryVersions } from '@/app/api/skills/by-name/[name]/versions/route';
import { recordAgentJudgeExecution } from '@/lib/engine/evaluation/evaluator-execution-recorder';
import { GET as getExperiment } from '@/app/api/experiments/[id]/route';
import { agentEvaluationTraceId } from '@/lib/evaluators/evaluator-skills';
import { POST as createExperiment } from '@/app/api/experiments/route';
import { startExperimentRun, ensureEvalExperiment } from '@/lib/engine/experiment/run-experiment';
import { createComparisonExperiment } from '@/lib/engine/experiment/comparison-runner';
import { runCustomLlmEvaluator } from '@/lib/engine/evaluation/custom-llm-evaluator';
import { buildJudgePrompt, parseJudgeText } from '@/lib/evaluators/judge-assembly';
import { cloneExperimentFromFrozenConfig } from '@/lib/engine/experiment/reuse-config';

const user = `evaluator-skills-${Date.now()}`;
const main = (name = 'validator') => Buffer.from(`---\nname: ${name}\ndescription: Verify task results\n---\nVALIDATE-${name} {{not_a_case_variable}}\n`);
const packageFiles = (name = 'validator'): SkillPackageFile[] => [
  { path: 'SKILL.md', data: main(name) },
  { path: 'scripts/check.cjs', data: Buffer.from('console.log(JSON.stringify({verified: 42}))'), executable: true },
  { path: 'assets/data.bin', data: Buffer.from([0, 255, 128, 1]) },
];
function card(): EvaluatorCard {
  return { id: 'custom-skills-test', name: 'skills_judge', description: '', evaluatorType: 'LLM', source: 'custom', targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '0-100', popularity: 0, mappedMetrics: [], status: 'ready', llmConfig: { model: '', systemPrompt: '评判 {{output}}', skills: [] }, pointsDef: [{ label: '验证结果' }] };
}
test.after(async () => {
  await prismaRaw.experiment.deleteMany({ where: { user } });
  await prismaRaw.execution.deleteMany({ where: { user: { in: [user, `${user}-foreign`] } } });
  await prismaRaw.customEvaluatorList.deleteMany({ where: { user } });
  await prismaRaw.registeredAgent.deleteMany({ where: { user } });
  await prismaRaw.skill.deleteMany({ where: { user } });
  await fs.rm(home, { recursive: true, force: true });
  await prismaRaw.$disconnect();
});

test('完整文件、二进制、执行位在导入和冻结后保持不变，临时数据与持久数据分离', async () => {
  let now = 1000;
  const store = new EvaluatorSkillStore(path.join(home, 'store-a'), () => now);
  const staged = await store.stage(user, packageFiles().map(f => ({ ...f, path: `folder/${f.path}` })), 'folder');
  const binding = await store.publishImport(user, staged.importToken);
  assert.equal(binding.name, 'validator');
  assert.equal(binding.source.kind, 'local');
  assert.equal(binding.fileCount, 3);
  const frozen = await store.load(user, binding.snapshotHash);
  assert.deepEqual(frozen.files.find(f => f.path === 'assets/data.bin')?.data, Buffer.from([0, 255, 128, 1]));
  assert.equal(frozen.files.find(f => f.path === 'scripts/check.cjs')?.executable, true);
  now += 25 * 3600_000;
  await assert.rejects(store.load(user, staged.importToken, true), /过期/);
  await store.stage(user, [{ path: 'SKILL.md', data: main('second') }]);
  assert.equal((await store.load(user, binding.snapshotHash)).manifest.name, 'validator');
  await assert.rejects(store.load('someone-else', binding.snapshotHash), /不存在/);
});

test('ZIP 导入保留实际文件字节并拒绝链接、CRC 损坏和解压后超限', () => {
  const zip = new AdmZip();
  for (const file of packageFiles()) zip.addFile(`validator/${file.path}`, file.data);
  assert.equal(normalizeSkillPackage(readSkillZip(zip.toBuffer())).name, 'validator');
  const link = new AdmZip(); link.addFile('SKILL.md', main()); const alias = link.addFile('alias', Buffer.from('outside')); alias.attr = (0o120777 << 16) >>> 0;
  assert.throws(() => readSkillZip(link.toBuffer()), /链接|特殊/);
  const bomb = new AdmZip(); bomb.addFile('SKILL.md', main()); bomb.addFile('huge', Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.throws(() => readSkillZip(bomb.toBuffer()), /超限/);
  const corrupt = new AdmZip(); corrupt.addFile('SKILL.md', main());
  const bytes = corrupt.toBuffer(); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(0, central + 16);
  assert.throws(() => readSkillZip(bytes), /损坏/);
});

test('主文件、frontmatter、多个 Skill 根、路径、大小写与文件目录冲突均校验', () => {
  for (const value of ['../secret', '/root', 'C:/secret', 'a\\b', 'a//b', 'a/./b']) assert.throws(() => skillRelativePath(value));
  assert.throws(() => normalizeSkillPackage([{ path: 'notes.md', data: main() }]), /缺少/);
  assert.throws(() => normalizeSkillPackage([{ path: 'SKILL.md', data: Buffer.from('---javascript\nglobalThis.bad=1\n---') }]), /frontmatter/);
  assert.throws(() => normalizeSkillPackage([{ path: 'SKILL.md', data: main('Bad_Name') }]), /name/);
  assert.throws(() => normalizeSkillPackage([...packageFiles(), { path: 'another/SKILL.md', data: main('second') }]), /多个/);
  assert.throws(() => normalizeSkillPackage([...packageFiles(), { path: 'skill.md', data: main() }]), /重复/);
  assert.throws(() => normalizeSkillPackage([...packageFiles(), { path: 'scripts', data: Buffer.from('collision') }]), /冲突/);
});

test('篡改冻结文件不会悄悄继续执行', async () => {
  const root = path.join(home, 'store-tamper'); const store = new EvaluatorSkillStore(root);
  const binding = await store.publish(user, packageFiles(), { kind: 'local' });
  const users = await fs.readdir(path.join(root, 'evaluator-skills'));
  await fs.writeFile(path.join(root, 'evaluator-skills', users[0], binding.snapshotHash, 'files/SKILL.md'), Buffer.alloc(main().length));
  await assert.rejects(store.load(user, binding.snapshotHash), /摘要|损坏/);
});

test('保存校验支持库 v0 和本地来源，复用旧快照，省略保留/空数组移除，重复拒绝', async () => {
  const store = new EvaluatorSkillStore();
  const staged = await store.stage(user, packageFiles());
  const incoming = card(); incoming.llmConfig!.skills = [{ kind: 'local', name: staged.name, importToken: staged.importToken, fileCount: 3 }];
  const [saved] = await normalizeEvaluatorSkillCards(user, [incoming], [], store);
  assert.equal(saved.llmConfig?.skills?.length, 1);
  const omitted = { ...saved, llmConfig: { model: '', systemPrompt: '新提示词' } };
  assert.equal((await normalizeEvaluatorSkillCards(user, [omitted], [saved], store))[0].llmConfig?.skills?.length, 1);
  assert.equal((await normalizeEvaluatorSkillCards(user, [card()], [saved], store))[0].llmConfig?.skills?.length, 0);
  const duplicate = { ...saved, llmConfig: { ...saved.llmConfig!, skills: [...saved.llmConfig!.skills!, ...saved.llmConfig!.skills!] } };
  await assert.rejects(normalizeEvaluatorSkillCards(user, [duplicate], [saved], store), /重复/);
  await assert.rejects(normalizeEvaluatorSkillCards(user, [saved], [], store), /未绑定/);
  const root = path.join(home, 'library'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'notes.txt'), 'library bytes');
  await prismaRaw.skill.create({ data: { user, name: 'library-validator', visibility: 'private', versions: { create: { version: 0, content: main('library-validator').toString(), files: '["SKILL.md","notes.txt"]', assetPath: root } } } });
  const libraryCard = card(); libraryCard.llmConfig!.skills = [{ kind: 'library', name: 'library-validator', sourceOwner: user, version: 0 }];
  const normalized = await normalizeEvaluatorSkillCards(user, [libraryCard], [], store);
  const binding = normalized[0].llmConfig!.skills![0]; assert.ok('snapshotHash' in binding);
  assert.deepEqual(binding.source, { kind: 'library', owner: user, version: 0 });
  const response = await libraryVersions(new Request(`http://localhost/api/skills/by-name/library-validator/versions?user=${user}&sourceOwner=${user}&version=0`), { params: Promise.resolve({ name: 'library-validator' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).files.length, 2);
});

test('本地上传 → 文件预览 → 保存 → 冻结文件查看，全程不创建 Skill 库记录', async () => {
  const count = await prismaRaw.skill.count({ where: { user } });
  const form = new FormData(); form.set('user', user); form.set('kind', 'folder'); form.append('files', new File([main()], 'SKILL.md')); form.append('paths', 'validator/SKILL.md');
  const response = await importSkill(new Request('http://localhost/api/user-evaluators/skill-imports', { method: 'POST', body: form }));
  assert.equal(response.status, 200); const imported = await response.json();
  const preview = await previewImport(new Request(`http://localhost/preview?user=${user}&path=SKILL.md`), { params: Promise.resolve({ importToken: imported.importToken }) });
  assert.match((await preview.json()).content, /VALIDATE-validator/);
  const denied = await previewImport(new Request('http://localhost/preview?user=other'), { params: Promise.resolve({ importToken: imported.importToken }) });
  assert.equal(denied.status, 404);
  const item = card(); item.llmConfig!.skills = [{ kind: 'local', name: imported.name, importToken: imported.importToken, fileCount: 1 }];
  const saved = await saveEvaluators(new Request('http://localhost/api/user-evaluators', { method: 'PUT', body: JSON.stringify({ user, evaluators: [item] }), headers: { 'Content-Type': 'application/json' } }));
  assert.equal(saved.status, 200); const normalized = await saved.json();
  assert.equal(normalized.evaluators[0].llmConfig.skills[0].source.kind, 'local');
  assert.equal(JSON.stringify(normalized).includes(imported.importToken), false);
  const files = await previewBinding(new Request(`http://localhost/preview?user=${user}&path=SKILL.md`), { params: Promise.resolve({ evaluatorId: item.id, name: 'validator' }) });
  assert.equal(files.status, 200); assert.match((await files.json()).content, /VALIDATE/);
  assert.equal(await prismaRaw.skill.count({ where: { user } }), count);
});

test('评分点创建后回读、增改删后保存并重新加载，保留 Prompt 与 Skill 绑定', async () => {
  const item = card(); item.id = 'custom-points-roundtrip';
  item.llmConfig!.skills = [await new EvaluatorSkillStore().publish(user, packageFiles(), { kind: 'local' })];
  await writeUserCustomEvaluators(user, [item]);
  const read = async () => {
    const response = await getEvaluators(new Request(`http://localhost/api/user-evaluators?user=${user}`));
    assert.equal(response.status, 200);
    return (await response.json() as EvaluatorCard[]).find(candidate => candidate.id === item.id)!;
  };
  const save = async (draft: EvaluatorCard) => {
    const response = await saveEvaluators(new Request('http://localhost/api/user-evaluators', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, evaluators: [{ ...draft, pointsDef: normalizeEvaluatorPoints(draft.pointsDef) }] }),
    }));
    assert.equal(response.status, 200);
    return read();
  };
  const created = await read();
  assert.deepEqual(created.pointsDef, [{ label: '验证结果' }]);
  const edited = await save({ ...created, pointsDef: [
    { label: ' 订单金额正确性 ', note: ' 核对订单金额 ' },
    { label: '输出格式', note: '  ' }, { label: '   ', note: '空名称草稿行' },
  ] });
  assert.deepEqual(edited.pointsDef, [{ label: '订单金额正确性', note: '核对订单金额' }, { label: '输出格式' }]);
  assert.match(buildJudgePrompt(edited, {}).user, /1\. 订单金额正确性——核对订单金额/);
  const removed = await save({ ...edited, pointsDef: edited.pointsDef!.slice(1) });
  assert.deepEqual(removed.pointsDef, [{ label: '输出格式' }]);
  const empty = await save({ ...removed, pointsDef: [] });
  assert.deepEqual(empty.pointsDef, []);
  assert.match(buildJudgePrompt(empty, {}).user, /自行提取 2~6 个评分点/);
  assert.deepEqual(empty.llmConfig, created.llmConfig);
});

test('上传在解析 multipart 前限制实际接收字节，不能省略 Content-Length 绕过限制', async () => {
  const response = await importSkill(new Request('http://localhost/api/user-evaluators/skill-imports', {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body: new Uint8Array(11 * 1024 * 1024 + 1),
  }));
  assert.equal(response.status, 413); assert.match((await response.json()).error, /大小超限/);
});

test('本地导入仅接受单个 Skill 文件夹，拒绝 ZIP、单文件和伪造目录路径', async () => {
  const folder = new FormData(); folder.set('user', user); folder.set('kind', 'folder');
  for (const file of packageFiles()) {
    folder.append('files', new File([new Uint8Array(file.data)], path.basename(file.path)));
    folder.append('paths', `validator/${file.path}`);
  }
  const accepted = await importSkill(new Request('http://localhost/import', { method: 'POST', body: folder }));
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).files.length, 3);
  const zip = new AdmZip(); zip.addFile('SKILL.md', main());
  for (const kind of ['zip', 'markdown']) {
    const form = new FormData(); form.set('user', user); form.set('kind', kind);
    form.append('files', new File([kind === 'zip' ? new Uint8Array(zip.toBuffer()) : new Uint8Array(main())], kind === 'zip' ? 'validator.zip' : 'SKILL.md'));
    const response = await importSkill(new Request('http://localhost/import', { method: 'POST', body: form }));
    assert.equal(response.status, 400); assert.match((await response.json()).error, /Skill 文件夹/);
  }
  for (const paths of [['SKILL.md'], ['validator/notes.txt'], ['validator/SKILL.md', 'other/notes.txt'], ['validator/../SKILL.md']]) {
    const form = new FormData(); form.set('user', user); form.set('kind', 'folder');
    paths.forEach((relative, index) => { form.append('files', new File([main()], index ? 'notes.txt' : 'SKILL.md')); form.append('paths', relative); });
    const response = await importSkill(new Request('http://localhost/import', { method: 'POST', body: form }));
    assert.equal(response.status, 400);
  }
});

test('文件夹上传兼容浏览器 multipart 中的相对路径文件名，但拒绝不匹配路径', async () => {
  const makeForm = (mismatch = false) => {
    const form = new FormData(); form.set('user', user); form.set('kind', 'folder');
    for (const file of packageFiles()) {
      const relative = `validator/${file.path}`;
      form.append('files', new File([new Uint8Array(file.data)], path.basename(file.path)), mismatch ? `other/${file.path}` : relative);
      form.append('paths', relative);
    }
    return form;
  };
  const accepted = await importSkill(new Request('http://localhost/import', { method: 'POST', body: makeForm() }));
  assert.equal(accepted.status, 200); const imported = await accepted.json();
  assert.deepEqual(imported.files.map((file: { path: string }) => file.path).sort(), packageFiles().map(file => file.path).sort());
  const preview = await previewImport(new Request(`http://localhost/preview?user=${user}&path=scripts/check.cjs`), { params: Promise.resolve({ importToken: imported.importToken }) });
  assert.equal(preview.status, 200); assert.match((await preview.json()).content, /verified: 42/);
  const rejected = await importSkill(new Request('http://localhost/import', { method: 'POST', body: makeForm(true) }));
  assert.equal(rejected.status, 400);
});

test('冻结配置在编辑/删除评估器后仍可复用，历史任务不自动获得新增 Skills', async () => {
  const original = card();
  const binding = await new EvaluatorSkillStore().publish(user, packageFiles(), { kind: 'local' });
  original.llmConfig!.skills = [binding];
  await writeUserCustomEvaluators(user, [original]);
  const frozen = { customEvaluatorSnapshots: await freezeCustomEvaluators(user, [original.id]) };
  const changed = card(); changed.llmConfig!.systemPrompt = 'changed'; changed.llmConfig!.skills = [binding];
  await writeUserCustomEvaluators(user, [changed]);
  assert.equal((await resolveFrozenCustomEvaluator(user, original.id, frozen))?.llmConfig?.systemPrompt, original.llmConfig!.systemPrompt);
  assert.deepEqual((await resolveFrozenCustomEvaluator(user, original.id, {}))?.llmConfig?.skills, []);
  await writeUserCustomEvaluators(user, []);
  assert.equal((await customEvaluatorsForReuse(user, [original.id], frozen)).cards[original.id].llmConfig!.skills!.length, 1);
  await assert.rejects(resolveFrozenCustomEvaluator(user, original.id, { customEvaluatorSnapshots: { schemaVersion: 1, cards: {} } }), /缺失/);
});

test('Agent transport 收到全部主指令、完整脚本和 Case，真实脚本结果形成证据且目录清理', async () => {
  const store = new EvaluatorSkillStore(path.join(home, 'runtime'));
  const item = card(); item.llmConfig!.skills = [await store.publish(user, packageFiles(), { kind: 'local' }), await store.publish(user, [{ path: 'SKILL.md', data: main('second') }], { kind: 'local' })];
  let directory = '';
  const result = await runCustomEvaluatorWithSkills(user, item, { input: 'question', output: 'answer' }, { store, caller: async (_user, request) => {
    directory = request.directory!;
    assert.match(request.system, /VALIDATE-validator/); assert.match(request.system, /VALIDATE-second/);
    assert.match(request.system, /\{\{not_a_case_variable\}\}/);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'inputs/case.json'), 'utf8')).input, 'question');
    const output = execFileSync(process.execPath, [path.join(directory, '.opencode/skills/validator/scripts/check.cjs')], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).verified, 42);
    request.onModel?.('test-model'); request.onTool?.({ phase: 'end', sessionID: 'session', callID: 'call-1', name: 'bash', status: 'completed', input: { command: 'node check.cjs' }, output });
    return JSON.stringify({ verdict: 'pass', summary: '脚本验证为 42', score: 100, points: [{ label: '验证结果', score: 100 }], evidence: { md: output } });
  } });
  assert.equal(result.output.score, 100); assert.equal(result.runtime.skills.length, 2); assert.equal(result.runtime.tools[0].status, 'completed');
  assert.equal(result.runtime.model, 'test-model');
  await assert.rejects(fs.access(directory));
});

test('Agent 失败与损坏快照明确失败，保留元数据，不降级；并发执行不共用目录', async () => {
  const store = new EvaluatorSkillStore(path.join(home, 'runtime-errors'));
  const item = card(); item.llmConfig!.skills = [await store.publish(user, packageFiles(), { kind: 'local' })];
  let attempts = 0;
  await assert.rejects(runCustomEvaluatorWithSkills(user, item, {}, { store, caller: async () => { attempts++; throw new Error('OpenCode unavailable'); } }), (e: unknown) => e instanceof CustomEvaluatorExecutionError && e.runtime.error === 'OpenCode unavailable');
  assert.equal(attempts, 1);
  const directories = new Set<string>();
  await Promise.all([1, 2].map(() => runCustomEvaluatorWithSkills(user, item, {}, { store, caller: async (_u, request) => { directories.add(request.directory!); return '{"verdict":"pass","summary":"ok","score":100}'; } })));
  assert.equal(directories.size, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCustomEvaluatorWithSkills(user, item, {}, { store, signal: controller.signal, caller: async () => { throw new Error('must not run'); } }), /abort/i);
});

test('真实实验 API 冻结两种来源配置，行执行读取冻结 Prompt，backing/对比创建同样冻结', async () => {
  const item = card();
  item.llmConfig!.systemPrompt = 'ORIGINAL-RUBRIC {{output}}';
  item.llmConfig!.skills = [await new EvaluatorSkillStore().publish(user, packageFiles(), { kind: 'local' })];
  await writeUserCustomEvaluators(user, [item]);
  const response = await createExperiment(new Request('http://localhost/api/experiments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, name: 'frozen skills', agentName: 'test-agent', evaluatorIds: [item.id], cases: [{ input: 'task', actualOutput: 'answer' }] }) }));
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const backing = await ensureEvalExperiment({ user, name: 'backing', evaluatorIds: [item.id] });
  const comparison = await createComparisonExperiment({ user, name: 'comparison', agentName: 'test-agent', variableDimension: 'llm', groups: [{ key: 'a', value: 'a' }, { key: 'b', value: 'b' }], evaluatorIds: [item.id], configSnapshot: { keep: true, customEvaluatorSnapshots: { malicious: true } } });
  for (const experimentId of [id, backing, comparison.id]) {
    const row = await prismaRaw.experiment.findUniqueOrThrow({ where: { id: experimentId } });
    const frozen = JSON.parse(row.configSnapshotJson!);
    assert.equal(frozen.customEvaluatorSnapshots.cards[item.id].llmConfig.skills.length, 1);
    if (experimentId === comparison.id) assert.equal(frozen.keep, true);
  }
  await writeUserCustomEvaluators(user, [{ ...item, llmConfig: { ...item.llmConfig!, systemPrompt: 'NEW-RUBRIC', skills: [] } }]);
  const clone = await cloneExperimentFromFrozenConfig({ sourceExperimentId: id, user });
  const cloneRow = await prismaRaw.experiment.findUniqueOrThrow({ where: { id: clone.id } });
  assert.equal(JSON.parse(cloneRow.configSnapshotJson!).customEvaluatorSnapshots.cards[item.id].llmConfig.skills.length, 1);
  const legacy = await prismaRaw.experiment.create({ data: { user, name: 'legacy', agentName: 'test-agent', evaluatorIdsJson: JSON.stringify([item.id]), cases: { create: { input: 'task', actualOutput: 'answer' } } } });
  await writeUserCustomEvaluators(user, [item]);
  const legacyClone = await cloneExperimentFromFrozenConfig({ sourceExperimentId: legacy.id, user });
  const legacyCloneRow = await prismaRaw.experiment.findUniqueOrThrow({ where: { id: legacyClone.id } });
  assert.deepEqual(JSON.parse(legacyCloneRow.configSnapshotJson!).customEvaluatorSnapshots.cards[item.id].llmConfig.skills, []);
  await writeUserCustomEvaluators(user, [{ ...item, llmConfig: { ...item.llmConfig!, systemPrompt: 'NEW-RUBRIC', skills: [] } }]);
  let calls = 0;
  setCustomEvaluatorSkillCallerForTest(async (_user, request) => {
    calls++;
    assert.match(request.system, /ORIGINAL-RUBRIC/); assert.doesNotMatch(request.system, /NEW-RUBRIC/);
    request.onModel?.('test-model');
    return '{"verdict":"pass","summary":"冻结配置已使用","score":90}';
  });
  try {
    const started = await startExperimentRun(id, user); await started!.completion;
    const row = await prismaRaw.experimentEvalResult.findFirstOrThrow({ where: { experimentId: id } });
    assert.equal(row.status, 'done'); assert.equal(row.score, 90); assert.equal(calls, 1);
    const evidence = JSON.parse(row.evidenceJson!); assert.equal(evidence.json.customEvaluatorRuntime.skills[0].name, 'validator');
    assert.equal(evidence.json.customEvaluatorRuntime.model, 'test-model');
  } finally { setCustomEvaluatorSkillCallerForTest(null); }
});

test('旧轨迹入口使用同一 Skill 运行时，适配评分并保留平台元数据，失败不产生分数', async () => {
  const item = card(); item.llmConfig!.skills = [await new EvaluatorSkillStore().publish(user, packageFiles(), { kind: 'local' })];
  setCustomEvaluatorSkillCallerForTest(async () => '{"verdict":"pass","summary":"验证通过","score":92}');
  try {
    const result = await runCustomLlmEvaluator(user, item.id, { caseInput: 'task', actualOutput: 'answer' }, 'target-skill', 0, item);
    assert.equal(result.score, 92); assert.equal(result.reason, '验证通过'); assert.equal(result.runtime?.skills[0].name, 'validator');
    setCustomEvaluatorSkillCallerForTest(async () => { throw new Error('verification unavailable'); });
    const failed = await runCustomLlmEvaluator(user, item.id, { caseInput: 'task', actualOutput: 'answer' }, null, null, item);
    assert.equal(failed.score, null); assert.equal(failed.runtime?.error, 'verification unavailable');
  } finally { setCustomEvaluatorSkillCallerForTest(null); }
  assert.throws(() => parseJudgeText('{"score":100,"evidence":{"json":{"type":"custom-evaluator-runtime-v1","customEvaluatorRuntime":{"skills":[]}}}}'), /保留/);
});


test('Agent 评估仅在真实会话保存后提供可访问链路，普通 LLM、历史、空会话与失效引用不显示', async () => {
  const taskId = `ses_evaluator_${Date.now()}`;
  const input = { taskId, agentName: 'skills_judge', user, query: 'verify case', systemPrompt: 'Loaded Skill validator v0', fallbackOutput: '{"score":100}' };
  assert.equal(await recordAgentJudgeExecution({ listMessages: async () => [] }, input), null);
  assert.equal(await prismaRaw.execution.count({ where: { taskId } }), 0);
  const messages = [{ info: { role: 'assistant', modelID: 'test-model', time: { created: Date.now(), completed: Date.now() } }, parts: [
    { type: 'tool', callID: 'real-tool-event', tool: 'bash', state: { status: 'completed', input: { command: 'node verify.cjs' }, output: 'SCRIPT_EXECUTED' } },
    { type: 'text', text: '{"score":100}' },
  ] }];
  assert.equal(await recordAgentJudgeExecution({ listMessages: async () => messages }, input), taskId);
  const record = await prismaRaw.execution.findFirstOrThrow({ where: { taskId, user } });
  assert.equal(record.agentName, 'skills_judge');
  const experiment = await prismaRaw.experiment.create({ data: { user, name: 'trace visibility', agentName: 'fixture', evaluatorIdsJson: '["custom-skills-test"]', cases: { create: { input: 'task', actualOutput: 'answer' } } }, include: { cases: true } });
  const evidence = { json: { type: 'custom-evaluator-runtime-v1', evaluationEvidence: { md: '脚本验证通过' }, customEvaluatorRuntime: { transport: 'opencode', skills: [{ name: 'validator' }], evaluationTraceId: taskId } } };
  const row = await prismaRaw.experimentEvalResult.create({ data: { experimentId: experiment.id, caseId: experiment.cases[0].id, evaluatorId: 'custom-skills-test', status: 'done', score: 100, evidenceJson: JSON.stringify(evidence) } });
  const read = async () => { const response = await getExperiment(new Request(`http://localhost/api/experiments/${experiment.id}?user=${user}`), { params: Promise.resolve({ id: experiment.id }) }); assert.equal(response.status, 200); return (await response.json()).results[0]; };
  assert.equal((await read()).evaluationTraceId, taskId);
  await prismaRaw.execution.update({ where: { id: record.id }, data: { user: `${user}-foreign` } });
  assert.equal((await read()).evaluationTraceId, null);
  await prismaRaw.execution.delete({ where: { id: record.id } });
  assert.equal((await read()).evaluationTraceId, null);
  await prismaRaw.experimentEvalResult.update({ where: { id: row.id }, data: { evidenceJson: '{"md":"普通 LLM 评分"}' } });
  assert.equal((await read()).evaluationTraceId, null);
  assert.equal(agentEvaluationTraceId({ json: { ...evidence.json, customEvaluatorRuntime: { ...evidence.json.customEvaluatorRuntime, transport: 'direct' } } }), null);
  assert.equal(agentEvaluationTraceId({ json: { ...evidence.json, customEvaluatorRuntime: { ...evidence.json.customEvaluatorRuntime, evaluationTraceId: undefined } } }), null);
});

test('configured Skills retries preserve frozen input and use fresh workspaces with original error classification', async () => {
  const { withEvaluatorExecution, runConfiguredEvaluationStage } = await import('@/lib/engine/experiment/evaluator-execution-policy');
  const item = card();
  const store = new EvaluatorSkillStore();
  item.llmConfig!.skills = [await store.publish(user, packageFiles(), { kind: 'local' })];
  const workspaces: string[] = [];
  const inputs: string[] = [];
  const result = await withEvaluatorExecution({ attemptTimeoutSeconds: 600, maxRetries: 1 }, new AbortController().signal,
    () => runConfiguredEvaluationStage(() => runCustomEvaluatorWithSkills(user, item, { input: 'frozen input', output: '42' }, {
      store, caller: async (_user, req) => {
        assert.equal(req.timeoutMs, 600_000);
        if (workspaces.length) await assert.rejects(fs.stat(workspaces[0]), /ENOENT/);
        workspaces.push(req.directory!);
        inputs.push(await fs.readFile(path.join(req.directory!, 'inputs/case.json'), 'utf8'));
        assert.match(req.system, /VALIDATE-validator/);
        if (workspaces.length === 1) throw Object.assign(new Error('service unavailable'), { status: 503 });
        return JSON.stringify({ verdict: 'pass', summary: '通过', score: 90, points: [] });
      },
    }), { deferTimeout: true }), { retryDelaysMs: [0] });
  assert.equal(result.output.score, 90);
  assert.equal(workspaces.length, 2);
  assert.notEqual(workspaces[0], workspaces[1]);
  assert.equal(inputs[0], inputs[1]);
  for (const workspace of workspaces) await assert.rejects(fs.stat(workspace), /ENOENT/);
});
