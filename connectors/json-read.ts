import type { Connector } from '@sdk/connectorTypes.js';
import { extractField, parseJobInputs } from '@sdk/parsing.js';

export const jsonReadConnector: Connector = {
  name: 'json-read',
  description: "Looks up a record in a JSON collection by a given field",
  inputParams: [
    { name: "collection", type: "string", required: true, description: "The collection name to query" },
    { name: "searchField", type: "string", required: true, description: "The column to search in" },
    { name: "find", type: "string", required: true, description: "The value to search for, supports {{template}} syntax" },
    { name: "returns", type: "string", required: true, description: "The variable name to assign the result to" },
    { name: "mappings", type: "object", required: false, description: "Optional property aliases used during lookup" }
  ],
  outputParams: [
    { name: "{{returns}}", type: "object", description: "The matched record, keyed by the returns value" }
  ],
  parse: (section: string) => {
    const params = parseJobInputs(section);

    if (!params.collection) {
      params.collection = extractField(section, 'collection') || extractField(section, 'Collection');
    }
    if (!params.find) {
      params.find = extractField(section, 'find') || extractField(section, 'Find');
    }
    if (!params.returns) {
      params.returns = extractField(section, 'returns', ':\\s*([^\\s*(]+)') ||
        extractField(section, 'Returns', ':\\s*([^\\s*(]+)');
    }
    if (!params.searchField) {
      params.searchField = extractField(section, 'searchField') || extractField(section, 'SearchField');
    }

    return params;
  },
  getAssignedVariables: (params: Record<string, any>) => {
    const coll = params.collection || '';
    const resultKey = params.returns || (coll === 'users' ? 'user' : (coll.endsWith('s') ? coll.slice(0, -1) : coll));
    return { assignedVariables: [resultKey] };
  },
  execute: async (ctx: any, params: Record<string, any>, input: any) => {
    const { collection, find, returns: paramResultKey, mappings, searchField: paramSearchField } = params;

    let searchField: string | undefined = paramSearchField;
    let searchValue: any;

    if (typeof find === 'string' && find.startsWith('{{') && find.endsWith('}}')) {
      const varName = find.slice(2, -2);
      searchValue = input[varName] || input[varName.toLowerCase()];
      if (searchValue === undefined) {
        const key = Object.keys(input).find(k => k.toLowerCase() === varName.toLowerCase());
        if (key) searchValue = input[key];
      }
    } else if (find && typeof find === 'object') {
      if (!searchField) searchField = Object.keys(find)[0];
      searchValue = Object.values(find)[0];
    } else if (typeof find === 'string' && find.startsWith('{')) {
      try {
        const findObj = JSON.parse(find);
        if (!searchField) searchField = Object.keys(findObj)[0];
        searchValue = Object.values(findObj)[0];
      } catch (e) {
        searchValue = find;
      }
    } else {
      searchValue = find;
    }

    if (searchValue === null || searchValue === undefined || searchValue === "null" || searchValue === "undefined") {
      if (input.params) {
        searchValue = input.params.id || input.params.customerId || input.params.userId || input.params.user;
      }

      if (searchValue === undefined || searchValue === null) {
        const idKey = Object.keys(input).find(k => k.toLowerCase().endsWith('id'));
        searchValue = idKey ? input[idKey] : input.id;
      }
    }

    const resultKey = paramResultKey || (collection === 'users' ? 'user' : (collection.endsWith('s') ? collection.slice(0, -1) : collection));

    if (searchValue === null || searchValue === undefined || searchValue === "null" || searchValue === "undefined") {
      return null;
    }

    const jsonData = ctx.dataSources.json;
    const items = await jsonData.read(collection);
    const searchStr = searchValue.toString().toLowerCase();

    const item = items.find((u: any) => {
      if (searchField) {
        const itemValue = u[searchField];
        if (itemValue === undefined) {
          const key = Object.keys(u).find(k => k.toLowerCase() === searchField!.toLowerCase());
          if (key) {
            const val = u[key];
            return val?.toString().toLowerCase() === searchStr;
          }
        }
        return itemValue?.toString().toLowerCase() === searchStr;
      }
      if (u.id?.toString().toLowerCase() === searchStr) return true;
      return Object.values(u).some(val => val?.toString().toLowerCase() === searchStr);
    });

    return item || null;
  }
};
