import { Hono } from 'hono';
import { shareCodeSchema } from '../../domain/homes/schema';
import type { AppEnv } from '../../env';
import { apiError } from '../../middleware/errors';
import { rateLimit } from '../../middleware/rate-limit';
import { DeleteData } from './delete-data';
import { ANDROID_PACKAGE, FamilyNotFound, FamilyPage, openInAppHref } from './family';
import { Privacy } from './privacy';
import { findHomeByShareCode } from './repo';

// Páginas públicas que pide Google Play. No van en el OpenAPI y no tocan la base: son texto fijo.
// Se arman con `c.body` (y no con `c.html`) para fijar el `content-type` exacto del contrato.
const headers = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=3600',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
};

// `/c/:code` (A-035): sin dominio propio no hay Cache API, así que el único caché es el del
// cliente. El código va en la URL: que no salga en el `Referer` ni se indexe. El botón cambia
// según el User-Agent (A-048), por eso `Vary`: un caché no puede darle a un iPhone la página de
// Android.
const familyHeaders = {
  ...headers,
  'cache-control': 'public, max-age=30',
  vary: 'User-Agent',
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
};

export const pages = new Hono<AppEnv>()
  .get('/privacidad', (c) => c.body(`<!doctype html>${Privacy()}`, 200, headers))
  .get('/borrar-datos', (c) => c.body(`<!doctype html>${DeleteData()}`, 200, headers))
  // El límite por IP corre antes que todo, también antes de validar el código. Un código inválido
  // y uno que no existe dan el mismo 404, y el inválido ni consulta (1 consulta por vista, regla 5).
  .get('/c/:code', rateLimit('RATE_LIMIT_PUBLIC', 'ip'), async (c) => {
    const notFound = () => c.body(`<!doctype html>${FamilyNotFound()}`, 404, familyHeaders);
    const parsed = shareCodeSchema.safeParse(c.req.param('code').toUpperCase());
    if (!parsed.success) return notFound();
    const home = await findHomeByShareCode(c.var.sql, parsed.data);
    if (!home) return notFound();
    const openHref = openInAppHref({
      code: parsed.data,
      origin: new URL(c.req.url).origin,
      android: /Android/i.test(c.req.header('user-agent') ?? ''),
    });
    const page = FamilyPage({ code: parsed.data, home, now: c.var.now(), openHref });
    return c.body(`<!doctype html>${page}`, 200, familyHeaders);
  })
  // App Links: Android verifica el dominio con este archivo. Sin huella configurada no hay nada
  // que verificar y responde 404. Acepta varias huellas separadas por coma.
  .get('/.well-known/assetlinks.json', (c) => {
    const fingerprints = (c.env.ANDROID_CERT_SHA256 ?? '')
      .split(',')
      .map((fingerprint) => fingerprint.trim())
      .filter(Boolean);
    if (fingerprints.length === 0) return apiError(c, 404, 'not_found', 'No existe esa ruta.');
    const body = [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ];
    return c.body(JSON.stringify(body), 200, {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    });
  });
