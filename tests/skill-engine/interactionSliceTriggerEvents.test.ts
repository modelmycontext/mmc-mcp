import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import {
  loadInteractionSliceTriggerEvents,
  loadInterfaceSliceNames,
  loadViewSliceNames,
  loadEligibleScenariosForSlice,
  loadAutomatedSliceMap,
  loadWorkflowDefinitions,
  loadSliceOutcomes,
  loadSliceFromMdPath,
  invalidateOutcomeModelCache,
  addSliceFactsToMap,
  buildEventSchemaIndex,
  buildScopedFactIdToName,
  collectUnmappedFactIds,
  getSlicePattern,
  validateSlice,
  buildExternalTriggerMap,
} from '../../src/skill-engine/interaction-slice-trigger-events.js';

const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  default: { readdir: mockReaddir, readFile: mockReadFile },
  readdir: mockReaddir,
  readFile: mockReadFile,
}));

function makeDirEntry(name: string) {
  return { name, isDirectory: () => true, isFile: () => false };
}
function makeFileEntry(name: string) {
  return { name, isDirectory: () => false, isFile: () => true };
}

// Minimal outcome model with one interface slice and one automated slice.
// Interface fixtures need `command` — `getSlicePattern` keys off command
// absence as the discriminator for views.
const interfaceModel = JSON.stringify({
  slices: [
    {
      name: 'request-discount',
      interface: true,
      command: { name: 'request-discount' },
      scenarios: [
        { id: 's1', given: [{ name: 'discount-requested' }], then: [] },
        { id: 's2', given: [{ name: 'tier-identified' }], then: [] },
      ],
    },
  ],
});

const automatedModel = JSON.stringify({
  slices: [
    {
      name: 'evaluate-discount',
      scenarios: [
        { id: 's1', given: [], then: [{ name: 'discount-approved', facts: [] }] },
      ],
      facts: [{ id: 'f1', name: 'customer-tier' }],
    },
  ],
});

const mixedModel = JSON.stringify({
  slices: [
    {
      name: 'interface-slice',
      interface: true,
      command: { name: 'interface-slice' },
      scenarios: [{ id: 's1', given: [{ name: 'event-a' }], then: [] }],
    },
    {
      name: 'auto-slice',
      scenarios: [
        {
          id: 's2',
          given: [{ name: 'event-a' }],
          then: [{ name: 'auto-done', facts: [{ id: 'f1', name: 'result' }] }],
          givenBusinessRules: [],
          whenBusinessRules: [],
        },
      ],
      facts: [{ id: 'f1', name: 'result' }],
    },
  ],
});

describe('loadInteractionSliceTriggerEvents', () => {
  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('returns empty array when directory cannot be read', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    expect(await loadInteractionSliceTriggerEvents('/skills')).toEqual([]);
  });

  it('returns empty array when no JSON files present', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('skill.md')]);
    expect(await loadInteractionSliceTriggerEvents('/skills')).toEqual([]);
  });

  it('returns empty array when JSON files have no interface slices', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(automatedModel);
    expect(await loadInteractionSliceTriggerEvents('/skills')).toEqual([]);
  });

  it('collects given event names from interface-bearing slice scenarios', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(interfaceModel);
    const result = await loadInteractionSliceTriggerEvents('/skills');
    expect(result).toContain('discount-requested');
    expect(result).toContain('tier-identified');
  });

  it('deduplicates given names across multiple scenarios', async () => {
    const duplicateModel = JSON.stringify({
      slices: [
        {
          name: 'slice1',
          interface: true,
          command: { name: 'slice1' },
          scenarios: [
            { given: [{ name: 'event-x' }] },
            { given: [{ name: 'event-x' }] },
          ],
        },
      ],
    });
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(duplicateModel);
    const result = await loadInteractionSliceTriggerEvents('/skills');
    expect(result.filter(e => e === 'event-x')).toHaveLength(1);
  });

  it('skips malformed JSON files without throwing', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('bad.json'), makeFileEntry('good.json')]);
    mockReadFile
      .mockResolvedValueOnce('{ invalid json }')
      .mockResolvedValueOnce(interfaceModel);
    const result = await loadInteractionSliceTriggerEvents('/skills');
    expect(result.length).toBeGreaterThan(0);
  });

  it('recurses into subdirectories', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('activity')]) // /skills
      .mockResolvedValueOnce([makeFileEntry('model.json')]); // /skills/activity
    mockReadFile.mockResolvedValue(interfaceModel);
    const result = await loadInteractionSliceTriggerEvents('/skills');
    expect(result).toContain('discount-requested');
  });
});

describe('loadInterfaceSliceNames', () => {
  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('returns empty Set when no JSON files present', async () => {
    mockReaddir.mockResolvedValue([]);
    const result = await loadInterfaceSliceNames('/skills');
    expect(result.size).toBe(0);
  });

  it('returns names of slices that have an interface property', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(interfaceModel);
    const result = await loadInterfaceSliceNames('/skills');
    expect(result.has('request-discount')).toBe(true);
  });

  it('excludes slices without interface property', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(automatedModel);
    const result = await loadInterfaceSliceNames('/skills');
    expect(result.has('evaluate-discount')).toBe(false);
  });

  it('handles multiple slices in one model', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(mixedModel);
    const result = await loadInterfaceSliceNames('/skills');
    expect(result.has('interface-slice')).toBe(true);
    expect(result.has('auto-slice')).toBe(false);
  });

  it('skips malformed JSON files', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('bad.json')]);
    mockReadFile.mockResolvedValue('{bad json}');
    await expect(loadInterfaceSliceNames('/skills')).resolves.toBeDefined();
  });
});

