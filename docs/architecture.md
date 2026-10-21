# Arquitectura del backend

**Qué responde este documento**

- Cómo está organizado `pulso-api`
- Qué pasa con un lote de eventos desde que llega hasta el push
- Entornos, CI, respaldos, costos y techos

El producto, la app y la detección en el teléfono se documentan en `pulso-app/docs/`. Las decisiones internas del backend están en `docs/decisions.md`.

## Stack

| Pieza | Elección |
| --- | --- |
| Runtime | Cloudflare Workers (plan gratuito, sin tarjeta), con `nodejs_compat` |
| Framework | Hono, con `@hono/zod-openapi` |
| Validación y contrato | Zod 4: el mismo esquema valida la petición y genera `openapi.json` |
| Base de datos | PostgreSQL en Supabase (plan gratuito), usado solo como base: sin Supabase Auth ni la API REST |
| Conexión | Hyperdrive (pool de conexiones y caché cerca de la base) con el driver `postgres` (postgres.js) |
| ORM y migraciones | Drizzle ORM; migraciones SQL de `drizzle-kit`, versionadas en `drizzle/` |
| Crons | Cron Triggers |
| Límite de peticiones | Binding Rate Limiting de Workers |
| Páginas | `/privacidad`, `/borrar-datos` y `/c/:code` con `hono/jsx`, en el mismo Worker |
| Errores | `@sentry/cloudflare` (desde la fase 4) |
| Tests | Vitest en Node: `domain/` puro, y repositorios y rutas (`app.request()`) contra un PostgreSQL real |

## Estructura

```text
pulso-api/
├─ src/
│  ├─ index.ts                  # createApp(): OpenAPIHono con rutas, /openapi.json, /docs, handler scheduled
│  ├─ env.ts                    # AppEnv: Bindings (HYPERDRIVE, RATE_LIMIT_*, secretos) y AuthedDevice
│  ├─ db/
│  │  ├─ schema.ts              # tablas de Drizzle en el esquema `app` (ver docs/data-model.md)
│  │  └─ client.ts              # postgres(env.HYPERDRIVE.connectionString) + drizzle, por petición
│  ├─ lib/crypto.ts             # token firmado con HMAC, SHA-256 y código para compartir (Web Crypto)
│  ├─ middleware/               # db (cliente por petición), auth (firma y hash del token), rate-limit,
│  │                            # errores { error: { code, message } }
│  ├─ domain/                   # lógica pura: sin Hono ni base de datos, testeada con Vitest en Node
│  │  ├─ events/schema.ts       # contrato de eventos y lotes
│  │  ├─ homes/schema.ts        # HomeStatus
│  │  ├─ detection/             # detectOutages, applyConfirmations, classify, reconcileOutages,
│  │  │                         # deriveHomeStatus, summarizeOutages
│  │  └─ time/caracas.ts        # días y semanas en America/Caracas
│  ├─ modules/<dominio>/        # devices, homes, events, outages, follows, push, pages
│  │  └─ routes.ts · service.ts · repo.ts · index.ts
│  ├─ jobs/                     # sweep (cada 5 min), retention (diario)
│  └─ testing/builders.ts       # snap(), report(), confirmation() para tests
├─ drizzle/                     # migraciones SQL generadas, incluidas las funciones de ingesta
├─ scripts/
│  ├─ export-openapi.ts         # escribe openapi.json
│  └─ spike/                    # analyze.ts y measure.ts: exportes del registrador
├─ test/
│  ├─ fixtures/                 # exportes reales y un lote por versión de la app publicada
│  └─ integration/              # repositorios y rutas contra PostgreSQL
├─ compose.dev.yaml             # PostgreSQL local, misma versión mayor que Supabase
├─ openapi.json                 # contrato generado y versionado
├─ wrangler.jsonc               # local y staging (production en la fase 2), Hyperdrive, Rate Limiting; crons en las fases 3 y 4
├─ worker-configuration.d.ts    # tipos de Workers generados con `pnpm cf-typegen` (versionados)
├─ tsconfig.worker.json         # src/ contra los tipos de Workers; tsconfig.json queda para Node (tests y scripts)
├─ docs/
├─ AGENTS.md
└─ CLAUDE.md
```

