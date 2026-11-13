# AGY Todo (`agy-todo`)

A lightweight, project-scoped personal scratchpad plugin for Antigravity. It runs an Auxiliary Pane sidecar (`agy-todo/panel`) that automatically tracks the active workspace—unifying linked Git worktrees under the same canonical repository—without writing any files into target project repositories.

## Features

- **Links strip:** Save quick project URLs (`http`/`https`) with inline capture and one-click removal.
- **Todos checklist:** Quick-add tasks, toggle completion, inline edit, and clear completed items.
- **Auto-saving notes:** Freeform notes pad that persists across workspace switches.
- **Export `.md`:** Copy or download the active project's scratchpad as Markdown.
- **Zero dependencies & zero build step:** Uses only Node.js built-in modules, Antigravity `sidecar_sdk`, and vanilla HTML/CSS/JS.

## Layout

- `plugin.json` — Antigravity plugin manifest.
- `assets/logo.svg` — 128×128 plugin icon.
- `sidecars/panel/sidecar.json` — Auxiliary Pane sidecar manifest (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).
- `sidecars/panel/package.json` — ESM Node configuration (`"type": "module"`).

## Testing

```bash
cd sidecars/panel && npm test
```
