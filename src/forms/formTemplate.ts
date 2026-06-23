// formTemplate.ts — server-side resolution of an authored public FormTemplate
// into a render-ready spec for the /f/:token applicant runner.
//
// This is the FormTemplate path (authored, branded, external applicants),
// distinct from the FormSpec path (derived from a slice for internal workflow
// roles, see src/ui/formSpec.ts). The split is intentional — see
// mmc-knowledge/architecture/forms.md.
//
// A FormTemplate carries presentation only (sections, labels, help, colSpan,
// branding) plus factId references. The data — fact names, value types, enum
// options — is resolved here from the synced activity model JSON, so the form
// can never drift from the model contract. The resolved control vocabulary is
// the SAME one the interface-form renderer uses (controlFor in formSpec.ts), so
// the public page reuses that renderer's field-drawing logic verbatim.
import fs from 'fs';
import fsAsync from 'fs/promises';
import path from 'path';
import { buildValueTypeRegistry, controlFor, toDisplay } from '@src/ui/formSpec.js';
import type { FormControl } from '@src/types/outcomeModel.js';
import { logger } from '@src/utils/logger.js';
import { resolveFormulaValue } from '@src/utils/factValueResolver.js';

// ── Authored template schema (mirror of mmc-workbench src/forms/shared/types.ts).
// Hand-duplicated, not shared — per the repo's "no shared packages" stance. ──

export interface FormFieldRef {
  factId: string;
  /** Address a single sub-field of a composite fact. `factId` points at the
   *  composite; `subField` names the inner field (kebab). The field renders with
   *  the sub-field's own control, and its value submits NESTED under the
   *  composite's name (`{ [composite]: { [subField]: value } }`). This lets one
   *  composite scatter across many sections without un-collapsing the model. */
  subField?: string;
  /** Override the auto-derived (display) label for this fact in this form. */
  label?: string;
  /** Secondary hint shown under the label. */
  helpText?: string;
  /** Visual asterisk only — runtime enforcement is the Command's rules. */
  required?: boolean;
  /** Grid column span on wide screens: 1 = half, 2 = full (default). */
  colSpan?: 1 | 2;
  /** Render disabled — the value still submits (prefilled, system-controlled). */
  readOnly?: boolean;
  /** Form-load default formula, evaluated when no prefill value is present.
   *  Supports the #116 vocabulary: `TODAY()`, `NOW()`, a fixed literal, or an
   *  `@fact` reference. Unlike a top-level fact default, this reaches composite
   *  sub-fields (e.g. a `registration-date` folded into `application-form`). */
  default?: string;
}

export interface FormSection {
  id: string;
  title?: string;
  /** Long-form copy above the fields (paragraphs split on blank lines). */
  intro?: string;
  fields: FormFieldRef[];
  /** Long-form copy below the fields. */
  outro?: string;
}

export interface FormBranding {
  logoUrl?: string;
  organisationName?: string;
  tagline?: string;
  footer?: string;
  /** Full-viewport backdrop image (sits behind the document page). */
  backgroundUrl?: string;
  /** Viewport backdrop colour — used alone, or as a tint under backgroundUrl. */
  backgroundColor?: string;
  /** Brand accent colour — drives the header rule, section bars, focus highlight. */
  accentColor?: string;
  /** Solid actionable surfaces that carry white text (submit button, section
   *  number badges). Defaults to accentColor. Use when the accent is too light
   *  for white text (e.g. a yellow accent paired with a black button). */
  buttonColor?: string;
}

export interface FormTemplate {
  id: string;
  displayName: string;
  /** The activity/model this template's facts belong to (informational; the
   *  owning model is located by the referenced factIds, which are globally
   *  unique, so an id/directory-name mismatch can't misroute resolution). */
  activityId?: string;
  externalOutcomeName?: string;
  /** Event published on submit. Falls back to the jti's eventType. */
  eventType?: string;
  branding?: FormBranding;
  /** Whether a signature is required before submit. Defaults to true. */
  requiresSignature?: boolean;
  sections: FormSection[];
}

// ── Resolved, render-ready spec sent to the public page ──

export interface ResolvedFormField {
  /** Kebab fact name — the submit payload key (the webhook reads names). For a
   *  composite sub-field this is the SUB-field name; routing under the composite
   *  is carried by `compositeName`/`subField` below. */
  name: string;
  factId: string;
  label: string;
  helpText?: string;
  control: FormControl;
  collection: boolean;
  readOnly: boolean;
  required: boolean;
  colSpan: 1 | 2;
  value?: unknown;
  /** When set, this field addresses a sub-field of a composite fact: its value
   *  submits nested as `{ [compositeName]: { [subField]: value } }`. */
  compositeName?: string;
  subField?: string;
}

