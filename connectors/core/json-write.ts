import type { Connector } from '@sdk/connectorTypes.js';
import { extractField, parseJobInputs } from '@sdk/parsing.js';

export const jsonWriteConnector: Connector = {
  name: 'json-write',
  description:
    "Writes or upserts a single record into a named JSON collection. Pick this for any persistence step — cues " +
    "in the user's intent include 'save', 'store', 'persist', 'record', 'log to history', 'archive', 'keep a copy'. " +
    "Use it at the END of a workflow, after all computations are complete, so the persisted record carries final " +
    "values rather than intermediates. Returns a flat scalar { success: boolean } — no record envelope and no " +
    "returnedFact needed for downstream consumers.",
  inputParams: [
    { name: "collection", type: "string", required: true, description: "Literal collection name to write to (e.g. 'users', 'orders'). Pick from the 'Available data collections' block; never wire this dynamically." },
    { name: "data", type: "object", required: true, description: "The record payload as an object. Wire field values from upstream facts via the step's mappings / dynamicParamMappings — do not paste literal values for fields the user hasn't supplied." },
    { name: "upsert", type: "boolean", required: false, description: "When true (default), update the existing record matching idField; when false, always append a new record." },
    { name: "idField", type: "string", required: false, description: "Which field acts as the primary key for upsert matching (default: 'id', falls back to 'MemberID')." },
    { name: "mappings", type: "object", required: false, description: "Optional property aliases used during execution" }
  ],
  outputParams: [
    { name: "success", type: "boolean", description: "Flat scalar — true if the write succeeded. No record envelope; downstream steps can reference 'success' directly as an outputFact." }
  ],
  parse: (section: string) => {
    const params = parseJobInputs(section);

    if (!params.collection) {
      params.collection = extractField(section, 'collection') || extractField(section, 'Collection');
    }

    if (params.upsert === undefined) {
      const upsertVal = extractField(section, 'upsert') || extractField(section, 'Upsert');
      if (upsertVal) params.upsert = upsertVal.toLowerCase() === 'true';
    }

    if (!params.idField) {
      params.idField = extractField(section, 'idField') || extractField(section, 'IdField') || extractField(section, 'id-field');
    }

    return params;
  },
  getAssignedVariables: (_params: Record<string, any>) => {
    return { assignedVariables: ['success'] };
  },
  execute: async (ctx: any, params: Record<string, any>, input: any) => {
    const { collection, data: staticData, upsert = true, idField } = params;

    let recordData = { ...staticData };

    const excludeFields = ['collection', 'data', 'upsert', 'idField', 'mappings', 'returns', 'resultKey', 'template', 'writeResult'];

    if (params.mappings) {
      for (const [targetKey, sourceTemplate] of Object.entries(params.mappings)) {
        if (typeof sourceTemplate !== 'string') continue;
        const resolved = ctx.resolveTemplate ? ctx.resolveTemplate(sourceTemplate, input) : sourceTemplate;
        if (resolved !== undefined && !String(resolved).includes('{{')) {
          recordData[targetKey] = resolved;
          if (typeof resolved === 'string' && /^-?\d+(\.\d+)?$/.test(resolved)) {
            recordData[targetKey] = parseFloat(resolved);
          }
        } else if (input[targetKey] !== undefined && !String(input[targetKey]).includes('{{')) {
          recordData[targetKey] = input[targetKey];
        }
      }
    }

    // Build the record from the step's resolved fields. Two delivery paths feed
    // this connector and they put the facts in DIFFERENT bags:
    //   - Interface/complete-slice path: collected facts arrive in `input`.
    //   - Automation job path: `resolveJobParams` resolves the job's
    //     inputMappings into top-level `params` (the executor calls the
    //     connector with `input = {}`), so the facts are in `params`.
    // Merge both (input wins on conflict) minus the static config keys, so a
    // json-write in an Automation slice actually persists its mapped facts
    // instead of writing an empty record.
    for (const [key, value] of Object.entries({ ...params, ...input })) {
      if (excludeFields.includes(key)) continue;
      if (recordData[key] !== undefined) continue;

      if (typeof value === 'string' && !value.includes('{{') && value !== '') {
        recordData[key] = value;
      } else if (typeof value !== 'string' && value !== undefined) {
        recordData[key] = value;
      }
    }

    if (!collection || Object.keys(recordData).length === 0) {
      return { success: false };
    }

    const jsonData = ctx.dataSources.json;
    // A first write to a brand-new collection must CREATE it. JsonDataSource.read
    // throws "Collection not found" for a missing file (correct for read-only
    // connectors), so treat a read failure here as an empty collection rather
    // than failing the whole write — upsert/append then persists the new file.
    let items: any[];
    try {
      items = await jsonData.read(collection);
    } catch {
      items = [];
    }
    if (!Array.isArray(items)) items = [];

    if (upsert) {
      const possibleIdFields = idField ? [idField] : ['id', 'ID', 'MemberID', 'memberId'];
      let existingIndex = -1;

      for (const field of possibleIdFields) {
        const idValue = recordData[field];
        if (idValue !== undefined && idValue !== null) {
          existingIndex = items.findIndex((item: any) =>
            item[field]?.toString().toLowerCase() === idValue.toString().toLowerCase()
          );
          if (existingIndex !== -1) break;
        }
      }

      if (existingIndex !== -1) {
        items[existingIndex] = { ...items[existingIndex], ...recordData };
      } else {
        items.push(recordData);
      }
    } else {
      items.push(recordData);
    }

    await jsonData.write(collection, items);
    return { success: true, record: recordData };
  }
};
