import type { Connector } from '@sdk/connectorTypes.js';
import { extractField, parseJobInputs } from '@sdk/parsing.js';

export const jsonWriteConnector: Connector = {
  name: 'json-write',
  description: "Writes or updates a record in a JSON collection",
  inputParams: [
    { name: "collection", type: "string", required: true, description: "The collection name to write to" },
    { name: "data", type: "object", required: true, description: "The record data to write" },
    { name: "upsert", type: "boolean", required: false, description: "Whether to update if a record with the same ID exists" },
    { name: "idField", type: "string", required: false, description: "The field to use as ID for upsert (default: 'id' or 'MemberID')" },
    { name: "mappings", type: "object", required: false, description: "Optional property aliases used during execution" }
  ],
  outputParams: [
    { name: "success", type: "boolean", description: "Whether the write operation was successful" }
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

    const excludeFields = ['collection', 'upsert', 'idField', 'mappings', 'returns', 'resultKey', 'template', 'writeResult'];

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

    for (const [key, value] of Object.entries(input)) {
      if (excludeFields.includes(key)) continue;
      if (recordData[key] !== undefined) continue;

      if (typeof value === 'string' && !value.includes('{{')) {
        recordData[key] = value;
      } else if (typeof value !== 'string' && value !== undefined) {
        recordData[key] = value;
      }
    }

    if (!collection || Object.keys(recordData).length === 0) {
      return { success: false };
    }

    const jsonData = ctx.dataSources.json;
    const items = await jsonData.read(collection);

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
