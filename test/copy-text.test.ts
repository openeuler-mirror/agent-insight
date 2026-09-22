import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { copyText } from '../src/lib/copy-text';

function clipboardEnvironment(t: TestContext, options: {
  modal?: boolean;
  modern?: 'available' | 'denied';
  execResult?: boolean;
} = {}) {
  let clipboard = 'previous clipboard';
  let active: Element;
  let selection = '';
  let trap: Element | undefined;
  const textareas: Element[] = [];
  class Element {
    parentElement: Element | null = null;
    children: Element[] = [];
    style = {};
    value = '';
    isConnected = true;
    constructor(readonly role = '') {}
    appendChild(child: Element) {
      child.parentElement = this;
      this.children.push(child);
    }
    removeChild(child: Element) {
      this.children = this.children.filter(item => item !== child);
      child.parentElement = null;
      child.isConnected = false;
    }
    remove() { this.parentElement?.removeChild(this); }
    setAttribute() {}
    contains(child: Element): boolean {
      return child === this || this.children.some(item => item.contains(child));
    }
    closest(): Element | null {
      return this.role === 'dialog' ? this : this.parentElement?.closest() ?? null;
    }
    focus() {
      // Model a modal focus scope: focusing outside restores its last focused child.
      active = trap && !trap.contains(this) ? button : this;
      selection = '';
    }
    select() {
      this.focus();
      selection = active === this ? this.value : '';
    }
  }
  const body = new Element();
  const dialog = new Element('dialog');
  const button = new Element();
  body.appendChild(dialog);
  (options.modal ? dialog : body).appendChild(button);
  if (options.modal) trap = dialog;
  active = button;
  const exec = t.mock.fn(() => {
    if (options.execResult === false) return false;
    if (selection) clipboard = selection;
    return true;
  });
  const writeText = t.mock.fn(async (text: string) => {
    if (options.modern === 'denied') throw new Error('NotAllowedError');
    clipboard = text;
  });
  const globals = {
    HTMLElement: Element,
    navigator: { clipboard: options.modern ? { writeText } : undefined },
    document: {
      body,
      get activeElement() { return active; },
      createElement() {
        const element = new Element();
        textareas.push(element);
        return element;
      },
      execCommand: exec,
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.mock.method(console, 'warn', () => {});
  return {
    readText: () => clipboard, exec, writeText, textareas,
    assertCleanup() {
      assert.equal(active, button, 'restore focus to the copy button');
      assert.ok(textareas.every(item => !item.isConnected), 'remove temporary textareas');
    },
  };
}

for (const [name, content] of [
  ['JSON input', JSON.stringify({ filePath: '/tmp/示例.txt', nested: { enabled: true } }, null, 2)],
  ['long output', '第一行\n第二行 😀\n'.repeat(1000) + 'OUTPUT_END'],
] as const) {
  test(`fallback copies complete modal ${name} without Clipboard API`, async t => {
    const env = clipboardEnvironment(t, { modal: true });
    await copyText(content);
    assert.equal(env.readText(), content);
    env.assertCleanup();
  });
}

test('fallback copies in a modal when Clipboard API rejects', async t => {
  const env = clipboardEnvironment(t, { modal: true, modern: 'denied' });
  await copyText('  original text\n');
  assert.equal(env.readText(), '  original text\n');
  env.assertCleanup();
});

test('fallback still copies outside a modal and restores focus', async t => {
  const env = clipboardEnvironment(t);
  await copyText('outside modal');
  assert.equal(env.readText(), 'outside modal');
  env.assertCleanup();
});

test('failed fallback rejects and restores focus without leaving a textarea', async t => {
  const env = clipboardEnvironment(t, { modal: true, execResult: false });
  await assert.rejects(copyText('do not claim success'), /execCommand/);
  assert.equal(env.readText(), 'previous clipboard');
  env.assertCleanup();
});

test('successful Clipboard API writes original content without fallback', async t => {
  const env = clipboardEnvironment(t, { modal: true, modern: 'available' });
  await copyText('  原文\n😀');
  assert.equal(env.readText(), '  原文\n😀');
  assert.equal(env.exec.mock.callCount(), 0);
  assert.equal(env.textareas.length, 0);
  env.assertCleanup();
});
