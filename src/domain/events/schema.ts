import { z } from '@hono/zod-openapi'; // el z de Zod 4 con .openapi()

export const epochMs = z.number().int().positive();

export const snapshotSourceSchema = z.enum([
  'network_callback',
  'heartbeat',
  'charging_job',
  'power_receiver',
  'transition_check',
  'app_open',
  'boot',
]);

export const snapshotEventSchema = z.object({
  kind: z.literal('snapshot'),
  id: z.uuid(), // uuid v7 del teléfono: clave de idempotencia
  at: epochMs, // reloj del teléfono
  source: snapshotSourceSchema,
  plugged: z.boolean(),
  onWifi: z.boolean(),
  homeWifi: z.boolean().nullable(),
  internet: z.boolean().nullable(),
  interactive: z.boolean().nullable(),
  batteryPct: z.number().int().min(0).max(100).nullable(),
});

export const reportEventSchema = z.object({
  kind: z.literal('report'),
  id: z.uuid(),
  at: epochMs,
  value: z.enum(['hay_luz', 'fluctuando', 'sin_luz']),
});

export const confirmationEventSchema = z.object({
  kind: z.literal('confirmation'),
  id: z.uuid(),
  at: epochMs,
  outageStart: epochMs, // el teléfono no conoce el id del servidor
  answer: z.boolean(),
});

export const deviceEventSchema = z.discriminatedUnion('kind', [
  snapshotEventSchema,
  reportEventSchema,
  confirmationEventSchema,
]);

export const diagnosticsSchema = z.object({
  appVersion: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  sdkInt: z.number().int(),
  standbyBucket: z.number().int().nullable(), // UsageStatsManager.getAppStandbyBucket()
  ignoringBatteryOptimizations: z.boolean(),
  pendingEvents: z.number().int().min(0),
});

export const eventBatchSchema = z.object({
  sentAt: epochMs, // para corregir el desfase de reloj
  diagnostics: diagnosticsSchema,
  events: z.array(deviceEventSchema).max(200), // vacío = solo latido
});

export type SnapshotSource = z.infer<typeof snapshotSourceSchema>;
export type SnapshotEvent = z.infer<typeof snapshotEventSchema>;
export type ReportEvent = z.infer<typeof reportEventSchema>;
export type ConfirmationEvent = z.infer<typeof confirmationEventSchema>;
export type DeviceEvent = z.infer<typeof deviceEventSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;