describe('loadViewSliceNames', () => {
  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('returns empty Set when no JSON files present', async () => {
    mockReaddir.mockResolvedValue([]);
    const result = await loadViewSliceNames('/skills');
    expect(result.size).toBe(0);
  });

  it('includes slices with no command (view pattern)', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      slices: [
        { name: 'view-active-discounts', queries: [{ id: 'q' }] },
        { name: 'evaluate-discount', command: { name: 'eval' }, scenarios: [{ given: [{ name: 'requested' }] }] },
      ],
    }));
    const result = await loadViewSliceNames('/skills');
    expect(result.has('view-active-discounts')).toBe(true);
    expect(result.has('evaluate-discount')).toBe(false);
  });

  it('classifies slices with an interface block but no command as views', async () => {
    // `command` absence is the discriminator — a slice with an `interface`
    // block (declaring facts to render) but no command is a view, since it
    // has nothing to commit. This invariant prevents views from leaking into
    // the entry-point/starting-task surfaces (mmc-workflow /workflows endpoint,
    // workbench test panel, mcp todos).
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      slices: [
        { name: 'iface-no-command', interface: true, scenarios: [] },
      ],
    }));
    const result = await loadViewSliceNames('/skills');
    expect(result.has('iface-no-command')).toBe(true);
  });

  it('skips malformed JSON files', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('bad.json')]);
    mockReadFile.mockResolvedValue('{bad json}');
    await expect(loadViewSliceNames('/skills')).resolves.toBeDefined();
  });
});

describe('loadEligibleScenariosForSlice', () => {
  // skillMdPath: /skills/my-activity/my-slice/my-slice.md
  // sliceName = path.basename(path.dirname(skillMdPath)) = 'my-slice'
  // activityDir = path.dirname(path.dirname(skillMdPath)) = /skills/my-activity
  const skillMdPath = path.join('/skills', 'my-activity', 'my-slice', 'my-slice.md');

  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('returns empty array when activity directory cannot be read', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    const result = await loadEligibleScenariosForSlice(skillMdPath, new Set());
    expect(result).toEqual([]);
  });

  it('returns empty array when no JSON file contains matching slice name', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('other.json')]);
    mockReadFile.mockResolvedValue(JSON.stringify({ slices: [{ name: 'different-slice', scenarios: [] }] }));
    const result = await loadEligibleScenariosForSlice(skillMdPath, new Set());
    expect(result).toEqual([]);
  });

  it('returns scenarios when sessionEventTypes satisfies all given[] constraints', async () => {
    const model = JSON.stringify({
      slices: [{
        name: 'my-slice',
        scenarios: [{
          id: 'sc1',
          given: [{ name: 'event-a' }],
          then: [{ name: 'my-outcome', facts: [] }],
        }],
        facts: [],
      }],
    });
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(model);
    const result = await loadEligibleScenariosForSlice(skillMdPath, new Set(['event-a']));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('sc1');
  });

  it('excludes scenarios whose given[] events are not all present', async () => {
    const model = JSON.stringify({
      slices: [{
        name: 'my-slice',
        scenarios: [{
          id: 'sc1',
          given: [{ name: 'event-a' }, { name: 'event-b' }],
          then: [],
        }],
        facts: [],
      }],
    });
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(model);
    // Only 'event-a' present, not 'event-b'
    const result = await loadEligibleScenariosForSlice(skillMdPath, new Set(['event-a']));
    expect(result).toEqual([]);
  });

  it('includes scenarios with empty given[] unconditionally', async () => {
    const model = JSON.stringify({
      slices: [{
        name: 'my-slice',
        scenarios: [{
          id: 'sc-always',
          given: [],
          then: [{ name: 'always-happens', facts: [] }],
        }],
        facts: [],
      }],
    });
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(model);
    const result = await loadEligibleScenariosForSlice(skillMdPath, new Set());
    expect(result).toHaveLength(1);
  });

  it('populates thenOutcomes, givenNames, and factIdToName correctly', async () => {
    const model = JSON.stringify({
      slices: [{
        name: 'my-slice',
        scenarios: [{
          id: 'sc1',
          given: [{ name: 'trigger-event' }],
          then: [{ name: 'outcome-fired', facts: [{ id: 'f1', name: 'result-value', defaultValue: 'yes' }] }],
          givenBusinessRules: [],
          whenBusinessRules: [],
        }],
        facts: [{ id: 'f1', name: 'result-value' }],
      }],
    });
    mockReaddir.mockResolvedValue([makeFileEntry('model.json')]);
    mockReadFile.mockResolvedValue(model);
    const result = await loadEligibleScenariosForSlice(skillMdPath, new Set(['trigger-event']));
    expect(result[0].givenNames).toEqual(['trigger-event']);
    expect(result[0].thenOutcomes[0].name).toBe('outcome-fired');
    expect(result[0].factIdToName.get('f1')).toBe('result-value');
  });

  it('skips malformed JSON files in activity directory', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('bad.json')]);
    mockReadFile.mockResolvedValue('{bad json}');
    const result = await loadEligibleScenariosForSlice(skillMdPath, new Set());
    expect(result).toEqual([]);
  });
});

