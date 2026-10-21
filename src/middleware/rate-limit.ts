import type { MiddlewareHandler } from 'hono';
import type { AppEnv, RateLimitBinding } from '../env';
import { apiError } from './errors';

/**
 * Límite con el binding Rate Limiting (A-009, A-014). Por `token`, la clave es el hash del token
 * (va después de `requireToken`), así que corre antes de tocar la base. Por `ip`, solo en el
 * registro y las páginas públicas (CGNAT).
 */
export function rateLimit(
  binding: RateLimitBinding,
  key: 'ip' | 'token',
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limitKey =
      key === 'ip' ? (c.req.header('cf-connecting-ip') ?? 'unknown') : c.var.tokenHash;
    if (!limitKey) throw new Error('rateLimit por token va después de requireToken');
    const { success } = await c.env[binding].limit({ key: limitKey });
    if (!success) {
      c.header('Retry-After', '60');
      return apiError(
        c,
        429,
        'rate_limited',
        'Demasiadas peticiones. Intenta de nuevo en un minuto.',
      );
    }
    await next();
  };
}