`domain/` no importa nada de `modules/` ni de `db/`. Los `routes.ts` validan con los esquemas y llaman al `service.ts`. El `service.ts` llama a `domain/` y al `repo.ts`, que es el único que toca la base. Como Hono y postgres.js corren igual en Node, la misma app se puede levantar con `@hono/node-server` si algún día hiciera falta salir de Workers.

## Qué pasa con un lote

```text
POST /v1/events (Bearer)
  → auth: SHA-256 del token → devices                        (consulta 1)
  → rate limit por dispositivo
  → eventBatchSchema (zod-openapi)
  → offset = receivedAt − sentAt; at = device_at + offset
  → si el lote viene vacío (latido): la consulta 1 ya actualizó last_seen_at → listo
  → si trae eventos: app.ingest_batch(device, home, eventos, offset, ahora)  (consulta 2, una transacción)
       inserta con ON CONFLICT (device_id, id) DO NOTHING y devuelve
       accepted, duplicated, la revisión, la ventana y los cortes de la casa
  → classify y reconcileOutages en el Worker (dominio puro)
  → app.apply_outages(home, revisión, cambios, estado, ahora)  (consulta 3, una transacción)
  ← { accepted, duplicated, status }

cron */5 min: push de inicio · sin noticias · sin_datos · recibos de Expo Push
cron diario (08:00 UTC = 4:00 a. m. en Caracas): retención
al cerrar un corte: push de regreso a seguidores y confirmación al teléfono de la casa (ctx.waitUntil)
```

La consulta 1 es un `UPDATE … SET last_seen_at = … WHERE token_hash = … RETURNING …`: autentica y registra el latido a la vez. El clasificador queda en TypeScript (el mismo de los tests). Solo la parte de SQL va en las funciones de PostgreSQL, y esas funciones se versionan en las migraciones.

## Entornos

| Entorno | Worker | Base de datos | Uso |
| --- | --- | --- | --- |
| Local | `wrangler dev` en `localhost:8787` | PostgreSQL de `compose.dev.yaml` (vía `localConnectionString` de Hyperdrive) | El Xiaomi llega con `adb reverse tcp:8787 tcp:8787` |
| Staging | `pulso-api-staging.<subdominio>.workers.dev` | Proyecto de Supabase `pulso-staging` | Dev builds y APK de prueba; `/docs` visible |
| Producción (desde la fase 2, A-018) | `pulso-api.<subdominio>.workers.dev` | Proyecto de Supabase `pulso` | Builds de Play |

Los dos proyectos de Supabase gratuitos se usan uno para staging y otro para producción. Ambos en la región `us-east-1`, la más cercana a Venezuela. Producción se crea en la fase 2, cuando empieza a recibir tráfico: un proyecto sin uso se pausa a la semana (A-018). Staging se pausa si pasa una semana sin uso; se reactiva desde el panel. Cada Hyperdrive va con la caché de consultas desactivada (A-015).

Secretos: la cadena de conexión vive en la configuración de Hyperdrive de cada entorno, no en el código. El resto se carga con `wrangler secret put --env <entorno>`; en local, en `.dev.vars` (en `.gitignore`). En la v1 son `TOKEN_SIGNING_KEY` (desde la fase 1; rotarla invalida todos los tokens, A-021), `EXPO_ACCESS_TOKEN` (desde la fase 3) y `SENTRY_DSN` (desde la fase 4). Staging y producción nunca comparten secretos ni contraseñas de base.

## Seguridad de Supabase

Supabase publica por defecto las tablas del esquema `public` en su API REST, accesible con la clave `anon`. Pulso no la usa, así que:

- Las tablas viven en el esquema `app`, que no se expone en la API REST.
- RLS está activado en todas las tablas, sin políticas: aunque alguien tuviera la clave `anon`, no lee nada.
- El Worker y las migraciones usan un rol propio (`pulso_api`), dueño del esquema `app`, nunca el rol `postgres`.
- Las claves `anon` y `service_role` no se usan en ningún lado, y la contraseña de la base solo está en Hyperdrive y en los secretos de GitHub.

