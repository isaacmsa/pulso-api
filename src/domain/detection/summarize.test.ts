import { expect, it } from 'vitest';
import { summarizeOutages } from './summarize';

const MIN = 60_000;
const VET = (y: number, m: number, d: number, h: number, min = 0) =>
  Date.UTC(y, m - 1, d, h + 4, min);

it('reparte un corte que cruza la medianoche de Caracas', () => {
  const outages = [
    { start: VET(2026, 11, 1, 23, 30), end: VET(2026, 11, 2, 1, 30), status: 'cerrado' as const },
  ];
  expect(
    summarizeOutages(outages, {
      from: VET(2026, 11, 1, 0),
      to: VET(2026, 11, 3, 0),
      now: VET(2026, 11, 3, 0),
    }),
  ).toEqual({
    totalMs: 120 * MIN,
    days: [
      { date: '2026-11-01', ms: 30 * MIN },
      { date: '2026-11-02', ms: 90 * MIN },
    ],
  });
});
it('un corte abierto cuenta hasta now', () => {
  const outages = [{ start: VET(2026, 11, 2, 10), end: null, status: 'abierto' as const }];
  expect(
    summarizeOutages(outages, {
      from: VET(2026, 11, 2, 0),
      to: VET(2026, 11, 3, 0),
      now: VET(2026, 11, 2, 12),
    }),
  ).toEqual({ totalMs: 120 * MIN, days: [{ date: '2026-11-02', ms: 120 * MIN }] });
});
it('descartados y sin_datos no suman', () => {
  const outages = [
    { start: VET(2026, 11, 2, 10), end: VET(2026, 11, 2, 11), status: 'descartado' as const },
    { start: VET(2026, 11, 2, 12), end: null, status: 'sin_datos' as const },
  ];
  expect(
    summarizeOutages(outages, {
      from: VET(2026, 11, 2, 0),
      to: VET(2026, 11, 3, 0),
      now: VET(2026, 11, 2, 23),
    }),
  ).toEqual({ totalMs: 0, days: [{ date: '2026-11-02', ms: 0 }] });
});
it('recorta al rango', () => {
  const outages = [
    { start: VET(2026, 10, 31, 22), end: VET(2026, 11, 1, 2), status: 'cerrado' as const },
  ];
  expect(
    summarizeOutages(outages, {
      from: VET(2026, 11, 1, 0),
      to: VET(2026, 11, 2, 0),
      now: VET(2026, 11, 2, 0),
    }),
  ).toEqual({ totalMs: 120 * MIN, days: [{ date: '2026-11-01', ms: 120 * MIN }] });
});
