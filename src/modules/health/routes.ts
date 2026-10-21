import { createRoute, z } from '@hono/zod-openapi';
import { jsonError } from '../../middleware/errors';

export const healthRoute = createRoute({
  operationId: 'getHealth',
  method: 'get',
  path: '/health',
  tags: ['monitoreo'],
  summary: 'La API y la base responden',
  responses: {
    200: {
      description: 'La base respondió a un `SELECT 1`',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    500: jsonError('`internal_error`: la base no respondió'),
  },
});
