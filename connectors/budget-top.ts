import type { Connector } from '@sdk/connectorTypes.js';

export const budgetTopConnector: Connector = {
  name: 'budget-top',
  description: "Returns the top N records from the budgets collection, sorted by budget descending",
  inputParams: [
    { name: "limit", type: "number", required: false, description: "Number of records to return (default: 5)" },
  ],
  outputParams: [
    { name: "budgets", type: "array", description: "Array of budget records sorted by budget descending" },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['budgets'] }),

  execute: async (ctx: any, params: Record<string, any>) => {
    const limit = Number(params.limit) || 5;
    const jsonData = ctx.dataSources.json;
    const items: { id: string; projectName: string; budget: number }[] = await jsonData.read('budgets');
    const sorted = [...items].sort((a, b) => b.budget - a.budget);
    return { budgets: sorted.slice(0, limit) };
  },
};
