import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_PATH = fileURLToPath(new URL('../../../mcp/server.mjs', import.meta.url));

function makeTempDir(prefix = 'agy-todo-mcp-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createMcpClient(t, { dataDir, extraArgs = [], env = {} } = {}) {
  const spawnEnv = { ...process.env };
  if (dataDir !== undefined) {
    spawnEnv.AGY_TODO_DATA_DIR = dataDir;
  }
  Object.assign(spawnEnv, env);

  const child = spawn(process.execPath, [SERVER_PATH, ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv,
  });

  const stdoutLines = [];
  const stderrChunks = [];
  const pending = new Map();
  const anyResponses = [];
  let stdoutBuffer = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let idx = stdoutBuffer.indexOf('\n');
    while (idx !== -1) {
      const rawLine = stdoutBuffer.slice(0, idx).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (rawLine.length > 0) {
        stdoutLines.push(rawLine);
        const msg = JSON.parse(rawLine);
        if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        } else {
          anyResponses.push(msg);
        }
      }
      idx = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);
  });

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  t.after(async () => {
    for (const { reject } of pending.values()) {
      reject(new Error('MCP client closed before response arrived'));
    }
    pending.clear();
    if (!child.killed && child.exitCode === null) {
      child.stdin.end();
      const settled = await Promise.race([
        exitPromise.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 1000)),
      ]);
      if (!settled) {
        child.kill('SIGTERM');
        await exitPromise;
      }
    }
  });

  function sendRaw(line) {
    child.stdin.write(`${line}\n`);
  }

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      payload.params = params;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${method} (id=${id}). stderr=${stderrChunks.join('')}`));
      }, 5000);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      sendRaw(JSON.stringify(payload));
    });
  }

  function notify(method, params) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      payload.params = params;
    }
    sendRaw(JSON.stringify(payload));
  }

  async function waitForNullIdResponse() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const idx = anyResponses.findIndex((m) => m.id === null);
      if (idx !== -1) {
        return anyResponses.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out waiting for null-id parse error response. stderr=${stderrChunks.join('')}`);
  }

  function assertAllStdoutLinesValidJson() {
    assert.ok(stdoutLines.length > 0, 'Expected at least one stdout JSON-RPC line');
    for (const line of stdoutLines) {
      assert.doesNotThrow(() => JSON.parse(line), `Invalid JSON on stdout: ${line}`);
    }
  }

  return {
    request,
    notify,
    sendRaw,
    waitForNullIdResponse,
    assertAllStdoutLinesValidJson,
    stdoutLines,
    stderrChunks,
  };
}

function parseToolResult(rpcResponse) {
  assert.equal(rpcResponse.error, undefined, `Unexpected JSON-RPC error: ${JSON.stringify(rpcResponse.error)}`);
  assert.ok(rpcResponse.result, 'Expected JSON-RPC result');
  assert.ok(Array.isArray(rpcResponse.result.content), 'Expected result.content array');
  assert.equal(rpcResponse.result.content[0]?.type, 'text');
  return {
    isError: Boolean(rpcResponse.result.isError),
    text: rpcResponse.result.content[0].text,
    data: JSON.parse(rpcResponse.result.content[0].text),
  };
}

