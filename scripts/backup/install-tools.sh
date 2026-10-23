#!/usr/bin/env bash
# Instala en un runner de GitHub Actions (Ubuntu) lo que necesita el respaldo: pg_dump y pg_restore
# 17 (del repositorio PGDG, porque el servidor de Supabase es 17 y un pg_dump más viejo se niega a
# respaldarlo) y `age`. Lo usan `backup.yml` y `ci.yml` (que corre los tests del respaldo).
set -euo pipefail

keyring=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
. /etc/os-release

sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o "$keyring" https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=$keyring] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq postgresql-client-17 age

# El runner trae otros clientes: este va primero en el PATH de los pasos siguientes.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo /usr/lib/postgresql/17/bin >> "$GITHUB_PATH"
fi
export PATH="/usr/lib/postgresql/17/bin:$PATH"
pg_dump --version
age --version
