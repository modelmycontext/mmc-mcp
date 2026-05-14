import { vi } from 'vitest';

/**
 * Shared `vi.mock` factory for `@src/utils/logger.js`.
 *
 * Use as:
 *   vi.mock('@src/utils/logger.js', async () =>
 *     (await import('<relative>/_helpers/loggerMock')).loggerMock(),
 *   );
 *
 * Why an async factory? `vi.mock` is hoisted above ordinary imports, so a
 * top-level `import { loggerMock } from ...` would not be defined when the
 * factory ran. The async-import form lazily resolves the helper at mock-
 * registration time, which sidesteps the hoisting trap without needing
 * `vi.hoisted`.
 *
 * Exposes the same surface as the real logger module:
 *  - `logger`        — pino-shaped spy methods, so tests can still assert
 *                      `expect(logger.warn).toHaveBeenCalledWith(...)`.
 *  - `timed`         — passthrough; runs the wrapped fn and returns its
 *                      value, no timing log emitted.
 *  - `withTraceId`   — passthrough; runs the wrapped fn synchronously.
 */
export function loggerMock() {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    timed: async (_event: unknown, fn: () => unknown) => fn(),
    withTraceId: (_id: unknown, fn: () => unknown) => fn(),
  };
}
