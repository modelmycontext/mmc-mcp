import type { Connector } from '@sdk/connectorTypes.js';

/**
 * Mock credit-bureau connector. Stands in for a real bureau pull
 * (Experian / Equifax / TransUnion soft-pull API). Hardwired to the
 * 'credit-bureau' collection; returns the credit file for one applicationId.
 *
 * Note: this connector is pure I/O. It returns the raw bureau facts only —
 * it deliberately makes NO lending decision. The approve/refer/decline policy
 * lives in the outcome model's scenario business rules, where it can be
 * reviewed and signed off, not buried in connector code.
 */
export const creditBureauPullConnector: Connector = {
  name: 'credit-bureau-pull',
  description:
    "Pulls the credit file for one applicationId from the 'credit-bureau' collection. Pick this for the " +
    "'pull credit / bureau check' step. Returns flat scalars { creditScore, debtToIncomeRatio, " +
    "derogatoryMarks, bankruptcyOnFile } — declare each as its own outputFact. Makes no decision; " +
    "downstream scenario rules decide. Hardwired to 'credit-bureau'. Returns nulls when no file matches.",
  inputParams: [
    { name: "applicationId", type: "string", required: true, description: "The application id whose credit file to pull. Wire DYNAMICALLY from the upstream applicationId fact." },
  ],
  outputParams: [
    { name: "creditScore", type: "number", description: "FICO-style score (300-850)." },
    { name: "debtToIncomeRatio", type: "number", description: "DTI as a decimal (0.0-1.0)." },
    { name: "derogatoryMarks", type: "number", description: "Count of derogatory marks on file." },
    { name: "bankruptcyOnFile", type: "boolean", description: "True if an undischarged bankruptcy is on file." },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({
    assignedVariables: ['creditScore', 'debtToIncomeRatio', 'derogatoryMarks', 'bankruptcyOnFile'],
  }),

  execute: async (ctx: any, params: Record<string, any>, input: Record<string, any> = {}) => {
    const applicationId = params.applicationId ?? input.applicationId ?? input.find ?? input['application-id'];
    if (!applicationId) return { creditScore: null, bankruptcyOnFile: null };

    const rows: any[] = await ctx.dataSources.json.read('credit-bureau');
    const file = rows.find(
      (r) => r.applicationId?.toString().toLowerCase() === applicationId.toString().toLowerCase(),
    );
    if (!file) return { creditScore: null, bankruptcyOnFile: null };

    return {
      creditScore: file.creditScore,
      debtToIncomeRatio: file.debtToIncomeRatio,
      derogatoryMarks: file.derogatoryMarks,
      bankruptcyOnFile: file.bankruptcyOnFile,
    };
  },
};
