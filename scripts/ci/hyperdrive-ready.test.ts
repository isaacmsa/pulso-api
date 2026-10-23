import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'hyperdrive-ready.mjs');
const dir = mkdtempSync(join(tmpdir(), 'pulso-hyperdrive-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Corre el script contra un `wrangler.jsonc` de prueba y devuelve lo que imprime. */
function run(env: string, jsonc: string): string {
  const file = join(dir, `wrangler-${Math.random().toString(36).slice(2)}.jsonc`);
  writeFileSync(file, jsonc);
  return execFileSync(process.execPath, [script, env, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const config = (stagingId: string, productionId: string) => `{
  "name": "pulso-api",
  "env": {
    "staging": { "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "${stagingId}" }] },
    "production": { "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "${productionId}" }] }
  }
}`;

describe('hyperdrive-ready', () => {
  it('lee el id de cada entorno', () => {
    const text = config('aaaa1111', '<pendiente-isaac>');
    expect(run('staging', text)).toBe('ready=true');
    expect(run('production', text)).toBe('ready=false');
    expect(run('production', config('aaaa1111', 'bbbb2222'))).toBe('ready=true');
  });

  it('el marcador pendiente da ready=false', () => {
    expect(run('staging', config('<pendiente-isaac>', 'bbbb2222'))).toBe('ready=false');
    expect(run('staging', config('', 'bbbb2222'))).toBe('ready=false');
  });

  it('acepta comas finales y comentarios', () => {
    const text = `// Nada secreto aquí
{
  /* bloque
     de varias líneas */
  "hyperdrive": [
    // el de local no cuenta
    { "binding": "HYPERDRIVE", "id": "local", "localConnectionString": "postgres://u:p@localhost:54322/db" },
  ],
  "note": "una cadena con // dentro y /* esto */ también",
  "env": {
    "staging": {
      "hyperdrive": [
        { "binding": "HYPERDRIVE", "id": "4c73e199", }, // comentario al final
      ],
    },
  },
}
`;
    expect(run('staging', text)).toBe('ready=true');
  });

  it('un entorno que no existe da ready=false', () => {
    expect(run('qa', config('aaaa1111', 'bbbb2222'))).toBe('ready=false');
    expect(run('production', '{ "env": { "staging": {} } }')).toBe('ready=false');
  });

  it('el marcador dentro de un comentario no cuenta', () => {
    const text = `{ "env": { "staging": { "hyperdrive": [{ "id": "aaaa1111" }] } } } // <pendiente-isaac>`;
    expect(run('staging', text)).toBe('ready=true');
  });

  it('un archivo ilegible falla en vez de dar ready=false', () => {
    expect(() => run('staging', '{ "env": ')).toThrow();
  });
});
