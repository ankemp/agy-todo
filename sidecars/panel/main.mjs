import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NotFoundError, ValidationError, createStore } from './store.mjs';

const BIND_HOST = '127.0.0.1';
const DEFAULT_STANDALONE_PORT = 4810;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const STATIC_ROUTES = [
  { path: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' },
  { path: '/styles.css', file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  { path: '/app.js', file: 'app.js', contentType: 'application/javascript; charset=utf-8' },
  { path: '/helpers.js', file: 'helpers.js', contentType: 'application/javascript; charset=utf-8' },
];

const STANDALONE_PRELOAD_JS = `(() => {
  function readWorkspaces() {
    const params = new URLSearchParams(window.location.search);
    return [...params.getAll('workspace'), ...params.getAll('workspaceUri')].filter(Boolean);
  }
  const listeners = new Set();
  window.addEventListener('popstate', () => {
    const uris = readWorkspaces();
    for (const listener of listeners) {
      try {
        listener([...uris]);
      } catch (err) {
        console.error('workspace-change listener failed:', err);
      }
    }
  });
  window.sidecar = {
    fetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (options.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      return window.fetch(url, { ...options, headers });
    },
    async getWorkspaceUris() {
      return readWorkspaces();
    },
    onWorkspaceChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
`;

function readPublicAsset(filename) {
  return readFileSync(join(PUBLIC_DIR, filename), 'utf8');
}

function buildResponse(ResponseCtor, status, contentType, body) {
  if (typeof ResponseCtor === 'function') {
    return new ResponseCtor(body, { status, contentType });
  }
  return { status, contentType, body };
}

function jsonResponse(ResponseCtor, status, payload) {
  return buildResponse(
    ResponseCtor,
    status,
    'application/json',
    JSON.stringify(payload),
  );
}

function wrapApiHandler(ResponseCtor, handler) {
  return async (data) => {
    try {
      const payload = data && typeof data === 'object' ? data : {};
      const result = await handler(payload);
      return jsonResponse(ResponseCtor, 200, result);
    } catch (err) {
      if (err instanceof ValidationError) {
        return jsonResponse(ResponseCtor, 400, { error: err.message });
      }
      if (err instanceof NotFoundError) {
        return jsonResponse(ResponseCtor, 404, { error: err.message });
      }
      return jsonResponse(ResponseCtor, 500, {
        error: err?.message || 'Internal Server Error',
      });
    }
  };
}

function createApiRoutes(store, ResponseCtor) {
  const specs = [
    {
      method: 'GET',
      path: '/api/scratchpad',
      handler: (d) => store.getScratchpad(d.workspaceUri),
    },
    {
      method: 'POST',
      path: '/api/notes',
      handler: (d) => store.saveNotes(d.workspaceUri, d.notes),
    },
    {
      method: 'POST',
      path: '/api/todos/add',
      handler: (d) => store.addTodo(d.workspaceUri, d.text),
    },
    {
      method: 'POST',
      path: '/api/todos/toggle',
      handler: (d) => store.toggleTodo(d.workspaceUri, d.id, d.done),
    },
    {
      method: 'POST',
      path: '/api/todos/update',
      handler: (d) => store.updateTodo(d.workspaceUri, d.id, d.text),
    },
    {
      method: 'POST',
      path: '/api/todos/delete',
      handler: (d) => store.deleteTodo(d.workspaceUri, d.id),
    },
    {
      method: 'POST',
      path: '/api/todos/clear-done',
      handler: (d) => store.clearDoneTodos(d.workspaceUri),
    },
    {
      method: 'POST',
      path: '/api/links/add',
      handler: (d) => store.addLink(d.workspaceUri, d.label, d.url),
    },
    {
      method: 'POST',
      path: '/api/links/delete',
      handler: (d) => store.deleteLink(d.workspaceUri, d.id),
    },
  ];

  return specs.map((spec) => ({
    method: spec.method,
    path: spec.path,
    handler: wrapApiHandler(ResponseCtor, spec.handler),
  }));
}

async function loadSidecarSdk(explicitSdk) {
  if (explicitSdk !== undefined) {
    return explicitSdk;
  }
  try {
    return await import('sidecar_sdk');
  } catch {
    return null;
  }
}

function hasSidecarEnv() {
  return Boolean(
    process.env.ANTIGRAVITY_LS_ADDRESS &&
      process.env.ANTIGRAVITY_CSRF_TOKEN &&
      process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
  );
}

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolveBody(body));
    req.on('error', rejectBody);
  });
}

