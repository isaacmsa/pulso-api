#!/usr/bin/env bash
# Respaldo cifrado de los esquemas `app` y `drizzle` (A-030).
#
# Uso: DATABASE_URL=… BACKUP_AGE_RECIPIENT=age1… scripts/backup/dump.sh <salida.dump.age>
#
# `pg_dump -Fc` va directo por una tubería a `age`: el dump en claro nunca toca el disco. El
# archivo se escribe como `<salida>.partial` y solo se renombra si todo salió bien y pesa al menos
# 1 KB; ante cualquier falla se borra lo parcial y el script sale con error.
# Para restaurar hace falta la clave privada de Isaac, que nunca entra a GitHub:
#   age -d -i clave.txt pulso-AAAAMMDD.dump.age | pg_restore --dbname=<url> --exit-on-error
set -euo pipefail

MIN_BYTES=1024

out="${1:-}"
if [ -z "$out" ]; then
  echo "Uso: scripts/backup/dump.sh <salida.dump.age>" >&2
  exit 2
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "Falta DATABASE_URL (la cadena de conexión de la base a respaldar)." >&2
  exit 2
fi
if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
  echo "Falta BACKUP_AGE_RECIPIENT (la clave pública age que cifra el respaldo)." >&2
  exit 2
fi

# El repositorio es público: los logs de Actions los puede leer cualquiera. Si pg_dump falla al
# conectar, su error imprime el host del pooler y el usuario (`pulso_api.<ref>`). Antes de correrlo
# se enmascaran host, usuario y contraseña (también la forma sin decodificar del %xx).
mask_connection_parts() {
  local rest authority userinfo hostport user pass host part
  rest="${DATABASE_URL#*://}"
  authority="${rest%%[/?]*}"
  hostport="${authority##*@}"
  host="${hostport%%:*}"
  user=""
  pass=""
  if [ "$authority" != "$hostport" ]; then
    userinfo="${authority%@*}"
    user="${userinfo%%:*}"
    if [ "$userinfo" != "$user" ]; then pass="${userinfo#*:}"; fi
  fi
  for part in "$host" "$user" "$pass"; do
    if [ -n "$part" ]; then echo "::add-mask::$part"; fi
  done
}
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  mask_connection_parts
fi

partial="$out.partial"
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then rm -f "$partial"; fi
}
# Una cancelación o un timeout del job (INT/TERM) también deja la carpeta sin lo parcial.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
rm -f "$partial"

# La cadena va en argv: se acepta en un runner de un solo uso y sin otros usuarios (en los logs
# GitHub la enmascara por ser un secreto).
pg_dump --format=custom --schema=app --schema=drizzle --no-password "$DATABASE_URL" \
  | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$partial"

size=$(wc -c < "$partial" | tr -d '[:space:]')
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "El respaldo pesa $size bytes (menos de $MIN_BYTES): algo salió mal, se descarta." >&2
  exit 1
fi

mv "$partial" "$out"
echo "Respaldo cifrado: $out ($size bytes)"
