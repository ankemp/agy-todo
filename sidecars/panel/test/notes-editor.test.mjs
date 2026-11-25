import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const require = createRequire(import.meta.url);

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
  const cjsCtx = {
    module: cjsModule,
    exports: cjsModule.exports,
    require,
    __dirname: publicDir,
    console,
    URL,
  };
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

function createMarkdownState(cm, doc, anchor = 0, head = anchor) {
  return cm.EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [cm.markdown({ extensions: [cm.Strikethrough, cm.TaskList, cm.Autolink] })],
  });
}

function loadEditorWithCmInContext() {
  const cmCode = readFileSync(join(publicDir, 'vendor', 'cm6-bundle.js'), 'utf8');
  const edCode = readFileSync(join(publicDir, 'notes-editor.js'), 'utf8');
  const ctx = { window: {}, globalThis: null, self: null, console, URL };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInNewContext(cmCode, ctx, { filename: 'public/vendor/cm6-bundle.js' });
  vm.runInNewContext(edCode, ctx, { filename: 'public/notes-editor.js' });
  return {
    cm: ctx.AGYCodeMirror || ctx.window.AGYCodeMirror,
    editor: ctx.AGYNotesEditor || ctx.window.AGYNotesEditor,
  };
}

function sliceSpec(doc, spec) {
  if (spec.kind === 'line') {
    return doc.slice(spec.pos);
  }
  return doc.slice(spec.from, spec.to);
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('AGYNotesEditor exports Task 2 helpers in both browser global and CommonJS modes', () => {
  const { browserGlobal, cjsExports } = loadNotesEditor();

  for (const target of [browserGlobal, cjsExports]) {
    assert.equal(typeof target.isSafeHttpUrl, 'function');
    assert.equal(typeof target.isSelectionInRange, 'function');
    assert.equal(typeof target.isSelectionOnLine, 'function');
    assert.equal(typeof target.computeLivePreviewSpecs, 'function');
  }
  // Verify isSafeHttpUrl also works inside a bare vm context without global URL
  assert.equal(browserGlobal.isSafeHttpUrl('https://example.com'), true);
  assert.equal(browserGlobal.isSafeHttpUrl('javascript:alert(1)'), false);
});

test('isSafeHttpUrl permits only valid http(s) URLs and rejects unsafe schemes', () => {
  const { editor } = loadEditorWithCmInContext();
  const { isSafeHttpUrl } = editor;

  assert.equal(isSafeHttpUrl('https://example.com'), true);
  assert.equal(isSafeHttpUrl('http://localhost:3000/docs?x=1#top'), true);
  assert.equal(isSafeHttpUrl('HTTPS://EXAMPLE.COM/path'), true);

  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('JAVASCRIPT:alert(1)'), false);
  assert.equal(isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeHttpUrl('vbscript:msgbox(1)'), false);
  assert.equal(isSafeHttpUrl('file:///etc/passwd'), false);
  assert.equal(isSafeHttpUrl('ftp://example.com/file'), false);
  assert.equal(isSafeHttpUrl('www.example.com'), false);
  assert.equal(isSafeHttpUrl('https://'), false);
  assert.equal(isSafeHttpUrl('not a url'), false);
  assert.equal(isSafeHttpUrl(''), false);
  assert.equal(isSafeHttpUrl('   '), false);
  assert.equal(isSafeHttpUrl(null), false);
  assert.equal(isSafeHttpUrl(undefined), false);
});

test('isSelectionInRange and isSelectionOnLine handle inclusive cursor and range boundaries', () => {
  const { cm, editor } = loadEditorWithCmInContext();
  const { isSelectionInRange, isSelectionOnLine } = editor;

  const doc = '# One\n## Two\nThree';
  const stateAtTwo = createMarkdownState(cm, doc, 8);
  assert.equal(isSelectionInRange(stateAtTwo.selection, 6, 12), true);
  assert.equal(isSelectionInRange(stateAtTwo.selection, 8, 12), true);
  assert.equal(isSelectionInRange(stateAtTwo.selection, 0, 8), true);
  assert.equal(isSelectionInRange(stateAtTwo.selection, 0, 5), false);
  assert.equal(isSelectionInRange(stateAtTwo.selection, 9, 12), false);

  const line1 = stateAtTwo.doc.line(1);
  const line2 = stateAtTwo.doc.line(2);
  const line3 = stateAtTwo.doc.line(3);
  assert.equal(isSelectionOnLine(stateAtTwo, line1), false);
  assert.equal(isSelectionOnLine(stateAtTwo, line2), true);
  assert.equal(isSelectionOnLine(stateAtTwo, line3), false);

  const spanningState = createMarkdownState(cm, doc, 3, 14);
  assert.equal(isSelectionOnLine(spanningState, line1), true);
  assert.equal(isSelectionOnLine(spanningState, line2), true);
  assert.equal(isSelectionOnLine(spanningState, line3), true);
});

test('computeLivePreviewSpecs formats ATX headings # through ###### and reveals syntax only on active line', () => {
  const { cm, editor } = loadEditorWithCmInContext();
  const doc = '# One\n## Two\n###### Six\nplain';

  const offLineState = createMarkdownState(cm, doc, doc.indexOf('plain'));
  const offSpecs = editor.computeLivePreviewSpecs(offLineState, cm);

  assert.ok(offSpecs.some((s) => s.kind === 'line' && s.pos === 0 && s.className === 'cm-md-h1'));
  assert.ok(offSpecs.some((s) => s.kind === 'line' && s.pos === 6 && s.className === 'cm-md-h2'));
  assert.ok(offSpecs.some((s) => s.kind === 'line' && s.pos === 13 && s.className === 'cm-md-h6'));

  assert.ok(offSpecs.some((s) => s.kind === 'hide' && s.from === 0 && s.to === 2));
  assert.ok(offSpecs.some((s) => s.kind === 'hide' && s.from === 6 && s.to === 9));
  assert.ok(offSpecs.some((s) => s.kind === 'hide' && s.from === 13 && s.to === 20));
  assert.equal(offSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-syntax'), false);

  const onH2State = createMarkdownState(cm, doc, doc.indexOf('Two'));
  const onH2Specs = editor.computeLivePreviewSpecs(onH2State, cm);

  assert.ok(onH2Specs.some((s) => s.kind === 'line' && s.pos === 6 && s.className === 'cm-md-h2'));
  assert.ok(onH2Specs.some((s) => s.kind === 'mark' && s.from === 6 && s.to === 9 && s.className === 'cm-md-syntax'));
  assert.equal(onH2Specs.some((s) => s.kind === 'hide' && s.from === 6 && s.to === 9), false);
  // Heading 1 & 6 remain hidden while editing Heading 2
  assert.ok(onH2Specs.some((s) => s.kind === 'hide' && s.from === 0 && s.to === 2));
  assert.ok(onH2Specs.some((s) => s.kind === 'hide' && s.from === 13 && s.to === 20));
});

test('computeLivePreviewSpecs hides inline delimiters off-cursor and enforces node-scoped nested vs sibling reveal (Review Focus #3)', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  const plainDoc = '**bold** *italic* _under_ ~~strike~~ `code`\nother';
  const plainState = createMarkdownState(cm, plainDoc, plainDoc.indexOf('other'));
  const plainSpecs = editor.computeLivePreviewSpecs(plainState, cm);

  const hiddenTexts = plainSpecs.filter((s) => s.kind === 'hide').map((s) => sliceSpec(plainDoc, s));
  assert.deepEqual(toPlain(hiddenTexts), ['**', '**', '*', '*', '_', '_', '~~', '~~', '`', '`']);
  assert.ok(plainSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-strong' && sliceSpec(plainDoc, s) === 'bold'));
  assert.ok(plainSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-em' && sliceSpec(plainDoc, s) === 'italic'));
  assert.ok(plainSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-em' && sliceSpec(plainDoc, s) === 'under'));
  assert.ok(plainSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-strike' && sliceSpec(plainDoc, s) === 'strike'));
  assert.ok(plainSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-code' && sliceSpec(plainDoc, s) === 'code'));

  const rfDoc = '- [x] **Initialize:** Run `npx create`\n  - _This creates `apps/shell` now._';

  // Cursor inside **Initialize:** -> reveals ONLY **, keeps checkbox widget and sibling `npx create` hidden
  const initCursor = rfDoc.indexOf('Initialize') + 3;
  const initSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, rfDoc, initCursor), cm);

  assert.ok(
    initSpecs.some((s) => s.kind === 'widget' && s.widget === 'checkbox' && s.checked === true && s.markerFrom === 0 && s.markerTo === 5),
    'Expected checked checkbox widget to stay rendered when cursor is on bold span',
  );
  const initSyntax = initSpecs.filter((s) => s.kind === 'mark' && s.className === 'cm-md-syntax').map((s) => sliceSpec(rfDoc, s));
  assert.deepEqual(toPlain(initSyntax), ['**', '**']);

  const codeStart = rfDoc.indexOf('`npx create`');
  assert.ok(initSpecs.some((s) => s.kind === 'hide' && s.from === codeStart && s.to === codeStart + 1));
  assert.ok(initSpecs.some((s) => s.kind === 'hide' && s.from === codeStart + 11 && s.to === codeStart + 12));

  // Cursor inside _This creates `apps/shell` now._ -> reveals both enclosing _ and nested `...` while keeping bullet & indent guide
  const createsCursor = rfDoc.indexOf('creates') + 2;
  const createsSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, rfDoc, createsCursor), cm);

  const createsSyntax = createsSpecs.filter((s) => s.kind === 'mark' && s.className === 'cm-md-syntax').map((s) => sliceSpec(rfDoc, s));
  assert.deepEqual(toPlain(createsSyntax), ['_', '`', '`', '_']);
  assert.ok(createsSpecs.some((s) => s.kind === 'widget' && s.widget === 'bullet'));
  assert.ok(createsSpecs.some((s) => s.kind === 'widget' && s.widget === 'indent-guide'));
  assert.ok(createsSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-em'));
  assert.ok(createsSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-code' && sliceSpec(rfDoc, s) === 'apps/shell'));
});

test('computeLivePreviewSpecs handles task checkboxes, done styling, and raw prefix reveal when cursor is inside checkbox', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  const openDoc = '- [ ] Buy milk';
  const openSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, openDoc, openDoc.indexOf('Buy')), cm);
  assert.ok(
    openSpecs.some((s) => s.kind === 'widget' && s.widget === 'checkbox' && s.checked === false && s.markerFrom === 0 && s.markerTo === 5),
  );
  assert.equal(openSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-task-done'), false);

  const doneDoc = '- [x] Done item';
  const doneSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doneDoc, doneDoc.indexOf('Done')), cm);
  assert.ok(
    doneSpecs.some((s) => s.kind === 'widget' && s.widget === 'checkbox' && s.checked === true && s.markerFrom === 0 && s.markerTo === 5),
  );
  assert.ok(
    doneSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-task-done' && sliceSpec(doneDoc, s) === 'Done item'),
  );

  // Cursor specifically inside `- [x]` prefix -> NO checkbox widget; raw prefix gets cm-md-syntax
  const prefixSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doneDoc, 3), cm);
  assert.equal(prefixSpecs.some((s) => s.kind === 'widget' && s.widget === 'checkbox'), false);
  assert.ok(prefixSpecs.some((s) => s.kind === 'mark' && s.from === 0 && s.to === 5 && s.className === 'cm-md-syntax'));
});

