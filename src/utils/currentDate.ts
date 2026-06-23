// currentDate.ts — the single source of "today" for the runtime.
//
// Returns the current calendar date as YYYY-MM-DD in the configured timezone
// (MMC_TZ env, e.g. "Pacific/Auckland"), falling back to the host's local zone.
// Deliberately NOT `toISOString()` (which is UTC): east of UTC that stamps the
// date a day early for the first hours of local time — a real bug for a NZ
// registration date.
//
// `now`/`tz` are injectable for tests. `en-CA` formats as YYYY-MM-DD.
export function currentLocalDate(now: Date = new Date(), tz: string | undefined = process.env.MMC_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
