import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { authenticate } from '../../middleware/auth';
import { apiError, validationHook } from '../../middleware/errors';
import { postEventsRoute } from './routes';
import * as service from './service';

export const events = new OpenAPIHono<AppEnv>({ defaultHook: validationHook }).openapi(
  postEventsRoute,
  async (c) => {
    const batch = c.req.valid('json');
    const receivedAt = c.var.now();
    // consulta 1: auth, latido y diagnostics en un solo UPDATE
    const device = await authenticate(c.var.sql, c.var.tokenHash, receivedAt, batch.diagnostics);
    if (!device) return apiError(c, 401, 'invalid_token', 'El token falta o no es válido.');
    const { homeId, home } = device;
    if (!homeId || !home) {
      return apiError(c, 404, 'not_found', 'Este dispositivo no vigila ninguna casa.');
    }
    const result = await service.ingestEvents(
      c.var.sql,
      { id: device.id, homeId, home },
      batch,
      receivedAt,
    );
    return c.json(result, 200);
  },
);
