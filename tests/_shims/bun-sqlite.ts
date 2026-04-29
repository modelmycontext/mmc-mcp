// Vitest shim for `bun:sqlite`. Vitest workers run as Node, so the production
// import `bun:sqlite` cannot resolve. We alias to `node:sqlite` (stable in
// Node 22.5+) which exposes a near-identical synchronous API. Aliased via
// `vitest.config.ts` resolve.alias.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export { DatabaseSync as Database };
export type Statement = StatementSync;
