import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startServer } from '../main.mjs';

function makeTempDir(prefix = 'agy-todo-server-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createMockSidecarSdk() {
  class MockResponse {
    constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
      this.body = body;
      this.contentType = contentType;
      this.status = status;
      this.headers = headers;
    }
  }

  class MockSidecarApp {
    #server;
    #pages = new Map();
    #apis = new Map();

    page(path, handler) {
      this.#pages.set(path, handler);
    }

    api(path, handler, method = 'POST') {
      if (!this.#apis.has(path)) {
        this.#apis.set(path, new Map());
      }
      this.#apis.get(path).set(method.toUpperCase(), handler);
    }

    run() {
      this.#pages.set(
        '/preload.js',
        () => 'window.sidecar = { fetch: window.fetch.bind(window), getWorkspaceUris: async () => [], onWorkspaceChange: () => () => {} };',
      );

      const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');

        if (req.method === 'GET' && this.#pages.has(url.pathname)) {
          const content = await this.#pages.get(url.pathname)();
          if (content instanceof MockResponse) {
            res.writeHead(content.status || 200, {
              'Content-Type': content.contentType,
              ...content.headers,
            });
            res.end(content.body);
            return;
          }
          const isJS = url.pathname.endsWith('.js');
          res.writeHead(200, {
            'Content-Type': isJS ? 'application/javascript' : 'text/html',
          });
          res.end(content);
          return;
        }

        if (this.#apis.has(url.pathname)) {
          const methodMap = this.#apis.get(url.pathname);
          if (!methodMap.has(req.method)) {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const handler = methodMap.get(req.method);
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', async () => {
            try {
              const data = {};
              if (req.method === 'GET' || url.searchParams.size > 0) {
                for (const [key, value] of url.searchParams.entries()) {
                  if (key.toLowerCase() !== 'token') {
                    data[key] = value;
                  }
                }
              }
              if (body) {
                Object.assign(data, JSON.parse(body));
              }
              const result = await handler(data);
              if (
                result instanceof MockResponse ||
                (result &&
                  typeof result === 'object' &&
                  result.contentType &&
                  result.body !== undefined)
              ) {
                const status = result.status || 200;
                const respBody =
                  typeof result.body === 'string'
                    ? result.body
                    : Buffer.from(result.body);
                res.writeHead(status, {
                  'Content-Type': result.contentType,
                  ...result.headers,
                });
                res.end(respBody);
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      return new Promise((resolve) => {
        this.#server = server.listen(0, '127.0.0.1', () => {
          resolve(server);
        });
      });
    }

    close() {
      return new Promise((resolve) =>
        this.#server ? this.#server.close(() => resolve()) : resolve(),
      );
    }
  }

  return { SidecarApp: MockSidecarApp, Response: MockResponse };
}

async function fetchJson(baseUrl, path, options) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, headers: res.headers, data };
}

