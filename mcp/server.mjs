import { realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_READ_LINES,
  MAX_FILE_BYTES,
  createFileStore,
} from '../sidecars/panel/files-store.mjs';
import { ValidationError, createStore } from '../sidecars/panel/store.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'agy-todo',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'save_file',
    description:
      'Save or append a file (such as a Markdown document) to AGY Todo sidecar storage without writing into the project repository. Extensionless non-dotfiles default to .md. Collisions auto-suffix (-2, -3) unless overwrite or append is true.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Single-segment file name. Extensionless non-dotfiles default to .md.',
        },
        content: {
          type: 'string',
          description: `File contents (utf8 text or base64 bytes). Maximum decoded size is ${MAX_FILE_BYTES} bytes.`,
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          default: 'project',
          description: 'Storage scope ("project" requires workspaceUri; "global" is shared across projects).',
        },
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI (required when scope is "project").',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          default: 'utf8',
          description: 'Content encoding.',
        },
        overwrite: {
          type: 'boolean',
          default: false,
          description: 'Replace an existing file with the same name when true; otherwise auto-rename.',
        },
        append: {
          type: 'boolean',
          default: false,
          description:
            'Append content verbatim to an existing file (or create it if missing). Cannot be combined with overwrite=true.',
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Edit an existing UTF-8 text file in AGY Todo sidecar storage by replacing exact target text with replacement text. Use for a single contiguous block of edits; make separate calls for non-adjacent regions. Target must match existing text verbatim including whitespace; every occurrence of target in the file is replaced. Leave replacement empty to delete target.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Single-segment file name to edit (exact filename, no .md auto-append).',
        },
        target: {
          type: 'string',
          description: 'Exact verbatim text to replace, including whitespace.',
        },
        replacement: {
          type: 'string',
          description: 'Replacement text (use an empty string to delete target).',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          default: 'project',
          description: 'Storage scope ("project" requires workspaceUri; "global" is shared across projects).',
        },
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI (required when scope is "project").',
        },
      },
      required: ['filename', 'target', 'replacement'],
    },
  },
  {
    name: 'list_files',
    description: 'List saved files in AGY Todo sidecar storage for the project or global scope.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          default: 'project',
          description: 'Storage scope.',
        },
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI (required when scope is "project").',
        },
      },
    },
  },
  {
    name: 'read_file',
    description: `Read a saved file from AGY Todo sidecar storage. Each UTF-8 read returns at most ${DEFAULT_MAX_READ_LINES} lines or ${DEFAULT_MAX_READ_BYTES} bytes.`,
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Single-segment file name to read.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          default: 'project',
          description: 'Storage scope.',
        },
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI (required when scope is "project").',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          default: 'utf8',
          description: 'Output content encoding.',
        },
        startLine: {
          type: 'integer',
          minimum: 1,
          description: '1-based inclusive start line to read (utf8 encoding only).',
        },
        endLine: {
          type: 'integer',
          minimum: 1,
          description: '1-based inclusive end line to read (utf8 encoding only).',
        },
        byteOffset: {
          type: 'integer',
          minimum: 0,
          description: 'Byte offset into the selected line range for paging truncated UTF-8 reads.',
        },
      },
      required: ['filename'],
    },
  },
  {
    name: 'get_scratchpad',
    description: 'Get the AGY Todo scratchpad (todos, links, and notes) for a project workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI.',
        },
      },
      required: ['workspaceUri'],
    },
  },
  {
    name: 'add_todo',
    description: 'Add a todo item to the AGY Todo scratchpad for a project workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI.',
        },
        text: {
          type: 'string',
          description: 'Todo item text.',
        },
      },
      required: ['workspaceUri', 'text'],
    },
  },
  {
    name: 'toggle_todo',
    description: 'Toggle or explicitly set completion status of a todo item in AGY Todo.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI.',
        },
        id: {
          type: 'string',
          description: 'Todo item ID (e.g., tod_...).',
        },
        done: {
          type: 'boolean',
          description: 'Optional target done state; toggles current state if omitted.',
        },
      },
      required: ['workspaceUri', 'id'],
    },
  },
  {
    name: 'append_notes',
    description: 'Append to or replace the Markdown scratchpad notes in AGY Todo for a project workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI.',
        },
        text: {
          type: 'string',
          description: 'Markdown note text.',
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          default: 'append',
          description: '"append" joins to existing non-empty notes with a blank line; "replace" overwrites.',
        },
      },
      required: ['workspaceUri', 'text'],
    },
  },
  {
    name: 'add_link',
    description: 'Add a quick link (http/https URL) to the AGY Todo scratchpad for a project workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceUri: {
          type: 'string',
          description: 'Workspace filesystem path or file:// URI.',
        },
        label: {
          type: 'string',
          default: '',
          description: 'Optional display label (defaults to URL hostname).',
        },
        url: {
          type: 'string',
          description: 'Link URL.',
        },
      },
      required: ['workspaceUri', 'url'],
    },
  },
];

