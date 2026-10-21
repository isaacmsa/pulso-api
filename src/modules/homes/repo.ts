import { eq } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Db } from '../../db/client';
import { homes } from '../../db/schema';

/**
 * Asigna la casa al dispositivo y la crea, en **una sola consulta**. El `UPDATE` va primero y
 * solo con `home_id IS NULL`, y el `INSERT` solo corre si asignó: dos peticiones a la vez no
 * dejan una casa huérfana. La FK se comprueba al final de la sentencia, con la casa ya creada.
 * Devuelve `false` si el dispositivo ya tenía casa. Lanza `23505` si el `share_code` choca.
 */
export async function insertHomeForDevice(
  sql: postgres.Sql,
  home: { id: string; shareCode: string; alias: string; deviceId: string; now: number },
): Promise<boolean> {
  const rows = await sql`
    WITH assigned AS (
      UPDATE app.devices SET home_id = ${home.id}
      WHERE id = ${home.deviceId} AND home_id IS NULL
      RETURNING id
    )
    INSERT INTO app.homes (id, share_code, alias, status, status_since, created_at)
    SELECT ${home.id}, ${home.shareCode}, ${home.alias}, 'con_luz', ${home.now}, ${home.now}
    FROM assigned
    RETURNING id`;
  return rows.length === 1;
}

export async function updateHome(
  db: Db,
  homeId: string,
  patch: { alias?: string | undefined; mode?: 'base' | 'ups' | undefined },
): Promise<boolean> {
  const rows = await db.update(homes).set(patch).where(eq(homes.id, homeId)).returning({
    id: homes.id,
  });
  return rows.length === 1;
}
