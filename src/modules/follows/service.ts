import type postgres from 'postgres';
import * as repo from './repo';

export type { FollowItem } from './repo';

/** Tope de casas que sigue un dispositivo (A-036). */
export const MAX_FOLLOWS = 20;

export function followHome(
  sql: postgres.Sql,
  deviceId: string,
  input: { code: string; alias: string },
  now: number,
): Promise<repo.FollowResult> {
  return repo.followHome(sql, { ...input, deviceId, now, max: MAX_FOLLOWS });
}

const byAlias = new Intl.Collator('es', { sensitivity: 'base' });

/**
 * Ordena por alias como lo haría una persona (sin distinguir acentos ni mayúsculas; la ñ después
 * de la n) y desempata por `homeId`. Son 20 filas como mucho (A-036), así que se hace aquí y no
 * con una collation de PostgreSQL, que en Supabase puede no existir.
 */
export function sortFollows(items: readonly repo.FollowItem[]): repo.FollowItem[] {
  return [...items].sort(
    (a, b) =>
      byAlias.compare(a.alias, b.alias) || (a.homeId < b.homeId ? -1 : a.homeId > b.homeId ? 1 : 0),
  );
}

export async function listFollows(sql: postgres.Sql, deviceId: string): Promise<repo.FollowItem[]> {
  return sortFollows(await repo.listFollows(sql, deviceId));
}
export const unfollowHome = repo.deleteFollow;
