import fs from 'fs';
import fsAsync from 'fs/promises';
import path from 'path';

/** Parses YAML frontmatter from a skill markdown file. */
export function parseSkillFrontmatter(raw: string): { name: string; skill_id: string; description: string; body: string } {
  const match = raw.match(/^---\s*[\r\n]+([\s\S]*?)\s*[\r\n]+---\s*[\r\n]+([\s\S]*)$/);
  if (!match) return { name: '', skill_id: '', description: '', body: raw };
  const fmLines = match[1].split(/\r?\n/);
  const fm: Record<string, string> = {};
  let key = '';
  for (const line of fmLines) {
    const kv = line.match(/^([\w-]+):\s*(.*)/);
    if (kv) {
      key = kv[1];
      let value = kv[2].trim() === '>' ? '' : kv[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }
      fm[key] = value;
    }
    else if (key && line.trim()) { fm[key] = (fm[key] + ' ' + line.trim()).trim(); }
  }
  return { name: fm['name'] ?? '', skill_id: fm['skill_id'] ?? '', description: fm['description'] ?? '', body: match[2] };
}

/** Returns all skill .md file paths recursively from the skills directory. */
export async function listSkillPaths(skillsDir: string): Promise<string[]> {
  const paths: string[] = [];

  async function walk(dir: string) {
    const entries = await fsAsync.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(fullPath);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        paths.push(fullPath);
      }
    }
  }

  if (fs.existsSync(skillsDir)) {
    await walk(skillsDir);
  }
  return paths;
}

/** Resolves a skill file path by skill_id (preferred) or name, then falls back to a direct path.
 *  Supports "workflow--sliceName" tool-name format and "workflow/sliceName" source format,
 *  both matched via the file's workflow parent directory + frontmatter name. */
export async function resolveSkillPath(skillsDir: string, name: string): Promise<string> {
  const allPaths = await listSkillPaths(skillsDir);
  // Support both "--" (MCP tool name separator) and "/" (internal source separator)
  const sepIdx = name.includes('--') ? name.indexOf('--') : name.indexOf('/');
  const sep = name.includes('--') ? '--' : '/';
  const workflowPart = sepIdx !== -1 ? name.slice(0, sepIdx) : null;
  const namePart = sepIdx !== -1 ? name.slice(sepIdx + sep.length) : name;

  for (const p of allPaths) {
    try {
      const raw = await fsAsync.readFile(p, 'utf-8');
      const fm = parseSkillFrontmatter(raw);
      const identity = fm.skill_id || fm.name;
      if (identity === name) return p; // exact match
      if (workflowPart && identity === namePart) {
        const dirWorkflow = path.basename(path.dirname(path.dirname(p)));
        if (dirWorkflow === workflowPart) return p; // workflow--name or workflow/name match
      }
    } catch {
      // Skip
    }
  }

  return path.join(skillsDir, `${name}.md`);
}