describe('loadAutomatedSliceMap', () => {
  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('returns empty map when directory cannot be read', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.size).toBe(0);
  });

  it('derives trigger map from non-interface slice scenario.given[].name in workflow JSON', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('my-activity')])              // /skills
      .mockResolvedValueOnce([makeFileEntry('my-activity.json')]);        // /skills/my-activity
    mockReadFile.mockResolvedValue(JSON.stringify({
      slices: [
        {
          name: 'evaluate-discount',
          command: { name: 'evaluate' },
          scenarios: [{ id: 's1', given: [{ name: 'discount-requested' }], then: [] }],
        },
      ],
    }));
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.get('discount-requested')).toEqual([
      path.join('/skills', 'my-activity', 'evaluate-discount', 'evaluate-discount.md'),
    ]);
  });

  it('registers a slice for every distinct given event across its scenarios', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('activity')])
      .mockResolvedValueOnce([makeFileEntry('activity.json')]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      slices: [
        {
          name: 'multi-trigger-slice',
          command: { name: 'multi' },
          scenarios: [
            { id: 's1', given: [{ name: 'eventA' }], then: [] },
            { id: 's2', given: [{ name: 'eventB' }], then: [] },
          ],
        },
      ],
    }));
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.has('eventA')).toBe(true);
    expect(result.has('eventB')).toBe(true);
  });

  it('skips slices marked as interface', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('activity')])
      .mockResolvedValueOnce([makeFileEntry('activity.json')]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      slices: [
        {
          name: 'interface-slice',
          interface: true,
          command: { name: 'interface-slice' },
          scenarios: [{ id: 's1', given: [{ name: 'some-event' }], then: [] }],
        },
      ],
    }));
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.size).toBe(0);
  });

  it('includes an automation slice based on its own pattern, regardless of name collisions in other activities', async () => {
    // Regression: inclusion must be decided per-slice via getSlicePattern, NOT
    // by a global slice-name set. A name like `request-discount` could be an
    // interface slice in another activity; that must not cause THIS activity's
    // automation slice of the same name to be skipped (the old name-keyed guard
    // wrongly did, dropping its event subscription).
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('activity')])
      .mockResolvedValueOnce([makeFileEntry('activity.json')]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      slices: [
        {
          name: 'request-discount',
          command: { name: 'request' },
          scenarios: [{ id: 's1', given: [{ name: 'some-event' }], then: [] }],
        },
      ],
    }));
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.get('some-event')).toEqual([
      path.join('/skills', 'activity', 'request-discount', 'request-discount.md'),
    ]);
  });

  it('omits slices whose scenarios have no given events (entry slices)', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('activity')])
      .mockResolvedValueOnce([makeFileEntry('activity.json')]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      slices: [
        {
          name: 'no-trigger-slice',
          command: { name: 'no-trigger' },
          scenarios: [{ id: 's1', given: [], then: [{ name: 'something-happened', facts: [] }] }],
        },
      ],
    }));
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.size).toBe(0);
  });

  it('appends a second slice path when two slices share a trigger event', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('activity')])
      .mockResolvedValueOnce([makeFileEntry('activity.json')]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      slices: [
        { name: 'a', command: { name: 'a' }, scenarios: [{ id: 's1', given: [{ name: 'shared-event' }], then: [] }] },
        { name: 'b', command: { name: 'b' }, scenarios: [{ id: 's1', given: [{ name: 'shared-event' }], then: [] }] },
      ],
    }));
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.get('shared-event')).toEqual([
      path.join('/skills', 'activity', 'a', 'a.md'),
      path.join('/skills', 'activity', 'b', 'b.md'),
    ]);
  });

  it('skips malformed JSON files without crashing', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('activity')])
      .mockResolvedValueOnce([makeFileEntry('broken.json'), makeFileEntry('ok.json')]);
    mockReadFile
      .mockResolvedValueOnce('not-json{')
      .mockResolvedValueOnce(JSON.stringify({
        slices: [{ name: 'ok-slice', command: { name: 'ok' }, scenarios: [{ given: [{ name: 'evt' }], then: [] }] }],
      }));
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.has('evt')).toBe(true);
  });
});

// Workflow model with interface + automated + view slices for loadWorkflowDefinitions
// tests. Interface slices must carry a `command` (the discriminator); the
// trailing `view` slice has no command — `getSlicePattern` classifies it as
// a view, which loadWorkflowDefinitions records as isInterface=false.
const workflowModel = JSON.stringify({
  slices: [
    {
      name: 'request',
      interface: true,
      command: { name: 'request' },
      role: 'requester',
      outcomes: [{ name: 'requested', facts: [] }],
      scenarios: [],
    },
    {
      name: 'approve',
      role: 'system',
      command: { name: 'approve' },
      outcomes: [{ name: 'approved', facts: [] }],
      scenarios: [{ id: 's1', given: [{ name: 'requested' }], then: [] }],
    },
    {
      name: 'view',
      interface: true,
      role: 'requester',
      outcomes: [],
      scenarios: [{ id: 's2', given: [{ name: 'approved' }], then: [] }],
    },
  ],
});

