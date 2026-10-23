import { createRoute, z } from '@hono/zod-openapi';
import { aliasSchema, homeStatusSchema } from '../../domain/homes/schema';
import { deviceAuth, SECURITY } from '../../middleware/device-auth';
import { internalError, jsonError, rateLimitedError } from '../../middleware/errors';
import { requireJsonBody } from '../../middleware/json-body';

/** Tope de casas que sigue un dispositivo (A-036). */
export const MAX_FOLLOWS = 20;

// El alfabeto de `generateShareCode` (sin 0, 1, I, L ni O). Se pasa a mayúsculas **antes** de
// validar, así que un código en minúsculas se acepta; el OpenAPI declara el patrón en mayúsculas.
const codeSchema = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.toUpperCase() : value),
    z.string().regex(/^[2-9A-HJKMNP-Z]{8}$/),
  )
  .openapi({
    type: 'string',
    pattern: '^[2-9A-HJKMNP-Z]{8}$',
    description: 'Código de la casa, 8 caracteres. Las minúsculas se aceptan',
    example: 'K7M2QX9P',
  });

export const followRequestSchema = z
  .object({
    code: codeSchema,
    alias: aliasSchema.openapi({ description: 'Cómo llamo yo a esa casa' }),
  })
  .openapi('FollowRequest');

export const followItemSchema = z
  .object({
    homeId: z.uuid(),
    alias: aliasSchema.openapi({ description: 'El alias que le puse yo, no el del dueño' }),
    status: homeStatusSchema,
  })
  .openapi('FollowItem');

export const followListSchema = z
  .object({
    items: z.array(followItemSchema).openapi({ description: 'Ordenadas por alias' }),
  })
  .openapi('FollowList');

export const followHomeRoute = createRoute({
  operationId: 'followHome',
  method: 'post',
  path: '/v1/follows',
  tags: ['seguidores'],
  summary: 'Seguir una casa con su código',
  description:
    'Es idempotente (A-036): seguir otra vez la misma casa actualiza el alias y también responde 201. Se puede seguir la propia casa. Tope de 20 casas por dispositivo.',
  security: SECURITY,
  middleware: [...deviceAuth, requireJsonBody],
  request: {
    body: { required: true, content: { 'application/json': { schema: followRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Siguiendo la casa, con su estado',
      content: { 'application/json': { schema: followItemSchema } },
    },
    400: jsonError('Cuerpo inválido, o el dispositivo ya sigue 20 casas (`validation_failed`)'),
    401: jsonError('Token inválido'),
    404: jsonError('No existe una casa con ese código'),
    429: rateLimitedError('Demasiadas peticiones'),
    500: internalError,
  },
});

export const listFollowsRoute = createRoute({
  operationId: 'listFollows',
  method: 'get',
  path: '/v1/follows',
  tags: ['seguidores'],
  summary: 'Las casas que sigo, con su estado',
  security: SECURITY,
  middleware: deviceAuth,
  responses: {
    200: {
      description: 'Casas que sigo, ordenadas por alias',
      content: { 'application/json': { schema: followListSchema } },
    },
    401: jsonError('Token inválido'),
    429: rateLimitedError('Demasiadas peticiones'),
    500: internalError,
  },
});

export const unfollowHomeRoute = createRoute({
  operationId: 'unfollowHome',
  method: 'delete',
  path: '/v1/follows/{homeId}',
  tags: ['seguidores'],
  summary: 'Dejar de seguir una casa',
  description: 'Responde 204 también si el dispositivo no la seguía.',
  security: SECURITY,
  middleware: deviceAuth,
  request: { params: z.object({ homeId: z.uuid() }) },
  responses: {
    204: { description: 'Ya no la sigo' },
    400: jsonError('`homeId` no es un uuid'),
    401: jsonError('Token inválido'),
    429: rateLimitedError('Demasiadas peticiones'),
    500: internalError,
  },
});
