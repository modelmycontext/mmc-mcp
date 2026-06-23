import type { Connector, ConnectorContext } from '@sdk/connectorTypes.js';
import { signJti } from '@src/forms/jtiVerify.js';

/**
 * Built-in connector that mints an HMAC-signed form-runner token.
 *
 * Self-contained: signs locally using `FORMS_HMAC_KEY` from env (the same key
 * the webhook verifies with). Returns `{jti, tokenUrl, expiresAt}` — the
 * caller's Job typically maps `tokenUrl` to the `enrolment-link-url` returned
 * fact, then a downstream `send-email` Job templates it into the email body.
 *
 * The `correlationId` argument is the workflow-instance id the eventual webhook
 * publish should land on (workflow-instance-isolation RFC D4). It defaults to
 * the minting slice's instance via the connector context, so the submission
 * rejoins the exact instance across the transport hop. Was `sessionId`.
 */
export const mintFormTokenConnector: Connector = {
  name: 'mint-form-token',
  description:
    "Mints a signed bearer token for the public form runner. The returned tokenUrl is what gets emailed to the applicant; on submit, the workbench POSTs the jti back to mmc-mcp's /external-events webhook which verifies the signature and publishes the inbound event onto the matching session's bus.",
  inputParams: [
    { name: 'correlationId',  type: 'string', required: true,  description: "Workflow-instance id this token binds to. The published external event lands on this instance's bus. Defaults to the slice's instance; legacy 'sessionId' still accepted." },
    { name: 'eventType',  type: 'string', required: true,  description: "Event type the form's submit will publish (e.g. 'application-form-submitted')." },
    { name: 'templateId', type: 'string', required: true,  description: 'Workbench-side FormTemplate id (looked up client-side by the form runner).' },
    { name: 'prefilled',  type: 'object', required: false, description: 'Optional map of factId → value to pre-populate the form with.' },
    { name: 'ttlMs',      type: 'number', required: false, description: 'Token lifetime in milliseconds. Defaults to 30 days.' },
    { name: 'baseUrl',    type: 'string', required: false, description: 'Form-runner base URL. Defaults to MMC_FORMS_BASE_URL env or http://localhost:3001 (the mmc-mcp instance now serves /f/:token).' },
  ],
  outputParams: [
    { name: 'jti',        type: 'string',  description: 'The signed token string itself. Embedded in tokenUrl.' },
    { name: 'tokenUrl',   type: 'string',  description: 'Full URL the applicant clicks to open the form runner.' },
    { name: 'expiresAt',  type: 'number',  description: 'Unix epoch ms when the token expires.' },
    { name: 'success',    type: 'boolean', description: 'False if the connector is misconfigured (missing key or required inputs).' },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['jti', 'tokenUrl', 'expiresAt', 'success'] }),

  execute: async (ctx: ConnectorContext, params: Record<string, any>, input: Record<string, any> = {}) => {
    const pick = (...keys: string[]): any => {
      for (const k of keys) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') return params[k];
        if (input[k] !== undefined && input[k] !== null && input[k] !== '') return input[k];
      }
      return undefined;
    };
    // The correlationId (workflow-instance id) falls back to the connector
    // context so the slice author doesn't have to wire it through. Only override
    // via param when minting on behalf of a different instance than the one this
    // slice runs in. Legacy `sessionId`/`session-id` params still accepted.
    const correlationId = pick('correlationId', 'correlation-id', 'sessionId', 'session-id') ?? (ctx as any)?.correlationId;
    const eventType  = pick('eventType',  'event-type');
    const templateId = pick('templateId', 'template-id');
    const prefilled  = pick('prefilled');
    const ttlMs      = Number(pick('ttlMs', 'ttl-ms')) || 30 * 24 * 60 * 60 * 1000;
    // The public form runner is served by mmc-mcp itself (GET /f/:token), so the
    // dev default points at this instance. Production sets MMC_FORMS_BASE_URL to
    // the org instance's public URL.
    const baseUrlRaw = pick('baseUrl', 'base-url') || process.env.MMC_FORMS_BASE_URL || 'http://localhost:3001';
    const baseUrl    = String(baseUrlRaw).replace(/\/+$/, '');

    const key = process.env.FORMS_HMAC_KEY;
    if (!key) {
      return { success: false, jti: null, tokenUrl: null, expiresAt: null };
    }
    if (!correlationId || !eventType || !templateId) {
      return { success: false, jti: null, tokenUrl: null, expiresAt: null };
    }

    const exp = Date.now() + ttlMs;
    const extras = (prefilled && typeof prefilled === 'object') ? { prefilled } : undefined;
    const jti = signJti({ correlationId, eventType, templateId, exp, extras }, key);

    return {
      success: true,
      jti,
      tokenUrl: `${baseUrl}/f/${jti}`,
      expiresAt: exp,
    };
  },
};
