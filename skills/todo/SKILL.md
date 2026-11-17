---
name: todo
description: Save markdown files, todos, links, or notes to the AGY Todo (agy-todo) scratchpad panel. Use ONLY when the user explicitly names AGY Todo, agy-todo, the Todo/scratchpad panel, or invokes /todo.
---

# AGY Todo (`/todo`)

Route requests for AGY Todo through the `agy-todo` MCP tools so files and scratchpad items stay isolated in AGY Todo sidecar storage without writing into the project repository.

## Tool Mapping

- **Save a markdown doc / note file:** `save_file` (`filename` defaults to `.md`; `overwrite: false` by default so collisions auto-suffix `-2`, `-3`; set `overwrite: true` ONLY when the user explicitly asks to update or overwrite an existing file).
- **List or read saved files:** `list_files`, `read_file`.
- **Add or toggle a checklist item:** `add_todo`, `toggle_todo`.
- **Append or replace scratchpad notes:** `append_notes` (`mode: "append"` or `"replace"`).
- **Save a URL / inspect current state:** `add_link`, `get_scratchpad`.

## Scope & Reporting

1. Pass the active project workspace root path as `workspaceUri` (`scope: "project"` by default; use `scope: "global"` only when the user asks for global/cross-project storage).
2. Confirm the saved `savedFile.name` (noting if auto-renamed) and `scope` in your reply.
