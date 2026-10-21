import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../db/client';
import type { AuthedDevice } from '../../env';
import { generateToken, sha256Hex } from '../../lib/crypto';
import * as repo from './repo';

/** Crea el dispositivo con un token firmado. El token solo existe en la respuesta: en la base queda su hash. */
export async function registerDevice(
  db: Db,
  appVersion: string,
  now: number,
  signingKey: string,
): Promise<{ deviceId: string; token: string }> {
  const deviceId = uuidv7();
  const token = await generateToken(signingKey);
  await repo.insertDevice(db, { id: deviceId, tokenHash: await sha256Hex(token), appVersion, now });
  return { deviceId, token };
}

export async function updateDevice(
  db: Db,
  device: AuthedDevice,
  patch: { pushToken?: string | null | undefined; appVersion?: string | undefined },
): Promise<void> {
  await repo.updateDevice(db, device.id, patch);
}

export async function deleteDevice(sql: postgres.Sql, device: AuthedDevice): Promise<void> {
  await repo.deleteDeviceAndHome(sql, device);
}
