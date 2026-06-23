import { describe, it, expect } from 'vitest';
import {
  indexModelFactsById,
  resolvePublicFormSpec,
  type FormTemplate,
} from '../../src/forms/formTemplate.js';

// Inline model fixture (NOT read from the gitignored skills/ dir — see
// memory feedback_tests_no_gitignored_skills). Mirrors the real export shape:
// facts carry id/name/valueType, enums inline `options[]`, composites `fields[]`.
const MODEL = {
  slices: [
    {
      interface: {
        facts: [
          { id: 'fact-name', name: 'full-name', valueType: 'text' },
          { id: 'fact-dob', name: 'date-of-birth', valueType: 'date' },
          { id: 'fact-gender', name: 'gender', valueType: 'gender', options: ['female', 'male', 'other'] },
          { id: 'fact-consent', name: 'consent-given', valueType: 'true-false' },
        ],
      },
      queries: [
        { facts: [{ id: 'fact-applicant', name: 'applicant-id', valueType: 'text' }] },
      ],
      // A composite fact whose sub-fields a template can address individually.
      automation: {
        jobs: [
          {
            returnedFact: {
              id: 'fact-app', name: 'application-form', valueType: 'application-form',
              fields: [
                { name: 'first-name', valueType: 'text' },
                { name: 'emergency-phone', valueType: 'text' },
                { name: 'current-licence', valueType: 'licence-class', options: ['none', 'learners', 'restricted', 'full'] },
              ],
            },
          },
        ],
      },
    },
  ],
};

const TEMPLATE: FormTemplate = {
  id: 'tmpl-enrol',
  displayName: 'Enrolment application',
  externalOutcomeName: 'application-form-submitted',
  branding: { organisationName: 'Driving Academy', tagline: 'Heart at Work' },
  sections: [
    {
      id: 'about',
      title: 'About you',
      intro: 'Tell us who you are.',
      fields: [
        { factId: 'fact-applicant', readOnly: true },
        { factId: 'fact-name', required: true, colSpan: 1 },
        { factId: 'fact-dob', required: true, colSpan: 1, label: 'Birth date', helpText: 'DD/MM/YYYY' },
        { factId: 'fact-gender' },
      ],
    },
    {
      id: 'consent',
      title: 'Consent',
      fields: [{ factId: 'fact-consent', required: true }],
    },
  ],
};

describe('indexModelFactsById', () => {
  it('indexes every fact across the model by id, first-wins', () => {
    const ix = indexModelFactsById(MODEL);
    expect(ix.size).toBe(6);
    expect(ix.get('fact-name')?.name).toBe('full-name');
    expect(ix.get('fact-applicant')?.name).toBe('applicant-id');
  });
});

describe('resolvePublicFormSpec', () => {
  const spec = resolvePublicFormSpec(TEMPLATE, MODEL, {
    eventType: 'application-form-submitted',
    prefilled: { 'fact-applicant': 'APP-123' },
  });

  it('carries template-level metadata and branding through', () => {
    expect(spec.templateId).toBe('tmpl-enrol');
    expect(spec.title).toBe('Enrolment application');
    expect(spec.eventType).toBe('application-form-submitted');
    expect(spec.branding?.organisationName).toBe('Driving Academy');
    expect(spec.requiresSignature).toBe(true); // defaults on
  });

  it('keys fields by kebab fact NAME (the webhook payload key)', () => {
    const about = spec.sections[0];
    expect(about.fields.map((f) => f.name)).toEqual([
      'applicant-id', 'full-name', 'date-of-birth', 'gender',
    ]);
  });

  it('resolves controls from value types (enum → select, true-false → checkbox)', () => {
    const byName = new Map(spec.sections.flatMap((s) => s.fields).map((f) => [f.name, f]));
    expect(byName.get('gender')?.control).toMatchObject({ kind: 'select', options: ['female', 'male', 'other'] });
    expect(byName.get('consent-given')?.control.kind).toBe('checkbox');
    expect(byName.get('date-of-birth')?.control.kind).toBe('date');
    expect(byName.get('full-name')?.control.kind).toBe('text');
  });

  it('applies presentation overrides (label, helpText, colSpan)', () => {
    const dob = spec.sections[0].fields.find((f) => f.name === 'date-of-birth')!;
    expect(dob.label).toBe('Birth date');
    expect(dob.helpText).toBe('DD/MM/YYYY');
    expect(dob.colSpan).toBe(1);
    // auto-derived label when no override
    expect(spec.sections[0].fields.find((f) => f.name === 'full-name')!.label).toBe('Full Name');
  });

  it('prefills by factId and forces read-only fields non-required', () => {
    const applicant = spec.sections[0].fields.find((f) => f.name === 'applicant-id')!;
    expect(applicant.value).toBe('APP-123');
    expect(applicant.readOnly).toBe(true);
    expect(applicant.required).toBe(false); // readOnly ⇒ never user-required
  });

  it('drops fields whose factId is absent from the model', () => {
    const t: FormTemplate = {
      id: 't', displayName: 'X',
      sections: [{ id: 's', fields: [{ factId: 'fact-name' }, { factId: 'fact-ghost' }] }],
    };
    const r = resolvePublicFormSpec(t, MODEL, { eventType: 'e' });
    expect(r.sections[0].fields.map((f) => f.name)).toEqual(['full-name']);
  });

  it('honours requiresSignature:false', () => {
    const r = resolvePublicFormSpec({ ...TEMPLATE, requiresSignature: false }, MODEL, { eventType: 'e' });
    expect(r.requiresSignature).toBe(false);
  });
});

