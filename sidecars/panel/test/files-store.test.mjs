import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ValidationError, NotFoundError } from '../store.mjs';
import {
  MAX_FILE_BYTES,
  VALID_EDITORS,
  createFileStore,
  resolveUniqueFileName,
  sanitizeFileName,
} from '../files-store.mjs';

function makeTempDir(prefix = 'agy-todo-files-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('1. sanitizeFileName rejects traversal, separators, empty names, and control chars', () => {
  assert.equal(sanitizeFileName('  notes.md  '), 'notes.md');
  for (const bad of ['', '   ', '.', '..', '../secret.md', 'a/b.md', 'a\\b.md', 'bad\0.md', 'bad\n.md', null, 123]) {
    assert.throws(
      () => sanitizeFileName(bad),
      (err) => err instanceof ValidationError,
      `Expected ValidationError for: ${JSON.stringify(bad)}`,
    );
  }
});

test('2. Project vs Global file lifecycle, duplicate auto-rename, and Git worktree sharing', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const wsDir = join(root, 'repo');
  mkdirSync(wsDir, { recursive: true });
  const wsUri = pathToFileURL(wsDir).href;

  const store = createFileStore({ dataDir });

  // Global save works without workspaceUri
  const g1 = await store.saveFile({
    scope: 'global',
    filename: 'prompt.md',
    content: '# First\n',
    encoding: 'utf8',
  });
  assert.equal(g1.savedFile.name, 'prompt.md');
  assert.equal(g1.savedFile.scope, 'global');
  assert.ok(g1.savedFile.path.startsWith(join(dataDir, 'files', 'global')));

  // Duplicate auto-rename preserves extension
  const g2 = await store.saveFile({
    scope: 'global',
    filename: 'prompt.md',
    content: '# Second\n',
    encoding: 'utf8',
  });
  assert.equal(g2.savedFile.name, 'prompt-2.md');
  assert.equal(g2.files.length, 2);

  // Project save requires workspaceUri and persists binary base64
  await assert.rejects(
    () => store.saveFile({ scope: 'project', filename: 'a.md', content: 'hi' }),
    (err) => err instanceof ValidationError,
  );
  const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const p1 = await store.saveFile({
    scope: 'project',
    workspaceUri: wsUri,
    filename: 'diagram.png',
    content: binBytes.toString('base64'),
    encoding: 'base64',
  });
  assert.equal(p1.savedFile.scope, 'project');
  assert.deepEqual(readFileSync(p1.savedFile.path), binBytes);

  // Git worktree sharing: main repo and linked worktree share project files
  const gitRepo = join(root, 'git-main');
  const gitWorktree = join(root, 'git-wt');
  mkdirSync(gitRepo, { recursive: true });
  execFileSync('git', ['init'], { cwd: gitRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepo, stdio: 'ignore' });
  writeFileSync(join(gitRepo, 'README.md'), 'init\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: gitRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: gitRepo, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', gitWorktree, '-b', 'wt-branch'], { cwd: gitRepo, stdio: 'ignore' });

  await store.saveFile({
    scope: 'project',
    workspaceUri: pathToFileURL(gitRepo).href,
    filename: 'shared.md',
    content: 'shared across worktrees',
  });
  const wtList = await store.listFiles('project', pathToFileURL(gitWorktree).href);
  assert.equal(wtList.files.length, 1);
  assert.equal(wtList.files[0].name, 'shared.md');

  // Rename with collision auto-renames; Delete removes file
  await store.saveFile({ scope: 'global', filename: 'other.md', content: 'x' });
  const renamed = await store.renameFile({
    scope: 'global',
    filename: 'other.md',
    newFilename: 'prompt.md',
  });
  assert.equal(renamed.renamedFile.name, 'prompt-3.md');
  assert.equal(existsSync(join(dataDir, 'files', 'global', 'other.md')), false);

  const afterDel = await store.deleteFile({ scope: 'global', filename: 'prompt-3.md' });
  assert.equal(afterDel.files.some((f) => f.name === 'prompt-3.md'), false);
});

test('3. importFileFromPath handles file:// URIs, missing files, directories, and 10 MB limit', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const srcFile = join(root, 'plan.md');
  writeFileSync(srcFile, '# Imported Plan\n', 'utf8');

  const store = createFileStore({ dataDir, maxFileBytes: 64 });
  const imported = await store.importFileFromPath({
    scope: 'global',
    sourcePath: pathToFileURL(srcFile).href,
  });
  assert.equal(imported.savedFile.name, 'plan.md');
  assert.equal(readFileSync(imported.savedFile.path, 'utf8'), '# Imported Plan\n');

  await assert.rejects(
    () => store.importFileFromPath({ scope: 'global', sourcePath: join(root, 'missing.md') }),
    (err) => err instanceof NotFoundError,
  );
  await assert.rejects(
    () => store.importFileFromPath({ scope: 'global', sourcePath: root }),
    (err) => err instanceof ValidationError,
  );

  const bigFile = join(root, 'big.md');
  writeFileSync(bigFile, 'a'.repeat(65), 'utf8');
  await assert.rejects(
    () => store.importFileFromPath({ scope: 'global', sourcePath: bigFile }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.saveFile({ scope: 'global', filename: 'too-big.txt', content: 'a'.repeat(65), encoding: 'utf8' }),
    (err) => err instanceof ValidationError,
  );
  assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
});

