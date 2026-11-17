import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import vm from 'node:vm';

const panelDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(panelDir, 'public');

const loadHelpers = vm.runInThisContext(
  `(function (window, globalThis) {\n${readFileSync(join(publicDir, 'helpers.js'), 'utf8')}\nreturn window.AGYTodoHelpers;\n})`,
  { filename: 'public/helpers.js' },
);
const helpersTarget = {};
const {
  escapeHtml,
  partitionTodos,
  formatMarkdown,
  createNotesAutosaver,
  extractWorkspaceUrisFromMetadata,
  formatAttachMention,
  formatFileSize,
  normalizeNewMarkdownFilename,
  arrayBufferToBase64,
  shouldApplyNotesRefresh,
  haveFilesListChanged,
  computeThemeFromColor,
  scratchpadRenderSignature,
  filePathToUri,
} = loadHelpers(helpersTarget, helpersTarget);

test('escapeHtml neutralizes HTML tags and attribute quotes', () => {
  const payload = `<img src=x onerror="alert('xss')">&`;
  const escaped = escapeHtml(payload);

  assert.equal(escaped.includes('<'), false);
  assert.equal(escaped.includes('>'), false);
  assert.equal(escaped.includes('"'), false);
  assert.equal(escaped.includes("'"), false);
  assert.equal(
    escaped,
    '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;'
  );
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('partitionTodos separates open and done todos while preserving relative order', () => {
  const todos = [
    { id: '1', text: 'First open', done: false },
    { id: '2', text: 'First done', done: true },
    { id: '3', text: 'Second open', done: false },
    { id: '4', text: 'Second done', done: true },
    { id: '5', text: 'Third open', done: false },
  ];

  const { open, done } = partitionTodos(todos);
  assert.deepEqual(
    open.map((t) => t.id),
    ['1', '3', '5']
  );
  assert.deepEqual(
    done.map((t) => t.id),
    ['2', '4']
  );

  assert.deepEqual(partitionTodos([]), { open: [], done: [] });
});

test('formatMarkdown formats project heading, links, todos, and notes deterministically', () => {
  const scratchpad = {
    displayName: 'my-api-service',
    links: [
      { id: 'l1', label: 'Staging', url: 'https://staging.example.com' },
      { id: 'l2', label: 'Runbook', url: 'https://docs.example.com/runbook' },
    ],
    todos: [
      { id: 't1', text: 'Verify Redis TLS', done: false },
      { id: 't2', text: 'Rotate staging key', done: true },
    ],
    notes: 'Check connection pool limits\nbefore deploy.',
  };

  const md = formatMarkdown(scratchpad);
  assert.equal(
    md,
    [
      '# my-api-service',
      '',
      '## Links',
      '- [Staging](https://staging.example.com)',
      '- [Runbook](https://docs.example.com/runbook)',
      '',
      '## Todos',
      '- [ ] Verify Redis TLS',
      '- [x] Rotate staging key',
      '',
      '## Notes',
      'Check connection pool limits',
      'before deploy.',
      '',
    ].join('\n')
  );
});

test('createNotesAutosaver debounces rapid edits and flushes pending notes to original workspace', async () => {
  const calls = [];
  const saveFn = async (workspaceUri, notes) => {
    calls.push({ workspaceUri, notes });
  };

  const autosaver = createNotesAutosaver({ saveFn, delayMs: 30 });

  // Rapid edits on proj-a coalesce into a single save after delayMs.
  autosaver.schedule('file:///proj-a', 'draft 1');
  autosaver.schedule('file:///proj-a', 'draft 2');
  assert.equal(autosaver.hasPending(), true);
  assert.equal(calls.length, 0);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(autosaver.hasPending(), false);
  assert.deepEqual(calls, [{ workspaceUri: 'file:///proj-a', notes: 'draft 2' }]);

  // Pending edit on proj-a flushes immediately on explicit flush().
  autosaver.schedule('file:///proj-a', 'note A');
  assert.equal(autosaver.hasPending(), true);
  await autosaver.flush();
  assert.equal(autosaver.hasPending(), false);
  assert.deepEqual(calls, [
    { workspaceUri: 'file:///proj-a', notes: 'draft 2' },
    { workspaceUri: 'file:///proj-a', notes: 'note A' },
  ]);

  // Scheduling a different workspace while previous workspace is pending flushes previous first.
  autosaver.schedule('file:///proj-a', 'unsaved A2');
  autosaver.schedule('file:///proj-b', 'note B');
  // Flush synchronously or immediately triggers save of proj-a before proj-b settles.
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [
    { workspaceUri: 'file:///proj-a', notes: 'draft 2' },
    { workspaceUri: 'file:///proj-a', notes: 'note A' },
    { workspaceUri: 'file:///proj-a', notes: 'unsaved A2' },
    { workspaceUri: 'file:///proj-b', notes: 'note B' },
  ]);
});

test('public/index.html loads preload, styles, classic helpers/app scripts, and required UI landmarks', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');

  assert.match(html, /<script\s+src="\/preload\.js"><\/script>/);
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\/styles\.css"\s*\/?>/);
  assert.match(html, /<script\s+src="\/helpers\.js"><\/script>/);
  assert.match(html, /<script\s+src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /type="module"/);

  // Required landmarks and controls
  assert.match(html, /id="empty-state"/);
  assert.match(html, /<header\b/);
  assert.match(html, /Export \.md/);
  assert.match(html, /\+ Link/);
  assert.match(html, /id="links-section"/);
  assert.match(html, /id="todos-section"/);
  assert.match(html, /id="notes-section"/);
  assert.match(html, /<textarea\b[^>]*id="notes-input"/);
});

