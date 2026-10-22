import { createRoute, z } from '@hono/zod-openapi';
import { eventBatchSchema } from '../../domain/events/schema';
import { homeStatusSchema } from '../../domain/homes/schema';
import { requireToken } from '../../middleware/auth';
import { SECURITY } from '../../middleware/device-auth';
import { internalError, jsonError, rateLimitedError } from '../../middleware/errors';
import { requireJsonBody } from '../../middleware/json-body';
import { rateLimit } from '../../middleware/rate-limit';

const count = z.number().int().min(0);

/**
 * Sin `requireDevice`: el handler autentica con los `diagnostics` del lote, para guardarlos en el
 * mismo `UPDATE` del latido (consulta 1).
 */
export const postEventsRoute = createRoute({
  operationId: 'ingestEvents',
  method: 'post',
  path: '/v1/events',
  tags: ['eventos'],
  summary: 'Subir un lote de eventos (hasta 200) o un latido vacío',
  description:
    'Idempotente por el `id` de cada evento: un reintento cuenta como `duplicated` y no cambia nada. ' +
    'Responde el estado de la casa después de clasificar.',
  security: SECURITY,
  middleware: [requireToken, rateLimit('RATE_LIMIT_EVENTS', 'token'), requireJsonBody],
  request: {
    body: { required: true, content: { 'application/json': { schema: eventBatchSchema } } },
  },
  responses: {
    200: {
      description: 'Lote guardado y clasificado',
      content: {
        'application/json': {
          schema: z
            .object({ accepted: count, duplicated: count, status: homeStatusSchema })
            .openapi('IngestEventsResponse'),
        },
      },
    },
    400: jsonError('Lote inválido o de más de 200 eventos'),
    401: jsonError('Token inválido'),
    404: jsonError('El dispositivo no vigila ninguna casa'),
    429: rateLimitedError('Más de 30 lotes por minuto de este dispositivo'),
    500: internalError,
  },
});