## CI y despliegue

- **`ci.yml`**, en cada push y PR: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (con un PostgreSQL de `services:` de GitHub Actions), `pnpm openapi:check` (falla si `openapi.json` no está al día) y `wrangler types --check` (falla si `worker-configuration.d.ts` no coincide con `wrangler.jsonc`).
- **`deploy.yml`**: con cada push a `main`, aplica las migraciones a Supabase staging (`drizzle-kit migrate` por el pooler de sesión: IPv4, puerto 5432, usuario `pulso_api.<ref>`, A-017) y despliega el Worker. La conexión directa de Supabase gratis es solo IPv6 y los runners de GitHub no tienen IPv6; Hyperdrive sí usa la conexión directa. Producción se despliega a mano (`workflow_dispatch`, con aprobación en GitHub Environments), en el mismo orden: primero las migraciones, después el código. Secretos de GitHub: `CLOUDFLARE_API_TOKEN` (solo con permisos de Workers y Hyperdrive), `CLOUDFLARE_ACCOUNT_ID`, `STAGING_DATABASE_URL` y `PRODUCTION_DATABASE_URL`.
- **Rollback**: `wrangler rollback` vuelve a la versión anterior del Worker en segundos. Las migraciones solo agregan, así que el código anterior sigue funcionando con el esquema nuevo.
- **Antes de cambiar el contrato**: el cambio es aditivo, el test de contrato con `test/fixtures/` sigue en verde, se despliega el backend y recién después la app regenera su cliente.
- **Repo público**: GitHub Actions es gratis y sin límite de minutos, y el portafolio lo muestra.

## Respaldos y monitoreo

- **Respaldo propio**: el plan gratuito de Supabase no incluye respaldos descargables. Un workflow programado de GitHub Actions corre cada noche `pg_dump` de producción, cifra el resultado con `age` y lo guarda como artefacto privado (14 días de retención).
- **Restauración probada**: una vez al mes se restaura el último respaldo en el PostgreSQL local, y se anota en `docs/runbook.md` cuánto tardó.
- **Monitoreo**: Sentry para errores; un chequeo de uptime externo a `/health` cada 5 minutos (UptimeRobot, gratis, con aviso al teléfono; `/health` hace un `SELECT 1`); logs de Workers (`wrangler tail` y Workers Logs); y el uso diario de Hyperdrive y del disco de Supabase en sus paneles.
- **`docs/runbook.md`** (fase 5): desplegar, volver atrás, restaurar un respaldo, rotar secretos y la contraseña de la base, reactivar un proyecto pausado.

## Costos y techos

| Pieza | Servicio | Costo en v1 | Techo del plan gratuito |
| --- | --- | --- | --- |
| API, páginas y crons | Cloudflare Workers + Cron Triggers | USD 0 | 100.000 peticiones al día ≈ 900 teléfonos; 10 ms de CPU por petición |
| Conexión a la base | Hyperdrive | USD 0 | **100.000 consultas al día ≈ 600 teléfonos** (ver `docs/data-model.md`) |
| Base de datos | Supabase, 2 proyectos | USD 0 | 500 MB por proyecto ≈ 2.000 teléfonos con 30 días de eventos; 5 GB de transferencia |
| Límite de peticiones | Binding Rate Limiting | USD 0 | |
| Dominio | `*.workers.dev`, con HTTPS | USD 0 | |
| Push | Expo Push (FCM por debajo) | USD 0 | |
| Errores y uptime | Sentry y UptimeRobot | USD 0 | Eventos por mes |
| CI y respaldos | GitHub Actions en repo público | USD 0 | |

El primer techo es Hyperdrive (~600 teléfonos). El siguiente paso es Workers Paid (USD 5 al mes), que sube los límites de Workers y de Hyperdrive. Después vendría Supabase Pro (USD 25 al mes), cuando la base pase de 500 MB o haga falta respaldo gestionado. Confirmar los límites antes de lanzar: cambian.
