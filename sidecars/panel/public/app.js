(() => {
'use strict';

const {
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
} = window.AGYTodoHelpers;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const OPEN_WITH_EDITORS = [
  { id: 'subl', label: 'Sublime Text' },
  { id: 'code', label: 'VS Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'agy', label: 'Antigravity' },
  { id: 'system', label: 'System Default' },
];

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

const filesSectionEl = document.getElementById('files-section');
const filesTabProjectEl = document.getElementById('files-tab-project');
const filesTabGlobalEl = document.getElementById('files-tab-global');
const fileNewBtnEl = document.getElementById('file-new-btn');
const fileUploadBtnEl = document.getElementById('file-upload-btn');
const filePathBtnEl = document.getElementById('file-path-btn');
const editorSettingsBtnEl = document.getElementById('editor-settings-btn');
const fileUploadInputEl = document.getElementById('file-upload-input');
const editorSettingsPanelEl = document.getElementById('editor-settings-panel');
const editorDefaultSelectEl = document.getElementById('editor-default-select');
const editorCustomFormEl = document.getElementById('editor-custom-form');
const editorCustomInputEl = document.getElementById('editor-custom-input');
const editorSettingsErrorEl = document.getElementById('editor-settings-error');
const fileNewFormEl = document.getElementById('file-new-form');
const fileNewNameInputEl = document.getElementById('file-new-name-input');
const fileNewContentInputEl = document.getElementById('file-new-content-input');
const fileNewErrorEl = document.getElementById('file-new-error');
const fileNewCancelBtnEl = document.getElementById('file-new-cancel-btn');
const filePathFormEl = document.getElementById('file-path-form');
const filePathInputEl = document.getElementById('file-path-input');
const filePathErrorEl = document.getElementById('file-path-error');
const filePathCancelBtnEl = document.getElementById('file-path-cancel-btn');
const filesStatusEl = document.getElementById('files-status');
const filesDropHintEl = document.getElementById('files-drop-hint');
const filesListEl = document.getElementById('files-list');

const notesInputEl = document.getElementById('notes-input');

let workspaceUris = [];
let activeWorkspaceUri = null;
let scratchpad = null;
let editingTodoId = null;
let loadSeq = 0;
let workspaceQueue = Promise.resolve();
let exportResetTimer = null;

let activeFilesScope = 'project';
let filesList = [];
let editorSettings = { defaultEditor: 'system', customEditorCommand: '' };
let editingFileName = null;
let openMenuForFile = null;
let filesLoadSeq = 0;
let filesStatusTimer = null;
let dragDepth = 0;
let refreshInFlight = false;

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

function showFilesStatus(message, isError = false, autoHideMs = 3000) {
  if (filesStatusTimer) {
    clearTimeout(filesStatusTimer);
    filesStatusTimer = null;
  }
  filesStatusEl.textContent = message || '';
  filesStatusEl.classList.toggle('is-error', Boolean(isError));
  filesStatusEl.hidden = !message;
  if (message && autoHideMs > 0) {
    filesStatusTimer = setTimeout(() => {
      filesStatusEl.hidden = true;
      filesStatusEl.textContent = '';
      filesStatusTimer = null;
    }, autoHideMs);
  }
}

function fileScopePayload(scope = activeFilesScope, workspaceUri = activeWorkspaceUri) {
  if (scope === 'project') {
    return { scope: 'project', workspaceUri };
  }
  return { scope: 'global' };
}

async function copyTextToClipboard(text) {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function flashButtonLabel(button, temporaryLabel, defaultLabel) {
  button.textContent = temporaryLabel;
  setTimeout(() => {
    if (button.isConnected) {
      button.textContent = defaultLabel;
    }
  }, 1500);
}

function positionOpenWithMenu(menuEl, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return;
  }
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 360;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 600;
  const menuHeight = menuEl.offsetHeight || 150;
  const rightOffset = Math.max(8, viewportWidth - rect.right);

  menuEl.style.right = `${rightOffset}px`;
  if (rect.bottom + menuHeight + 8 <= viewportHeight) {
    menuEl.style.top = `${rect.bottom + 2}px`;
    menuEl.style.bottom = 'auto';
  } else {
    menuEl.style.bottom = `${Math.max(8, viewportHeight - rect.top + 2)}px`;
    menuEl.style.top = 'auto';
  }
}

function renderFilesTabs() {
  const isProject = activeFilesScope === 'project';
  filesTabProjectEl.classList.toggle('is-active', isProject);
  filesTabProjectEl.setAttribute('aria-selected', isProject ? 'true' : 'false');
  filesTabGlobalEl.classList.toggle('is-active', !isProject);
  filesTabGlobalEl.setAttribute('aria-selected', isProject ? 'false' : 'true');
}

function renderEditorSettings() {
  const chosen = editorSettings?.defaultEditor || 'system';
  editorDefaultSelectEl.value = chosen;
  const isCustom = chosen === 'custom';
  editorCustomFormEl.hidden = !isCustom;
  if (isCustom && document.activeElement !== editorCustomInputEl) {
    editorCustomInputEl.value = editorSettings?.customEditorCommand || '';
  }
}

function renderFiles() {
  renderFilesTabs();
  while (filesListEl.firstChild) {
    filesListEl.removeChild(filesListEl.firstChild);
  }

  if (!Array.isArray(filesList) || filesList.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'files-empty';
    emptyLi.textContent =
      activeFilesScope === 'project'
        ? 'No project files yet. Drop files here or create one.'
        : 'No global files yet. Drop files here or create one.';
    filesListEl.appendChild(emptyLi);
    return;
  }

  for (const file of filesList) {
    const li = document.createElement('li');
    li.className = 'file-row';

    if (editingFileName === file.name) {
      const editInput = document.createElement('input');
      editInput.type = 'text';
      editInput.className = 'input file-edit-input';
      editInput.value = file.name;
      editInput.setAttribute('aria-label', `Rename ${file.name}`);

      let finished = false;
      const commitRename = async () => {
        if (finished) return;
        finished = true;
        const nextName = editInput.value.trim();
        editingFileName = null;
        if (!nextName || nextName === file.name) {
          renderFiles();
          return;
        }
        await handleRenameFile(file.name, nextName);
      };
      const cancelRename = () => {
        if (finished) return;
        finished = true;
        editingFileName = null;
        renderFiles();
      };

      editInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void commitRename();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelRename();
        }
      });
      editInput.addEventListener('blur', () => {
        void commitRename();
      });

      li.appendChild(editInput);
      filesListEl.appendChild(li);
      queueMicrotask(() => {
        editInput.focus();
        editInput.select();
      });
      continue;
    }

    const mainDiv = document.createElement('div');
    mainDiv.className = 'file-main';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = file.name;
    nameSpan.title = `${file.path} (double-click to rename)`;
    nameSpan.addEventListener('dblclick', () => {
      openMenuForFile = null;
      editingFileName = file.name;
      renderFiles();
    });
    mainDiv.appendChild(nameSpan);

    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'file-size';
    sizeSpan.textContent = formatFileSize(file.size);
    mainDiv.appendChild(sizeSpan);

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'file-rename-btn';
    renameBtn.title = 'Rename file';
    renameBtn.setAttribute('aria-label', `Rename ${file.name}`);
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', () => {
      openMenuForFile = null;
      editingFileName = file.name;
      renderFiles();
    });
    mainDiv.appendChild(renameBtn);

    li.appendChild(mainDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'file-actions';

    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'btn btn-xs file-action-btn';
    attachBtn.title = 'Copy @path mention for chat';
    attachBtn.setAttribute('aria-label', `Attach ${file.name}`);
    attachBtn.textContent = 'Attach';
    attachBtn.addEventListener('click', async () => {
      const mention = formatAttachMention(file.path);
      const copied = await copyTextToClipboard(mention);
      if (copied) {
        flashButtonLabel(attachBtn, 'Copied @', 'Attach');
      } else {
        showFilesStatus(`Clipboard unavailable. Copy manually: ${mention}`, true, 6000);
      }
    });
    actionsDiv.appendChild(attachBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-xs file-action-btn';
    copyBtn.title = 'Copy file path';
    copyBtn.setAttribute('aria-label', `Copy path for ${file.name}`);
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const copied = await copyTextToClipboard(file.path);
      if (copied) {
        flashButtonLabel(copyBtn, 'Copied!', 'Copy');
      } else {
        showFilesStatus(`Clipboard unavailable. Path: ${file.path}`, true, 6000);
      }
    });
    actionsDiv.appendChild(copyBtn);

    const openSplit = document.createElement('div');
    openSplit.className = 'open-split';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-xs file-action-btn open-split-main';
    openBtn.title = 'Open in default editor';
    openBtn.setAttribute('aria-label', `Open ${file.name}`);
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => {
      openMenuForFile = null;
      void handleOpenFile(file.name);
    });
    openSplit.appendChild(openBtn);

    const openToggleBtn = document.createElement('button');
    openToggleBtn.type = 'button';
    openToggleBtn.className = 'btn btn-xs file-action-btn open-split-toggle';
    openToggleBtn.title = 'Open with…';
    openToggleBtn.setAttribute('aria-label', `Open ${file.name} with specific editor`);
    openToggleBtn.setAttribute('aria-haspopup', 'menu');
    openToggleBtn.setAttribute('aria-expanded', openMenuForFile === file.name ? 'true' : 'false');
    openToggleBtn.textContent = '▾';
    openToggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openMenuForFile = openMenuForFile === file.name ? null : file.name;
      renderFiles();
    });
    openSplit.appendChild(openToggleBtn);

    if (openMenuForFile === file.name) {
      const menu = document.createElement('div');
      menu.className = 'open-with-menu';
      menu.setAttribute('role', 'menu');

      for (const opt of OPEN_WITH_EDITORS) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'open-with-item';
        item.setAttribute('role', 'menuitem');
        item.textContent = opt.label;
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          openMenuForFile = null;
          renderFiles();
          void handleOpenFile(file.name, opt.id);
        });
        menu.appendChild(item);
      }

      openSplit.appendChild(menu);
      queueMicrotask(() => {
        if (menu.isConnected && openToggleBtn.isConnected) {
          positionOpenWithMenu(menu, openToggleBtn);
        }
      });
    }

    actionsDiv.appendChild(openSplit);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'file-delete-btn';
    deleteBtn.title = 'Delete file';
    deleteBtn.setAttribute('aria-label', `Delete file ${file.name}`);
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', () => {
      openMenuForFile = null;
      void handleDeleteFile(file.name);
    });
    actionsDiv.appendChild(deleteBtn);

    li.appendChild(actionsDiv);
    filesListEl.appendChild(li);
  }
}

