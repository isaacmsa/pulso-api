import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventBatchSchema } from './schema';

// El contrato de /v1 solo cambia de forma aditiva (AGENTS.md, regla 6): estos lotes son los que
// mandaron las versiones publicadas de la app y tienen que seguir validando.

const BATCHES_DIR = join(import.meta.dirname, '../../../test/fixtures/batches');
const OPENAPI_PATH = join(import.meta.dirname, '../../../openapi.json');

describe('contrato de /v1', () => {
  it('el lote de la app 0.1.0 sigue validando', () => {
    const files = readdirSync(BATCHES_DIR).filter((name) => name.endsWith('.json'));
    expect(files).toContain('v0.1.0-spike.json');
    for (const file of files) {
      const batch = JSON.parse(readFileSync(join(BATCHES_DIR, file), 'utf8'));
      const result = eventBatchSchema.safeParse(batch);
      expect(result.success, `${file}: ${result.success ? '' : result.error.message}`).toBe(true);
    }
  });

  // Los operationId nombran las funciones del cliente que la app genera: renombrar uno lo rompe.
  const OPERATIONS: Array<[method: string, path: string, operationId: string]> = [
    ['get', '/health', 'getHealth'],
    ['post', '/v1/devices', 'registerDevice'],
    ['patch', '/v1/devices/me', 'updateDevice'],
    ['delete', '/v1/devices/me', 'deleteDevice'],
    ['post', '/v1/homes', 'createHome'],
    ['patch', '/v1/homes/me', 'updateHome'],
    ['get', '/v1/homes/me/status', 'getHomeStatus'],
    ['get', '/v1/homes/me/outages', 'getOutages'],
    ['post', '/v1/homes/me/share-code', 'regenerateShareCode'],
    ['post', '/v1/events', 'ingestEvents'],
    ['post', '/v1/follows', 'followHome'],
    ['get', '/v1/follows', 'listFollows'],
    ['delete', '/v1/follows/{homeId}', 'unfollowHome'],
  ];

  it('openapi.json declara las rutas de /v1, con sus métodos y operationId', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const expected: Record<string, string[]> = {};
    for (const [method, path, operationId] of OPERATIONS) {
      expect(doc.paths[path]?.[method]?.operationId, `${method} ${path}`).toBe(operationId);
      expected[path] = [...(expected[path] ?? []), method];
    }
    // ni rutas ni métodos de más: un método nuevo se agrega aquí a propósito
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(doc.paths[path] ?? {}).sort(), path).toEqual(methods.sort());
    }
    expect(Object.keys(doc.paths).sort()).toEqual(Object.keys(expected).sort());
  });

  it('cada ruta documenta el 500 y el 429 con Retry-After', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, Record<string, { responses: Record<string, { headers?: object }> }>>;
    };
    for (const [method, path] of OPERATIONS) {
      const responses = doc.paths[path]?.[method]?.responses ?? {};
      expect(responses, `${method} ${path}`).toHaveProperty('500');
      if (responses['429'])
        expect(responses['429'].headers, `${method} ${path}`).toHaveProperty('Retry-After');
    }
  });

  it('openapi.json no expone tokens de ejemplo', () => {
    const text = readFileSync(OPENAPI_PATH, 'utf8');
    const strings = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? '');
    const tokenLike = strings.filter((s) => /^[A-Za-z0-9_-]{43}$/.test(s));
    expect(tokenLike).toEqual([]);
  });
});
