import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NotFoundError, ValidationError, createStore } from './store.mjs';
import { createFileStore } from './files-store.mjs';
import { openFileInEditor } from './editor.mjs';

const BIND_HOST = '127.0.0.1';
const DEFAULT_STANDALONE_PORT = 4810;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

class PayloadTooLargeError extends Error {
  constructor(message = `Request body exceeds ${MAX_REQUEST_BODY_BYTES} byte limit`) {
    super(message);
    this.name = 'PayloadTooLargeError';
    this.status = 413;
  }
}

const STATIC_ROUTES = [
  { path: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' },
  { path: '/styles.css', file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  { path: '/app.js', file: 'app.js', contentType: 'application/javascript; charset=utf-8' },
  { path: '/helpers.js', file: 'helpers.js', contentType: 'application/javascript; charset=utf-8' },
  { path: '/notes-editor.js', file: 'notes-editor.js', contentType: 'application/javascript; charset=utf-8' },
  { path: '/vendor/cm6-bundle.js', file: 'vendor/cm6-bundle.js', contentType: 'application/javascript; charset=utf-8' },
];

const STANDALONE_PRELOAD_JS = `(() => {
  const THEME_PRESETS = {
    light: {
      '--background': '#f7f7f8',
      '--foreground': '#1d1f21',
      '--card': '#ffffff',
      '--card-border': 'rgba(0, 0, 0, 0.10)',
      '--border': 'rgba(0, 0, 0, 0.08)',
      '--primary': '#007acc',
      '--primary-foreground': '#ffffff',
      '--secondary': '#e6e7e9',
      '--secondary-foreground': '#3d4348',
      '--muted': '#eff0f1',
      '--muted-foreground': '#5d676f',
      '--placeholder': '#9da5ab',
      '--error': '#cb3d3d',
      '--ring': 'rgba(0, 122, 204, 0.70)',
      '--font-family': '"Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      '--editor-font-family': '"Google Sans Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    },
    dark: {
      '--background': '#111318',
      '--foreground': '#e5e7eb',
      '--card': '#181b22',
      '--card-border': 'rgba(255, 255, 255, 0.10)',
      '--border': 'rgba(255, 255, 255, 0.08)',
      '--primary': '#3b9eff',
      '--primary-foreground': '#0b1017',
      '--secondary': '#232732',
      '--secondary-foreground': '#c7ccd4',
      '--muted': '#1c2029',
      '--muted-foreground': '#949ba6',
      '--placeholder': '#69707d',
      '--error': '#ef6461',
      '--ring': 'rgba(59, 158, 255, 0.70)',
      '--font-family': '"Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      '--editor-font-family': '"Google Sans Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    },
  };

  function applyCssVars(vars) {
    if (!vars || typeof vars !== 'object') return;
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (!root || !root.style) return;
    for (const [key, value] of Object.entries(vars)) {
      if (typeof key === 'string' && key.startsWith('--') && typeof value === 'string') {
        root.style.setProperty(key, value);
      }
    }
  }

  function readParams() {
    return new URLSearchParams(window.location.search);
  }

  function readWorkspaces() {
    const params = readParams();
    return [...params.getAll('workspace'), ...params.getAll('workspaceUri')].filter(Boolean);
  }

  const initialTheme = (readParams().get('theme') || '').toLowerCase();
  if (initialTheme === 'dark' || initialTheme === 'light') {
    applyCssVars(THEME_PRESETS[initialTheme]);
  }

  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (data && data.type === 'theme-change' && data.payload && data.payload.cssVariables) {
      applyCssVars(data.payload.cssVariables);
    }
  });

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
    get conversationId() {
      return readParams().get('conversationId') || '';
    },
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

export function createApiRoutes(
  store,
  ResponseCtor,
  fileStore = createFileStore(),
  editorRunner = openFileInEditor,
) {
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
    {
      method: 'GET',
      path: '/api/files',
      handler: async (d) => {
        const listing = await fileStore.listFiles(d.scope, d.workspaceUri);
        const settings = await fileStore.getSettings();
        return { ...listing, settings };
      },
    },
    {
      method: 'POST',
      path: '/api/files/save',
      handler: (d) =>
        fileStore.saveFile({
          scope: d.scope,
          workspaceUri: d.workspaceUri,
          filename: d.filename,
          content: d.content,
          encoding: d.encoding,
        }),
    },
    {
      method: 'POST',
      path: '/api/files/import',
      handler: (d) =>
        fileStore.importFileFromPath({
          scope: d.scope,
          workspaceUri: d.workspaceUri,
          sourcePath: d.sourcePath,
        }),
    },
    {
      method: 'POST',
      path: '/api/files/rename',
      handler: (d) =>
        fileStore.renameFile({
          scope: d.scope,
          workspaceUri: d.workspaceUri,
          filename: d.filename,
          newFilename: d.newFilename,
        }),
    },
    {
      method: 'POST',
      path: '/api/files/delete',
      handler: (d) =>
        fileStore.deleteFile({
          scope: d.scope,
          workspaceUri: d.workspaceUri,
          filename: d.filename,
        }),
    },
    {
      method: 'POST',
      path: '/api/files/open',
      handler: async (d) => {
        if (d.editor !== undefined && typeof d.editor !== 'string') {
          throw new ValidationError('editor must be a string');
        }
        if (d.customCommand !== undefined && typeof d.customCommand !== 'string') {
          throw new ValidationError('customCommand must be a string');
        }

        const filePath = await fileStore.resolveManagedFilePath({
          scope: d.scope,
          workspaceUri: d.workspaceUri,
          filename: d.filename,
        });

        let editor = typeof d.editor === 'string' ? d.editor.trim() : '';
        let customCommand = typeof d.customCommand === 'string' ? d.customCommand : '';

        if (!editor || (editor === 'custom' && !customCommand)) {
          const settings = await fileStore.getSettings();
          if (!editor) {
            editor = settings.defaultEditor;
          }
          if (!customCommand) {
            customCommand = settings.customEditorCommand;
          }
        }

        return editorRunner(filePath, { editor, customCommand });
      },
    },
    {
      method: 'POST',
      path: '/api/settings',
      handler: async (d) => {
        const settings = await fileStore.saveSettings({
          defaultEditor: d.defaultEditor,
          customEditorCommand: d.customEditorCommand,
        });
        return { settings };
      },
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

function readRequestBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    const onData = (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        settled = true;
        cleanup();
        if (typeof req.resume === 'function') {
          req.resume();
        }
        rejectBody(
          new PayloadTooLargeError(
            `Request body exceeds ${maxBytes} byte limit`,
          ),
        );
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBody(Buffer.concat(chunks, totalBytes).toString('utf8'));
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectBody(err);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function startStandaloneServer(store, port, fileStore, editorRunner) {
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
  for (const route of createApiRoutes(store, null, fileStore, editorRunner)) {
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

        let rawBody;
        try {
          rawBody = await readRequestBody(req);
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          throw err;
        }
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
  const fileStore = createFileStore({ dataDir: options.dataDir });
  const editorRunner = options.editorRunner || openFileInEditor;
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

    for (const route of createApiRoutes(store, ResponseCtor, fileStore, editorRunner)) {
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

  return startStandaloneServer(store, port, fileStore, editorRunner);
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
