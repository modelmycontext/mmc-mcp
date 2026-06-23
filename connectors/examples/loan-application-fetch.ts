import type { Connector } from '@sdk/connectorTypes.js';

/**
 * Mock loan-origination-system connector. Stands in for a real LOS API
 * (nCino, Encompass, etc.). Hardwired to the 'loan-applications' collection;
 * looks a single application up by applicationId and returns its flat fields.
 */
export const loanApplicationFetchConnector: Connector = {
  name: 'loan-application-fetch',
  description:
    "Fetches a single loan application from the 'loan-applications' collection by applicationId. " +
    "Pick this for the 'retrieve the submitted application' step. Returns flat scalar fields " +
    "{ applicationId, applicantName, requestedAmount, annualIncome, monthlyDebt, employmentStatus } — " +
    "no record envelope, declare each as its own outputFact. Hardwired to 'loan-applications'; do not " +
    "use it for any other collection. Returns nulls when no application matches.",
  inputParams: [
    { name: "applicationId", type: "string", required: true, description: "The application id to fetch. Wire DYNAMICALLY from the upstream applicationId fact." },
  ],
  outputParams: [
    { name: "applicationId", type: "string", description: "Echoed application id." },
    { name: "applicantName", type: "string", description: "Applicant full name." },
    { name: "requestedAmount", type: "number", description: "Loan amount requested." },
    { name: "annualIncome", type: "number", description: "Stated annual income." },
    { name: "monthlyDebt", type: "number", description: "Stated total monthly debt service." },
    { name: "employmentStatus", type: "string", description: "Employment status." },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({
    assignedVariables: ['applicationId', 'applicantName', 'requestedAmount', 'annualIncome', 'monthlyDebt', 'employmentStatus'],
  }),

  execute: async (ctx: any, params: Record<string, any>, input: Record<string, any> = {}) => {
    const applicationId = params.applicationId ?? input.applicationId ?? input.find ?? input['application-id'];
    if (!applicationId) return { applicationId: null, applicantName: null };

    const rows: any[] = await ctx.dataSources.json.read('loan-applications');
    const match = rows.find(
      (r) => r.applicationId?.toString().toLowerCase() === applicationId.toString().toLowerCase(),
    );
    if (!match) return { applicationId: null, applicantName: null };

    return {
      applicationId: match.applicationId,
      applicantName: match.applicantName,
      requestedAmount: match.requestedAmount,
      annualIncome: match.annualIncome,
      monthlyDebt: match.monthlyDebt,
      employmentStatus: match.employmentStatus,
    };
  },
};
