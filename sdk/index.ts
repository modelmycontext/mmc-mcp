// Barrel export for the connector SDK.
//
// Everything in this folder is licensed under Apache-2.0 (see ./LICENSE).
// Connector authors can import from `@sdk/...` (or this barrel) without
// inheriting the GPL-3.0 obligations of the rest of the codebase.
//
// See ../LICENSING.md for the dual-license rationale.

export type {
  Connector,
  ConnectorContext,
  DataSources,
  McpTool,
} from './connectorTypes.js';

export {
  parseJobInputs,
  parseKeyValueBlock,
  extractField,
} from './parsing.js';
