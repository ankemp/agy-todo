import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError } from '../store.mjs';
import {
  openFileInEditor,
  resolveEditorInvocation,
  splitCommandArgs,
} from '../editor.mjs';

test('1. splitCommandArgs parses quoted and unquoted tokens without shell interpolation', () => {
  assert.deepEqual(splitCommandArgs('subl -n'), ['subl', '-n']);
  assert.deepEqual(
    splitCommandArgs('"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" --wait'),
    ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl', '--wait'],
  );
  assert.deepEqual(
    splitCommandArgs("'/Applications/My Editor/bin/ed' --flag='a b'"),
    ['/Applications/My Editor/bin/ed', '--flag=a b'],
  );
  assert.deepEqual(splitCommandArgs('my\\ editor --wait'), ['my editor', '--wait']);

  for (const bad of ['', '   ', null, undefined, 'subl "unclosed', "subl 'unclosed", 'trailing\\']) {
    assert.throws(
      () => splitCommandArgs(bad),
      (err) => err instanceof ValidationError,
      `Expected ValidationError for: ${JSON.stringify(bad)}`,
    );
  }
});

test('2. resolveEditorInvocation prefers macOS CLI paths and falls back to open -a when missing', () => {
  const filePath = '/tmp/plan.md';

  // CLI binary found in PATH via whichFn
  assert.deepEqual(
    resolveEditorInvocation(filePath, {
      editor: 'code',
      platform: 'darwin',
      whichFn: (bin) => (bin === 'code' ? '/usr/local/bin/code' : null),
      existsFn: () => false,
    }),
    { command: '/usr/local/bin/code', args: [filePath] },
  );

  // CLI binary found in standard macOS app bundle path
  const sublBundle = '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl';
  assert.deepEqual(
    resolveEditorInvocation(filePath, {
      editor: 'subl',
      platform: 'darwin',
      whichFn: () => null,
      existsFn: (p) => p === sublBundle,
    }),
    { command: sublBundle, args: [filePath] },
  );

  // Homebrew path fallback on darwin when whichFn returns null
  assert.deepEqual(
    resolveEditorInvocation(filePath, {
      editor: 'agy',
      platform: 'darwin',
      whichFn: () => null,
      existsFn: (p) => p === '/opt/homebrew/bin/agy',
    }),
    { command: '/opt/homebrew/bin/agy', args: [filePath] },
  );

  // Neither PATH nor bundle CLI exists -> fall back to `open -a` on darwin
  assert.deepEqual(
    resolveEditorInvocation(filePath, {
      editor: 'subl',
      platform: 'darwin',
      whichFn: () => null,
      existsFn: () => false,
    }),
    { command: 'open', args: ['-a', 'Sublime Text', filePath] },
  );
  assert.deepEqual(
    resolveEditorInvocation(filePath, {
      editor: 'code',
      platform: 'darwin',
      whichFn: () => null,
      existsFn: () => false,
    }),
    { command: 'open', args: ['-a', 'Visual Studio Code', filePath] },
  );
  assert.deepEqual(
    resolveEditorInvocation(filePath, {
      editor: 'cursor',
      platform: 'darwin',
      whichFn: () => null,
      existsFn: () => false,
    }),
    { command: 'open', args: ['-a', 'Cursor', filePath] },
  );
  assert.deepEqual(
    resolveEditorInvocation(filePath, {
      editor: 'agy',
      platform: 'darwin',
      whichFn: () => null,
      existsFn: () => false,
    }),
    { command: 'open', args: ['-a', 'Antigravity', filePath] },
  );

  // System default on darwin, linux, win32
  assert.deepEqual(
    resolveEditorInvocation(filePath, { editor: 'system', platform: 'darwin' }),
    { command: 'open', args: [filePath] },
  );
  assert.deepEqual(
    resolveEditorInvocation(filePath, { editor: 'system', platform: 'linux' }),
    { command: 'xdg-open', args: [filePath] },
  );
  assert.deepEqual(
    resolveEditorInvocation(filePath, { editor: 'system', platform: 'win32' }),
    { command: 'cmd', args: ['/c', 'start', '', filePath] },
  );

  // Non-macOS without CLI throws ValidationError
  assert.throws(
    () =>
      resolveEditorInvocation(filePath, {
        editor: 'subl',
        platform: 'linux',
        whichFn: () => null,
        existsFn: () => false,
      }),
    (err) => err instanceof ValidationError,
  );

  // Unsupported editor or missing filePath throws ValidationError
  assert.throws(
    () => resolveEditorInvocation(filePath, { editor: 'vim-unknown' }),
    (err) => err instanceof ValidationError,
  );
  assert.throws(
    () => resolveEditorInvocation('   ', { editor: 'system' }),
    (err) => err instanceof ValidationError,
  );
});

test('3. openFileInEditor spawns resolved command detached without shell and handles spawn errors', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-todo-ed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'notes.md');
  writeFileSync(target, '# hi\n', 'utf8');

  const spawned = [];
  let unrefCalled = false;
  const fakeSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return {
      unref() {
        unrefCalled = true;
      },
      once() {},
      removeListener() {},
    };
  };

  const res = await openFileInEditor(target, {
    editor: 'custom',
    customCommand: '"/usr/local/bin/my editor" --reuse-window',
    spawnFn: fakeSpawn,
  });

  assert.equal(res.ok, true);
  assert.equal(res.editor, 'custom');
  assert.equal(res.command, '/usr/local/bin/my editor');
  assert.deepEqual(res.args, ['--reuse-window', target]);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, '/usr/local/bin/my editor');
  assert.deepEqual(spawned[0].args, ['--reuse-window', target]);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.stdio, 'ignore');
  assert.equal(spawned[0].opts.shell, undefined);
  assert.equal(unrefCalled, true);

  // Immediate ENOENT error on child rejects cleanly
  const failingSpawn = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => {
      const err = new Error('spawn ENOENT');
      err.code = 'ENOENT';
      child.emit('error', err);
    });
    return child;
  };

  await assert.rejects(
    () =>
      openFileInEditor(target, {
        editor: 'custom',
        customCommand: 'nonexistent-editor',
        spawnFn: failingSpawn,
      }),
    (err) => err instanceof ValidationError && /ENOENT|nonexistent-editor/i.test(err.message),
  );
});
