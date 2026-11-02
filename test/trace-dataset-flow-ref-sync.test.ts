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
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const target = 'src/components/TraceDatasetFlow.tsx';
const source = fs.readFileSync(new URL('../src/components/TraceDatasetFlow.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

function statement(prefix: string): ts.ExpressionStatement {
  let found: ts.ExpressionStatement | undefined;
  (function visit(node: ts.Node) {
    if (!found && ts.isExpressionStatement(node) && normalize(node.getText(ast)).startsWith(prefix)) found = node;
    if (!found) ts.forEachChild(node, visit);
  })(ast);
  assert.ok(found, `${target} 必须保留语句：${prefix}`);
  return found as ts.ExpressionStatement;
}

// 最近的包裹 hook 调用名；在事件处理函数体里为 undefined，用于断言 ref 同步落在提交阶段。
function enclosingHook(node: ts.Node): ts.CallExpression | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && /^use[A-Z]/.test(current.expression.text)) return current;
  }
  return undefined;
}

function hookName(node: ts.Node): string | undefined {
  const call = enclosingHook(node);
  return call && ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

test('被 pagehide 与异步续体读取的 ref 在提交阶段由 useLayoutEffect 同步', () => {
  const syncs = ['currentId.current = id;', 'changeRef.current = onChange;', 'finishCleanup.current = () => {'];
  for (const prefix of syncs) {
    const sync = statement(prefix);
    assert.equal(hookName(sync), 'useLayoutEffect', `${prefix} 必须由 useLayoutEffect 同步：已注册的 pagehide 处理器和轮询/提交的异步续体会在新状态提交后、passive effect 执行前读到旧值`);
  }
});

test('currentId 同步仍只在 id 变化时执行，changeRef / finishCleanup 仍每次提交同步', () => {
  assert.equal(enclosingHook(statement('currentId.current = id;'))?.arguments.length, 2, 'currentId 同步需要 [id] 依赖数组');
  assert.equal(enclosingHook(statement('currentId.current = id;'))?.arguments[1]?.getText(ast).replace(/\s+/g, ''), '[id]');
  assert.equal(enclosingHook(statement('changeRef.current = onChange;'))?.arguments.length, 1, 'changeRef 需要在每次提交后同步，不能加依赖数组');
  assert.equal(enclosingHook(statement('finishCleanup.current = () => {'))?.arguments.length, 1, 'finishCleanup 需要在每次提交后同步，不能加依赖数组');
});

test('close() 成功后仍在原地清空 currentId，且不落入 effect', () => {
  assert.equal(hookName(statement('currentId.current = undefined;')), undefined, '已释放的数据集需就地清空 currentId，避免重复 DELETE');
});

test('pagehide 释放链路完整：读取 currentId、注册与注销监听、卸载时延迟释放', () => {
  assert.match(source, /const release = \(\) => \{[\s\S]*?const datasetId = currentId\.current;[\s\S]*?apiFetch\(`\/api\/agent-datasets\/\$\{datasetId\}\/generation`, \{ method: 'DELETE', keepalive: true \}/);
  assert.match(source, /window\.addEventListener\('pagehide', release\);/);
  assert.match(source, /window\.removeEventListener\('pagehide', release\);/);
  assert.match(source, /releaseTimer\.current = setTimeout\(release, 0\);/);
});

test('react 导入包含 useLayoutEffect', () => {
  const declaration = ast.statements.find(node => ts.isImportDeclaration(node) && node.moduleSpecifier.getText(ast) === "'react'") as ts.ImportDeclaration | undefined;
  const named = declaration?.importClause?.namedBindings;
  const names = named && ts.isNamedImports(named) ? named.elements.map(element => element.name.text) : [];
  for (const hook of ['useEffect', 'useLayoutEffect', 'useRef', 'useState']) assert.ok(names.includes(hook), `react 导入必须包含 ${hook}`);
});
