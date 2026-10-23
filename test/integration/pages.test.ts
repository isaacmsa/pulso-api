import { describe, expect, it } from 'vitest';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { TEST_SIGNING_KEY } from './helpers';

const CONTACT = 'isaac.mendozasa@gmail.com';

const limiter: RateLimiter = { limit: async () => ({ success: true }) };

function testEnv(): Bindings {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  return {
    HYPERDRIVE: { connectionString: url },
    RATE_LIMIT_REGISTER: limiter,
    RATE_LIMIT_EVENTS: limiter,
    RATE_LIMIT_API: limiter,
    RATE_LIMIT_PUBLIC: limiter,
    ENVIRONMENT: 'test',
    TOKEN_SIGNING_KEY: TEST_SIGNING_KEY,
  };
}

function expectHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  expect(res.headers.get('content-security-policy')).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
}

/** El texto de la columna de retención de la fila de `/privacidad` cuyo dato contiene `fragment`. */
function retentionOf(html: string, fragment: string): string {
  const rows = [...html.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)];
  const row = rows.find((m) => m[1]?.toLowerCase().includes(fragment.toLowerCase()));
  if (!row) throw new Error(`No hay fila con "${fragment}"`);
  return row[2] ?? '';
}

async function get(path: string, onQuery?: () => void) {
  const res = await createApp({ onQuery }).request(path, {}, testEnv());
  return { res, html: await res.text() };
}

describe('páginas públicas', () => {
  it('privacidad responde HTML en español sin consultar la base', async () => {
    let queries = 0;
    const { res, html } = await get('/privacidad', () => queries++);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expectHeaders(res);
    expect(html).toContain('lang="es"');
    expect(html).toContain('name="viewport"');
    expect(queries).toBe(0);
  });

  it('privacidad dice que no recoge ubicación ni el nombre de la red', async () => {
    const { html } = await get('/privacidad');
    expect(html).toMatch(/no (se )?recoge[^.]*ubicación/i);
    expect(html).toMatch(/nombre de la red/i);
    expect(html).toMatch(/identificador del router/i);
  });

  it('privacidad lista los proveedores y el correo de contacto', async () => {
    const { html } = await get('/privacidad');
    for (const provider of ['Cloudflare', 'Supabase', 'Expo', 'Firebase', 'Sentry', 'GitHub']) {
      expect(html).toContain(provider);
    }
    expect(html).toMatch(/no (se )?vend/i);
    expect(html).toContain(`mailto:${CONTACT}`);
  });

  it('privacidad tiene las retenciones: 30 días, 180 días y 7 días', async () => {
    const { html } = await get('/privacidad');
    expect(retentionOf(html, 'identificador anónimo')).toMatch(/180 días sin actividad.*7 días/);
    expect(retentionOf(html, 'si hay corriente')).toMatch(/30 días en el servidor.*14 días/);
    expect(retentionOf(html, 'reportes y confirmaciones')).toBe('30 días.');
    expect(retentionOf(html, 'cortes de luz detectados')).toBe('Mientras exista la casa.');
  });

  it('privacidad explica el código de la casa y cómo regenerarlo', async () => {
    const { html } = await get('/privacidad');
    expect(html).toMatch(/código de la casa/i);
    expect(html).toMatch(/regeneralo|regenéralo/i);
    expect(html).toMatch(/enlace viejos dejan de servir/);
    expect(html).toMatch(
      /el código y\s+el enlace viejos dejan de servir y se quita a todos los que siguen la casa/,
    );
    expect(html).toMatch(/necesitarán el código nuevo/);
    expect(html).not.toMatch(/Quienes ya la\s+siguen la siguen/);
    expect(html).not.toMatch(/hasta que dejen de seguirla/);
    expect(html).toMatch(/cuánto lleva el corte/);
    expect(html).toContain('Última actualización');
  });

  it('privacidad tiene las cabeceras de seguridad', async () => {
    expectHeaders((await get('/privacidad')).res);
  });

  it('borrar-datos explica el borrado desde la app y por correo', async () => {
    let queries = 0;
    const { res, html } = await get('/borrar-datos', () => queries++);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html).toContain('lang="es"');
    expect(html).toContain('Ajustes');
    expect(html).toContain('Borrar mis datos');
    expect(html).toContain(`mailto:${CONTACT}`);
    expect(html).toMatch(/código de la casa/i);
    expect(html).toMatch(/quien tenga el código de la casa también\s+puede pedir el borrado/);
    expect(html).toMatch(/te avisamos por correo cuando esté hecho/i);
    expect(html).not.toMatch(/plazo de 7 días/);
    expect(html).toMatch(/Sentry/);
    expect(html).toMatch(/en su servidor/);
    expectHeaders(res);
    for (const thing of ['dispositivo', 'casa', 'eventos', 'cortes', 'seguidores', 'avisos']) {
      expect(html).toContain(thing);
    }
    expect(queries).toBe(0);
  });

  it('las páginas no cargan nada externo', async () => {
    for (const path of ['/privacidad', '/borrar-datos']) {
      const { html } = await get(path);
      expect(html).not.toContain('src="http');
      expect(html).not.toContain('href="http');
      expect(html).not.toMatch(/url\(\s*['"]?https?:/);
      expect(html).not.toContain('<script');
    }
  });

  it('el CSS en línea no lleva entidades HTML (el <style> no las decodifica)', async () => {
    for (const path of ['/privacidad', '/borrar-datos']) {
      const { html } = await get(path);
      const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
      expect(css).not.toMatch(/&[a-z#0-9]+;/);
    }
  });

  it('las páginas no aparecen en el contrato OpenAPI', async () => {
    const { html } = await get('/openapi.json');
    const doc = JSON.parse(html) as { paths: Record<string, unknown> };
    expect(doc.paths['/privacidad']).toBeUndefined();
    expect(doc.paths['/borrar-datos']).toBeUndefined();
  });
});
