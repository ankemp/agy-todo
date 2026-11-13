import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
  }
}

function safeRealpath(targetPath) {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function isLocalHostname(host) {
  const lower = host.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]';
}

function extractSchemelessHost(authorityAndPath) {
  const authority = authorityAndPath.split(/[/?#]/, 1)[0];
  if (!authority || authority.includes('@')) {
    return '';
  }
  if (authority.startsWith('[')) {
    const closeIdx = authority.indexOf(']');
    return closeIdx === -1 ? '' : authority.slice(0, closeIdx + 1);
  }
  return authority.split(':', 1)[0];
}

/**
 * Validate and normalize a link URL to an http: or https: URL string.
 * Auto-prefixes http:// for localhost/127.0.0.1 and https:// for other schemeless hosts.
 */
export function normalizeLinkUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new ValidationError('Link URL must be a string');
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\r\n\t\u0000-\u001f\u007f]/.test(trimmed) || trimmed.startsWith('/')) {
    throw new ValidationError('Link URL is invalid or empty');
  }

  let candidate;
  if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed;
  } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) {
    throw new ValidationError('Only http and https URLs are allowed');
  } else {
    const colonMatch = /^([a-zA-Z][a-zA-Z\d+.-]*):(.*)$/.exec(trimmed);
    if (colonMatch) {
      const prefix = colonMatch[1].toLowerCase();
      const rest = colonMatch[2];
      const isHostPort =
        (prefix === 'localhost' || prefix.includes('.')) &&
        /^\d{1,5}(?:[/?#]|$)/.test(rest);
      if (!isHostPort) {
        throw new ValidationError('Only http and https URLs are allowed');
      }
      candidate = `${prefix === 'localhost' ? 'http' : 'https'}://${trimmed}`;
    } else {
      const host = extractSchemelessHost(trimmed);
      if (!host) {
        throw new ValidationError('Link URL must include a valid host');
      }
      const scheme = isLocalHostname(host) ? 'http' : 'https';
      candidate = `${scheme}://${trimmed}`;
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ValidationError('Link URL is invalid');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only http and https URLs are allowed');
  }
  if (!parsed.hostname) {
    throw new ValidationError('Link URL must include a host');
  }

  return parsed.toString();
}

/**
 * Resolve a workspace URI or filesystem path to a canonical repository key.
 * Linked Git worktrees resolve to the shared main repository root.
 */
export function resolveProject(workspaceInput) {
  if (typeof workspaceInput !== 'string' || workspaceInput.trim() === '') {
    throw new ValidationError('Workspace path or URI is required');
  }

  const raw = workspaceInput.trim();
  let fsPath;

  if (/^file:/i.test(raw)) {
    try {
      fsPath = fileURLToPath(raw);
    } catch {
      throw new ValidationError('Invalid file:// workspace URI');
    }
  } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new ValidationError('Unsupported workspace URI scheme');
  } else {
    fsPath = raw;
  }

  let dir = safeRealpath(fsPath);
  try {
    if (existsSync(dir) && statSync(dir).isFile()) {
      dir = dirname(dir);
    }
  } catch {
    // Keep resolved path if stat fails.
  }

  let canonicalPath = dir;
  try {
    const gitOut = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lines = gitOut.replace(/\r?\n$/, '').split(/\r?\n/);
    const showToplevel = lines[0];
    const gitCommonDir = lines[1];
    if (showToplevel && gitCommonDir) {
      const absToplevel = resolve(dir, showToplevel);
      const absCommonDir = resolve(dir, gitCommonDir);
      const repoRoot =
        basename(absCommonDir) === '.git' ? dirname(absCommonDir) : absToplevel;
      canonicalPath = safeRealpath(repoRoot);
    }
  } catch {
    // Not a git repository (or directory does not exist yet); keep dir.
  }

  const projectKey = createHash('sha256')
    .update(canonicalPath)
    .digest('hex')
    .slice(0, 16);
  const displayName = basename(canonicalPath) || canonicalPath;

  return { projectKey, canonicalPath, displayName };
}

function defaultDataDir() {
  return join(
    homedir(),
    '.gemini',
    'antigravity',
    'sidecar_data',
    'agy-todo',
    'panel',
    'data',
  );
}

function emptyScratchpad(project) {
  return {
    version: 1,
    projectKey: project.projectKey,
    canonicalPath: project.canonicalPath,
    displayName: project.displayName,
    updatedAt: null,
    links: [],
    todos: [],
    notes: '',
  };
}

function normalizeScratchpad(raw, project) {
  return {
    version: 1,
    projectKey: project.projectKey,
    canonicalPath: project.canonicalPath,
    displayName: project.displayName,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    links: Array.isArray(raw.links) ? raw.links : [],
    todos: Array.isArray(raw.todos) ? raw.todos : [],
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function quarantineCorruptFile(filePath, baseName) {
  const dir = dirname(filePath);
  const ts = Date.now();
  let target = join(dir, `${baseName}.corrupt.${ts}.json`);
  if (existsSync(target)) {
    target = join(dir, `${baseName}.corrupt.${ts}.${randomUUID().slice(0, 8)}.json`);
  }
  renameSync(filePath, target);
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${fieldName} is required`);
  }
  return value.trim();
}

/**
 * Create an atomic, per-project serialized JSON scratchpad store.
 */
export function createStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.AGY_TODO_DATA_DIR ||
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    defaultDataDir();

  const projectsDir = join(dataDir, 'projects');
  const indexFile = join(dataDir, 'index.json');
  const projectQueues = new Map();
  let indexQueue = Promise.resolve();

  function projectFilePath(projectKey) {
    return join(projectsDir, `${projectKey}.json`);
  }

  function enqueueProject(projectKey, task) {
    const prev = projectQueues.get(projectKey) ?? Promise.resolve();
    const next = prev.then(task);
    const tail = next.catch(() => {}).finally(() => {
      if (projectQueues.get(projectKey) === tail) {
        projectQueues.delete(projectKey);
      }
    });
    projectQueues.set(projectKey, tail);
    return next;
  }

  function enqueueIndexUpdate(project, updatedAt) {
    const run = indexQueue.then(() => {
      let indexData = {};
      if (existsSync(indexFile)) {
        try {
          const parsed = JSON.parse(readFileSync(indexFile, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            indexData = parsed;
          } else {
            quarantineCorruptFile(indexFile, 'index');
          }
        } catch {
          quarantineCorruptFile(indexFile, 'index');
        }
      }
      indexData[project.projectKey] = {
        canonicalPath: project.canonicalPath,
        displayName: project.displayName,
        updatedAt,
      };
      writeJsonAtomic(indexFile, indexData);
    });
    indexQueue = run.catch(() => {});
    return run;
  }

  function loadProjectScratchpad(project) {
    const filePath = projectFilePath(project.projectKey);
    if (!existsSync(filePath)) {
      return emptyScratchpad(project);
    }

    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyntaxError('Scratchpad JSON root must be an object');
      }
      return normalizeScratchpad(parsed, project);
    } catch {
      quarantineCorruptFile(filePath, project.projectKey);
      return emptyScratchpad(project);
    }
  }

  async function mutateProject(workspaceUri, mutator) {
    const project = resolveProject(workspaceUri);
    return enqueueProject(project.projectKey, async () => {
      const pad = loadProjectScratchpad(project);
      mutator(pad, project);
      pad.updatedAt = new Date().toISOString();
      writeJsonAtomic(projectFilePath(project.projectKey), pad);
      await enqueueIndexUpdate(project, pad.updatedAt);
      return pad;
    });
  }

  return {
    dataDir,
    resolveProject,

    async getScratchpad(workspaceUri) {
      const project = resolveProject(workspaceUri);
      return enqueueProject(project.projectKey, () => loadProjectScratchpad(project));
    },

    async saveNotes(workspaceUri, notes) {
      if (typeof notes !== 'string') {
        throw new ValidationError('notes must be a string');
      }
      return mutateProject(workspaceUri, (pad) => {
        pad.notes = notes;
      });
    },

    async addTodo(workspaceUri, text) {
      const cleanText = requireNonEmptyString(text, 'Todo text');
      return mutateProject(workspaceUri, (pad) => {
        pad.todos.push({
          id: `tod_${randomUUID()}`,
          text: cleanText,
          done: false,
          createdAt: new Date().toISOString(),
          doneAt: null,
        });
      });
    },

    async toggleTodo(workspaceUri, id, done) {
      const cleanId = requireNonEmptyString(id, 'Todo id');
      if (done !== undefined && typeof done !== 'boolean') {
        throw new ValidationError('done must be a boolean');
      }
      return mutateProject(workspaceUri, (pad) => {
        const todo = pad.todos.find((item) => item.id === cleanId);
        if (!todo) {
          throw new NotFoundError(`Todo not found: ${cleanId}`);
        }
        const nextDone = typeof done === 'boolean' ? done : !todo.done;
        todo.done = nextDone;
        todo.doneAt = nextDone ? new Date().toISOString() : null;
      });
    },

    async updateTodo(workspaceUri, id, text) {
      const cleanId = requireNonEmptyString(id, 'Todo id');
      const cleanText = requireNonEmptyString(text, 'Todo text');
      return mutateProject(workspaceUri, (pad) => {
        const todo = pad.todos.find((item) => item.id === cleanId);
        if (!todo) {
          throw new NotFoundError(`Todo not found: ${cleanId}`);
        }
        todo.text = cleanText;
      });
    },

    async deleteTodo(workspaceUri, id) {
      const cleanId = requireNonEmptyString(id, 'Todo id');
      return mutateProject(workspaceUri, (pad) => {
        const idx = pad.todos.findIndex((item) => item.id === cleanId);
        if (idx === -1) {
          throw new NotFoundError(`Todo not found: ${cleanId}`);
        }
        pad.todos.splice(idx, 1);
      });
    },

    async clearDoneTodos(workspaceUri) {
      return mutateProject(workspaceUri, (pad) => {
        pad.todos = pad.todos.filter((item) => !item.done);
      });
    },

    async addLink(workspaceUri, label, url) {
      const normalizedUrl = normalizeLinkUrl(url);
      const hostname = new URL(normalizedUrl).hostname;
      const cleanLabel =
        typeof label === 'string' && label.trim() !== '' ? label.trim() : hostname;

      return mutateProject(workspaceUri, (pad) => {
        pad.links.push({
          id: `lnk_${randomUUID()}`,
          label: cleanLabel,
          url: normalizedUrl,
          createdAt: new Date().toISOString(),
        });
      });
    },

    async deleteLink(workspaceUri, id) {
      const cleanId = requireNonEmptyString(id, 'Link id');
      return mutateProject(workspaceUri, (pad) => {
        const idx = pad.links.findIndex((item) => item.id === cleanId);
        if (idx === -1) {
          throw new NotFoundError(`Link not found: ${cleanId}`);
        }
        pad.links.splice(idx, 1);
      });
    },
  };
}