function renderAll() {
  renderHeader();
  renderWorkspaceSelector();
  renderLinks();
  renderTodos();
  renderFiles();
  renderEditorSettings();
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

function closeNewFileForm() {
  fileNewFormEl.hidden = true;
  fileNewBtnEl.setAttribute('aria-expanded', 'false');
  fileNewNameInputEl.value = '';
  fileNewContentInputEl.value = '';
  fileNewErrorEl.textContent = '';
  fileNewErrorEl.hidden = true;
}

function openNewFileForm() {
  closePathImportForm();
  closeEditorSettingsPanel();
  fileNewFormEl.hidden = false;
  fileNewBtnEl.setAttribute('aria-expanded', 'true');
  fileNewErrorEl.textContent = '';
  fileNewErrorEl.hidden = true;
  fileNewNameInputEl.focus();
}

function closePathImportForm() {
  filePathFormEl.hidden = true;
  filePathBtnEl.setAttribute('aria-expanded', 'false');
  filePathInputEl.value = '';
  filePathErrorEl.textContent = '';
  filePathErrorEl.hidden = true;
}

function openPathImportForm() {
  closeNewFileForm();
  closeEditorSettingsPanel();
  filePathFormEl.hidden = false;
  filePathBtnEl.setAttribute('aria-expanded', 'true');
  filePathErrorEl.textContent = '';
  filePathErrorEl.hidden = true;
  filePathInputEl.focus();
}

function closeEditorSettingsPanel() {
  editorSettingsPanelEl.hidden = true;
  editorSettingsBtnEl.setAttribute('aria-expanded', 'false');
  editorSettingsErrorEl.textContent = '';
  editorSettingsErrorEl.hidden = true;
}

function openEditorSettingsPanel() {
  closeNewFileForm();
  closePathImportForm();
  renderEditorSettings();
  editorSettingsPanelEl.hidden = false;
  editorSettingsBtnEl.setAttribute('aria-expanded', 'true');
  editorSettingsErrorEl.textContent = '';
  editorSettingsErrorEl.hidden = true;
}

function closeAllFilePanels() {
  closeNewFileForm();
  closePathImportForm();
  closeEditorSettingsPanel();
}

async function loadFiles(scope = activeFilesScope, workspaceUri = activeWorkspaceUri) {
  if (scope === 'project' && !workspaceUri) {
    filesList = [];
    renderFiles();
    return;
  }

  const seq = ++filesLoadSeq;
  const params = new URLSearchParams({ scope });
  if (scope === 'project' && workspaceUri) {
    params.set('workspaceUri', workspaceUri);
  }

  try {
    const data = await sidecarRequest(`/api/files?${params.toString()}`);
    if (seq !== filesLoadSeq || scope !== activeFilesScope) return;
    if (scope === 'project' && workspaceUri !== activeWorkspaceUri) return;

    filesList = Array.isArray(data?.files) ? data.files : [];
    if (data?.settings && typeof data.settings === 'object') {
      editorSettings = {
        defaultEditor: data.settings.defaultEditor || 'system',
        customEditorCommand: data.settings.customEditorCommand || '',
      };
      renderEditorSettings();
    }
    renderFiles();
  } catch (err) {
    if (seq !== filesLoadSeq || scope !== activeFilesScope) return;
    console.error('Failed to load files:', err);
    showFilesStatus(err.message || 'Failed to load files', true, 0);
  }
}

async function handleRenameFile(filename, newFilename) {
  const targetScope = activeFilesScope;
  const targetUri = activeWorkspaceUri;
  if (targetScope === 'project' && !targetUri) return;

  try {
    const res = await postJson('/api/files/rename', {
      ...fileScopePayload(targetScope, targetUri),
      filename,
      newFilename,
    });
    if (targetScope !== activeFilesScope) return;
    if (targetScope === 'project' && targetUri !== activeWorkspaceUri) return;
    filesList = Array.isArray(res?.files) ? res.files : filesList;
    renderFiles();
  } catch (err) {
    console.error('Failed to rename file:', err);
    showFilesStatus(err.message || 'Failed to rename file', true, 5000);
    renderFiles();
  }
}

async function handleDeleteFile(filename) {
  const targetScope = activeFilesScope;
  const targetUri = activeWorkspaceUri;
  if (targetScope === 'project' && !targetUri) return;

  try {
    const res = await postJson('/api/files/delete', {
      ...fileScopePayload(targetScope, targetUri),
      filename,
    });
    if (targetScope !== activeFilesScope) return;
    if (targetScope === 'project' && targetUri !== activeWorkspaceUri) return;
    filesList = Array.isArray(res?.files) ? res.files : [];
    renderFiles();
  } catch (err) {
    console.error('Failed to delete file:', err);
    showFilesStatus(err.message || 'Failed to delete file', true, 5000);
  }
}

async function handleOpenFile(filename, editorOverride) {
  const targetScope = activeFilesScope;
  const targetUri = activeWorkspaceUri;
  if (targetScope === 'project' && !targetUri) return;

  const payload = {
    ...fileScopePayload(targetScope, targetUri),
    filename,
  };
  if (editorOverride) {
    payload.editor = editorOverride;
  }

  try {
    await postJson('/api/files/open', payload);
  } catch (err) {
    console.error('Failed to open file:', err);
    showFilesStatus(err.message || 'Failed to open file in editor', true, 5000);
  }
}

async function handleUploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const targetScope = activeFilesScope;
  const targetUri = activeWorkspaceUri;
  if (targetScope === 'project' && !targetUri) {
    showFilesStatus('Open a workspace before uploading project files.', true, 4000);
    return;
  }

  const errors = [];
  let savedCount = 0;

  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`"${file.name}" exceeds 10 MB limit`);
      continue;
    }

    try {
      const buffer = await file.arrayBuffer();
      const content = arrayBufferToBase64(buffer);
      const res = await postJson('/api/files/save', {
        ...fileScopePayload(targetScope, targetUri),
        filename: file.name,
        content,
        encoding: 'base64',
      });
      savedCount += 1;
      if (
        targetScope === activeFilesScope &&
        (targetScope !== 'project' || targetUri === activeWorkspaceUri)
      ) {
        filesList = Array.isArray(res?.files) ? res.files : filesList;
        renderFiles();
      }
    } catch (err) {
      errors.push(`"${file.name}": ${err.message || 'upload failed'}`);
    }
  }

  if (errors.length > 0) {
    showFilesStatus(errors.join('; '), true, 6000);
  } else if (savedCount > 0) {
    showFilesStatus(savedCount === 1 ? 'File saved' : `${savedCount} files saved`, false, 2000);
  }
}

