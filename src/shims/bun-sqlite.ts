// Runtime-detecting SQLite shim. Picks the native driver for whichever runtime
// is executing the source so a single import works everywhere:
//
//   • Bun  (production Fly image: `bun src/server/index.ts`) → `bun:sqlite`,
//     the exact driver production has always used — this keeps the Bun-on-Fly
//     code path byte-for-byte unchanged while the rest of the codebase moves
//     to Node for development.
//   • Node (dev via `tsx`, Vitest, and the mcpb bundle)       → `node:sqlite`
//     (`DatabaseSync`, stable in Node 22+).
//
// Both drivers expose the subset this codebase uses — `new Database(path)`,
// `.exec()`, `.prepare(...).run/.get/.all`, `.close()` — so consumers import
// `{ Database, type Statement }` and stay driver-agnostic.
//
// The `bun:sqlite` specifier is assembled at runtime and marked `@vite-ignore`
// so Node-side bundlers (Vite/esbuild for the mcpb build, Vitest) never try to
// resolve it; that branch only ever evaluates under Bun, which resolves the
// built-in natively.

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';

let Database: unknown;
if (isBun) {
  const bunSqliteSpecifier = 'bun:' + 'sqlite';
  ({ Database } = await import(/* @vite-ignore */ bunSqliteSpecifier));
} else {
  const { DatabaseSync } = await import('node:sqlite');
  Database = DatabaseSync;
}

// Both drivers' Database classes are structurally compatible for the API
// surface used here; the cast keeps the public export shape identical to the
// previous direct `bun:sqlite` / `node:sqlite` imports.
const ResolvedDatabase = Database as typeof import('node:sqlite').DatabaseSync;
export { ResolvedDatabase as Database };

// Type exports — erased at runtime, so they can reference the node:sqlite types
// unconditionally regardless of which driver loads. The previous `bun:sqlite`
// import exported `Database` as a class (value AND type); consumers use it both
// ways (`private db: Database`), so we re-declare the instance type under the
// same name. StatementSync and bun:sqlite's Statement share the .run/.get/.all
// surface this code relies on.
export type Database = import('node:sqlite').DatabaseSync;
export type Statement = import('node:sqlite').StatementSync;
