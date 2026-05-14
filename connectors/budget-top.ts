import type { Connector } from '@sdk/connectorTypes.js';

export const budgetTopConnector: Connector = {
  name: 'budget-top',
  description:
    "Returns the top-N records from the 'budgets' collection, pre-sorted by budget amount descending. Pick this " +
    "for 'top spenders / largest budgets / highest-value projects' steps that don't need filtering — it's faster " +
    "and simpler than a paginated read + sort. Hardwired to the 'budgets' collection; do NOT use it for any other " +
    "collection. Returns { budgets: array of { id, projectName, budget } }.",
  inputParams: [
    { name: "limit", type: "number", required: false, description: "How many records to return (default: 5)." },
  ],
  outputParams: [
    { name: "budgets", type: "array", description: "Pre-sorted collection of budget records. Each element has { id, projectName, budget }. Declare as collection=true; pair with a returnedFact when downstream steps reference individual fields by name." },
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
