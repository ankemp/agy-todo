import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const UNSAFE_HTML_SINK_RE = /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write\b/;

const REQUIRED_CM6_EXPORTS = [
  'EditorState',
  'StateField',
  'StateEffect',
  'Compartment',
  'RangeSetBuilder',
  'Prec',
  'Transaction',
  'EditorView',
  'Decoration',
  'ViewPlugin',
  'WidgetType',
  'keymap',
  'placeholder',
  'drawSelection',
  'defaultKeymap',
  'history',
  'historyKeymap',
  'undo',
  'redo',
  'syntaxTree',
  'HighlightStyle',
  'syntaxHighlighting',
  'markdown',
  'Strikethrough',
  'TaskList',
  'Autolink',
  'tags',
];

function loadVendorBundle() {
  const code = readFileSync(join(publicDir, 'vendor', 'cm6-bundle.js'), 'utf8');
  // Verify valid classic script syntax
  new vm.Script(code, { filename: 'public/vendor/cm6-bundle.js' });
  const ctx = { window: {}, globalThis: null, self: null, console };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInNewContext(code, ctx, { filename: 'public/vendor/cm6-bundle.js' });
  return { code, cm: ctx.AGYCodeMirror || ctx.window.AGYCodeMirror };
}

function loadNotesEditor() {
  const code = readFileSync(join(publicDir, 'notes-editor.js'), 'utf8');
  new vm.Script(code, { filename: 'public/notes-editor.js' });

  const browserCtx = { window: {}, globalThis: null, self: null, console };
  browserCtx.globalThis = browserCtx;
  browserCtx.self = browserCtx;
  vm.runInNewContext(code, browserCtx, { filename: 'public/notes-editor.js' });

  const cjsModule = { exports: {} };
  const cjsCtx = { module: cjsModule, exports: cjsModule.exports, console };
  vm.runInNewContext(code, cjsCtx, { filename: 'public/notes-editor.js' });

  return {
    code,
    browserGlobal: browserCtx.AGYNotesEditor || browserCtx.window.AGYNotesEditor,
    cjsExports: cjsModule.exports,
  };
}

test('vendor/cm6-bundle.js parses as classic script, has no unsafe HTML sinks, and exposes all 27 CodeMirror 6 + Markdown exports', () => {
  const { code, cm } = loadVendorBundle();
  assert.equal(UNSAFE_HTML_SINK_RE.test(code), false, 'Expected zero unsafe HTML sinks in cm6-bundle.js');
  assert.ok(cm && typeof cm === 'object', 'Expected AGYCodeMirror global');
  for (const name of REQUIRED_CM6_EXPORTS) {
    assert.ok(cm[name] !== undefined, `Expected AGYCodeMirror.${name}`);
  }
  const state = cm.EditorState.create({
    doc: '## Title\n- [x] **Done**',
    extensions: [cm.markdown({ extensions: [cm.Strikethrough, cm.TaskList, cm.Autolink] })],
  });
  assert.equal(state.doc.lines, 2);
});

test('notes-editor.js parses as classic UMD script without unsafe HTML sinks', () => {
  const { code, browserGlobal, cjsExports } = loadNotesEditor();
  assert.equal(UNSAFE_HTML_SINK_RE.test(code), false, 'Expected zero unsafe HTML sinks in notes-editor.js');
  assert.ok(browserGlobal && typeof browserGlobal === 'object', 'Expected window.AGYNotesEditor object');
  assert.ok(cjsExports && typeof cjsExports === 'object', 'Expected CommonJS module.exports object');
});
