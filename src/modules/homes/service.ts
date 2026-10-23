import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../db/client';
import type { HomeStatus } from '../../domain/homes/schema';
import type { AuthedDevice } from '../../env';
import { generateShareCode } from '../../lib/crypto';
import * as repo from './repo';

const SHARE_CODE_ATTEMPTS = 3;

function isShareCodeCollision(err: unknown): boolean {
  const { code, constraint_name: constraint } = err as {
    code?: string;
    constraint_name?: string;
  };
  return code === '23505' && (constraint?.includes('share_code') ?? false);
}

/**
 * Crea la casa del dispositivo con un `share_code` nuevo. Si el código choca, reintenta hasta 3
 * veces en total; después lanza el error. Devuelve `null` si el dispositivo ya tenía casa.
 */
export async function createHomeForDevice(
  sql: postgres.Sql,
  device: Pick<AuthedDevice, 'id'>,
  alias: string,
  now: number,
  newShareCode: () => string = generateShareCode,
): Promise<{ homeId: string; shareCode: string } | null> {
  const homeId = uuidv7();
  for (let attempt = 1; ; attempt++) {
    const shareCode = newShareCode();
    try {
      const created = await repo.insertHomeForDevice(sql, {
        id: homeId,
        shareCode,
        alias,
        deviceId: device.id,
        now,
      });
      return created ? { homeId, shareCode } : null;
    } catch (err) {
      if (!isShareCodeCollision(err) || attempt >= SHARE_CODE_ATTEMPTS) throw err;
    }
  }
}

/**
 * Cambia el código de la casa y quita a todos sus seguidores (A-041). Reintenta si el código
 * choca, hasta 3 veces en total; después lanza el error. Devuelve `null` si la casa ya no existe.
 */
export async function regenerateShareCode(
  sql: postgres.Sql,
  homeId: string,
  newShareCode: () => string = generateShareCode,
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const shareCode = newShareCode();
    try {
      return (await repo.replaceShareCode(sql, homeId, shareCode)) ? shareCode : null;
    } catch (err) {
      if (!isShareCodeCollision(err) || attempt >= SHARE_CODE_ATTEMPTS) throw err;
    }
  }
}

/** `false` si la casa ya no existe. */
export function updateHome(
  db: Db,
  homeId: string,
  patch: { alias?: string | undefined; mode?: 'base' | 'ups' | undefined },
): Promise<boolean> {
  return repo.updateHome(db, homeId, patch);
}

/** El estado sale de la consulta de auth: no cuesta otra consulta. */
export function homeStatus(device: AuthedDevice): HomeStatus | null {
  if (!device.home) return null;
  const { state, since, alias, openOutageStart } = device.home;
  return { state, since, alias, openOutageStart };
}
