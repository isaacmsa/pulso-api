import { createRoute, z } from '@hono/zod-openapi';
import { aliasSchema as alias, homeStatusSchema, shareCodeSchema } from '../../domain/homes/schema';
import { deviceAuth, SECURITY } from '../../middleware/device-auth';
import { internalError, jsonError, rateLimitedError } from '../../middleware/errors';
import { requireJsonBody } from '../../middleware/json-body';

export const createHomeRoute = createRoute({
  operationId: 'createHome',
  method: 'post',
  path: '/v1/homes',
  tags: ['casas'],
  summary: 'Este teléfono vigila mi casa: crea la casa del dispositivo',
  security: SECURITY,
  middleware: [...deviceAuth, requireJsonBody],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ alias: alias.default('Casa') }).openapi('CreateHomeRequest'),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Casa creada y asignada al dispositivo',
      content: {
        'application/json': {
          schema: z
            .object({
              homeId: z.uuid(),
              shareCode: shareCodeSchema,
            })
            .openapi('CreateHomeResponse'),
        },
      },
    },
    400: jsonError('Cuerpo inválido'),
    401: jsonError('Token inválido'),
    409: jsonError('`home_exists`: el dispositivo ya vigila una casa'),
    429: rateLimitedError('Demasiadas peticiones'),
    500: internalError,
  },
});

export const patchHomeBody = z
  .object({
    alias: alias.optional(),
    mode: z.enum(['base', 'ups']).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Manda al menos un campo.',
  })
  .openapi('UpdateHomeRequest');

export const patchHomeRoute = createRoute({
  operationId: 'updateHome',
  method: 'patch',
  path: '/v1/homes/me',
  tags: ['casas'],
  summary: 'Cambiar el alias o el modo (`base` o `ups`) de mi casa',
  security: SECURITY,
  middleware: [...deviceAuth, requireJsonBody],
  request: {
    body: { required: true, content: { 'application/json': { schema: patchHomeBody } } },
  },
  responses: {
    204: { description: 'Guardado' },
    400: jsonError('Cuerpo inválido o sin campos'),
    401: jsonError('Token inválido'),
    404: jsonError('El dispositivo no tiene casa'),
    429: rateLimitedError('Demasiadas peticiones'),
    500: internalError,
  },
});

export const homeStatusRoute = createRoute({
  operationId: 'getHomeStatus',
  method: 'get',
  path: '/v1/homes/me/status',
  tags: ['casas'],
  summary: 'Estado actual de mi casa',
  security: SECURITY,
  middleware: deviceAuth,
  responses: {
    200: {
      description: 'Estado de la casa',
      content: { 'application/json': { schema: homeStatusSchema } },
    },
    401: jsonError('Token inválido'),
    404: jsonError('El dispositivo no tiene casa'),
    429: rateLimitedError('Demasiadas peticiones'),
    500: internalError,
  },
});

export const regenerateShareCodeRoute = createRoute({
  operationId: 'regenerateShareCode',
  method: 'post',
  path: '/v1/homes/me/share-code',
  tags: ['casas'],
  summary: 'Regenerar el código de mi casa: el viejo deja de servir y se quita a los seguidores',
  description:
    'El código viejo deja de servir y se borran todos los seguidores de la casa (A-041): tienen que volver a seguirla con el código nuevo. No hay aviso a quien se quita.',
  security: SECURITY,
  middleware: deviceAuth,
  responses: {
    200: {
      description: 'El código nuevo',
      content: {
        'application/json': {
          schema: z.object({ shareCode: shareCodeSchema }).openapi('ShareCode'),
        },
      },
    },
    401: jsonError('Token inválido'),
    404: jsonError('El dispositivo no tiene casa'),
    429: rateLimitedError('Demasiadas peticiones'),
    500: internalError,
  },
});
