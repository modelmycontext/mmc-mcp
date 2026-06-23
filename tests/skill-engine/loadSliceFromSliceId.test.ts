import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSliceFromSliceId,
  invalidateOutcomeModelCache,
} from '../../src/skill-engine/interaction-slice-trigger-events.js';

// A minimal two-slice activity model whose slice `id`s differ from both the
// slice `name` and the would-be kebab tool name — the exact shape that broke
// disk-path `complete-slice` (it resolved by name/skill_id, never by id).
const MODEL = {
  slices: [
    {
      id: 'slice-zvt2wzkyt',
      name: 'admissions-officer-captures-enquiry',
      role: 'admissions-officer',
      interface: { fields: [] },
      command: { facts: [{ id: 'fact-uig726p2k', name: 'applicant-id', valueType: 'text' }] },
      facts: [{ id: 'fact-uig726p2k', name: 'applicant-id', valueType: 'text' }],
      outcomes: [{ name: 'admissions-officer-enquiry-captured', facts: [] }],
      scenarios: [{ id: 'sc-1', given: [], then: [{ name: 'admissions-officer-enquiry-captured' }] }],
    },
    {
      id: 'slice-v6rxxwup7',
      name: 'application-approved',
      role: 'admissions-officer',
      interface: { fields: [] },
      command: { facts: [] },
      outcomes: [{ name: 'application-approved', facts: [] }],
      scenarios: [{ id: 'sc-2', given: [{ name: 'enrolment-agreement-signed' }], then: [] }],
    },
  ],
};

describe('loadSliceFromSliceId', () => {
  let skillsDir: string;
  let activity: string;

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-sliceid-'));
    activity = 'da-nzta-enrollment';
    const dir = path.join(skillsDir, activity);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${activity}.json`), JSON.stringify(MODEL));
    invalidateOutcomeModelCache(); // avoid cross-test cache bleed on reused tmp paths
  });
  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    invalidateOutcomeModelCache();
  });

  it('resolves a slice by its canonical slice.id (not its name)', async () => {
    const res = await loadSliceFromSliceId(skillsDir, 'slice-zvt2wzkyt');
    expect(res).not.toBeNull();
    expect(res!.slice.name).toBe('admissions-officer-captures-enquiry');
    // scoped factId→name includes the slice's own fact
    expect(res!.factIdToName.get('fact-uig726p2k')).toBe('applicant-id');
    // skillMdPath is synthesized as {skillsDir}/{activity}/{slice}/{slice}.md so
    // the caller derives the activity name from dirname(dirname(path)).
    expect(res!.skillMdPath).toBe(
      path.join(skillsDir, activity, 'admissions-officer-captures-enquiry', 'admissions-officer-captures-enquiry.md'),
    );
    expect(path.basename(path.dirname(path.dirname(res!.skillMdPath)))).toBe(activity);
  });

  it('resolves the second slice by id too', async () => {
    const res = await loadSliceFromSliceId(skillsDir, 'slice-v6rxxwup7');
    expect(res?.slice.name).toBe('application-approved');
  });

  it('returns null for an unknown id', async () => {
    expect(await loadSliceFromSliceId(skillsDir, 'slice-does-not-exist')).toBeNull();
  });

  it('returns null when the skills dir is missing', async () => {
    expect(await loadSliceFromSliceId(path.join(skillsDir, 'nope'), 'slice-zvt2wzkyt')).toBeNull();
  });
});
