import { describe, it, expect } from 'vitest';
import { resolveRuntimeCommand } from '../../src/server/externalMcpManager.js';

// Bun is production-only. Dev/tests run under Node, where `bun x …` must become
// `npx …` so the dev loop never spawns Bun (Windows ghost processes — #86).
describe('resolveRuntimeCommand', () => {
  it('rewrites `bun x -y <pkg>` to `npx -y <pkg>` under Node', () => {
    const r = resolveRuntimeCommand('bun', ['x', '-y', '@modelcontextprotocol/server-github'], /*isBun*/ false);
    expect(r).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] });
  });

  it('keeps `bun x …` as-is under Bun (production)', () => {
    const r = resolveRuntimeCommand('bun', ['x', '-y', '@modelcontextprotocol/server-slack'], /*isBun*/ true);
    expect(r).toEqual({ command: 'bun', args: ['x', '-y', '@modelcontextprotocol/server-slack'] });
  });

  it('passes explicit non-bun commands through unchanged under Node', () => {
    const r = resolveRuntimeCommand('node', ['./node_modules/mcp-server-sqlite/dist/cli.js'], false);
    expect(r).toEqual({ command: 'node', args: ['./node_modules/mcp-server-sqlite/dist/cli.js'] });
  });

  it('does not rewrite a bun command that is not the `x` package-runner form', () => {
    const r = resolveRuntimeCommand('bun', ['run', 'something'], false);
    expect(r).toEqual({ command: 'bun', args: ['run', 'something'] });
  });
});
