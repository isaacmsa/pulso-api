import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { createApp } from '../../src/index';

const limiter = { limit: async () => ({ success: true }) };

// Ninguna de estas rutas toca la base: la cadena es falsa y `onQuery` cuenta cero consultas.
function envWith(overrides: Partial<Bindings> = {}): Bindings {
  return {
    HYPERDRIVE: { connectionString: 'postgres://nadie:nada@127.0.0.1:1/nada' },
    RATE_LIMIT_REGISTER: limiter,
    RATE_LIMIT_EVENTS: limiter,
    RATE_LIMIT_API: limiter,
    RATE_LIMIT_PUBLIC: limiter,
    ENVIRONMENT: 'test',
    TOKEN_SIGNING_KEY: 'x',
    ...overrides,
  };
}

describe('documentación del contrato', () => {
  it('GET /openapi.json sirve el mismo documento que openapi.json, sin base ni token', async () => {
    let queries = 0;
    const app = createApp({ onQuery: () => queries++ });
    const res = await app.request('/openapi.json', {}, envWith());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const committed = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../openapi.json'), 'utf8'),
    );
    expect(await res.json()).toEqual(committed);
    expect(queries).toBe(0);
  });

  it('nombra los esquemas para que el cliente generado tenga tipos estables', () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../openapi.json'), 'utf8'),
    ) as { components: { schemas: Record<string, unknown> } };
    expect(Object.keys(committed.components.schemas).sort()).toEqual(
      [
        'ConfirmationEvent',
        'CreateHomeRequest',
        'CreateHomeResponse',
        'DeviceEvent',
        'Diagnostics',
        'Error',
        'EventBatch',
        'Health',
        'HomeStatus',
        'IngestEventsResponse',
        'RegisterDeviceRequest',
        'RegisterDeviceResponse',
        'ReportEvent',
        'SnapshotEvent',
        'UpdateDeviceRequest',
        'UpdateHomeRequest',
      ].sort(),
    );
  });

  it('GET /openapi.json arma el documento una sola vez por isolate', async () => {
    const app = createApp();
    const build = vi.spyOn(app, 'getOpenAPI31Document');
    for (let i = 0; i < 3; i++) {
      expect((await app.request('/openapi.json', {}, envWith())).status).toBe(200);
    }
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('GET /docs responde 404 con la forma de error si EXPOSE_DOCS no es true', async () => {
    for (const env of [envWith(), envWith({ EXPOSE_DOCS: 'false' })]) {
      const res = await createApp().request('/docs', {}, env);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      });
    }
  });

  it('GET /docs sirve Scalar con EXPOSE_DOCS=true', async () => {
    let queries = 0;
    const app = createApp({ onQuery: () => queries++ });
    const res = await app.request('/docs', {}, envWith({ EXPOSE_DOCS: 'true' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('/openapi.json');
    expect(queries).toBe(0);
  });
});
