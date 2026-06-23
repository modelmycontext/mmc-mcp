import { describe, it, expect } from 'vitest';
import { classifyTerminus, evaluateQuiescence } from '../../src/server/workflowCompletion.js';

describe('classifyTerminus', () => {
  it('classifies a structural terminus (no slice consumes it) as terminus', () => {
    expect(classifyTerminus({
      eventType: 'decision-recorded',
      terminalEventTypes: new Set(['decision-recorded', 'adverse-action-issued']),
      sessionPublishesType: false,
    })).toBe('terminus');
  });

  it('classifies a session-published event as terminus even when not on disk', () => {
    expect(classifyTerminus({
      eventType: 'order-shipped',
      terminalEventTypes: new Set(),
      sessionPublishesType: true,
    })).toBe('terminus');
  });

  it('classifies an event that is neither a known terminus nor session-published as a wiring gap', () => {
    expect(classifyTerminus({
      eventType: 'stray-event',
      terminalEventTypes: new Set(['decision-recorded']),
      sessionPublishesType: false,
    })).toBe('wiring-gap');
  });
});

describe('evaluateQuiescence', () => {
  it('completes only when no branch is in flight, no open todo, and not already emitted', () => {
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 0, hasOpenTodo: false }))
      .toBe('complete');
  });

  it('waits while an automated branch is still in flight', () => {
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 1, hasOpenTodo: false }))
      .toBe('wait');
  });

  it('waits while an interface/view todo is still open', () => {
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 0, hasOpenTodo: true }))
      .toBe('wait');
  });

  it('never completes twice (completionEmitted guard)', () => {
    expect(evaluateQuiescence({ completionEmitted: true, inFlightCount: 0, hasOpenTodo: false }))
      .toBe('wait');
  });

  it('waits while an inbound external event is still expected (awaiting-callback obligation)', () => {
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 0, hasOpenTodo: false, hasOpenAwaitingCallback: true }))
      .toBe('wait');
  });

  it('completes once the awaiting-callback obligation is closed (external event arrived)', () => {
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 0, hasOpenTodo: false, hasOpenAwaitingCallback: false }))
      .toBe('complete');
  });

  it('treats a missing hasOpenAwaitingCallback as no obligation (back-compat)', () => {
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 0, hasOpenTodo: false }))
      .toBe('complete');
  });
});

describe('credit-decisioning decline fan-out (the amputation bug this fixes)', () => {
  // On a decline, the single `application-declined` event fans out to:
  //   • record-decision      → decision-recorded      (terminus)
  //   • issue-adverse-action → adverse-action-issued  (terminus)
  //   • show-credit-decision (interface)               → pending todo
  // First-past-the-post used to fire workflow_completed on whichever of the
  // two automated terminuses won the race, amputating the applicant-facing
  // show-credit-decision branch. Under last-branch-closes it must not.
  const terminalEventTypes = new Set(['decision-recorded', 'adverse-action-issued']);

  it('both automated outcomes are recognised as branch termini', () => {
    expect(classifyTerminus({ eventType: 'decision-recorded', terminalEventTypes, sessionPublishesType: false }))
      .toBe('terminus');
    expect(classifyTerminus({ eventType: 'adverse-action-issued', terminalEventTypes, sessionPublishesType: false }))
      .toBe('terminus');
  });

  it('the first terminus does NOT complete while the sibling automated branch is still running', () => {
    // decision-recorded fired; issue-adverse-action still in flight; show-credit-decision todo pending.
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 1, hasOpenTodo: true }))
      .toBe('wait');
  });

  it('still does NOT complete after both automated branches close while the interface todo is pending', () => {
    // both automated termini done (inFlight 0) but applicant's show-credit-decision not yet shown.
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 0, hasOpenTodo: true }))
      .toBe('wait');
  });

  it('completes only once the interface branch (show-credit-decision) is also done', () => {
    expect(evaluateQuiescence({ completionEmitted: false, inFlightCount: 0, hasOpenTodo: false }))
      .toBe('complete');
  });

  it('a late sibling terminus after completion does not re-complete', () => {
    expect(evaluateQuiescence({ completionEmitted: true, inFlightCount: 0, hasOpenTodo: false }))
      .toBe('wait');
  });
});