test('computeLivePreviewSpecs handles bullets, ordered list numbers, and nested indent guides', () => {
  const { cm, editor } = loadEditorWithCmInContext();
  const doc = '- parent\n  - child\n    - grandchild\n\t- tab child\n* star\n+ plus\n1. first\n2. second';

  const specs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doc, doc.indexOf('first')), cm);

  const bulletWidgets = specs.filter((s) => s.kind === 'widget' && s.widget === 'bullet');
  assert.equal(bulletWidgets.length, 6);

  const line2From = doc.indexOf('  - child');
  const line3From = doc.indexOf('    - grandchild');
  const line4From = doc.indexOf('\t- tab child');

  const line2Guides = specs.filter((s) => s.kind === 'widget' && s.widget === 'indent-guide' && s.from >= line2From && s.from < line3From);
  assert.equal(line2Guides.length, 1);

  const line3Guides = specs.filter((s) => s.kind === 'widget' && s.widget === 'indent-guide' && s.from >= line3From && s.from < line4From);
  assert.equal(line3Guides.length, 2);

  const line4Guides = specs.filter((s) => s.kind === 'widget' && s.widget === 'indent-guide' && s.from >= line4From && s.from < doc.indexOf('* star'));
  assert.equal(line4Guides.length, 1);

  const listNums = specs.filter((s) => s.kind === 'mark' && s.className === 'cm-md-list-num').map((s) => sliceSpec(doc, s));
  assert.deepEqual(toPlain(listNums), ['1.', '2.']);

  // Cursor inside bullet '-' reveals syntax instead of bullet widget
  const bulletCursorSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doc, 0), cm);
  assert.ok(bulletCursorSpecs.some((s) => s.kind === 'mark' && s.from === 0 && s.to === 1 && s.className === 'cm-md-syntax'));
  assert.equal(bulletCursorSpecs.some((s) => s.kind === 'widget' && s.widget === 'bullet' && s.from === 0), false);
});

test('computeLivePreviewSpecs renders safe links, reveals link syntax on cursor, and blocks unsafe URL schemes (Review Focus #2)', () => {
  const { cm, editor } = loadEditorWithCmInContext();
  const doc = '[Docs](https://example.com) and [Bad](javascript:alert(1)) and [Data](data:text/html,x) and https://example.com/bare and [plain]';

  const offSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doc, doc.indexOf('[plain]')), cm);

  const docsMark = offSpecs.find((s) => s.kind === 'mark' && s.className === 'cm-md-link' && sliceSpec(doc, s) === 'Docs');
  assert.ok(docsMark);
  assert.deepEqual(toPlain(docsMark.attrs), {
    'data-md-href': 'https://example.com',
    title: 'Cmd/Ctrl+Click to open https://example.com',
  });
  assert.ok(offSpecs.some((s) => s.kind === 'hide' && sliceSpec(doc, s) === '['));
  assert.ok(offSpecs.some((s) => s.kind === 'hide' && sliceSpec(doc, s) === '](https://example.com)'));

  const bareMark = offSpecs.find((s) => s.kind === 'mark' && s.className === 'cm-md-link' && sliceSpec(doc, s) === 'https://example.com/bare');
  assert.ok(bareMark);
  assert.equal(bareMark.attrs?.['data-md-href'], 'https://example.com/bare');

  // Unsafe URLs NEVER receive data-md-href or title
  const anyUnsafeAttr = offSpecs.some(
    (s) => s.attrs && (String(s.attrs['data-md-href'] || '').includes('javascript:') || String(s.attrs['data-md-href'] || '').includes('data:') || String(s.attrs.title || '').includes('javascript:')),
  );
  assert.equal(anyUnsafeAttr, false);

  // Plain bracket text is not hidden
  assert.equal(offSpecs.some((s) => s.kind === 'hide' && s.from === doc.indexOf('[plain]')), false);

  // Cursor inside [Docs](https://example.com) reveals syntax & URL
  const onLinkSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doc, doc.indexOf('Docs') + 1), cm);
  assert.ok(onLinkSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-syntax' && s.from === 0 && s.to === 1));
  assert.ok(onLinkSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-syntax' && sliceSpec(doc, s) === ']('));
  assert.ok(onLinkSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-link-url' && sliceSpec(doc, s) === 'https://example.com'));
  assert.ok(onLinkSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-syntax' && s.from === 26 && s.to === 27));
});

test('computeLivePreviewSpecs handles blockquotes and horizontal rules', () => {
  const { cm, editor } = loadEditorWithCmInContext();
  const doc = '> Quoted\n> Second\n\n---\n***\n___';

  const offSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doc, doc.indexOf('***')), cm);
  assert.ok(offSpecs.some((s) => s.kind === 'line' && s.pos === 0 && s.className === 'cm-md-quote'));
  assert.ok(offSpecs.some((s) => s.kind === 'line' && s.pos === 9 && s.className === 'cm-md-quote'));
  assert.ok(offSpecs.some((s) => s.kind === 'hide' && s.from === 0 && s.to === 2));
  assert.ok(offSpecs.some((s) => s.kind === 'hide' && s.from === 9 && s.to === 11));

  const hr1From = doc.indexOf('---');
  assert.ok(offSpecs.some((s) => s.kind === 'widget' && s.widget === 'hr' && s.from === hr1From && s.to === hr1From + 3));

  const hr2From = doc.indexOf('***');
  assert.ok(offSpecs.some((s) => s.kind === 'mark' && s.className === 'cm-md-syntax' && s.from === hr2From && s.to === hr2From + 3));

  const onQuoteSpecs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doc, 3), cm);
  assert.ok(onQuoteSpecs.some((s) => s.kind === 'line' && s.pos === 0 && s.className === 'cm-md-quote'));
  assert.ok(onQuoteSpecs.some((s) => s.kind === 'mark' && s.from === 0 && s.to === 2 && s.className === 'cm-md-syntax'));
  assert.ok(onQuoteSpecs.some((s) => s.kind === 'hide' && s.from === 9 && s.to === 11));
});

function buildDecorationSet(cm, specs) {
  class DummyWidget extends cm.WidgetType {
    toDOM() {
      return {};
    }
  }
  const builder = new cm.RangeSetBuilder();
  for (const spec of specs) {
    if (spec.kind === 'line') {
      builder.add(spec.pos, spec.pos, cm.Decoration.line({ class: spec.className }));
    } else if (spec.kind === 'hide') {
      builder.add(spec.from, spec.to, cm.Decoration.replace({}));
    } else if (spec.kind === 'mark') {
      builder.add(spec.from, spec.to, cm.Decoration.mark({ class: spec.className, attributes: spec.attrs }));
    } else if (spec.kind === 'widget') {
      if (spec.from === spec.to) {
        builder.add(spec.from, spec.to, cm.Decoration.widget({ widget: new DummyWidget(), side: -1 }));
      } else {
        builder.add(spec.from, spec.to, cm.Decoration.replace({ widget: new DummyWidget() }));
      }
    }
  }
  return builder.finish();
}

test('computeLivePreviewSpecs works without explicit cm in CommonJS and browser globals, and sorts specs compatibly with RangeSetBuilder', () => {
  const { cm, editor } = loadEditorWithCmInContext();
  const { cjsExports } = loadNotesEditor();

  const doc = [
    '# Heading',
    '- [x] **Bold** `code` [Link](https://example.com)',
    '  - _Nested `item`_',
    '> Quote line',
    '---',
  ].join('\n');

  const state = createMarkdownState(cm, doc, 0);
  // Call with omitted second arg in both CommonJS and global AGYCodeMirror modes
  const cjsSpecs = cjsExports.computeLivePreviewSpecs(state);
  const globalSpecs = editor.computeLivePreviewSpecs(state);
  assert.ok(Array.isArray(cjsSpecs) && cjsSpecs.length > 0);
  assert.deepEqual(toPlain(cjsSpecs), toPlain(globalSpecs));

  const decoSet = buildDecorationSet(cm, globalSpecs);
  assert.ok(decoSet.size > 0);
});

