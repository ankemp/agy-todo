import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NotFoundError, ValidationError, resolveProject, withFileLock } from './store.mjs';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_READ_LINES = 800;
export const DEFAULT_MAX_READ_BYTES = 46080;
export const VALID_EDITORS = ['system', 'subl', 'code', 'cursor', 'agy', 'custom'];

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

/**
 * Validate and normalize a single-segment managed filename.
 * Rejects empty names, dot segments, path separators, and control characters.
 */
export function sanitizeFileName(rawName) {
  if (typeof rawName !== 'string') {
    throw new ValidationError('Filename must be a string');
  }
  const trimmed = rawName.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    throw new ValidationError('Filename is invalid or empty');
  }
  if (/[/\\]/.test(trimmed) || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ValidationError('Filename contains forbidden path separators or control characters');
  }
  if (basename(trimmed) !== trimmed) {
    throw new ValidationError('Filename must be a single path segment');
  }
  return trimmed;
}

/**
 * Resolve a non-colliding filename inside `dirPath` by appending `-2`, `-3`, etc. before the extension.
 */
export function resolveUniqueFileName(dirPath, desiredName) {
  const clean = sanitizeFileName(desiredName);
  if (!existsSync(join(dirPath, clean))) {
    return clean;
  }

  const ext = extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  let counter = 2;
  while (true) {
    const candidate = `${stem}-${counter}${ext}`;
    if (!existsSync(join(dirPath, candidate))) {
      return candidate;
    }
    counter += 1;
  }
}

function writeBufferAtomic(filePath, buffer) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Best-effort temp cleanup.
    }
    throw error;
  }
}

function writeJsonAtomic(filePath, data) {
  writeBufferAtomic(filePath, Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'));
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

function resolveImportSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new ValidationError('Source file path is required');
  }
  const raw = sourcePath.trim();
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ValidationError('Source file path contains invalid control characters');
  }

  if (/^file:/i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      throw new ValidationError('Invalid file:// source URI');
    }
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new ValidationError('Unsupported source path URI scheme');
  }
  if (raw === '~') {
    return homedir();
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return join(homedir(), raw.slice(2));
  }
  return resolve(raw);
}

function assertContainedPath(scopeDir, targetPath) {
  let exists = false;
  try {
    lstatSync(targetPath);
    exists = true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new NotFoundError(`File not found: ${basename(targetPath)}`);
    }
    throw error;
  }

  if (!exists || !existsSync(scopeDir)) {
    throw new NotFoundError(`File not found: ${basename(targetPath)}`);
  }

  let realDir;
  let realTarget;
  try {
    realDir = realpathSync(scopeDir);
    realTarget = realpathSync(targetPath);
  } catch {
    throw new ValidationError('Managed file path cannot be resolved inside storage');
  }

  const prefix = realDir.endsWith(sep) ? realDir : `${realDir}${sep}`;
  if (!realTarget.startsWith(prefix)) {
    throw new ValidationError('Managed file path escapes storage directory');
  }

  const st = statSync(realTarget);
  if (!st.isFile()) {
    throw new ValidationError('Managed path is not a regular file');
  }

  return realTarget;
}

