#!/usr/bin/env bash
# Restaura un respaldo cifrado de `backup.yml` en el PostgreSQL local (tarea 4.5, A-030).
#
# Uso: scripts/backup/restore-local.sh <archivo.dump.age> <identidad-age>
#
# Descifra con `age` directo por una tubería a `pg_restore`: el dump en claro nunca toca el disco.
# Restaura en una base nueva, `pulso_restore` (o `RESTORE_DB`), que borra y crea de cero en cada
# corrida; nunca toca `pulso_dev` ni `pulso_test`. Al final imprime las filas de cada tabla y el
# tiempo total. Sin dueños ni permisos (`--no-owner --no-privileges`): los roles de Supabase no
# existen en local, y para revisar los datos no hacen falta.
#
# `RESTORE_ADMIN_URL` es el superusuario del contenedor de `pnpm db:up`; solo se acepta un host
# local, para que el borrado de la base nunca llegue a otro servidor.
set -euo pipefail

file="${1:-}"
identity="${2:-}"
if [ -z "$file" ] || [ -z "$identity" ]; then
  echo "Uso: scripts/backup/restore-local.sh <archivo.dump.age> <identidad-age>" >&2
  exit 2
fi
for path in "$file" "$identity"; do
  if [ ! -r "$path" ]; then
    echo "No se puede leer $path." >&2
    exit 2
  fi
done

admin_url="${RESTORE_ADMIN_URL:-postgres://postgres:postgres@localhost:54322/postgres}"
db="${RESTORE_DB:-pulso_restore}"
if ! [[ "$db" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "RESTORE_DB tiene que ser un nombre simple (minúsculas, números y _)." >&2
  exit 2
fi
if [ "$db" = "pulso_dev" ] || [ "$db" = "pulso_test" ] || [ "$db" = "postgres" ]; then
  echo "RESTORE_DB no puede ser $db: el script borra esa base." >&2
  exit 2
fi
rest="${admin_url#*://}"
authority="${rest%%[/?]*}"
hostport="${authority##*@}"
host="${hostport%%:*}"
if [ "$host" != "localhost" ] && [ "$host" != "127.0.0.1" ]; then
  echo "RESTORE_ADMIN_URL tiene que apuntar a localhost (es $host)." >&2
  exit 2
fi
# La misma cadena con la base nueva en lugar de la de administración
db_url="${admin_url%%\?*}"
db_url="${db_url%/*}/$db"

started=$(date +%s)

psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname "$admin_url" \
  --command "DROP DATABASE IF EXISTS $db WITH (FORCE)" \
  --command "CREATE DATABASE $db"

age --decrypt --identity "$identity" "$file" \
  | pg_restore --exit-on-error --no-owner --no-privileges --dbname "$db_url"

echo "Restaurado en $db:"
# Una línea `app.<tabla> <filas>` por tabla: \gexec corre cada SELECT que arma la primera consulta
psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --tuples-only --no-align --field-separator ' ' \
  --dbname "$db_url" <<'SQL'
SELECT format('SELECT %L, count(*) FROM app.%I', 'app.' || c.relname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
ORDER BY c.relname
\gexec
SQL

echo "Tiempo total: $(($(date +%s) - started)) s"
