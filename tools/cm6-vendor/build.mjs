import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const vendorDir = dirname(fileURLToPath(import.meta.url));
const entryPoint = join(vendorDir, 'entry.mjs');
const outfile = join(vendorDir, '..', '..', 'sidecars', 'panel', 'public', 'vendor', 'cm6-bundle.js');

mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'AGYCodeMirror',
  platform: 'browser',
  target: 'es2020',
  outfile,
  banner: {
    js: '/* Pre-built CodeMirror 6 + Lezer Markdown bundle for AGY Todo. Rebuild via tools/cm6-vendor. */',
  },
});

const { size } = statSync(outfile);
console.log(`Built ${outfile} (${size} bytes)`);
