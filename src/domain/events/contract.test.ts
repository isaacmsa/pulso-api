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

  it('openapi.json declara las rutas de la fase 1', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, unknown>;
    };
    for (const path of [
      '/v1/devices',
      '/v1/devices/me',
      '/v1/homes',
      '/v1/homes/me',
      '/v1/homes/me/status',
      '/v1/events',
      '/health',
    ]) {
      expect(doc.paths, path).toHaveProperty([path]);
    }
  });

  it('openapi.json no expone tokens de ejemplo', () => {
    const text = readFileSync(OPENAPI_PATH, 'utf8');
    const strings = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? '');
    const tokenLike = strings.filter((s) => /^[A-Za-z0-9_-]{43}$/.test(s));
    expect(tokenLike).toEqual([]);
  });
});