function startStandaloneServer(store, port) {
  const staticHandlers = new Map();
  for (const route of STATIC_ROUTES) {
    staticHandlers.set(route.path, () =>
      buildResponse(null, 200, route.contentType, readPublicAsset(route.file)),
    );
  }
  staticHandlers.set('/preload.js', () =>
    buildResponse(
      null,
      200,
      'application/javascript; charset=utf-8',
      STANDALONE_PRELOAD_JS,
    ),
  );

  const apiHandlers = new Map();
  for (const route of createApiRoutes(store, null)) {
    if (!apiHandlers.has(route.path)) {
      apiHandlers.set(route.path, new Map());
    }
    apiHandlers.get(route.path).set(route.method, route.handler);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${BIND_HOST}`);

      if (req.method === 'GET' && staticHandlers.has(url.pathname)) {
        const result = staticHandlers.get(url.pathname)();
        res.writeHead(result.status, { 'Content-Type': result.contentType });
        res.end(result.body);
        return;
      }

      if (apiHandlers.has(url.pathname)) {
        const methodMap = apiHandlers.get(url.pathname);
        if (!methodMap.has(req.method)) {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }

        const data = {};
        if (req.method === 'GET' || url.searchParams.size > 0) {
          for (const [key, value] of url.searchParams.entries()) {
            if (key.toLowerCase() !== 'token') {
              data[key] = value;
            }
          }
        }

        const rawBody = await readRequestBody(req);
        if (rawBody.trim() !== '') {
          let parsed;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body must be a JSON object' }));
            return;
          }
          Object.assign(data, parsed);
        }

        const result = await methodMap.get(req.method)(data);
        res.writeHead(result.status, { 'Content-Type': result.contentType });
        res.end(result.body);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
    }
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(port, BIND_HOST, () => {
      server.off('error', rejectServer);
      const addr = server.address();
      resolveServer({
        mode: 'standalone',
        port: addr && typeof addr === 'object' ? addr.port : port,
        server,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/**
 * Start the agy-todo panel server in SidecarApp mode (inside Antigravity) or
 * standalone loopback HTTP mode (local development and tests).
 */
export async function startServer(options = {}) {
  const store = createStore({ dataDir: options.dataDir });
  const sidecarSdk = await loadSidecarSdk(options.sidecarSdk);
  const useSidecarSdk = Boolean(
    sidecarSdk?.SidecarApp && (options.forceSidecarSdk || hasSidecarEnv()),
  );

  if (useSidecarSdk) {
    const ResponseCtor = sidecarSdk.Response;
    const app = new sidecarSdk.SidecarApp();

    for (const route of STATIC_ROUTES) {
      app.page(route.path, () =>
        buildResponse(
          ResponseCtor,
          200,
          route.contentType,
          readPublicAsset(route.file),
        ),
      );
    }

    for (const route of createApiRoutes(store, ResponseCtor)) {
      app.api(route.path, route.handler, route.method);
    }

    const server = await app.run();
    const addr = server?.address?.();
    const port =
      addr && typeof addr === 'object'
        ? addr.port
        : Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);

    return {
      mode: 'sidecar_sdk',
      port,
      server,
      close: () => app.close(),
    };
  }

  const port =
    options.port ??
    (process.env.PORT !== undefined && process.env.PORT !== ''
      ? Number(process.env.PORT)
      : DEFAULT_STANDALONE_PORT);

  return startStandaloneServer(store, port);
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  }
}

if (isDirectExecution()) {
  startServer()
    .then(({ mode, port }) => {
      if (mode === 'standalone') {
        console.log(
          `[agy-todo] standalone server listening on http://${BIND_HOST}:${port}`,
        );
      }
    })
    .catch((err) => {
      console.error('[agy-todo] failed to start sidecar:', err);
      process.exit(1);
    });
}
