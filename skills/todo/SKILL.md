---
name: todo
description: Save markdown files, todos, links, or notes to the AGY Todo (agy-todo) scratchpad panel. Use ONLY when the user explicitly names AGY Todo, agy-todo, the Todo/scratchpad panel, or invokes /todo.
---

# AGY Todo (`/todo`)

Route requests for AGY Todo through the `agy-todo` MCP tools so files and scratchpad items stay isolated in AGY Todo sidecar storage without writing into the project repository.

## Tool Mapping

- **Save or append a markdown doc / note file:** `save_file` (`filename` defaults to `.md`; `overwrite: false` auto-suffixes collisions `-2`, `-3`; use `append: true` to append verbatim or create if missing; set `overwrite: true` only when replacing the full file).
- **Edit an existing text file in place:** `edit_file` (exact verbatim `target` → `replacement` on the exact filename; replaces every occurrence).
- **List or read saved files:** `list_files`, `read_file` (supports optional `startLine`, `endLine`, `byteOffset` for UTF-8 paging).
- **Add or toggle a checklist item:** `add_todo`, `toggle_todo`.
- **Append or replace scratchpad notes:** `append_notes` (`mode: "append"` or `"replace"`).
- **Save a URL / inspect current state:** `add_link`, `get_scratchpad`.

## Scope & Reporting

1. Pass the active project workspace root path as `workspaceUri` (`scope: "project"` by default; use `scope: "global"` only when the user asks for global/cross-project storage).
2. Confirm the saved `savedFile.name` (noting if auto-renamed) and `scope` in your reply.
