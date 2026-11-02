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

const target = 'src/app/(main)/dashboard/page.tsx';
const source = fs.readFileSync(new URL('../src/app/(main)/dashboard/page.tsx', import.meta.url), 'utf8');
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

test('刷新闭包在提交阶段由 useLayoutEffect 同步，且每次提交都执行', () => {
  const sync = statement('refreshRef.current = () => {');
  assert.equal(hookName(sync), 'useLayoutEffect', '已注册的 30s interval 会在新状态提交后、passive effect 执行前调到旧闭包，按旧 user / window / 筛选条件取数');
  assert.equal(enclosingHook(sync)?.arguments.length, 1, '刷新闭包需要在每次提交后同步，不能加依赖数组');
});

test('interval 的建立与清理逻辑保持不变', () => {
  assert.match(source, /const id = setInterval\(\(\) => refreshRef\.current\(\), 30_000\);/);
  assert.match(source, /return \(\) => clearInterval\(id\);/);
});

test('刷新闭包仍按当前 user / window / 筛选条件请求三块数据', () => {
  const body = normalize(statement('refreshRef.current = () => {').getText(ast));
  assert.match(body, /if \(!user\) return;/);
  assert.match(body, /\/api\/fleet\/trends\?window=\$\{win\}&user=\$\{encodeURIComponent\(user\)\}/);
  assert.match(body, /if \(bd\)[\s\S]*\/api\/fleet\/breakdowns\?window=\$\{win\}/);
  assert.match(body, /if \(reliability\)[\s\S]*\/api\/fleet\/reliability\?\$\{params\.toString\(\)\}/);
  assert.match(body, /platformFilter !== "all"\) params\.set\("platform", platformFilter\)/);
  assert.match(body, /agentFilter !== "all"\) params\.set\("agent", agentFilter\)/);
});

test('react 导入包含 useLayoutEffect', () => {
  const declaration = ast.statements.find(node => ts.isImportDeclaration(node) && node.moduleSpecifier.getText(ast) === "'react'") as ts.ImportDeclaration | undefined;
  const named = declaration?.importClause?.namedBindings;
  const names = named && ts.isNamedImports(named) ? named.elements.map(element => element.name.text) : [];
  for (const hook of ['useEffect', 'useLayoutEffect', 'useState']) assert.ok(names.includes(hook), `react 导入必须包含 ${hook}`);
});
