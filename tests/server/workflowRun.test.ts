import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRun,
  ensureRun,
  addAlias,
  addMember,
  attachSession,
  removeMemberAndMaybeGc,
  isSessionScoped,
  incInFlight,
  decInFlight,
  getInstance,
  ensureInstance,
  registerRunGcHook,
  _runCount,
  _aliasCount,
  _resetRuns,
} from '../../src/server/workflowRun.js';

beforeEach(() => { _resetRuns(); });

describe('WorkflowRun aggregate (#73)', () => {
  describe('lookup', () => {
    it('resolves a run by canonical id and by every alias', () => {
      const run = ensureRun('cid-1');
      addAlias(run, 'reg-1');
      addAlias(run, 'wsid-1');
      expect(getRun('cid-1')).toBe(run);
      expect(getRun('reg-1')).toBe(run);
      expect(getRun('wsid-1')).toBe(run);
      expect(getRun('unknown')).toBeUndefined();
      expect(getRun(undefined)).toBeUndefined();
    });

    it('keeps the heavy maps on ONE run object across all three aliases', () => {
      // The whole point of #73: no map written under multiple keys.
      const run = attachSession('cid-1', 'wsid-1');
      addAlias(run, 'reg-1');
      run.skills.set('s', { id: 's', name: 's' } as any);
      // Same object via any id — not three copies.
      expect(getRun('cid-1')!.skills).toBe(getRun('wsid-1')!.skills);
      expect(getRun('reg-1')!.skills).toBe(run.skills);
      expect(_runCount()).toBe(1);
    });
  });

  describe('attachSession', () => {
    it('stitches the transport cid and the minted correlationId to one run', () => {
      const run = attachSession('cid-1', 'wsid-1', { isTest: true });
      expect(getRun('cid-1')).toBe(run);
      expect(getRun('wsid-1')).toBe(run);
      expect(run.isTest).toBe(true);
      expect(run.members.has('cid-1')).toBe(true);
      expect(_runCount()).toBe(1);
    });

    it('aliases a brand-new correlationId onto the connection\'s existing run', () => {
      const a = attachSession('cid-1', 'wsid-a');
      // wsid-b has no run of its own → it just becomes another alias of A.
      const same = attachSession('cid-1', 'wsid-b');
      expect(same).toBe(a);
      expect(getRun('wsid-b')).toBe(a);
      expect(_runCount()).toBe(1);
    });

    it('migrates a connection to a pre-existing different run, releasing the old one', () => {
      const a = attachSession('cid-1', 'wsid-a');
      const b = ensureRun('wsid-b'); // an independent run already exists
      const got = attachSession('cid-1', 'wsid-b');
      expect(got).toBe(b);
      expect(getRun('cid-1')).toBe(b);
      expect(b.members.has('cid-1')).toBe(true);
      // A had only cid-1 and nothing in flight → reclaimed.
      expect(getRun('wsid-a')).toBeUndefined();
      expect(a.members.size).toBe(0);
      expect(_runCount()).toBe(1);
    });
  });

  describe('isSessionScoped', () => {
    it('is true for a test run and for a run with registered skills, false for a bare run', () => {
      ensureRun('test-run', { isTest: true });
      const skilled = ensureRun('skilled-run');
      skilled.skills.set('s', { id: 's', name: 's' } as any);
      ensureRun('bare-run'); // production: no skills, not test
      expect(isSessionScoped('test-run')).toBe(true);
      expect(isSessionScoped('skilled-run')).toBe(true);
      expect(isSessionScoped('bare-run')).toBe(false);
      expect(isSessionScoped('missing')).toBe(false);
    });
  });

  describe('GC', () => {
    it('reclaims a run only when its last member leaves AND nothing is in flight', () => {
      const run = attachSession('cid-1', 'wsid-1');
      incInFlight('wsid-1');
      // Member gone but a branch is still in flight → not yet.
      expect(removeMemberAndMaybeGc('cid-1')).toBe(false);
      expect(getRun('wsid-1')).toBe(run);
      // Branch settles → now idle → reclaimed on the settle path's recheck.
      decInFlight('wsid-1');
      expect(removeMemberAndMaybeGc('cid-1')).toBe(true);
      expect(getRun('wsid-1')).toBeUndefined();
    });

    it('does not GC while another member connection remains', () => {
      const run = attachSession('cid-1', 'wsid-1');
      addMember(run, 'cid-2');
      addAlias(run, 'cid-2');
      expect(removeMemberAndMaybeGc('cid-1')).toBe(false);
      expect(getRun('wsid-1')).toBe(run);
      expect(removeMemberAndMaybeGc('cid-2')).toBe(true);
      expect(getRun('wsid-1')).toBeUndefined();
    });

    it('fires the GC hook with every alias and empties the alias index', () => {
      const seen: string[][] = [];
      registerRunGcHook((_run, aliases) => seen.push([...aliases].sort()));
      const run = attachSession('cid-1', 'wsid-1');
      addAlias(run, 'reg-1');
      removeMemberAndMaybeGc('cid-1');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(['cid-1', 'reg-1', 'wsid-1']);
      expect(_runCount()).toBe(0);
      expect(_aliasCount()).toBe(0);
    });
  });

  describe('soak — bounded memory', () => {
    it('reclaims all runs after every connection evicts (no leak)', () => {
      for (let i = 0; i < 200; i++) {
        const cid = `cid-${i}`;
        const run = attachSession(cid, `wsid-${i}`, { isTest: true });
        addAlias(run, `reg-${i}`);
        run.skills.set('s', { id: 's', name: 's' } as any);
        run.eventSchemaIndex.set('e', []);
      }
      expect(_runCount()).toBe(200);
      for (let i = 0; i < 200; i++) removeMemberAndMaybeGc(`cid-${i}`);
      expect(_runCount()).toBe(0);
      expect(_aliasCount()).toBe(0);
    });
  });

  // workflow-instance-isolation RFC (D6): one connection can drive several
  // instances sequentially — the two-applications-in-one-session bug. Their
  // lifecycle (inFlight / completionEmitted) must NOT be shared, or the second
  // instance inherits the first's completion and never emits workflow_completed.
  describe('per-instance lifecycle (correlationId-scoped)', () => {
    it('keeps inFlight + completionEmitted independent for two instances on ONE run', () => {
      const runA = attachSession('cid-1', 'corr-A');
      const runB = attachSession('cid-1', 'corr-B'); // second instance, same connection
      expect(runB).toBe(runA);                        // both alias the SAME run
      expect(getRun('corr-A')).toBe(getRun('corr-B'));

      incInFlight('corr-A');
      expect(getInstance('corr-A')!.inFlight).toBe(1);
      expect(getInstance('corr-B')?.inFlight ?? 0).toBe(0); // B unaffected by A

      ensureInstance('corr-A').completionEmitted = true;
      expect(getInstance('corr-B')?.completionEmitted ?? false).toBe(false); // B can still complete
    });

    it('blocks GC while ANY instance on the run is in flight, and drops lifecycle on GC', () => {
      attachSession('cid-1', 'corr-A');
      attachSession('cid-1', 'corr-B');
      incInFlight('corr-B');
      ensureInstance('corr-A').completionEmitted = true;
      // corr-B still in flight → run not reclaimable even though member left.
      expect(removeMemberAndMaybeGc('cid-1')).toBe(false);
      decInFlight('corr-B');
      expect(removeMemberAndMaybeGc('cid-1')).toBe(true);
      // Both instances' lifecycle reclaimed with the run.
      expect(getInstance('corr-A')).toBeUndefined();
      expect(getInstance('corr-B')).toBeUndefined();
    });
  });
});
