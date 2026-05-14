// Builds a fully-bundled Node.js-compatible output for the mcpb package.
// All npm dependencies are inlined. bun:sqlite is aliased to the Node 22 shim.
// Output: dist-mcpb/server/index.js
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-mcpb');
const serverOutDir = path.join(outDir, 'server');

fs.mkdirSync(serverOutDir, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(serverOutDir, 'index.js'),
  sourcemap: false,
  alias: {
    'bun:sqlite': path.join(root, 'src', 'shims', 'bun-sqlite.ts'),
    '@connectors': path.join(root, 'connectors'),
    '@sdk': path.join(root, 'sdk'),
    '@src': path.join(root, 'src'),
  },
  external: [
    // Genuine Node.js built-ins — present in every Node 22 install.
    'node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:http',
    'node:https', 'node:stream', 'node:crypto', 'node:os', 'node:util',
    'node:zlib', 'node:events', 'node:buffer', 'node:process',
    'node:child_process', 'node:net', 'node:tls', 'node:dns',
    'node:sqlite', 'node:worker_threads', 'node:async_hooks',
    // Bare versions of the above
    'fs', 'path', 'url', 'http', 'https', 'stream', 'crypto', 'os',
    'util', 'zlib', 'events', 'buffer', 'process', 'child_process',
    'net', 'tls', 'dns', 'worker_threads', 'async_hooks',
  ],
  logLevel: 'info',
});

// Copy manifest.json (required by mcpb pack) into the bundle root.
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(outDir, 'manifest.json'));
console.log('Copied manifest.json → dist-mcpb/manifest.json');

// Copy config/ into dist-mcpb/config/
const configSrc = path.join(root, 'config');
const configDst = path.join(outDir, 'config');
if (fs.existsSync(configSrc)) {
  fs.mkdirSync(configDst, { recursive: true });
  for (const f of fs.readdirSync(configSrc)) {
    fs.copyFileSync(path.join(configSrc, f), path.join(configDst, f));
  }
  console.log('Copied config/ →', configDst);
}

console.log('mcpb build complete →', outDir);