describe('loadWorkflowDefinitions', () => {
  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('returns empty map when directory cannot be read', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    const result = await loadWorkflowDefinitions('/skills');
    expect(result.size).toBe(0);
  });

  it('loads workflow with correct slice summaries', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('my-workflow')])
      .mockResolvedValueOnce([makeFileEntry('my-workflow.json')]);
    mockReadFile.mockResolvedValue(workflowModel);
    const result = await loadWorkflowDefinitions('/skills');
    expect(result.has('my-workflow')).toBe(true);
    const wf = result.get('my-workflow')!;
    expect(wf.slices).toHaveLength(3);
    expect(wf.slices[0].isInterface).toBe(true);  // request (interface + command)
    expect(wf.slices[1].isInterface).toBe(false); // approve (automation)
    expect(wf.slices[2].isInterface).toBe(false); // view (no command → view, not interface)
  });

  it('extracts givenEventGroups from scenario given arrays', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('wf')])
      .mockResolvedValueOnce([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(workflowModel);
    const result = await loadWorkflowDefinitions('/skills');
    const wf = result.get('wf')!;
    // 'approve' slice has given: [requested]
    expect(wf.slices[1].givenEventGroups).toEqual([['requested']]);
    // 'view' slice has given: [approved]
    expect(wf.slices[2].givenEventGroups).toEqual([['approved']]);
  });

  it('extracts outcomeEventTypes from slice outcomes', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('wf')])
      .mockResolvedValueOnce([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(workflowModel);
    const result = await loadWorkflowDefinitions('/skills');
    const wf = result.get('wf')!;
    expect(wf.slices[0].outcomeEventTypes).toEqual(['requested']);
    expect(wf.slices[1].outcomeEventTypes).toEqual(['approved']);
    expect(wf.slices[2].outcomeEventTypes).toEqual([]);
  });

  it('automatedTriggerMap is derived from JSON scenario.given (not from .md frontmatter)', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('wf')])
      .mockResolvedValueOnce([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(workflowModel);
    const result = await loadWorkflowDefinitions('/skills');
    const wf = result.get('wf')!;
    // 'approve' (automation) subscribes to 'requested'; 'view' is interface,
    // not automation, so its 'approved' subscription must NOT be registered.
    expect(wf.automatedTriggerMap.get('requested')).toBe('approve');
    expect(wf.automatedTriggerMap.has('approved')).toBe(false);
  });

  it('terminalEventTypes is empty when every outcome is consumed by another slice', async () => {
    // workflowModel: requested → approved → view consumes both. No terminus.
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('wf')])
      .mockResolvedValueOnce([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(workflowModel);
    const result = await loadWorkflowDefinitions('/skills');
    const wf = result.get('wf')!;
    expect([...wf.terminalEventTypes]).toEqual([]);
  });

  it('terminalEventTypes contains outcomes that no slice in the workflow consumes', async () => {
    const modelWithTerminus = JSON.stringify({
      slices: [
        {
          name: 'kick-off',
          interface: true,
          command: { name: 'kick-off' },
          outcomes: [{ name: 'kicked-off', facts: [] }],
          scenarios: [],
        },
        {
          name: 'do-work',
          command: { name: 'do-work' },
          outcomes: [{ name: 'work-done', facts: [] }],
          scenarios: [{ id: 's1', given: [{ name: 'kicked-off' }], then: [] }],
        },
      ],
    });
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('chain')])
      .mockResolvedValueOnce([makeFileEntry('chain.json')]);
    mockReadFile.mockResolvedValue(modelWithTerminus);
    const result = await loadWorkflowDefinitions('/skills');
    const wf = result.get('chain')!;
    // kicked-off is consumed by do-work; work-done is unconsumed → terminus.
    expect([...wf.terminalEventTypes]).toEqual(['work-done']);
  });
});

// Model for loadSliceOutcomes tests
const outcomeSliceModel = JSON.stringify({
  slices: [
    {
      name: 'activate',
      outcomes: [
        {
          name: 'activated',
          facts: [
            { id: 'f1', name: 'order-id' },
            { id: 'f2', name: 'total', calculatedValue: 'amount * 1.1' },
          ],
        },
      ],
      scenarios: [],
    },
  ],
});

