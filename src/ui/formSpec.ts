// formSpec.ts — turns an outcome-model Interface slice into a FormSpec the
// `ui://mmc/interface-form` renderer can draw, and whose submit reproduces the
// existing `complete-slice` payload `{ sliceId, facts }` (kebab keys).
//
// Ported from prototypes/interface-forms/build-form-spec.mjs. The recovery
// strategy reflects what the disk export actually carries:
//   - scalars resolve from the value-type NAME string,
//   - composites are recovered from the fact's inline `fields[]`,
//   - enums render when an `options[]` is present (added by the workbench export).
import type {
  Fact,
  FormControl,
  FormControlKind,
  FormField,
  FormAction,
  FormSection,
  FormSpec,
  Slice,
} from '@src/types/outcomeModel.js';
// Use the ONE canonical classifier (command-first). A view often carries an
// `interface` block just to declare which facts it renders, so an
// interface-first check would misread `show-credit-decision` (no command,
// interface block, 0 facts) as an Interface slice — building a "Confirm" form
// that posts complete-slice, which then re-renders the view. See sliceValidation.
import { getSlicePattern } from '@src/skill-engine/sliceValidation.js';

/** A recovered value-type definition (composite or enum). */
interface RegistryEntry {
  kind: 'composite' | 'select';
  typeName: string;
  fields?: { name: string; valueType?: string }[];
  options?: string[];
}
export type ValueTypeRegistry = Map<string, RegistryEntry>;

const norm = (s: unknown): string =>
  String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');

