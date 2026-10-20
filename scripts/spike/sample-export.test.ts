import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify } from '../../src/domain/detection/classify';
import { deviceEventSchema } from '../../src/domain/events/schema';
import { spikeExportSchema } from '../../src/domain/spike/schema';
import { detectorInput } from './detector-input';

const raw = JSON.parse(
  readFileSync(new URL('../../test/fixtures/sample-export.json', import.meta.url), 'utf8'),
);

describe('exporte de ejemplo', () => {
  const envelope = spikeExportSchema.parse(raw);
  const events = envelope.events.map((e) => deviceEventSchema.parse(e));

  it('cumple el formato del exporte y cada evento el contrato', () => {
    expect(events).toHaveLength(21);
    expect(events.some((e) => e.kind === 'report')).toBe(true);
  });
  it('el detector se mide sin los botones', () => {
    expect(detectorInput(events).some((e) => e.kind === 'report')).toBe(false);
    expect(detectorInput(events)).toHaveLength(19);
  });
  it('sin botones, el modo base ve un corte de 18:10 a 20:10', () => {
    // 18:10 deja de cargar en el Wi-Fi de casa; 20:10 vuelve la corriente con el router arrancando
    expect(classify(detectorInput(events), { mode: 'base' })).toEqual([
      {
        start: Date.UTC(2026, 9, 28, 22, 10), // 28 de octubre, 6:10 p. m. en Caracas
        end: Date.UTC(2026, 9, 29, 0, 10), // 8:10 p. m.
        status: 'cerrado',
        confidence: 'alta',
        confirmed: null,
      },
    ]);
  });
});
