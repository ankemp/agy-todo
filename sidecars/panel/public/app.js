import {
  partitionTodos,
  formatMarkdown,
  createNotesAutosaver,
  extractWorkspaceUrisFromMetadata,
} from './helpers.mjs';

const emptyStateEl = document.getElementById('empty-state');
const appShellEl = document.getElementById('app-shell');
const statusDotEl = document.getElementById('status-dot');
const projectNameEl = document.getElementById('project-name');
const workspaceSelectEl = document.getElementById('workspace-select');
const saveStatusEl = document.getElementById('save-status');
const exportBtnEl = document.getElementById('export-btn');

const linksListEl = document.getElementById('links-list');
const toggleLinkFormBtnEl = document.getElementById('toggle-link-form-btn');
const linkFormEl = document.getElementById('link-form');
const linkLabelInputEl = document.getElementById('link-label-input');
const linkUrlInputEl = document.getElementById('link-url-input');
const linkCancelBtnEl = document.getElementById('link-cancel-btn');
const linkErrorEl = document.getElementById('link-error');

const todosCountsEl = document.getElementById('todos-counts');
const clearDoneBtnEl = document.getElementById('clear-done-btn');
const todoAddFormEl = document.getElementById('todo-add-form');
const todoInputEl = document.getElementById('todo-input');
const todosListEl = document.getElementById('todos-list');

const notesInputEl = document.getElementById('notes-input');

let workspaceUris = [];
let activeWorkspaceUri = null;
let scratchpad = null;
let editingTodoId = null;
let loadSeq = 0;
let workspaceQueue = Promise.resolve();
let exportResetTimer = null;

function setStatus(state, text) {
  saveStatusEl.textContent = text;
  saveStatusEl.classList.toggle('is-error', state === 'error');
  statusDotEl.classList.toggle('is-saving', state === 'saving');
  statusDotEl.classList.toggle('is-error', state === 'error');
}

function isSafeHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function workspaceOptionLabel(uri) {
  try {
    if (uri.startsWith('file://')) {
      const pathname = decodeURIComponent(new URL(uri).pathname).replace(/\/+$/, '');
      const segments = pathname.split('/').filter(Boolean);
      return segments[segments.length - 1] || pathname || uri;
    }
  } catch {
    // Fallback to raw URI below
  }
  const parts = uri.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || uri;
}