function normalizeSaveFilename(filename) {
  if (typeof filename !== 'string') {
    throw new ValidationError('filename must be a string');
  }
  const trimmed = filename.trim();
  if (trimmed && !trimmed.startsWith('.') && !extname(trimmed)) {
    return `${trimmed}.md`;
  }
  return trimmed;
}

function makeToolResult(payload, isError = false) {
  const result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

function makeJsonRpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

/**
 * Create an AGY Todo MCP server instance handling JSON-RPC 2.0 messages.
 */
export function createMcpServer({ dataDir, store, fileStore } = {}) {
  const storeOptions = dataDir ? { dataDir } : {};
  const resolvedStore = store || createStore(storeOptions);
  const resolvedFileStore = fileStore || createFileStore(storeOptions);

  const toolHandlers = {
    async save_file(args) {
      const scope = args.scope === undefined ? 'project' : args.scope;
      const encoding = args.encoding === undefined ? 'utf8' : args.encoding;
      const overwrite = args.overwrite === undefined ? false : args.overwrite;
      const append = args.append === undefined ? false : args.append;
      const targetName = normalizeSaveFilename(args.filename);

      const result = await resolvedFileStore.saveFile({
        scope,
        workspaceUri: args.workspaceUri,
        filename: targetName,
        content: args.content,
        encoding,
        overwrite,
        append,
      });

      return {
        savedFile: result.savedFile,
        scope: result.scope,
        renamed: !overwrite && !append && result.savedFile.name !== targetName,
        overwritten: overwrite === true && result.existedBefore,
        appended: append === true && result.existedBefore,
      };
    },

    async edit_file(args) {
      const scope = args.scope === undefined ? 'project' : args.scope;
      const result = await resolvedFileStore.editFile({
        scope,
        workspaceUri: args.workspaceUri,
        filename: args.filename,
        target: args.target,
        replacement: args.replacement,
      });

      return {
        file: result.file,
        scope: result.scope,
        replacements: result.replacements,
      };
    },

    async list_files(args) {
      const scope = args.scope === undefined ? 'project' : args.scope;
      const result = await resolvedFileStore.listFiles(scope, args.workspaceUri);
      return {
        scope: result.scope,
        projectKey: result.projectKey,
        files: result.files,
      };
    },

    async read_file(args) {
      const scope = args.scope === undefined ? 'project' : args.scope;
      const encoding = args.encoding === undefined ? 'utf8' : args.encoding;
      return resolvedFileStore.readFile({
        scope,
        workspaceUri: args.workspaceUri,
        filename: args.filename,
        encoding,
        startLine: args.startLine,
        endLine: args.endLine,
        byteOffset: args.byteOffset,
      });
    },

    async get_scratchpad(args) {
      return resolvedStore.getScratchpad(args.workspaceUri);
    },

    async add_todo(args) {
      return resolvedStore.addTodo(args.workspaceUri, args.text);
    },

    async toggle_todo(args) {
      return resolvedStore.toggleTodo(args.workspaceUri, args.id, args.done);
    },

    async append_notes(args) {
      const mode = args.mode === undefined ? 'append' : args.mode;
      if (typeof args.text !== 'string') {
        throw new ValidationError('text must be a string');
      }
      if (mode !== 'append' && mode !== 'replace') {
        throw new ValidationError('mode must be "append" or "replace"');
      }
      if (mode === 'replace') {
        return resolvedStore.saveNotes(args.workspaceUri, args.text);
      }
      const pad = await resolvedStore.getScratchpad(args.workspaceUri);
      const existing = pad.notes || '';
      const nextNotes =
        existing.length > 0 && args.text.length > 0
          ? `${existing}\n\n${args.text}`
          : existing || args.text;
      return resolvedStore.saveNotes(args.workspaceUri, nextNotes);
    },

    async add_link(args) {
      const label = args.label === undefined ? '' : args.label;
      return resolvedStore.addLink(args.workspaceUri, label, args.url);
    },
  };

  async function handleToolCall(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return makeToolResult({ error: 'tools/call params must be an object' }, true);
    }
    const toolName = params.name;
    if (typeof toolName !== 'string' || !Object.hasOwn(toolHandlers, toolName)) {
      return makeToolResult({ error: `Unknown tool: ${String(toolName)}` }, true);
    }
    if (
      params.arguments !== undefined &&
      (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))
    ) {
      return makeToolResult({ error: 'Tool arguments must be an object' }, true);
    }

    const args = params.arguments || {};
    try {
      const output = await toolHandlers[toolName](args);
      return makeToolResult(output, false);
    } catch (error) {
      return makeToolResult(
        {
          error: error?.message || 'Tool execution failed',
          code: error?.code || 'INTERNAL_ERROR',
        },
        true,
      );
    }
  }

  async function handleJsonRpcMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      const errId = msg && typeof msg === 'object' && msg.id !== undefined ? msg.id : null;
      return makeJsonRpcError(errId, -32600, 'Invalid Request');
    }

    if (typeof msg.method !== 'string' || msg.method.length === 0) {
      const errId = msg.id !== undefined ? msg.id : null;
      return makeJsonRpcError(errId, -32600, 'Invalid Request');
    }

    // Notifications carry no id and must not receive a JSON-RPC response.
    if (msg.id === undefined) {
      return null;
    }

    switch (msg.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: SERVER_INFO,
          },
        };

      case 'ping':
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {},
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: TOOLS,
          },
        };

      case 'tools/call':
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: await handleToolCall(msg.params),
        };

      default:
        return makeJsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  return {
    tools: TOOLS,
    handleJsonRpcMessage,
  };
}

