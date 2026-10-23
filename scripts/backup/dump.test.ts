import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, createHome, testDb, truncateAll } from '../../test/integration/helpers';

// Estos tests corren contra el PostgreSQL de `pnpm db:up` (proyecto `integration`). Necesitan
// `age`/`age-keygen` y `pg_dump`/`pg_restore` 17: los del sistema o, para PostgreSQL, los del
// contenedor de `compose.dev.yaml`. Si falta algo, el test lo dice y falla: nunca se salta.

const script = join(import.meta.dirname, 'dump.sh');
const composeFile = join(import.meta.dirname, '..', '..', 'compose.dev.yaml');
const TABLES = ['homes', 'devices', 'events', 'outages', 'follows', 'push_tickets'] as const;

const work = mkdtempSync(join(tmpdir(), 'pulso-backup-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function onPath(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).error === undefined;
}

/** `age` y `age-keygen` del sistema; si no están, el test falla diciendo qué falta. */
function requireAge(): void {
  if (onPath('age') && onPath('age-keygen')) return;
  throw new Error(
    'Faltan `age` y `age-keygen` en el PATH. Instálalos (brew install age, apt install age) y vuelve a correr los tests del respaldo.',
  );
}

/**
 * Carpeta con `pg_dump` y `pg_restore` 17 para el PATH del script. Si el pg_dump del sistema ya es
 * 17, no hace falta nada (cadena vacía). Si no, genera envoltorios que corren las herramientas del
 * contenedor de `compose.dev.yaml`; dentro del contenedor la base está en el puerto 5432.
 */
function pgToolsDir(): string {
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
  for (const tool of ['pg_dump', 'pg_restore']) {
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

type RunOptions = {
  env?: Record<string, string | undefined>;
  pathPrefix?: string[];
  input?: string;
};

/** Corre `bash <comando…>` con un entorno limpio de las variables del respaldo. */
function bash(args: string[], { env = {}, pathPrefix = [], input }: RunOptions = {}) {
  const base = { ...process.env };
  delete base.DATABASE_URL;
  delete base.BACKUP_AGE_RECIPIENT;
  const merged: Record<string, string | undefined> = { ...base, ...env };
  merged.PATH = [...pathPrefix.filter(Boolean), process.env.PATH].join(':');
  return spawnSync('bash', args, { env: merged, encoding: 'utf8', input });
}

/** Un `pg_dump` falso (carpeta para el PATH) cuyo cuerpo es el script dado. */
function fakePgDump(body: string): string {
  const dir = join(work, `fake-${randomUUID()}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'pg_dump'), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, 'pg_dump'), 0o755);
  return dir;
}

/** Destinatario de un par `age` efímero (la clave privada se queda en la carpeta temporal). */
function newRecipient(): string {
  const keygen = bash(['-c', `age-keygen -o "${join(work, `${randomUUID()}.key`)}" 2>&1`]);
  const recipient = /(age1[a-z0-9]+)/.exec(keygen.stdout)?.[1];
  if (!recipient) throw new Error(`age-keygen no dio una clave pública: ${keygen.stdout}`);
  return recipient;
}

function newOutDir(): string {
  const dir = join(work, randomUUID());
  mkdirSync(dir);
  return dir;
}

function testUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL (ver .env.example)');
  return url;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describe('scripts/backup/dump.sh', () => {
  const { sql } = testDb();

  beforeAll(async () => {
    await truncateAll(sql);
  });

  afterAll(async () => {
    await truncateAll(sql);
    await sql.end();
  });

  it('sin destinatario age, el respaldo sale con error y no deja archivo', () => {
    const dir = newOutDir();
    const out = join(dir, 'pulso.dump.age');
    const result = bash([script, out], { env: { DATABASE_URL: testUrl() } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('BACKUP_AGE_RECIPIENT');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('sin DATABASE_URL, el respaldo sale con error y no deja archivo', () => {
    const dir = newOutDir();
    const out = join(dir, 'pulso.dump.age');
    const result = bash([script, out], { env: { BACKUP_AGE_RECIPIENT: 'age1xxx' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DATABASE_URL');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('si pg_dump no logra conectar, el respaldo sale con error y no deja archivo', () => {
    requireAge();
    const pg = pgToolsDir();
    const dir = newOutDir();
    const out = join(dir, 'pulso.dump.age');
    // el puerto 1 no tiene nada escuchando
    const result = bash([script, out], {
      env: {
        DATABASE_URL: 'postgres://pulso_api:pulso_dev@localhost:1/pulso_test',
        BACKUP_AGE_RECIPIENT: newRecipient(),
      },
      pathPrefix: [pg],
    });
    expect(result.status).not.toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('si pg_dump falla a medio camino, aunque ya haya escrito 8 KB, sale con error y no deja archivo', () => {
    requireAge();
    const fake = fakePgDump('head -c 8192 /dev/urandom\nexit 1');
    const dir = newOutDir();
    const out = join(dir, 'pulso.dump.age');
    const result = bash([script, out], {
      env: { DATABASE_URL: testUrl(), BACKUP_AGE_RECIPIENT: newRecipient() },
      pathPrefix: [fake],
    });
    expect(result.status).not.toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('con un destinatario age inválido, sale con error y no deja archivo', () => {
    requireAge();
    const fake = fakePgDump('head -c 8192 /dev/urandom');
    const dir = newOutDir();
    const out = join(dir, 'pulso.dump.age');
    const result = bash([script, out], {
      env: { DATABASE_URL: testUrl(), BACKUP_AGE_RECIPIENT: 'age1invalid' },
      pathPrefix: [fake],
    });
    expect(result.status).not.toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('si el resultado pesa menos de 1 KB, sale con error y no deja archivo', () => {
    requireAge();
    const fake = fakePgDump('printf x');
    const dir = newOutDir();
    const out = join(dir, 'pulso.dump.age');
    const result = bash([script, out], {
      env: { DATABASE_URL: testUrl(), BACKUP_AGE_RECIPIENT: newRecipient() },
      pathPrefix: [fake],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pesa');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('en GitHub Actions enmascara host, usuario y contraseña antes de correr pg_dump', () => {
    const fake = fakePgDump('echo "pg_dump corrió" >&2\nexit 1');
    const dir = newOutDir();
    const result = bash([script, join(dir, 'pulso.dump.age')], {
      env: {
        GITHUB_ACTIONS: 'true',
        DATABASE_URL:
          'postgres://pulso_api.abcd1234:s3cr3t%40x@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
        BACKUP_AGE_RECIPIENT: 'age1xxx',
      },
      pathPrefix: [fake],
    });
    const lines = result.stdout.split('\n');
    expect(lines).toContain('::add-mask::aws-1-us-east-1.pooler.supabase.com');
    expect(lines).toContain('::add-mask::pulso_api.abcd1234');
    expect(lines).toContain('::add-mask::s3cr3t%40x');
    expect(result.stderr).toContain('pg_dump corrió');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('con un destinatario de prueba, el archivo cifrado se descifra y restaura las 6 tablas en una base nueva', async () => {
    requireAge();
    const pg = pgToolsDir();

    // datos en las seis tablas
    const { homeId, deviceId } = await createHome(sql, { since: 1_000 });
    const follower = randomUUID();
    await sql`
      INSERT INTO app.devices (id, token_hash, app_version, push_token, created_at, last_seen_at)
      VALUES (${follower}, ${randomUUID()}, '1.0.0', 'ExponentPushToken[test]', 1000, 1000)`;
    await sql`
      INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
      VALUES (${deviceId}, ${randomUUID()}, ${homeId}, 'snapshot', 2000, 2000,
              ${JSON.stringify({ battery: 80, charging: true })}, 2001)`;
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, ended_at, status, confidence, updated_at)
      VALUES (${randomUUID()}, ${homeId}, 3000, 4000, 'cerrado', 'alta', 4000)`;
    await sql`
      INSERT INTO app.follows (home_id, follower_device_id, alias, created_at)
      VALUES (${homeId}, ${follower}, 'Casa de mamá', 1000)`;
    await sql`
      INSERT INTO app.push_tickets (ticket_id, device_id, created_at)
      VALUES (${randomUUID()}, ${follower}, 5000)`;

    // par de claves efímero: la clave privada solo existe en esta carpeta temporal
    const keyFile = join(work, 'restore.key');
    const keygen = bash(['-c', `age-keygen -o "${keyFile}" 2>&1`]);
    expect(keygen.status).toBe(0);
    const recipient = /(age1[a-z0-9]+)/.exec(keygen.stdout)?.[1];
    expect(recipient).toBeTruthy();

    const dir = newOutDir();
    const out = join(dir, 'pulso-test.dump.age');
    const result = bash([script, out], {
      env: { DATABASE_URL: testUrl(), BACKUP_AGE_RECIPIENT: recipient },
      pathPrefix: [pg],
    });
    expect(result.stderr).not.toContain('Falta');
    expect(result.status).toBe(0);

    // el archivo es un age, no un dump en claro, y no quedan restos
    expect(readdirSync(dir)).toEqual(['pulso-test.dump.age']);
    expect(statSync(out).size).toBeGreaterThanOrEqual(1024);
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 21).toString('latin1')).toBe('age-encryption.org/v1');
    expect(bytes.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(bytes.includes(Buffer.from('Casa de mamá'))).toBe(false);

    // restaura en una base nueva
    const restoreDb = `pulso_restore_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = adminSql();
    await admin.unsafe(`CREATE DATABASE ${restoreDb}`);
    let restored: postgres.Sql | undefined;
    try {
      const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? '';
      const restoreUrl = withDatabase(adminUrl, restoreDb);
      const restore = bash(
        [
          '-c',
          'set -o pipefail; age -d -i "$KEY" "$FILE" | pg_restore --exit-on-error --dbname "$URL"',
        ],
        { env: { KEY: keyFile, FILE: out, URL: restoreUrl }, pathPrefix: [pg] },
      );
      expect(restore.stderr).toBe('');
      expect(restore.status).toBe(0);

      restored = postgres(restoreUrl, { max: 1, onnotice: () => {} });
      for (const table of TABLES) {
        const [original] = await sql.unsafe(`SELECT count(*)::int AS n FROM app.${table}`);
        const [copy] = await restored.unsafe(`SELECT count(*)::int AS n FROM app.${table}`);
        expect(original?.n, `app.${table} tiene filas de prueba`).toBeGreaterThan(0);
        expect(copy?.n, `app.${table} restaurada`).toBe(original?.n);
      }
      const [migrations] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      const [restoredMigrations] =
        await restored`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      expect(restoredMigrations?.n).toBe(migrations?.n);
      const [alias] = await restored`SELECT alias FROM app.follows`;
      expect(alias?.alias).toBe('Casa de mamá');
    } finally {
      await restored?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${restoreDb} WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);
});