describe('resolvePublicFormSpec — composite sub-field addressing (Option A)', () => {
  const T: FormTemplate = {
    id: 'tmpl-sub', displayName: 'Scattered',
    sections: [
      {
        id: 'client', title: 'Client',
        fields: [
          { factId: 'fact-app', subField: 'first-name', label: 'First name', colSpan: 1 },
          { factId: 'fact-app', subField: 'current-licence' },
        ],
      },
      {
        id: 'emergency', title: 'Emergency',
        fields: [{ factId: 'fact-app', subField: 'emergency-phone' }],
      },
    ],
  };

  it('emits one field per addressed sub-field, with the sub-field control', () => {
    const r = resolvePublicFormSpec(T, MODEL, { eventType: 'e' });
    const client = r.sections[0];
    expect(client.fields.map((f) => f.name)).toEqual(['first-name', 'current-licence']);
    const lic = client.fields.find((f) => f.name === 'current-licence')!;
    expect(lic.control).toMatchObject({ kind: 'select', options: ['none', 'learners', 'restricted', 'full'] });
  });

  it('tags each sub-field with its composite parent for nested submit routing', () => {
    const r = resolvePublicFormSpec(T, MODEL, { eventType: 'e' });
    const f = r.sections[0].fields[0];
    expect(f.compositeName).toBe('application-form');
    expect(f.subField).toBe('first-name');
    expect(f.label).toBe('First name');
    expect(f.colSpan).toBe(1);
    // sub-fields scatter across sections but share the one composite parent
    expect(r.sections[1].fields[0].compositeName).toBe('application-form');
  });

  it('drops a subField ref when the composite has no such sub-field', () => {
    const bad: FormTemplate = {
      id: 't', displayName: 'X',
      sections: [{ id: 's', fields: [{ factId: 'fact-app', subField: 'ghost-field' }] }],
    };
    const r = resolvePublicFormSpec(bad, MODEL, { eventType: 'e' });
    expect(r.sections[0].fields).toHaveLength(0);
  });

  it('drops a subField ref that targets a non-composite fact', () => {
    const bad: FormTemplate = {
      id: 't', displayName: 'X',
      sections: [{ id: 's', fields: [{ factId: 'fact-name', subField: 'first-name' }] }],
    };
    const r = resolvePublicFormSpec(bad, MODEL, { eventType: 'e' });
    expect(r.sections[0].fields).toHaveLength(0);
  });

  it('prefills a sub-field from a nested composite prefill map', () => {
    const r = resolvePublicFormSpec(T, MODEL, {
      eventType: 'e',
      prefilled: { 'fact-app': { 'first-name': 'Ada' } },
    });
    expect(r.sections[0].fields[0].value).toBe('Ada');
  });
});