test('extractWorkspaceUrisFromMetadata extracts and deduplicates workspace URIs', () => {
  assert.deepEqual(
    extractWorkspaceUrisFromMetadata({
      response: {
        conversationMetadata: {
          metadata: {
            workspaceUris: ['file:///Users/akemp/Workspace/agy-todo'],
            workspaces: [
              { workspaceFolderAbsoluteUri: 'file:///Users/akemp/Workspace/agy-todo' },
              { workspaceFolderAbsoluteUri: 'file:///Users/akemp/Workspace/ledger' },
            ],
          },
        },
      },
    }),
    [
      'file:///Users/akemp/Workspace/agy-todo',
      'file:///Users/akemp/Workspace/ledger',
    ]
  );

  assert.deepEqual(
    extractWorkspaceUrisFromMetadata({
      response: {
        conversation_metadata: {
          metadata: {
            workspaces: [{ git_root_absolute_uri: 'file:///tmp/repo' }],
          },
        },
      },
    }),
    ['file:///tmp/repo']
  );

  assert.deepEqual(extractWorkspaceUrisFromMetadata(null), []);
});

test('formatAttachMention formats @path mentions and quotes paths containing whitespace', () => {
  assert.equal(formatAttachMention('/tmp/data/plan.md'), '@/tmp/data/plan.md');
  assert.equal(
    formatAttachMention('/Users/my user/data/plan.md'),
    '@"/Users/my user/data/plan.md"',
  );
  assert.equal(formatAttachMention(''), '');
  assert.equal(formatAttachMention('   '), '');
  assert.equal(formatAttachMention(null), '');
});

test('formatFileSize formats bytes, KB, and MB cleanly', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatFileSize(-1), '0 B');
  assert.equal(formatFileSize(NaN), '0 B');
});

test('normalizeNewMarkdownFilename defaults to .md when no extension is given', () => {
  assert.equal(normalizeNewMarkdownFilename('notes'), 'notes.md');
  assert.equal(normalizeNewMarkdownFilename('  notes  '), 'notes.md');
  assert.equal(normalizeNewMarkdownFilename('spec.md'), 'spec.md');
  assert.equal(normalizeNewMarkdownFilename('config.json'), 'config.json');
  assert.equal(normalizeNewMarkdownFilename('.gitignore'), '.gitignore');
  assert.equal(normalizeNewMarkdownFilename('   '), '');
  assert.equal(normalizeNewMarkdownFilename(null), '');
});

test('arrayBufferToBase64 encodes arbitrary binary bytes and chunked buffers accurately', () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x89, 0x50, 0x4e, 0x47, 0xff]);
  assert.equal(
    arrayBufferToBase64(bytes.buffer),
    Buffer.from(bytes).toString('base64'),
  );
  assert.equal(
    arrayBufferToBase64(bytes),
    Buffer.from(bytes).toString('base64'),
  );

  // Verify chunking across > 8192-byte buffers without call stack overflow
  const large = new Uint8Array(25000);
  for (let i = 0; i < large.length; i += 1) {
    large[i] = (i * 31) & 0xff;
  }
  assert.equal(
    arrayBufferToBase64(large.buffer),
    Buffer.from(large).toString('base64'),
  );
  assert.equal(arrayBufferToBase64(new ArrayBuffer(0)), '');
});

