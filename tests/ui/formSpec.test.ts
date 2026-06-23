import { describe, it, expect } from 'vitest';
import {
  buildInterfaceFormSpec,
  buildSliceFormSpec,
  buildViewFormSpec,
  buildValueTypeRegistry,
  controlFor,
} from '@src/ui/formSpec.js';
import type { Slice } from '@src/types/outcomeModel.js';

// Inline fixture (a trimmed credit-decisioning shape). The real export lives in
// `skills/`, which is runtime-synced from GitHub and NOT in source — so a test
// that read it passed locally but ENOENT'd in CI's clean checkout. Keep the
// fixture self-contained: an interface slice with a read-only query context, two
// automations whose jobLink.returnedFact carries composite `fields[]`, and no
// enum options.
const sf = (id: string, name: string, valueType: string) => ({ id, name, valueType, collection: false });

const model = {
  slices: [
    {
      id: 'slice-cd-uwreview',
      name: 'underwriter-review',
      // Interface slices commit a Command — without one, the canonical
      // (command-first) getSlicePattern correctly classifies the slice as a
      // View. Mirror the real model so this fixture is a valid Interface slice.
      command: {
        id: 'command-cd-uwreview',
        name: 'underwriter-review',
        facts: [sf('fact-cd-underwriterDecision', 'underwriter-decision', 'credit-text')],
      },
      interface: {
        id: 'interface-cd-uwreview',
        name: 'underwriter-review-interaction',
        description: "Underwriter reviews the referred application and records 'approve' or 'decline'.",
        facts: [sf('fact-cd-underwriterDecision', 'underwriter-decision', 'credit-text')],
      },
      queries: [
        {
          id: 'query-cd-uwreview',
          name: 'underwriter-review-state',
          facts: [
            sf('fact-cd-applicationId', 'application-id', 'identifier'),
            sf('fact-cd-requestedAmount', 'requested-amount', 'numeric'),
            sf('fact-cd-applicantName', 'applicant-name', 'credit-text'),
            sf('fact-cd-annualIncome', 'annual-income', 'numeric'),
            sf('fact-cd-monthlyDebt', 'monthly-debt', 'numeric'),
            sf('fact-cd-creditScore', 'credit-score', 'numeric'),
            sf('fact-cd-debtToIncomeRatio', 'debt-to-income-ratio', 'numeric'),
            sf('fact-cd-derogatoryMarks', 'derogatory-marks', 'numeric'),
            sf('fact-cd-bankruptcyOnFile', 'bankruptcy-on-file', 'true-false'),
          ],
        },
      ],
      scenarios: [],
    },
    {
      id: 'slice-cd-retrieve',
      name: 'retrieve-loan-application',
      command: { id: 'command-cd-retrieve', name: 'retrieve-loan-application', facts: [] },
      automation: {
        id: 'automation-cd-retrieve',
        name: 'retrieve-loan-application-automation',
        jobLink: {
          returnedFact: {
            id: 'fact-cd-application', name: 'application', valueType: 'loan-application', collection: false,
            fields: [
              { name: 'applicant-name', valueType: 'credit-text' },
              { name: 'annual-income', valueType: 'numeric' },
              { name: 'monthly-debt', valueType: 'numeric' },
            ],
          },
        },
      },
      queries: [],
      scenarios: [],
    },
    {
      id: 'slice-cd-pull',
      name: 'pull-credit-file',
      command: { id: 'command-cd-pull', name: 'pull-credit-file', facts: [] },
      automation: {
        id: 'automation-cd-pull',
        name: 'pull-credit-file-automation',
        jobLink: {
          returnedFact: {
            id: 'fact-cd-creditFile', name: 'credit-file', valueType: 'credit-file', collection: false,
            fields: [
              { name: 'credit-score', valueType: 'numeric' },
              { name: 'debt-to-income-ratio', valueType: 'numeric' },
              { name: 'derogatory-marks', valueType: 'numeric' },
              { name: 'bankruptcy-on-file', valueType: 'true-false' },
            ],
          },
        },
      },
      queries: [],
      scenarios: [],
    },
  ],
};

const slices = model.slices as unknown as Slice[];
const bySliceId = (id: string) => slices.find((s) => s.id === id)!;

