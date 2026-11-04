import { z } from '@hono/zod-openapi'; // el z de Zod 4 con .openapi()

// Los `.openapi('Nombre')` vuelven cada esquema un componente de openapi.json: el cliente que
// genera la app tiene tipos con nombres estables en lugar de tipos anónimos por ruta.

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

export const snapshotEventSchema = z
  .object({
    kind: z.literal('snapshot'),
    id: z.uuid(), // uuid v7 del teléfono: clave de idempotencia
    at: epochMs, // reloj del teléfono
    source: snapshotSourceSchema,
    plugged: z.boolean(),
    onWifi: z.boolean(),
    homeWifi: z.boolean().nullable(),
    internet: z.boolean().nullable(),
    interactive: z.boolean().nullable(),
    // Opcional: las versiones de la app anteriores a la 0.2 no lo mandan. MIUI enciende la pantalla unos segundos al
    // desenchufar, así que en el modo UPS "bloqueado" distingue un corte de alguien que desenchufa para usar el teléfono.
    locked: z.boolean().nullable().optional(),
    batteryPct: z.number().int().min(0).max(100).nullable(),
  })
  .openapi('SnapshotEvent');

export const reportEventSchema = z
  .object({
    kind: z.literal('report'),
    id: z.uuid(),
    at: epochMs,
    value: z.enum(['hay_luz', 'fluctuando', 'sin_luz']),
  })
  .openapi('ReportEvent');

export const confirmationEventSchema = z
  .object({
    kind: z.literal('confirmation'),
    id: z.uuid(),
    at: epochMs,
    outageStart: epochMs, // el teléfono no conoce el id del servidor
    answer: z.boolean(),
  })
  .openapi('ConfirmationEvent');

export const deviceEventSchema = z
  .discriminatedUnion('kind', [snapshotEventSchema, reportEventSchema, confirmationEventSchema])
  .openapi('DeviceEvent');

export const diagnosticsSchema = z
  .object({
    appVersion: z.string(),
    manufacturer: z.string(),
    model: z.string(),
    sdkInt: z.number().int(),
    standbyBucket: z.number().int().nullable(), // UsageStatsManager.getAppStandbyBucket()
    ignoringBatteryOptimizations: z.boolean(),
    pendingEvents: z.number().int().min(0),
  })
  .openapi('Diagnostics');

export const eventBatchSchema = z
  .object({
    sentAt: epochMs, // para corregir el desfase de reloj
    diagnostics: diagnosticsSchema,
    events: z.array(deviceEventSchema).max(200), // vacío = solo latido
  })
  .openapi('EventBatch');

export type SnapshotSource = z.infer<typeof snapshotSourceSchema>;
export type SnapshotEvent = z.infer<typeof snapshotEventSchema>;
export type ReportEvent = z.infer<typeof reportEventSchema>;
export type ConfirmationEvent = z.infer<typeof confirmationEventSchema>;
export type DeviceEvent = z.infer<typeof deviceEventSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;