test('MCP server handles initialize, ping, tools/list, files, scratchpad, and error cases over stdio', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const projectDir = join(root, 'project-repo');
  mkdirSync(projectDir, { recursive: true });
  const workspaceUri = pathToFileURL(projectDir).href;

  const client = createMcpClient(t, { dataDir });

  // 1. initialize + notifications/initialized + ping
  const initResp = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  assert.equal(initResp.jsonrpc, '2.0');
  assert.equal(initResp.result.protocolVersion, '2024-11-05');
  assert.equal(initResp.result.serverInfo.name, 'agy-todo');
  assert.ok(initResp.result.capabilities?.tools);

  client.notify('notifications/initialized');

  const pingResp = await client.request('ping');
  assert.deepEqual(pingResp.result, {});

  // 2. tools/list returns all 8 tools with schemas
  const listToolsResp = await client.request('tools/list');
  const toolNames = listToolsResp.result.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    'save_file',
    'list_files',
    'read_file',
    'get_scratchpad',
    'add_todo',
    'toggle_todo',
    'append_notes',
    'add_link',
  ]);
  for (const tool of listToolsResp.result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema?.type, 'object');
  }

  // 3. save_file defaults extensionless non-dotfiles to .md, auto-renames, supports overwrite, keeps projectDir clean
  const save1 = parseToolResult(
    await client.request('tools/call', {
      name: 'save_file',
      arguments: {
        filename: 'architecture-notes',
        content: '# Architecture\nInitial draft\n',
        workspaceUri,
      },
    }),
  );
  assert.equal(save1.isError, false);
  assert.equal(save1.data.scope, 'project');
  assert.equal(save1.data.savedFile.name, 'architecture-notes.md');
  assert.equal(save1.data.renamed, false);
  assert.equal(save1.data.overwritten, false);
  assert.deepEqual(readdirSync(projectDir), []);
  assert.equal(existsSync(save1.data.savedFile.path), true);

  const save2 = parseToolResult(
    await client.request('tools/call', {
      name: 'save_file',
      arguments: {
        filename: 'architecture-notes',
        content: '# Architecture\nSecond file\n',
        workspaceUri,
      },
    }),
  );
  assert.equal(save2.isError, false);
  assert.equal(save2.data.savedFile.name, 'architecture-notes-2.md');
  assert.equal(save2.data.renamed, true);
  assert.equal(save2.data.overwritten, false);

  const save3 = parseToolResult(
    await client.request('tools/call', {
      name: 'save_file',
      arguments: {
        filename: 'architecture-notes',
        content: '# Architecture\nOverwritten v3\n',
        workspaceUri,
        overwrite: true,
      },
    }),
  );
  assert.equal(save3.isError, false);
  assert.equal(save3.data.savedFile.name, 'architecture-notes.md');
  assert.equal(save3.data.renamed, false);
  assert.equal(save3.data.overwritten, true);

  // 4. list_files & read_file in project and global scopes
  const listedProject = parseToolResult(
    await client.request('tools/call', {
      name: 'list_files',
      arguments: { scope: 'project', workspaceUri },
    }),
  );
  assert.equal(listedProject.isError, false);
  assert.deepEqual(
    listedProject.data.files.map((f) => f.name).sort(),
    ['architecture-notes-2.md', 'architecture-notes.md'],
  );

  const readProject = parseToolResult(
    await client.request('tools/call', {
      name: 'read_file',
      arguments: { filename: 'architecture-notes.md', scope: 'project', workspaceUri },
    }),
  );
  assert.equal(readProject.isError, false);
  assert.equal(readProject.data.content, '# Architecture\nOverwritten v3\n');
  assert.equal(readProject.data.encoding, 'utf8');

  // global scope works without workspaceUri
  const saveGlobal = parseToolResult(
    await client.request('tools/call', {
      name: 'save_file',
      arguments: {
        filename: 'global-memo',
        content: 'Shared across workspaces',
        scope: 'global',
      },
    }),
  );
  assert.equal(saveGlobal.isError, false);
  assert.equal(saveGlobal.data.scope, 'global');
  assert.equal(saveGlobal.data.savedFile.name, 'global-memo.md');

  const listedGlobal = parseToolResult(
    await client.request('tools/call', {
      name: 'list_files',
      arguments: { scope: 'global' },
    }),
  );
  assert.equal(listedGlobal.data.files.length, 1);
  assert.equal(listedGlobal.data.files[0].name, 'global-memo.md');

  const readGlobal = parseToolResult(
    await client.request('tools/call', {
      name: 'read_file',
      arguments: { filename: 'global-memo.md', scope: 'global' },
    }),
  );
  assert.equal(readGlobal.data.content, 'Shared across workspaces');

  // Dotfile and explicit extension are not given an extra .md suffix, and base64 round-trips
  const rawBytes = Buffer.from([0x00, 0x7f, 0xff, 0x42]);
  const dotSave = parseToolResult(
    await client.request('tools/call', {
      name: 'save_file',
      arguments: {
        filename: '.env',
        content: 'KEY=VALUE\n',
        scope: 'global',
      },
    }),
  );
  assert.equal(dotSave.data.savedFile.name, '.env');

  const binSave = parseToolResult(
    await client.request('tools/call', {
      name: 'save_file',
      arguments: {
        filename: 'blob.bin',
        content: rawBytes.toString('base64'),
        encoding: 'base64',
        scope: 'global',
      },
    }),
  );
  assert.equal(binSave.data.savedFile.name, 'blob.bin');

  const binRead = parseToolResult(
    await client.request('tools/call', {
      name: 'read_file',
      arguments: {
        filename: 'blob.bin',
        encoding: 'base64',
        scope: 'global',
      },
    }),
  );
  assert.equal(binRead.data.encoding, 'base64');
  assert.equal(binRead.data.content, rawBytes.toString('base64'));

  // 5. scratchpad tools: add_todo, toggle_todo, append_notes, add_link, get_scratchpad
  const addedTodo = parseToolResult(
    await client.request('tools/call', {
      name: 'add_todo',
      arguments: { workspaceUri, text: 'Ship MCP server' },
    }),
  );
  assert.equal(addedTodo.isError, false);
  assert.equal(addedTodo.data.todos.length, 1);
  const todoId = addedTodo.data.todos[0].id;
  assert.equal(addedTodo.data.todos[0].done, false);

  const toggledTodo = parseToolResult(
    await client.request('tools/call', {
      name: 'toggle_todo',
      arguments: { workspaceUri, id: todoId, done: true },
    }),
  );
  assert.equal(toggledTodo.isError, false);
  assert.equal(toggledTodo.data.todos[0].done, true);

  const notes1 = parseToolResult(
    await client.request('tools/call', {
      name: 'append_notes',
      arguments: { workspaceUri, text: 'First paragraph' },
    }),
  );
  assert.equal(notes1.data.notes, 'First paragraph');

  const notes2 = parseToolResult(
    await client.request('tools/call', {
      name: 'append_notes',
      arguments: { workspaceUri, text: 'Second paragraph', mode: 'append' },
    }),
  );
  assert.equal(notes2.data.notes, 'First paragraph\n\nSecond paragraph');

  const notes3 = parseToolResult(
    await client.request('tools/call', {
      name: 'append_notes',
      arguments: { workspaceUri, text: 'Replaced notes', mode: 'replace' },
    }),
  );
  assert.equal(notes3.data.notes, 'Replaced notes');

  const linked = parseToolResult(
    await client.request('tools/call', {
      name: 'add_link',
      arguments: { workspaceUri, label: 'Docs', url: 'https://example.com/docs' },
    }),
  );
  assert.equal(linked.data.links.length, 1);
  assert.equal(linked.data.links[0].label, 'Docs');
  assert.equal(linked.data.links[0].url, 'https://example.com/docs');

  const linkedDefaultLabel = parseToolResult(
    await client.request('tools/call', {
      name: 'add_link',
      arguments: { workspaceUri, url: 'https://docs.example.org/guide' },
    }),
  );
  assert.equal(linkedDefaultLabel.data.links.length, 2);
  assert.equal(linkedDefaultLabel.data.links[1].label, 'docs.example.org');

  const pad = parseToolResult(
    await client.request('tools/call', {
      name: 'get_scratchpad',
      arguments: { workspaceUri },
    }),
  );
  assert.equal(pad.data.todos.length, 1);
  assert.equal(pad.data.todos[0].done, true);
  assert.equal(pad.data.notes, 'Replaced notes');
  assert.equal(pad.data.links.length, 2);

  // 6. Error handling: missing workspaceUri on project scope, invalid append_notes args, missing file, unknown tool, invalid JSON -32700 + survival
  const missingWsResp = await client.request('tools/call', {
    name: 'save_file',
    arguments: { filename: 'orphan.md', content: 'oops', scope: 'project' },
  });
  assert.equal(missingWsResp.result.isError, true);

  const badModeResp = await client.request('tools/call', {
    name: 'append_notes',
    arguments: { workspaceUri, text: 'hello', mode: 'prepend' },
  });
  assert.equal(badModeResp.result.isError, true);

  const badTextResp = await client.request('tools/call', {
    name: 'append_notes',
    arguments: { workspaceUri, text: 42 },
  });
  assert.equal(badTextResp.result.isError, true);

  const missingFileResp = await client.request('tools/call', {
    name: 'read_file',
    arguments: { filename: 'does-not-exist.md', scope: 'global' },
  });
  assert.equal(missingFileResp.result.isError, true);

  const unknownToolResp = await client.request('tools/call', {
    name: 'nonexistent_tool',
    arguments: {},
  });
  assert.equal(unknownToolResp.result.isError, true);

  client.sendRaw('{not valid json');
  const parseErrResp = await client.waitForNullIdResponse();
  assert.equal(parseErrResp.jsonrpc, '2.0');
  assert.equal(parseErrResp.id, null);
  assert.equal(parseErrResp.error?.code, -32700);

  // Server remains alive after parse error
  const pingAfterErr = await client.request('ping');
  assert.deepEqual(pingAfterErr.result, {});

  client.assertAllStdoutLinesValidJson();
});

test('MCP server supports --data-dir CLI argument', async (t) => {
  const root = makeTempDir('agy-todo-mcp-cli-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliDataDir = join(root, 'cli-data');

  const client = createMcpClient(t, { extraArgs: ['--data-dir', cliDataDir], env: { AGY_TODO_DATA_DIR: '' } });

  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });

  const saved = parseToolResult(
    await client.request('tools/call', {
      name: 'save_file',
      arguments: { filename: 'cli-flag.md', content: 'from --data-dir', scope: 'global' },
    }),
  );
  assert.equal(saved.isError, false);
  assert.ok(saved.data.savedFile.path.startsWith(cliDataDir));
  assert.equal(existsSync(saved.data.savedFile.path), true);
  client.assertAllStdoutLinesValidJson();
});