async function saveEditorSettings(defaultEditor, customEditorCommand) {
  editorSettingsErrorEl.hidden = true;
  editorSettingsErrorEl.textContent = '';

  try {
    const res = await postJson('/api/settings', {
      defaultEditor,
      customEditorCommand,
    });
    if (res?.settings) {
      editorSettings = {
        defaultEditor: res.settings.defaultEditor || 'system',
        customEditorCommand: res.settings.customEditorCommand || '',
      };
    }
    renderEditorSettings();
    showFilesStatus('Editor preference saved', false, 2000);
  } catch (err) {
    editorSettingsErrorEl.textContent = err.message || 'Failed to save editor setting';
    editorSettingsErrorEl.hidden = false;
  }
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
  editingFileName = null;
  openMenuForFile = null;
  filesList = [];
  notesInputEl.value = '';
  notesInputEl.disabled = true;
  closeLinkForm();
  closeAllFilePanels();
  showFilesStatus('');
  emptyStateEl.hidden = true;
  appShellEl.hidden = false;
  renderHeader();
  renderWorkspaceSelector();
  renderLinks();
  renderTodos();
  renderFiles();
  setStatus('saving', 'Loading…');

  const filesPromise = loadFiles(activeFilesScope, nextUri);

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

  await filesPromise;
}

