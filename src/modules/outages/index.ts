import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { apiError, validationHook } from '../../middleware/errors';
import { getOutagesRoute } from './routes';
import * as service from './service';

export const outages = new OpenAPIHono<AppEnv>({ defaultHook: validationHook }).openapi(
  getOutagesRoute,
  async (c) => {
    const { homeId } = c.var.device;
    if (!homeId) return apiError(c, 404, 'not_found', 'Este dispositivo no vigila ninguna casa.');
    const { from, to } = c.req.valid('query');
    const history = await service.outageHistory(c.var.sql, homeId, { from, to, now: c.var.now() });
    return c.json(history, 200);
  },
);
