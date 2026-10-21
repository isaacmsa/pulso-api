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

/** Vacía las seis tablas de Pulso. Las cascadas hacen el resto. */
export async function truncateAll(sql: postgres.Sql): Promise<void> {
  await sql`TRUNCATE app.push_tickets, app.follows, app.outages, app.events, app.devices, app.homes CASCADE`;
}