async function sidecarRequest(url, options = {}) {
  const fetcher = window.sidecar?.fetch || window.fetch.bind(window);
  const res = await fetcher(url, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

async function postJson(path, payload) {
  return sidecarRequest(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

const autosaver = createNotesAutosaver({
  delayMs: 400,
  saveFn: async (workspaceUri, notes) => {
    if (workspaceUri === activeWorkspaceUri) {
      setStatus('saving', 'Saving…');
    }
    try {
      const updated = await postJson('/api/notes', { workspaceUri, notes });
      if (workspaceUri === activeWorkspaceUri && scratchpad) {
        scratchpad = {
          ...scratchpad,
          ...updated,
          notes: notesInputEl.value,
        };
        setStatus('saved', 'Saved');
      }
    } catch (err) {
      if (workspaceUri === activeWorkspaceUri) {
        setStatus('error', 'Save failed');
      }
      throw err;
    }
  },
});

function renderHeader() {
  if (!scratchpad) {
    projectNameEl.textContent = workspaceOptionLabel(activeWorkspaceUri || '');
    projectNameEl.title = activeWorkspaceUri || '';
    return;
  }
  projectNameEl.textContent = scratchpad.displayName || 'Scratchpad';
  projectNameEl.title = scratchpad.canonicalPath || activeWorkspaceUri || '';
}

function renderWorkspaceSelector() {
  while (workspaceSelectEl.firstChild) {
    workspaceSelectEl.removeChild(workspaceSelectEl.firstChild);
  }

  if (workspaceUris.length <= 1) {
    workspaceSelectEl.hidden = true;
    return;
  }

  for (const uri of workspaceUris) {
    const option = document.createElement('option');
    option.value = uri;
    option.textContent = workspaceOptionLabel(uri);
    option.selected = uri === activeWorkspaceUri;
    workspaceSelectEl.appendChild(option);
  }
  workspaceSelectEl.hidden = false;
}

function renderLinks() {
  while (linksListEl.firstChild) {
    linksListEl.removeChild(linksListEl.firstChild);
  }

  const links = Array.isArray(scratchpad?.links) ? scratchpad.links : [];
  for (const link of links) {
    const pill = document.createElement('span');
    pill.className = 'link-pill';

    if (isSafeHttpUrl(link.url)) {
      const anchor = document.createElement('a');
      anchor.className = 'link-anchor';
      anchor.href = link.url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.title = link.url;
      anchor.textContent = `↗ ${link.label || link.url}`;
      pill.appendChild(anchor);
    } else {
      const span = document.createElement('span');
      span.className = 'link-anchor';
      span.textContent = link.label || link.url || 'Link';
      pill.appendChild(span);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'link-remove-btn';
    removeBtn.title = 'Remove link';
    removeBtn.setAttribute('aria-label', `Remove link ${link.label || link.url}`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      void handleDeleteLink(link.id);
    });
    pill.appendChild(removeBtn);

    linksListEl.appendChild(pill);
  }
}

function renderTodos() {
  while (todosListEl.firstChild) {
    todosListEl.removeChild(todosListEl.firstChild);
  }

  const { open, done } = partitionTodos(scratchpad?.todos);
  todosCountsEl.textContent = `${open.length} open · ${done.length} done`;
  clearDoneBtnEl.hidden = done.length === 0;

  const ordered = [...open, ...done];
  if (ordered.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'todo-empty';
    emptyLi.textContent = 'No todos yet.';
    todosListEl.appendChild(emptyLi);
    return;
  }

  for (const todo of ordered) {
    const li = document.createElement('li');
    li.className = todo.done ? 'todo-item is-done' : 'todo-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'todo-checkbox';
    checkbox.checked = Boolean(todo.done);
    checkbox.setAttribute('aria-label', `Mark "${todo.text}" as ${todo.done ? 'open' : 'done'}`);
    checkbox.addEventListener('change', () => {
      void handleToggleTodo(todo.id, checkbox.checked);
    });
    li.appendChild(checkbox);

    if (editingTodoId === todo.id) {
      const editInput = document.createElement('input');
      editInput.type = 'text';
      editInput.className = 'input todo-edit-input';
      editInput.value = todo.text;
      editInput.setAttribute('aria-label', 'Edit todo text');

      let finished = false;
      const commitEdit = async () => {
        if (finished) return;
        finished = true;
        const nextText = editInput.value.trim();
        editingTodoId = null;
        if (!nextText || nextText === todo.text) {
          renderTodos();
          return;
        }
        await handleUpdateTodo(todo.id, nextText);
      };
      const cancelEdit = () => {
        if (finished) return;
        finished = true;
        editingTodoId = null;
        renderTodos();
      };

      editInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void commitEdit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelEdit();
        }
      });
      editInput.addEventListener('blur', () => {
        void commitEdit();
      });

      li.appendChild(editInput);
      todosListEl.appendChild(li);
      queueMicrotask(() => {
        editInput.focus();
        editInput.select();
      });
    } else {
      const textSpan = document.createElement('span');
      textSpan.className = 'todo-text';
      textSpan.title = 'Double-click to edit';
      textSpan.textContent = todo.text;
      textSpan.addEventListener('dblclick', () => {
        editingTodoId = todo.id;
        renderTodos();
      });
      li.appendChild(textSpan);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'todo-delete-btn';
    deleteBtn.title = 'Delete todo';
    deleteBtn.setAttribute('aria-label', `Delete todo ${todo.text}`);
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', () => {
      void handleDeleteTodo(todo.id);
    });
    li.appendChild(deleteBtn);

    todosListEl.appendChild(li);
  }
}

function renderNotes() {
  const nextNotes = typeof scratchpad?.notes === 'string' ? scratchpad.notes : '';
  if (notesInputEl.value !== nextNotes) {
    notesInputEl.value = nextNotes;
  }
}

function renderAll() {
  renderHeader();
  renderWorkspaceSelector();
  renderLinks();
  renderTodos();
  renderNotes();
}

function closeLinkForm() {
  linkFormEl.hidden = true;
  toggleLinkFormBtnEl.setAttribute('aria-expanded', 'false');
  linkLabelInputEl.value = '';
  linkUrlInputEl.value = '';
  linkErrorEl.textContent = '';
  linkErrorEl.hidden = true;
}