export interface ResolvedFormSection {
  id: string;
  title?: string;
  intro?: string;
  outro?: string;
  fields: ResolvedFormField[];
}

export interface PublicFormSpec {
  templateId: string;
  title: string;
  externalOutcomeName?: string;
  /** Event type the submit publishes (drives POST /external-events/:eventType). */
  eventType: string;
  branding?: FormBranding;
  requiresSignature: boolean;
  submitLabel: string;
  sections: ResolvedFormSection[];
}

interface ModelFact {
  id: string;
  name: string;
  valueType?: string;
  collection?: boolean;
}

/** Normalize a name for case/separator-insensitive matching (mirrors formSpec). */
const norm = (s: unknown): string =>
  String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');

/** Walk any activity-model JSON subtree and index every fact by its id. A fact
 *  is any node carrying a string `id` + `name` + a `valueType`. First-wins on
 *  duplicate ids (the same fact is inlined many times across the export). */
export function indexModelFactsById(model: unknown): Map<string, ModelFact> {
  const byId = new Map<string, ModelFact>();
  const seen = new Set<unknown>();
  (function walk(node: any): void {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.id === 'string' && typeof node.name === 'string' && 'valueType' in node) {
      if (!byId.has(node.id)) {
        byId.set(node.id, { id: node.id, name: node.name, valueType: node.valueType, collection: !!node.collection });
      }
    }
    for (const k in node) walk(node[k]);
  })(model);
  return byId;
}

/**
 * Resolve an authored template + its owning model JSON into a render-ready
 * PublicFormSpec. Pure — no I/O — so it unit-tests with inline fixtures.
 *
 * Fields whose factId is not present in the model are dropped (a stale template
 * entry can't inject an unbound input). Prefilled values are keyed by factId
 * (matching the mint-side `extras.prefilled` map).
 */
export function resolvePublicFormSpec(
  template: FormTemplate,
  model: unknown,
  opts: { eventType: string; prefilled?: Record<string, unknown> } = { eventType: '' },
): PublicFormSpec {
  const factsById = indexModelFactsById(model);
  const registry = buildValueTypeRegistry(model);
  const prefilled = opts.prefilled ?? {};

  // Evaluate a field's form-load `default` formula (TODAY()/NOW()/literal/@fact)
  // when no prefill value is present. Brings the #116 default vocabulary to the
  // public /f path, including composite sub-fields that a top-level fact default
  // can't reach.
  const evalDefault = (ref: FormFieldRef): unknown =>
    (typeof ref.default === 'string' && ref.default.trim() !== '')
      ? resolveFormulaValue(ref.default, prefilled)
      : undefined;

  const sections: ResolvedFormSection[] = (template.sections ?? []).map((sec) => {
    const fields: ResolvedFormField[] = (sec.fields ?? [])
      .map((ref): ResolvedFormField | null => {
        const fact = factsById.get(ref.factId);
        if (!fact) {
          logger.warn({ templateId: template.id, factId: ref.factId }, '[forms] template references a factId absent from the model — dropping field');
          return null;
        }
        const readOnly = ref.readOnly === true;

        // Composite sub-field addressing: resolve the composite's control, pluck
        // the named inner field, and tag it so the value submits nested.
        if (ref.subField) {
          const composite = controlFor(fact.valueType, registry);
          if (composite.kind !== 'composite') {
            logger.warn({ templateId: template.id, factId: ref.factId, subField: ref.subField }, '[forms] subField ref targets a non-composite fact — dropping field');
            return null;
          }
          const sub = (composite.fields ?? []).find((f) => norm(f.name) === norm(ref.subField));
          if (!sub) {
            logger.warn({ templateId: template.id, factId: ref.factId, subField: ref.subField }, '[forms] composite has no such sub-field — dropping field');
            return null;
          }
          // Prefill a sub-field from `${factId}.${subField}` or a nested composite map.
          const nestedPrefill = (prefilled[`${ref.factId}.${sub.name}`]
            ?? (prefilled[ref.factId] as Record<string, unknown> | undefined)?.[sub.name]);
          return {
            name: sub.name,
            factId: fact.id,
            label: ref.label ?? sub.label ?? toDisplay(sub.name),
            helpText: ref.helpText,
            control: sub.control,
            collection: false,
            readOnly,
            required: ref.required === true && !readOnly,
            colSpan: ref.colSpan === 1 ? 1 : 2,
            value: nestedPrefill ?? evalDefault(ref),
            compositeName: fact.name,
            subField: sub.name,
          };
        }

        return {
          name: fact.name,
          factId: fact.id,
          label: ref.label ?? toDisplay(fact.name),
          helpText: ref.helpText,
          control: controlFor(fact.valueType, registry),
          collection: !!fact.collection,
          readOnly,
          // A read-only (system-controlled) field is never user-required.
          required: ref.required === true && !readOnly,
          colSpan: ref.colSpan === 1 ? 1 : 2,
          value: prefilled[ref.factId] ?? evalDefault(ref),
        };
      })
      .filter((f): f is ResolvedFormField => f !== null);
    return { id: sec.id, title: sec.title, intro: sec.intro, outro: sec.outro, fields };
  });

  return {
    templateId: template.id,
    title: template.displayName || 'Form',
    externalOutcomeName: template.externalOutcomeName,
    eventType: template.eventType || opts.eventType,
    branding: template.branding,
    requiresSignature: template.requiresSignature !== false,
    submitLabel: 'Submit application',
    sections,
  };
}

