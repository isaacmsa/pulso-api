import { expect, it } from 'vitest';
import { at, report, snap } from '../../src/testing/builders';
import { measureMechanisms } from './measure';

const events = [
  snap(0, true, true, { source: 'heartbeat' }),
  report(60, 'sin_luz'),
  snap(60.33, false, true, { source: 'charging_job' }),
  snap(72, false, false, { source: 'heartbeat' }),
  report(180, 'hay_luz'),
  snap(180.5, true, false, { source: 'charging_job' }),
];

it('mide el retraso de cada mecanismo frente a los botones', () => {
  const result = measureMechanisms(events);
  expect(result.truths).toEqual([{ start: at(60), end: at(180) }]);
  expect(result.rows).toContainEqual({
    source: 'charging_job',
    truthStart: at(60),
    startLatencyMs: at(60.33) - at(60),
    endLatencyMs: 30_000,
  });
  expect(result.rows).toContainEqual({
    source: 'heartbeat',
    truthStart: at(60),
    startLatencyMs: 12 * 60_000,
    endLatencyMs: null,
  });
  expect(result.bySource.charging_job).toEqual({
    hits: 1,
    total: 1,
    medianStartLatencyMs: at(60.33) - at(60),
  });
  expect(result.bySource.power_receiver).toEqual({ hits: 0, total: 1, medianStartLatencyMs: null });
});

it('un corte sin hay_luz queda sin fin', () => {
  expect(measureMechanisms([report(10, 'sin_luz')]).truths).toEqual([{ start: at(10), end: null }]);
});
