# AGY Todo (`agy-todo`)

A lightweight, project-scoped personal scratchpad plugin for Antigravity. It runs an Auxiliary Pane sidecar (`agy-todo/panel`) that automatically tracks the active workspace—unifying linked Git worktrees under the same canonical repository—without writing any files into target project repositories.

## Features

- **Links strip:** Save quick project URLs (`http`/`https`) with inline capture and one-click removal.
- **Todos checklist:** Quick-add tasks, toggle completion, inline edit, and clear completed items.
- **Files shelf:** Project and Global tabs above Notes; upload via picker or drag-and-drop, create inline with `+ New .md`, or import by local path (10 MB limit, duplicate auto-renaming); copy `@<path>` mentions to attach, copy raw paths, open in external editors (`subl`, `code`, `cursor`, `agy`, system default, or custom), rename, and delete.
- **Auto-saving notes:** Freeform notes pad that persists across workspace switches.
- **Export `.md`:** Copy or download the active project's scratchpad as Markdown.
- **Zero dependencies & zero build step:** Uses only Node.js built-in modules, Antigravity `sidecar_sdk`, and vanilla HTML/CSS/JS.

## Layout

- `plugin.json` — Antigravity plugin manifest.
- `assets/logo.svg` — 128×128 plugin icon.
- `sidecars/panel/sidecar.json` — Auxiliary Pane sidecar manifest (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).
- `sidecars/panel/package.json` — ESM Node configuration (`"type": "module"`).
- `sidecars/panel/files-store.mjs` — Project- and global-scoped sidecar file storage and editor settings persistence.
- `sidecars/panel/editor.mjs` — Cross-platform external editor launcher (`subl`, `code`, `cursor`, `agy`, system default, or custom command).

## Testing

```bash
cd sidecars/panel && npm test
```
