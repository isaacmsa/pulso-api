import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DetectedOutage } from '../../src/domain/detection/types';
import type { DeviceEvent } from '../../src/domain/events/schema';
import type { HomeStatus } from '../../src/domain/homes/schema';
import { at, confirmation, report, snap } from '../../src/testing/builders';
import { createHome, testDb, truncateAll } from './helpers';

type StoredOutage = DetectedOutage & { id: string };

type IngestResult = {
  accepted: number;
  duplicated: number;
  revision: number;
  mode: 'base' | 'ups';
  status: { state: HomeStatus['state']; since: number };
  window: DeviceEvent[];
  outages: StoredOutage[];
};

type ApplyResult = { applied: boolean; status: HomeStatus };

type Change = { op: 'insert' | 'update'; id: string; outage: DetectedOutage };

const NOW = at(2000);

describe('funciones de ingesta', () => {
  const { sql } = testDb();

  beforeEach(async () => {
    await truncateAll(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function ingest(
    home: { homeId: string; deviceId: string },
    events: DeviceEvent[],
    offsetMs = 0,
  ): Promise<IngestResult> {
    const [row] = await sql<{ result: IngestResult }[]>`
      SELECT app.ingest_batch(
        ${home.deviceId}, ${home.homeId}, ${JSON.stringify(events)}, ${offsetMs}, ${NOW}
      ) AS result`;
    if (!row) throw new Error('ingest_batch no devolvió nada');
    return row.result;
  }

  async function apply(
    homeId: string,
    revision: number,
    changes: Change[],
    status: { state: HomeStatus['state']; since: number } | null,
  ): Promise<ApplyResult> {
    const [row] = await sql<{ result: ApplyResult }[]>`
      SELECT app.apply_outages(
        ${homeId}, ${revision}, ${JSON.stringify(changes)},
        ${status === null ? null : JSON.stringify(status)}, ${NOW}
      ) AS result`;
    if (!row) throw new Error('apply_outages no devolvió nada');
    return row.result;
  }

  /** Un lote ya procesado: `ingest_batch` y el `apply_outages` que le sigue (sin cambios). */
  async function ingestApplied(
    home: { homeId: string; deviceId: string },
    events: DeviceEvent[],
  ): Promise<IngestResult> {
    const result = await ingest(home, events);
    await apply(home.homeId, result.revision, [], null);
    return result;
  }

  async function storeOutage(homeId: string, outage: DetectedOutage): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, ended_at, status, confidence, confirmed, updated_at)
      VALUES (${id}, ${homeId}, ${outage.start}, ${outage.end}, ${outage.status},
              ${outage.confidence}, ${outage.confirmed}, ${outage.start})`;
    return id;
  }

  async function outagesOf(homeId: string) {
    return sql<(StoredOutage & { updatedAt: number })[]>`
      SELECT id, started_at::float8 AS start, ended_at::float8 AS "end", status, confidence,
             confirmed, updated_at::float8 AS "updatedAt"
      FROM app.outages WHERE home_id = ${homeId} ORDER BY started_at`;
  }

  async function homeRow(homeId: string) {
    const [row] = await sql<{ status: string; since: number; revision: number }[]>`
      SELECT status, status_since::float8 AS since, ingest_revision::float8 AS revision
      FROM app.homes WHERE id = ${homeId}`;
    return row;
  }

  async function pendingAnchorOf(homeId: string) {
    const [row] = await sql<{ pendingAnchor: number | null }[]>`
      SELECT pending_anchor::float8 AS "pendingAnchor" FROM app.homes WHERE id = ${homeId}`;
    return row?.pendingAnchor;
  }

  it('devuelve el estado actual de la casa, también en un reintento', async () => {
    const home = await createHome(sql, { since: at(-60) });
    await sql`UPDATE app.homes SET status = 'sin_luz', status_since = ${at(-10)} WHERE id = ${home.homeId}`;
    const events = [snap(0, true, true)];

    const first = await ingest(home, events);
    expect(first.status).toEqual({ state: 'sin_luz', since: at(-10) });

    const again = await ingest(home, events);
    expect(again).toMatchObject({ accepted: 0, status: { state: 'sin_luz', since: at(-10) } });
  });

  it('inserta y cuenta duplicados', async () => {
    const home = await createHome(sql);
    const events = [snap(0, true, true), snap(5, false, true), snap(6, false, false)];

    const first = await ingest(home, events);
    expect(first).toMatchObject({ accepted: 3, duplicated: 0 });
    // el Worker clasificó y aplicó: no queda nada pendiente
    await apply(home.homeId, first.revision, [], null);

    const second = await ingest(home, events);
    expect(second).toMatchObject({ accepted: 0, duplicated: 3, window: [], outages: [] });

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.events WHERE home_id = ${home.homeId}`;
    expect(count?.n).toBe(3);
  });

  it('device_at queda intacto y at se corrige', async () => {
    const home = await createHome(sql);
    const event = snap(0, true, true);

    const result = await ingest(home, [event], 90_000);

    const [row] = await sql<{ deviceAt: number; at: number; receivedAt: number }[]>`
      SELECT device_at::float8 AS "deviceAt", at::float8 AS at, received_at::float8 AS "receivedAt"
      FROM app.events WHERE device_id = ${home.deviceId} AND id = ${event.id}`;
    expect(row).toEqual({ deviceAt: event.at, at: event.at + 90_000, receivedAt: NOW });
    expect(result.window).toEqual([{ ...event, at: event.at + 90_000 }]);
  });

  it('la ventana empieza en el último snapshot powered anterior', async () => {
    const home = await createHome(sql);
    const stored = [snap(0, true, true), snap(5, false, true), snap(6, false, false)];
    await ingestApplied(home, stored);

    const latest = snap(100, true, true);
    const result = await ingest(home, [latest]);

    expect(result.window).toEqual([...stored, latest]);
    expect(result.window[0]?.at).toBe(at(0));
  });

  it('la ventana llega hasta el corte que confirma una confirmación tardía', async () => {
    const home = await createHome(sql);
    const stored = [
      snap(0, true, true),
      snap(5, false, true),
      snap(6, false, false),
      snap(125, true, true),
    ];
    await ingestApplied(home, stored);
    const outage: DetectedOutage = {
      start: at(5),
      end: at(125),
      status: 'cerrado',
      confidence: 'alta',
      confirmed: null,
    };
    const outageId = await storeOutage(home.homeId, outage);

    const late = confirmation(3000, 5, false);
    const result = await ingest(home, [late]);

    expect(result.outages).toEqual([{ id: outageId, ...outage }]);
    expect(result.window).toEqual([...stored, late]);
  });

  it('la ventana incluye el corte abierto aunque sea viejo', async () => {
    const home = await createHome(sql);
    const stored = [snap(0, true, true), snap(5, false, true), snap(6, false, false)];
    await ingestApplied(home, stored);
    const outage: DetectedOutage = {
      start: at(5),
      end: null,
      status: 'abierto',
      confidence: 'alta',
      confirmed: null,
    };
    const outageId = await storeOutage(home.homeId, outage);

    const result = await ingest(home, [snap(1400, true, false)]);

    expect(result.outages).toEqual([{ id: outageId, ...outage }]);
    expect(result.window[0]?.at).toBe(at(0));
  });

  it('la ventana arranca antes del corte manual abierto aunque haya un snapshot powered repetido dentro', async () => {
    const home = await createHome(sql);
    const armed = snap(0, true, true);
    const sinLuz = report(1, 'sin_luz');
    await ingestApplied(home, [armed]);
    await ingestApplied(home, [sinLuz]);
    // un snapshot powered repetido no cierra el corte manual (solo lo cierra entrar en powered)
    await ingestApplied(home, [snap(2, true, true, { internet: false })]);
    await storeOutage(home.homeId, {
      start: at(1),
      end: null,
      status: 'abierto',
      confidence: 'manual',
      confirmed: null,
    });

    const result = await ingest(home, [snap(30, true, true)]);

    expect(result.window[0]?.at).toBe(at(0));
    expect(result.window).toContainEqual(sinLuz);
  });

  it('la ventana empieza en el snapshot powered más reciente antes del ancla, no en uno más viejo', async () => {
    const home = await createHome(sql);
    await ingestApplied(home, [
      snap(-30, false, false),
      snap(-20, true, true),
      snap(0, true, true),
      snap(5, false, true),
    ]);

    const result = await ingest(home, [snap(100, true, true)]);

    expect(result.window[0]?.at).toBe(at(0));
  });

  it('si el lote empieza con un snapshot powered, la ventana arranca en el powered anterior', async () => {
    const home = await createHome(sql);
    await ingestApplied(home, [snap(0, true, true)]);

    const result = await ingest(home, [
      snap(100, true, true, { internet: false }),
      snap(105, false, true),
    ]);

    expect(result.window[0]?.at).toBe(at(0));
  });

  it('un evento atrasado dentro de un corte manual cerrado arranca la ventana antes del corte', async () => {
    const home = await createHome(sql);
    const armed = snap(0, true, true);
    const sinLuz = report(1, 'sin_luz');
    await ingestApplied(home, [armed]);
    await ingestApplied(home, [sinLuz]);
    await ingestApplied(home, [snap(2, true, true, { internet: false })]);
    await ingestApplied(home, [report(60, 'hay_luz')]);
    const outage: DetectedOutage = {
      start: at(1),
      end: at(60),
      status: 'cerrado',
      confidence: 'manual',
      confirmed: null,
    };
    const outageId = await storeOutage(home.homeId, outage);

    // llega tarde: sin el corte, la ventana empezaría en el snapshot powered del minuto 2
    const result = await ingest(home, [snap(30, false, false)]);

    expect(result.window[0]?.at).toBe(at(0));
    expect(result.window).toContainEqual(sinLuz);
    expect(result.outages).toEqual([{ id: outageId, ...outage }]);
  });

  it('deja fuera de la ventana los cortes sin_datos', async () => {
    const home = await createHome(sql);
    await ingestApplied(home, [snap(0, true, true)]);
    await storeOutage(home.homeId, {
      start: at(5),
      end: null,
      status: 'sin_datos' as DetectedOutage['status'],
      confidence: 'alta',
      confirmed: null,
    });

    const result = await ingest(home, [snap(10, false, false)]);

    expect(result.outages).toEqual([]);
  });

  it('sube la revisión solo si aceptó algo o quedó algo sin clasificar', async () => {
    const home = await createHome(sql);
    const events = [snap(0, true, true)];

    const first = await ingest(home, events);
    expect(first.revision).toBe(1);
    await apply(home.homeId, first.revision, [], null);

    const second = await ingest(home, events);
    expect(second.revision).toBe(1);
    expect((await homeRow(home.homeId))?.revision).toBe(1);
  });

  it('guarda el ancla del lote como pendiente y apply_outages la borra', async () => {
    const home = await createHome(sql);
    expect(await pendingAnchorOf(home.homeId)).toBeNull();

    const { revision } = await ingest(home, [snap(0, true, true), snap(5, false, false)]);
    expect(await pendingAnchorOf(home.homeId)).toBe(at(0));

    await apply(home.homeId, revision, [], null);
    expect(await pendingAnchorOf(home.homeId)).toBeNull();
  });

  it('apply_outages con una revisión vieja deja el ancla pendiente', async () => {
    const home = await createHome(sql);
    const first = await ingest(home, [snap(0, true, true)]);
    await ingest(home, [snap(5, false, false)]);

    const result = await apply(home.homeId, first.revision, [], null);

    expect(result.applied).toBe(false);
    expect(await pendingAnchorOf(home.homeId)).toBe(at(0));
  });

  it('el ancla pendiente más vieja gana sobre la del lote nuevo', async () => {
    const home = await createHome(sql);
    const original = [snap(0, true, true), snap(5, false, true), snap(6, false, false)];
    await ingest(home, original);
    const powered = snap(125, true, true);
    await ingest(home, [powered]);

    // sin el ancla pendiente, la ventana empezaría en el snapshot powered del minuto 125
    const latest = snap(200, true, true, { internet: false });
    const result = await ingest(home, [latest]);

    expect(result.window).toEqual([...original, powered, latest]);
    expect(await pendingAnchorOf(home.homeId)).toBe(at(0));
  });

  it('un reintento sin apply sube la revisión y devuelve la ventana desde el ancla pendiente', async () => {
    const home = await createHome(sql);
    const events = [snap(0, true, true), snap(5, false, false)];
    const first = await ingest(home, events);

    const retry = await ingest(home, events);

    expect(retry).toMatchObject({ accepted: 0, duplicated: 2, revision: first.revision + 1 });
    expect(retry.window).toEqual(events);
    expect(await homeRow(home.homeId)).toMatchObject({ revision: first.revision + 1 });
  });

  it('un reintento reproduce la misma ventana aunque el ancla caiga dentro de un corte guardado', async () => {
    const home = await createHome(sql);
    await ingestApplied(home, [snap(0, true, true)]);
    await ingestApplied(home, [report(1, 'sin_luz')]);
    await ingestApplied(home, [snap(2, true, true, { internet: false })]);
    await ingestApplied(home, [report(60, 'hay_luz')]);
    await storeOutage(home.homeId, {
      start: at(1),
      end: at(60),
      status: 'cerrado',
      confidence: 'manual',
      confirmed: null,
    });
    const late = [snap(30, false, false)];
    const first = await ingest(home, late);
    // se guarda el ancla del evento, no la ampliada por el corte: el corte se vuelve a leer
    expect(await pendingAnchorOf(home.homeId)).toBe(at(30));

    const retry = await ingest(home, late);

    expect(retry.accepted).toBe(0);
    expect(retry.window).toEqual(first.window);
    expect(retry.outages).toEqual(first.outages);
    expect(retry.window[0]?.at).toBe(at(0));
  });

  it('apply_outages inserta, actualiza y cambia el estado', async () => {
    const home = await createHome(sql);
    const { revision } = await ingest(home, [snap(0, true, true)]);
    const existingId = await storeOutage(home.homeId, {
      start: at(5),
      end: null,
      status: 'abierto',
      confidence: 'alta',
      confirmed: null,
    });
    const closed: DetectedOutage = {
      start: at(5),
      end: at(125),
      status: 'cerrado',
      confidence: 'alta',
      confirmed: null,
    };
    const opened: DetectedOutage = {
      start: at(200),
      end: null,
      status: 'abierto',
      confidence: 'media',
      confirmed: null,
    };
    const newId = randomUUID();

    const result = await apply(
      home.homeId,
      revision,
      [
        { op: 'insert', id: newId, outage: opened },
        { op: 'update', id: existingId, outage: closed },
      ],
      { state: 'sin_luz', since: opened.start },
    );

    expect(result).toEqual({
      applied: true,
      status: { state: 'sin_luz', since: opened.start, alias: 'Casa', openOutageStart: at(200) },
      notify: [], // nadie a quien avisar: sin seguidores y el teléfono sin push_token
    });
    expect(await outagesOf(home.homeId)).toEqual([
      { id: existingId, ...closed, updatedAt: NOW },
      { id: newId, ...opened, updatedAt: NOW },
    ]);
    expect(await homeRow(home.homeId)).toMatchObject({ status: 'sin_luz', since: opened.start });
  });

  it('apply_outages ignora una revisión vieja', async () => {
    const home = await createHome(sql, { since: at(0) });
    await ingest(home, [snap(0, true, true)]);
    await ingest(home, [snap(5, false, false)]);
    const before = await outagesOf(home.homeId);

    const result = await apply(
      home.homeId,
      1,
      [
        {
          op: 'insert',
          id: randomUUID(),
          outage: {
            start: at(5),
            end: null,
            status: 'abierto',
            confidence: 'alta',
            confirmed: null,
          },
        },
      ],
      { state: 'sin_luz', since: at(5) },
    );

    expect(result).toEqual({
      applied: false,
      status: { state: 'con_luz', since: at(0), alias: 'Casa', openOutageStart: null },
      notify: [],
    });
    expect(await outagesOf(home.homeId)).toEqual(before);
    expect(await homeRow(home.homeId)).toEqual({ status: 'con_luz', since: at(0), revision: 2 });
  });

  it('apply_outages es atómica', async () => {
    const home = await createHome(sql, { since: at(0) });
    const { revision } = await ingest(home, [snap(0, true, true)]);
    const existingId = await storeOutage(home.homeId, {
      start: at(5),
      end: null,
      status: 'abierto',
      confidence: 'alta',
      confirmed: null,
    });
    const before = await outagesOf(home.homeId);

    await expect(
      apply(
        home.homeId,
        revision,
        [
          {
            op: 'insert',
            id: randomUUID(),
            outage: {
              start: at(200),
              end: null,
              status: 'abierto',
              confidence: 'alta',
              confirmed: null,
            },
          },
          {
            op: 'update',
            id: existingId,
            outage: {
              start: at(5),
              end: at(125),
              status: 'roto' as DetectedOutage['status'],
              confidence: 'alta',
              confirmed: null,
            },
          },
        ],
        { state: 'sin_luz', since: at(200) },
      ),
    ).rejects.toMatchObject({ code: '23514' });

    expect(await outagesOf(home.homeId)).toEqual(before);
    expect(await homeRow(home.homeId)).toEqual({ status: 'con_luz', since: at(0), revision });
  });
});
