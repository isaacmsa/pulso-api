import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Lo que comparten los tests del respaldo (`dump.test.ts` y `restore-local.test.ts`). Corren contra
// el PostgreSQL de `pnpm db:up` (proyecto `backup`) y necesitan `age`/`age-keygen` y las
// herramientas de PostgreSQL 17: las del sistema o, si no, las del contenedor de `compose.dev.yaml`.
// Si falta algo, el test lo dice y falla: nunca se salta.

const composeFile = join(import.meta.dirname, '..', '..', 'compose.dev.yaml');

function onPath(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).error === undefined;
}

/** `age` y `age-keygen` del sistema; si no están, el test falla diciendo qué falta. */
export function requireAge(): void {
  if (onPath('age') && onPath('age-keygen')) return;
  throw new Error(
    'Faltan `age` y `age-keygen` en el PATH. Instálalos (brew install age, apt install age) y vuelve a correr los tests del respaldo.',
  );
}

/**
 * Carpeta con `pg_dump`, `pg_restore` y `psql` 17 para el PATH de los scripts. Si el pg_dump del
 * sistema ya es 17, no hace falta nada (cadena vacía). Si no, genera en `work` envoltorios que
 * corren las herramientas del contenedor de `compose.dev.yaml`; dentro del contenedor la base está
 * en el puerto 5432.
 */
export function pgToolsDir(work: string): string {
  const host = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (host.status === 0 && /\) 17\./.test(host.stdout)) return '';
  const container = spawnSync(
    'docker',
    ['compose', '-f', composeFile, 'ps', '--status', 'running', '-q', 'postgres'],
    { encoding: 'utf8' },
  );
  if (container.status !== 0 || !container.stdout.trim()) {
    throw new Error(
      'Falta pg_dump 17: el del sistema no es 17 y el contenedor de PostgreSQL no está corriendo. Instala postgresql-client-17 o corre pnpm db:up.',
    );
  }
  const dir = join(work, 'pg17');
  mkdirSync(dir, { recursive: true });
  for (const tool of ['pg_dump', 'pg_restore', 'psql']) {
    const shim = join(dir, tool);
    writeFileSync(
      shim,
      `#!/usr/bin/env bash
args=()
for a in "$@"; do args+=("\${a//localhost:54322/localhost:5432}"); done
exec docker compose -f "${composeFile}" exec -T postgres ${tool} "\${args[@]}"
`,
    );
    chmodSync(shim, 0o755);
  }
  return dir;
}

export type RunOptions = {
  env?: Record<string, string | undefined>;
  pathPrefix?: string[];
  input?: string;
};

/** Corre `bash <comando…>` con un entorno limpio de las variables del respaldo. */
export function bash(args: string[], { env = {}, pathPrefix = [], input }: RunOptions = {}) {
  const base = { ...process.env };
  delete base.DATABASE_URL;
  delete base.BACKUP_AGE_RECIPIENT;
  delete base.RESTORE_ADMIN_URL;
  delete base.RESTORE_DB;
  const merged: Record<string, string | undefined> = { ...base, ...env };
  merged.PATH = [...pathPrefix.filter(Boolean), process.env.PATH].join(':');
  return spawnSync('bash', args, { env: merged, encoding: 'utf8', input });
}

/** Un par `age` efímero en `work`: la clave privada solo existe en esa carpeta temporal. */
export function newKeyPair(work: string): { keyFile: string; recipient: string } {
  const keyFile = join(work, `${randomUUID()}.key`);
  const keygen = bash(['-c', `age-keygen -o "${keyFile}" 2>&1`]);
  const recipient = /(age1[a-z0-9]+)/.exec(keygen.stdout)?.[1];
  if (keygen.status !== 0 || !recipient) {
    throw new Error(`age-keygen no dio una clave pública: ${keygen.stdout}`);
  }
  return { keyFile, recipient };
}

export function testUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL (ver .env.example)');
  return url;
}

export function adminUrl(): string {
  const url = process.env.TEST_ADMIN_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_ADMIN_DATABASE_URL (ver .env.example)');
  return url;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
