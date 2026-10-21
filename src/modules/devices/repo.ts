import { eq } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Db } from '../../db/client';
import { devices } from '../../db/schema';

export async function insertDevice(
  db: Db,
  device: { id: string; tokenHash: string; appVersion: string; now: number },
): Promise<void> {
  await db.insert(devices).values({
    id: device.id,
    tokenHash: device.tokenHash,
    appVersion: device.appVersion,
    createdAt: device.now,
    lastSeenAt: device.now,
  });
}

/** Solo toca los campos que vengan (`undefined` se omite; `pushToken: null` lo borra). */
export async function updateDevice(
  db: Db,
  id: string,
  patch: { pushToken?: string | null | undefined; appVersion?: string | undefined },
): Promise<void> {
  await db.update(devices).set(patch).where(eq(devices.id, id));
}

/**
 * Borra la casa (si hay) y después el dispositivo, en una transacción. Las cascadas llevan los
 * eventos, cortes y seguidores de la casa, y los eventos y tickets del dispositivo.
 */
export async function deleteDeviceAndHome(
  sql: postgres.Sql,
  device: { id: string; homeId: string | null },
): Promise<void> {
  await sql.begin(async (tx) => {
    if (device.homeId) await tx`DELETE FROM app.homes WHERE id = ${device.homeId}`;
    await tx`DELETE FROM app.devices WHERE id = ${device.id}`;
  });
}
