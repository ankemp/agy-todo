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
