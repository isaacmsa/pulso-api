import { readFileSync } from 'node:fs';
import { classify } from '../../src/domain/detection/classify';
import type { DetectedOutage } from '../../src/domain/detection/types';
import { type DeviceEvent, deviceEventSchema } from '../../src/domain/events/schema';
import { spikeExportSchema } from '../../src/domain/spike/schema';
import { CARACAS_OFFSET_MS } from '../../src/domain/time/caracas';
import { detectorInput } from './detector-input';
import { measureMechanisms } from './measure';

// 'YYYY-MM-DD HH:mm' en hora de Caracas, sin Intl
const caracasLocal = (ts: number): string =>
  new Date(ts + CARACAS_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

const minutes = (ms: number): number => Math.round(ms / 60_000);

// Un corte abierto no tiene fin ni duración
const endLabel = (end: number | null): string => (end === null ? 'sin fin' : caracasLocal(end));
const durationMin = (start: number, end: number | null): number | null =>
  end === null ? null : minutes(end - start);

const path = process.argv[2];
if (!path) {
  console.error('Uso: pnpm spike:analyze <archivo.json>');
  process.exit(1);
}

const envelope = spikeExportSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
if (!envelope.success) {
  console.error('El exporte no tiene el formato esperado:');
  console.error(envelope.error.issues);
  process.exit(1);
}
const { exportedAt, diagnostics, events: rawEvents } = envelope.data;

console.log(`Exportado: ${caracasLocal(exportedAt)} (hora de Caracas)`);
console.log('Diagnóstico:');
console.log(diagnostics);

// Los eventos se validan uno por uno: uno malo no tumba el análisis
const events: DeviceEvent[] = [];
let invalid = 0;
for (const [index, raw] of rawEvents.entries()) {
  const parsed = deviceEventSchema.safeParse(raw);
  if (parsed.success) {
    events.push(parsed.data);
    continue;
  }
  invalid++;
  const issue = parsed.error.issues[0];
  console.warn(`Evento #${index} inválido: ${issue?.path.join('.')} ${issue?.message}`);
}
console.log(`Eventos: ${events.length} válidos, ${invalid} inválidos`);

const { truths, bySource } = measureMechanisms(events);
console.log('\nRetraso por mecanismo frente a los botones (hits/total, mediana en ms):');
console.table(bySource);

console.log('\nVerdades (botones sin_luz → hay_luz):');
console.table(
  truths.map((t) => ({
    inicio: caracasLocal(t.start),
    fin: endLabel(t.end),
    minutos: durationMin(t.start, t.end),
  })),
);

const outageRows = (outages: readonly DetectedOutage[]) =>
  outages.map((o) => ({
    inicio: caracasLocal(o.start),
    fin: endLabel(o.end),
    minutos: durationMin(o.start, o.end),
    estado: o.status,
    confianza: o.confidence,
    confirmado: o.confirmed,
  }));

// Sin botones: los botones son la verdad, así que el detector no puede verlos
for (const mode of ['base', 'ups'] as const) {
  console.log(`\nCortes detectados sin botones (modo ${mode}):`);
  console.table(outageRows(classify(detectorInput(events), { mode })));
}

// Referencia: lo que vería el servidor con los botones incluidos. No sirve para medir el detector
console.log('\nCon botones (modo base, solo referencia: los botones también son la verdad):');
console.table(outageRows(classify(events, { mode: 'base' })));
