import { expect, it } from 'vitest';
import { deviceEventSchema } from '../events/schema';
import { spikeExportSchema } from './schema';

const diagnostics = {
  appVersion: '0.1.0-spike',
  manufacturer: 'Xiaomi',
  model: 'Redmi Note 12',
  sdkInt: 34,
  standbyBucket: 10,
  ignoringBatteryOptimizations: true,
  pendingEvents: 0,
  storedEvents: 2,
  homeNetworkLearned: true,
  armed: { networkCallback: true, heartbeat: true, chargingJob: true, foregroundService: false },
};

const validSnapshot = {
  kind: 'snapshot',
  id: '01939c1e-7a3b-7c00-8000-000000000001',
  at: 1_793_570_400_000,
  source: 'heartbeat',
  plugged: true,
  onWifi: true,
  homeWifi: true,
  internet: true,
  interactive: null,
  batteryPct: 80,
};

it('acepta un exporte con un evento inválido y lo deja para validar aparte', () => {
  const invalid = { ...validSnapshot, id: '01939c1e-7a3b-7c00-8000-000000000002', batteryPct: -1 };
  const envelope = spikeExportSchema.safeParse({
    exportedAt: 1_793_580_000_000,
    diagnostics,
    events: [validSnapshot, invalid],
  });
  expect(envelope.success).toBe(true);
  expect(deviceEventSchema.safeParse(validSnapshot).success).toBe(true);
  expect(deviceEventSchema.safeParse(invalid).success).toBe(false);
});
