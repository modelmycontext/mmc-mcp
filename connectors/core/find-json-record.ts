import type { Connector } from '@sdk/connectorTypes.js';
import { extractField, parseJobInputs } from '@sdk/parsing.js';

export const findJsonRecordConnector: Connector = {
  name: 'find-json-record',
  description:
    "Looks up a single record from a named JSON collection by matching one field against a value. " +
    "Pick this for any 'fetch by id / email / key / name' step — e.g. 'look up the customer with this id', " +
    "'load the order matching this number', 'find the user by email'. Returns a record envelope (the matched row " +
    "as an object), never a bare scalar — downstream consumers must declare a returnedFact whose fields name the " +
    "individual columns they need, otherwise the whole envelope gets stored under the outputFact's name and downstream " +
    "rules silently fail. Returns null when no record matches.",
  inputParams: [
    { name: "collection", type: "string", required: true, description: "Literal collection name to query (e.g. 'users', 'orders'). Use a value from the workbench's 'Available data collections' block; never wire this dynamically." },
    { name: "searchField", type: "string", required: true, description: "Literal name of the field on the collection to match against (e.g. 'id', 'customerEmail'). Pick the field whose values will match the upstream lookup value." },
    { name: "find", type: "string", required: true, description: "The value to match against searchField. Wire this DYNAMICALLY from an upstream fact carrying the lookup key. The parameter name is literally 'find' — not 'id', not the upstream fact name." },
    { name: "mappings", type: "object", required: false, description: "Optional property aliases used during lookup" }
  ],
  outputParams: [
    { name: "record", type: "object", description: "The matched record. RECORD ENVELOPE — declare a composite returnedFact when picking individual fields downstream." }
  ],
  parse: (section: string) => {
    const params = parseJobInputs(section);

    if (!params.collection) {
      params.collection = extractField(section, 'collection') || extractField(section, 'Collection');
    }
    if (!params.find) {
      params.find = extractField(section, 'find') || extractField(section, 'Find');
    }
    if (!params.searchField) {
      params.searchField = extractField(section, 'searchField') || extractField(section, 'SearchField');
    }

    return params;
  },
  getAssignedVariables: (params: Record<string, any>) => {
    const coll = params.collection || '';
    const resultKey = coll === 'users' ? 'user' : (coll.endsWith('s') ? coll.slice(0, -1) : coll);
    return { assignedVariables: [resultKey] };
  },
  execute: async (ctx: any, params: Record<string, any>, input: any) => {
    const { collection, find, mappings, searchField: paramSearchField } = params;

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
