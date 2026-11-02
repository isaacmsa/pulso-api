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
import {
  adminUrl,
  bash,
  newKeyPair,
  pgToolsDir,
  requireAge,
  testUrl,
  withDatabase,
} from './test-support';

// Los requisitos (PostgreSQL de `pnpm db:up`, `age`, herramientas 17) están en `test-support.ts`.
const script = join(import.meta.dirname, 'dump.sh');
const TABLES = ['homes', 'devices', 'events', 'outages', 'follows', 'push_tickets'] as const;

const work = mkdtempSync(join(tmpdir(), 'pulso-backup-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Un `pg_dump` falso (carpeta para el PATH) cuyo cuerpo es el script dado. */
function fakePgDump(body: string): string {
  const dir = join(work, `fake-${randomUUID()}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'pg_dump'), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, 'pg_dump'), 0o755);
  return dir;
}

const newRecipient = (): string => newKeyPair(work).recipient;

function newOutDir(): string {
  const dir = join(work, randomUUID());
  mkdirSync(dir);
  return dir;
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
    const pg = pgToolsDir(work);
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
    const pg = pgToolsDir(work);

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
    const { keyFile, recipient } = newKeyPair(work);

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
      const restoreUrl = withDatabase(adminUrl(), restoreDb);
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
