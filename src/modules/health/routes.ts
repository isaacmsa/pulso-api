import { createRoute, z } from '@hono/zod-openapi';
import { errorSchema } from '../../middleware/errors';

export const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['monitoreo'],
  summary: 'La API y la base responden',
  responses: {
    200: {
      description: 'La base respondió a un `SELECT 1`',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    500: {
      description: 'La base no respondió',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});
