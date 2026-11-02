# Runbook de operación

Qué hacer en cada situación de operación de `pulso-api`. Los comandos corren desde la raíz del repo, con `wrangler` logueado en la cuenta de Cloudflare de Isaac. Ninguna sección pide escribir una contraseña en un archivo del repo ni en la línea de comandos: los secretos se pegan cuando `wrangler` o el panel los piden.

## Desplegar

### Staging

Es automático: un push a `main` dispara `ci`. Si `ci` termina en verde, `deploy.yml` hace esto con el commit que probó:

1. aplica las migraciones a Supabase staging por el pooler de sesión;
2. despliega `pulso-api-staging`;
3. comprueba que `/openapi.json` sea el del repo.

Si `ci` falla, el deploy se salta y staging sigue en la versión anterior.

A mano, solo si `deploy.yml` no sirve:

```bash
DATABASE_URL='<pooler de sesión de staging>' pnpm db:migrate
pnpm deploy:staging
```

### Producción

Solo a mano (A-029):

1. Actions > `deploy-production` > Run workflow. El `ref` es `main` por defecto.
2. Isaac aprueba el job en el Environment `production`.
3. El workflow comprueba:
   - que el commit sea de `main` y tenga `ci` en verde;
   - que el `id` de Hyperdrive de producción no sea el marcador;
   - que estén los secretos.
4. Aplica las migraciones, despliega `pulso-api` y comprueba `/health` y `/openapi.json`.

Después del deploy, revisa a mano:

- `https://pulso-api.isaac-mendozasa.workers.dev/health` responde 200;
- `/privacidad` carga;
- `pnpm exec wrangler deployments list --env production` muestra la versión nueva.

## Volver atrás

```bash
pnpm exec wrangler deployments list --env production
pnpm exec wrangler rollback --env production
```

`wrangler rollback` vuelve a la versión anterior del Worker en segundos y no toca la base. Funciona porque:

- las migraciones se aplican **antes** que el código;
- las migraciones solo agregan (regla 10), así que el código anterior sigue funcionando con el esquema nuevo.

Las migraciones nunca se revierten a mano.

Límites conocidos de un rollback:

- **Código anterior a `0004` con `0004` aplicada:** descarta los `sin_datos` sin pareja de la ventana. Además, solo saca una casa de `sin_noticias` con un lote que traiga eventos (A-038).
- **Volver al código de la fase 2:**
  - `apply_outages` (migración `0003`) sigue marcando avisos de regreso, de resumen y de confirmación que el código viejo no manda. Esos avisos se pierden, y la regla 11 impide reenviarlos.
  - El cron `*/5` llega a un `scheduled` que no lo conoce, y solo queda en el log.

Por eso un rollback no se deja puesto. Una de dos:

- se corrige y se despliega hacia adelante;
- o se acepta que esos avisos se pierden mientras dure.

## Restaurar un respaldo

`backup.yml` deja cada noche un artefacto `pulso-AAAAMMDD.dump.age`, que dura 14 días. Para restaurarlo en el PostgreSQL local:

1. Abre Docker Desktop y levanta la base con `pnpm db:up`.
2. Baja el artefacto más reciente: Actions > `backup` > la última corrida > Artifacts. Descomprime el `.zip`.
3. Corre el script con la clave privada `age` de Isaac. La clave no sale de su equipo:

   ```bash
   scripts/backup/restore-local.sh pulso-AAAAMMDD.dump.age ~/ruta/a/clave-age.txt
   ```

   El script hace esto:
   - descifra directo a `pg_restore`;
   - restaura en la base nueva `pulso_restore`, que borra y crea de cero en cada corrida;
   - imprime las filas de cada tabla y el tiempo total.

   Solo acepta un servidor en `localhost`, y nunca toca `pulso_dev` ni `pulso_test`.
4. Revisa los conteos con `psql postgres://postgres:postgres@localhost:54322/pulso_restore`.

Se restaura una vez al mes. Cada restauración se anota aquí:

| Fecha | Artefacto | Tamaño | Duración | Notas |
| --- | --- | --- | --- | --- |
| (pendiente, B8) | | | | |

