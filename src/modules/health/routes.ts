import { createRoute, z } from '@hono/zod-openapi';
import { internalError, rateLimitedError } from '../../middleware/errors';
import { rateLimit } from '../../middleware/rate-limit';

export const healthRoute = createRoute({
  operationId: 'getHealth',
  method: 'get',
  path: '/health',
  tags: ['monitoreo'],
  summary: 'La API y la base responden',
  // Pública: el límite es por IP (regla 9) y corre antes del `SELECT 1`.
  middleware: [rateLimit('RATE_LIMIT_PUBLIC', 'ip')],
  responses: {
    200: {
      description: 'La base respondió a un `SELECT 1`',
      content: {
        'application/json': { schema: z.object({ ok: z.literal(true) }).openapi('Health') },
      },
    },
    429: rateLimitedError('Más de 60 peticiones por minuto desde esta IP'),
    500: { ...internalError, description: '`internal_error`: la base no respondió' },
  },
});