test('computeLivePreviewSpecs handles empty docs, autolinks, angle-bracket links, quoted blocks, and ignores fenced code blocks', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  assert.deepEqual(toPlain(editor.computeLivePreviewSpecs(createMarkdownState(cm, '', 0), cm)), []);

  const doc = [
    '<https://example.com/auto>',
    '[Angle](<https://example.com/angle>)',
    '> ## Quoted Heading',
    '> - Quoted item',
    '>   - Nested quoted item',
    '> ---',
    '```js',
    '# Not a heading',
    '- [ ] Not a task',
    '```',
  ].join('\n');

  const specs = editor.computeLivePreviewSpecs(createMarkdownState(cm, doc, doc.indexOf('Not a heading')), cm);
  assert.ok(specs.some((s) => s.kind === 'mark' && s.className === 'cm-md-link' && s.attrs?.['data-md-href'] === 'https://example.com/auto'));
  assert.ok(specs.some((s) => s.kind === 'mark' && s.className === 'cm-md-link' && s.attrs?.['data-md-href'] === 'https://example.com/angle'));
  assert.ok(specs.some((s) => s.kind === 'line' && s.className === 'cm-md-quote'));
  assert.ok(specs.some((s) => s.kind === 'line' && s.className === 'cm-md-h2'));
  assert.ok(specs.some((s) => s.kind === 'widget' && s.widget === 'indent-guide'));
  assert.ok(specs.some((s) => s.kind === 'widget' && s.widget === 'hr'));

  const fencedStart = doc.indexOf('```js');
  assert.equal(specs.some((s) => (s.kind === 'line' ? s.pos : s.from) >= fencedStart), false);
  assert.ok(buildDecorationSet(cm, specs).size > 0);
});

function applySpec(state, spec) {
  assert.ok(spec && typeof spec === 'object', 'Expected non-null TransactionSpec');
  return state.update(spec).state;
}

test('AGYNotesEditor exports Task 3 ergonomics helpers and keymap builder in browser global and CommonJS modes', () => {
  const { browserGlobal, cjsExports } = loadNotesEditor();

  for (const target of [browserGlobal, cjsExports]) {
    assert.equal(typeof target.isSafeHttpUrl, 'function');
    assert.equal(typeof target.isSelectionInRange, 'function');
    assert.equal(typeof target.isSelectionOnLine, 'function');
    assert.equal(typeof target.computeLivePreviewSpecs, 'function');
    assert.equal(typeof target.computeSmartEnter, 'function');
    assert.equal(typeof target.computeSmartTab, 'function');
    assert.equal(typeof target.computeToggleInlineWrap, 'function');
    assert.equal(typeof target.computeInsertLink, 'function');
    assert.equal(typeof target.computeDelimiterWrap, 'function');
    assert.equal(typeof target.computeToggleTask, 'function');
    assert.equal(typeof target.createNotesKeymap, 'function');
  }
});

test('computeSmartEnter continues tasks, bullets, ordered lists, blockquotes, exits empty prefixes, and returns null on plain lines', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  // Task continuation resets checked state to unchecked and preserves indent/marker
  const doneTaskState = createMarkdownState(cm, '- [x] Done', '- [x] Done'.length);
  const doneTaskNext = applySpec(doneTaskState, editor.computeSmartEnter(doneTaskState));
  assert.equal(doneTaskNext.doc.toString(), '- [x] Done\n- [ ] ');
  assert.equal(doneTaskNext.selection.main.anchor, '- [x] Done\n- [ ] '.length);

  const nestedTaskState = createMarkdownState(cm, '  * [X] Subtask', '  * [X] Subtask'.length);
  const nestedTaskNext = applySpec(nestedTaskState, editor.computeSmartEnter(nestedTaskState));
  assert.equal(nestedTaskNext.doc.toString(), '  * [X] Subtask\n  * [ ] ');

  // Empty task clears line to exit list
  const emptyTaskDoc = '# Notes\n  - [ ] ';
  const emptyTaskState = createMarkdownState(cm, emptyTaskDoc, emptyTaskDoc.length);
  const emptyTaskNext = applySpec(emptyTaskState, editor.computeSmartEnter(emptyTaskState));
  assert.equal(emptyTaskNext.doc.toString(), '# Notes\n');
  assert.equal(emptyTaskNext.selection.main.anchor, '# Notes\n'.length);

  // Bullet continuation and exit
  const bulletState = createMarkdownState(cm, '- Item', '- Item'.length);
  const bulletNext = applySpec(bulletState, editor.computeSmartEnter(bulletState));
  assert.equal(bulletNext.doc.toString(), '- Item\n- ');

  const emptyBulletState = createMarkdownState(cm, '- ', 2);
  const emptyBulletNext = applySpec(emptyBulletState, editor.computeSmartEnter(emptyBulletState));
  assert.equal(emptyBulletNext.doc.toString(), '');
  assert.equal(emptyBulletNext.selection.main.anchor, 0);

  // Ordered list increments number and exits on empty
  const orderedState = createMarkdownState(cm, '1. First', '1. First'.length);
  const orderedNext = applySpec(orderedState, editor.computeSmartEnter(orderedState));
  assert.equal(orderedNext.doc.toString(), '1. First\n2. ');

  const parenOrderedState = createMarkdownState(cm, '9) Ninth', '9) Ninth'.length);
  const parenOrderedNext = applySpec(parenOrderedState, editor.computeSmartEnter(parenOrderedState));
  assert.equal(parenOrderedNext.doc.toString(), '9) Ninth\n10) ');

  const emptyOrderedState = createMarkdownState(cm, '2. ', 3);
  const emptyOrderedNext = applySpec(emptyOrderedState, editor.computeSmartEnter(emptyOrderedState));
  assert.equal(emptyOrderedNext.doc.toString(), '');

  // Blockquote continuation and exit
  const quoteState = createMarkdownState(cm, '> Quote', '> Quote'.length);
  const quoteNext = applySpec(quoteState, editor.computeSmartEnter(quoteState));
  assert.equal(quoteNext.doc.toString(), '> Quote\n> ');

  const emptyQuoteState = createMarkdownState(cm, '> ', 2);
  const emptyQuoteNext = applySpec(emptyQuoteState, editor.computeSmartEnter(emptyQuoteState));
  assert.equal(emptyQuoteNext.doc.toString(), '');

  // Mid-line split preserves trailing text on new list item
  const splitDoc = '- [ ] HelloWorld';
  const splitState = createMarkdownState(cm, splitDoc, '- [ ] Hello'.length);
  const splitNext = applySpec(splitState, editor.computeSmartEnter(splitState));
  assert.equal(splitNext.doc.toString(), '- [ ] Hello\n- [ ] World');

  // Plain lines, horizontal rules, cursor before prefix, and fenced code return null
  assert.equal(editor.computeSmartEnter(createMarkdownState(cm, 'Hello', 5)), null);
  assert.equal(editor.computeSmartEnter(createMarkdownState(cm, '- - -', 5)), null);
  assert.equal(editor.computeSmartEnter(createMarkdownState(cm, '- Item', 0)), null);
  const fencedDoc = '```md\n- inside code\n```';
  assert.equal(editor.computeSmartEnter(createMarkdownState(cm, fencedDoc, fencedDoc.indexOf('code') + 4)), null);
});

test('computeSmartTab indents/outdents list lines and returns null on non-list lines for Tab focus traversal (Review Focus #5)', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  // Bullet indent & outdent
  const bulletState = createMarkdownState(cm, '- item', 0);
  const indented = applySpec(bulletState, editor.computeSmartTab(bulletState, false));
  assert.equal(indented.doc.toString(), '  - item');
  assert.equal(indented.selection.main.anchor, 2);

  const outdented = applySpec(indented, editor.computeSmartTab(indented, true));
  assert.equal(outdented.doc.toString(), '- item');
  assert.equal(outdented.selection.main.anchor, 0);

  // Leading tab outdent and single-space outdent
  const tabBulletState = createMarkdownState(cm, '\t- item', 3);
  const tabOutdented = applySpec(tabBulletState, editor.computeSmartTab(tabBulletState, true));
  assert.equal(tabOutdented.doc.toString(), '- item');
  assert.equal(tabOutdented.selection.main.anchor, 2);

  const oneSpaceState = createMarkdownState(cm, ' - item', 3);
  const oneSpaceOutdented = applySpec(oneSpaceState, editor.computeSmartTab(oneSpaceState, true));
  assert.equal(oneSpaceOutdented.doc.toString(), '- item');

  // Nested task & ordered list
  const taskState = createMarkdownState(cm, '  - [ ] task', '  - [ ] task'.length);
  const indentedTask = applySpec(taskState, editor.computeSmartTab(taskState, false));
  assert.equal(indentedTask.doc.toString(), '    - [ ] task');

  const orderedState = createMarkdownState(cm, '1. item', 4);
  const indentedOrdered = applySpec(orderedState, editor.computeSmartTab(orderedState, false));
  assert.equal(indentedOrdered.doc.toString(), '  1. item');

  // Multi-line list selection
  const multiDoc = '- one\n- two';
  const multiState = createMarkdownState(cm, multiDoc, 0, multiDoc.length);
  const multiIndented = applySpec(multiState, editor.computeSmartTab(multiState, false));
  assert.equal(multiIndented.doc.toString(), '  - one\n  - two');

  // Outdent at column 0 has nothing to outdent -> null
  assert.equal(editor.computeSmartTab(createMarkdownState(cm, '- item', 2), true), null);

  // Non-list lines return null so Tab / Shift-Tab moves focus outside editor naturally
  assert.equal(editor.computeSmartTab(createMarkdownState(cm, 'Hello world', 5), false), null);
  assert.equal(editor.computeSmartTab(createMarkdownState(cm, 'Hello world', 5), true), null);
  assert.equal(editor.computeSmartTab(createMarkdownState(cm, '', 0), false), null);
  assert.equal(editor.computeSmartTab(createMarkdownState(cm, '> quote', 4), false), null);
  assert.equal(editor.computeSmartTab(createMarkdownState(cm, '---', 3), false), null);
});

