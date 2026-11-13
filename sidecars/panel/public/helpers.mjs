/**
 * Pure UI helper functions for AGY Todo auxiliary pane.
 */

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
export function escapeHtml(value) {
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
export function partitionTodos(todos) {
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
export function formatMarkdown(scratchpad) {
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
export function createNotesAutosaver({ saveFn, delayMs = 400 }) {
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
