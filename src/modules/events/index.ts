import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { authenticate } from '../../middleware/auth';
import { apiError, validationHook } from '../../middleware/errors';
import { sendAndRecord } from '../push/notices';
import { postEventsRoute } from './routes';
import * as service from './service';

export const events = new OpenAPIHono<AppEnv>({ defaultHook: validationHook }).openapi(
  postEventsRoute,
  async (c) => {
    const batch = c.req.valid('json');
    const receivedAt = c.var.now();
    // consulta 1: auth, latido y diagnostics en un solo UPDATE. Un lote con eventos no saca la
    // casa de sin_noticias en la auth: lo decide la clasificación, que sabe cuándo volvió la luz.
    const device = await authenticate(c.var.sql, c.var.tokenHash, receivedAt, batch.diagnostics, {
      revive: batch.events.length === 0,
    });
    if (!device) return apiError(c, 401, 'invalid_token', 'El token falta o no es válido.');
    const { homeId, home } = device;
    if (!homeId || !home) {
      return apiError(c, 404, 'not_found', 'Este dispositivo no vigila ninguna casa.');
    }
    const { response, notify } = await service.ingestEvents(
      c.var.sql,
      { id: device.id, homeId, home },
      batch,
      receivedAt,
    );
    // Los avisos ya quedaron marcados (regla 11): se mandan después de responder, y guardar sus
    // tickets es la 4.ª consulta, solo cuando sale un push (A-031).
    if (notify.length > 0) {
      const token = c.env.EXPO_ACCESS_TOKEN;
      c.var.defer(
        sendAndRecord(c.var.sql, notify, receivedAt, {
          fetch: c.var.fetch,
          ...(token ? { accessToken: token } : {}),
        }),
      );
    }
    return c.json(response, 200);
  },
);
