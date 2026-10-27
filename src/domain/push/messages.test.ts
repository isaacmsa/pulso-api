import { describe, expect, it } from 'vitest';
import {
  confirmationMessage,
  lateSummaryMessage,
  returnMessage,
  returnWithoutDurationMessage,
  startMessage,
} from './messages';

/** Una hora de Caracas (UTC−4) en epoch ms. */
const VET = (h: number, min = 0, sec = 0) => Date.UTC(2026, 10, 1, h + 4, min, sec);

describe('textos de push', () => {
  it('los cinco textos de push son exactos', () => {
    const start = VET(18, 5);
    const end = VET(20, 15);

    expect(startMessage('Casa de mamá', start)).toEqual({
      title: 'Pulso',
      body: 'Se fue la luz en Casa de mamá (6:05 p. m.)',
    });
    expect(returnMessage('Casa de mamá', start, end)).toEqual({
      title: 'Pulso',
      body: 'Volvió la luz en Casa de mamá tras 2 h 10 min',
    });
    expect(lateSummaryMessage('Casa de mamá', start, end)).toEqual({
      title: 'Pulso',
      body: 'En Casa de mamá se fue la luz de 6:05 a 8:15 p. m. (2 h 10 min)',
    });
    expect(returnWithoutDurationMessage('Casa de mamá')).toEqual({
      title: 'Pulso',
      body: 'Volvió la luz en Casa de mamá',
    });
    expect(confirmationMessage(start, end)).toEqual({
      title: 'Pulso',
      body: '¿Se fue la luz de 6:05 a 8:15 p. m.?',
    });
  });

  it('la duración sale de los minutos que se muestran, no de los segundos', () => {
    // de 6:05:50 a 8:15:10 son 2 h 9 min 20 s, pero el texto dice "de 6:05 a 8:15"
    const start = VET(18, 5, 50);
    const end = VET(20, 15, 10);

    expect(returnMessage('Casa', start, end).body).toBe('Volvió la luz en Casa tras 2 h 10 min');
    expect(lateSummaryMessage('Casa', start, end).body).toBe(
      'En Casa se fue la luz de 6:05 a 8:15 p. m. (2 h 10 min)',
    );
  });

  it('un corte que cruza el mediodía lleva las dos horas completas', () => {
    expect(confirmationMessage(VET(11, 30), VET(12, 15)).body).toBe(
      '¿Se fue la luz de 11:30 a. m. a 12:15 p. m.?',
    );
  });
});
