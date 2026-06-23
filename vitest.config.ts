import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Source no longer imports `bun:sqlite` directly — it goes through the
      // runtime-detecting shim at src/shims/bun-sqlite.ts (Bun→bun:sqlite,
      // Node→node:sqlite). This alias remains only as a defensive net for any
      // stray `bun:sqlite` import, routed to the same single shim.
      'bun:sqlite': path.resolve(__dirname, './src/shims/bun-sqlite.ts'),
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