describe('loadSliceOutcomes', () => {
  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('returns null when activity directory cannot be read', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    const result = await loadSliceOutcomes('/skills/wf/activate/activate.md');
    expect(result).toBeNull();
  });

  it('loads outcomes with facts and factIdToName map', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(outcomeSliceModel);
    const result = await loadSliceOutcomes('/skills/wf/activate/activate.md');
    expect(result).not.toBeNull();
    expect(result!.outcomes).toHaveLength(1);
    expect(result!.outcomes[0].name).toBe('activated');
    expect(result!.outcomes[0].facts).toHaveLength(2);
    expect(result!.outcomes[0].facts[1].calculatedValue).toBe('amount * 1.1');
    expect(result!.totalScenarios).toBe(0);
  });

  it('reports totalScenarios from the slice', async () => {
    const model = JSON.stringify({
      slices: [{
        name: 'activate',
        outcomes: [{ name: 'activated', facts: [] }],
        scenarios: [
          { id: 's1', given: [{ name: 'evt-a' }], then: [] },
          { id: 's2', given: [{ name: 'evt-b' }], then: [] },
        ],
      }],
    });
    mockReaddir.mockResolvedValue([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(model);
    const result = await loadSliceOutcomes('/skills/wf/activate/activate.md');
    expect(result!.totalScenarios).toBe(2);
  });

  it('returns null when slice name not found in model', async () => {
    mockReaddir.mockResolvedValue([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(outcomeSliceModel);
    const result = await loadSliceOutcomes('/skills/wf/nonexistent/nonexistent.md');
    expect(result).toBeNull();
  });
});

describe('addSliceFactsToMap', () => {
  it('adds slice-level, query, command, outcome and scenario.then facts', () => {
    const slice = {
      facts: [{ id: 'f-slice', name: 'slice-fact' }],
      outcomes: [{ name: 'o', facts: [{ id: 'f-out', name: 'out-fact' }] }],
      queries: [{
        facts: [{ id: 'f-q', name: 'q-fact' }],
        outcomes: [{ facts: [{ id: 'f-qout', name: 'q-out' }] }],
      }],
      command: {
        facts: [{ id: 'f-cmd', name: 'cmd-fact' }],
        outcomes: [{ facts: [{ id: 'f-cmdout', name: 'cmd-out' }] }],
      },
      scenarios: [{ then: [{ facts: [{ id: 'f-then', name: 'then-fact' }] }] }],
    };
    const map = new Map<string, string>();
    addSliceFactsToMap(map, slice);
    expect(map.get('f-slice')).toBe('slice-fact');
    expect(map.get('f-out')).toBe('out-fact');
    expect(map.get('f-q')).toBe('q-fact');
    expect(map.get('f-qout')).toBe('q-out');
    expect(map.get('f-cmd')).toBe('cmd-fact');
    expect(map.get('f-cmdout')).toBe('cmd-out');
    expect(map.get('f-then')).toBe('then-fact');
  });

  it('skips entries missing id or name', () => {
    const map = new Map<string, string>();
    addSliceFactsToMap(map, {
      facts: [{ id: 'has-both', name: 'ok' }, { id: 'no-name' }, { name: 'no-id' }, null],
    });
    expect(map.size).toBe(1);
    expect(map.get('has-both')).toBe('ok');
  });
});

describe('buildEventSchemaIndex', () => {
  it('indexes outcomes from slice.outcomes, slice.command.outcomes, and scenario.then', () => {
    const slices = [
      {
        outcomes: [{ name: 'evt-a', facts: [{ id: 'f-a', name: 'fact-a' }] }],
        command: { outcomes: [{ name: 'evt-b', facts: [{ id: 'f-b', name: 'fact-b' }] }] },
        scenarios: [{ then: [{ name: 'evt-c', facts: [{ id: 'f-c', name: 'fact-c' }] }] }],
      },
    ];
    const idx = buildEventSchemaIndex(slices);
    expect(idx.get('evt-a')).toEqual([{ id: 'f-a', name: 'fact-a' }]);
    expect(idx.get('evt-b')).toEqual([{ id: 'f-b', name: 'fact-b' }]);
    expect(idx.get('evt-c')).toEqual([{ id: 'f-c', name: 'fact-c' }]);
  });

  it('records empty fact arrays for events with no declared facts', () => {
    const idx = buildEventSchemaIndex([{ outcomes: [{ name: 'bare-event' }] }]);
    expect(idx.has('bare-event')).toBe(true);
    expect(idx.get('bare-event')).toEqual([]);
  });

  it('skips entries lacking a name', () => {
    const idx = buildEventSchemaIndex([{ outcomes: [{ facts: [{ id: 'x', name: 'y' }] }] }]);
    expect(idx.size).toBe(0);
  });
});

describe('buildScopedFactIdToName', () => {
  it('union of own facts and facts on outcome events declared in scenario.given', () => {
    const sliceA = { outcomes: [{ name: 'tier-selected', facts: [{ id: 'f-tier', name: 'plan-tier' }] }] };
    const sliceB = {
      facts: [{ id: 'f-own', name: 'own-fact' }],
      scenarios: [{ given: [{ name: 'tier-selected' }], then: [] }],
    };
    const idx = buildEventSchemaIndex([sliceA, sliceB]);
    const map = buildScopedFactIdToName(sliceB, idx);
    expect(map.get('f-own')).toBe('own-fact');
    expect(map.get('f-tier')).toBe('plan-tier');
  });

  it('does not include facts from outcomes that the slice does not subscribe to via given', () => {
    const sliceA = {
      outcomes: [
        { name: 'subscribed-evt', facts: [{ id: 'f-sub', name: 'sub' }] },
        { name: 'unsubscribed-evt', facts: [{ id: 'f-other', name: 'other' }] },
      ],
    };
    const sliceB = {
      scenarios: [{ given: [{ name: 'subscribed-evt' }], then: [] }],
    };
    const idx = buildEventSchemaIndex([sliceA, sliceB]);
    const map = buildScopedFactIdToName(sliceB, idx);
    expect(map.has('f-sub')).toBe(true);
    expect(map.has('f-other')).toBe(false);
  });

  it('returns own-only when scenarios have no given references', () => {
    const slice = { facts: [{ id: 'f-1', name: 'one' }], scenarios: [{ given: [], then: [] }] };
    const idx = buildEventSchemaIndex([slice]);
    const map = buildScopedFactIdToName(slice, idx);
    expect([...map.entries()]).toEqual([['f-1', 'one']]);
  });
});

describe('collectUnmappedFactIds', () => {
  it('flags factIds in givenBusinessRules / whenBusinessRules that are not in the scoped lookup', () => {
    const slice = {
      scenarios: [{
        givenBusinessRules: [{ factId: 'f-known', operator: 'equals', value: 'x' }],
        whenBusinessRules: [{ factId: 'f-missing', operator: 'equals', value: 'y' }],
      }],
    };
    const scoped = new Map([['f-known', 'known']]);
    const refs = collectUnmappedFactIds(slice, scoped);
    expect(refs).toHaveLength(1);
    expect(refs[0].factId).toBe('f-missing');
    expect(refs[0].location).toBe('scenario[0].whenBusinessRules[0]');
  });

  it('flags bare factIds in command.jobLink.inputMappings but ignores @-prefixed mappings', () => {
    const slice = {
      command: {
        jobLink: {
          inputMappings: {
            customerId: 'f-customer',
            tier: '@plan-tier',
            empty: '',
          },
        },
      },
    };
    const refs = collectUnmappedFactIds(slice, new Map());
    expect(refs).toHaveLength(1);
    expect(refs[0].factId).toBe('f-customer');
    expect(refs[0].location).toBe('command.jobLink.inputMappings.customerId');
  });

  it('ignores Formula-mode inputMapping values (constants, {{templates}}, arithmetic) — only bare factIds are checked', () => {
    const slice = {
      automation: {
        jobLink: {
          inputMappings: {
            toEmail: '@application-form.email',                       // fact ref → skipped (@)
            subject: 'Update on your Driving Academy application',    // constant → skipped
            bodyText: 'Hi {{application-id}}, you were not accepted.', // template → skipped
            fee: 'orderValue * 0.1',                                  // arithmetic → skipped
            legacy: 'fact-customer',                                  // bare factId → flagged
          },
        },
      },
    };
    const refs = collectUnmappedFactIds(slice, new Map());
    expect(refs).toHaveLength(1);
    expect(refs[0].factId).toBe('fact-customer');
    expect(refs[0].location).toBe('automation.jobLink.inputMappings.legacy');
  });

  it('flags bare factIds in queries[*].jobLink.inputMappings', () => {
    const slice = {
      queries: [
        { jobLink: { inputMappings: { p: 'f-q1' } } },
        { jobLink: { inputMappings: { p: '@whatever' } } },
        { jobLink: { inputMappings: { p: 'f-q3' } } },
      ],
    };
    const refs = collectUnmappedFactIds(slice, new Map([['f-q3', 'q3']]));
    expect(refs.map((r) => r.factId)).toEqual(['f-q1']);
    expect(refs[0].location).toBe('queries[0].jobLink.inputMappings.p');
  });

  it('returns empty when every reference resolves through the scoped map', () => {
    const slice = {
      scenarios: [{
        whenBusinessRules: [{ factId: 'f-a', operator: 'equals', value: 'x' }],
      }],
      command: { jobLink: { inputMappings: { p: 'f-b' } } },
    };
    const scoped = new Map([['f-a', 'a'], ['f-b', 'b']]);
    expect(collectUnmappedFactIds(slice, scoped)).toEqual([]);
  });

  it('annotates each unmapped ref with scenarioIndex and suggestedGiven from the event-schema index', () => {
    const slice = {
      scenarios: [
        // index 0
        { whenBusinessRules: [{ factId: 'f-other', operator: 'equals', value: 'x' }] },
        // index 1
        { whenBusinessRules: [{ factId: 'f-tier', operator: 'equals', value: 'gold' }] },
      ],
    };
    const eventSchemaIndex = new Map<string, { id: string; name: string }[]>([
      ['tier-selected', [{ id: 'f-tier', name: 'plan-tier' }]],
    ]);
    const refs = collectUnmappedFactIds(slice, new Map(), eventSchemaIndex);
    const tierRef = refs.find((r) => r.factId === 'f-tier');
    expect(tierRef?.scenarioIndex).toBe(1);
    expect(tierRef?.suggestedGiven).toBe('tier-selected');
    const otherRef = refs.find((r) => r.factId === 'f-other');
    expect(otherRef?.scenarioIndex).toBe(0);
    expect(otherRef?.suggestedGiven).toBeUndefined();
  });
});

describe('loadSliceFromMdPath — scoped factIdToName', () => {
  beforeEach(() => {
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    invalidateOutcomeModelCache();
  });

  it('returns scoped (own ∪ given) factIdToName, not workflow-wide', async () => {
    const model = JSON.stringify({
      slices: [
        {
          name: 'slice-a',
          outcomes: [{ name: 'a-published', facts: [{ id: 'f-a', name: 'a' }] }],
          facts: [{ id: 'f-a-private', name: 'a-private' }],
        },
        {
          name: 'slice-b',
          facts: [{ id: 'f-b-own', name: 'b-own' }],
          scenarios: [{ id: 's', given: [{ name: 'a-published' }], then: [] }],
        },
        {
          name: 'slice-c',
          outcomes: [{ name: 'c-published', facts: [{ id: 'f-c', name: 'c' }] }],
        },
      ],
    });
    mockReaddir.mockResolvedValue([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(model);

    const loaded = await loadSliceFromMdPath('/skills/wf/slice-b/slice-b.md');
    expect(loaded).not.toBeNull();
    // Slice B sees its own fact + the fact on the given event.
    expect(loaded!.factIdToName.get('f-b-own')).toBe('b-own');
    expect(loaded!.factIdToName.get('f-a')).toBe('a');
    // It MUST NOT see slice A's private fact or slice C's outcome fact.
    expect(loaded!.factIdToName.has('f-a-private')).toBe(false);
    expect(loaded!.factIdToName.has('f-c')).toBe(false);
  });
});

// External-event-triggered automation slice (the Driving Academy
// `translate-application-form` shape): the trigger is NOT a scenario.given,
// it is an `external` outcomeLink connecting an externalOutcome to the slice's
// query. The runtime must route the inbound webhook event off this registry.
const externalTriggerModel = JSON.stringify({
  slices: [
    {
      name: 'translate-application-form',
      command: { name: 'translate-application-form' },
      queries: [
        {
          id: 'query-1',
          name: 'submitted-form',
          outcomes: [{ id: 'externalOutcome-x', name: 'application-form-submitted', facts: [] }],
        },
      ],
      outcomes: [{ name: 'application-received', facts: [] }],
      scenarios: [{ id: 's1', given: [], then: [{ name: 'application-received', facts: [] }] }],
    },
  ],
  externalOutcomes: [{ id: 'externalOutcome-x', name: 'application-form-submitted', facts: [] }],
  outcomeLinks: [{ fromId: 'externalOutcome-x', toId: 'query-1', type: 'external' }],
});

describe('buildExternalTriggerMap', () => {
  it('maps a slice to the external event whose externalOutcome links to its query', () => {
    const map = buildExternalTriggerMap(JSON.parse(externalTriggerModel));
    expect(map.get('translate-application-form')).toEqual(['application-form-submitted']);
  });

  it('returns an empty map when there are no outcomeLinks', () => {
    const map = buildExternalTriggerMap({ slices: [{ name: 's', queries: [{ id: 'q' }] }] });
    expect(map.size).toBe(0);
  });

  it('ignores non-external links and links with no resolvable outcome or query', () => {
    const map = buildExternalTriggerMap({
      slices: [{ name: 's', queries: [{ id: 'q1' }] }],
      externalOutcomes: [{ id: 'eo1', name: 'ext-evt' }],
      outcomeLinks: [
        { fromId: 'eo1', toId: 'q1', type: 'internal' },   // wrong type
        { fromId: 'eo-missing', toId: 'q1', type: 'external' }, // unknown outcome
        { fromId: 'eo1', toId: 'q-missing', type: 'external' }, // unknown query
      ],
    });
    expect(map.size).toBe(0);
  });
});

describe('loadAutomatedSliceMap — external-event triggers', () => {
  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('registers the external event as a trigger for the consuming automation slice', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('da-nzta-enrollment')])
      .mockResolvedValueOnce([makeFileEntry('da-nzta-enrollment.json')]);
    mockReadFile.mockResolvedValue(externalTriggerModel);
    const result = await loadAutomatedSliceMap('/skills');
    expect(result.get('application-form-submitted')).toEqual([
      path.join('/skills', 'da-nzta-enrollment', 'translate-application-form', 'translate-application-form.md'),
    ]);
  });
});

describe('loadWorkflowDefinitions — external-event triggers', () => {
  beforeEach(() => { mockReaddir.mockReset(); mockReadFile.mockReset(); invalidateOutcomeModelCache(); });

  it('folds the external event into givenEventGroups and the automatedTriggerMap', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('da-nzta-enrollment')])
      .mockResolvedValueOnce([makeFileEntry('da-nzta-enrollment.json')]);
    mockReadFile.mockResolvedValue(externalTriggerModel);
    const result = await loadWorkflowDefinitions('/skills');
    const wf = result.get('da-nzta-enrollment')!;
    const slice = wf.slices.find(s => s.name === 'translate-application-form')!;
    expect(slice.givenEventGroups).toContainEqual(['application-form-submitted']);
    expect(wf.automatedTriggerMap.get('application-form-submitted')).toBe('translate-application-form');
    // application-form-submitted is now consumed → not terminal; application-received IS terminal.
    expect(wf.terminalEventTypes.has('application-form-submitted')).toBe(false);
    // The inbound external event is surfaced on the workflow for the awaiting-callback gate.
    expect([...wf.externalTriggerEvents]).toEqual(['application-form-submitted']);
  });

  it('externalTriggerEvents is empty for a workflow with no external links', async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('wf')])
      .mockResolvedValueOnce([makeFileEntry('wf.json')]);
    mockReadFile.mockResolvedValue(workflowModel);
    const result = await loadWorkflowDefinitions('/skills');
    expect([...result.get('wf')!.externalTriggerEvents]).toEqual([]);
  });
});