/** Humanize a kebab/camel identifier: `applicant-name` → `Applicant Name`. */
export function toDisplay(name: unknown): string {
  return String(name ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// scalar value-type name -> control kind
const SCALAR: Record<string, FormControlKind> = {
  identifier: 'text',
  text: 'text',
  string: 'text',
  'credit-text': 'text',
  // multi-line free text → <textarea>. "Text Area" is a seeded value type in
  // the workbench; the aliases cover hand-authored/imported variants.
  'text-area': 'textarea',
  textarea: 'textarea',
  'multiline-text': 'textarea',
  multiline: 'textarea',
  'long-text': 'textarea',
  numeric: 'number',
  number: 'number',
  integer: 'number',
  date: 'date',
  datetime: 'datetime',
  'date-time': 'datetime',
  'true-false': 'checkbox',
  boolean: 'checkbox',
  bool: 'checkbox',
};

/**
 * Walk any model/slice subtree and register inline composite + enum value-type
 * definitions, keyed by normalized value-type name. Pass the whole model when
 * available (cross-slice composites), or a single slice (slice-local is enough
 * for most interfaces).
 */
export function buildValueTypeRegistry(root: unknown): ValueTypeRegistry {
  const reg: ValueTypeRegistry = new Map();
  const seen = new Set<unknown>();
  (function walk(node: any): void {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }

    // composite: an object that names a value type AND lists its sub-fields
    if (Array.isArray(node.fields) && node.fields.length &&
        node.fields.every((f: any) => f && typeof f.name === 'string')) {
      const key = norm(node.valueType ?? node.name);
      if (key && !reg.has(key)) {
        reg.set(key, {
          kind: 'composite',
          typeName: String(node.valueType ?? node.name),
          fields: node.fields.map((f: any) => ({ name: f.name, valueType: f.valueType ?? f.valueTypeId })),
        });
      }
    }
    // enum: present once the export carries options[]
    if (Array.isArray(node.options) && node.options.length) {
      const key = norm(node.valueType ?? node.name);
      if (key && !reg.has(key)) {
        reg.set(key, {
          kind: 'select',
          typeName: String(node.valueType ?? node.name),
          options: node.options.map((o: any) => (typeof o === 'string' ? o : o?.value ?? o?.label)),
        });
      }
    }
    for (const k in node) walk(node[k]);
  })(root);
  return reg;
}

/** Resolve a value-type NAME to a renderable control (recursive for composites). */
export function controlFor(typeName: unknown, reg: ValueTypeRegistry, stack: string[] = []): FormControl {
  const key = norm(typeName);
  const entry = reg.get(key);
  if (entry && !stack.includes(key)) {
    if (entry.kind === 'select') return { kind: 'select', options: entry.options, typeName: entry.typeName };
    if (entry.kind === 'composite') {
      return {
        kind: 'composite',
        typeName: entry.typeName,
        fields: (entry.fields ?? []).map((f) => ({
          factId: f.name,
          name: f.name,
          label: toDisplay(f.name),
          control: controlFor(f.valueType, reg, stack.concat(key)),
          collection: false,
          readOnly: false,
        })),
      };
    }
  }
  return { kind: SCALAR[key] ?? 'text', typeName: String(typeName ?? '') };
}

export interface BuildFormSpecOptions {
  /** Prebuilt registry (defaults to one scanned from the slice itself). */
  registry?: ValueTypeRegistry;
  /** Optional live values keyed by kebab fact name — used to prefill the
   *  read-only context block. */
  values?: Record<string, unknown>;
}

/**
 * Build the FormSpec for an Interface slice. Returns null for non-interface
 * slices so callers can guard.
 */
export function buildInterfaceFormSpec(slice: Slice, opts: BuildFormSpecOptions = {}): FormSpec | null {
  if (getSlicePattern(slice) !== 'interface') return null;
  const reg = opts.registry ?? buildValueTypeRegistry(slice);
  const values = opts.values ?? {};

  const editable: Fact[] = (slice.interface?.facts as Fact[]) ?? [];

  // Decision buttons: when an interface slice's single enum input gates more
  // than one outcome (≥2 scenarios), render that enum's options as submit
  // buttons instead of a radio + generic submit. Each button stamps the chosen
  // value and posts the same complete-slice payload — first-match scenarios
  // route to the matching outcome (e.g. Approve → approved, Decline → declined).
  const enumEditable = editable.filter((f) => controlFor(f.valueType, reg).kind === 'select');
  let actions: FormAction[] | undefined;
  let decisionFact: Fact | undefined;
  if (enumEditable.length === 1 && (slice.scenarios?.length ?? 0) >= 2) {
    const f = enumEditable[0];
    const opts = controlFor(f.valueType, reg).options ?? [];
    if (opts.length >= 2) {
      decisionFact = f;
      actions = opts.map((opt, i) => ({
        label: toDisplay(opt),
        set: { [f.name]: opt },
        variant: /decline|reject|deny|cancel|refuse|withdraw/i.test(String(opt))
          ? 'danger'
          : i === 0
            ? 'primary'
            : 'default',
      }));
    }
  }

  const toField = (fact: Fact, readOnly: boolean): FormField => ({
    factId: fact.id,
    name: fact.name,
    label: toDisplay(fact.name),
    control: controlFor(fact.valueType, reg),
    collection: !!fact.collection,
    readOnly,
    required: !readOnly,
    value: values[fact.name],
  });

  // Interface (input) steps no longer echo the slice's QUERY facts as a
  // read-only "Information from the application" section. Those facts are read
  // for rule evaluation (the slice's `queries[].facts`), not for display —
  // surfacing them (incl. internal tokens/hashes/URLs) was noise. Per-field
  // display control belongs in the model as a "show on form" flag on the fact;
  // until that exists, query facts are simply not rendered on input steps.
  const sections: FormSection[] = [];
  // Only emit an editable section when there are facts to collect. An interface
  // slice with no interface facts (e.g. a display-only confirmation) renders as
  // a read-only projection — no empty "Your input" block, no submit.
  // The decision fact (if any) renders as buttons, not a field.
  const inputFields = editable.filter((f) => f !== decisionFact);
  if (inputFields.length)
    sections.push({
      id: 'input',
      title: 'Your input',
      readOnly: false,
      fields: inputFields.map((f) => toField(f, false)),
    });

  const rawTitle = slice.interface?.name ?? slice.name ?? 'Interface';
  const title = toDisplay(String(rawTitle).replace(/[-\s]*(interaction|interface)$/i, ''));

  return {
    sliceId: slice.id ?? slice.name,
    toolName: slice.name,
    title,
    description: slice.interface?.description ?? '',
    submitLabel: editable.length ? 'Continue' : 'Confirm',
    ...(actions ? { actions } : {}),
    kind: editable.length || actions ? 'interface' : 'view',
    sections,
    submit: { tool: 'complete-slice', sliceIdArg: slice.id ?? slice.name },
  };
}

/**
 * Build a read-only display FormSpec for a View slice. The displayed fields are
 * the view's displayed-facts contract (scenario.then facts) ∪ its query facts.
 * Returns null for non-view slices.
 */
export function buildViewFormSpec(slice: Slice, opts: BuildFormSpecOptions = {}): FormSpec | null {
  if (getSlicePattern(slice) !== 'view') return null;
  const reg = opts.registry ?? buildValueTypeRegistry(slice);
  const values = opts.values ?? {};

  const byId = new Map<string, Fact>();
  for (const sc of (slice.scenarios ?? []) as any[])
    for (const o of (sc.then ?? []) as any[])
      for (const f of (o.facts ?? []) as Fact[]) if (!byId.has(f.id)) byId.set(f.id, f);
  for (const q of (slice.queries ?? []) as any[])
    for (const f of (q.facts ?? []) as Fact[]) if (!byId.has(f.id)) byId.set(f.id, f);

  const fields: FormField[] = [...byId.values()].map((f) => ({
    factId: f.id,
    name: f.name,
    label: toDisplay(f.name),
    control: controlFor(f.valueType, reg),
    collection: !!f.collection,
    readOnly: true,
    value: values[f.name],
  }));

  const title = toDisplay(String(slice.name ?? 'View').replace(/[-\s]*(view|interaction)$/i, ''));
  return {
    sliceId: slice.id ?? slice.name,
    toolName: slice.name,
    title,
    description: '',
    submitLabel: 'Close',
    kind: 'view',
    sections: [{ id: 'display', title: 'Result', readOnly: true, fields }],
    submit: { tool: 'complete-slice', sliceIdArg: slice.id ?? slice.name },
  };
}

/** Dispatch by pattern: interface → editable form, view → read-only display. */
export function buildSliceFormSpec(slice: Slice, opts: BuildFormSpecOptions = {}): FormSpec | null {
  const pattern = getSlicePattern(slice);
  if (pattern === 'interface') return buildInterfaceFormSpec(slice, opts);
  if (pattern === 'view') return buildViewFormSpec(slice, opts);
  return null;
}
