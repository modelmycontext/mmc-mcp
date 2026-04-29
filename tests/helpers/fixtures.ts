import type { Event } from '../../src/events/eventBus.js';
import type { BusinessRule } from '../../src/types/businessRule.js';

export function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'test-id',
    type: 'TEST',
    source: 'test',
    payload: {},
    timestamp: new Date('2025-01-01T00:00:00Z'),
    sequence: 1,
    sessionId: 'session-1',
    ...overrides,
  };
}

export function makeBusinessRule(overrides: Partial<BusinessRule> = {}): BusinessRule {
  return {
    id: 'rule-1',
    factId: 'fact-1',
    operator: 'equals',
    value: 'test',
    ...overrides,
  };
}

export function makeFactIdToName(...pairs: [string, string][]): Map<string, string> {
  return new Map(pairs);
}
