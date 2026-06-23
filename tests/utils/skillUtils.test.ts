import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { parseSkillFrontmatter, listSkillPaths, resolveSkillPath } from '../../src/utils/skillUtils.js';

// Mock fs (sync) and fs/promises (async) before any imports that use them
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  default: { existsSync: mockExistsSync },
  existsSync: mockExistsSync,
}));

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

describe('parseSkillFrontmatter', () => {
  it('parses name and description from standard YAML frontmatter block', () => {
    const raw = `---\nname: my-skill\ndescription: Does something useful\n---\n# Body content`;
    const result = parseSkillFrontmatter(raw);
    expect(result.name).toBe('my-skill');
    expect(result.description).toBe('Does something useful');
    expect(result.body).toBe('# Body content');
  });

  it('handles quoted name values (double quotes)', () => {
    const raw = `---\nname: "quoted-skill"\ndescription: Test\n---\nbody`;
    const result = parseSkillFrontmatter(raw);
    expect(result.name).toBe('quoted-skill');
  });

  it('handles quoted name values (single quotes)', () => {
    const raw = `---\nname: 'single-quoted'\ndescription: Test\n---\nbody`;
    const result = parseSkillFrontmatter(raw);
    expect(result.name).toBe('single-quoted');
  });

  it('returns empty name and description when frontmatter is missing', () => {
    const raw = '# Just a heading\nSome content';
    const result = parseSkillFrontmatter(raw);
    expect(result.name).toBe('');
    expect(result.description).toBe('');
    expect(result.body).toBe(raw);
  });

  it('returns empty name when name key is absent from frontmatter', () => {
    const raw = `---\ndescription: No name here\n---\nbody`;
    const result = parseSkillFrontmatter(raw);
    expect(result.name).toBe('');
    expect(result.description).toBe('No name here');
  });

  it('handles multi-line description (continuation lines)', () => {
    const raw = `---\nname: x\ndescription: Line one\n  continued here\n---\nbody`;
    const result = parseSkillFrontmatter(raw);
    expect(result.description).toContain('Line one');
    expect(result.description).toContain('continued here');
  });

  it('body includes everything after the closing ---', () => {
    const raw = `---\nname: test\n---\n## Header\nsome content`;
    const result = parseSkillFrontmatter(raw);
    expect(result.body).toBe('## Header\nsome content');
  });
});

describe('listSkillPaths', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockReaddir.mockReset();
  });

  it('returns empty array when directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await listSkillPaths('/skills');
    expect(result).toEqual([]);
  });

  it('returns paths for .md files only, skipping other extensions', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([
      makeFileEntry('skill.md'),
      makeFileEntry('README.txt'),
      makeFileEntry('config.json'),
    ]);
    const result = await listSkillPaths('/skills');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(path.join('/skills', 'skill.md'));
  });

  it('recurses into subdirectories', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry('my-skill')])          // /skills
      .mockResolvedValueOnce([makeFileEntry('my-skill.md')]);      // /skills/my-skill
    const result = await listSkillPaths('/skills');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(path.join('/skills', 'my-skill', 'my-skill.md'));
  });
});

describe('resolveSkillPath', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockReaddir.mockReset();
    mockReadFile.mockReset();
  });

  it('returns path of skill whose frontmatter name matches the search name', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([makeFileEntry('other-skill.md')]);
    mockReadFile.mockResolvedValue('---\nname: my-skill\n---\nbody');

    const result = await resolveSkillPath('/skills', 'my-skill');
    expect(result).toBe(path.join('/skills', 'other-skill.md'));
  });

  it('falls back to path.join(skillsDir, name.md) when no frontmatter match found', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([makeFileEntry('other.md')]);
    mockReadFile.mockResolvedValue('---\nname: other\n---\nbody');

    const result = await resolveSkillPath('/skills', 'not-found');
    expect(result).toBe(path.join('/skills', 'not-found.md'));
  });

  it('skips files that cannot be read without throwing', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([makeFileEntry('broken.md'), makeFileEntry('good.md')]);
    mockReadFile
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce('---\nname: good\n---\nbody');

    const result = await resolveSkillPath('/skills', 'good');
    expect(result).toBe(path.join('/skills', 'good.md'));
  });
});
