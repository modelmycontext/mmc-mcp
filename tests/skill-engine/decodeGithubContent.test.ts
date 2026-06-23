import { describe, it, expect } from 'vitest';
import { SkillSync } from '../../src/skill-engine/skillSync.js';

// Regression coverage for the base64-on-disk bug: GitHub's REST API returns
// file content base64-encoded AND line-wrapped with `\n` every 60 chars. An
// earlier heuristic treated any content containing `\n` as "already decoded"
// and wrote the raw base64 to disk, so every model/skill failed to JSON.parse
// at load time — `loadWorkflowDefinitions` returned zero workflows and the
// TodoProcessor never created interface/view todos (View slices never ran).
describe('SkillSync.decodeGithubContent', () => {
  const sync = new SkillSync('any-skills-dir');

  /** Mimic GitHub's REST response: base64, wrapped at 60 chars with `\n`. */
  function githubBase64Response(text: string): string {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const wrapped = b64.replace(/(.{60})/g, '$1\n');
    return JSON.stringify({ content: wrapped, encoding: 'base64', sha: 'deadbeef' });
  }

  it('decodes LINE-WRAPPED base64 JSON content (the regression)', () => {
    const model = JSON.stringify({ project: { id: 'model-x' }, slices: [{ name: 'a' }] });
    const decoded = sync.decodeGithubContent(githubBase64Response(model));
    // Must round-trip back to the original JSON, not stay base64.
    expect(() => JSON.parse(decoded)).not.toThrow();
    expect(JSON.parse(decoded)).toEqual(JSON.parse(model));
  });

  it('decodes line-wrapped base64 markdown content', () => {
    const md = '---\nname: show-discount-summary\nskill_id: activity-1\n---\n\n# Heading\n';
    const decoded = sync.decodeGithubContent(githubBase64Response(md));
    expect(decoded).toBe(md);
  });

  it('passes through content that is already decoded (not valid base64)', () => {
    // Some upstream layers hand back already-decoded text in the `content`
    // field while still labelling it `encoding: base64`. Markdown is not valid
    // base64 (has `#`, spaces, `:`), so the validator rejects it and we keep it.
    const alreadyDecoded = '# Title\n\nSome body text with spaces.';
    const wrapper = JSON.stringify({ content: alreadyDecoded, encoding: 'base64' });
    expect(sync.decodeGithubContent(wrapper)).toBe(alreadyDecoded);
  });

  it('returns content unchanged when encoding is not base64', () => {
    const wrapper = JSON.stringify({ content: 'plain text', encoding: 'utf-8' });
    expect(sync.decodeGithubContent(wrapper)).toBe('plain text');
  });

  it('returns non-JSON input unchanged', () => {
    expect(sync.decodeGithubContent('just a raw string')).toBe('just a raw string');
    expect(sync.decodeGithubContent('')).toBe('');
  });
});
