import { requireDevice, requireToken } from './auth';
import { rateLimit } from './rate-limit';

/** Las rutas con token: lee el `Bearer`, limita por dispositivo (120 por minuto) y autentica. */
export const deviceAuth = [requireToken, rateLimit('RATE_LIMIT_API', 'token'), requireDevice];

/** Esquema de seguridad `bearer` (registrado en `createApp`) de las rutas con token. */
export const SECURITY = [{ bearer: [] }];
