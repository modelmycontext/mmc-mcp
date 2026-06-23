import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFormLocalPath } from '../../src/skill-engine/skillSync.js';
import { loadFormTemplate } from '../../src/forms/formTemplate.js';

describe('resolveFormLocalPath (forms sync layout)', () => {
  const SKILLS = path.join('any', 'skills');

  it('co-locates an activity-scoped form with its model', () => {
    const r = resolveFormLocalPath(SKILLS, 'da-nzta-enrollment/forms/tmpl-enrol.json');
    expect(r).toEqual({
      localPath: path.join(SKILLS, 'da-nzta-enrollment', 'forms', 'tmpl-enrol.json'),
      relPath: 'da-nzta-enrollment/forms/tmpl-enrol.json',
    });
  });

  it('maps a top-level (activity-less) form to <skillsDir>/forms', () => {
    const r = resolveFormLocalPath(SKILLS, 'forms/tmpl-enrol.json');
    expect(r).toEqual({
      localPath: path.join(SKILLS, 'forms', 'tmpl-enrol.json'),
      relPath: 'forms/tmpl-enrol.json',
    });
  });

  it('returns null for non-form paths (models, skills)', () => {
    expect(resolveFormLocalPath(SKILLS, 'da-nzta-enrollment/da-nzta-enrollment.json')).toBeNull();
    expect(resolveFormLocalPath(SKILLS, 'da-nzta-enrollment/skills/x.md')).toBeNull();
    expect(resolveFormLocalPath(SKILLS, 'forms/readme.txt')).toBeNull();
  });
});

describe('loadFormTemplate co-location scan (no MMC_FORMS_DIR override)', () => {
  let tmp: string;
  let skillsDir: string;
  const origDir = process.env.MMC_FORMS_DIR;

  const TEMPLATE = { displayName: 'X', sections: [{ id: 's', fields: [] }] };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-formsync-'));
    skillsDir = path.join(tmp, 'skills');
    // Activity-scoped, co-located with the model (where the GitHub sync lands it).
    fs.mkdirSync(path.join(skillsDir, 'da-nzta-enrollment', 'forms'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'da-nzta-enrollment', 'forms', 'tmpl-coloc.json'), JSON.stringify(TEMPLATE));
    // Top-level forms dir too.
    fs.mkdirSync(path.join(skillsDir, 'forms'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'forms', 'tmpl-top.json'), JSON.stringify(TEMPLATE));
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => { delete process.env.MMC_FORMS_DIR; });
  afterEach(() => { if (origDir === undefined) delete process.env.MMC_FORMS_DIR; else process.env.MMC_FORMS_DIR = origDir; });

  it('finds an activity-co-located template by id', async () => {
    const t = await loadFormTemplate(skillsDir, 'tmpl-coloc');
    expect(t?.id).toBe('tmpl-coloc');
    expect(t?.displayName).toBe('X');
  });

  it('finds a top-level template by id', async () => {
    const t = await loadFormTemplate(skillsDir, 'tmpl-top');
    expect(t?.id).toBe('tmpl-top');
  });

  it('returns null for an unknown id and rejects traversal ids', async () => {
    expect(await loadFormTemplate(skillsDir, 'nope')).toBeNull();
    expect(await loadFormTemplate(skillsDir, '../secret')).toBeNull();
  });
});
