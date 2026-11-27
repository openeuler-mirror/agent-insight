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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvaluationErrorNotice } from '@/components/eval/EvaluationErrorNotice';
import { isMissingEvaluationModelError, MISSING_EVALUATION_MODEL_MESSAGE } from '@/lib/evaluators/model-configuration-error';

test('新错误和已存储的缺模型错误都提供模型注册与重评指引', () => {
  for (const message of [
    MISSING_EVALUATION_MODEL_MESSAGE,
    '未配置可用的评测模型',
    '未配置可用的评测模型，请到「模型注册」页完善连接信息',
    '未配置评测模型',
    '未配置评测模型，请先在「模型配置」中激活一个模型。',
    '未配置评测模型，无法提取关键观点',
    ' Error: 未配置可用的评测模型 ',
  ]) {
    const html = renderToStaticMarkup(createElement(EvaluationErrorNotice, { message }));
    assert.match(html, /未配置平台评测模型/);
    assert.match(html, /测试连接并设为默认/);
    assert.match(html, /href="\/modelconfig\/registry"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /新标签页打开/);
    assert.match(html, /无需重新执行 Agent/);
  }
});

test('展开的评估器错误保留配置入口和返回重评指引', () => {
  const html = renderToStaticMarkup(createElement(EvaluationErrorNotice, {
    message: '未配置可用的评测模型', compact: true,
  }));
  assert.match(html, /href="\/modelconfig\/registry"/);
  assert.match(html, /返回评测页面重新评测失败项/);
});

test('连接、鉴权、返回格式及执行端错误保留原文，不误引导平台模型注册', () => {
  for (const message of [
    '模型认证失败：401 Unauthorized',
    '评测模型连接超时',
    '评测模型输出不符合 JSON 契约',
    'Agent 执行端未配置模型',
    '未配置可用的评测模型，但当前错误是请求超时',
    '请到「模型注册」检查 API Key，鉴权失败',
  ]) {
    assert.equal(isMissingEvaluationModelError(message), false);
    const html = renderToStaticMarkup(createElement(EvaluationErrorNotice, { message }));
    assert.ok(html.includes(message));
    assert.doesNotMatch(html, /href=|未配置平台评测模型/);
  }
  assert.equal(isMissingEvaluationModelError(null), false);
  assert.equal(isMissingEvaluationModelError(undefined), false);
  assert.equal(isMissingEvaluationModelError(''), false);
});
