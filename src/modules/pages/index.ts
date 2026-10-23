import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { DeleteData } from './delete-data';
import { Privacy } from './privacy';

// Páginas públicas que pide Google Play. No van en el OpenAPI y no tocan la base: son texto fijo.
// Se arman con `c.body` (y no con `c.html`) para fijar el `content-type` exacto del contrato.
const headers = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=3600',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
};

export const pages = new Hono<AppEnv>()
  .get('/privacidad', (c) => c.body(`<!doctype html>${Privacy()}`, 200, headers))
  .get('/borrar-datos', (c) => c.body(`<!doctype html>${DeleteData()}`, 200, headers));
