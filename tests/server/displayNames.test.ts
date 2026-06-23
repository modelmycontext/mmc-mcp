import { describe, it, expect, afterEach } from 'vitest';
import type { Event } from '../../src/events/eventBus.js';
import type { WorkflowDefinition } from '../../src/skill-engine/interaction-slice-trigger-events.js';
import { ensureRun, _resetRuns } from '../../src/server/workflowRun.js';
import { buildDisplayNameMap, withDisplayNames, eventForDisplay } from '../../src/server/displayNames.js';

const ev = (payload: any, over: Partial<Event> = {}): Event => ({
  id: 'e1', type: 'credit-file-pulled', source: 'credit-decisioning/pull-credit-file',
  payload, timestamp: new Date(), sessionId: 'sess-1', ...over,
});

function wfWith(factIdToName: Map<string, string>): Map<string, WorkflowDefinition> {
  return new Map([['credit-decisioning', {
    name: 'credit-decisioning',
    slices: [{ name: 's', role: '', pattern: 'automation', isInterface: false, givenEventGroups: [], outcomeEventTypes: [], scenarios: [], factNames: [], factIdToName } as any],
    automatedTriggerMap: new Map(),
    terminalEventTypes: new Set<string>(),
  }]]);
}

afterEach(() => { _resetRuns(); });

describe('withDisplayNames', () => {
  it('renames factId payload keys to fact names; passes through unknown/_/sessionId keys', () => {
    const map = new Map([['fact-cd-decision', 'decision'], ['fact-cd-creditScore', 'credit-score']]);
    const out = withDisplayNames(ev({ 'fact-cd-decision': 'approved', 'fact-cd-creditScore': '651', sessionId: 'sess-1', _tool_errors: [{ x: 1 }] }), map);
    expect(out.payload).toEqual({ decision: 'approved', 'credit-score': '651', sessionId: 'sess-1', _tool_errors: [{ x: 1 }] });
  });

  it('returns the SAME event object when nothing changed (no factId keys)', () => {
    const e = ev({ foo: 'bar' });
    expect(withDisplayNames(e, new Map([['fact-x', 'x']]))).toBe(e);
  });

  it('leaves non-object payloads untouched', () => {
    const e = ev(null);
    expect(withDisplayNames(e, new Map([['a', 'b']]))).toBe(e);
  });
});

describe('buildDisplayNameMap', () => {
  it('builds from the matching workflow (by source prefix)', () => {
    const wf = wfWith(new Map([['fact-cd-decision', 'decision']]));
    const map = buildDisplayNameMap('sess-1', 'credit-decisioning/pull-credit-file', wf);
    expect(map.get('fact-cd-decision')).toBe('decision');
  });

  it('unions the session event-schema index', () => {
    ensureRun('sess-1').eventSchemaIndex = new Map([
      ['credit-file-pulled', [{ id: 'fact-cd-creditScore', name: 'credit-score' }]],
    ]);
    const map = buildDisplayNameMap('sess-1', 'some-source', null);
    expect(map.get('fact-cd-creditScore')).toBe('credit-score');
  });
});

describe('eventForDisplay', () => {
  it('translates an event payload end-to-end using its workflow', () => {
    const wf = wfWith(new Map([['fact-cd-decision', 'decision']]));
    const out = eventForDisplay(ev({ 'fact-cd-decision': 'referred' }), wf);
    expect(out.payload).toEqual({ decision: 'referred' });
  });
});
