// Solo Web Crypto: corre igual en Workers y en Node (los tests).

const SHARE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sin 0, 1, I, L ni O
const SHARE_CODE_LENGTH = 8;
// El mayor múltiplo de 31 que cabe en un byte: los bytes desde aquí se descartan para no sesgar.
const SHARE_CODE_BYTE_LIMIT = 256 - (256 % SHARE_CODE_ALPHABET.length);

const MIN_KEY_BYTES = 32;
const encoder = new TextEncoder();

function toBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

// Una sola entrada por isolate: la clave es la misma en todas las peticiones.
let cachedKey: { raw: string; key: Promise<CryptoKey> } | undefined;

/** La clave HMAC a partir de `TOKEN_SIGNING_KEY` (base64url de al menos 32 bytes). */
function signingKey(raw: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.raw === raw) return cachedKey.key;
  const bytes = typeof raw === 'string' ? fromBase64url(raw) : null;
  if (!bytes || bytes.length < MIN_KEY_BYTES) {
    throw new Error(`TOKEN_SIGNING_KEY debe ser base64url de al menos ${MIN_KEY_BYTES} bytes`);
  }
  const key = crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  cachedKey = { raw, key };
  return key;
}

/**
 * Token del dispositivo: `<aleatorio>.<firma>`. El aleatorio son 32 bytes en base64url sin relleno
 * (43 caracteres) y la firma es el HMAC-SHA256 de ese texto con `TOKEN_SIGNING_KEY` (otros 43).
 */
export async function generateToken(signingKeyRaw: string): Promise<string> {
  const key = await signingKey(signingKeyRaw);
  const random = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(random));
  return `${random}.${toBase64url(new Uint8Array(signature))}`;
}

/**
 * Comprueba la firma de un token sin tocar la base. La comparación es en tiempo constante
 * (`subtle.verify`). Una forma que no sea `<aleatorio>.<firma>` es `false`.
 */
export async function verifyToken(signingKeyRaw: string, token: string): Promise<boolean> {
  const key = await signingKey(signingKeyRaw);
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [random = '', signature = ''] = parts;
  const signatureBytes = fromBase64url(signature);
  if (!random || !signatureBytes?.length) return false;
  // 43 caracteres llevan 258 bits: sin esto, 3 escrituras más de la misma firma verificarían, y
  // cada una sería otro hash (otra consulta y otro cubo del límite)
  if (toBase64url(signatureBytes) !== signature) return false;
  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(random));
}

/** SHA-256 en hexadecimal. Es lo único que se guarda del token. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
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