async function refreshActiveWorkspace() {
  if (refreshInFlight) return;
  if (!activeWorkspaceUri && activeFilesScope === 'project') return;

  refreshInFlight = true;
  const targetUri = activeWorkspaceUri;
  const targetScope = activeFilesScope;
  const startLoadSeq = loadSeq;
  const startFilesLoadSeq = filesLoadSeq;

  try {
    const params = new URLSearchParams({ scope: targetScope });
    if (targetScope === 'project' && targetUri) {
      params.set('workspaceUri', targetUri);
    }

    try {
      const filesData = await sidecarRequest(`/api/files?${params.toString()}`);
      if (
        targetScope === activeFilesScope &&
        startFilesLoadSeq === filesLoadSeq &&
        (targetScope !== 'project' || targetUri === activeWorkspaceUri)
      ) {
        const nextFiles = Array.isArray(filesData?.files) ? filesData.files : [];
        if (
          !editingFileName &&
          !openMenuForFile &&
          haveFilesListChanged(filesList, nextFiles)
        ) {
          filesList = nextFiles;
          renderFiles();
        }
      }
    } catch (err) {
      console.error('Failed to refresh files:', err);
    }

    if (targetUri && targetUri === activeWorkspaceUri && startLoadSeq === loadSeq) {
      try {
        const nextScratchpad = await sidecarRequest(
          `/api/scratchpad?workspaceUri=${encodeURIComponent(targetUri)}`
        );
        if (
          targetUri === activeWorkspaceUri &&
          startLoadSeq === loadSeq &&
          nextScratchpad
        ) {
          scratchpad = nextScratchpad;
          notesInputEl.disabled = false;
          renderHeader();
          renderLinks();
          if (!editingTodoId) {
            renderTodos();
          }
          if (
            shouldApplyNotesRefresh({
              isFocused: document.activeElement === notesInputEl,
              hasPending: autosaver.hasPending(),
            })
          ) {
            renderNotes();
          }
        }
      } catch (err) {
        console.error('Failed to refresh scratchpad:', err);
      }
    }
  } finally {
    refreshInFlight = false;
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
        filesLoadSeq++;
        activeWorkspaceUri = null;
        scratchpad = null;
        editingTodoId = null;
        editingFileName = null;
        openMenuForFile = null;
        filesList = [];
        closeLinkForm();
        closeAllFilePanels();
        showFilesStatus('');
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

filesTabProjectEl.addEventListener('click', () => {
  if (activeFilesScope === 'project') return;
  activeFilesScope = 'project';
  editingFileName = null;
  openMenuForFile = null;
  filesList = [];
  showFilesStatus('');
  renderFiles();
  void loadFiles('project', activeWorkspaceUri);
});

filesTabGlobalEl.addEventListener('click', () => {
  if (activeFilesScope === 'global') return;
  activeFilesScope = 'global';
  editingFileName = null;
  openMenuForFile = null;
  filesList = [];
  showFilesStatus('');
  renderFiles();
  void loadFiles('global', activeWorkspaceUri);
});

fileNewBtnEl.addEventListener('click', () => {
  if (fileNewFormEl.hidden) {
    openNewFileForm();
  } else {
    closeNewFileForm();
  }
});

fileNewCancelBtnEl.addEventListener('click', () => {
  closeNewFileForm();
});

fileNewFormEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeNewFileForm();
  }
});

fileNewFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const targetScope = activeFilesScope;
  const targetUri = activeWorkspaceUri;
  if (targetScope === 'project' && !targetUri) return;

  const filename = normalizeNewMarkdownFilename(fileNewNameInputEl.value);
  if (!filename) {
    fileNewErrorEl.textContent = 'Filename is required';
    fileNewErrorEl.hidden = false;
    return;
  }

  const content = fileNewContentInputEl.value || '';
  fileNewErrorEl.hidden = true;
  fileNewErrorEl.textContent = '';

  try {
    const res = await postJson('/api/files/save', {
      ...fileScopePayload(targetScope, targetUri),
      filename,
      content,
      encoding: 'utf8',
    });
    if (
      targetScope === activeFilesScope &&
      (targetScope !== 'project' || targetUri === activeWorkspaceUri)
    ) {
      filesList = Array.isArray(res?.files) ? res.files : filesList;
      renderFiles();
    }
    closeNewFileForm();
  } catch (err) {
    fileNewErrorEl.textContent = err.message || 'Failed to save file';
    fileNewErrorEl.hidden = false;
  }
});

fileUploadBtnEl.addEventListener('click', () => {
  fileUploadInputEl.click();
});

fileUploadInputEl.addEventListener('change', async () => {
  const files = fileUploadInputEl.files;
  await handleUploadFiles(files);
  fileUploadInputEl.value = '';
});

