import { expect, it } from 'vitest';
import { at, confirmation, snap } from '../../testing/builders';
import { classify } from './classify';

it('classify aplica las confirmaciones sobre lo detectado', () => {
  expect(
    classify(
      [
        snap(0, true, true),
        snap(5, false, false),
        snap(125, true, true),
        confirmation(130, 5, false),
      ],
      { mode: 'base' },
    ),
  ).toEqual([
    { start: at(5), end: at(125), status: 'descartado', confidence: 'alta', confirmed: false },
  ]);
});
