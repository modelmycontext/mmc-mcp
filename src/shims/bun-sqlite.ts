// Production shim: maps bun:sqlite to Node 22+ built-in node:sqlite.
// Used by the mcpb/Node build; the identical shim in tests/_shims/ serves Vitest.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export { DatabaseSync as Database };
export type Statement = StatementSync;