test('computeToggleInlineWrap wraps/unwraps selections and centers empty cursor for **, *, and `', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  for (const marker of ['**', '*', '`']) {
    const startState = createMarkdownState(cm, 'hello', 0, 5);
    const wrapped = applySpec(startState, editor.computeToggleInlineWrap(startState, marker));
    assert.equal(wrapped.doc.toString(), `${marker}hello${marker}`);
    assert.equal(wrapped.doc.sliceString(wrapped.selection.main.from, wrapped.selection.main.to), 'hello');

    const unwrapped = applySpec(wrapped, editor.computeToggleInlineWrap(wrapped, marker));
    assert.equal(unwrapped.doc.toString(), 'hello');
    assert.equal(unwrapped.selection.main.from, 0);
    assert.equal(unwrapped.selection.main.to, 5);
  }

  // Unwrapping when delimiters are included inside the selection
  const fullSelected = createMarkdownState(cm, '**hello**', 0, 9);
  const fullUnwrapped = applySpec(fullSelected, editor.computeToggleInlineWrap(fullSelected, '**'));
  assert.equal(fullUnwrapped.doc.toString(), 'hello');
  assert.equal(fullUnwrapped.selection.main.from, 0);
  assert.equal(fullUnwrapped.selection.main.to, 5);

  // Applying italic * onto bold **hello** adds ***hello*** instead of breaking **
  const boldInner = createMarkdownState(cm, '**hello**', 2, 7);
  const boldItalic = applySpec(boldInner, editor.computeToggleInlineWrap(boldInner, '*'));
  assert.equal(boldItalic.doc.toString(), '***hello***');
  const backToBold = applySpec(boldItalic, editor.computeToggleInlineWrap(boldItalic, '*'));
  assert.equal(backToBold.doc.toString(), '**hello**');

  // Empty selection centers cursor between markers
  const emptyState = createMarkdownState(cm, 'ab', 1);
  const emptyWrapped = applySpec(emptyState, editor.computeToggleInlineWrap(emptyState, '*'));
  assert.equal(emptyWrapped.doc.toString(), 'a**b');
  assert.equal(emptyWrapped.selection.main.anchor, 2);
});

test('computeInsertLink handles text selection, safe http(s) URL selection, unsafe schemes, and empty cursor', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  const textDoc = 'Read Docs now';
  const textState = createMarkdownState(cm, textDoc, textDoc.indexOf('Docs'), textDoc.indexOf('Docs') + 4);
  const textLinked = applySpec(textState, editor.computeInsertLink(textState));
  assert.equal(textLinked.doc.toString(), 'Read [Docs](url) now');
  assert.equal(textLinked.doc.sliceString(textLinked.selection.main.from, textLinked.selection.main.to), 'url');

  const urlDoc = 'https://example.com';
  const urlState = createMarkdownState(cm, urlDoc, 0, urlDoc.length);
  const urlLinked = applySpec(urlState, editor.computeInsertLink(urlState));
  assert.equal(urlLinked.doc.toString(), '[](https://example.com)');
  assert.equal(urlLinked.selection.main.empty, true);
  assert.equal(urlLinked.selection.main.anchor, 1);

  // Unsafe URL is treated as link text rather than a URL
  const unsafeDoc = 'javascript:alert(1)';
  const unsafeState = createMarkdownState(cm, unsafeDoc, 0, unsafeDoc.length);
  const unsafeLinked = applySpec(unsafeState, editor.computeInsertLink(unsafeState));
  assert.equal(unsafeLinked.doc.toString(), '[javascript:alert(1)](url)');
  assert.equal(unsafeLinked.doc.sliceString(unsafeLinked.selection.main.from, unsafeLinked.selection.main.to), 'url');

  // Empty selection places cursor inside []
  const emptyState = createMarkdownState(cm, 'ab', 1);
  const emptyLinked = applySpec(emptyState, editor.computeInsertLink(emptyState));
  assert.equal(emptyLinked.doc.toString(), 'a[](url)b');
  assert.equal(emptyLinked.selection.main.empty, true);
  assert.equal(emptyLinked.selection.main.anchor, 2);
});

test('computeDelimiterWrap wraps non-empty selections on *, _, `, ~, [ and returns null otherwise', () => {
  const { cm, editor } = loadEditorWithCmInContext();
  const baseDoc = 'a word b';
  const from = baseDoc.indexOf('word');
  const to = from + 4;
  const state = createMarkdownState(cm, baseDoc, from, to);

  for (const [open, close] of [['*', '*'], ['_', '_'], ['`', '`'], ['~', '~'], ['[', ']']]) {
    const next = applySpec(state, editor.computeDelimiterWrap(state, from, to, open));
    assert.equal(next.doc.toString(), `a ${open}word${close} b`);
    assert.equal(next.doc.sliceString(next.selection.main.from, next.selection.main.to), 'word');
  }

  assert.equal(editor.computeDelimiterWrap(state, from, from, '*'), null);
  assert.equal(editor.computeDelimiterWrap(state, from, to, 'a'), null);
  assert.equal(editor.computeDelimiterWrap(state, from, to, '**'), null);
});

test('computeToggleTask toggles [ ], [x], [X] markers and ignores non-task ranges or read-only states', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  const openState = createMarkdownState(cm, '- [ ] Buy milk', 10);
  const checked = applySpec(openState, editor.computeToggleTask(openState, 0, 5));
  assert.equal(checked.doc.toString(), '- [x] Buy milk');
  assert.equal(checked.selection.main.anchor, 10);

  const unchecked = applySpec(checked, editor.computeToggleTask(checked, 2, 5));
  assert.equal(unchecked.doc.toString(), '- [ ] Buy milk');

  const upperState = createMarkdownState(cm, '* [X] Done', 0);
  const upperUnchecked = applySpec(upperState, editor.computeToggleTask(upperState, 0, 5));
  assert.equal(upperUnchecked.doc.toString(), '* [ ] Done');

  const nonTaskState = createMarkdownState(cm, '- Plain item', 0);
  assert.equal(editor.computeToggleTask(nonTaskState, 0, 2), null);
  assert.equal(editor.computeToggleTask(nonTaskState, 0, 99), null);

  const readOnlyState = cm.EditorState.create({
    doc: '- [ ] Locked',
    extensions: [cm.EditorState.readOnly.of(true)],
  });
  assert.equal(editor.computeToggleTask(readOnlyState, 0, 5), null);
});

