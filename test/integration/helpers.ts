import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { createDb } from '../../src/db/client';

/** Conexión a la base de test (`TEST_DATABASE_URL`), con el mismo cliente que usa el Worker. */
export function testDb(options?: { onQuery?: () => void }) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  return createDb(url, options);
}

/** Conexión de superusuario, solo para lo que exige serlo (p. ej. `SET ROLE anon`). */
export function adminSql() {
  const url = process.env.TEST_ADMIN_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_ADMIN_DATABASE_URL (ver .env.example)');
  return createDb(url).sql;
}

/** Crea con SQL directo una casa (en `con_luz` desde `since`) y el teléfono que la vigila. */
export async function createHome(
  sql: postgres.Sql,
  { mode = 'base', since = 0 }: { mode?: 'base' | 'ups'; since?: number } = {},
): Promise<{ homeId: string; deviceId: string }> {
  const homeId = randomUUID();
  const deviceId = randomUUID();
  const shareCode = randomUUID().slice(0, 8).toUpperCase();
  await sql`
    INSERT INTO app.homes (id, share_code, mode, status_since, created_at)
    VALUES (${homeId}, ${shareCode}, ${mode}, ${since}, ${since})`;
  await sql`
    INSERT INTO app.devices (id, token_hash, home_id, app_version, created_at, last_seen_at)
    VALUES (${deviceId}, ${randomUUID()}, ${homeId}, '1.0.0', ${since}, ${since})`;
  return { homeId, deviceId };
}

/** Vacía las seis tablas de Pulso. Las cascadas hacen el resto. */
export async function truncateAll(sql: postgres.Sql): Promise<void> {
  await sql`TRUNCATE app.push_tickets, app.follows, app.outages, app.events, app.devices, app.homes CASCADE`;
}
