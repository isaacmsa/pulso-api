// Solo Web Crypto: corre igual en Workers y en Node (los tests).

const SHARE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sin 0, 1, I, L ni O
const SHARE_CODE_LENGTH = 8;
// El mayor múltiplo de 31 que cabe en un byte: los bytes desde aquí se descartan para no sesgar.
const SHARE_CODE_BYTE_LIMIT = 256 - (256 % SHARE_CODE_ALPHABET.length);

/** Token del dispositivo: 32 bytes aleatorios en base64url sin relleno (43 caracteres). */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** SHA-256 en hexadecimal. Es lo único que se guarda del token. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Código para compartir la casa: 8 caracteres del alfabeto, por muestreo con rechazo. */
export function generateShareCode(): string {
  let code = '';
  while (code.length < SHARE_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SHARE_CODE_LENGTH * 2))) {
      if (byte >= SHARE_CODE_BYTE_LIMIT) continue;
      code += SHARE_CODE_ALPHABET[byte % SHARE_CODE_ALPHABET.length];
      if (code.length === SHARE_CODE_LENGTH) break;
    }
  }
  return code;
}
