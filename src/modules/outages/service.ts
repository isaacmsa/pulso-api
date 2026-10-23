import type postgres from 'postgres';
import { summarizeOutages } from '../../domain/detection/summarize';
import * as repo from './repo';

/** Los cortes y reportes del rango con el total y el reparto por día de Caracas. */
export async function outageHistory(
  sql: postgres.Sql,
  homeId: string,
  range: { from: number; to: number; now: number },
) {
  const { outages, reports } = await repo.findOutageHistory(sql, homeId, range);
  const { totalMs, days } = summarizeOutages(outages, range);
  return { items: outages, reports, totalMs, days };
}
