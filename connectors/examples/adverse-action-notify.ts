import type { Connector } from '@sdk/connectorTypes.js';

/**
 * Mock adverse-action notice connector. Stands in for the regulated
 * notification step required on a credit denial (ECOA / FCRA adverse-action
 * notice). Appends an immutable notice record to the 'adverse-action-notices'
 * collection so the demo can show the specific principal reasons were issued.
 */
export const adverseActionNotifyConnector: Connector = {
  name: 'adverse-action-notify',
  description:
    "Issues an adverse-action notice for a declined application and records it in the " +
    "'adverse-action-notices' collection. Pick this for the 'send the denial notice' step on a declined " +
    "application. Always appends (never upserts) so the notice log is immutable. Returns { success, noticeId }.",
  inputParams: [
    { name: "applicationId", type: "string", required: true, description: "Declined application id. Wire from the upstream applicationId fact." },
    { name: "applicantName", type: "string", required: false, description: "Applicant name for the notice." },
    { name: "declineReasons", type: "string", required: true, description: "The specific principal reasons for denial. Wire from the decision slice's declineReasons fact." },
  ],
  outputParams: [
    { name: "success", type: "boolean", description: "True if the notice was recorded." },
    { name: "noticeId", type: "string", description: "Generated id of the issued notice." },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['success', 'noticeId'] }),

  execute: async (ctx: any, params: Record<string, any>, input: Record<string, any> = {}) => {
    const applicationId = params.applicationId ?? input.applicationId ?? input['application-id'];
    const applicantName = params.applicantName ?? input.applicantName ?? input['applicant-name'] ?? '';
    const declineReasons = params.declineReasons ?? input.declineReasons ?? input['decline-reasons'] ?? '';

    if (!applicationId || !declineReasons) return { success: false, noticeId: null };

    const noticeId = `AAN-${applicationId}-${Date.now()}`;
    const notices: any[] = await ctx.dataSources.json.read('adverse-action-notices').catch(() => []);
    notices.push({
      noticeId,
      applicationId,
      applicantName,
      declineReasons,
      issuedAt: new Date().toISOString(),
    });
    await ctx.dataSources.json.write('adverse-action-notices', notices);

    return { success: true, noticeId };
  },
};