filePathBtnEl.addEventListener('click', () => {
  if (filePathFormEl.hidden) {
    openPathImportForm();
  } else {
    closePathImportForm();
  }
});

filePathCancelBtnEl.addEventListener('click', () => {
  closePathImportForm();
});

filePathFormEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closePathImportForm();
  }
});

filePathFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const targetScope = activeFilesScope;
  const targetUri = activeWorkspaceUri;
  if (targetScope === 'project' && !targetUri) return;

  const sourcePath = filePathInputEl.value.trim();
  if (!sourcePath) {
    filePathErrorEl.textContent = 'Source file path is required';
    filePathErrorEl.hidden = false;
    return;
  }

  filePathErrorEl.hidden = true;
  filePathErrorEl.textContent = '';

  try {
    const res = await postJson('/api/files/import', {
      ...fileScopePayload(targetScope, targetUri),
      sourcePath,
    });
    if (
      targetScope === activeFilesScope &&
      (targetScope !== 'project' || targetUri === activeWorkspaceUri)
    ) {
      filesList = Array.isArray(res?.files) ? res.files : filesList;
      renderFiles();
    }
    closePathImportForm();
  } catch (err) {
    filePathErrorEl.textContent = err.message || 'Failed to import file';
    filePathErrorEl.hidden = false;
  }
});

