import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, '../../src/server/index.ts');

/**
 * Regression test for the stdout-pollution bug.
 *
 * MCP stdio transport requires that the server's stdout contain ONLY
 * newline-delimited JSON-RPC messages. Anything else — log lines, ANSI
 * escapes, banners — corrupts the protocol stream and can be exploited
 * as message injection (see SECURITY.md). This test boots the server as
 * a child process, sends a valid `initialize` request on stdin, and
 * asserts that every non-empty line on stdout parses as JSON-RPC.
 * Stderr is unconstrained.
 */
describe('stdio transport stdout cleanliness', () => {
  it('emits only JSON-RPC frames on stdout during init', async () => {
    const child = spawn('bun', ['run', ENTRY], {
      env: {
        ...process.env,
        MMC_SKIP_SYNC: '1',
        // Skip spawning child MCP servers (sqlite/github/slack); their
        // dependency resolution is slow and unrelated to this regression.
        MMC_SKIP_EXTERNAL: '1',
        // Let the OS pick a free port so the HTTP listener doesn't
        // collide with a running dev server on 3001.
        PORT: '0',
        NODE_ENV: 'test',
        LOG_LEVEL: 'debug',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    // Wait for the parent stdio transport to be live before sending init.
    const stdioReady = new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (/MMC MCP Server running on stdio/.test(stderr)) {
          clearInterval(t);
          resolve();
        }
      }, 50);
    });
    await Promise.race([
      stdioReady,
      new Promise((r) => setTimeout(r, 8000)),
    ]);

    const initReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdout-cleanliness-test', version: '1.0.0' },
      },
    });
    child.stdin.write(initReq + '\n');
    await new Promise((r) => setTimeout(r, 1500));

    child.kill('SIGTERM');
    // Surface boot stderr if stdout was empty — makes the failure debuggable.
    if (stdout.trim().length === 0) {
      // eslint-disable-next-line no-console
      console.error('[stdout-cleanliness] empty stdout; stderr was:\n' + stderr.slice(0, 4000));
    }

    const lines = stdout.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      let parsed: any;
      expect(() => { parsed = JSON.parse(line); }).not.toThrow();
      expect(parsed.jsonrpc).toBe('2.0');
      expect(line).not.toMatch(/\x1b\[/);
    }
  }, 20_000);
});
