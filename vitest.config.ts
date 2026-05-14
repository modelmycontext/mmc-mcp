import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Production imports `bun:sqlite`; Vitest workers run on Node, so we
      // route to a `node:sqlite`-backed shim. See tests/_shims/bun-sqlite.ts.
      'bun:sqlite': path.resolve(__dirname, './tests/_shims/bun-sqlite.ts'),
      '@connectors': path.resolve(__dirname, './connectors'),
      '@sdk': path.resolve(__dirname, './sdk'),
      '@src': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
