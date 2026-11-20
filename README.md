# AGY Todo (`agy-todo`)

A lightweight, project-scoped personal scratchpad plugin for Antigravity. It runs an Auxiliary Pane sidecar (`agy-todo/panel`) that automatically tracks the active workspace—unifying linked Git worktrees under the same canonical repository—without writing any files into target project repositories.

## Features

- **Links strip:** Save quick project URLs (`http`/`https`) with inline capture and one-click removal.
- **Todos checklist:** Quick-add tasks, toggle completion, inline edit, and clear completed items.
- **Files shelf:** Project and Global tabs above Notes; upload via picker or drag-and-drop, create inline with `+ New .md`, or import by local path (10 MB limit, duplicate auto-renaming); copy `@<path>` mentions to attach, copy raw paths, open in external editors (`subl`, `code`, `cursor`, `agy`, system default, or custom), rename, and delete.
- **Auto-saving notes:** Freeform notes pad that persists across workspace switches.
- **Export `.md`:** Copy or download the active project's scratchpad as Markdown.
- **Agent MCP & `/todo` skill:** Exposes an `agy-todo` stdio MCP server (`save_file`, `edit_file`, `list_files`, `read_file`, `get_scratchpad`, `add_todo`, `toggle_todo`, `append_notes`, `add_link`) and a `/todo` skill so agents can save docs, todos, links, and notes directly into AGY Todo without touching target repositories, with live panel refresh.
- **Zero dependencies & zero build step:** Uses only Node.js built-in modules, Antigravity `sidecar_sdk`, and vanilla HTML/CSS/JS.

## Installation

Clone the repository anywhere on your machine and symlink it into `~/.gemini/config/plugins/agy-todo`. Only Node.js is required; there is no `npm install` or build step.

```bash
git clone https://github.com/ankemp/agy-todo.git /path/to/agy-todo
mkdir -p ~/.gemini/config/plugins
ln -s /path/to/agy-todo ~/.gemini/config/plugins/agy-todo
```

Use an absolute source path in `ln -s`, because relative symlink targets resolve from `~/.gemini/config/plugins/`. Keep the link named `agy-todo` to match `plugin.json`. Antigravity keys plugin configuration on the directory name, and `mcp_config.json` resolves `${PLUGIN_ROOT}/mcp/server.mjs` from it.

Antigravity 2.0 and the `agy` CLI both load plugins from `~/.gemini/config/plugins/`. In Antigravity 2.0, restart or reload the app if it was already open so it starts the `agy-todo` MCP server and `agy-todo/panel` sidecar. Open Skills & Customizations in the left sidebar to confirm AGY Todo is enabled, then open the AGY Todo tab in the Auxiliary Pane (or type `/todo` in chat).

If you use the `agy` CLI, you can validate and list the plugin from a terminal:

```bash
agy plugin validate ~/.gemini/config/plugins/agy-todo
agy plugin list
```

## Layout

- `plugin.json` — Antigravity plugin manifest.
- `mcp_config.json` — Antigravity MCP server configuration registering `agy-todo`.
- `mcp/server.mjs` — Zero-dependency JSON-RPC 2.0 stdio MCP server exposing AGY Todo tools.
- `skills/todo/SKILL.md` — `/todo` skill routing explicit AGY Todo requests through `agy-todo` MCP tools.
- `assets/logo.svg` — 128×128 plugin icon.
- `sidecars/panel/sidecar.json` — Auxiliary Pane sidecar manifest (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).
- `sidecars/panel/package.json` — ESM Node configuration (`"type": "module"`).
- `sidecars/panel/files-store.mjs` — Project- and global-scoped sidecar file storage and editor settings persistence.
- `sidecars/panel/editor.mjs` — Cross-platform external editor launcher (`subl`, `code`, `cursor`, `agy`, system default, or custom command).

## Testing

```bash
cd sidecars/panel && npm test
```
