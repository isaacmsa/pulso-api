import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runRetention } from '../../src/jobs/retention';
import { createHome, testDb, truncateAll } from './helpers';

const DAY = 86_400_000;
// Una "hora actual" fija y redonda: los tests restan días exactos.
const NOW = 1_800_000_000_000;

describe('retención diaria', () => {
  const { sql } = testDb();
  let queries = 0;
  const counted = testDb({ onQuery: () => queries++ });

  beforeEach(async () => {
    await truncateAll(sql);
    queries = 0;
  });

  afterAll(async () => {
    await sql.end();
    await counted.sql.end();
  });

  /** Un registro suelto: sin casa, sin follows y (por defecto) sin haber mandado nada. */
  async function createBareDevice({ createdAt, lastSeenAt = createdAt }: Times) {
    const id = randomUUID();
    await sql`
      INSERT INTO app.devices (id, token_hash, app_version, created_at, last_seen_at)
      VALUES (${id}, ${randomUUID()}, '1.0.0', ${createdAt}, ${lastSeenAt})`;
    return id;
  }

  async function insertEvent(deviceId: string, homeId: string, at: number) {
    await sql`
      INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
      VALUES (${deviceId}, ${randomUUID()}, ${homeId}, 'snapshot', ${at}, ${at}, '{}'::jsonb, ${at})`;
  }

  async function count(table: 'events' | 'devices' | 'homes' | 'follows' | 'outages') {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(`app.${table}`)}`;
    return row?.n ?? 0;
  }

  it('borra los eventos de más de 30 días y deja los demás', async () => {
    // el teléfono sigue activo: solo envejecen sus eventos
    const { homeId, deviceId } = await createHome(sql, { since: NOW - 40 * DAY });
    await sql`UPDATE app.devices SET last_seen_at = ${NOW} WHERE id = ${deviceId}`;
    await insertEvent(deviceId, homeId, NOW - 31 * DAY);
    await insertEvent(deviceId, homeId, NOW - 30 * DAY - 1);
    await insertEvent(deviceId, homeId, NOW - 30 * DAY); // justo en el límite: se queda
    await insertEvent(deviceId, homeId, NOW - 1 * DAY);

    const result = await runRetention(sql, NOW);

    expect(result.events).toBe(2);
    const left = await sql<{ at: number }[]>`SELECT at FROM app.events ORDER BY at`;
    expect(left.map((r) => Number(r.at))).toEqual([NOW - 30 * DAY, NOW - 1 * DAY]);
    // nada más se tocó
    expect(await count('devices')).toBe(1);
    expect(await count('homes')).toBe(1);
  });

  it('borra un dispositivo de 181 días sin actividad con su casa', async () => {
    const { homeId, deviceId } = await createHome(sql, { since: NOW - 300 * DAY });
    await sql`UPDATE app.devices SET last_seen_at = ${NOW - 181 * DAY} WHERE id = ${deviceId}`;
    await insertEvent(deviceId, homeId, NOW - 10 * DAY); // reciente, pero la casa se va igual
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, status, confidence, updated_at)
      VALUES (${randomUUID()}, ${homeId}, ${NOW - 200 * DAY}, 'cerrado', 'alta', ${NOW - 200 * DAY})`;
    // un seguidor activo de esa casa: pierde el follow, no el dispositivo
    const follower = await createBareDevice({ createdAt: NOW - 20 * DAY, lastSeenAt: NOW });
    await sql`
      INSERT INTO app.follows (home_id, follower_device_id, alias, created_at)
      VALUES (${homeId}, ${follower}, 'Casa de mamá', ${NOW - 20 * DAY})`;

    const result = await runRetention(sql, NOW);

    expect(result).toMatchObject({ inactiveDevices: 1, homes: 1, unusedDevices: 0 });
    expect(await count('homes')).toBe(0);
    expect(await count('events')).toBe(0);
    expect(await count('outages')).toBe(0);
    expect(await count('follows')).toBe(0);
    const left = await sql<{ id: string }[]>`SELECT id FROM app.devices`;
    expect(left.map((r) => r.id)).toEqual([follower]);
  });

  it('deja un dispositivo de 179 días sin actividad con su casa', async () => {
    const { deviceId } = await createHome(sql, { since: NOW - 300 * DAY });
    await sql`UPDATE app.devices SET last_seen_at = ${NOW - 179 * DAY} WHERE id = ${deviceId}`;

    const result = await runRetention(sql, NOW);

    expect(result).toEqual({
      events: 0,
      inactiveDevices: 0,
      homes: 0,
      unusedDevices: 0,
      oldOutages: 0,
    });
    expect(await count('devices')).toBe(1);
    expect(await count('homes')).toBe(1);
  });

  it('deja un dispositivo de exactamente 180 días sin actividad y un registro de exactamente 7 días', async () => {
    const { deviceId } = await createHome(sql, { since: NOW - 300 * DAY });
    await sql`UPDATE app.devices SET last_seen_at = ${NOW - 180 * DAY} WHERE id = ${deviceId}`;
    await createBareDevice({ createdAt: NOW - 7 * DAY });

    const result = await runRetention(sql, NOW);

    expect(result).toEqual({
      events: 0,
      inactiveDevices: 0,
      homes: 0,
      unusedDevices: 0,
      oldOutages: 0,
    });
    expect(await count('devices')).toBe(2);
    expect(await count('homes')).toBe(1);
  });

  it('borra un dispositivo que solo seguía casas y lleva 181 días sin actividad', async () => {
    const { homeId } = await createHome(sql, { since: NOW });
    const follower = await createBareDevice({
      createdAt: NOW - 300 * DAY,
      lastSeenAt: NOW - 181 * DAY,
    });
    await sql`
      INSERT INTO app.follows (home_id, follower_device_id, alias, created_at)
      VALUES (${homeId}, ${follower}, 'Casa de mamá', ${NOW - 250 * DAY})`;

    const result = await runRetention(sql, NOW);

    expect(result).toMatchObject({ inactiveDevices: 1, homes: 0 });
    expect(await count('follows')).toBe(0);
    expect(await count('homes')).toBe(1); // la casa seguida no es del seguidor
  });

  it('borra un registro de 8 días que nunca mandó nada', async () => {
    const id = await createBareDevice({ createdAt: NOW - 8 * DAY });

    const result = await runRetention(sql, NOW);

    expect(result).toEqual({
      events: 0,
      inactiveDevices: 0,
      homes: 0,
      unusedDevices: 1,
      oldOutages: 0,
    });
    const left = await sql`SELECT 1 FROM app.devices WHERE id = ${id}`;
    expect(left).toHaveLength(0);
  });

  it('deja un registro de 6 días que nunca mandó nada', async () => {
    await createBareDevice({ createdAt: NOW - 6 * DAY });

    const result = await runRetention(sql, NOW);

    expect(result.unusedDevices).toBe(0);
    expect(await count('devices')).toBe(1);
  });

  it('no borra un registro de 8 días que sigue una casa', async () => {
    const { homeId } = await createHome(sql, { since: NOW });
    const follower = await createBareDevice({ createdAt: NOW - 8 * DAY });
    await sql`
      INSERT INTO app.follows (home_id, follower_device_id, alias, created_at)
      VALUES (${homeId}, ${follower}, 'Casa de mamá', ${NOW - 7 * DAY})`;

    const result = await runRetention(sql, NOW);

    expect(result.unusedDevices).toBe(0);
    expect(await count('devices')).toBe(2);
    expect(await count('follows')).toBe(1);
  });

  it('no borra un registro de 8 días con casa o que ya mandó un latido', async () => {
    // con casa, aunque last_seen_at siga igual a created_at
    await createHome(sql, { since: NOW - 8 * DAY });
    // sin casa, pero el teléfono ya hizo una petición después de registrarse
    await createBareDevice({ createdAt: NOW - 8 * DAY, lastSeenAt: NOW - 8 * DAY + 1 });

    const result = await runRetention(sql, NOW);

    expect(result.unusedDevices).toBe(0);
    expect(await count('devices')).toBe(2);
    expect(await count('homes')).toBe(1);
  });

  it('un registro sin uso de más de 180 días cuenta una sola vez', async () => {
    await createBareDevice({ createdAt: NOW - 200 * DAY });

    const result = await runRetention(sql, NOW);

    expect(result.inactiveDevices + result.unusedDevices).toBe(1);
    expect(await count('devices')).toBe(0);
  });

  async function insertOutage(homeId: string, startedAt: number, status: string, endedAt?: number) {
    const id = randomUUID();
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, ended_at, status, confidence, updated_at)
      VALUES (${id}, ${homeId}, ${startedAt}, ${endedAt ?? null}, ${status}, 'alta', ${startedAt})`;
    return id;
  }

  const statusOf = async (id: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM app.outages WHERE id = ${id}`)[0]?.status;

  it('un corte abierto que empezó hace más de 30 días pasa a sin_datos', async () => {
    // A-042: sus eventos de inicio se borran en esta misma pasada
    const { homeId, deviceId } = await createHome(sql, { since: NOW - 40 * DAY });
    await sql`UPDATE app.devices SET last_seen_at = ${NOW} WHERE id = ${deviceId}`;
    const old = await insertOutage(homeId, NOW - 30 * DAY - 1, 'abierto');
    const recent = await insertOutage(homeId, NOW - 30 * DAY, 'abierto'); // en el límite: se queda
    const closed = await insertOutage(homeId, NOW - 35 * DAY, 'cerrado', NOW - 34 * DAY);

    const result = await runRetention(sql, NOW);

    expect(result.oldOutages).toBe(1);
    expect(await statusOf(old)).toBe('sin_datos');
    expect(await statusOf(recent)).toBe('abierto');
    expect(await statusOf(closed)).toBe('cerrado');
    const [row] = await sql<{ updatedAt: number }[]>`
      SELECT updated_at::float8 AS "updatedAt" FROM app.outages WHERE id = ${old}`;
    expect(row?.updatedAt).toBe(NOW);
  });

  it('un corte viejo de una casa que se borra en la misma pasada no se cuenta', async () => {
    const { homeId, deviceId } = await createHome(sql, { since: NOW - 300 * DAY });
    await sql`UPDATE app.devices SET last_seen_at = ${NOW - 181 * DAY} WHERE id = ${deviceId}`;
    await insertOutage(homeId, NOW - 200 * DAY, 'abierto');

    const result = await runRetention(sql, NOW);

    expect(result).toMatchObject({ homes: 1, oldOutages: 0 });
    expect(await count('outages')).toBe(0);
  });

  it('gasta una sola consulta', async () => {
    const { homeId, deviceId } = await createHome(sql, { since: NOW - 300 * DAY });
    await sql`UPDATE app.devices SET last_seen_at = ${NOW - 181 * DAY} WHERE id = ${deviceId}`;
    await insertEvent(deviceId, homeId, NOW - 40 * DAY);
    await createBareDevice({ createdAt: NOW - 8 * DAY });
    const alive = await createHome(sql, { since: NOW - 40 * DAY });
    await sql`UPDATE app.devices SET last_seen_at = ${NOW} WHERE id = ${alive.deviceId}`;
    await insertOutage(alive.homeId, NOW - 31 * DAY, 'abierto');
    queries = 0;

    const result = await runRetention(counted.sql, NOW);

    expect(queries).toBe(1);
    expect(result).toEqual({
      events: 1,
      inactiveDevices: 1,
      homes: 1,
      unusedDevices: 1,
      oldOutages: 1,
    });
  });
});

type Times = { createdAt: number; lastSeenAt?: number };