test('4. Symlink escape inside managed directory is rejected by resolveManagedFilePath', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const outsideFile = join(root, 'outside.txt');
  writeFileSync(outsideFile, 'secret', 'utf8');

  const globalDir = join(dataDir, 'files', 'global');
  mkdirSync(globalDir, { recursive: true });
  symlinkSync(outsideFile, join(globalDir, 'escape.txt'));

  const store = createFileStore({ dataDir });
  await assert.rejects(
    () => store.resolveManagedFilePath({ scope: 'global', filename: 'escape.txt' }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.deleteFile({ scope: 'global', filename: 'missing.txt' }),
    (err) => err instanceof NotFoundError,
  );
  await assert.rejects(
    () => store.renameFile({ scope: 'global', filename: 'missing.txt', newFilename: 'x.txt' }),
    (err) => err instanceof NotFoundError,
  );
});

test('5. Settings persistence validates defaultEditor and survives reload', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');

  assert.deepEqual(VALID_EDITORS, ['system', 'subl', 'code', 'cursor', 'agy', 'custom']);

  const store = createFileStore({ dataDir });
  const initial = await store.getSettings();
  assert.equal(initial.defaultEditor, 'system');

  const saved = await store.saveSettings({
    defaultEditor: 'subl',
    customEditorCommand: '',
  });
  assert.equal(saved.defaultEditor, 'subl');

  const reloaded = createFileStore({ dataDir });
  assert.equal((await reloaded.getSettings()).defaultEditor, 'subl');

  await assert.rejects(
    () => store.saveSettings({ defaultEditor: 'vim-evil' }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.saveSettings({ defaultEditor: 'custom', customEditorCommand: '   ' }),
    (err) => err instanceof ValidationError,
  );
});

test('6. resolveUniqueFileName handles extensions, no-extension files, and dotfiles', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(resolveUniqueFileName(dir, 'README'), 'README');
  writeFileSync(join(dir, 'README'), '1');
  assert.equal(resolveUniqueFileName(dir, 'README'), 'README-2');

  writeFileSync(join(dir, '.env'), '1');
  assert.equal(resolveUniqueFileName(dir, '.env'), '.env-2');

  writeFileSync(join(dir, 'archive.tar.gz'), '1');
  assert.equal(resolveUniqueFileName(dir, 'archive.tar.gz'), 'archive.tar-2.gz');
});

test('7. saveFile supports opt-in overwrite while preserving default unique renaming and symlink safety', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const store = createFileStore({ dataDir });

  await store.saveFile({ scope: 'global', filename: 'plan.md', content: 'v1' });
  const autoRenamed = await store.saveFile({ scope: 'global', filename: 'plan.md', content: 'v2' });
  assert.equal(autoRenamed.savedFile.name, 'plan-2.md');

  const overwritten = await store.saveFile({
    scope: 'global',
    filename: 'plan.md',
    content: 'v3-updated',
    overwrite: true,
  });
  assert.equal(overwritten.savedFile.name, 'plan.md');
  const readBack = await store.readFile({ scope: 'global', filename: 'plan.md' });
  assert.equal(readBack.content, 'v3-updated');

  // Non-boolean overwrite is rejected
  await assert.rejects(
    () => store.saveFile({ scope: 'global', filename: 'plan.md', content: 'bad', overwrite: 'yes' }),
    (err) => err instanceof ValidationError,
  );

  // Symlink escape cannot be overwritten
  const outsideFile = join(root, 'outside.md');
  writeFileSync(outsideFile, 'untouched', 'utf8');
  symlinkSync(outsideFile, join(dataDir, 'files', 'global', 'escape.md'));
  await assert.rejects(
    () => store.saveFile({ scope: 'global', filename: 'escape.md', content: 'pwned', overwrite: true }),
    (err) => err instanceof ValidationError,
  );
  assert.equal(readFileSync(outsideFile, 'utf8'), 'untouched');
});

test('8. readFile returns utf8 and base64 contents and rejects missing, invalid encoding, or escaping paths', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const store = createFileStore({ dataDir });

  await store.saveFile({ scope: 'global', filename: 'note.md', content: '# Hello\n' });
  const utf8Res = await store.readFile({ scope: 'global', filename: 'note.md' });
  assert.equal(utf8Res.scope, 'global');
  assert.equal(utf8Res.encoding, 'utf8');
  assert.equal(utf8Res.file.name, 'note.md');
  assert.equal(utf8Res.content, '# Hello\n');

  const rawBytes = Buffer.from([0x00, 0xff, 0x42]);
  await store.saveFile({
    scope: 'global',
    filename: 'bin.dat',
    content: rawBytes.toString('base64'),
    encoding: 'base64',
  });
  const b64Res = await store.readFile({ scope: 'global', filename: 'bin.dat', encoding: 'base64' });
  assert.equal(b64Res.encoding, 'base64');
  assert.equal(b64Res.content, rawBytes.toString('base64'));

  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'missing.md' }),
    (err) => err instanceof NotFoundError,
  );
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'note.md', encoding: 'hex' }),
    (err) => err instanceof ValidationError,
  );

  // Symlink escape is rejected
  const outsideFile = join(root, 'secret.txt');
  writeFileSync(outsideFile, 'top-secret', 'utf8');
  symlinkSync(outsideFile, join(dataDir, 'files', 'global', 'escape-read.txt'));
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'escape-read.txt' }),
    (err) => err instanceof ValidationError,
  );
});