function parseCliArgs(argv) {
  let dataDir;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir' && i + 1 < argv.length) {
      dataDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    }
  }
  return { dataDir };
}

function runStdioServer() {
  const { dataDir } = parseCliArgs(process.argv.slice(2));
  const server = createMcpServer({ dataDir });
  const inFlight = new Set();
  let stdinBuffer = '';
  let stdinEnded = false;

  function writeResponse(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  function processLine(rawLine) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeResponse(makeJsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    const task = Promise.resolve()
      .then(() => server.handleJsonRpcMessage(parsed))
      .then((response) => {
        if (response !== null) {
          writeResponse(response);
        }
      })
      .catch((error) => {
        process.stderr.write(`agy-todo MCP request error: ${error?.stack || error}\n`);
        const errId =
          parsed && typeof parsed === 'object' && parsed.id !== undefined ? parsed.id : null;
        if (errId !== null) {
          writeResponse(makeJsonRpcError(errId, -32603, 'Internal error'));
        }
      })
      .finally(() => {
        inFlight.delete(task);
        if (stdinEnded && inFlight.size === 0) {
          process.exit(0);
        }
      });

    inFlight.add(task);
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuffer += chunk;
    let newlineIdx = stdinBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = stdinBuffer.slice(0, newlineIdx);
      stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
      processLine(line);
      newlineIdx = stdinBuffer.indexOf('\n');
    }
  });

  process.stdin.on('end', () => {
    stdinEnded = true;
    if (stdinBuffer.trim().length > 0) {
      const trailing = stdinBuffer;
      stdinBuffer = '';
      processLine(trailing);
    }
    if (inFlight.size === 0) {
      process.exit(0);
    }
  });

  process.stdin.on('error', (error) => {
    process.stderr.write(`agy-todo MCP stdin error: ${error?.stack || error}\n`);
    process.exit(1);
  });
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isDirectExecution) {
  runStdioServer();
}
