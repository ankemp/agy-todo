import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ValidationError, NotFoundError } from '../store.mjs';
import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_READ_LINES,
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

test('9. file store serializes mutations across store instances via locks outside files dir', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const storeA = createFileStore({ dataDir });
  const storeB = createFileStore({ dataDir });

  // Two independent store instances (simulating separate processes) saving colliding names concurrently
  const results = await Promise.all([
    storeA.saveFile({ scope: 'global', filename: 'race.md', content: 'from-a' }),
    storeB.saveFile({ scope: 'global', filename: 'race.md', content: 'from-b' }),
    storeA.saveFile({ scope: 'global', filename: 'race.md', content: 'from-a2' }),
    storeB.saveFile({ scope: 'global', filename: 'race.md', content: 'from-b2' }),
  ]);

  const savedNames = results.map((r) => r.savedFile.name).sort();
  assert.deepEqual(savedNames, ['race-2.md', 'race-3.md', 'race-4.md', 'race.md']);

  const listed = await storeA.listFiles('global');
  assert.deepEqual(
    listed.files.map((f) => f.name).sort(),
    ['race-2.md', 'race-3.md', 'race-4.md', 'race.md'],
  );

  // Project scope also serializes across store instances without polluting the project files dir
  const projDir = join(root, 'proj');
  mkdirSync(projDir, { recursive: true });
  const workspaceUri = pathToFileURL(projDir).href;
  const projResults = await Promise.all([
    storeA.saveFile({ scope: 'project', workspaceUri, filename: 'spec.md', content: 'p1' }),
    storeB.saveFile({ scope: 'project', workspaceUri, filename: 'spec.md', content: 'p2' }),
  ]);
  assert.deepEqual(
    projResults.map((r) => r.savedFile.name).sort(),
    ['spec-2.md', 'spec.md'],
  );
  const projListed = await storeA.listFiles('project', workspaceUri);
  assert.equal(
    readdirSync(projListed.directory).some((n) => n.endsWith('.lock')),
    false,
  );

  // Lock directory exists under dataDir/locks/files and no .lock files appear in files/global
  assert.equal(existsSync(join(dataDir, 'locks', 'files')), true);
  assert.equal(
    readdirSync(join(dataDir, 'files', 'global')).some((n) => n.endsWith('.lock')),
    false,
  );
});

test('10. editFile replaces exact single/multiple occurrences literally and rejects missing, binary, invalid, oversized, or escaping targets', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const store = createFileStore({ dataDir, maxFileBytes: 128 });

  await store.saveFile({
    scope: 'global',
    filename: 'notes.md',
    content: '# Plan\r\n- [ ] item\r\n- [ ] item\r\nPrice: TBD\r\n',
  });

  // Single occurrence with literal $ tokens ($100, $&, $$) and CRLF preserved
  const edit1 = await store.editFile({
    scope: 'global',
    filename: 'notes.md',
    target: 'Price: TBD',
    replacement: 'Price: $100 ($& / $$)',
  });
  assert.equal(edit1.scope, 'global');
  assert.equal(edit1.file.name, 'notes.md');
  assert.equal(edit1.replacements, 1);

  // Multiple occurrences replaced atomically
  const edit2 = await store.editFile({
    scope: 'global',
    filename: 'notes.md',
    target: '- [ ] item',
    replacement: '- [x] item',
  });
  assert.equal(edit2.replacements, 2);

  // Empty replacement deletes target
  const edit3 = await store.editFile({
    scope: 'global',
    filename: 'notes.md',
    target: '# Plan\r\n',
    replacement: '',
  });
  assert.equal(edit3.replacements, 1);

  const after = await store.readFile({ scope: 'global', filename: 'notes.md' });
  assert.equal(after.content, '- [x] item\r\n- [x] item\r\nPrice: $100 ($& / $$)\r\n');

  // Target not found -> ValidationError
  await assert.rejects(
    () => store.editFile({ scope: 'global', filename: 'notes.md', target: 'nonexistent', replacement: 'x' }),
    (err) => err instanceof ValidationError,
  );
  // Empty target / non-string replacement -> ValidationError
  await assert.rejects(
    () => store.editFile({ scope: 'global', filename: 'notes.md', target: '', replacement: 'x' }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.editFile({ scope: 'global', filename: 'notes.md', target: 'item', replacement: 42 }),
    (err) => err instanceof ValidationError,
  );
  // Missing file -> NotFoundError
  await assert.rejects(
    () => store.editFile({ scope: 'global', filename: 'missing.md', target: 'a', replacement: 'b' }),
    (err) => err instanceof NotFoundError,
  );
  // Oversized resulting file -> ValidationError (original untouched)
  await assert.rejects(
    () => store.editFile({ scope: 'global', filename: 'notes.md', target: 'item', replacement: 'x'.repeat(100) }),
    (err) => err instanceof ValidationError,
  );
  assert.equal((await store.readFile({ scope: 'global', filename: 'notes.md' })).content, after.content);

  // Binary (NUL byte) and invalid UTF-8 files rejected
  await store.saveFile({
    scope: 'global',
    filename: 'bin.dat',
    content: Buffer.from([0x61, 0x00, 0x62]).toString('base64'),
    encoding: 'base64',
  });
  await assert.rejects(
    () => store.editFile({ scope: 'global', filename: 'bin.dat', target: 'a', replacement: 'z' }),
    (err) => err instanceof ValidationError,
  );
  await store.saveFile({
    scope: 'global',
    filename: 'badutf8.dat',
    content: Buffer.from([0xff, 0xfe, 0x61]).toString('base64'),
    encoding: 'base64',
  });
  await assert.rejects(
    () => store.editFile({ scope: 'global', filename: 'badutf8.dat', target: 'a', replacement: 'z' }),
    (err) => err instanceof ValidationError,
  );

  // Symlink escape rejected without modifying outside file
  const outsideFile = join(root, 'outside.md');
  writeFileSync(outsideFile, 'secret text', 'utf8');
  symlinkSync(outsideFile, join(dataDir, 'files', 'global', 'escape-edit.md'));
  await assert.rejects(
    () => store.editFile({ scope: 'global', filename: 'escape-edit.md', target: 'secret', replacement: 'pwned' }),
    (err) => err instanceof ValidationError,
  );
  assert.equal(readFileSync(outsideFile, 'utf8'), 'secret text');
});

