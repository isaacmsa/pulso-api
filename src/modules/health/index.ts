import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { validationHook } from '../../middleware/errors';
import { healthRoute } from './routes';

export const health = new OpenAPIHono<AppEnv>({ defaultHook: validationHook }).openapi(
  healthRoute,
  async (c) => {
    await c.var.sql`SELECT 1`;
    return c.json({ ok: true as const }, 200);
  },
);
