import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, join } from 'node:path';

import { ValidationError } from './store.mjs';

function buildEditorConfigs() {
  const home = homedir();
  return {
    subl: {
      cli: 'subl',
      appName: 'Sublime Text',
      macBundlePaths: [
        '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl',
        join(home, 'Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'),
      ],
      homebrewPaths: ['/opt/homebrew/bin/subl', '/usr/local/bin/subl'],
    },
    code: {
      cli: 'code',
      appName: 'Visual Studio Code',
      macBundlePaths: [
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        join(home, 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
      ],
      homebrewPaths: ['/opt/homebrew/bin/code', '/usr/local/bin/code'],
    },
    cursor: {
      cli: 'cursor',
      appName: 'Cursor',
      macBundlePaths: [
        '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
        join(home, 'Applications/Cursor.app/Contents/Resources/app/bin/cursor'),
      ],
      homebrewPaths: ['/opt/homebrew/bin/cursor', '/usr/local/bin/cursor'],
    },
    agy: {
      cli: 'agy',
      appName: 'Antigravity',
      macBundlePaths: [
        '/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
        join(home, 'Applications/Antigravity.app/Contents/Resources/app/bin/agy'),
      ],
      homebrewPaths: ['/opt/homebrew/bin/agy', '/usr/local/bin/agy'],
    },
  };
}

function isExecutableFile(candidate, platform) {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      return false;
    }
    if (platform !== 'win32') {
      accessSync(candidate, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function defaultWhich(bin, platform) {
  const pathEnv = process.env.PATH || '';
  if (!pathEnv) {
    return null;
  }
  const sep = platform === 'win32' ? ';' : delimiter;
  const dirs = pathEnv.split(sep).filter(Boolean);
  const exts =
    platform === 'win32' && !extname(bin)
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${bin}${ext}`);
      if (isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Split a command line string into argv tokens with single/double quote and backslash support.
 * Never invokes a shell.
 */
export function splitCommandArgs(commandLine) {
  if (typeof commandLine !== 'string') {
    throw new ValidationError('Custom editor command must be a non-empty string');
  }
  if (/[\r\n\0]/.test(commandLine)) {
    throw new ValidationError('Custom editor command contains invalid control characters');
  }

  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\') {
        const next = commandLine[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }

    inToken = true;

    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '\\') {
      if (i + 1 >= commandLine.length) {
        throw new ValidationError('Custom editor command has a trailing backslash');
      }
      current += commandLine[i + 1];
      i += 1;
    } else {
      current += ch;
    }
  }

  if (quote !== null) {
    throw new ValidationError('Custom editor command has an unclosed quote');
  }

  if (inToken) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new ValidationError('Custom editor command cannot be empty');
  }

  return tokens;
}

/**
 * Resolve the executable command and argument array for opening a file in an external editor.
 */
export function resolveEditorInvocation(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '' || filePath.includes('\0')) {
    throw new ValidationError('A valid file path is required');
  }

  const editor = options.editor || 'system';
  const platform = options.platform || process.platform;
  const existsFn = options.existsFn || existsSync;
  const whichFn = options.whichFn || ((bin) => defaultWhich(bin, platform));

  if (editor === 'system') {
    if (platform === 'darwin') {
      return { command: 'open', args: [filePath] };
    }
    if (platform === 'win32') {
      return { command: 'cmd', args: ['/c', 'start', '', filePath] };
    }
    return { command: 'xdg-open', args: [filePath] };
  }

  if (editor === 'custom') {
    const tokens = splitCommandArgs(options.customCommand);
    return { command: tokens[0], args: [...tokens.slice(1), filePath] };
  }

  const configs = buildEditorConfigs();
  const config = configs[editor];
  if (!config) {
    throw new ValidationError(`Unsupported editor: ${editor}`);
  }

  const fromPath = whichFn(config.cli);
  if (typeof fromPath === 'string' && fromPath.length > 0) {
    return { command: fromPath, args: [filePath] };
  }

  if (platform === 'darwin') {
    const candidates = [...config.macBundlePaths, ...config.homebrewPaths];
    for (const candidate of candidates) {
      if (existsFn(candidate)) {
        return { command: candidate, args: [filePath] };
      }
    }
    return { command: 'open', args: ['-a', config.appName, filePath] };
  }

  throw new ValidationError(`Editor CLI "${config.cli}" was not found in PATH`);
}

/**
 * Launch the resolved external editor detached without invoking a shell.
 */
export async function openFileInEditor(filePath, options = {}) {
  const editor = options.editor || 'system';
  const { command, args } = resolveEditorInvocation(filePath, options);
  const spawnFn = options.spawnFn || spawn;

  const child = spawnFn(command, args, {
    detached: true,
    stdio: 'ignore',
  });

  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = () => {
      if (typeof child?.removeListener === 'function') {
        child.removeListener('error', onError);
      } else if (typeof child?.off === 'function') {
        child.off('error', onError);
      }
    };
    const onError = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(
        new ValidationError(
          `Failed to launch editor "${command}": ${err?.message || String(err)}`,
        ),
      );
    };

    if (typeof child?.once === 'function') {
      child.once('error', onError);
    } else if (typeof child?.on === 'function') {
      child.on('error', onError);
    }

    setImmediate(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (typeof child?.unref === 'function') {
        child.unref();
      }
      resolvePromise();
    });
  });

  return { ok: true, editor, command, args };
}
