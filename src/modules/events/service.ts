import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { classify } from '../../domain/detection/classify';
import { deriveHomeStatus } from '../../domain/detection/home-status';
import { reconcileOutages } from '../../domain/detection/reconcile';
import type { EventBatch } from '../../domain/events/schema';
import type { HomeStatus } from '../../domain/homes/schema';
import type { AuthedDevice } from '../../env';
import * as repo from './repo';

export type IngestResponse = { accepted: number; duplicated: number; status: HomeStatus };

type HomeDevice = { id: string; homeId: string; home: NonNullable<AuthedDevice['home']> };

/**
 * Guarda el lote, clasifica la ventana de la casa y aplica los cortes y el estado (docs/api.md,
 * "Qué hace POST /v1/events"). La auth (consulta 1) ya corrió; aquí van la 2 (`ingest_batch`) y,
 * solo si entró algún evento nuevo, la 3 (`apply_outages`).
 */
export async function ingestEvents(
  sql: postgres.Sql,
  device: HomeDevice,
  batch: EventBatch,
  receivedAt: number,
): Promise<IngestResponse> {
  const { state, since, alias, openOutageStart } = device.home;
  // estado de la auth: solo se responde tal cual si no entra ningún evento nuevo
  const current: HomeStatus = { state, since, alias, openOutageStart };
  if (batch.events.length === 0) return { accepted: 0, duplicated: 0, status: current };

  const ingested = await repo.ingestBatch(sql, {
    deviceId: device.id,
    homeId: device.homeId,
    events: batch.events,
    offsetMs: receivedAt - batch.sentAt,
    receivedAt,
  });
  const { accepted, duplicated } = ingested;
  if (accepted === 0) return { accepted, duplicated, status: current };

  const detected = classify(ingested.window, { mode: ingested.mode });
  const changes = reconcileOutages(ingested.outages, detected).map(
    (change): repo.IdentifiedChange =>
      change.op === 'insert' ? { op: 'insert', id: uuidv7(), outage: change.outage } : change,
  );
  // El estado previo sale de ingest_batch, no de la auth: otro lote pudo aplicar entre las dos
  // consultas, y la revisión garantiza que nadie aplica entre ingest_batch y apply_outages (A-023).
  const previous = ingested.status;
  const next = deriveHomeStatus(previous, detected, receivedAt);
  const unchanged = next.state === previous.state && next.since === previous.since;

  const applied = await repo.applyOutages(sql, {
    homeId: device.homeId,
    revision: ingested.revision,
    changes,
    status: unchanged ? null : next,
    now: receivedAt,
  });
  if (!applied.applied) {
    // otro lote de la misma casa ingirió entretanto y ya clasificó con estos eventos (A-016)
    console.log('apply_outages sin aplicar', {
      homeId: device.homeId,
      revision: ingested.revision,
    });
  }
  return { accepted, duplicated, status: applied.status };
}