Restaurar **en producción** no es un procedimiento de rutina. Si se pierde la base:

1. Se crea un proyecto nuevo.
2. Se le aplican las migraciones.
3. Se restaura con `pg_restore --data-only`.
4. Se apunta el Hyperdrive de producción al proyecto nuevo.

Se decide con Isaac en el momento.

## Rotar secretos

### `TOKEN_SIGNING_KEY`

Rotarla invalida **todos** los tokens: cada teléfono recibe 401 y se registra de nuevo (A-021). Solo se rota si la clave se filtró.

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
pnpm exec wrangler secret put TOKEN_SIGNING_KEY --env production
```

Genera la clave con `openssl` y pégala cuando `wrangler` la pida. Para staging, lo mismo con `--env staging` y otra clave. Staging y producción nunca comparten secretos.

### `EXPO_ACCESS_TOKEN` y `SENTRY_DSN`

1. Crea el valor nuevo en Expo o en Sentry.
2. Cárgalo con `pnpm exec wrangler secret put <NOMBRE> --env production`.
3. Revoca el valor viejo en el panel.

Ninguno de los dos invalida tokens de los teléfonos.

### Contraseña de `pulso_api`

El orden importa: entre el paso 1 y el 2, el Worker no puede consultar la base.

1. **Supabase:** cambia la contraseña del rol desde el editor SQL del proyecto (`ALTER ROLE pulso_api WITH PASSWORD '…'`). La contraseña de `postgres` no se toca.
2. **Hyperdrive:** en el panel de Cloudflare, abre la configuración del entorno y pon la contraseña nueva en el origen. Hazlo enseguida.
3. **GitHub:** actualiza el secreto de la cadena del pooler de sesión, con la contraseña nueva:
   - `PRODUCTION_DATABASE_URL`, en los Environments `production` y `backup`;
   - o `STAGING_DATABASE_URL`, en el repositorio.
4. **Comprobación:** pide `/health` (200) y corre `backup` a mano.

### `CLOUDFLARE_API_TOKEN`

1. Crea un token nuevo con permisos solo de Workers y Hyperdrive.
2. Cámbialo en los secretos del repositorio.
3. Revoca el viejo.

## Reactivar un proyecto pausado

Supabase pausa un proyecto gratuito tras 1 semana sin actividad. Producción recibe latidos constantes y no debería pausarse. Staging sí se pausa.

Síntomas de un proyecto pausado:

- `/health` responde 500 con `internal_error`;
- `deploy.yml` falla en "Aplicar migraciones".

Para reactivarlo:

1. En el panel de Supabase, abre el proyecto y elige "Restore project". Tarda unos minutos.
2. Comprueba que `/health` responda 200. Si el deploy falló, vuelve a correr `deploy.yml` o haz un push.

## Revisar que el respaldo sigue corriendo

GitHub desactiva los workflows programados de un repositorio público tras 60 días sin actividad. El respaldo puede detenerse sin aviso, así que una vez al mes:

1. En Actions > `backup`, comprueba que corrió anoche y terminó en verde.
2. Si aparece desactivado, elige "Enable workflow" y córrelo a mano con Run workflow.
3. Comprueba que el artefacto más reciente existe y pesa más de 1 KB.

Aprovecha esa revisión para la restauración mensual (ver arriba).

## Si un deploy falla en "Aplicar migraciones"

- **"tenant not found":** el host del pooler es de otra región. Staging está en `us-west-2` (`aws-1-us-west-2.pooler.supabase.com`, A-026) y producción en `us-east-1`.
- **"password authentication failed":**
  - el usuario tiene que ser `pulso_api.<ref>`, con la contraseña de `pulso_api` y no la de `postgres` (A-017);
  - si la contraseña se rotó, falta el paso 3 de "Contraseña de `pulso_api`".
- **Timeout o "network unreachable":** la cadena usa la conexión directa (solo IPv6) en vez del pooler de sesión, o usa el puerto 6543 (modo transacción). Tiene que ser el puerto 5432 del pooler.
- **Proyecto pausado:** ver "Reactivar un proyecto pausado".

El código no se desplegó, así que la versión anterior sigue sirviendo. Corrige la causa y vuelve a correr el workflow.