test('11. saveFile with append creates missing file, appends verbatim to existing, rejects overwrite+append, oversized, and symlink escapes', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const store = createFileStore({ dataDir, maxFileBytes: 32 });

  const created = await store.saveFile({
    scope: 'global',
    filename: 'log.md',
    content: 'line1\n',
    append: true,
  });
  assert.equal(created.savedFile.name, 'log.md');
  assert.equal(created.existedBefore, false);

  const appended = await store.saveFile({
    scope: 'global',
    filename: 'log.md',
    content: 'line2\n',
    append: true,
  });
  assert.equal(appended.savedFile.name, 'log.md');
  assert.equal(appended.existedBefore, true);
  assert.equal((await store.readFile({ scope: 'global', filename: 'log.md' })).content, 'line1\nline2\n');

  // overwrite=true sets existedBefore accurately for new vs existing files
  const overwriteNew = await store.saveFile({
    scope: 'global',
    filename: 'fresh.md',
    content: 'init',
    overwrite: true,
  });
  assert.equal(overwriteNew.existedBefore, false);
  const overwriteExisting = await store.saveFile({
    scope: 'global',
    filename: 'fresh.md',
    content: 'replaced',
    overwrite: true,
  });
  assert.equal(overwriteExisting.existedBefore, true);

  // Cannot combine overwrite and append
  await assert.rejects(
    () => store.saveFile({ scope: 'global', filename: 'log.md', content: 'x', overwrite: true, append: true }),
    (err) => err instanceof ValidationError,
  );
  // Non-boolean append rejected
  await assert.rejects(
    () => store.saveFile({ scope: 'global', filename: 'log.md', content: 'x', append: 'yes' }),
    (err) => err instanceof ValidationError,
  );
  // Combined size > maxFileBytes rejected and original untouched
  await assert.rejects(
    () => store.saveFile({ scope: 'global', filename: 'log.md', content: 'z'.repeat(25), append: true }),
    (err) => err instanceof ValidationError,
  );
  assert.equal((await store.readFile({ scope: 'global', filename: 'log.md' })).content, 'line1\nline2\n');

  // Symlink escape rejected
  const outsideFile = join(root, 'outside-append.md');
  writeFileSync(outsideFile, 'untouched', 'utf8');
  symlinkSync(outsideFile, join(dataDir, 'files', 'global', 'escape-append.md'));
  await assert.rejects(
    () => store.saveFile({ scope: 'global', filename: 'escape-append.md', content: 'pwned', append: true }),
    (err) => err instanceof ValidationError,
  );
  assert.equal(readFileSync(outsideFile, 'utf8'), 'untouched');
});

