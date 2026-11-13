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
