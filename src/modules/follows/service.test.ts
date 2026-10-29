import { describe, expect, it } from 'vitest';
import type { FollowItem } from './repo';
import { sortFollows } from './service';

const item = (homeId: string, alias: string): FollowItem => ({
  homeId,
  alias,
  status: { state: 'con_luz', since: 0, alias: 'Casa', openOutageStart: null },
});

describe('sortFollows', () => {
  it('ordena por alias como una persona: sin distinguir acentos ni mayúsculas', () => {
    const sorted = sortFollows([
      item('1', 'Zulia'),
      item('2', 'Álvaro'),
      item('3', 'abuela'),
      item('4', 'Beto'),
      item('5', 'árbol'),
    ]);
    expect(sorted.map((i) => i.alias)).toEqual(['abuela', 'Álvaro', 'árbol', 'Beto', 'Zulia']);
  });

  it('la ñ va después de la n', () => {
    const sorted = sortFollows([item('1', 'Ñoño'), item('2', 'Oso'), item('3', 'Nena')]);
    expect(sorted.map((i) => i.alias)).toEqual(['Nena', 'Ñoño', 'Oso']);
  });

  it('con el mismo alias (a menos de acentos) desempata por homeId, sin importar la entrada', () => {
    const rows = [item('c', 'Mamá'), item('a', 'mama'), item('b', 'MAMÁ')];
    const expected = ['a', 'b', 'c'];
    expect(sortFollows(rows).map((i) => i.homeId)).toEqual(expected);
    expect(sortFollows([...rows].reverse()).map((i) => i.homeId)).toEqual(expected);
  });

  it('no cambia la lista que recibe', () => {
    const rows = [item('1', 'b'), item('2', 'a')];
    sortFollows(rows);
    expect(rows.map((i) => i.alias)).toEqual(['b', 'a']);
  });
});
