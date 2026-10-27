import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, formatRange } from './format';

/** Una hora de Caracas (UTC−4) en epoch ms. */
const VET = (h: number, min = 0, day = 1, sec = 0) => Date.UTC(2026, 10, day, h + 4, min, sec);
const MIN = 60_000;

describe('formatClock', () => {
  it('formatClock da 6:05 p. m. y 12:00 m.', () => {
    expect(formatClock(VET(18, 5))).toBe('6:05 p. m.');
    expect(formatClock(VET(12, 0))).toBe('12:00 m.');
  });

  it('la medianoche es 12:00 a. m. y la mañana va con a. m.', () => {
    expect(formatClock(VET(0, 0))).toBe('12:00 a. m.');
    expect(formatClock(VET(0, 7))).toBe('12:07 a. m.');
    expect(formatClock(VET(9, 30))).toBe('9:30 a. m.');
    expect(formatClock(VET(11, 59))).toBe('11:59 a. m.');
  });

  it('pasado el mediodía va con p. m., y los segundos se ignoran', () => {
    expect(formatClock(VET(12, 1))).toBe('12:01 p. m.');
    expect(formatClock(VET(23, 59, 1, 59))).toBe('11:59 p. m.');
  });
});

describe('formatDuration', () => {
  it('formatDuration da 2 h 10 min, 45 min y 1 h', () => {
    expect(formatDuration(130 * MIN)).toBe('2 h 10 min');
    expect(formatDuration(45 * MIN)).toBe('45 min');
    expect(formatDuration(60 * MIN)).toBe('1 h');
  });

  it('redondea al minuto más cercano', () => {
    expect(formatDuration(44 * MIN + 31_000)).toBe('45 min');
    expect(formatDuration(25 * 60 * MIN)).toBe('25 h');
  });
});

describe('formatRange', () => {
  it('con la misma mitad del día, el a. m. o p. m. va una sola vez', () => {
    expect(formatRange(VET(18, 5), VET(20, 15))).toBe('6:05 a 8:15 p. m.');
    expect(formatRange(VET(6, 5), VET(8, 15))).toBe('6:05 a 8:15 a. m.');
  });

  it('si cambia la mitad del día o el día, van las dos completas', () => {
    expect(formatRange(VET(11, 30), VET(13, 15))).toBe('11:30 a. m. a 1:15 p. m.');
    expect(formatRange(VET(11, 30), VET(12, 0))).toBe('11:30 a. m. a 12:00 m.');
    expect(formatRange(VET(12, 0), VET(12, 40))).toBe('12:00 m. a 12:40 p. m.');
    expect(formatRange(VET(20, 0), VET(21, 0, 2))).toBe('8:00 p. m. a 9:00 p. m.');
  });
});
