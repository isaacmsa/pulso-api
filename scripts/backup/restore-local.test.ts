import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const restore = join(import.meta.dirname, 'restore-local.sh');
const dump = join(import.meta.dirname, 'dump.sh');

const work = mkdtempSync(join(tmpdir(), 'pulso-restore-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Un `psql` y un `pg_restore` falsos que solo dejan una marca: prueban que no se llamaron. */
function trapTools(): { dir: string; marker: string } {
  const dir = join(work, `trap-${randomUUID()}`);
  mkdirSync(dir);
  const marker = join(dir, 'called');
  for (const tool of ['psql', 'pg_restore']) {
    writeFileSync(join(dir, tool), `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  return { dir, marker };
}

/** Archivos que existen, para pasar las validaciones de argumentos. */
function dummyFiles(): { file: string; key: string } {
  const file = join(work, `${randomUUID()}.dump.age`);
  const key = join(work, `${randomUUID()}.key`);
  writeFileSync(file, 'x');
  writeFileSync(key, 'x');
  return { file, key };
}

describe('scripts/backup/restore-local.sh', () => {
  const { sql } = testDb();

  beforeAll(async () => {
    await truncateAll(sql);
  });

  afterAll(async () => {
    await truncateAll(sql);
    await sql.end();
  });

  it('sin el archivo y la identidad, sale con el uso', () => {
    const result = bash([restore]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Uso:');
  });

  it('con un servidor que no es local, no borra ni restaura nada', () => {
    const { dir, marker } = trapTools();
    const { file, key } = dummyFiles();
    const result = bash([restore, file, key], {
      env: { RESTORE_ADMIN_URL: 'postgres://postgres:x@db.example.com:5432/postgres' },
      pathPrefix: [dir],
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('localhost');
    expect(existsSync(marker)).toBe(false);
  });

  it('no acepta otra forma de elegir el servidor: query, varios hosts o variables PG*', () => {
    const { dir, marker } = trapTools();
    const { file, key } = dummyFiles();
    const local = 'postgres://postgres:postgres@localhost:54322/postgres';
    const cases: Record<string, string | undefined>[] = [
      { RESTORE_ADMIN_URL: `${local}?host=192.0.2.1` },
      { RESTORE_ADMIN_URL: `${local}?hostaddr=192.0.2.1` },
      {
        RESTORE_ADMIN_URL:
          'postgres://postgres:postgres@localhost:54322,db.example.com:5432/postgres',
      },
      { RESTORE_ADMIN_URL: 'postgres://postgres:postgres@localhost:54322' },
    ];
    for (const env of cases) {
      const result = bash([restore, file, key], { env, pathPrefix: [dir] });
      expect(result.status, JSON.stringify(env)).toBe(2);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('ignora PGHOST, PGHOSTADDR y PGSERVICE del entorno', () => {
    // un psql falso que deja en la marca las variables que vio
    const dir = join(work, `env-${randomUUID()}`);
    mkdirSync(dir);
    const seen = join(dir, 'seen');
    writeFileSync(
      join(dir, 'psql'),
      `#!/usr/bin/env bash\necho "\${PGHOST:-}|\${PGHOSTADDR:-}|\${PGSERVICE:-}" >> "${seen}"\nexit 1\n`,
    );
    chmodSync(join(dir, 'psql'), 0o755);
    const { file, key } = dummyFiles();
    const result = bash([restore, file, key], {
      env: { PGHOST: 'db.example.com', PGHOSTADDR: '192.0.2.1', PGSERVICE: 'prod' },
      pathPrefix: [dir],
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(seen, 'utf8').trim().split('\n')).toEqual(['||']);
  });

  it('nunca restaura sobre pulso_dev ni pulso_test', () => {
    const { dir, marker } = trapTools();
    const { file, key } = dummyFiles();
    for (const db of ['pulso_dev', 'pulso_test']) {
      const result = bash([restore, file, key], { env: { RESTORE_DB: db }, pathPrefix: [dir] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(db);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('restaura en una base nueva y cuenta las filas', async () => {
    requireAge();
    const pg = pgToolsDir(work);
    const { homeId, deviceId } = await createHome(sql, { since: 1_000 });
    for (const at of [2_000, 3_000]) {
      await sql`
        INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
        VALUES (${deviceId}, ${randomUUID()}, ${homeId}, 'snapshot', ${at}, ${at}, '{}'::jsonb, ${at})`;
    }

    const { keyFile, recipient } = newKeyPair(work);
    const file = join(work, 'pulso-test.dump.age');
    const dumped = bash([dump, file], {
      env: { DATABASE_URL: testUrl(), BACKUP_AGE_RECIPIENT: recipient },
      pathPrefix: [pg],
    });
    expect(dumped.status, dumped.stderr).toBe(0);

    const db = `pulso_restore_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = adminSql();
    try {
      const env = { RESTORE_ADMIN_URL: withDatabase(adminUrl(), 'postgres'), RESTORE_DB: db };
      const first = bash([restore, file, keyFile], { env, pathPrefix: [pg] });
      expect(first.status, first.stderr).toBe(0);
      const lines = first.stdout.split('\n');
      expect(lines).toContain(`Restaurado en ${db}:`);
      expect(lines).toContain('app.homes 1');
      expect(lines).toContain('app.devices 1');
      expect(lines).toContain('app.events 2');
      expect(lines).toContain('app.outages 0');
      expect(first.stdout).toMatch(/Tiempo total: \d+ s/);

      // una segunda corrida parte de cero: no duplica ni choca con lo anterior
      const second = bash([restore, file, keyFile], { env, pathPrefix: [pg] });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout.split('\n')).toContain('app.events 2');
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);
});