// ── Disk loading ──
//
// Form templates are stored in GitHub co-located with the model they belong to
// (`<activity>/forms/<formId>.json` in the org repo) and synced into
// `<skillsDir>/<activity>/forms/<formId>.json`. The owning activity model is the
// synced `<skillsDir>/<activity>/<activity>.json` that contains the template's
// factIds. `MMC_FORMS_DIR` overrides to a single flat directory (used by tests
// and for a top-level `forms/` layout).

const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Candidate on-disk paths for a template id, in resolution order:
 *  1. `$MMC_FORMS_DIR/<id>.json` when the override is set (flat dir),
 *  2. `<skillsDir>/forms/<id>.json` (top-level co-location),
 *  3. `<skillsDir>/<activity>/forms/<id>.json` for each synced activity. */
async function candidateFormPaths(skillsDir: string, templateId: string): Promise<string[]> {
  const override = process.env.MMC_FORMS_DIR;
  if (override) return [path.join(override, `${templateId}.json`)];
  const paths = [path.join(skillsDir, 'forms', `${templateId}.json`)];
  let activities: string[] = [];
  try {
    activities = await fsAsync.readdir(skillsDir);
  } catch { /* skillsDir missing — only the top-level candidate remains */ }
  for (const activity of activities) {
    if (activity === 'forms') continue;
    paths.push(path.join(skillsDir, activity, 'forms', `${templateId}.json`));
  }
  return paths;
}

/** Load a FormTemplate JSON by id. Returns null if absent or malformed (the
 *  caller renders a friendly not-found). */
export async function loadFormTemplate(skillsDir: string, templateId: string): Promise<FormTemplate | null> {
  // templateId is opaque but used as a filename — guard against traversal.
  if (!TEMPLATE_ID_RE.test(templateId)) return null;
  for (const file of await candidateFormPaths(skillsDir, templateId)) {
    let raw: string;
    try {
      raw = await fsAsync.readFile(file, 'utf-8');
    } catch {
      continue; // not at this candidate — try the next
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sections)) return null;
      return { id: templateId, ...parsed };
    } catch {
      return null; // present but malformed — don't keep scanning
    }
  }
  return null;
}

/** Find the synced activity model JSON that defines all (or the most) of the
 *  template's referenced factIds. Scans `<skillsDir>/<activity>/<activity>.json`.
 *  Returns the parsed model with the best factId coverage, or null. */
export async function findModelForTemplate(skillsDir: string, template: FormTemplate): Promise<unknown | null> {
  const wanted = new Set<string>();
  for (const sec of template.sections ?? [])
    for (const f of sec.fields ?? []) if (f.factId) wanted.add(f.factId);
  if (wanted.size === 0) return null;

  let entries: string[];
  try {
    entries = await fsAsync.readdir(skillsDir);
  } catch {
    return null;
  }

  let best: { model: unknown; hits: number } | null = null;
  for (const activity of entries) {
    const modelPath = path.join(skillsDir, activity, `${activity}.json`);
    if (!fs.existsSync(modelPath)) continue;
    let model: unknown;
    try {
      model = JSON.parse(await fsAsync.readFile(modelPath, 'utf-8'));
    } catch {
      continue;
    }
    const ids = indexModelFactsById(model);
    let hits = 0;
    for (const id of wanted) if (ids.has(id)) hits++;
    if (hits > 0 && (!best || hits > best.hits)) best = { model, hits };
    if (best && best.hits === wanted.size) break; // full coverage — done
  }
  return best?.model ?? null;
}
