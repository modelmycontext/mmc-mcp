import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

// AsyncLocalStorage carries a per-request traceId through the async chain.
// Every log call running inside `withTraceId(...)` gets `traceId` injected via
// pino's mixin hook below — no call-site changes required.
const traceStore = new AsyncLocalStorage<{ traceId: string }>();

// Redact obvious secret-bearing keys at any one level under the root. Pino's
// fast-redact only supports single-segment wildcards, so we enumerate the
// known headers + env keys explicitly and rely on `*.X` for incidental
// logging of objects that happen to carry tokens.
const redactPaths = [
  'headers.authorization',
  'headers.Authorization',
  'req.headers.authorization',
  'req.headers.Authorization',
  'env.GITHUB_PERSONAL_ACCESS_TOKEN',
  'env.OPENROUTER_API_KEY',
  'env.SLACK_BOT_TOKEN',
  'env.FLY_API_TOKEN',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.authorization',
  '*.Authorization',
];

// Production: raw JSON to stderr — easy for log shippers to parse, and
// stderr keeps stdout free for the MCP stdio transport's JSON-RPC framing.
// Dev: pino-pretty to stderr for readability + a file in ./logs/ for grep.
let transport: any;
if (isDev) {
  const logDir = path.join(process.cwd(), 'logs');
  mkdirSync(logDir, { recursive: true });
  transport = pino.transport({
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname', destination: 2 },
        level,
      },
      {
        target: 'pino/file',
        options: { destination: path.join(logDir, 'server.log'), append: true },
        level,
      },
    ],
  });
}

export const logger = pino(
  {
    level,
    redact: { paths: redactPaths, censor: '[redacted]' },
    mixin: () => {
      const ctx = traceStore.getStore();
      return ctx?.traceId ? { traceId: ctx.traceId } : {};
    },
  },
  // Prod: stderr (fd 2). Dev: multi-target transport (also lands on stderr).
  transport ?? pino.destination({ fd: 2, sync: false }),
);

/**
 * Run `fn` inside a trace context so every `logger.*` call from inside it
 * automatically includes `traceId`. AsyncLocalStorage propagates through
 * await/then chains.
 */
export function withTraceId<T>(traceId: string, fn: () => T): T {
  return traceStore.run({ traceId }, fn);
}

/**
 * Wrap an async operation with start/finish timing logs. Emits one log line
 * on completion with `{ event, durationMs, status: 'ok' | 'error' }` plus any
 * extra structured fields. Re-throws the underlying error unchanged.
 */
export async function timed<T>(
  event: string,
  fn: () => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    logger.info({ event, durationMs, status: 'ok', ...extra }, `${event} ok ${durationMs}ms`);
    return result;
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - start);
    logger.warn(
      { event, durationMs, status: 'error', error: err?.message, ...extra },
      `${event} failed ${durationMs}ms: ${err?.message}`,
    );
    throw err;
  }
}

export default logger;
