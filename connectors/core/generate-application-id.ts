import type { Connector, ConnectorContext } from '@sdk/connectorTypes.js';
import { currentLocalDate } from '@src/utils/currentDate.js';

/**
 * Mints a sequential, year-scoped application reference id (e.g. `APP-2026-001`).
 *
 * Intended to run as a Command Job at application *receipt* — e.g. the
 * `translate-application-form` step that fires on the inbound webhook — so the
 * system assigns the id at the moment an application actually arrives, instead
 * of relying on a hand-typed value that's empty in a webhook-first flow. The
 * job maps the returned `applicationId` onto the `application-id` fact.
 *
 * Keeps a per-year counter in the `application-id-counters` JSON collection
 * (`[{ year, count }]`): each call reads the year's row, increments it, and
 * persists. Side-effecting / non-idempotent — a re-run advances the sequence —
 * so invoke it exactly once per received application.
 */
export const generateApplicationIdConnector: Connector = {
  name: 'generate-application-id',
  description:
    "Mints a sequential, year-scoped application reference id (e.g. APP-2026-001) from a persisted per-year " +
    "counter. Run it as a job when an application is received (e.g. translate-application-form on the inbound " +
    "webhook) to assign the id at that point, then map the returned `applicationId` onto the application-id fact. " +
    "Side-effecting (advances the counter each call) — invoke once per received application. Returns " +
    "{ success, applicationId, year, sequence }.",
  inputParams: [
    { name: 'prefix', type: 'string', required: false, description: "Id prefix (default 'APP'). The reference is `<prefix>-<year>-<zero-padded sequence>`." },
    { name: 'pad', type: 'number', required: false, description: 'Zero-pad width for the sequence (default 3, e.g. 001).' },
    { name: 'collection', type: 'string', required: false, description: "JSON collection holding the per-year counter (default 'application-id-counters'). Rarely changed." },
  ],
  outputParams: [
    { name: 'success', type: 'boolean', description: 'False only if the counter could not be persisted.' },
    { name: 'applicationId', type: 'string', description: 'The minted reference, e.g. APP-2026-001. Map this onto the application-id fact.' },
    { name: 'year', type: 'string', description: 'The calendar year (YYYY) the sequence is scoped to.' },
    { name: 'sequence', type: 'number', description: 'The 1-based numeric sequence within the year.' },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['success', 'applicationId', 'year', 'sequence'] }),

  execute: async (ctx: ConnectorContext, params: Record<string, any>, input: Record<string, any> = {}) => {
    const pick = (...keys: string[]): any => {
      for (const k of keys) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') return params[k];
        if (input[k] !== undefined && input[k] !== null && input[k] !== '') return input[k];
      }
      return undefined;
    };
    const prefix = String(pick('prefix') || 'APP');
    const pad = Number(pick('pad')) || 3;
    const collection = String(pick('collection') || 'application-id-counters');
    // Year from the configured local calendar (MMC_TZ), so the sequence rolls
    // over with the local new year rather than UTC.
    const year = currentLocalDate().slice(0, 4);

    const json = ctx.dataSources.json;
    // Mirror json-write: a missing collection throws on read — treat as empty so
    // the first mint of the year creates the counter file.
    let rows: any[];
    try { rows = await json.read(collection); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];

    const row = rows.find((r) => String(r?.year) === year);
    const sequence = (Number(row?.count) || 0) + 1;
    if (row) row.count = sequence; else rows.push({ year, count: sequence });

    try {
      await json.write(collection, rows);
    } catch {
      return { success: false, applicationId: null, year, sequence: null };
    }

    const applicationId = `${prefix}-${year}-${String(sequence).padStart(pad, '0')}`;
    return { success: true, applicationId, year, sequence };
  },
};
