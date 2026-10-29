import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVENTS_RETENTION_MS } from './retention';

describe('retención', () => {
  it('la migración 0004 usa los mismos 30 días que EVENTS_RETENTION_MS', () => {
    const sql = readFileSync(new URL('../../drizzle/0004_staleness.sql', import.meta.url), 'utf8');
    const literals = sql.match(/started_at >= p_now - \d+/g) ?? [];
    // el literal de la comparación con `started_at` aparece en los dos CTE de `mark_stale`
    expect(literals).toHaveLength(2);
    for (const literal of literals)
      expect(literal).toBe(`started_at >= p_now - ${EVENTS_RETENTION_MS}`);
    expect(sql).toContain(String(EVENTS_RETENTION_MS));
    expect(EVENTS_RETENTION_MS).toBe(2_592_000_000);
  });
});
