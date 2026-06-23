import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const apiKeyMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const rawKey = authHeader.slice(7).trim();
  const hash = createHash('sha256').update(rawKey).digest('hex');
  const storedHash = process.env.ADMIN_API_KEY_HASH;
  if (!storedHash || hash !== storedHash) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};
