import fs from 'fs';
import path from 'path';

/**
 * Runtime-mutable server config (externalServers, mmcGithubServer, skillsDir).
 *
 * Two locations:
 * - `config/config.json` — the seed, shipped in the repo / Docker image.
 * - `data/config.json`   — the runtime copy, written by `PUT /admin/config`.
 *
 * On Fly only `/app/data` is volume-backed; a write into `config/` lands on
 * the ephemeral container FS and silently disappears on machine restart.
 * Reads therefore prefer the runtime copy when it exists; writes always
 * target it.
 */
export function seedConfigPath(projectRoot: string): string {
  return path.join(projectRoot, 'config', 'config.json');
}

export function runtimeConfigPath(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'config.json');
}

/** The path reads should use: runtime copy if present, else the seed. */
export function resolveConfigPath(projectRoot: string): string {
  const runtime = runtimeConfigPath(projectRoot);
  return fs.existsSync(runtime) ? runtime : seedConfigPath(projectRoot);
}

/**
 * Parse the effective config. Returns null when neither file exists; parse
 * errors propagate so call sites keep their existing error handling.
 */
export function readConfig<T = any>(projectRoot: string): T | null {
  const p = resolveConfigPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

/** Persist config to the volume-backed runtime copy. */
export function writeConfig(projectRoot: string, config: unknown): void {
  const p = runtimeConfigPath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8');
}
