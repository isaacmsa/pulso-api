import { createRoute, z } from '@hono/zod-openapi';
import { deviceAuth, SECURITY } from '../../middleware/device-auth';
import { errorSchema } from '../../middleware/errors';
import { requireJsonBody } from '../../middleware/json-body';
import { rateLimit } from '../../middleware/rate-limit';

const appVersion = z.string().min(1).max(32).openapi({ example: '1.0.0' });

const jsonError = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorSchema } },
});

export const registerRoute = createRoute({
  method: 'post',
  path: '/v1/devices',
  tags: ['dispositivos'],
  summary: 'Registrar el teléfono al primer arranque',
  description: 'Devuelve el token una sola vez: la API solo guarda su SHA-256.',
  middleware: [rateLimit('RATE_LIMIT_REGISTER', 'ip'), requireJsonBody],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ appVersion }) } },
    },
  },
  responses: {
    201: {
      description: 'Dispositivo registrado',
      content: {
        'application/json': {
          schema: z.object({ deviceId: z.uuid(), token: z.string().length(87) }),
        },
      },
    },
    400: jsonError('Cuerpo inválido'),
    429: jsonError('Más de 5 registros por minuto desde esta IP'),
  },
});

export const patchDeviceBody = z
  .object({
    pushToken: z.string().min(1).nullable().optional(),
    appVersion: appVersion.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Manda al menos un campo.',
  });

export const patchDeviceRoute = createRoute({
  method: 'patch',
  path: '/v1/devices/me',
  tags: ['dispositivos'],
  summary: 'Guardar el push token y la versión de la app',
  security: SECURITY,
  middleware: [...deviceAuth, requireJsonBody],
  request: {
    body: { required: true, content: { 'application/json': { schema: patchDeviceBody } } },
  },
  responses: {
    204: { description: 'Guardado' },
    400: jsonError('Cuerpo inválido o sin campos'),
    401: jsonError('Token inválido'),
    429: jsonError('Demasiadas peticiones'),
  },
});

export const deleteDeviceRoute = createRoute({
  method: 'delete',
  path: '/v1/devices/me',
  tags: ['dispositivos'],
  summary: 'Borrar el dispositivo, su casa y todo lo asociado',
  security: SECURITY,
  middleware: deviceAuth,
  responses: {
    204: { description: 'Borrado, con su casa, eventos, cortes y seguidores' },
    401: jsonError('Token inválido'),
    429: jsonError('Demasiadas peticiones'),
  },
});