test('createNotesKeymap binds all 7 Obsidian chords and prevents Hub forwarding on claimed modifier chords when editable (Review Focus #5)', () => {
  const { cm, editor } = loadEditorWithCmInContext();

  // 1. Real CM6 state acceptance & high-precedence registered bindings
  const realExt = editor.createNotesKeymap(cm);
  const realState = cm.EditorState.create({
    doc: '- item',
    extensions: [cm.markdown({ extensions: [cm.Strikethrough, cm.TaskList, cm.Autolink] }), realExt],
  });
  const keymapLayers = realState.facet(cm.keymap);
  assert.ok(keymapLayers.length >= 1);
  const boundKeys = keymapLayers[0].map((b) => b.key);
  assert.deepEqual(toPlain(boundKeys), ['Enter', 'Tab', 'Shift-Tab', 'Mod-b', 'Mod-i', 'Mod-`', 'Mod-k']);

  // 2. Instrumented CM6 wrapper to exercise keymap run() handlers and domEventHandlers keydown guard
  let capturedBindings = null;
  let capturedPrec = null;
  let capturedDomHandlers = null;
  const spyCm = {
    ...cm,
    Prec: {
      ...cm.Prec,
      highest(ext) {
        capturedPrec = 'highest';
        return cm.Prec.highest(ext);
      },
    },
    keymap: {
      ...cm.keymap,
      of(bindings) {
        capturedBindings = bindings;
        return cm.keymap.of(bindings);
      },
    },
    EditorView: {
      ...cm.EditorView,
      domEventHandlers(handlers) {
        capturedDomHandlers = handlers;
        return cm.EditorView.domEventHandlers(handlers);
      },
    },
  };

  editor.createNotesKeymap(spyCm);
  assert.equal(capturedPrec, 'highest');
  assert.ok(Array.isArray(capturedBindings));
  assert.equal(typeof capturedDomHandlers?.keydown, 'function');

  const byKey = new Map(capturedBindings.map((b) => [b.key, b]));
  const makeView = (doc, anchor, head = anchor, extraExts = []) => {
    const view = {
      state: cm.EditorState.create({
        doc,
        selection: { anchor, head },
        extensions: [cm.markdown({ extensions: [cm.Strikethrough, cm.TaskList, cm.Autolink] }), ...extraExts],
      }),
      dispatched: 0,
      dispatch(spec) {
        view.dispatched += 1;
        view.state = view.state.update(spec).state;
      },
    };
    return view;
  };

  // Enter & Tab passthrough vs handled
  const plainView = makeView('plain', 5);
  assert.equal(byKey.get('Enter').run(plainView), false);
  assert.equal(byKey.get('Tab').run(plainView), false);
  assert.equal(byKey.get('Shift-Tab').run(plainView), false);
  assert.equal(plainView.dispatched, 0);

  const listView = makeView('- item', 6);
  assert.equal(byKey.get('Tab').run(listView), true);
  assert.equal(listView.state.doc.toString(), '  - item');
  assert.equal(byKey.get('Shift-Tab').run(listView), true);
  assert.equal(listView.state.doc.toString(), '- item');
  assert.equal(byKey.get('Enter').run(listView), true);
  assert.equal(listView.state.doc.toString(), '- item\n- ');

  // Mod-b, Mod-i, Mod-`, Mod-k
  const fmtView = makeView('word', 0, 4);
  assert.equal(byKey.get('Mod-b').run(fmtView), true);
  assert.equal(fmtView.state.doc.toString(), '**word**');

  const italicView = makeView('word', 0, 4);
  assert.equal(byKey.get('Mod-i').run(italicView), true);
  assert.equal(italicView.state.doc.toString(), '*word*');

  const codeView = makeView('word', 0, 4);
  assert.equal(byKey.get('Mod-`').run(codeView), true);
  assert.equal(codeView.state.doc.toString(), '`word`');

  const linkView = makeView('Docs', 0, 4);
  assert.equal(byKey.get('Mod-k').run(linkView), true);
  assert.equal(linkView.state.doc.toString(), '[Docs](url)');

  // domEventHandlers keydown guard prevents default for claimed Mod chords when editable (and returns false so keymap runs)
  const makeEvent = (overrides) => ({
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...overrides,
  });

  for (const chord of [
    { key: 'b', metaKey: true },
    { key: 'i', metaKey: true },
    { key: '`', metaKey: true },
    { key: 'k', metaKey: true },
    { key: 'k', ctrlKey: true },
    { key: 'Dead', code: 'Backquote', metaKey: true },
  ]) {
    const ev = makeEvent(chord);
    const handled = capturedDomHandlers.keydown(ev, fmtView);
    assert.equal(ev.defaultPrevented, true, `Expected preventDefault() for ${JSON.stringify(chord)}`);
    assert.equal(Boolean(handled), false, 'Expected domEventHandlers to allow keymap execution');
  }

  // Non-claimed chords must NOT call preventDefault()
  for (const ignored of [
    { key: 'c', metaKey: true },
    { key: 'z', metaKey: true },
    { key: 'b', metaKey: false, ctrlKey: false },
    { key: 'b', metaKey: true, shiftKey: true },
    { key: 'b', metaKey: true, altKey: true },
  ]) {
    const ev = makeEvent(ignored);
    capturedDomHandlers.keydown(ev, fmtView);
    assert.equal(ev.defaultPrevented, false, `Did not expect preventDefault() for ${JSON.stringify(ignored)}`);
  }

  // Disabled / read-only views must block both domEventHandlers prevention and keymap mutations
  const readOnlyView = makeView('word', 0, 4, [cm.EditorState.readOnly.of(true)]);
  const nonEditableView = makeView('word', 0, 4, [cm.EditorView.editable.of(false)]);
  for (const lockedView of [readOnlyView, nonEditableView]) {
    const ev = makeEvent({ key: 'b', metaKey: true });
    capturedDomHandlers.keydown(ev, lockedView);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(byKey.get('Mod-b').run(lockedView), false);
    assert.equal(byKey.get('Enter').run(lockedView), false);
    assert.equal(lockedView.dispatched, 0);
  }
});

// ============================================================================
// Task 4 Tests: Widgets, DecorationSet, Extensions, Mode Toggle & Adapter
// ============================================================================

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

