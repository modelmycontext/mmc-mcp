import { describe, it, expect } from 'vitest';
import { formatEventLog } from '../../src/utils/eventFormatter.js';

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    id: 'evt-1',
    type: 'TEST',
    source: 'test',
    payload: {},
    timestamp: new Date('2025-06-15T12:34:56Z'),
    sequence: 1,
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('formatEventLog', () => {
  it('returns empty string for empty events array', () => {
    expect(formatEventLog([])).toBe('');
  });

  it('formats a SKILL_STARTED event with emoji and skillId', () => {
    const event = makeEvent({
      type: 'SKILL_STARTED',
      payload: { skillId: 'my-skill', initialInput: {} },
    });
    const output = formatEventLog([event]);
    expect(output).toContain('🚀');
    expect(output).toContain('SKILL_STARTED');
    expect(output).toContain('my-skill');
  });

  it('formats a TOOL_CALLED event with emoji and tool name', () => {
    const event = makeEvent({
      type: 'TOOL_CALLED',
      payload: { tool: 'find-json-record', result: {} },
    });
    const output = formatEventLog([event]);
    expect(output).toContain('🔧');
    expect(output).toContain('TOOL_CALLED');
    expect(output).toContain('find-json-record');
  });

  it('formats a SKILL_STEP_COMPLETED event', () => {
    const event = makeEvent({
      type: 'SKILL_STEP_COMPLETED',
      payload: { stepId: 'step-1', outcome: {} },
    });
    const output = formatEventLog([event]);
    expect(output).toContain('✅');
    expect(output).toContain('STEP_COMPLETED');
    expect(output).toContain('step-1');
  });

  it('formats a SKILL_COMPLETED event', () => {
    const event = makeEvent({
      type: 'SKILL_COMPLETED',
      payload: { skillId: 'my-skill', finalOutcome: {} },
    });
    const output = formatEventLog([event]);
    expect(output).toContain('🎉');
    expect(output).toContain('SKILL_COMPLETED');
    expect(output).toContain('my-skill');
  });

  it('formats a SKILL_STEP_FAILED event with error message', () => {
    const event = makeEvent({
      type: 'SKILL_STEP_FAILED',
      payload: { stepId: 'step-2', error: 'Something failed' },
    });
    const output = formatEventLog([event]);
    expect(output).toContain('❌');
    expect(output).toContain('STEP_FAILED');
    expect(output).toContain('Something failed');
  });

  it('filters out transform: tool calls from output', () => {
    const event = makeEvent({
      type: 'TOOL_CALLED',
      payload: { tool: 'transform:logic', result: {} },
    });
    expect(formatEventLog([event])).toBe('');
  });

  it('filters out transform:template tool calls from output', () => {
    const event = makeEvent({
      type: 'TOOL_CALLED',
      payload: { tool: 'transform:template', result: {} },
    });
    expect(formatEventLog([event])).toBe('');
  });

  it('pads sequence number to 4 digits', () => {
    const event = makeEvent({ sequence: 1 });
    const output = formatEventLog([event]);
    expect(output).toContain('#0001');
  });

  it('pads large sequence numbers without truncation', () => {
    const event = makeEvent({ sequence: 1234 });
    const output = formatEventLog([event]);
    expect(output).toContain('#1234');
  });

  it('omits sequence prefix when sequence is absent', () => {
    const event = makeEvent({ sequence: undefined });
    const output = formatEventLog([event]);
    expect(output).not.toContain('#');
  });

  it('includes sessionId in output', () => {
    const event = makeEvent({ sessionId: 'my-session' });
    const output = formatEventLog([event]);
    expect(output).toContain('[my-session]');
  });

  it('omits session bracket when sessionId is absent', () => {
    const event = makeEvent({ sessionId: undefined });
    const output = formatEventLog([event]);
    expect(output).not.toContain('[');
  });

  it('formats timestamp as HH:MM:SS from ISO string', () => {
    const event = makeEvent({ timestamp: '2025-06-15T12:34:56.000Z' });
    const output = formatEventLog([event]);
    expect(output).toContain('12:34:56');
  });

  it('joins multiple events with newline separator', () => {
    const e1 = makeEvent({ sequence: 1, type: 'SKILL_STARTED', payload: { skillId: 'a', initialInput: {} } });
    const e2 = makeEvent({ sequence: 2, type: 'SKILL_STARTED', payload: { skillId: 'b', initialInput: {} } });
    const output = formatEventLog([e1, e2]);
    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
  });

  it('includes non-reserved payload keys in outcome summary', () => {
    const event = makeEvent({
      type: 'TOOL_CALLED',
      payload: { tool: 'find-json-record', result: { tier: 'gold', amount: 100 } },
    });
    const output = formatEventLog([event]);
    expect(output).toContain('tier: gold');
    expect(output).toContain('amount: 100');
  });

  it('excludes reserved keys (id, timestamp, sequence, message) from payload summary', () => {
    const event = makeEvent({
      type: 'TOOL_CALLED',
      payload: { tool: 'find-json-record', result: { id: 'x', message: 'hi', timestamp: 'now', tier: 'gold' } },
    });
    const output = formatEventLog([event]);
    // tier should appear, but id/message/timestamp should not appear in the outcome summary
    expect(output).toContain('tier: gold');
    const summaryPart = output.split(' — ')[1] ?? '';
    expect(summaryPart).not.toContain('id: x');
    expect(summaryPart).not.toContain('message: hi');
  });

  it('flattens nested payload in outcome summary with dot notation', () => {
    const event = makeEvent({
      type: 'TOOL_CALLED',
      payload: { tool: 'find-json-record', result: { user: { name: 'Alice' } } },
    });
    const output = formatEventLog([event]);
    expect(output).toContain('user.name: Alice');
  });
});
