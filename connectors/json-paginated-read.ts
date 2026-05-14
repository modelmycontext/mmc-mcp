import type { Connector } from '@sdk/connectorTypes.js';
import { parseJobInputs } from '@sdk/parsing.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `collection` is treated as a file path (read directly with fs) only when
 * it is unambiguously a path: absolute (`C:\…`, `/…`) or already ends in
 * `.json`. Plain relative segments like `downloads/foo/bar` are still
 * routed through `ctx.dataSources.json.read` so `JsonDataSource` can
 * resolve them under its data directory and append the `.json` suffix.
 */
function looksLikePath(collection: string): boolean {
  return path.isAbsolute(collection) || collection.endsWith('.json');
}

async function loadCollection(ctx: any, collection: string): Promise<any[]> {
  if (looksLikePath(collection)) {
    const content = await fs.readFile(collection, 'utf-8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return ctx.dataSources.json.read(collection);
}

export const jsonPaginatedReadConnector: Connector = {
  name: 'json-paginated-read',
  description:
    "Returns a contiguous page of records from a JSON collection. Pick this for any list-style step over a JSON " +
    "collection where the consumer needs multiple rows (e.g. 'show recent orders', 'list candidate projects', " +
    "'top items'). For single-record lookups by a known key, use the lookup-by-field tool instead. " +
    "Returns { records: array } — a list. Declare the output as an outputFact with collection=true so downstream " +
    "steps see it as a list rather than a scalar.",
  inputParams: [
    { name: "collection", type: "string",  required: true,  description: "Literal collection name (e.g. 'orders', 'budgets') OR an absolute path to a .json file." },
    { name: "startRow",   type: "number",  required: false, description: "Zero-based row offset (default: 0). Set when the consumer wants a non-first page." },
    { name: "rows",       type: "number",  required: false, description: "Page size — number of rows to return (default: 10)." },
    { name: "returns",    type: "string",  required: false, description: "Variable name for the records array (default: 'records')." },
  ],
  outputParams: [
    { name: "records", type: "array", description: "The records for the requested page — an array. Declare as collection=true in outputFacts." },
  ],
  parse: (section: string) => {
    return parseJobInputs(section);
  },
  getAssignedVariables: (params: Record<string, any>) => {
    return { assignedVariables: [params.returns || 'records'] };
  },
  execute: async (ctx: any, params: Record<string, any>) => {
    const { collection } = params;
    const startRow = Math.max(0, Number(params.startRow) || 0);
    const rows     = Math.max(1, Number(params.rows)     || 10);

    const all: any[] = await loadCollection(ctx, collection);
    return { records: all.slice(startRow, startRow + rows) };
  },
};
