/**
 * Utility for formatting event logs with emojis and detailed payload summaries.
 */
export function formatEventLog(events: any[]): string {
  return events
    .filter(e => !(e.type === 'TOOL_CALLED' && e.payload && typeof e.payload.tool === 'string' && e.payload.tool.startsWith('transform:')))
    .map(e => {
      const timestamp = e.timestamp instanceof Date ? e.timestamp : new Date(e.timestamp);
      const time = timestamp.toISOString().substring(11, 19);
      const seq = e.sequence !== undefined ? `#${e.sequence.toString().padStart(4, '0')} ` : '';
      const session = e.sessionId ? `[${e.sessionId}] ` : '';
      let payloadSummary = '';

      const formatOutcome = (outcome: any) => {
        if (!outcome || typeof outcome !== 'object') return String(outcome || '');

        const flatten = (obj: any, prefix = ''): [string, any][] => {
          return Object.entries(obj).reduce((acc, [key, value]) => {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              acc.push(...flatten(value, fullKey));
            } else {
              acc.push([fullKey, value]);
            }
            return acc;
          }, [] as [string, any][]);
        };

        const entries = flatten(outcome)
          .filter(([key]) => !['id', 'timestamp', 'sequence', 'message'].includes(key.split('.').pop() || ''))
          .map(([key, value]) => {
            const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
            return `${key}: ${valStr}`;
          });
        return entries.length > 0 ? ` { ${entries.join(', ')} }` : '';
      };

      let emoji = '🔹';
      let typeLabel = e.type;

      if (e.type === 'SKILL_STARTED') {
        emoji = '🚀';
        typeLabel = 'SKILL_STARTED';
        payloadSummary = `${e.payload.skillId}${formatOutcome(e.payload.initialInput)}`;
      } else if (e.type === 'TOOL_CALLED') {
        emoji = '🔧';
        typeLabel = 'TOOL_CALLED';
        payloadSummary = `${e.payload.tool}${formatOutcome(e.payload.result)}`;
      } else if (e.type === 'SKILL_STEP_COMPLETED') {
        emoji = '✅';
        typeLabel = 'STEP_COMPLETED';
        payloadSummary = `${e.payload.stepId}${formatOutcome(e.payload.outcome)}`;
      } else if (e.type === 'SKILL_COMPLETED') {
        emoji = '🎉';
        typeLabel = 'SKILL_COMPLETED';
        payloadSummary = `${e.payload.skillId}${formatOutcome(e.payload.finalOutcome)}`;
      } else if (e.type === 'SKILL_STEP_FAILED') {
        emoji = '❌';
        typeLabel = 'STEP_FAILED';
        payloadSummary = `${e.payload.stepId} — Error: ${e.payload.error}`;
      }

      return `${seq}${time} ${session}${emoji} ${typeLabel.padEnd(16)} — ${payloadSummary}`;
    }).join('\n');
}
