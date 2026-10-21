/** `Authorization: Bearer <aleatorio>.<firma>`: 43 caracteres base64url cada parte. */
const BEARER = /^Bearer +([A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43})$/i;

/** El token completo de un `Authorization` bien formado, o `undefined`. */
export function bearerToken(header: string | undefined): string | undefined {
  return BEARER.exec(header ?? '')?.[1];
}