editorSettingsBtnEl.addEventListener('click', () => {
  if (editorSettingsPanelEl.hidden) {
    openEditorSettingsPanel();
  } else {
    closeEditorSettingsPanel();
  }
});

editorSettingsPanelEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeEditorSettingsPanel();
  }
});

editorDefaultSelectEl.addEventListener('change', () => {
  const chosen = editorDefaultSelectEl.value;
  editorSettingsErrorEl.hidden = true;
  editorSettingsErrorEl.textContent = '';

  if (chosen === 'custom') {
    editorCustomFormEl.hidden = false;
    editorCustomInputEl.value = editorSettings?.customEditorCommand || '';
    editorCustomInputEl.focus();
    return;
  }

  editorCustomFormEl.hidden = true;
  void saveEditorSettings(chosen, editorSettings?.customEditorCommand || '');
});

editorCustomFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const cmd = editorCustomInputEl.value.trim();
  if (!cmd) {
    editorSettingsErrorEl.textContent = 'Custom editor command is required';
    editorSettingsErrorEl.hidden = false;
    return;
  }
  void saveEditorSettings('custom', cmd);
});

filesSectionEl.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  filesSectionEl.classList.add('is-drag-over');
  filesDropHintEl.hidden = false;
});

filesSectionEl.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
});

filesSectionEl.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    filesSectionEl.classList.remove('is-drag-over');
    filesDropHintEl.hidden = true;
  }
});

filesSectionEl.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  filesSectionEl.classList.remove('is-drag-over');
  filesDropHintEl.hidden = true;
  const files = event.dataTransfer?.files;
  if (files && files.length > 0) {
    void handleUploadFiles(files);
  }
});

document.addEventListener('click', (event) => {
  if (!openMenuForFile) return;
  if (event.target instanceof Element && event.target.closest('.open-split')) {
    return;
  }
  openMenuForFile = null;
  renderFiles();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenuForFile !== null) {
    openMenuForFile = null;
    renderFiles();
  }
});

filesListEl.addEventListener('scroll', () => {
  if (openMenuForFile !== null) {
    openMenuForFile = null;
    renderFiles();
  }
});

appShellEl.addEventListener('scroll', () => {
  if (openMenuForFile !== null) {
    openMenuForFile = null;
    renderFiles();
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
  } else if (document.visibilityState === 'visible') {
    void refreshActiveWorkspace();
  }
});

window.addEventListener('focus', () => {
  void refreshActiveWorkspace();
});

setInterval(() => {
  if (document.visibilityState === 'visible') {
    void refreshActiveWorkspace();
  }
}, 3000);

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

function showEmptyStateDetail(message) {
  const descEl = emptyStateEl?.querySelector('.empty-description');
  if (descEl) {
    descEl.textContent = message;
  }
}

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
    if (workspaceUris.length === 0) {
      const detail = err instanceof Error ? err.message : String(err);
      showEmptyStateDetail(`Unable to read workspace metadata (${detail}). Try toggling the plugin or reopening the pane.`);
    }
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

})();
