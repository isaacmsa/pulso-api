import { describe, expect, it } from 'vitest';
import { generateShareCode, generateToken, sha256Hex, verifyToken } from './crypto';

const KEY = Buffer.from('una-clave-de-prueba-de-32-bytes!!').toString('base64url');
const OTHER_KEY = Buffer.from('otra-clave-de-prueba-de-32-bytes!').toString('base64url');

describe('crypto', () => {
  it('el token es <aleatorio>.<firma>, cada uno de 43 caracteres base64url', async () => {
    expect(await generateToken(KEY)).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  });

  it('dos tokens seguidos son distintos', async () => {
    expect(await generateToken(KEY)).not.toBe(await generateToken(KEY));
  });

  it('verifyToken acepta un token propio', async () => {
    expect(await verifyToken(KEY, await generateToken(KEY))).toBe(true);
  });

  it('verifyToken rechaza una firma alterada, otra clave y formas incompletas', async () => {
    const token = await generateToken(KEY);
    const [random = '', sig = ''] = token.split('.');
    const flipped = `${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
    expect(await verifyToken(KEY, `${random}.${flipped}`)).toBe(false);
    expect(await verifyToken(OTHER_KEY, token)).toBe(false);
    expect(await verifyToken(KEY, random)).toBe(false);
    expect(await verifyToken(KEY, `${random}.`)).toBe(false);
    expect(await verifyToken(KEY, `${random}.${sig}.${sig}`)).toBe(false);
    expect(await verifyToken(KEY, '')).toBe(false);
  });

  it('una clave de menos de 32 bytes se rechaza al firmar y al verificar', async () => {
    const short = Buffer.from('corta').toString('base64url');
    await expect(generateToken(short)).rejects.toThrow('TOKEN_SIGNING_KEY');
    await expect(verifyToken(short, 'x.y')).rejects.toThrow('TOKEN_SIGNING_KEY');
  });

  it('sha256Hex es estable', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('el código usa solo el alfabeto', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateShareCode()).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    }
  });
});
