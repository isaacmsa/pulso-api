import type postgres from 'postgres';

export type FamilyHome = {
  alias: string;
  state: 'con_luz' | 'sin_luz' | 'sin_noticias';
  since: number;
  openOutageStart: number | null;
};

type Row = {
  alias: string;
  status: FamilyHome['state'];
  status_since: string;
  open_outage_start: string | null;
};

/** La casa de un código, con su estado y el inicio de su corte abierto: **una** consulta. */
export async function findHomeByShareCode(
  sql: postgres.Sql,
  shareCode: string,
): Promise<FamilyHome | null> {
  const [row] = await sql<Row[]>`
    SELECT h.alias, h.status, h.status_since, open_outage.started_at AS open_outage_start
    FROM app.homes h
    LEFT JOIN LATERAL (
      SELECT o.started_at FROM app.outages o
      WHERE o.home_id = h.id AND o.status = 'abierto'
      ORDER BY o.started_at DESC
      LIMIT 1
    ) open_outage ON true
    WHERE h.share_code = ${shareCode}`;
  if (!row) return null;
  return {
    alias: row.alias,
    state: row.status,
    since: Number(row.status_since),
    openOutageStart: row.open_outage_start === null ? null : Number(row.open_outage_start),
  };
}
