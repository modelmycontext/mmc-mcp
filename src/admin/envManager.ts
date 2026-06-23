import fs from 'fs';

export function readEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

export function writeEnvVar(envPath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  const lines = content.split('\n');
  const keyPattern = new RegExp(`^${key}\\s*=`);
  const existingIdx = lines.findIndex(l => keyPattern.test(l));

  const newLine = `${key}=${value}`;
  if (existingIdx >= 0) {
    lines[existingIdx] = newLine;
  } else {
    if (content && !content.endsWith('\n')) lines.push('');
    lines.push(newLine);
  }

  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
}
