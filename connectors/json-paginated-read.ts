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
  description: "Returns a paginated slice of a JSON collection",
  inputParams: [
    { name: "collection", type: "string",  required: true,  description: "The collection name to read, or a file path ending in .json" },
    { name: "startRow",   type: "number",  required: false, description: "Zero-based row offset (default: 0)" },
    { name: "rows",       type: "number",  required: false, description: "Number of rows to return (default: 10)" },
    { name: "returns",    type: "string",  required: false, description: "Variable name to assign the records array to" },
  ],
  outputParams: [
    { name: "records", type: "array", description: "The records for the requested page" },
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
    return all.slice(startRow, startRow + rows);
  },
};