function openLinkForm() {
  linkFormEl.hidden = false;
  toggleLinkFormBtnEl.setAttribute('aria-expanded', 'true');
  linkErrorEl.textContent = '';
  linkErrorEl.hidden = true;
  linkLabelInputEl.focus();
}

async function applyMutation(fn) {
  if (!activeWorkspaceUri) return;
  const targetUri = activeWorkspaceUri;
  setStatus('saving', 'Saving…');
  try {
    const updated = await fn(targetUri);
    if (targetUri !== activeWorkspaceUri) return;
    scratchpad = updated;
    renderHeader();
    renderLinks();
    renderTodos();
    setStatus('saved', 'Saved');
  } catch (err) {
    if (targetUri === activeWorkspaceUri) {
      setStatus('error', 'Error');
    }
    throw err;
  }
}

async function handleDeleteLink(id) {
  try {
    await applyMutation((uri) => postJson('/api/links/delete', { workspaceUri: uri, id }));
  } catch (err) {
    console.error('Failed to delete link:', err);
  }
}

async function handleToggleTodo(id, done) {
  try {
    await applyMutation((uri) => postJson('/api/todos/toggle', { workspaceUri: uri, id, done }));
  } catch (err) {
    console.error('Failed to toggle todo:', err);
  }
}

async function handleUpdateTodo(id, text) {
  try {
    await applyMutation((uri) => postJson('/api/todos/update', { workspaceUri: uri, id, text }));
  } catch (err) {
    console.error('Failed to update todo:', err);
  }
}

async function handleDeleteTodo(id) {
  try {
    await applyMutation((uri) => postJson('/api/todos/delete', { workspaceUri: uri, id }));
  } catch (err) {
    console.error('Failed to delete todo:', err);
  }
}

async function switchWorkspace(nextUri) {
  await autosaver.flush().catch((err) => {
    console.error('Failed to flush notes before workspace switch:', err);
  });

  const seq = ++loadSeq;
  activeWorkspaceUri = nextUri;
  scratchpad = null;
  editingTodoId = null;
  notesInputEl.value = '';
  notesInputEl.disabled = true;
  closeLinkForm();
  emptyStateEl.hidden = true;
  appShellEl.hidden = false;
  renderHeader();
  renderWorkspaceSelector();
  renderLinks();
  renderTodos();
  setStatus('saving', 'Loading…');

  try {
    const data = await sidecarRequest(
      `/api/scratchpad?workspaceUri=${encodeURIComponent(nextUri)}`
    );
    if (seq !== loadSeq || nextUri !== activeWorkspaceUri) return;
    scratchpad = data;
    notesInputEl.disabled = false;
    renderAll();
    setStatus('saved', 'Saved');
  } catch (err) {
    if (seq !== loadSeq || nextUri !== activeWorkspaceUri) return;
    console.error('Failed to load scratchpad:', err);
    setStatus('error', 'Load failed');
  }
}

function enqueueWorkspaceUris(rawUris) {
  workspaceQueue = workspaceQueue
    .catch(() => {})
    .then(async () => {
      const nextList = Array.isArray(rawUris) ? rawUris.filter(Boolean) : [];
      workspaceUris = nextList;

      if (nextList.length === 0) {
        await autosaver.flush().catch((err) => {
          console.error('Failed to flush notes before clearing workspace:', err);
        });
        loadSeq++;
        activeWorkspaceUri = null;
        scratchpad = null;
        editingTodoId = null;
        closeLinkForm();
        appShellEl.hidden = true;
        emptyStateEl.hidden = false;
        return;
      }

      const targetUri = nextList.includes(activeWorkspaceUri)
        ? activeWorkspaceUri
        : nextList[0];

      if (targetUri !== activeWorkspaceUri) {
        await switchWorkspace(targetUri);
      } else {
        renderWorkspaceSelector();
      }
    });
  return workspaceQueue;
}

workspaceSelectEl.addEventListener('change', () => {
  const chosen = workspaceSelectEl.value;
  if (chosen && chosen !== activeWorkspaceUri) {
    workspaceQueue = workspaceQueue
      .catch(() => {})
      .then(() => switchWorkspace(chosen));
  }
});