describe('buildInterfaceFormSpec — credit-decisioning-shaped fixture', () => {
  it('builds a form for the underwriter-review interface slice', () => {
    const spec = buildInterfaceFormSpec(bySliceId('slice-cd-uwreview'), {
      registry: buildValueTypeRegistry(model),
    });
    expect(spec).not.toBeNull();
    expect(spec!.sliceId).toBe('slice-cd-uwreview');
    expect(spec!.title).toBe('Underwriter Review');
    expect(spec!.submit).toEqual({ tool: 'complete-slice', sliceIdArg: 'slice-cd-uwreview' });
  });

  it('renders only the editable input — query facts are not echoed as a context section', () => {
    const spec = buildInterfaceFormSpec(bySliceId('slice-cd-uwreview'), {
      registry: buildValueTypeRegistry(model),
    })!;
    // Interface (input) steps no longer surface the slice's query facts as a
    // read-only "Information from the application" section — they're read for
    // rules, not for display.
    expect(spec.sections.find((s) => s.id === 'context')).toBeUndefined();

    const input = spec.sections.find((s) => s.id === 'input')!;
    expect(input.fields.map((f) => f.name)).toEqual(['underwriter-decision']);
    expect(input.fields[0]).toMatchObject({ readOnly: false, required: true });
  });

  it('the editable fact is the only thing the form submits (context excluded)', () => {
    const spec = buildInterfaceFormSpec(bySliceId('slice-cd-uwreview'))!;
    const submittable = spec.sections
      .filter((s) => !s.readOnly)
      .flatMap((s) => s.fields.map((f) => f.name));
    expect(submittable).toEqual(['underwriter-decision']);
  });

  it('recovers composite value types from inline fields[] on jobLink.returnedFact', () => {
    const reg = buildValueTypeRegistry(model);
    expect(reg.get('loan-application')?.kind).toBe('composite');
    expect(reg.get('credit-file')?.kind).toBe('composite');

    const ctrl = controlFor('loan-application', reg);
    expect(ctrl.kind).toBe('composite');
    expect(ctrl.fields?.map((f) => f.name)).toEqual(['applicant-name', 'annual-income', 'monthly-debt']);
    expect(ctrl.fields?.find((f) => f.name === 'annual-income')?.control.kind).toBe('number');
  });

  it('the fixture carries no enum options (dormant select support)', () => {
    const reg = buildValueTypeRegistry(model);
    expect([...reg.values()].some((v) => v.kind === 'select')).toBe(false);
  });

  it('renders a <select> once a value type carries options (post-export-change)', () => {
    const reg = buildValueTypeRegistry({
      fakeEnum: { valueType: 'decision-enum', options: ['approve', 'decline', 'refer'] },
    });
    const ctrl = controlFor('decision-enum', reg);
    expect(ctrl.kind).toBe('select');
    expect(ctrl.options).toEqual(['approve', 'decline', 'refer']);
  });

  it('returns null for non-interface slices', () => {
    expect(buildInterfaceFormSpec(bySliceId('slice-cd-pull'))).toBeNull(); // automation
  });
});

// Regression: a read-only View commonly carries an `interface` block just to
// declare its role / displayed facts but has NO command. The canonical
// (command-first) getSlicePattern must classify it as a View, so the form
// renderer draws a read-only "Close" projection — NOT an interface "Confirm"
// form that posts complete-slice and re-renders the view. (A divergent
// interface-first classifier in formSpec previously misread this as Interface.)
describe('view classification — command-less slice with an interface block', () => {
  const viewSlice = {
    id: 'slice-cd-showdecision',
    name: 'show-credit-decision',
    interface: {
      id: 'interface-cd-show',
      name: 'show-credit-decision-interaction',
      role: 'loan-officer',
      facts: [],
    },
    queries: [
      {
        id: 'query-cd-show',
        name: 'credit-decision-state',
        facts: [
          sf('fact-cd-decision', 'decision', 'credit-text'),
          sf('fact-cd-decidedBy', 'decided-by', 'credit-text'),
        ],
      },
    ],
    scenarios: [],
  } as unknown as Slice;

  it('is NOT built as an interface form', () => {
    expect(buildInterfaceFormSpec(viewSlice)).toBeNull();
  });

  it('is built as a read-only view with a Close action', () => {
    const spec = buildSliceFormSpec(viewSlice)!;
    expect(spec).not.toBeNull();
    expect(spec.kind).toBe('view');
    expect(spec.submitLabel).toBe('Close');
    expect(spec.sections.every((s) => s.readOnly)).toBe(true);
    expect(buildViewFormSpec(viewSlice)).not.toBeNull();
  });
});
