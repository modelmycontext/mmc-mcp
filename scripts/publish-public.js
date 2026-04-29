// Publishes the current working tree to the modelmycontext/mmc-mcp public
// repo as a single fresh "Initial commit" — no history.
//
// Flow: create an orphan branch → commit current tree → force-push to
// public/main → switch back to original branch → delete the orphan.
//
// Requires:
//   - working tree must be clean (no uncommitted changes)
//   - `public` remote configured (https://github.com/modelmycontext/mmc-mcp.git)
//   - GH_TOKEN env var set (or git credential helper configured)
import { execSync } from 'node:child_process';

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd).toString().trim();

// Reject only tracked-file modifications (M/A/D/R/C/U). Untracked files (??) are
// fine — they wouldn't be staged into the orphan commit anyway, since
// `git checkout --orphan` carries over the index from HEAD without them.
const dirty = out('git status --porcelain')
  .split('\n')
  .filter(line => line && !line.startsWith('??'))
  .join('\n');
if (dirty) {
  console.error('Tracked files have uncommitted changes. Commit or stash before publishing:\n' + dirty);
  process.exit(1);
}

const remotes = out('git remote');
if (!remotes.split('\n').includes('public')) {
  console.error("Remote 'public' not configured. Add it with:\n  git remote add public https://github.com/modelmycontext/mmc-mcp.git");
  process.exit(1);
}

const original = out('git symbolic-ref --short HEAD');
const orphan = `public-init-${Date.now()}`;

try {
  run(`git checkout --orphan ${orphan}`);
  run(`git commit -m "Initial commit"`);
  run(`git push public ${orphan}:main --force-with-lease`);
} finally {
  run(`git checkout ${original}`);
  run(`git branch -D ${orphan}`);
}

console.log(`\nPublished current tree of '${original}' to public/main as a fresh Initial commit.`);
