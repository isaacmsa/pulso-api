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

partial="$out.partial"
trap 'status=$?; if [ "$status" -ne 0 ]; then rm -f "$partial"; fi' EXIT

umask 077
rm -f "$partial"

pg_dump --format=custom --schema=app --schema=drizzle --no-password "$DATABASE_URL" \
  | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$partial"

size=$(wc -c < "$partial" | tr -d '[:space:]')
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "El respaldo pesa $size bytes (menos de $MIN_BYTES): algo salió mal, se descarta." >&2
  exit 1
fi

mv "$partial" "$out"
echo "Respaldo cifrado: $out ($size bytes)"
