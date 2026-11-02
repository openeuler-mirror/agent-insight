import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import React, { type ReactElement } from 'react';
import ts from 'typescript';

type TestElement = ReactElement<{
  children?: React.ReactNode;
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
  onClick?: unknown;
  type?: string;
  noValidate?: boolean;
  value?: string;
}>;

const source = fs.readFileSync(new URL('../src/app/login/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found);
  return found;
}

function evaluate<Value>(expression: string, scope: Record<string, unknown>): Value {
  const compiled = ts.transpileModule(`const result = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(scope), `${compiled}\nreturn result;`)(...Object.values(scope));
}

function formHarness(username: string, response = Response.json({ username: 'person@example.com', apiKey: 'test-key' })) {
  let currentUsername = username;
  let error = '';
  let prevented = false;
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const logins: unknown[][] = [];
  const scope = {
    React,
    username,
    error,
    colors: {},
    t: (key: string) => key,
    setUsername: (value: string) => { currentUsername = value; },
    setError: (value: string) => { error = value; },
    apiFetch: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return response;
    },
    login: (...args: unknown[]) => { logins.push(args); },
  };
  const handler = findNode(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleLogin') as ts.VariableDeclaration;
  const handleLogin = evaluate(handler.initializer!.getText(ast), scope);
  const formNode = findNode(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'form');
  const form = evaluate<TestElement>(formNode.getText(ast), { ...scope, handleLogin });
  return {
    form,
    requests,
    logins,
    error: () => error,
    inputValue: () => currentUsername,
    prevented: () => prevented,
    submit: async () => {
      assert.equal(typeof form.props.onSubmit, 'function', 'Submitting the form must invoke the login handler');
      await form.props.onSubmit!({ preventDefault: () => { prevented = true; } });
    },
  };
}

function descendants(element: TestElement): TestElement[] {
  const children = React.Children.toArray(element.props.children).filter(React.isValidElement) as TestElement[];
  return [element, ...children.flatMap(descendants)];
}

test('邮箱表单提交阻止页面刷新，去除首尾空白并完成登录', async () => {
  const harness = formHarness('  person@example.com  ');
  await harness.submit();
  assert.equal(harness.prevented(), true);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].url, '/api/auth/apikey');
  assert.equal(harness.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(String(harness.requests[0].options.body)), { username: 'person@example.com' });
  assert.deepEqual(harness.logins, [['person@example.com', 'test-key']]);
});

test('登录按钮作为表单提交入口，保留应用已有校验路径', () => {
  const { form } = formHarness('person@example.com');
  const button = descendants(form).find(element => element.type === 'button');
  assert.ok(button);
  assert.equal(button.props.type, 'submit');
  assert.equal(button.props.onClick, undefined);
  assert.equal(form.props.noValidate, true);
});

test('空邮箱提交显示现有提示且不发送登录请求', async () => {
  const harness = formHarness('   ');
  await harness.submit();
  assert.equal(harness.prevented(), true);
  assert.equal(harness.error(), 'login.emailRequired');
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(harness.logins, []);
});

test('登录被拒绝时显示接口错误并保留邮箱输入', async () => {
  const harness = formHarness('person@domain', Response.json({ error: 'Username must be a valid email address' }, { status: 400 }));
  await harness.submit();
  assert.equal(harness.prevented(), true);
  assert.equal(harness.error(), 'Username must be a valid email address');
  assert.deepEqual(harness.logins, []);
  assert.equal(harness.inputValue(), 'person@domain');
});