test('12. readFile supports startLine/endLine/byteOffset, preserves CRLF/no-trailing-newline, enforces line/byte caps without splitting UTF-8, and rejects invalid ranges/base64 slicing', async (t) => {
  assert.equal(DEFAULT_MAX_READ_LINES, 800);
  assert.equal(DEFAULT_MAX_READ_BYTES, 46080);

  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const store = createFileStore({ dataDir, maxReadLines: 3, maxReadBytes: 10 });

  // Empty file
  await store.saveFile({ scope: 'global', filename: 'empty.md', content: '' });
  const emptyRead = await store.readFile({ scope: 'global', filename: 'empty.md' });
  assert.equal(emptyRead.content, '');
  assert.equal(emptyRead.totalLines, 0);
  assert.equal(emptyRead.startLine, 0);
  assert.equal(emptyRead.endLine, 0);
  assert.equal(emptyRead.truncated, false);
  const emptyLine1 = await store.readFile({ scope: 'global', filename: 'empty.md', startLine: 1 });
  assert.equal(emptyLine1.totalLines, 0);
  assert.equal(emptyLine1.content, '');
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'empty.md', startLine: 2 }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'empty.md', byteOffset: 1 }),
    (err) => err instanceof ValidationError,
  );

  // Trailing newline does not produce a phantom empty line
  await store.saveFile({ scope: 'global', filename: 'trailing.txt', content: 'a\nb\n' });
  const trailingRead = await store.readFile({ scope: 'global', filename: 'trailing.txt' });
  assert.equal(trailingRead.totalLines, 2);
  assert.equal(trailingRead.endLine, 2);
  assert.equal(trailingRead.truncated, false);

  // CRLF + no trailing newline + line cap
  await store.saveFile({
    scope: 'global',
    filename: 'lines.txt',
    content: 'a\r\nb\r\nc\r\nd\r\ne',
  });
  const cappedLines = await store.readFile({ scope: 'global', filename: 'lines.txt' });
  assert.equal(cappedLines.content, 'a\r\nb\r\nc\r\n');
  assert.equal(cappedLines.totalLines, 5);
  assert.equal(cappedLines.startLine, 1);
  assert.equal(cappedLines.endLine, 3);
  assert.equal(cappedLines.truncated, true);

  // Explicit range clamped at totalLines
  const tailSlice = await store.readFile({ scope: 'global', filename: 'lines.txt', startLine: 4, endLine: 99 });
  assert.equal(tailSlice.content, 'd\r\ne');
  assert.equal(tailSlice.startLine, 4);
  assert.equal(tailSlice.endLine, 5);
  assert.equal(tailSlice.totalLines, 5);
  assert.equal(tailSlice.truncated, false);

  // Multi-byte UTF-8 (each emoji is 4 bytes; maxReadBytes = 10 -> cuts cleanly at 8 bytes = 2 emojis)
  await store.saveFile({ scope: 'global', filename: 'emoji.txt', content: '😀😁😂😃' });
  const chunk1 = await store.readFile({ scope: 'global', filename: 'emoji.txt', startLine: 1, endLine: 1 });
  assert.equal(chunk1.content, '😀😁');
  assert.equal(chunk1.truncated, true);
  assert.equal(chunk1.nextByteOffset, 8);

  const chunk2 = await store.readFile({
    scope: 'global',
    filename: 'emoji.txt',
    startLine: 1,
    endLine: 1,
    byteOffset: chunk1.nextByteOffset,
  });
  assert.equal(chunk2.content, '😂😃');
  assert.equal(chunk2.truncated, false);
  assert.equal(chunk2.nextByteOffset, undefined);

  // maxReadBytes < 4 still advances past a 4-byte UTF-8 character without stalling
  const tinyStore = createFileStore({ dataDir, maxReadBytes: 2 });
  await tinyStore.saveFile({ scope: 'global', filename: 'tiny-emoji.txt', content: '😀a' });
  const tiny1 = await tinyStore.readFile({ scope: 'global', filename: 'tiny-emoji.txt' });
  assert.equal(tiny1.content, '😀');
  assert.equal(tiny1.truncated, true);
  assert.equal(tiny1.nextByteOffset, 4);
  const tiny2 = await tinyStore.readFile({
    scope: 'global',
    filename: 'tiny-emoji.txt',
    byteOffset: tiny1.nextByteOffset,
  });
  assert.equal(tiny2.content, 'a');
  assert.equal(tiny2.truncated, false);
  assert.equal(tiny2.nextByteOffset, undefined);

  // Invalid ranges & base64 slicing rejected
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'lines.txt', startLine: 0 }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'lines.txt', startLine: 3, endLine: 2 }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'lines.txt', startLine: 6 }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'lines.txt', byteOffset: -1 }),
    (err) => err instanceof ValidationError,
  );
  await assert.rejects(
    () => store.readFile({ scope: 'global', filename: 'lines.txt', encoding: 'base64', startLine: 1 }),
    (err) => err instanceof ValidationError,
  );
});
