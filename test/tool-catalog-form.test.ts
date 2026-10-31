/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { newCatalogTool, newCatalogParameter, readCatalogForm, serializeCatalogForm } from '@/lib/client/tool-catalog-form';
import { contextFromAvailableCatalogFields } from '@/lib/evaluators/evaluator-case-context';

test('表单区分未提供工具信息与明确没有工具，支持增删工具并产出原评估器合同', () => {
  const draft = readCatalogForm('');
  assert.equal(draft.provided, false);
  assert.equal(serializeCatalogForm(draft), '');
  draft.provided = true;
  assert.deepEqual(serializeCatalogForm(draft), []);
  const tool = newCatalogTool(); tool.name = 'read_file'; tool.description = '读取申请资料';
  draft.tools.push(tool);
  const value = serializeCatalogForm(draft);
  assert.equal(contextFromAvailableCatalogFields(value)!.availableTools[0].name, 'read_file');
  draft.tools.splice(0, 1);
  assert.deepEqual(serializeCatalogForm(draft), []);
});

test('编辑工具和参数不丢失旧目录包装、Skill及复杂Schema定义，增删/重命名参数同步required', () => {
  const original = { schemaVersion: 1, availableTools: [{ name: 'lookup', description: 'old', extra: 'keep', inputSchema: {
    type: 'object', additionalProperties: false, properties: { amount: { type: 'number', minimum: 0, description: '金额' }, nested: { type: 'object', properties: { id: { type: 'string' } } } }, required: ['amount'],
  } }], availableSkills: [{ name: 'loan' }] };
  const draft = readCatalogForm(JSON.stringify(original));
  draft.tools[0].description = 'new';
  draft.tools[0].parameters[0].name = 'total';
  const value = serializeCatalogForm(draft) as typeof original;
  assert.deepEqual(value.availableSkills, original.availableSkills);
  assert.equal(value.availableTools[0].extra, 'keep');
  assert.equal(value.availableTools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(value.availableTools[0].inputSchema.required, ['total']);
  assert.deepEqual((value.availableTools[0].inputSchema.properties as any).total, { type: 'number', minimum: 0, description: '金额' });
  assert.deepEqual(value.availableTools[0].inputSchema.properties.nested, original.availableTools[0].inputSchema.properties.nested);
  draft.tools[0].parameters.splice(0, 1);
  assert.deepEqual((serializeCatalogForm(draft) as typeof original).availableTools[0].inputSchema.required, []);
});

test('空名称、重复工具/参数与损坏旧数据阻止保存，不静默丢弃；复杂Schema原样保留', () => {
  const draft = readCatalogForm([{ name: 'lookup' }]);
  draft.tools.push(newCatalogTool());
  assert.throws(() => serializeCatalogForm(draft), /工具名称/);
  draft.tools[1].name = ' LOOKUP ';
  assert.throws(() => serializeCatalogForm(draft), /工具名称.*重复/);
  draft.tools.pop();
  const parameter = newCatalogParameter(); parameter.name = 'amount'; parameter.type = 'number'; parameter.required = true;
  draft.tools[0].parameters.push(parameter, { ...parameter, id: 'another' });
  assert.throws(() => serializeCatalogForm(draft), /参数名称.*重复/);
  const original = [{ name: 'custom', inputSchema: { oneOf: [{ type: 'string' }, { type: 'number' }] } }];
  const advanced = readCatalogForm(original);
  assert.equal(advanced.tools[0].schemaEditable, false);
  advanced.tools[0].description = '保留复杂定义';
  assert.deepEqual((serializeCatalogForm(advanced) as any)[0].inputSchema, original[0].inputSchema);
  assert.throws(() => serializeCatalogForm(readCatalogForm('{invalid')), /无法读取/);
});

test('布尔子Schema保留禁止约束，重命名只同步required，不能通过改说明隐式放开约束', () => {
  const draft = readCatalogForm([{ name: 'restricted', inputSchema: { type: 'object', properties: { forbidden: false }, required: ['forbidden'] } }]);
  draft.tools[0].parameters[0].name = 'blocked';
  const value = serializeCatalogForm(draft) as any;
  assert.equal(value[0].inputSchema.properties.blocked, false);
  assert.deepEqual(value[0].inputSchema.required, ['blocked']);
  draft.tools[0].parameters[0].description = '说明不能改变约束';
  assert.throws(() => serializeCatalogForm(draft), /复杂参数定义/);
});
