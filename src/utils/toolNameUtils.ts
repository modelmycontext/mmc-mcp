import { createHash } from 'crypto';
import { logger } from '@src/utils/logger.js';

/** MCP protocol tool-name limit. Pattern is `^[a-zA-Z0-9_-]{1,64}$`. */
export const MCP_TOOL_NAME_MAX = 64;

const TRUNCATED_TOOL_NAMES_LOGGED = new Set<string>();

/**
 * Ensures a tool name fits within `MCP_TOOL_NAME_MAX`. If too long, truncates
 * and appends `-{6-char sha1}` of the original name so distinct long names stay
 * distinct. Logs a one-time warning per original name.
 */
export function fitToolName(name: string): string {
  if (name.length <= MCP_TOOL_NAME_MAX) return name;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 6);
  const keep = MCP_TOOL_NAME_MAX - 1 - hash.length; // 1 for the '-' separator
  const truncated = `${name.slice(0, keep)}-${hash}`;
  if (!TRUNCATED_TOOL_NAMES_LOGGED.has(name)) {
    TRUNCATED_TOOL_NAMES_LOGGED.add(name);
    logger.warn(
      { original: name, truncated },
      `[fitToolName] tool name exceeded ${MCP_TOOL_NAME_MAX} chars; truncated with hash suffix`,
    );
  }
  return truncated;
}
