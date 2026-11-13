import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const panelDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(panelDir, '..', '..');

const ALLOWED_PLUGIN_KEYS = new Set([
  'name', 'description', 'logo', 'suggestedPrompts', 'displayName',
  'version', 'author', 'homepage', 'repository', 'disabled'
]);

test('plugin.json conforms to Antigravity plugin schema and references existing SVG logo', () => {
  const pkg = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
  assert.equal(pkg.name, 'agy-todo');
  assert.equal(pkg.displayName, 'AGY Todo');
  assert.equal(pkg.logo, 'assets/logo.svg');
  assert.equal('suggestedPrompts' in pkg, false);
  for (const key of Object.keys(pkg)) {
    assert.ok(ALLOWED_PLUGIN_KEYS.has(key), `Disallowed plugin.json key: ${key}`);
  }
  const logoSvg = readFileSync(join(pluginRoot, pkg.logo), 'utf8');
  assert.match(logoSvg, /<svg[\s>]/);
  assert.match(logoSvg, /viewBox="0 0 128 128"/);
});

test('sidecar.json uses snake_case AUX_PANE schema and ESM package.json', () => {
  const sidecar = JSON.parse(readFileSync(join(panelDir, 'sidecar.json'), 'utf8'));
  assert.equal(sidecar.command, 'node');
  assert.deepEqual(sidecar.args, ['main.mjs']);
  assert.equal(sidecar.restart_policy, 'always');
  assert.equal(sidecar.has_web_ui, true);
  assert.deepEqual(sidecar.ui_config?.views, [{
    path: '/',
    entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    title: 'AGY Todo'
  }]);
  const panelPkg = JSON.parse(readFileSync(join(panelDir, 'package.json'), 'utf8'));
  assert.equal(panelPkg.type, 'module');
  assert.equal(existsSync(join(pluginRoot, '.gitignore')), true);
});
