import { expect, it } from 'vitest';
import { caracasDate, startOfCaracasDay, startOfCaracasWeek } from './caracas';

const VET = (y: number, m: number, d: number, h: number, min = 0) =>
  Date.UTC(y, m - 1, d, h + 4, min);

it('caracasDate usa la fecha local de Caracas', () => {
  expect(caracasDate(Date.UTC(2026, 10, 2, 3, 59))).toBe('2026-11-01');
});
it('startOfCaracasDay vuelve a la medianoche local', () => {
  expect(startOfCaracasDay(VET(2026, 11, 4, 12))).toBe(VET(2026, 11, 4, 0));
});
it('startOfCaracasWeek vuelve al lunes', () => {
  expect(startOfCaracasWeek(VET(2026, 11, 4, 12))).toBe(Date.UTC(2026, 10, 2, 4, 0));
});
