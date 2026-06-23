import type { Connector, ConnectorContext } from '@sdk/connectorTypes.js';

/**
 * Pure-function connector: input `date-of-birth` (ISO YYYY-MM-DD), output
 * `applicant-age` in whole years as of today.
 *
 * Modeled as a Query Job: the slice author wires `date-of-birth` → input,
 * declares `applicant-age` as the returned fact, then uses it in a structured
 * business rule like `applicant-age >= 16`. This keeps the slice patterns
 * clean — age is brought into scope by a job, not "derived" from another fact
 * via formula. See slice-patterns.md "Query Job — injects knowledge".
 *
 * No side effects, no external calls. Safe to re-evaluate; the runtime can
 * call it as many times as it wants without consequence.
 */
export const calculateAgeConnector: Connector = {
  name: 'calculate-age',
  description:
    "Computes whole-year age from a date-of-birth (ISO YYYY-MM-DD) as of today. Returns { applicantAge, success }. Use as a Query Job whose returnedFact is `applicant-age`, then write structured rules against it (e.g. applicant-age >= 16). Pure, deterministic, no side effects.",
  inputParams: [
    { name: 'dateOfBirth', type: 'string', required: true, description: 'ISO YYYY-MM-DD date string.' },
    { name: 'asOfDate',    type: 'string', required: false, description: 'Optional ISO date to compute age against. Defaults to today.' },
  ],
  outputParams: [
    { name: 'applicantAge', type: 'number',  description: 'Age in whole years; null if the input date is unparseable.' },
    { name: 'success',      type: 'boolean', description: 'True if the input was valid and age computed.' },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['applicantAge', 'success'] }),

  execute: async (_ctx: ConnectorContext, params: Record<string, any>, input: Record<string, any> = {}) => {
    const pick = (...keys: string[]): any => {
      for (const k of keys) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') return params[k];
        if (input[k] !== undefined && input[k] !== null && input[k] !== '') return input[k];
      }
      return undefined;
    };
    const dob   = pick('dateOfBirth', 'date-of-birth', 'dob');
    const asOf  = pick('asOfDate', 'as-of-date');

    const dobDate = parseISO(dob);
    if (!dobDate) return { success: false, applicantAge: null };
    const refDate = asOf ? (parseISO(asOf) ?? new Date()) : new Date();

    let years = refDate.getFullYear() - dobDate.getFullYear();
    const m = refDate.getMonth() - dobDate.getMonth();
    if (m < 0 || (m === 0 && refDate.getDate() < dobDate.getDate())) years--;
    return { success: true, applicantAge: years };
  },
};

function parseISO(s: any): Date | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isNaN(d.getTime()) ? null : d;
}
