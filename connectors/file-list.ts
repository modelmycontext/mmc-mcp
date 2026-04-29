import type { Connector } from '@sdk/connectorTypes.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_DIR = 'data/files';

export const fileListConnector: Connector = {
  name: 'file-list',
  description: "Lists files previously stored under a given reference key, returning their metadata",
  inputParams: [
    { name: "referenceKey", type: "string", required: true, description: "The grouping key used when the files were stored. Must be the actual identifier value for the record, not a field/fact name." }
  ],
  outputParams: [
    { name: "documents", type: "array", description: "Array of document metadata objects" }
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
