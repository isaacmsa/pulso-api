import { describe, expect, it } from 'vitest';
import { generateShareCode, generateToken, sha256Hex } from './crypto';

describe('crypto', () => {
  it('el token tiene 43 caracteres base64url', () => {
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('dos tokens seguidos son distintos', () => {
    expect(generateToken()).not.toBe(generateToken());
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