function createDomHarness({ withCreateRange = false } = {}) {
  class MiniClassList {
    constructor(el) {
      this.el = el;
      this.set = new Set();
    }
    _sync(value) {
      this.set = new Set(String(value || '').split(/\s+/).filter(Boolean));
    }
    add(...tokens) {
      for (const t of tokens) if (t) this.set.add(t);
      this.el._className = Array.from(this.set).join(' ');
    }
    remove(...tokens) {
      for (const t of tokens) this.set.delete(t);
      this.el._className = Array.from(this.set).join(' ');
    }
    toggle(token, force) {
      const next = force === undefined ? !this.set.has(token) : Boolean(force);
      if (next) this.set.add(token);
      else this.set.delete(token);
      this.el._className = Array.from(this.set).join(' ');
      return next;
    }
    contains(token) {
      return this.set.has(token);
    }
  }

  class MiniEventTarget {
    constructor() {
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (!list) return;
      this._listeners.set(
        type,
        list.filter((entry) => entry !== fn),
      );
    }
    listenerCount(type) {
      return (this._listeners.get(type) || []).length;
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      event.currentTarget = this;
      if (typeof event.preventDefault !== 'function') {
        event.preventDefault = () => { event.defaultPrevented = true; };
      }
      if (typeof event.stopPropagation !== 'function') {
        event.stopPropagation = () => { event.propagationStopped = true; };
      }
      for (const fn of [...(this._listeners.get(event.type) || [])]) {
        fn.call(this, event);
      }
      if (!event.propagationStopped && this.parentNode && typeof this.parentNode.dispatchEvent === 'function') {
        this.parentNode.dispatchEvent(event);
      }
    }
  }

  class MiniElement extends MiniEventTarget {
    constructor(tagName, ownerDocument) {
      super();
      this.tagName = String(tagName || 'div').toUpperCase();
      this.nodeType = 1;
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.parentNode = null;
      this._attrs = new Map();
      this._className = '';
      this.classList = new MiniClassList(this);
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.textContent = '';
      this.checked = false;
      this.type = '';
      this.title = '';
      this.placeholder = '';
    }
    get className() {
      return this._className;
    }
    set className(val) {
      this._className = String(val || '');
      this.classList._sync(this._className);
    }
    get parentElement() {
      return this.parentNode;
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    setAttribute(name, value) {
      const str = String(value);
      this._attrs.set(name, str);
      if (name === 'title') this.title = str;
    }
    getAttribute(name) {
      if (name === 'title' && this.title) return this.title;
      return this._attrs.has(name) ? this._attrs.get(name) : null;
    }
    closest(selector) {
      const attrMatch = selector.match(/^\[([^=\]]+)\]$/);
      let cur = this;
      while (cur) {
        if (attrMatch && typeof cur.getAttribute === 'function' && cur.getAttribute(attrMatch[1]) !== null) {
          return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }
    focus() {
      this.ownerDocument.activeElement = this;
    }
    click() {
      this.dispatchEvent({ type: 'click', target: this });
    }
  }

  const doc = {
    activeElement: null,
    createElement(tag) {
      return new MiniElement(tag, doc);
    },
  };
  doc.documentElement = new MiniElement('html', doc);
  doc.head = new MiniElement('head', doc);
  doc.body = new MiniElement('body', doc);
  if (withCreateRange) {
    doc.createRange = () => ({});
  }
  const win = new MiniEventTarget();
  win.openCalls = [];
  win.open = (...args) => {
    win.openCalls.push(args);
  };
  return { doc, win, MiniElement };
}

function loadEditorWithDomEnv({ withCreateRange = false, storage = null } = {}) {
  const { doc, win, MiniElement } = createDomHarness({ withCreateRange });
  const cmCode = readFileSync(join(publicDir, 'vendor', 'cm6-bundle.js'), 'utf8');
  const edCode = readFileSync(join(publicDir, 'notes-editor.js'), 'utf8');
  const ctx = {
    window: win,
    document: doc,
    localStorage: storage || createMemoryStorage(),
    globalThis: null,
    self: null,
    console,
    URL,
  };
  win.window = win;
  win.document = doc;
  win.localStorage = ctx.localStorage;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInNewContext(cmCode, ctx, { filename: 'public/vendor/cm6-bundle.js' });
  vm.runInNewContext(edCode, ctx, { filename: 'public/notes-editor.js' });
  return {
    cm: ctx.AGYCodeMirror || ctx.window.AGYCodeMirror,
    editor: ctx.AGYNotesEditor || ctx.window.AGYNotesEditor,
    doc,
    win,
    MiniElement,
    storage: ctx.localStorage,
  };
}

test('AGYNotesEditor exports Task 4 API surface in both browser global and CommonJS modes', () => {
  const { browserGlobal, cjsExports } = loadNotesEditor();

  for (const target of [browserGlobal, cjsExports]) {
    assert.equal(target.NOTES_MODE_STORAGE_KEY, 'agy-todo.notes-mode');
    assert.equal(typeof target.loadSavedNotesMode, 'function');
    assert.equal(typeof target.saveNotesMode, 'function');
    assert.equal(typeof target.buildDecorationsFromSpecs, 'function');
    assert.equal(typeof target.buildDecorationSet, 'function');
    assert.equal(typeof target.buildEditorExtensions, 'function');
    assert.equal(typeof target.handleLinkClick, 'function');
    assert.equal(typeof target.createNotesEditor, 'function');
  }
});

test('loadSavedNotesMode and saveNotesMode handle live, source, invalid values, and throwing storage safely', () => {
  const { editor } = loadEditorWithCmInContext();
  assert.equal(editor.NOTES_MODE_STORAGE_KEY, 'agy-todo.notes-mode');

  const storage = createMemoryStorage();
  assert.equal(editor.loadSavedNotesMode(storage), 'live');

  editor.saveNotesMode('source', storage);
  assert.equal(storage.getItem('agy-todo.notes-mode'), 'source');
  assert.equal(editor.loadSavedNotesMode(storage), 'source');

  editor.saveNotesMode('live', storage);
  assert.equal(storage.getItem('agy-todo.notes-mode'), 'live');
  assert.equal(editor.loadSavedNotesMode(storage), 'live');

  storage.setItem('agy-todo.notes-mode', 'invalid-mode');
  assert.equal(editor.loadSavedNotesMode(storage), 'live');

  editor.saveNotesMode('bogus', storage);
  assert.equal(storage.getItem('agy-todo.notes-mode'), 'live');

  const brokenStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(editor.loadSavedNotesMode(brokenStorage), 'live');
  assert.doesNotThrow(() => editor.saveNotesMode('source', brokenStorage));
  assert.equal(editor.loadSavedNotesMode(null), 'live');
});

test('buildDecorationSet and buildDecorationsFromSpecs construct valid RangeSetBuilder DecorationSets on complex mixed documents without range errors', () => {
  const { cm, editor, doc } = loadEditorWithDomEnv({ withCreateRange: true });

  const complexDoc = [
    '# Heading 1',
    '## Heading 2',
    '###### Heading 6',
    '- [x] **bold** `code` ~~strike~~ [Docs](https://example.com) [Bad](javascript:alert(1))',
    '- [ ] open task with bare https://example.com/bare',
    '  - _text `code`_',
    '    - grandchild bullet',
    '\t- tab bullet',
    '1. ordered first',
    '2. ordered second',
    '> Quoted line',
    '> - [x] quoted task',
    '---',
    '[multi',
    'line](',
    'https://example.com/multiline',
    ')',
  ].join('\n');

  const positionsToCheck = [
    0,
    complexDoc.indexOf('Heading 2') + 2,
    complexDoc.indexOf('bold') + 1,
    complexDoc.indexOf('text `code`') + 2,
    complexDoc.indexOf('`code`') + 2,
    complexDoc.indexOf('[x]') + 1,
    complexDoc.indexOf('Docs') + 1,
    complexDoc.indexOf('Quoted line') + 2,
    complexDoc.indexOf('---') + 1,
    complexDoc.length,
  ];

  for (const pos of positionsToCheck) {
    const state = createMarkdownState(cm, complexDoc, pos);
    const decoSet = editor.buildDecorationSet(state, cm);
    assert.ok(decoSet && typeof decoSet.iter === 'function', `Expected DecorationSet at pos ${pos}`);
    assert.ok(decoSet.size > 0, `Expected non-empty DecorationSet at pos ${pos}`);

    // Verify no replace decoration crosses a newline (ViewPlugin requirement)
    const iter = decoSet.iter();
    while (iter.value) {
      const fromLine = state.doc.lineAt(iter.from).number;
      const toLine = state.doc.lineAt(iter.to).number;
      if (iter.value.startSide === 499999999 && fromLine !== toLine) {
        assert.fail(`Replace decoration crossed newline at ${iter.from}..${iter.to}`);
      }
      iter.next();
    }
  }

  // Verify buildDecorationsFromSpecs also handles unsorted & overlapping replaces cleanly
  const unsortedOverlapping = [
    { kind: 'mark', from: 5, to: 10, className: 'cm-md-strong' },
    { kind: 'hide', from: 3, to: 8 },
    { kind: 'hide', from: 1, to: 6 },
    { kind: 'line', pos: 0, className: 'cm-md-h1' },
    { kind: 'widget', from: 0, to: 0, widget: 'indent-guide', depth: 1 },
  ];
  const recoveredSet = editor.buildDecorationsFromSpecs(unsortedOverlapping, cm);
  assert.ok(recoveredSet && recoveredSet.size > 0);
  assert.ok(doc);
});

test('WidgetType DOM builders use safe DOM APIs only and CheckboxWidget enforces readOnly / editable lock (Review Focus #5)', () => {
  const { cm, editor } = loadEditorWithDomEnv({ withCreateRange: true });

  const sampleDoc = [
    '- [ ] Open task',
    '  - Nested bullet',
    '---',
    'plain',
  ].join('\n');

  const state = createMarkdownState(cm, sampleDoc, sampleDoc.length);
  const decoSet = editor.buildDecorationSet(state, cm);

  const widgets = [];
  const iter = decoSet.iter();
  while (iter.value) {
    if (iter.value.widget) {
      widgets.push(iter.value.widget);
    }
    iter.next();
  }

  const checkboxWidget = widgets.find((w) => {
    const el = w.toDOM({ state, dispatch() {} });
    return el.tagName === 'INPUT';
  });
  const bulletWidget = widgets.find((w) => {
    const el = w.toDOM({ state, dispatch() {} });
    return el.className === 'cm-md-bullet';
  });
  const hrWidget = widgets.find((w) => {
    const el = w.toDOM({ state, dispatch() {} });
    return el.className === 'cm-md-hr';
  });
  const guideWidget = widgets.find((w) => {
    const el = w.toDOM({ state, dispatch() {} });
    return el.className === 'cm-md-indent-guide';
  });

  assert.ok(checkboxWidget, 'Expected CheckboxWidget');
  assert.ok(bulletWidget, 'Expected BulletWidget');
  assert.ok(hrWidget, 'Expected HorizontalRuleWidget');
  assert.ok(guideWidget, 'Expected IndentGuideWidget');

  const bulletEl = bulletWidget.toDOM({ state, dispatch() {} });
  assert.equal(bulletEl.tagName, 'SPAN');
  assert.equal(bulletEl.textContent, '•');
  assert.equal(bulletEl.getAttribute('aria-hidden'), 'true');

  const hrEl = hrWidget.toDOM({ state, dispatch() {} });
  assert.equal(hrEl.tagName, 'SPAN');
  assert.equal(hrEl.getAttribute('role'), 'separator');
  assert.equal(hrEl.getAttribute('aria-hidden'), 'true');

  const guideEl = guideWidget.toDOM({ state, dispatch() {} });
  assert.equal(guideEl.tagName, 'SPAN');
  assert.equal(guideEl.getAttribute('aria-hidden'), 'true');

  // Editable view allows checkbox toggle via computeToggleTask
  const dispatchedSpecs = [];
  const editableView = {
    state,
    dispatch(spec) {
      dispatchedSpecs.push(spec);
      editableView.state = editableView.state.update(spec).state;
    },
  };
  const cbEl = checkboxWidget.toDOM(editableView);
  assert.equal(cbEl.getAttribute('type') || cbEl.type, 'checkbox');
  assert.equal(cbEl.className, 'cm-md-checkbox');
  assert.equal(cbEl.getAttribute('aria-label'), 'Toggle task');
  assert.equal(cbEl.checked, false);
  assert.equal(cbEl.disabled, false);

  const mousedownEv = { type: 'mousedown', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  cbEl.dispatchEvent(mousedownEv);
  assert.equal(mousedownEv.defaultPrevented, true);

  cbEl.checked = true;
  cbEl.dispatchEvent({ type: 'change' });
  assert.equal(dispatchedSpecs.length, 1);
  assert.equal(editableView.state.doc.lines, 4);
  assert.equal(editableView.state.doc.line(1).text, '- [x] Open task');

  // updateDOM refreshes checked/disabled state in place
  assert.equal(checkboxWidget.updateDOM(cbEl, { state: editableView.state }), true);
  assert.equal(cbEl.checked, false);

  // ReadOnly / disabled view blocks checkbox toggle and restores checked state
  const lockedState = cm.EditorState.create({
    doc: sampleDoc,
    selection: { anchor: sampleDoc.length },
    extensions: [
      cm.markdown({ extensions: [cm.Strikethrough, cm.TaskList, cm.Autolink] }),
      cm.EditorState.readOnly.of(true),
      cm.EditorView.editable.of(false),
    ],
  });
  let lockedDispatched = 0;
  const lockedView = {
    state: lockedState,
    dispatch() {
      lockedDispatched += 1;
    },
  };
  const lockedCbEl = checkboxWidget.toDOM(lockedView);
  assert.equal(lockedCbEl.disabled, true);
  lockedCbEl.checked = true;
  lockedCbEl.dispatchEvent({ type: 'change' });
  assert.equal(lockedDispatched, 0);
  assert.equal(lockedCbEl.checked, false);
});

test('handleLinkClick ignores plain click, opens validated http(s) on Mod+Click, and blocks unsafe schemes (Review Focus #2)', () => {
  const { editor, doc, MiniElement } = loadEditorWithDomEnv({ withCreateRange: true });

  const opened = [];
  const openUrl = (href) => opened.push(href);

  const makeLinkTarget = (href) => {
    const span = doc.createElement('span');
    span.className = 'cm-md-link';
    span.setAttribute('data-md-href', href);
    const childTextNode = { nodeType: 3, parentNode: span, parentElement: span };
    return { span, childTextNode };
  };

  const { span: safeSpan, childTextNode } = makeLinkTarget('https://example.com/docs');

  // Plain click does NOT open and does NOT preventDefault (allows cursor placement)
  const plainEv = { target: safeSpan, metaKey: false, ctrlKey: false, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(editor.handleLinkClick(plainEv, { openUrl }), false);
  assert.equal(plainEv.defaultPrevented, false);
  assert.deepEqual(opened, []);

  // Right-click with metaKey ignored
  const rightEv = { target: safeSpan, metaKey: true, ctrlKey: false, button: 2, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(editor.handleLinkClick(rightEv, { openUrl }), false);
  assert.deepEqual(opened, []);

  // Cmd+Click on nested text node opens safe URL
  const cmdEv = { target: childTextNode, metaKey: true, ctrlKey: false, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(editor.handleLinkClick(cmdEv, { openUrl }), true);
  assert.equal(cmdEv.defaultPrevented, true);
  assert.deepEqual(opened, ['https://example.com/docs']);

  // Ctrl+Click opens safe http URL
  const { span: httpSpan } = makeLinkTarget('http://localhost:4815/notes');
  const ctrlEv = { target: httpSpan, metaKey: false, ctrlKey: true, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(editor.handleLinkClick(ctrlEv, { openUrl }), true);
  assert.deepEqual(opened, ['https://example.com/docs', 'http://localhost:4815/notes']);

  // Unsafe URLs NEVER open
  for (const badHref of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'not a url', '']) {
    const { span: badSpan } = makeLinkTarget(badHref);
    const badEv = { target: badSpan, metaKey: true, ctrlKey: false, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    assert.equal(editor.handleLinkClick(badEv, { openUrl }), false);
  }
  assert.equal(opened.length, 2);

  // Non-link target does nothing
  const nonLink = new MiniElement('span', doc);
  assert.equal(editor.handleLinkClick({ target: nonLink, metaKey: true, button: 0, preventDefault() {} }, { openUrl }), false);
});

test('buildEditorExtensions wires mode/editable compartments, delimiter wrapping, externalSync guard, and history isolation (Review Focus #1 & #5)', () => {
  const { cm, editor } = loadEditorWithDomEnv({ withCreateRange: true });

  const modeCompartment = new cm.Compartment();
  const editableCompartment = new cm.Compartment();
  const changed = [];

  const extensions = editor.buildEditorExtensions({
    cm,
    mode: 'live',
    disabled: false,
    placeholderText: 'Write notes...',
    modeCompartment,
    editableCompartment,
    onChange(val) {
      changed.push(val);
    },
  });

  assert.ok(Array.isArray(extensions));
  let state = cm.EditorState.create({
    doc: 'a word b',
    selection: { anchor: 2, head: 6 },
    extensions,
  });

  // 1. lineWrapping, readOnly/editable, keymap present
  assert.equal(state.facet(cm.EditorState.readOnly), false);
  assert.equal(state.facet(cm.EditorView.editable), true);
  assert.ok(state.facet(cm.keymap).length >= 2);

  // 2. Delimiter wrap via EditorState.transactionFilter on input.type
  const wrapTr = state.update({
    changes: { from: 2, to: 6, insert: '*' },
    selection: { anchor: 3 },
    userEvent: 'input.type',
  });
  state = wrapTr.state;
  assert.equal(state.doc.toString(), 'a *word* b');
  assert.equal(state.doc.sliceString(state.selection.main.from, state.selection.main.to), 'word');

  // Non-delimiter input replaces normally without wrapping
  const replaceTr = state.update({
    changes: { from: 3, to: 7, insert: 'x' },
    selection: { anchor: 4 },
    userEvent: 'input.type',
  });
  assert.equal(replaceTr.state.doc.toString(), 'a *x* b');

  // 3. updateListener invokes onChange for user transactions and skips externalSync
  const listeners = state.facet(cm.EditorView.updateListener);
  assert.ok(listeners.length >= 1);

  const externalTr = state.update({
    changes: { from: 0, to: state.doc.length, insert: 'from mcp' },
    annotations: [
      cm.Transaction.userEvent.of('externalSync'),
      cm.Transaction.addToHistory.of(false),
    ],
  });
  for (const fn of listeners) {
    fn({ docChanged: true, state: externalTr.state, transactions: [externalTr] });
  }
  assert.deepEqual(changed, []);

  // addToHistory.of(false) prevents externalSync from entering undo stack
  const userUndoableState = externalTr.state;
  let undoDispatched = false;
  cm.undo({
    state: userUndoableState,
    dispatch(spec) {
      undoDispatched = true;
      state = userUndoableState.update(spec).state;
    },
  });
  // Undo reverts to pre-externalSync only if prior user edit was in history; externalSync itself is not undone into
  if (undoDispatched) {
    assert.notEqual(state.doc.toString(), 'from mcp');
  }

  for (const fn of listeners) {
    fn({ docChanged: true, state: wrapTr.state, transactions: [wrapTr] });
  }
  assert.deepEqual(changed, ['a *word* b']);

  // 4. modeCompartment toggles cleanly between 'live' and 'source' preserving document content
  const toSourceTr = state.update({
    effects: modeCompartment.reconfigure(editor.buildModeExtension('source', cm)),
  });
  assert.equal(toSourceTr.state.doc.toString(), state.doc.toString());
  const toLiveTr = toSourceTr.state.update({
    effects: modeCompartment.reconfigure(editor.buildModeExtension('live', cm)),
  });
  assert.equal(toLiveTr.state.doc.toString(), state.doc.toString());

  // 5. editableCompartment disables edits when setDisabled(true)
  const lockedTr = toLiveTr.state.update({
    effects: editableCompartment.reconfigure([
      cm.EditorState.readOnly.of(true),
      cm.EditorView.editable.of(false),
    ]),
  });
  assert.equal(lockedTr.state.facet(cm.EditorState.readOnly), true);
  assert.equal(lockedTr.state.facet(cm.EditorView.editable), false);
});

test('createNotesEditor falls back cleanly to textarea adapter when cm is null or document.createRange is unavailable', () => {
  const { editor, doc, MiniElement, storage } = loadEditorWithDomEnv({ withCreateRange: false });

  const mountEl = new MiniElement('div', doc);
  mountEl.hidden = true;
  const fallbackEl = new MiniElement('textarea', doc);
  const modeToggleEl = new MiniElement('button', doc);
  modeToggleEl.setAttribute('aria-pressed', 'false');
  modeToggleEl.textContent = 'Source';

  const changes = [];
  let blurs = 0;
  const modeChanges = [];

  const controller = editor.createNotesEditor({
    mountEl,
    fallbackEl,
    modeToggleEl,
    placeholderText: 'Notes placeholder',
    storage,
    cm: null,
    onChange(val) {
      changes.push(val);
    },
    onBlur() {
      blurs += 1;
    },
    onModeChange(mode) {
      modeChanges.push(mode);
    },
  });

  assert.equal(controller.isRichMode(), false);
  assert.equal(mountEl.hidden, true);
  assert.equal(fallbackEl.hidden, false);
  assert.equal(controller.getMode(), 'live');

  // setValue must NOT invoke onChange
  controller.setValue('initial notes', { resetHistory: true });
  assert.equal(fallbackEl.value, 'initial notes');
  assert.equal(controller.getValue(), 'initial notes');
  assert.deepEqual(changes, []);

  // User input fires onChange; blur fires onBlur
  fallbackEl.value = 'edited notes';
  fallbackEl.dispatchEvent({ type: 'input' });
  assert.deepEqual(changes, ['edited notes']);

  fallbackEl.dispatchEvent({ type: 'blur' });
  assert.equal(blurs, 1);

  // Disabled & focus tracking
  controller.setDisabled(true);
  assert.equal(fallbackEl.disabled, true);
  controller.setDisabled(false);
  assert.equal(fallbackEl.disabled, false);

  assert.equal(controller.isFocused(), false);
  controller.focus();
  assert.equal(doc.activeElement, fallbackEl);
  assert.equal(controller.isFocused(), true);

  // Mode toggle updates aria-pressed, textContent, title, .is-source, storage, and onModeChange
  modeToggleEl.click();
  assert.equal(controller.getMode(), 'source');
  assert.equal(modeToggleEl.getAttribute('aria-pressed'), 'true');
  assert.equal(modeToggleEl.textContent, 'Source');
  assert.ok(modeToggleEl.title.length > 0);
  assert.equal(mountEl.classList.contains('is-source'), true);
  assert.equal(storage.getItem('agy-todo.notes-mode'), 'source');
  assert.deepEqual(modeChanges, ['source']);

  // Also test missing document.createRange even when AGYCodeMirror is globally loaded
  const autoFallbackController = editor.createNotesEditor({
    mountEl,
    fallbackEl,
  });
  assert.equal(autoFallbackController.isRichMode(), false);

  // Destroy detaches listeners
  controller.destroy();
  autoFallbackController.destroy();
  fallbackEl.value = 'after destroy';
  fallbackEl.dispatchEvent({ type: 'input' });
  fallbackEl.dispatchEvent({ type: 'blur' });
  assert.deepEqual(changes, ['edited notes']);
  assert.equal(blurs, 1);
});

test('createNotesEditor mounts CM6 EditorView in rich DOM, isolates workspace undo history, toggles mode, and cleans up window listeners on destroy', () => {
  const storage = createMemoryStorage();
  const { cm, editor, doc, win, MiniElement } = loadEditorWithDomEnv({ withCreateRange: true, storage });

  const mountEl = new MiniElement('div', doc);
  mountEl.hidden = true;
  const fallbackEl = new MiniElement('textarea', doc);
  const modeToggleEl = new MiniElement('button', doc);
  modeToggleEl.setAttribute('aria-pressed', 'false');
  modeToggleEl.textContent = 'Source';

  let activeViewInstance = null;
  let viewFocused = false;
  let viewDestroyed = false;

  class FakeEditorView {
    constructor({ state, parent }) {
      this.state = state;
      this.parent = parent;
      this.dom = doc.createElement('div');
      this.dom.className = 'cm-editor';
      if (parent && typeof parent.appendChild === 'function') {
        parent.appendChild(this.dom);
      }
      activeViewInstance = this;
    }
    get hasFocus() {
      return viewFocused;
    }
    focus() {
      viewFocused = true;
    }
    dispatch(...specs) {
      const prevState = this.state;
      let tr = specs.length === 1 && typeof specs[0].state === 'object' ? specs[0] : prevState.update(...specs);
      const nextState = tr.state;
      this.state = nextState;
      const updateObj = {
        state: nextState,
        startState: prevState,
        docChanged: tr.docChanged,
        selectionSet: tr.selectionSet,
        transactions: [tr],
      };
      for (const listener of nextState.facet(cm.EditorView.updateListener)) {
        listener(updateObj);
      }
    }
    setState(newState) {
      this.state = newState;
    }
    destroy() {
      viewDestroyed = true;
    }
  }
  FakeEditorView.lineWrapping = cm.EditorView.lineWrapping;
  FakeEditorView.editable = cm.EditorView.editable;
  FakeEditorView.updateListener = cm.EditorView.updateListener;
  FakeEditorView.domEventHandlers = cm.EditorView.domEventHandlers;
  FakeEditorView.contentAttributes = cm.EditorView.contentAttributes;

  const instrumentedCm = {
    ...cm,
    EditorView: FakeEditorView,
  };

  const changes = [];
  const modeChanges = [];
  const openedUrls = [];

  const controller = editor.createNotesEditor({
    mountEl,
    fallbackEl,
    modeToggleEl,
    placeholderText: 'Project notes...',
    storage,
    cm: instrumentedCm,
    onChange(val) {
      changes.push(val);
    },
    onModeChange(mode) {
      modeChanges.push(mode);
    },
    openUrl(href) {
      openedUrls.push(href);
    },
  });

  assert.equal(controller.isRichMode(), true);
  assert.equal(mountEl.hidden, false);
  assert.equal(fallbackEl.hidden, true);
  assert.ok(activeViewInstance);

  // User typing triggers onChange and pushes onto history
  activeViewInstance.dispatch({
    changes: { from: 0, to: 0, insert: 'Workspace A note' },
    selection: { anchor: 16 },
    userEvent: 'input.type',
  });
  assert.equal(controller.getValue(), 'Workspace A note');
  assert.deepEqual(changes, ['Workspace A note']);

  // Background poll setValue(..., { resetHistory: false }) skips onChange & preserves history
  controller.setValue('Workspace A synced', { resetHistory: false });
  assert.equal(controller.getValue(), 'Workspace A synced');
  assert.deepEqual(changes, ['Workspace A note']);

  // Switching to Source mode preserves content and updates DOM + storage
  modeToggleEl.click();
  assert.equal(controller.getMode(), 'source');
  assert.equal(modeToggleEl.getAttribute('aria-pressed'), 'true');
  assert.equal(modeToggleEl.textContent, 'Source');
  assert.equal(mountEl.classList.contains('is-source'), true);
  assert.equal(storage.getItem('agy-todo.notes-mode'), 'source');
  assert.deepEqual(modeChanges, ['source']);

  // setDisabled(true) locks EditorState.readOnly & EditorView.editable
  controller.setDisabled(true);
  assert.equal(activeViewInstance.state.facet(cm.EditorState.readOnly), true);
  assert.equal(activeViewInstance.state.facet(cm.EditorView.editable), false);
  assert.equal(mountEl.classList.contains('is-disabled'), true);

  // Workspace switch setValue('Workspace B', { resetHistory: true }) resets history, preserves mode & disabled state, and skips onChange
  controller.setValue('Workspace B', { resetHistory: true });
  assert.equal(controller.getValue(), 'Workspace B');
  assert.deepEqual(changes, ['Workspace A note']);
  assert.equal(controller.getMode(), 'source');
  assert.equal(activeViewInstance.state.facet(cm.EditorState.readOnly), true);

  let revertedWorkspaceA = false;
  cm.undo({
    state: activeViewInstance.state,
    dispatch(spec) {
      revertedWorkspaceA = true;
      activeViewInstance.dispatch(spec);
    },
  });
  assert.equal(revertedWorkspaceA, false, 'Expected Cmd/Ctrl+Z undo NOT to revert into previous workspace notes');
  assert.equal(controller.getValue(), 'Workspace B');

  controller.setDisabled(false);
  assert.equal(activeViewInstance.state.facet(cm.EditorState.readOnly), false);

  // Focus helpers
  assert.equal(controller.isFocused(), false);
  controller.focus();
  assert.equal(controller.isFocused(), true);

  // Mod key tracking toggles .cm-mod-held on mountEl
  win.dispatchEvent({ type: 'keydown', metaKey: true, ctrlKey: false, key: 'Meta' });
  assert.equal(mountEl.classList.contains('cm-mod-held'), true);
  win.dispatchEvent({ type: 'keyup', metaKey: false, ctrlKey: false, key: 'Meta' });
  assert.equal(mountEl.classList.contains('cm-mod-held'), false);
  win.dispatchEvent({ type: 'keydown', metaKey: false, ctrlKey: true, key: 'Control' });
  assert.equal(mountEl.classList.contains('cm-mod-held'), true);
  win.dispatchEvent({ type: 'blur' });
  assert.equal(mountEl.classList.contains('cm-mod-held'), false);

  assert.ok(win.listenerCount('keydown') >= 1);
  assert.ok(win.listenerCount('keyup') >= 1);
  assert.ok(win.listenerCount('blur') >= 1);
  assert.equal(modeToggleEl.listenerCount('click'), 1);

  // destroy() removes all window & modeToggleEl listeners, clears .cm-mod-held, and destroys EditorView
  win.dispatchEvent({ type: 'keydown', metaKey: true, key: 'Meta' });
  assert.equal(mountEl.classList.contains('cm-mod-held'), true);

  controller.destroy();
  assert.equal(viewDestroyed, true);
  assert.equal(mountEl.classList.contains('cm-mod-held'), false);
  assert.equal(win.listenerCount('keydown'), 0);
  assert.equal(win.listenerCount('keyup'), 0);
  assert.equal(win.listenerCount('blur'), 0);
  assert.equal(modeToggleEl.listenerCount('click'), 0);
});

test('buildEditorExtensions domEventHandlers wire Mod+Click link opening and external blur detection', () => {
  const { cm, editor, doc } = loadEditorWithDomEnv({ withCreateRange: true });

  const capturedDomHandlers = [];
  const spyCm = {
    ...cm,
    EditorView: {
      ...cm.EditorView,
      domEventHandlers(handlers) {
        capturedDomHandlers.push(handlers);
        return cm.EditorView.domEventHandlers(handlers);
      },
    },
  };

  let blurCount = 0;
  const opened = [];
  editor.buildEditorExtensions({
    cm: spyCm,
    onBlur() {
      blurCount += 1;
    },
    openUrl(href) {
      opened.push(href);
    },
  });

  const viewHandlers = capturedDomHandlers.find((h) => typeof h.mousedown === 'function' && typeof h.blur === 'function');
  assert.ok(viewHandlers, 'Expected mousedown + blur domEventHandlers');

  const viewDom = doc.createElement('div');
  const innerEl = doc.createElement('input');
  viewDom.appendChild(innerEl);
  const outsideEl = doc.createElement('button');

  // Focus moving inside view.dom does NOT trigger onBlur; moving outside DOES trigger onBlur
  assert.equal(viewHandlers.blur({ relatedTarget: innerEl }, { dom: viewDom }), false);
  assert.equal(blurCount, 0);
  assert.equal(viewHandlers.blur({ relatedTarget: outsideEl }, { dom: viewDom }), false);
  assert.equal(blurCount, 1);

  const linkSpan = doc.createElement('span');
  linkSpan.setAttribute('data-md-href', 'https://example.com');
  assert.equal(viewHandlers.mousedown({ target: linkSpan, metaKey: true, button: 0, preventDefault() {} }), true);
  assert.deepEqual(opened, ['https://example.com']);
});

test('buildModeExtension source HighlightStyle dims list/task markers without dimming list text or links', () => {
  const { cm, editor } = loadEditorWithCmInContext();
  const sourceExts = editor.buildModeExtension('source', cm);
  assert.ok(Array.isArray(sourceExts));

  const styleExt = sourceExts.find((entry) => entry?.value && Array.isArray(entry.value.specs) && typeof entry.value.style === 'function');
  assert.ok(styleExt, 'Expected HighlightStyle extension in source mode');

  const highlighter = styleExt.value;
  const rulesText = (highlighter.module?.rules || []).join('\n');

  assert.equal(highlighter.style([cm.tags.list]), null, 'List container text must not be styled as faint syntax');
  const markerClass = highlighter.style([cm.tags.processingInstruction]);
  const taskBracketClass = highlighter.style([cm.tags.atom]);
  const linkClass = highlighter.style([cm.tags.link]);
  const urlClass = highlighter.style([cm.tags.url]);

  assert.ok(markerClass, 'Expected style class for processingInstruction markers');
  assert.ok(taskBracketClass, 'Expected style class for TaskMarker atom brackets');
  assert.ok(linkClass && urlClass, 'Expected style classes for links and URLs');
  assert.notEqual(markerClass, linkClass);
  assert.match(rulesText, new RegExp(`\\.${markerClass}[^}]*--ui-fg-faint`));
  assert.match(rulesText, new RegExp(`\\.${linkClass}[^}]*--ui-primary`));
});
