import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  NotFoundError,
  ValidationError,
  createStore,
  normalizeLinkUrl,
  resolveProject,
} from '../store.mjs';

function makeTempDir(prefix = 'agy-todo-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

test('1. Git worktree canonicalization maps main repo, worktree root, and nested subdir to same projectKey', (t) => {
  const root = makeTempDir('agy-todo-wt-');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const mainRepo = join(root, 'main-repo');
  const wtDir = join(root, 'feat-wt');
  mkdirSync(mainRepo, { recursive: true });

  git(mainRepo, ['init']);
  writeFileSync(join(mainRepo, 'README.md'), '# hello\n', 'utf8');
  git(mainRepo, ['add', 'README.md']);
  git(mainRepo, ['commit', '-m', 'init']);
  git(mainRepo, ['worktree', 'add', wtDir, '-b', 'feat-wt']);

  const nestedDir = join(wtDir, 'src', 'nested');
  mkdirSync(nestedDir, { recursive: true });

  const realMain = realpathSync(mainRepo);
  const fromMain = resolveProject(pathToFileURL(mainRepo).href);
  const fromWt = resolveProject(pathToFileURL(wtDir).href);
  const fromNested = resolveProject(pathToFileURL(nestedDir).href);

  assert.equal(fromMain.canonicalPath, realMain);
  assert.equal(fromWt.canonicalPath, realMain);
  assert.equal(fromNested.canonicalPath, realMain);
  assert.equal(fromWt.projectKey, fromMain.projectKey);
  assert.equal(fromNested.projectKey, fromMain.projectKey);
  assert.equal(fromMain.displayName, 'main-repo');
  assert.match(fromMain.projectKey, /^[0-9a-f]{16}$/);
});

test('2. Encoded file:// URIs decode spaces/UTF-8 and empty workspaceInput throws ValidationError', (t) => {
  const root = makeTempDir('agy-todo-uri-');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const unicodeDir = join(root, 'My Proj café');
  mkdirSync(unicodeDir, { recursive: true });

  const resolved = resolveProject(pathToFileURL(unicodeDir).href);
  assert.equal(resolved.canonicalPath, realpathSync(unicodeDir));
  assert.equal(resolved.displayName, 'My Proj café');

  for (const invalid of ['', '   ', null, undefined]) {
    assert.throws(
      () => resolveProject(invalid),
      (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
    );
  }
});

test('3. Link URL normalization auto-prefixes schemes and rejects dangerous/invalid URLs', () => {
  assert.equal(
    normalizeLinkUrl('staging.example.com/app'),
    'https://staging.example.com/app',
  );
  assert.equal(
    normalizeLinkUrl('localhost:4800/graphql'),
    'http://localhost:4800/graphql',
  );
  assert.equal(
    normalizeLinkUrl('127.0.0.1:9229'),
    'http://127.0.0.1:9229/',
  );
  assert.equal(
    normalizeLinkUrl('https://docs.example.com/path?x=1#top'),
    'https://docs.example.com/path?x=1#top',
  );

  for (const bad of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'http://',
    'https://',
    '',
    '   ',
  ]) {
    assert.throws(
      () => normalizeLinkUrl(bad),
      (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
      `Expected ValidationError for: ${String(bad)}`,
    );
  }
});

test('4. Read-before-write returns empty scratchpad without touching disk, and CRUD lifecycle updates disk + index.json', async (t) => {
  const root = makeTempDir('agy-todo-crud-');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspaceDir = join(root, 'workspace');
  const dataDir = join(root, 'data');
  mkdirSync(workspaceDir, { recursive: true });
  const workspaceUri = pathToFileURL(workspaceDir).href;

  const store = createStore({ dataDir });
  assert.equal(store.dataDir, dataDir);

  const info = store.resolveProject(workspaceUri);
  const projectFile = join(dataDir, 'projects', `${info.projectKey}.json`);
  const indexFile = join(dataDir, 'index.json');

  // Read before write: empty structure, no file created
  const initial = await store.getScratchpad(workspaceUri);
  assert.deepEqual(initial, {
    version: 1,
    projectKey: info.projectKey,
    canonicalPath: info.canonicalPath,
    displayName: info.displayName,
    updatedAt: null,
    links: [],
    todos: [],
    notes: '',
  });
  assert.equal(existsSync(projectFile), false);
  assert.equal(existsSync(indexFile), false);

  // Add link with blank label -> defaults to hostname
  const afterLink = await store.addLink(workspaceUri, '   ', 'docs.example.com/guide');
  assert.equal(afterLink.links.length, 1);
  assert.equal(afterLink.links[0].label, 'docs.example.com');
  assert.equal(afterLink.links[0].url, 'https://docs.example.com/guide');
  assert.ok(afterLink.updatedAt);
  assert.equal(existsSync(projectFile), true);
  assert.equal(existsSync(indexFile), true);

  // Add todos, toggle, update, clearDone, delete
  const afterTodo1 = await store.addTodo(workspaceUri, 'First task');
  const afterTodo2 = await store.addTodo(workspaceUri, 'Second task');
  assert.equal(afterTodo2.todos.length, 2);
  const id1 = afterTodo1.todos[0].id;
  const id2 = afterTodo2.todos[1].id;

  const afterToggle = await store.toggleTodo(workspaceUri, id1);
  assert.equal(afterToggle.todos[0].done, true);
  assert.ok(afterToggle.todos[0].doneAt);

  const afterUpdate = await store.updateTodo(workspaceUri, id2, 'Updated second');
  assert.equal(afterUpdate.todos[1].text, 'Updated second');

  const afterClear = await store.clearDoneTodos(workspaceUri);
  assert.equal(afterClear.todos.length, 1);
  assert.equal(afterClear.todos[0].id, id2);

  const afterDeleteTodo = await store.deleteTodo(workspaceUri, id2);
  assert.equal(afterDeleteTodo.todos.length, 0);

  const afterDeleteLink = await store.deleteLink(workspaceUri, afterLink.links[0].id);
  assert.equal(afterDeleteLink.links.length, 0);

  const afterNotes = await store.saveNotes(workspaceUri, 'Remember Redis TLS');
  assert.equal(afterNotes.notes, 'Remember Redis TLS');

  // Verify persisted project JSON & index.json
  const persisted = JSON.parse(readFileSync(projectFile, 'utf8'));
  assert.equal(persisted.notes, 'Remember Redis TLS');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  assert.equal(index[info.projectKey].canonicalPath, info.canonicalPath);
  assert.equal(index[info.projectKey].displayName, info.displayName);
  assert.equal(index[info.projectKey].updatedAt, afterNotes.updatedAt);

  // Unknown todo/link IDs throw NotFoundError
  await assert.rejects(
    () => store.toggleTodo(workspaceUri, 'missing-id'),
    (err) => err instanceof NotFoundError && err.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => store.updateTodo(workspaceUri, 'missing-id', 'text'),
    (err) => err instanceof NotFoundError && err.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => store.deleteTodo(workspaceUri, 'missing-id'),
    (err) => err instanceof NotFoundError && err.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => store.deleteLink(workspaceUri, 'missing-id'),
    (err) => err instanceof NotFoundError && err.code === 'NOT_FOUND',
  );
});

test('5. Concurrency serialization preserves all updates across Promise.all mutations', async (t) => {
  const root = makeTempDir('agy-todo-conc-');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspaceDir = join(root, 'workspace');
  const dataDir = join(root, 'data');
  mkdirSync(workspaceDir, { recursive: true });
  const uri = pathToFileURL(workspaceDir).href;

  const store = createStore({ dataDir });
  await Promise.all([
    store.saveNotes(uri, 'note body'),
    store.addTodo(uri, 't1'),
    store.addTodo(uri, 't2'),
    store.addLink(uri, 'Docs', 'docs.example.com'),
  ]);

  const final = await store.getScratchpad(uri);
  assert.equal(final.notes, 'note body');
  assert.deepEqual(
    final.todos.map((todo) => todo.text),
    ['t1', 't2'],
  );
  assert.equal(final.links.length, 1);
  assert.equal(final.links[0].label, 'Docs');
  assert.equal(final.links[0].url, 'https://docs.example.com/');
});

test('6. Corrupt JSON file is quarantined and getScratchpad returns a fresh empty scratchpad', async (t) => {
  const root = makeTempDir('agy-todo-corrupt-');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspaceDir = join(root, 'workspace');
  const dataDir = join(root, 'data');
  const projectsDir = join(dataDir, 'projects');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  const uri = pathToFileURL(workspaceDir).href;
  const info = resolveProject(uri);
  const corruptTarget = join(projectsDir, `${info.projectKey}.json`);
  writeFileSync(corruptTarget, '{truncated', 'utf8');

  const store = createStore({ dataDir });
  const pad = await store.getScratchpad(uri);

  assert.deepEqual(pad, {
    version: 1,
    projectKey: info.projectKey,
    canonicalPath: info.canonicalPath,
    displayName: info.displayName,
    updatedAt: null,
    links: [],
    todos: [],
    notes: '',
  });
  assert.equal(existsSync(corruptTarget), false);

  const files = readdirSync(projectsDir);
  const quarantined = files.filter((f) => f.startsWith(`${info.projectKey}.corrupt.`));
  assert.equal(quarantined.length, 1);
  assert.equal(readFileSync(join(projectsDir, quarantined[0]), 'utf8'), '{truncated');
});