describe('getSlicePattern', () => {
  it('returns "interface" when slice has both interface block and command', () => {
    expect(getSlicePattern({ interface: true, command: { name: 'c' } })).toBe('interface');
    expect(getSlicePattern({ interface: { id: 'i' }, command: { name: 'c' } })).toBe('interface');
  });

  it('returns "view" when slice has no command and no interface', () => {
    expect(getSlicePattern({ queries: [{ id: 'q' }] })).toBe('view');
    expect(getSlicePattern({})).toBe('view');
  });

  it('returns "automation" when slice has a command and no interface', () => {
    expect(getSlicePattern({ command: { name: 'c' }, queries: [{ id: 'q' }] })).toBe('automation');
  });

  it('returns "view" when slice has an interface block but no command', () => {
    // Views often carry an `interface` block to declare which facts they
    // render to the user. `command` absence is the real discriminator —
    // without it the slice has nothing to commit and must never surface
    // as a starting/executable task (mmc-workflow todo, test panel, etc.).
    expect(getSlicePattern({ interface: true })).toBe('view');
    expect(getSlicePattern({ interface: { id: 'i' }, queries: [{ id: 'q' }] })).toBe('view');
  });
});

describe('validateSlice', () => {
  describe('interface pattern', () => {
    it('accepts a well-formed interface slice', () => {
      const result = validateSlice({
        interface: true,
        command: { name: 'c' },
        outcomes: [{ name: 'requested', facts: [] }],
        scenarios: [{ given: [], when: 'c', then: [{ name: 'requested' }] }],
      });
      expect(result.pattern).toBe('interface');
      expect(result.errors).toEqual([]);
    });

    it('a slice with interface block but no command classifies as view, not interface', () => {
      // `command` absence is the discriminator — without one the slice is a
      // view (nothing to commit). The validator then applies view rules: this
      // fixture has Outcomes (forbidden) and missing Queries (required).
      const result = validateSlice({
        interface: true,
        outcomes: [{ name: 'requested', facts: [] }],
        scenarios: [{ given: [], when: 'c', then: [{ name: 'requested' }] }],
      });
      expect(result.pattern).toBe('view');
      expect(result.errors.map(e => e.code)).toContain('VIEW_HAS_OUTCOMES');
      expect(result.errors.map(e => e.code)).toContain('VIEW_MISSING_QUERIES');
    });

    it('flags interface slice with no outcomes', () => {
      const result = validateSlice({
        interface: true,
        command: { name: 'c' },
        outcomes: [],
        scenarios: [{ given: [], when: 'c', then: [] }],
      });
      expect(result.errors.map(e => e.code)).toContain('INTERFACE_MISSING_OUTCOMES');
    });

    it('flags interface slice with no scenarios', () => {
      const result = validateSlice({
        interface: true,
        command: { name: 'c' },
        outcomes: [{ name: 'requested', facts: [] }],
        scenarios: [],
      });
      expect(result.errors.map(e => e.code)).toContain('INTERFACE_MISSING_SCENARIO');
    });

    it('allows interface slice with zero queries (entry-point)', () => {
      const result = validateSlice({
        interface: true,
        command: { name: 'c' },
        outcomes: [{ name: 'requested', facts: [] }],
        queries: [],
        scenarios: [{ given: [], when: 'c', then: [{ name: 'requested' }] }],
      });
      expect(result.errors).toEqual([]);
    });

    it('allows interface slice with multiple queries (supporting facts)', () => {
      const result = validateSlice({
        interface: true,
        command: { name: 'c' },
        outcomes: [{ name: 'requested', facts: [] }],
        queries: [{ id: 'q1' }, { id: 'q2' }],
        scenarios: [{ given: [], when: 'c', then: [{ name: 'requested' }] }],
      });
      expect(result.errors).toEqual([]);
    });
  });

  describe('automation pattern', () => {
    it('accepts a well-formed automation slice', () => {
      const result = validateSlice({
        command: { name: 'c' },
        queries: [{ id: 'q' }],
        outcomes: [{ name: 'approved', facts: [] }],
        scenarios: [{ given: [{ name: 'requested' }], then: [] }],
      });
      expect(result.pattern).toBe('automation');
      expect(result.errors).toEqual([]);
    });

    it('flags automation with zero queries', () => {
      const result = validateSlice({
        command: { name: 'c' },
        queries: [],
        outcomes: [{ name: 'approved', facts: [] }],
        scenarios: [{ given: [{ name: 'requested' }] }],
      });
      expect(result.errors.map(e => e.code)).toContain('AUTOMATION_QUERY_CARDINALITY');
    });

    it('flags automation with more than one query', () => {
      const result = validateSlice({
        command: { name: 'c' },
        queries: [{ id: 'q1' }, { id: 'q2' }],
        outcomes: [{ name: 'approved', facts: [] }],
        scenarios: [{ given: [{ name: 'requested' }] }],
      });
      expect(result.errors.map(e => e.code)).toContain('AUTOMATION_QUERY_CARDINALITY');
    });

    it('flags automation with no subscription (no scenario.given)', () => {
      const result = validateSlice({
        command: { name: 'c' },
        queries: [{ id: 'q' }],
        outcomes: [{ name: 'approved', facts: [] }],
        scenarios: [{ given: [], then: [] }],
      });
      expect(result.errors.map(e => e.code)).toContain('AUTOMATION_MISSING_SUBSCRIPTION');
    });

    it('flags automation missing outcomes', () => {
      const result = validateSlice({
        command: { name: 'c' },
        queries: [{ id: 'q' }],
        outcomes: [],
        scenarios: [{ given: [{ name: 'requested' }] }],
      });
      expect(result.errors.map(e => e.code)).toContain('AUTOMATION_MISSING_OUTCOMES');
    });
  });

  describe('view pattern', () => {
    it('accepts a well-formed view slice', () => {
      const result = validateSlice({
        queries: [{ id: 'q' }],
        scenarios: [{ given: [{ name: 'data-asked' }], then: [] }],
      });
      expect(result.pattern).toBe('view');
      expect(result.errors).toEqual([]);
    });

    it('flags view with zero queries', () => {
      const result = validateSlice({});
      expect(result.errors.map(e => e.code)).toContain('VIEW_MISSING_QUERIES');
    });

    it('flags view with no scenarios (subscription declaration missing)', () => {
      const result = validateSlice({
        queries: [{ id: 'q' }],
      });
      expect(result.errors.map(e => e.code)).toContain('VIEW_MISSING_SCENARIO');
    });

    it('flags view that emits outcomes', () => {
      const result = validateSlice({
        queries: [{ id: 'q' }],
        outcomes: [{ name: 'something-shown', facts: [] }],
      });
      expect(result.errors.map(e => e.code)).toContain('VIEW_HAS_OUTCOMES');
    });

    it('allows view scenarios with given and then (then = displayed-facts contract)', () => {
      const result = validateSlice({
        queries: [{ id: 'q' }],
        scenarios: [{ given: [{ name: 'data-asked' }], then: [{ name: 'shown', facts: [] }] }],
      });
      expect(result.errors).toEqual([]);
    });

    it('allows view scenarios with given but no then', () => {
      const result = validateSlice({
        queries: [{ id: 'q' }],
        scenarios: [{ given: [{ name: 'data-asked' }], then: [] }],
      });
      expect(result.errors).toEqual([]);
    });

    it('flags view whose scenarios carry a When guard', () => {
      const result = validateSlice({
        queries: [{ id: 'q' }],
        scenarios: [{
          given: [{ name: 'data-asked' }],
          whenBusinessRules: [{ factId: 'f1', operator: 'eq', value: 'x' }],
        }],
      });
      expect(result.errors.map(e => e.code)).toContain('VIEW_HAS_WHEN');
    });
  });
});
