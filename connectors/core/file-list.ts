import type { Connector } from '@sdk/connectorTypes.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_DIR = 'data/files';

export const fileListConnector: Connector = {
  name: 'file-list',
  description:
    "Lists files previously stored under a given reference key, returning their metadata (name, mimeType, size, " +
    "documentRef). Pick this for any step that needs to REVIEW, DECIDE on, or RENDER files that an upstream step " +
    "produced as a list of references — typical case: an action step whose UI must show what was attached. Wire it " +
    "as the step's `query` sub-job (per the reference-expansion rule), not as the step's own tool call. Returns " +
    "{ documents: array } — declare as collection=true.",
  inputParams: [
    { name: "referenceKey", type: "string", required: true, description: "The grouping key the files were stored under. Must be the actual identifier value (e.g. an order id, a request id), not a field/fact name. Wire this dynamically from the upstream fact carrying the id." }
  ],
  outputParams: [
    { name: "documents", type: "array", description: "Array of document metadata objects. Declare as a collection outputFact." }
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['documents'] }),

  execute: async (_ctx: any, params: Record<string, any>, input: any) => {
    const referenceKey = params.referenceKey || input.referenceKey;

    if (!referenceKey) {
      throw new Error('referenceKey is required');
    }

    const safeKey = referenceKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.resolve(UPLOAD_DIR, safeKey);

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return { documents: [] };
    }

    const metaFiles = entries.filter(e => e.endsWith('.meta.json'));
    const documents = await Promise.all(
      metaFiles.map(async (metaFile) => {
        const raw = await fs.readFile(path.join(dir, metaFile), 'utf-8');
        const meta = JSON.parse(raw);
        // Include a download URL for the browser
        meta.url = `/files/${safeKey}/${meta.storedName}`;
        return meta;
      })
    );

    return { documents };
  }
};
