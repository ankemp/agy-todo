import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = join(__dirname, '..', 'public', 'styles.css');

function readStyles() {
  return readFileSync(STYLES_PATH, 'utf8');
}

test('styles.css binds all 20 AGY host tokens and avoids --destructive', () => {
  const css = readStyles();

  const requiredHostTokens = [
    '--background',
    '--foreground',
    '--card',
    '--card-foreground',
    '--card-border',
    '--border',
    '--primary',
    '--primary-foreground',
    '--secondary',
    '--secondary-foreground',
    '--muted',
    '--muted-foreground',
    '--accent',
    '--accent-foreground',
    '--error',
    '--placeholder',
    '--code-foreground',
    '--ring',
    '--font-family',
    '--editor-font-family',
  ];

  for (const token of requiredHostTokens) {
    assert.ok(css.includes(token), `Expected styles.css to bind host token ${token}`);
  }

  assert.ok(!css.includes('--destructive'), 'styles.css must use --error, not --destructive');
});

test('styles.css supports data-theme="dark" and scopes OS dark fallback to :root:not([data-theme="light"])', () => {
  const css = readStyles();

  assert.match(
    css,
    /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark;/,
    'Expected :root[data-theme="dark"] with color-scheme: dark',
  );
  assert.match(
    css,
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/,
    'Expected @media (prefers-color-scheme: dark) scoped to :root:not([data-theme="light"])',
  );
  assert.match(css, /--ui-success:\s*#63984f/, 'Expected light --ui-success hue');
  assert.match(css, /--ui-warning:\s*#bca136/, 'Expected light --ui-warning hue');
  assert.match(css, /--ui-success:\s*#7aae66/, 'Expected dark --ui-success hue');
  assert.match(css, /--ui-warning:\s*#cab43e/, 'Expected dark --ui-warning hue');
});

test('styles.css overrides preload.js body font and configures Google Sans Flex variation axes', () => {
  const css = readStyles();

  assert.match(
    css,
    /font-family:\s*var\(--ui-font\)\s*!important;/,
    'Expected body font-family: var(--ui-font) !important',
  );
  assert.match(
    css,
    /font-variation-settings:\s*"ROND"\s*0,\s*"slnt"\s*0,\s*"wdth"\s*92/,
    'Expected body font-variation-settings',
  );
  assert.match(
    css,
    /font-variation-settings:\s*"ROND"\s*20,\s*"slnt"\s*0,\s*"wdth"\s*100/,
    'Expected heading font-variation-settings',
  );
  assert.match(css, /font-variant-ligatures:\s*no-contextual/, 'Expected no-contextual ligatures');
  assert.match(css, /font-variant-numeric:\s*tabular-nums/, 'Expected tabular-nums on counts/sizes');
});

test('styles.css defines centered 760px column, sticky header, skeleton/empty/toast states, controls, scrollbars, focus rings, and reduced motion', () => {
  const css = readStyles();

  assert.match(css, /--col:\s*760px;/, 'Expected 760px max column token');
  assert.match(
    css,
    /--inline:\s*max\(var\(--pad-x\),\s*calc\(\(100%\s*-\s*var\(--col\)\)\s*\/\s*2\)\);/,
    'Expected --inline centered gutter calculation',
  );

  const requiredSelectors = [
    '.app-shell',
    '.app-header',
    '.app-header.is-stuck',
    '.loading',
    '.skel',
    '.empty-state',
    '.empty-card',
    '.empty-icon',
    '.select',
    '.segmented',
    '.scope-tab',
    '.link-pill',
    '.todo-item',
    '.file-row',
    '.file-name',
    '.open-with-menu',
    '.notes-input',
    '.toast',
    ':focus-visible',
    '::-webkit-scrollbar',
    '@media (prefers-reduced-motion: reduce)',
  ];

  for (const sel of requiredSelectors) {
    assert.ok(css.includes(sel), `Expected styles.css to include ${sel}`);
  }

  assert.match(css, /position:\s*sticky;/, 'Expected sticky .app-header');
  assert.match(css, /@keyframes\s+shimmer\b/, 'Expected @keyframes shimmer for .skel');
  assert.match(css, /@keyframes\s+rise\b/, 'Expected @keyframes rise for .empty-card');
  assert.match(css, /scrollbar-width:\s*thin;/, 'Expected thin Hub scrollbar styling');
  assert.match(css, /var\(--ui-ring\)/, 'Expected :focus-visible ring using --ui-ring');
});
