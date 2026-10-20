import { z } from '@hono/zod-openapi';
import { diagnosticsSchema, epochMs } from '../events/schema';

// Diagnóstico del registrador nativo: lo de la API más lo que solo importa en el spike
export const nativeDiagnosticsSchema = diagnosticsSchema.extend({
  storedEvents: z.number().int().min(0),
  homeNetworkLearned: z.boolean(),
  armed: z.object({
    networkCallback: z.boolean(),
    heartbeat: z.boolean(),
    chargingJob: z.boolean(),
    foregroundService: z.boolean(),
  }),
});

// Formato que escribe Exporter.kt en pulso-app. Los eventos se validan uno por uno después.
export const spikeExportSchema = z.object({
  exportedAt: epochMs,
  diagnostics: nativeDiagnosticsSchema,
  events: z.array(z.unknown()),
});

export type SpikeExport = z.infer<typeof spikeExportSchema>;