function resolveExistingContainedPath(scopeDir, targetPath) {
  try {
    lstatSync(targetPath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
  return assertContainedPath(scopeDir, targetPath);
}

function validateReadSliceOptions({ encoding, startLine, endLine, byteOffset }) {
  if (encoding === 'base64') {
    if (startLine !== undefined || endLine !== undefined || byteOffset !== undefined) {
      throw new ValidationError(
        'startLine, endLine, and byteOffset are only supported for utf8 encoding',
      );
    }
    return;
  }
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    throw new ValidationError('startLine must be an integer >= 1');
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
    throw new ValidationError('endLine must be an integer >= 1');
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new ValidationError('endLine must be >= startLine');
  }
  if (byteOffset !== undefined && (!Number.isInteger(byteOffset) || byteOffset < 0)) {
    throw new ValidationError('byteOffset must be an integer >= 0');
  }
}

function sliceUtf8Buffer(buf, startByte, maxBytes) {
  let cutEnd = Math.min(buf.length, startByte + maxBytes);
  while (cutEnd > startByte && cutEnd < buf.length && (buf[cutEnd] & 0xc0) === 0x80) {
    cutEnd -= 1;
  }
  // If maxBytes < 4 falls inside the very first multi-byte char, include the whole char so paging advances.
  if (cutEnd === startByte && startByte < buf.length) {
    cutEnd = startByte + 1;
    while (cutEnd < buf.length && (buf[cutEnd] & 0xc0) === 0x80) {
      cutEnd += 1;
    }
  }
  return {
    text: buf.subarray(startByte, cutEnd).toString('utf8'),
    nextByteOffset: cutEnd < buf.length ? cutEnd : undefined,
  };
}

function buildFileEntry(name, filePath, stat, scope) {
  return {
    name,
    path: filePath,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    scope,
  };
}

function normalizeSettings(raw) {
  const defaultEditor =
    raw && typeof raw.defaultEditor === 'string' && VALID_EDITORS.includes(raw.defaultEditor)
      ? raw.defaultEditor
      : 'system';
  const customEditorCommand =
    raw && typeof raw.customEditorCommand === 'string' ? raw.customEditorCommand.trim() : '';

  if (defaultEditor === 'custom' && !customEditorCommand) {
    return { defaultEditor: 'system', customEditorCommand: '' };
  }
  return { defaultEditor, customEditorCommand };
}

/**
 * Create a serialized per-project and global file store with editor settings persistence.
 */
export function createFileStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.AGY_TODO_DATA_DIR ||
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    defaultDataDir();

  const maxFileBytes =
    typeof options.maxFileBytes === 'number' && options.maxFileBytes > 0
      ? options.maxFileBytes
      : MAX_FILE_BYTES;

  const maxReadLines =
    Number.isInteger(options.maxReadLines) && options.maxReadLines > 0
      ? options.maxReadLines
      : DEFAULT_MAX_READ_LINES;

  const maxReadBytes =
    Number.isInteger(options.maxReadBytes) && options.maxReadBytes > 0
      ? options.maxReadBytes
      : DEFAULT_MAX_READ_BYTES;

  const filesRoot = join(dataDir, 'files');
  const locksRoot = join(dataDir, 'locks', 'files');
  const settingsFile = join(dataDir, 'settings.json');
  const scopeQueues = new Map();
  let settingsQueue = Promise.resolve();

  function enqueueScope(scopeKey, task) {
    const prev = scopeQueues.get(scopeKey) ?? Promise.resolve();
    const next = prev.then(task);
    const tail = next.catch(() => {}).finally(() => {
      if (scopeQueues.get(scopeKey) === tail) {
        scopeQueues.delete(scopeKey);
      }
    });
    scopeQueues.set(scopeKey, tail);
    return next;
  }

  function scopeLockPath(scopeInfo) {
    return join(
      locksRoot,
      scopeInfo.scope === 'global' ? 'global.lock' : `project-${scopeInfo.projectKey}.lock`,
    );
  }

  function runScopeMutation(scopeInfo, task) {
    return enqueueScope(scopeInfo.scopeKey, () => withFileLock(scopeLockPath(scopeInfo), task));
  }

  function enqueueSettings(task) {
    const run = settingsQueue.then(task);
    settingsQueue = run.catch(() => {});
    return run;
  }

  function resolveScope(scope, workspaceUri) {
    if (scope !== 'project' && scope !== 'global') {
      throw new ValidationError('scope must be "project" or "global"');
    }
    if (scope === 'global') {
      return {
        scope: 'global',
        projectKey: null,
        scopeKey: 'global',
        directory: join(filesRoot, 'global'),
      };
    }
    const project = resolveProject(workspaceUri);
    return {
      scope: 'project',
      projectKey: project.projectKey,
      scopeKey: `project:${project.projectKey}`,
      directory: join(filesRoot, 'projects', project.projectKey),
    };
  }

  function readFilesList(scopeInfo) {
    if (!existsSync(scopeInfo.directory)) {
      return [];
    }
    const entries = readdirSync(scopeInfo.directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.includes('.tmp.')) {
        continue;
      }
      const candidate = join(scopeInfo.directory, entry.name);
      try {
        const realPath = assertContainedPath(scopeInfo.directory, candidate);
        const st = statSync(realPath);
        files.push(buildFileEntry(entry.name, candidate, st, scopeInfo.scope));
      } catch {
        // Ignore non-regular or escaped entries when listing.
      }
    }
    files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
    return files;
  }

  function loadSettingsSync() {
    if (!existsSync(settingsFile)) {
      return { defaultEditor: 'system', customEditorCommand: '' };
    }
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyntaxError('Settings JSON root must be an object');
      }
      return normalizeSettings(parsed);
    } catch {
      quarantineCorruptFile(settingsFile, 'settings');
      return { defaultEditor: 'system', customEditorCommand: '' };
    }
  }

  return {
    dataDir,

    async listFiles(scope, workspaceUri) {
      const scopeInfo = resolveScope(scope, workspaceUri);
      return enqueueScope(scopeInfo.scopeKey, () => ({
        scope: scopeInfo.scope,
        projectKey: scopeInfo.projectKey,
        directory: scopeInfo.directory,
        files: readFilesList(scopeInfo),
      }));
    },

    async saveFile({
      scope,
      workspaceUri,
      filename,
      content,
      encoding = 'utf8',
      overwrite = false,
      append = false,
    } = {}) {
      const scopeInfo = resolveScope(scope, workspaceUri);
      const cleanName = sanitizeFileName(filename);

      if (typeof content !== 'string') {
        throw new ValidationError('File content must be a string');
      }
      if (encoding !== 'utf8' && encoding !== 'base64') {
        throw new ValidationError('encoding must be "utf8" or "base64"');
      }
      if (typeof overwrite !== 'boolean') {
        throw new ValidationError('overwrite must be a boolean');
      }
      if (typeof append !== 'boolean') {
        throw new ValidationError('append must be a boolean');
      }
      if (overwrite && append) {
        throw new ValidationError('overwrite and append cannot both be true');
      }

      const buffer = Buffer.from(content, encoding);
      if (buffer.length > maxFileBytes) {
        throw new ValidationError(`File exceeds maximum size of ${maxFileBytes} bytes`);
      }

      return runScopeMutation(scopeInfo, () => {
        mkdirSync(scopeInfo.directory, { recursive: true });
        let targetName;
        let destPath;
        let writeBuf = buffer;
        let existedBefore = false;

        if (append || overwrite) {
          targetName = cleanName;
          destPath = join(scopeInfo.directory, targetName);
          const existingRealPath = resolveExistingContainedPath(scopeInfo.directory, destPath);
          if (existingRealPath !== null) {
            existedBefore = true;
            if (append) {
              const existingBuf = readFileSync(existingRealPath);
              writeBuf = Buffer.concat([existingBuf, buffer]);
              if (writeBuf.length > maxFileBytes) {
                throw new ValidationError(`File exceeds maximum size of ${maxFileBytes} bytes`);
              }
            }
          }
        } else {
          targetName = resolveUniqueFileName(scopeInfo.directory, cleanName);
          destPath = join(scopeInfo.directory, targetName);
        }

        writeBufferAtomic(destPath, writeBuf);
        const st = statSync(destPath);
        const savedFile = buildFileEntry(targetName, destPath, st, scopeInfo.scope);
        return {
          scope: scopeInfo.scope,
          files: readFilesList(scopeInfo),
          savedFile,
          existedBefore,
        };
      });
    },

    async editFile({ scope, workspaceUri, filename, target, replacement } = {}) {
      const scopeInfo = resolveScope(scope, workspaceUri);
      const cleanName = sanitizeFileName(filename);

      if (typeof target !== 'string' || target.length === 0) {
        throw new ValidationError('target must be a non-empty string');
      }
      if (typeof replacement !== 'string') {
        throw new ValidationError('replacement must be a string');
      }

      return runScopeMutation(scopeInfo, () => {
        const targetPath = join(scopeInfo.directory, cleanName);
        const realPath = assertContainedPath(scopeInfo.directory, targetPath);
        const existingBuf = readFileSync(realPath);
        if (existingBuf.includes(0)) {
          throw new ValidationError('Cannot edit binary file containing NUL bytes');
        }
        let existingText;
        try {
          existingText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            existingBuf,
          );
        } catch {
          throw new ValidationError('Cannot edit invalid UTF-8 file');
        }

        // Literal split/join avoids `$` substitution sequences interpreted by String.prototype.replaceAll.
        const parts = existingText.split(target);
        const replacements = parts.length - 1;
        if (replacements === 0) {
          throw new ValidationError('Target text not found in file');
        }

        const nextBuf = Buffer.from(parts.join(replacement), 'utf8');
        if (nextBuf.length > maxFileBytes) {
          throw new ValidationError(`File exceeds maximum size of ${maxFileBytes} bytes`);
        }

        writeBufferAtomic(targetPath, nextBuf);
        const st = statSync(targetPath);
        return {
          scope: scopeInfo.scope,
          file: buildFileEntry(cleanName, targetPath, st, scopeInfo.scope),
          replacements,
        };
      });
    },

    async importFileFromPath({ scope, workspaceUri, sourcePath } = {}) {
      const scopeInfo = resolveScope(scope, workspaceUri);
      const resolvedSource = resolveImportSourcePath(sourcePath);

      let st;
      try {
        st = statSync(resolvedSource);
      } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
          throw new NotFoundError(`Source file not found: ${resolvedSource}`);
        }
        throw error;
      }

      if (!st.isFile()) {
        throw new ValidationError('Source path must point to a regular file');
      }
      if (st.size > maxFileBytes) {
        throw new ValidationError(`File exceeds maximum size of ${maxFileBytes} bytes`);
      }

      const cleanName = sanitizeFileName(basename(resolvedSource));
      const buffer = readFileSync(resolvedSource);
      if (buffer.length > maxFileBytes) {
        throw new ValidationError(`File exceeds maximum size of ${maxFileBytes} bytes`);
      }

      return runScopeMutation(scopeInfo, () => {
        mkdirSync(scopeInfo.directory, { recursive: true });
        const uniqueName = resolveUniqueFileName(scopeInfo.directory, cleanName);
        const destPath = join(scopeInfo.directory, uniqueName);
        writeBufferAtomic(destPath, buffer);
        const savedStat = statSync(destPath);
        const savedFile = buildFileEntry(uniqueName, destPath, savedStat, scopeInfo.scope);
        return {
          scope: scopeInfo.scope,
          files: readFilesList(scopeInfo),
          savedFile,
        };
      });
    },

    async renameFile({ scope, workspaceUri, filename, newFilename } = {}) {
      const scopeInfo = resolveScope(scope, workspaceUri);
      const cleanOld = sanitizeFileName(filename);
      const cleanNew = sanitizeFileName(newFilename);

      return runScopeMutation(scopeInfo, () => {
        const oldPath = join(scopeInfo.directory, cleanOld);
        assertContainedPath(scopeInfo.directory, oldPath);

        if (cleanOld === cleanNew) {
          const st = statSync(oldPath);
          return {
            scope: scopeInfo.scope,
            files: readFilesList(scopeInfo),
            renamedFile: buildFileEntry(cleanOld, oldPath, st, scopeInfo.scope),
          };
        }

        const uniqueNew = resolveUniqueFileName(scopeInfo.directory, cleanNew);
        const newPath = join(scopeInfo.directory, uniqueNew);
        renameSync(oldPath, newPath);
        const st = statSync(newPath);
        const renamedFile = buildFileEntry(uniqueNew, newPath, st, scopeInfo.scope);
        return {
          scope: scopeInfo.scope,
          files: readFilesList(scopeInfo),
          renamedFile,
        };
      });
    },

    async deleteFile({ scope, workspaceUri, filename } = {}) {
      const scopeInfo = resolveScope(scope, workspaceUri);
      const cleanName = sanitizeFileName(filename);

      return runScopeMutation(scopeInfo, () => {
        const targetPath = join(scopeInfo.directory, cleanName);
        assertContainedPath(scopeInfo.directory, targetPath);
        unlinkSync(targetPath);
        return {
          scope: scopeInfo.scope,
          files: readFilesList(scopeInfo),
        };
      });
    },

    async resolveManagedFilePath({ scope, workspaceUri, filename } = {}) {
      const scopeInfo = resolveScope(scope, workspaceUri);
      const cleanName = sanitizeFileName(filename);

      return enqueueScope(scopeInfo.scopeKey, () => {
        const targetPath = join(scopeInfo.directory, cleanName);
        return assertContainedPath(scopeInfo.directory, targetPath);
      });
    },

    async readFile({
      scope,
      workspaceUri,
      filename,
      encoding = 'utf8',
      startLine,
      endLine,
      byteOffset,
    } = {}) {
      const scopeInfo = resolveScope(scope, workspaceUri);
      const cleanName = sanitizeFileName(filename);
      if (encoding !== 'utf8' && encoding !== 'base64') {
        throw new ValidationError('encoding must be "utf8" or "base64"');
      }
      validateReadSliceOptions({ encoding, startLine, endLine, byteOffset });

      return enqueueScope(scopeInfo.scopeKey, () => {
        const targetPath = join(scopeInfo.directory, cleanName);
        const realPath = assertContainedPath(scopeInfo.directory, targetPath);
        const st = statSync(realPath);
        const buf = readFileSync(realPath);
        const file = buildFileEntry(cleanName, targetPath, st, scopeInfo.scope);

        if (encoding === 'base64') {
          return {
            scope: scopeInfo.scope,
            file,
            content: buf.toString('base64'),
            encoding,
          };
        }

        const fullText = buf.toString('utf8');
        const lines = fullText.match(/[^\n]*\n|[^\n]+/g) || [];
        const totalLines = lines.length;
        const startByte = byteOffset ?? 0;

        if (totalLines === 0) {
          if (startLine !== undefined && startLine > 1) {
            throw new ValidationError(`startLine (${startLine}) exceeds total lines (0)`);
          }
          if (startByte > 0) {
            throw new ValidationError(`byteOffset (${startByte}) exceeds file length (0)`);
          }
          return {
            scope: scopeInfo.scope,
            file,
            content: '',
            encoding,
            totalLines: 0,
            startLine: 0,
            endLine: 0,
            truncated: false,
          };
        }

        const effectiveStart = startLine ?? 1;
        if (effectiveStart > totalLines) {
          throw new ValidationError(
            `startLine (${effectiveStart}) exceeds total lines (${totalLines})`,
          );
        }
        const requestedEnd = endLine === undefined ? totalLines : Math.min(endLine, totalLines);
        const cappedEnd = Math.min(requestedEnd, effectiveStart + maxReadLines - 1);
        const truncatedByLines = cappedEnd < requestedEnd;

        const selectedText = lines.slice(effectiveStart - 1, cappedEnd).join('');
        const selectedBuf = Buffer.from(selectedText, 'utf8');
        if (startByte >= selectedBuf.length) {
          throw new ValidationError(
            `byteOffset (${startByte}) exceeds selected byte length (${selectedBuf.length})`,
          );
        }

        const { text, nextByteOffset } = sliceUtf8Buffer(selectedBuf, startByte, maxReadBytes);
        const truncatedByBytes = nextByteOffset !== undefined;

        return {
          scope: scopeInfo.scope,
          file,
          content: text,
          encoding,
          totalLines,
          startLine: effectiveStart,
          endLine: cappedEnd,
          truncated: truncatedByLines || truncatedByBytes,
          ...(truncatedByBytes ? { nextByteOffset } : {}),
        };
      });
    },

    async getSettings() {
      return enqueueSettings(() => loadSettingsSync());
    },

    async saveSettings({ defaultEditor, customEditorCommand = '' } = {}) {
      if (typeof defaultEditor !== 'string' || !VALID_EDITORS.includes(defaultEditor)) {
        throw new ValidationError(
          `defaultEditor must be one of: ${VALID_EDITORS.join(', ')}`,
        );
      }
      if (customEditorCommand !== undefined && typeof customEditorCommand !== 'string') {
        throw new ValidationError('customEditorCommand must be a string');
      }
      const trimmedCustom = (customEditorCommand || '').trim();
      if (defaultEditor === 'custom' && !trimmedCustom) {
        throw new ValidationError('customEditorCommand is required when defaultEditor is "custom"');
      }

      const nextSettings = {
        defaultEditor,
        customEditorCommand: trimmedCustom,
      };
      return enqueueSettings(() => {
        writeJsonAtomic(settingsFile, nextSettings);
        return { ...nextSettings };
      });
    },
  };
}
