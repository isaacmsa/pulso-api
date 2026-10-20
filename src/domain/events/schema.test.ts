import { describe, expect, it } from 'vitest';
import { deviceEventSchema, eventBatchSchema } from './schema';

const diagnostics = {
  appVersion: '0.1.0',
  manufacturer: 'Xiaomi',
  model: 'Redmi Note 13',
  sdkInt: 35,
  standbyBucket: 10,
  ignoringBatteryOptimizations: true,
  pendingEvents: 0,
};
const snapshot = {
  kind: 'snapshot',
  id: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
  at: 1_793_570_400_000,
  source: 'heartbeat',
  plugged: true,
  onWifi: true,
  homeWifi: null,
  internet: true,
  interactive: false,
  batteryPct: 80,
};

describe('eventBatchSchema', () => {
  it('acepta un lote válido', () => {
    expect(
      eventBatchSchema.safeParse({ sentAt: 1_793_570_460_000, diagnostics, events: [snapshot] })
        .success,
    ).toBe(true);
  });
  it('acepta un lote vacío como latido', () => {
    expect(
      eventBatchSchema.safeParse({ sentAt: 1_793_570_460_000, diagnostics, events: [] }).success,
    ).toBe(true);
  });
  it('rechaza más de 200 eventos', () => {
    const events = Array.from({ length: 201 }, () => snapshot);
    expect(eventBatchSchema.safeParse({ sentAt: 1, diagnostics, events }).success).toBe(false);
  });
});

describe('deviceEventSchema', () => {
  it('rechaza una fuente desconocida', () => {
    expect(deviceEventSchema.safeParse({ ...snapshot, source: 'magic' }).success).toBe(false);
  });
  it('rechaza batteryPct fuera de 0..100', () => {
    expect(deviceEventSchema.safeParse({ ...snapshot, batteryPct: 101 }).success).toBe(false);
    expect(deviceEventSchema.safeParse({ ...snapshot, batteryPct: -1 }).success).toBe(false);
  });
  it('rechaza un id que no es uuid', () => {
    expect(deviceEventSchema.safeParse({ ...snapshot, id: 'abc' }).success).toBe(false);
  });
  it('distingue el tipo por kind', () => {
    const parsed = deviceEventSchema.parse({
      kind: 'report',
      id: snapshot.id,
      at: snapshot.at,
      value: 'sin_luz',
    });
    expect(parsed.kind).toBe('report');
  });
});
