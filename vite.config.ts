import { defineConfig } from 'vite';
import devServer from '@hono/vite-dev-server';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@connectors': path.resolve(__dirname, './connectors'),
      '@sdk': path.resolve(__dirname, './sdk'),
      '@src': path.resolve(__dirname, './src'),
    }
  },
  server: {
    port: 3001,
  },
  plugins: [
    devServer({
      entry: 'src/server/index.ts',
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
    lib: {
      entry: 'src/server/index.ts',
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'server/index.js'
      },
      external: [
        /^node:.*/,
        /^bun:.*/,
        'fs', 'path', 'url', 'http', 'https', 'stream', 'crypto', 'os', 'util', 'zlib', 'events',
        'hono', '@modelcontextprotocol/sdk/server/index.js',
        '@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/server/stdio.js',
        '@hono/mcp', '@modelcontextprotocol/sdk/types.js', 'zod', 'google-auth-library',
        /^@azure\/.*/, /^@dsnp\/.*/
      ]
    },
    ssr: true,
  }
});
