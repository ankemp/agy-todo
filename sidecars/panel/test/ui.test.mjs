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