test('public/index.html includes #files-section above #notes-section with Project and Global tabs and controls', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const todosIdx = html.indexOf('id="todos-section"');
  const filesIdx = html.indexOf('id="files-section"');
  const notesIdx = html.indexOf('id="notes-section"');

  assert.ok(todosIdx !== -1 && filesIdx !== -1 && notesIdx !== -1);
  assert.ok(todosIdx < filesIdx && filesIdx < notesIdx, 'Files section must sit between Todos and Notes');

  assert.match(html, /id="files-tab-project"[^>]*role="tab"[^>]*aria-selected="/);
  assert.match(html, /id="files-tab-global"[^>]*role="tab"[^>]*aria-selected="/);
  assert.match(html, /id="file-upload-input"[^>]*type="file"[^>]*multiple/);
  assert.match(html, /id="file-new-form"/);
  assert.match(html, /id="file-path-form"/);
  assert.match(html, /id="editor-default-select"/);
  assert.match(html, /id="editor-custom-form"/);
  assert.match(html, /id="files-list"/);
});

test('public/app.js is valid classic JS, avoids raw HTML sinks, and wires all file API routes', () => {
  const appJs = readFileSync(join(publicDir, 'app.js'), 'utf8');

  // Must parse cleanly as classic script without ESM syntax
  assert.doesNotThrow(() => new vm.Script(appJs, { filename: 'public/app.js' }));

  // Must avoid unsafe HTML injection sinks
  assert.doesNotMatch(appJs, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write\b/);

  // Must integrate all files and settings routes
  for (const route of [
    '/api/files?',
    '/api/files/save',
    '/api/files/import',
    '/api/files/rename',
    '/api/files/delete',
    '/api/files/open',
    '/api/settings',
  ]) {
    assert.ok(appJs.includes(route), `Expected app.js to reference ${route}`);
  }
});

test('shouldApplyNotesRefresh only allows refresh when notes input is blurred and has no pending autosave', () => {
  assert.equal(shouldApplyNotesRefresh(), true);
  assert.equal(shouldApplyNotesRefresh({}), true);
  assert.equal(shouldApplyNotesRefresh({ isFocused: false, hasPending: false }), true);
  assert.equal(shouldApplyNotesRefresh({ isFocused: true, hasPending: false }), false);
  assert.equal(shouldApplyNotesRefresh({ isFocused: false, hasPending: true }), false);
  assert.equal(shouldApplyNotesRefresh({ isFocused: true, hasPending: true }), false);
});

test('haveFilesListChanged detects additions, deletions, renames, and size or updatedAt changes', () => {
  const base = [
    { name: 'notes.md', size: 120, updatedAt: '2026-01-01T00:00:00.000Z', path: '/tmp/notes.md' },
    { name: 'plan.md', size: 450, updatedAt: '2026-01-01T00:01:00.000Z', path: '/tmp/plan.md' },
  ];

  // Identical entries (cloned objects)
  assert.equal(
    haveFilesListChanged(
      base,
      base.map((f) => ({ ...f })),
    ),
    false,
  );
  assert.equal(haveFilesListChanged([], []), false);
  assert.equal(haveFilesListChanged(null, []), false);

  // Addition
  assert.equal(
    haveFilesListChanged(base, [
      ...base,
      { name: 'extra.md', size: 10, updatedAt: '2026-01-01T00:02:00.000Z', path: '/tmp/extra.md' },
    ]),
    true,
  );

  // Deletion
  assert.equal(haveFilesListChanged(base, [base[0]]), true);

  // Rename
  assert.equal(
    haveFilesListChanged(base, [
      { ...base[0], name: 'renamed.md', path: '/tmp/renamed.md' },
      base[1],
    ]),
    true,
  );

  // Size change
  assert.equal(
    haveFilesListChanged(base, [
      { ...base[0], size: 125 },
      base[1],
    ]),
    true,
  );

  // updatedAt change
  assert.equal(
    haveFilesListChanged(base, [
      base[0],
      { ...base[1], updatedAt: '2026-01-01T00:05:00.000Z' },
    ]),
    true,
  );
});

test('public/app.js implements refreshActiveWorkspace and wires focus, visibilitychange, and 3000ms polling', () => {
  const appJs = readFileSync(join(publicDir, 'app.js'), 'utf8');

  assert.match(appJs, /function\s+refreshActiveWorkspace\s*\(/);
  assert.ok(appJs.includes('shouldApplyNotesRefresh'), 'Expected app.js to use shouldApplyNotesRefresh');
  assert.ok(appJs.includes('haveFilesListChanged'), 'Expected app.js to use haveFilesListChanged');
  assert.match(appJs, /window\.addEventListener\(\s*['"]focus['"]/);
  assert.match(appJs, /document\.addEventListener\(\s*['"]visibilitychange['"]/);
  assert.match(appJs, /setInterval\([\s\S]*refreshActiveWorkspace[\s\S]*3000/);
});

test('computeThemeFromColor classifies rgb, rgba, and color(srgb) strings and rejects transparent or invalid values', () => {
  assert.equal(computeThemeFromColor('rgb(247, 247, 248)'), 'light');
  assert.equal(computeThemeFromColor('rgb(17, 19, 24)'), 'dark');
  assert.equal(computeThemeFromColor('color(srgb 0.08 0.09 0.1)'), 'dark');
  assert.equal(computeThemeFromColor('color(srgb 0.96 0.96 0.97)'), 'light');
  assert.equal(computeThemeFromColor('rgba(0, 0, 0, 0)'), null);
  assert.equal(computeThemeFromColor('color(srgb 0 0 0 / 0)'), null);
  assert.equal(computeThemeFromColor('rgba(17, 19, 24, 0.9)'), 'dark');
  assert.equal(computeThemeFromColor(''), null);
  assert.equal(computeThemeFromColor('transparent'), null);
  assert.equal(computeThemeFromColor(null), null);
});

test('scratchpadRenderSignature ignores notes/updatedAt and changes when identity, links, or todos change', () => {
  const base = {
    displayName: 'agy-todo',
    canonicalPath: '/Users/akemp/Workspace/agy-todo',
    links: [{ id: 'l1', label: 'Docs', url: 'https://example.com' }],
    todos: [{ id: 't1', text: 'Ship UI', done: false }],
    notes: 'initial draft',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const cloneWithNewNotes = {
    ...base,
    links: [{ id: 'l1', label: 'Docs', url: 'https://example.com' }],
    todos: [{ id: 't1', text: 'Ship UI', done: false }],
    notes: 'edited notes while typing',
    updatedAt: '2026-01-01T00:05:00.000Z',
  };

  const baseSig = scratchpadRenderSignature(base);
  assert.ok(baseSig.length > 0);
  assert.equal(baseSig, scratchpadRenderSignature(cloneWithNewNotes));

  assert.notEqual(
    baseSig,
    scratchpadRenderSignature({ ...base, displayName: 'other-repo' }),
  );
  assert.notEqual(
    baseSig,
    scratchpadRenderSignature({
      ...base,
      links: [{ id: 'l1', label: 'API Docs', url: 'https://example.com' }],
    }),
  );
  assert.notEqual(
    baseSig,
    scratchpadRenderSignature({
      ...base,
      links: [{ id: 'l1', label: 'Docs', url: 'https://example.org' }],
    }),
  );
  assert.notEqual(
    baseSig,
    scratchpadRenderSignature({
      ...base,
      todos: [{ id: 't1', text: 'Ship UI', done: true }],
    }),
  );
  assert.notEqual(
    baseSig,
    scratchpadRenderSignature({
      ...base,
      todos: [
        { id: 't2', text: 'Second', done: false },
        { id: 't1', text: 'Ship UI', done: false },
      ],
    }),
  );
  assert.equal(scratchpadRenderSignature(null), '');
  assert.equal(scratchpadRenderSignature('invalid'), '');
});

test('filePathToUri normalizes POSIX and Windows paths and percent-encodes special characters', () => {
  assert.equal(
    filePathToUri('/Users/my user/doc #1?.md'),
    'file:///Users/my%20user/doc%20%231%3F.md',
  );
  assert.equal(
    filePathToUri('/Users/my user/sprint #1 & 100%?.md'),
    'file:///Users/my%20user/sprint%20%231%20%26%20100%25%3F.md',
  );
  assert.equal(
    filePathToUri('C:\\my dir\\plan.md'),
    'file:///C:/my%20dir/plan.md',
  );
  assert.equal(filePathToUri(''), '');
  assert.equal(filePathToUri('   '), '');
  assert.equal(filePathToUri(null), '');
});

test('public/index.html loads Hub fonts, starts on skeleton loader, and includes toast and tablist a11y attributes', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');

  assert.match(
    html,
    /<link\b[^>]*rel="stylesheet"[^>]*media="print"[^>]*onload="this\.media='all'"[^>]*Google\+Sans\+Flex[^>]*Google\+Sans\+Code/,
  );

  assert.match(html, /<section\b[^>]*id="loading-state"[^>]*class="loading"/);
  assert.doesNotMatch(html, /<section\b[^>]*id="loading-state"[^>]*\bhidden\b/);
  assert.match(html, /<section\b[^>]*id="empty-state"[^>]*\bhidden\b/);
  assert.match(html, /<div\b[^>]*id="app-shell"[^>]*\bhidden\b/);

  assert.match(html, /<span\b[^>]*id="workspace-select-wrap"[^>]*class="select"[^>]*\bhidden\b[^>]*>\s*<select\b[^>]*id="workspace-select"/);
  assert.match(html, /<span\b[^>]*class="select"[^>]*>\s*<select\b[^>]*id="editor-default-select"/);

  assert.match(html, /<div\b[^>]*id="toast"[^>]*class="toast"[^>]*role="status"[^>]*aria-live="polite"[^>]*\bhidden\b/);

  assert.match(html, /id="files-tab-project"[^>]*aria-controls="files-list"[^>]*tabindex="0"/);
  assert.match(html, /id="files-tab-global"[^>]*aria-controls="files-list"[^>]*tabindex="-1"/);
});

test('public/app.js wires theme sync, diffed polling, native file preview, toast, view states, and keyboard a11y', () => {
  const appJs = readFileSync(join(publicDir, 'app.js'), 'utf8');

  assert.ok(appJs.includes('computeThemeFromColor'), 'Expected app.js to wire computeThemeFromColor');
  assert.ok(appJs.includes('MutationObserver'), 'Expected app.js to observe :root style changes');
  assert.ok(appJs.includes('scratchpadRenderSignature'), 'Expected app.js to use scratchpadRenderSignature');
  assert.ok(appJs.includes('filePathToUri'), 'Expected app.js to use filePathToUri');
  assert.match(appJs, /toggleAuxPane\s*\(\s*\{\s*tabType:\s*['"]fileView['"]\s*,\s*uri\s*\}/);
  assert.match(appJs, /function\s+setViewState\s*\(/);
  assert.match(appJs, /function\s+showToast\s*\(/);
  assert.match(appJs, /function\s+previewFileInAgy\s*\(/);
  assert.match(appJs, /function\s+selectFilesScope\s*\(/);
  assert.ok(appJs.includes('workspace-select-wrap'), 'Expected app.js to sync workspace-select-wrap');
  assert.ok(appJs.includes('conversationId'), 'Expected app.js to support conversationId fallback');
  assert.doesNotMatch(appJs, /nameSpan\.addEventListener\(\s*['"]dblclick['"]/);
});

function createMockDomSandbox({
  search = '',
  initialColor = 'rgb(247, 247, 248)',
  prefersDark = false,
  sidecar = {},
} = {}) {
  const timers = new Set();
  const intervals = new Set();
  const observers = [];

  class MockClassList {
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

  class MockEventTarget {
    constructor() {
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
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
      const list = this._listeners.get(event.type) || [];
      for (const fn of [...list]) {
        fn.call(this, event);
      }
      if (!event.propagationStopped && this.parentNode && typeof this.parentNode.dispatchEvent === 'function') {
        this.parentNode.dispatchEvent(event);
      }
    }
  }

  class MockElement extends MockEventTarget {
    constructor(tagName, ownerDocument) {
      super();
      this.tagName = String(tagName || 'div').toUpperCase();
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.parentNode = null;
      this._attrs = new Map();
      this.dataset = new Proxy({}, {
        get: (_, prop) => this._attrs.get(`data-${String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`),
        set: (_, prop, val) => {
          this._attrs.set(`data-${String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`, String(val));
          return true;
        },
      });
      this.style = {};
      this.classList = new MockClassList(this);
      this._className = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.textContent = '';
      this.checked = false;
      this.selected = false;
      this.offsetHeight = 140;
      this.isConnected = true;
    }
    get className() {
      return this._className;
    }
    set className(val) {
      this._className = String(val || '');
      this.classList._sync(this._className);
    }
    get firstChild() {
      return this.children[0] || null;
    }
    get parentElement() {
      return this.parentNode;
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      child.isConnected = true;
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
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    setAttribute(name, value) {
      const str = String(value);
      this._attrs.set(name, str);
      if (name === 'id') this.id = str;
      if (name === 'role') this.role = str;
    }
    getAttribute(name) {
      if (name === 'id') return this.id ?? null;
      return this._attrs.has(name) ? this._attrs.get(name) : null;
    }
    focus() {
      this.ownerDocument.activeElement = this;
    }
    select() {}
    click() {
      this.dispatchEvent({ type: 'click', target: this });
    }
    getBoundingClientRect() {
      return { top: 20, bottom: 44, right: 320, left: 280, width: 40, height: 24 };
    }
    closest(selector) {
      let cur = this;
      while (cur) {
        if (matchesSimpleSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (matchesSimpleSelector(child, selector)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
  }

  function matchesSimpleSelector(el, selector) {
    if (!el || !el.classList) return false;
    if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    const attrMatch = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attrMatch) {
      const val = el.getAttribute(attrMatch[1]);
      return attrMatch[2] === undefined ? val !== null : val === attrMatch[2];
    }
    return false;
  }

  const doc = new MockEventTarget();
  doc.visibilityState = 'visible';
  doc.activeElement = null;
  doc.documentElement = new MockElement('html', doc);
  doc.documentElement.parentNode = doc;
  doc.body = new MockElement('body', doc);
  doc.documentElement.appendChild(doc.body);
  const byId = new Map();
  doc.createElement = (tag) => new MockElement(tag, doc);
  doc.getElementById = (id) => byId.get(id) || null;
  doc.querySelector = (selector) => doc.body.querySelector(selector);

  const register = (id, tag = 'div', attrs = {}, parent = doc.body) => {
    const el = new MockElement(tag, doc);
    el.id = id;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'hidden') el.hidden = Boolean(v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    byId.set(id, el);
    parent.appendChild(el);
    return el;
  };

  register('loading-state', 'section', { class: 'loading', 'aria-busy': 'true', hidden: false });
  const emptyState = register('empty-state', 'section', { class: 'empty-state', hidden: true });
  register('empty-description', 'p', { class: 'empty-description' }, emptyState);
  const appShell = register('app-shell', 'div', { class: 'app-shell', hidden: true });
  const appHeader = register('app-header', 'header', { class: 'app-header' }, appShell);
  register('status-dot', 'span', {}, appHeader);
  register('project-name', 'h1', {}, appHeader);
  const wsWrap = register('workspace-select-wrap', 'span', { class: 'select', hidden: true }, appHeader);
  register('workspace-select', 'select', { hidden: true }, wsWrap);
  register('save-status', 'span', {}, appHeader);
  register('export-btn', 'button', {}, appHeader);

  register('links-list', 'div', {}, appShell);
  register('toggle-link-form-btn', 'button', {}, appShell);
  register('link-form', 'form', { hidden: true }, appShell);
  register('link-label-input', 'input', {}, appShell);
  register('link-url-input', 'input', {}, appShell);
  register('link-cancel-btn', 'button', {}, appShell);
  register('link-error', 'span', { hidden: true }, appShell);

  register('todos-counts', 'span', {}, appShell);
  register('clear-done-btn', 'button', { hidden: true }, appShell);
  register('todo-add-form', 'form', {}, appShell);
  register('todo-input', 'input', {}, appShell);
  register('todos-list', 'ul', {}, appShell);

  const filesSection = register('files-section', 'section', {}, appShell);
  const tablist = register('files-tablist', 'div', { class: 'segmented scope-tabs', role: 'tablist' }, filesSection);
  register('files-tab-project', 'button', { class: 'scope-tab is-active', role: 'tab', 'aria-selected': 'true', tabindex: '0' }, tablist);
  register('files-tab-global', 'button', { class: 'scope-tab', role: 'tab', 'aria-selected': 'false', tabindex: '-1' }, tablist);
  register('file-new-btn', 'button', {}, filesSection);
  register('file-upload-btn', 'button', {}, filesSection);
  register('file-path-btn', 'button', {}, filesSection);
  register('editor-settings-btn', 'button', {}, filesSection);
  register('file-upload-input', 'input', {}, filesSection);
  register('editor-settings-panel', 'div', { hidden: true }, filesSection);
  register('editor-default-select', 'select', {}, filesSection);
  register('editor-custom-form', 'form', { hidden: true }, filesSection);
  register('editor-custom-input', 'input', {}, filesSection);
  register('editor-settings-error', 'span', { hidden: true }, filesSection);
  register('file-new-form', 'form', { hidden: true }, filesSection);
  register('file-new-name-input', 'input', {}, filesSection);
  register('file-new-content-input', 'textarea', {}, filesSection);
  register('file-new-error', 'span', { hidden: true }, filesSection);
  register('file-new-cancel-btn', 'button', {}, filesSection);
  register('file-path-form', 'form', { hidden: true }, filesSection);
  register('file-path-input', 'input', {}, filesSection);
  register('file-path-error', 'span', { hidden: true }, filesSection);
  register('file-path-cancel-btn', 'button', {}, filesSection);
  register('files-status', 'div', { hidden: true }, filesSection);
  register('files-drop-hint', 'div', { hidden: true }, filesSection);
  register('files-list', 'ul', {}, filesSection);

  register('notes-input', 'textarea', {}, appShell);
  register('toast', 'div', { class: 'toast', role: 'status', hidden: true });

  let currentBgColor = initialColor;
  const win = new MockEventTarget();
  win.scrollY = 0;
  win.innerWidth = 400;
  win.innerHeight = 700;
  win.location = { search };
  win.sidecar = sidecar;
  win.matchMedia = () => ({ matches: prefersDark });

  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
    trigger() {
      this.cb([], this);
    }
  }

  const sandbox = {
    window: win,
    document: doc,
    Element: MockElement,
    URL,
    URLSearchParams,
    MutationObserver: MockMutationObserver,
    getComputedStyle: () => ({ color: currentBgColor }),
    queueMicrotask,
    navigator: {},
    Blob,
    console,
    setTimeout: (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      intervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
      clearInterval(id);
    },
  };
  win.window = win;
  sandbox.globalThis = sandbox;
  win.AGYTodoHelpers = loadHelpers(win, win);

  const context = vm.createContext(sandbox);
  const appJs = readFileSync(join(publicDir, 'app.js'), 'utf8');
  vm.runInContext(appJs, context, { filename: 'public/app.js' });

  return {
    window: win,
    document: doc,
    setBgColor(color) {
      currentBgColor = color;
      for (const obs of observers) obs.trigger();
    },
    cleanup() {
      for (const id of timers) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      timers.clear();
      intervals.clear();
    },
  };
}

test('app.js runtime handles theme sync, loading->empty/app transitions, diffed polling, native preview, toast, tablist & menu keyboard nav', async (t) => {
  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 20));

  // 1. Empty workspace resolution transitions loading -> empty
  {
    let resolveUris;
    const dom = createMockDomSandbox({
      sidecar: {
        getWorkspaceUris: () => new Promise((r) => { resolveUris = r; }),
      },
    });
    t.after(() => dom.cleanup());

    assert.equal(dom.document.getElementById('loading-state').hidden, false);
    assert.equal(dom.document.getElementById('empty-state').hidden, true);
    assert.equal(dom.document.getElementById('app-shell').hidden, true);
    assert.equal(dom.document.documentElement.dataset.theme, 'light');

    // Live theme change to dark via color(srgb ...)
    dom.setBgColor('color(srgb 0.08 0.09 0.1)');
    assert.equal(dom.document.documentElement.dataset.theme, 'dark');

    resolveUris([]);
    await flushMicrotasks();

    assert.equal(dom.document.getElementById('loading-state').hidden, true);
    assert.equal(dom.document.getElementById('empty-state').hidden, false);
    assert.equal(dom.document.getElementById('app-shell').hidden, true);
  }

  // 2. Multi-workspace, diffed polling, native preview + toast fallback, keyboard nav, and conversationId query fallback
  {
    const previewCalls = [];
    const metadataCalls = [];
    let currentNotes = 'hello';
    let currentTodos = [{ id: 't1', text: 'First task', done: false }];
    const currentFiles = [
      { name: 'doc #1?.md', path: '/Users/my user/doc #1?.md', size: 120, updatedAt: '2026-01-01T00:00:00.000Z' },
    ];

    const fakeFetch = async (url) => {
      if (url.startsWith('/api/scratchpad')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            displayName: 'agy-todo',
            canonicalPath: '/Users/akemp/Workspace/agy-todo',
            links: [{ id: 'l1', label: 'Repo', url: 'https://example.com' }],
            todos: currentTodos,
            notes: currentNotes,
          }),
        };
      }
      if (url.startsWith('/api/files?')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            files: currentFiles,
            settings: { defaultEditor: 'system', customEditorCommand: '' },
          }),
        };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };

    const dom = createMockDomSandbox({
      search: '?conversationId=conv-fallback-123',
      sidecar: {
        fetch: fakeFetch,
        agent: {
          getConversationMetadata: async (cid) => {
            metadataCalls.push(cid);
            return {
              response: {
                conversationMetadata: {
                  metadata: {
                    workspaceUris: [
                      'file:///Users/akemp/Workspace/agy-todo',
                      'file:///Users/akemp/Workspace/other',
                    ],
                  },
                },
              },
            };
          },
        },
        ui: {
          toggleAuxPane: async (opts) => {
            previewCalls.push(opts);
          },
        },
      },
    });
    t.after(() => dom.cleanup());

    await flushMicrotasks();

    assert.deepEqual(metadataCalls, ['conv-fallback-123']);
    assert.equal(dom.document.getElementById('loading-state').hidden, true);
    assert.equal(dom.document.getElementById('app-shell').hidden, false);
    assert.equal(dom.document.getElementById('workspace-select').hidden, false);
    assert.equal(dom.document.getElementById('workspace-select-wrap').hidden, false);

    // Verify 3s focus/visibility refresh skips re-rendering todos/links when only notes change
    const initialTodoNode = dom.document.getElementById('todos-list').children[0];
    currentNotes = 'updated externally';
    dom.window.dispatchEvent({ type: 'focus' });
    await flushMicrotasks();
    assert.equal(dom.document.getElementById('todos-list').children[0], initialTodoNode);
    assert.equal(dom.document.getElementById('notes-input').value, 'updated externally');

    // When todos change, refresh re-renders todos
    currentTodos = [{ id: 't1', text: 'First task', done: true }];
    dom.window.dispatchEvent({ type: 'focus' });
    await flushMicrotasks();
    assert.notEqual(dom.document.getElementById('todos-list').children[0], initialTodoNode);

    // Clicking .file-name button opens native AGY preview via filePathToUri
    const fileNameBtn = dom.document.getElementById('files-list').querySelector('.file-name');
    assert.equal(fileNameBtn.tagName, 'BUTTON');
    fileNameBtn.click();
    await flushMicrotasks();
    assert.deepEqual(JSON.parse(JSON.stringify(previewCalls)), [
      { tabType: 'fileView', uri: 'file:///Users/my%20user/doc%20%231%3F.md' },
    ]);

    // Standalone fallback without toggleAuxPane shows #toast without throwing
    delete dom.window.sidecar.ui;
    fileNameBtn.click();
    await flushMicrotasks();
    const toastEl = dom.document.getElementById('toast');
    assert.equal(toastEl.hidden, false);
    assert.match(toastEl.textContent, /Native file preview requires Antigravity/);

    // Tablist ArrowRight / ArrowLeft roving tabindex + focus
    const projectTab = dom.document.getElementById('files-tab-project');
    const globalTab = dom.document.getElementById('files-tab-global');
    projectTab.focus();
    projectTab.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
    assert.equal(dom.document.activeElement, globalTab);
    assert.equal(globalTab.getAttribute('aria-selected'), 'true');
    assert.equal(globalTab.getAttribute('tabindex'), '0');
    assert.equal(projectTab.getAttribute('tabindex'), '-1');

    globalTab.dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
    assert.equal(dom.document.activeElement, projectTab);
    assert.equal(projectTab.getAttribute('aria-selected'), 'true');
    await flushMicrotasks();

    // .open-with-menu focuses first menuitem, navigates with ArrowDown, and restores focus on Escape
    const toggleBtn = dom.document.getElementById('files-list').querySelector('.open-split-toggle');
    toggleBtn.click();
    await flushMicrotasks();
    const menu = dom.document.getElementById('files-list').querySelector('.open-with-menu');
    assert.ok(menu, 'Expected .open-with-menu to open');
    const menuItems = menu.querySelectorAll('[role="menuitem"]');
    assert.equal(menuItems[0].textContent, 'Preview in AGY');
    assert.equal(dom.document.activeElement, menuItems[0]);

    menu.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.equal(dom.document.activeElement, menuItems[1]);

    menu.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(dom.document.getElementById('files-list').querySelector('.open-with-menu'), null);
    const restoredToggleBtn = dom.document.getElementById('files-list').querySelector('.open-split-toggle');
    assert.equal(dom.document.activeElement, restoredToggleBtn);
  }
});
