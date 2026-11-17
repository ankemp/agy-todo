/**
 * Pure UI helper functions for AGY Todo auxiliary pane.
 * Exposed as window.AGYTodoHelpers in classic script tags and CommonJS module.exports in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AGYTodoHelpers = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  /**
   * Escapes HTML special characters to neutralize markup/attribute injection.
   * @param {unknown} value
   * @returns {string}
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
  }

  /**
   * Splits todos into open and done arrays while preserving relative order.
   * @param {Array<{ done?: boolean }>} todos
   * @returns {{ open: Array, done: Array }}
   */
  function partitionTodos(todos) {
    const list = Array.isArray(todos) ? todos : [];
    const open = [];
    const done = [];
    for (const todo of list) {
      if (todo && todo.done) {
        done.push(todo);
      } else if (todo) {
        open.push(todo);
      }
    }
    return { open, done };
  }

  /**
   * Formats a scratchpad object into deterministic Markdown for export.
   * @param {{ displayName?: string, links?: Array, todos?: Array, notes?: string }} scratchpad
   * @returns {string}
   */
  function formatMarkdown(scratchpad) {
    const name = scratchpad?.displayName || 'Scratchpad';
    const links = Array.isArray(scratchpad?.links) ? scratchpad.links : [];
    const { open, done } = partitionTodos(scratchpad?.todos);
    const orderedTodos = [...open, ...done];
    const notes = typeof scratchpad?.notes === 'string' ? scratchpad.notes : '';

    const lines = [`# ${name}`, '', '## Links'];
    if (links.length === 0) {
      lines.push('_None_');
    } else {
      for (const link of links) {
        const label = link.label || link.url || 'Link';
        lines.push(`- [${label}](${link.url})`);
      }
    }

    lines.push('', '## Todos');
    if (orderedTodos.length === 0) {
      lines.push('_None_');
    } else {
      for (const todo of orderedTodos) {
        const mark = todo.done ? 'x' : ' ';
        lines.push(`- [${mark}] ${todo.text}`);
      }
    }

    lines.push('', '## Notes');
    if (notes.length === 0) {
      lines.push('_None_');
    } else {
      lines.push(notes);
    }
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Creates a debounced notes autosaver that binds each edit to its workspaceUri
   * and flushes pending edits before switching workspaces.
   * @param {{ saveFn: (workspaceUri: string, notes: string) => Promise<unknown>, delayMs?: number }} options
   */
  function createNotesAutosaver({ saveFn, delayMs = 400 }) {
    if (typeof saveFn !== 'function') {
      throw new TypeError('createNotesAutosaver requires a saveFn function');
    }

    let timer = null;
    let pendingUri = null;
    let pendingNotes = null;
    let inFlight = Promise.resolve();

    function hasPending() {
      return pendingUri !== null;
    }

    function flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      if (pendingUri === null) {
        return inFlight;
      }

      const uriToSave = pendingUri;
      const notesToSave = pendingNotes;
      pendingUri = null;
      pendingNotes = null;

      const run = inFlight
        .catch(() => {})
        .then(() => saveFn(uriToSave, notesToSave));

      inFlight = run.catch(() => {});
      return run;
    }

    function schedule(workspaceUri, notes) {
      if (pendingUri !== null && pendingUri !== workspaceUri) {
        void flush();
      }

      pendingUri = workspaceUri;
      pendingNotes = notes;

      if (timer !== null) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delayMs);
    }

    return {
      schedule,
      flush,
      hasPending,
    };
  }

  /**
   * Extracts workspace folder URIs from a getConversationMetadata response.
   * @param {unknown} data
   * @returns {string[]}
   */
  function extractWorkspaceUrisFromMetadata(data) {
    const metaEvent =
      data?.response?.conversationMetadata ||
      data?.response?.conversation_metadata;
    const meta = metaEvent?.metadata;
    if (!meta || typeof meta !== 'object') {
      return [];
    }

    const direct = Array.isArray(meta.workspaceUris)
      ? meta.workspaceUris
      : Array.isArray(meta.workspace_uris)
        ? meta.workspace_uris
        : [];

    const fromWorkspaces = Array.isArray(meta.workspaces)
      ? meta.workspaces
          .map(
            (w) =>
              w?.workspaceFolderAbsoluteUri ||
              w?.workspace_folder_absolute_uri ||
              w?.gitRootAbsoluteUri ||
              w?.git_root_absolute_uri ||
              '',
          )
          .filter(Boolean)
      : [];

    const seen = new Set();
    const result = [];
    for (const uri of [...direct, ...fromWorkspaces]) {
      if (typeof uri === 'string' && uri.trim() && !seen.has(uri)) {
        seen.add(uri);
        result.push(uri);
      }
    }
    return result;
  }

  /**
   * Formats a file path as an @path mention, quoting paths that contain whitespace.
   * @param {unknown} filePath
   * @returns {string}
   */
  function formatAttachMention(filePath) {
    if (typeof filePath !== 'string') {
      return '';
    }
    const trimmed = filePath.trim();
    if (!trimmed) {
      return '';
    }
    return /\s/.test(trimmed) ? `@"${trimmed}"` : `@${trimmed}`;
  }

  /**
   * Formats a byte count into B, KB, or MB.
   * @param {unknown} bytes
   * @returns {string}
   */
  function formatFileSize(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }
    if (bytes < 1024) {
      return `${Math.floor(bytes)} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Normalizes a new inline filename, defaulting to .md when no extension is present.
   * @param {unknown} rawName
   * @returns {string}
   */
  function normalizeNewMarkdownFilename(rawName) {
    if (typeof rawName !== 'string') {
      return '';
    }
    const trimmed = rawName.trim();
    if (!trimmed) {
      return '';
    }
    return trimmed.includes('.') ? trimmed : `${trimmed}.md`;
  }

  /**
   * Encodes an ArrayBuffer or Uint8Array to base64 using chunked conversion
   * so large files up to 10 MB do not overflow the JS call stack.
   * @param {ArrayBuffer | ArrayBufferView} buffer
   * @returns {string}
   */
  function arrayBufferToBase64(buffer) {
    if (!buffer) {
      return '';
    }
    let bytes;
    if (buffer instanceof Uint8Array) {
      bytes = buffer;
    } else if (ArrayBuffer.isView(buffer)) {
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (
      buffer instanceof ArrayBuffer ||
      Object.prototype.toString.call(buffer) === '[object ArrayBuffer]'
    ) {
      bytes = new Uint8Array(buffer);
    } else {
      throw new TypeError('arrayBufferToBase64 requires an ArrayBuffer or TypedArray');
    }

    if (bytes.length === 0) {
      return '';
    }

    const CHUNK_SIZE = 8192;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const slice = bytes.subarray(i, i + CHUNK_SIZE);
      chunks.push(String.fromCharCode.apply(null, slice));
    }
    const binary = chunks.join('');
    if (typeof btoa === 'function') {
      return btoa(binary);
    }
    return Buffer.from(bytes).toString('base64');
  }

  /**
   * Returns true when a background refresh may safely update the notes textarea
   * without clobbering active typing or a pending debounced autosave.
   * @param {{ isFocused?: boolean, hasPending?: boolean }} [options]
   * @returns {boolean}
   */
  function shouldApplyNotesRefresh({ isFocused = false, hasPending = false } = {}) {
    return !isFocused && !hasPending;
  }

  /**
   * Compares two file metadata lists for additions, deletions, renames, or stat changes.
   * @param {Array<{ name?: string, size?: number, updatedAt?: string | number, path?: string }>} prevFiles
   * @param {Array<{ name?: string, size?: number, updatedAt?: string | number, path?: string }>} nextFiles
   * @returns {boolean}
   */
  function haveFilesListChanged(prevFiles, nextFiles) {
    const prev = Array.isArray(prevFiles) ? prevFiles : [];
    const next = Array.isArray(nextFiles) ? nextFiles : [];
    if (prev.length !== next.length) {
      return true;
    }
    for (let i = 0; i < prev.length; i += 1) {
      const a = prev[i];
      const b = next[i];
      if (!a || !b) {
        if (a !== b) {
          return true;
        }
        continue;
      }
      if (
        a.name !== b.name ||
        a.size !== b.size ||
        a.updatedAt !== b.updatedAt ||
        a.path !== b.path
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Classifies a computed CSS color string (`rgb(...)`, `rgba(...)`, or `color(srgb ...)`)
   * as `'dark'` or `'light'` by relative luminance, returning `null` if invalid or transparent.
   * @param {unknown} cssColor
   * @returns {'dark' | 'light' | null}
   */
  function computeThemeFromColor(cssColor) {
    if (typeof cssColor !== 'string') {
      return null;
    }
    const trimmed = cssColor.trim();
    if (!trimmed) {
      return null;
    }

    const srgbMatch = trimmed.match(/^color\(\s*srgb\s+([^)]+)\)$/i);
    const rgbMatch = !srgbMatch ? trimmed.match(/^rgba?\(\s*([^)]+)\s*\)$/i) : null;
    if (!srgbMatch && !rgbMatch) {
      return null;
    }

    const body = (srgbMatch ? srgbMatch[1] : rgbMatch[1]).trim();
    const nums = (body.match(/[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
    if (nums.length < 3 || nums.slice(0, 4).some((n) => !Number.isFinite(n))) {
      return null;
    }
    if (nums.length >= 4 && nums[3] <= 0) {
      return null;
    }

    const scale = srgbMatch ? 1 : 255;
    const r = nums[0] / scale;
    const g = nums[1] / scale;
    const b = nums[2] / scale;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum < 0.5 ? 'dark' : 'light';
  }

  /**
   * Builds a deterministic render signature over header identity, links, and todos
   * (explicitly excluding `notes` and `updatedAt`) so polling skips redundant DOM re-renders.
   * @param {unknown} scratchpad
   * @returns {string}
   */
  function scratchpadRenderSignature(scratchpad) {
    if (!scratchpad || typeof scratchpad !== 'object' || Array.isArray(scratchpad)) {
      return '';
    }
    const displayName = typeof scratchpad.displayName === 'string' ? scratchpad.displayName : '';
    const canonicalPath = typeof scratchpad.canonicalPath === 'string' ? scratchpad.canonicalPath : '';
    const links = (Array.isArray(scratchpad.links) ? scratchpad.links : []).map((link) => ({
      id: link && link.id != null ? String(link.id) : '',
      label: link && typeof link.label === 'string' ? link.label : '',
      url: link && typeof link.url === 'string' ? link.url : '',
    }));
    const todos = (Array.isArray(scratchpad.todos) ? scratchpad.todos : []).map((todo) => ({
      id: todo && todo.id != null ? String(todo.id) : '',
      text: todo && typeof todo.text === 'string' ? todo.text : '',
      done: Boolean(todo && todo.done),
    }));
    return JSON.stringify({ displayName, canonicalPath, links, todos });
  }

  /**
   * Converts a POSIX or Windows filesystem path into a percent-encoded `file://` URI.
   * @param {unknown} filePath
   * @returns {string}
   */
  function filePathToUri(filePath) {
    if (typeof filePath !== 'string') {
      return '';
    }
    const trimmed = filePath.trim();
    if (!trimmed) {
      return '';
    }

    let normalized = trimmed.replace(/\\/g, '/');
    if (/^[A-Za-z]:(?:\/|$)/.test(normalized)) {
      normalized = '/' + normalized;
    } else if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }

    const encodedSegments = normalized
      .slice(1)
      .split('/')
      .map((segment, index) => (
        index === 0 && /^[A-Za-z]:$/.test(segment)
          ? segment
          : encodeURIComponent(segment)
      ));

    return 'file:///' + encodedSegments.join('/');
  }

  return {
    escapeHtml,
    partitionTodos,
    formatMarkdown,
    createNotesAutosaver,
    extractWorkspaceUrisFromMetadata,
    formatAttachMention,
    formatFileSize,
    normalizeNewMarkdownFilename,
    arrayBufferToBase64,
    shouldApplyNotesRefresh,
    haveFilesListChanged,
    computeThemeFromColor,
    scratchpadRenderSignature,
    filePathToUri,
  };
});
