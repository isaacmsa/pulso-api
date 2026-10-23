import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../env';
import { requireDevice, requireToken } from '../../middleware/auth';
import { SECURITY } from '../../middleware/device-auth';
import {
  internalError,
  jsonError,
  rateLimitedError,
  validationHook,
} from '../../middleware/errors';
import { rateLimit } from '../../middleware/rate-limit';

const DAY_MS = 86_400_000;
/** Tope del rango (A-027): acota las filas y el CPU de una petición. */
export const MAX_RANGE_MS = 92 * DAY_MS;

// Los parámetros de la URL llegan como texto: `coerce` los vuelve número antes de validar.
const epochMsParam = z.coerce.number().int().positive();

export const outagesQuerySchema = z
  .object({
    from: epochMsParam.openapi({
      description: 'Inicio del rango, epoch ms (incluido)',
      example: 1_760_000_000_000,
    }),
    to: epochMsParam.openapi({
      description:
        'Fin del rango, epoch ms (excluido). Debe ser mayor que `from`, con un máximo de 92 días',
      example: 1_760_604_800_000,
    }),
  })
  .refine((q) => q.from < q.to, { message: '`from` debe ser menor que `to`.', path: ['from'] })
  .refine((q) => q.to - q.from <= MAX_RANGE_MS, {
    message: 'El rango no puede pasar de 92 días.',
    path: ['to'],
  });

/**
 * Valida el rango **antes** de la consulta de auth: una petición inválida no cuesta ninguna
 * consulta. La ruta lo vuelve a validar (barato) para tipar `c.req.valid('query')`.
 */
const validateRange: MiddlewareHandler<AppEnv> = async (c, next) => {
  const rejected = validationHook(outagesQuerySchema.safeParse(c.req.query()), c);
  if (rejected) return rejected;
  await next();
};

export const outageItemSchema = z
  .object({
    id: z.uuid(),
    start: z.number().int().positive(),
    end: z.number().int().positive().nullable().openapi({ description: 'null: sigue abierto' }),
    // A-027: los cuatro valores desde ya; D-023 no deja agregar uno después
    status: z.enum(['abierto', 'cerrado', 'descartado', 'sin_datos']),
    confidence: z.enum(['alta', 'media', 'manual']),
    confirmed: z.boolean().nullable().openapi({ description: 'null: sin respuesta' }),
  })
  .openapi('OutageItem');

export const reportItemSchema = z
  .object({
    at: z.number().int().positive(),
    value: z.enum(['hay_luz', 'fluctuando', 'sin_luz']),
  })
  .openapi('ReportItem');

export const daySummarySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .openapi({
        description: 'Día local de Caracas (UTC−4)',
        example: '2026-10-19',
      }),
    ms: z.number().int().nonnegative(),
  })
  .openapi('DaySummary');

export const outageHistorySchema = z
  .object({
    items: z.array(outageItemSchema).openapi({
      description: 'Cortes que se solapan con el rango, el más reciente primero',
    }),
    reports: z.array(reportItemSchema).openapi({
      description:
        'Reportes del rango, el más reciente primero. Llegan hasta donde llega la retención (30 días)',
    }),
    totalMs: z.number().int().nonnegative().openapi({
      description:
        'Suma de los cortes `cerrado` y `abierto` recortados al rango; el abierto cuenta hasta ahora',
    }),
    days: z.array(daySummarySchema).openapi({
      description: 'Todos los días del rango, también los que suman 0',
    }),
  })
  .openapi('OutageHistory');

export const getOutagesRoute = createRoute({
  operationId: 'getOutages',
  method: 'get',
  path: '/v1/homes/me/outages',
  tags: ['casas'],
  summary: 'Historial de cortes de mi casa en un rango, con el resumen por día',
  security: SECURITY,
  // igual que `deviceAuth`, con la validación del rango antes de la consulta de auth
  middleware: [requireToken, rateLimit('RATE_LIMIT_API', 'token'), validateRange, requireDevice],
  request: { query: outagesQuerySchema },
  responses: {
    200: {
      description: 'Cortes, reportes y resumen por día',
      content: { 'application/json': { schema: outageHistorySchema } },
    },
    400: jsonError('`from` o `to` faltan, no son epoch ms, o el rango pasa de 92 días'),
    401: jsonError('Token inválido'),
    404: jsonError('El dispositivo no tiene casa'),
    429: rateLimitedError('Demasiadas peticiones'),
    500: internalError,
  },
});