function postJson(baseUrl, path, payload) {
  return fetchJson(baseUrl, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('standalone mode serves static assets and /preload.js with accurate MIME types', async (t) => {
  const root = makeTempDir('agy-todo-static-');
  const dataDir = join(root, 'data');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const handle = await startServer({ port: 0, dataDir });
  t.after(() => handle.close());

  assert.equal(handle.mode, 'standalone');
  assert.ok(handle.port > 0);
  const baseUrl = `http://127.0.0.1:${handle.port}`;

  const cases = [
    { path: '/', contentType: 'text/html', snippet: '<title>AGY Todo</title>' },
    { path: '/styles.css', contentType: 'text/css', snippet: '.app-shell' },
    { path: '/app.js', contentType: 'application/javascript', snippet: '/api/scratchpad' },
    { path: '/helpers.mjs', contentType: 'application/javascript', snippet: 'createNotesAutosaver' },
    { path: '/preload.js', contentType: 'application/javascript', snippet: 'window.sidecar' },
  ];

  for (const c of cases) {
    const res = await fetch(`${baseUrl}${c.path}`);
    assert.equal(res.status, 200, `Expected 200 for ${c.path}`);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes(c.contentType), `Expected ${c.contentType} for ${c.path}, got ${ct}`);
    const body = await res.text();
    assert.ok(body.includes(c.snippet), `Expected ${c.path} body to include ${c.snippet}`);
  }
});

test('standalone mode supports full scratchpad CRUD lifecycle and error status mapping', async (t) => {
  const root = makeTempDir('agy-todo-api-');
  const workspaceDir = join(root, 'my-project');
  const dataDir = join(root, 'data');
  mkdirSync(workspaceDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspaceUri = pathToFileURL(workspaceDir).href;
  const handle = await startServer({ port: 0, dataDir });
  t.after(() => handle.close());
  const baseUrl = `http://127.0.0.1:${handle.port}`;

  // Initial GET
  const initial = await fetchJson(
    baseUrl,
    `/api/scratchpad?workspaceUri=${encodeURIComponent(workspaceUri)}`,
  );
  assert.equal(initial.status, 200);
  assert.equal(initial.data.displayName, 'my-project');
  assert.deepEqual(initial.data.links, []);
  assert.deepEqual(initial.data.todos, []);
  assert.equal(initial.data.notes, '');

  // Add link (auto-prefix http:// for localhost)
  const linkRes = await postJson(baseUrl, '/api/links/add', {
    workspaceUri,
    label: 'Local API',
    url: 'localhost:4800/health',
  });
  assert.equal(linkRes.status, 200);
  assert.equal(linkRes.data.links.length, 1);
  assert.equal(linkRes.data.links[0].url, 'http://localhost:4800/health');
  const linkId = linkRes.data.links[0].id;

  // Add two todos
  const t1 = await postJson(baseUrl, '/api/todos/add', { workspaceUri, text: 'First task' });
  assert.equal(t1.status, 200);
  const t2 = await postJson(baseUrl, '/api/todos/add', { workspaceUri, text: 'Second task' });
  assert.equal(t2.status, 200);
  assert.equal(t2.data.todos.length, 2);
  const id1 = t2.data.todos[0].id;
  const id2 = t2.data.todos[1].id;

  // Toggle first todo
  const toggled = await postJson(baseUrl, '/api/todos/toggle', {
    workspaceUri,
    id: id1,
    done: true,
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.todos[0].done, true);

  // Update second todo
  const updated = await postJson(baseUrl, '/api/todos/update', {
    workspaceUri,
    id: id2,
    text: 'Second task edited',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.todos[1].text, 'Second task edited');

  // Clear done
  const cleared = await postJson(baseUrl, '/api/todos/clear-done', { workspaceUri });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.todos.length, 1);
  assert.equal(cleared.data.todos[0].id, id2);

  // Delete remaining todo
  const deletedTodo = await postJson(baseUrl, '/api/todos/delete', {
    workspaceUri,
    id: id2,
  });
  assert.equal(deletedTodo.status, 200);
  assert.equal(deletedTodo.data.todos.length, 0);

  // Delete link
  const deletedLink = await postJson(baseUrl, '/api/links/delete', {
    workspaceUri,
    id: linkId,
  });
  assert.equal(deletedLink.status, 200);
  assert.equal(deletedLink.data.links.length, 0);

  // Save notes & re-read
  const savedNotes = await postJson(baseUrl, '/api/notes', {
    workspaceUri,
    notes: 'Check Redis TLS before deploy',
  });
  assert.equal(savedNotes.status, 200);
  assert.equal(savedNotes.data.notes, 'Check Redis TLS before deploy');

  const reloaded = await fetchJson(
    baseUrl,
    `/api/scratchpad?workspaceUri=${encodeURIComponent(workspaceUri)}`,
  );
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.data.notes, 'Check Redis TLS before deploy');

  // Error mappings: 400 and 404
  const badUrl = await postJson(baseUrl, '/api/links/add', {
    workspaceUri,
    label: 'XSS',
    url: 'javascript:alert(1)',
  });
  assert.equal(badUrl.status, 400);
  assert.ok(badUrl.data?.error);

  const missingWorkspace = await fetchJson(baseUrl, '/api/scratchpad');
  assert.equal(missingWorkspace.status, 400);
  assert.ok(missingWorkspace.data?.error);

  const missingTodo = await postJson(baseUrl, '/api/todos/toggle', {
    workspaceUri,
    id: 'tod_does_not_exist',
  });
  assert.equal(missingTodo.status, 404);
  assert.ok(missingTodo.data?.error);
});

test('SidecarApp mode serves MIME types, persists scratchpad, and maps 400/404 errors', async (t) => {
  const root = makeTempDir('agy-todo-sdk-');
  const workspaceDir = join(root, 'sdk-project');
  const dataDir = join(root, 'data');
  mkdirSync(workspaceDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspaceUri = pathToFileURL(workspaceDir).href;
  const mockSdk = createMockSidecarSdk();
  const handle = await startServer({
    dataDir,
    sidecarSdk: mockSdk,
    forceSidecarSdk: true,
  });
  t.after(() => handle.close());

  assert.equal(handle.mode, 'sidecar_sdk');
  assert.ok(handle.port > 0);
  const baseUrl = `http://127.0.0.1:${handle.port}`;

  // Static MIME types including styles.css via Response
  const htmlRes = await fetch(`${baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  assert.ok((htmlRes.headers.get('content-type') || '').includes('text/html'));

  const cssRes = await fetch(`${baseUrl}/styles.css`);
  assert.equal(cssRes.status, 200);
  assert.ok((cssRes.headers.get('content-type') || '').includes('text/css'));

  const jsRes = await fetch(`${baseUrl}/app.js`);
  assert.equal(jsRes.status, 200);
  assert.ok((jsRes.headers.get('content-type') || '').includes('application/javascript'));

  const helpersRes = await fetch(`${baseUrl}/helpers.mjs`);
  assert.equal(helpersRes.status, 200);
  assert.ok((helpersRes.headers.get('content-type') || '').includes('application/javascript'));

  // CRUD smoke test in SidecarApp mode
  const addRes = await postJson(baseUrl, '/api/todos/add', {
    workspaceUri,
    text: 'Via SidecarApp',
  });
  assert.equal(addRes.status, 200);
  assert.equal(addRes.data.todos[0].text, 'Via SidecarApp');

  const getRes = await fetchJson(
    baseUrl,
    `/api/scratchpad?workspaceUri=${encodeURIComponent(workspaceUri)}`,
  );
  assert.equal(getRes.status, 200);
  assert.equal(getRes.data.todos.length, 1);

  // Error mappings in SidecarApp mode
  const badUrl = await postJson(baseUrl, '/api/links/add', {
    workspaceUri,
    label: 'Bad',
    url: 'javascript:alert(1)',
  });
  assert.equal(badUrl.status, 400);
  assert.ok(badUrl.data?.error);

  const missingWorkspace = await fetchJson(baseUrl, '/api/scratchpad');
  assert.equal(missingWorkspace.status, 400);
  assert.ok(missingWorkspace.data?.error);

  const missingTodo = await postJson(baseUrl, '/api/todos/toggle', {
    workspaceUri,
    id: 'tod_missing',
  });
  assert.equal(missingTodo.status, 404);
  assert.ok(missingTodo.data?.error);
});