toggleLinkFormBtnEl.addEventListener('click', () => {
  if (linkFormEl.hidden) {
    openLinkForm();
  } else {
    closeLinkForm();
  }
});

linkCancelBtnEl.addEventListener('click', () => {
  closeLinkForm();
});

linkFormEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLinkForm();
  }
});

linkFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeWorkspaceUri) return;

  const label = linkLabelInputEl.value.trim();
  const url = linkUrlInputEl.value.trim();
  if (!url) return;

  linkErrorEl.hidden = true;
  linkErrorEl.textContent = '';

  try {
    await applyMutation((uri) =>
      postJson('/api/links/add', { workspaceUri: uri, label, url })
    );
    closeLinkForm();
  } catch (err) {
    linkErrorEl.textContent = err.message || 'Invalid link URL';
    linkErrorEl.hidden = false;
  }
});

todoAddFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeWorkspaceUri) return;

  const text = todoInputEl.value.trim();
  if (!text) return;

  todoInputEl.value = '';
  try {
    await applyMutation((uri) =>
      postJson('/api/todos/add', { workspaceUri: uri, text })
    );
  } catch (err) {
    todoInputEl.value = text;
    console.error('Failed to add todo:', err);
  }
});

clearDoneBtnEl.addEventListener('click', async () => {
  try {
    await applyMutation((uri) =>
      postJson('/api/todos/clear-done', { workspaceUri: uri })
    );
  } catch (err) {
    console.error('Failed to clear completed todos:', err);
  }
});

notesInputEl.addEventListener('input', () => {
  if (!activeWorkspaceUri) return;
  setStatus('saving', 'Saving…');
  autosaver.schedule(activeWorkspaceUri, notesInputEl.value);
});

notesInputEl.addEventListener('blur', () => {
  void autosaver.flush().catch((err) => {
    console.error('Failed to flush notes on blur:', err);
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void autosaver.flush().catch((err) => {
      console.error('Failed to flush notes on visibilitychange:', err);
    });
  }
});

window.addEventListener('beforeunload', () => {
  void autosaver.flush();
});

exportBtnEl.addEventListener('click', async () => {
  if (!scratchpad) return;
  const current = {
    ...scratchpad,
    notes: notesInputEl.value,
  };
  const markdown = formatMarkdown(current);
  const safeBase = (current.displayName || 'scratchpad')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'scratchpad';

  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(markdown);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `${safeBase}-scratchpad.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  exportBtnEl.textContent = copied ? 'Copied!' : 'Downloaded';
  if (exportResetTimer) {
    clearTimeout(exportResetTimer);
  }
  exportResetTimer = setTimeout(() => {
    exportBtnEl.textContent = 'Export .md';
    exportResetTimer = null;
  }, 1500);
});

let hasHostWorkspace = false;

async function resolveWorkspaceFromConversation() {
  const cid = window.sidecar?.conversationId;
  const getMeta = window.sidecar?.agent?.getConversationMetadata;
  if (!cid || typeof getMeta !== 'function') {
    return [];
  }
  try {
    const data = await getMeta(cid);
    return extractWorkspaceUrisFromMetadata(data);
  } catch (err) {
    console.error('Failed to resolve workspace from conversation metadata:', err);
    return [];
  }
}

if (window.sidecar?.onWorkspaceChange) {
  window.sidecar.onWorkspaceChange((uris) => {
    const list = Array.isArray(uris) ? uris.filter(Boolean) : [];
    if (list.length > 0 || hasHostWorkspace) {
      hasHostWorkspace = true;
      void enqueueWorkspaceUris(list);
    }
  });
}

if (window.sidecar?.getWorkspaceUris) {
  window.sidecar.getWorkspaceUris().then((uris) => {
    const list = Array.isArray(uris) ? uris.filter(Boolean) : [];
    if (list.length > 0) {
      hasHostWorkspace = true;
      void enqueueWorkspaceUris(list);
    } else if (workspaceUris.length === 0) {
      void enqueueWorkspaceUris([]);
    }
  });
}

void resolveWorkspaceFromConversation().then((uris) => {
  if (uris.length > 0 && workspaceUris.length === 0) {
    void enqueueWorkspaceUris(uris);
  } else if (!window.sidecar?.getWorkspaceUris && uris.length === 0) {
    void enqueueWorkspaceUris([]);
  }
});
