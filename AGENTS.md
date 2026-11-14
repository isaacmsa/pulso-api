# Pulso · API

Backend de Pulso, la app Android que detecta sola los cortes de luz de una casa y avisa a la familia que la sigue. Es un Cloudflare Worker en TypeScript con Hono, sobre PostgreSQL en Supabase (conectado por Hyperdrive, con Drizzle). Cuesta USD 0 en sus planes gratuitos. Hace cuatro cosas:

- Recibe los eventos del teléfono, los guarda sin duplicar y los clasifica en cortes. Es la única implementación del clasificador.
- Decide y manda los push.
- Sirve `/privacidad`, `/borrar-datos` y `/c/:code`.
- Publica el contrato en `openapi.json`, del que la app genera su cliente.

La app vive en `pulso-app` (`~/projects/personal/mobile/pulso-app`). Ahí están el producto, la detección en el teléfono, la privacidad, Play Store y el roadmap maestro.

**Estado y fases:** el estado no se copia en este archivo. Vive en el tablero maestro, `~/projects/personal/mobile/pulso-app/docs/roadmap.md`, que cubre los dos repos, y cada fase tiene su archivo en `pulso-app/docs/phases/`. Si Isaac pide el estatus o dice «continúa la fase N», lee ese tablero y sigue su sección «Cómo se usa este tablero». Staging: `https://pulso-api-staging.isaac-mendozasa.workers.dev`.

## Comandos

Si cambian, actualiza esta tabla en el mismo commit.

| Tarea | Comando |
| --- | --- |
| Instalar dependencias | `pnpm install` |
| Lint, tipos y tests (los de integración necesitan `pnpm db:up` y un `.env` copiado de `.env.example`; `pnpm test` no corre los del respaldo) | `pnpm lint && pnpm typecheck && pnpm test` |
| Solo los tests unitarios (sin Docker) | `pnpm test:unit` |
| Tests del respaldo (`scripts/backup/`; necesitan `pnpm db:up`, `age` y `age-keygen` en el PATH, y usan el `pg_dump` 17 del contenedor si el del sistema no es 17) | `pnpm test:backup` |
| Analizar un exporte del registrador | `pnpm spike:analyze <archivo.json>` |
| Mover un exporte real en el tiempo para publicarlo en `test/fixtures/exports/` | `pnpm fixtures:shift <entrada.json> <salida.json>` |
| PostgreSQL local | `pnpm db:up` (`docker compose -f compose.dev.yaml up -d --wait`, puerto 54322) |
| API local | `cp .dev.vars.example .dev.vars` una vez; `pnpm dev` (`wrangler dev`, puerto 8787) |
| El Xiaomi contra la API local | `adb reverse tcp:8787 tcp:8787` |
| Generar y aplicar migraciones | `pnpm db:generate` / `pnpm db:migrate` (usa `DATABASE_URL`) |
| Regenerar los tipos del Worker tras cambiar `wrangler.jsonc` | `pnpm cf-typegen` |
| Regenerar y verificar el contrato | `pnpm openapi:export` / `pnpm openapi:check` |
| Deploy a staging | Cuando `ci` pasa en un push a `main` (`deploy.yml`, despliega el commit que probó `ci`); a mano: `pnpm deploy:staging` |
| Deploy a producción | Solo a mano: Actions > `deploy-production` > Run workflow (`ref` por defecto `main`), con la aprobación de Isaac en el Environment `production` (A-029) |
| Secreto en un entorno | `pnpm exec wrangler secret put <NOMBRE> --env staging` |
| Volver a la versión anterior | `pnpm exec wrangler rollback --env production` |

## Convenciones de este proyecto

- `src/domain/` es lógica pura: no importa Hono, `src/db/` ni `src/modules/`. Ahí viven el contrato de eventos, el clasificador y el tiempo de Caracas.
- `src/modules/<dominio>/` tiene `routes.ts` (rutas con `createRoute` de `@hono/zod-openapi`), `service.ts`, `repo.ts` (el único que toca la base) e `index.ts`.
- `z` siempre desde `@hono/zod-openapi`: el mismo esquema valida la petición y genera el OpenAPI.
- Las tablas viven en el esquema `app` de PostgreSQL, nunca en `public`.
- Errores con la forma `{ error: { code, message } }` y los códigos de `docs/api.md`.
- Todas las horas viajan y se guardan como epoch en milisegundos (`bigint`, A-007). America/Caracas (UTC−4 fijo) se aplica solo al resumir o mostrar.
- Código e identificadores en inglés; documentación, nombres de tests y textos de push en español venezolano llano.
- Commits en Conventional Commits.

## Reglas obligatorias

1. **No cambiar umbrales ni reglas del clasificador sin un test que reproduzca el caso**, idealmente un exporte real en `test/fixtures/`. El detector es el corazón del producto y falla en silencio.
2. **El clasificador es invariante a snapshots repetidos**, porque el teléfono solo sube cambios. Ninguna regla puede depender de ver un latido sin cambios.
3. **`device_at` nunca se toca**. La hora corregida va aparte en `at`, y la hora del servidor nunca se usa como hora del evento.
4. **La ingesta es idempotente por `(device_id, id)`** y atómica: va dentro de `app.ingest_batch` y `app.apply_outages`.
5. **Cuidar el presupuesto de consultas** (Hyperdrive gratis: 100.000 al día). El latido es una sola consulta y un lote no pasa de tres. Una ruta nueva que agregue consultas por petición lo justifica en su PR.
6. **El contrato en `/v1` solo cambia de forma aditiva.** Los lotes de `test/fixtures/` (uno por versión de la app publicada) tienen que seguir validando. `openapi.json` se regenera en el mismo commit, y el CI lo verifica. **En `/v1` no se agregan valores a un enum de respuesta** (D-023 de la app): la app valida las respuestas con el Zod generado, y una versión vieja de Play fallaría en esa ruta para siempre. Un estado nuevo va en un campo nuevo o en `/v2`. Los campos nuevos sí son compatibles.
7. **Los tokens se guardan solo como SHA-256** (del token completo, `<aleatorio>.<firma>`). Nunca en logs, respuestas (salvo la única vez en `POST /v1/devices`) ni en Sentry; por eso los registros de invocación de Workers Logs están apagados (`invocation_logs: false`, A-043), ya que podrían guardar el encabezado `Authorization`. **El Worker verifica la firma HMAC (`TOKEN_SIGNING_KEY`) antes de cualquier consulta**: un token sin firma válida responde 401 sin tocar la base (A-021).
8. **Nada de Pulso es accesible por la API REST de Supabase**: esquema `app`, RLS activado sin políticas, rol `pulso_api` dueño. Las claves `anon` y `service_role` no se usan.
9. **Límites por dispositivo, no por IP**, salvo en el registro y en las páginas públicas (CGNAT).
10. **Cada cambio de esquema es una migración nueva generada por `drizzle-kit`.** Nunca editar una ya aplicada. Las migraciones solo agregan, para que `wrangler rollback` funcione, y se aplican antes de desplegar el código.
11. **Ningún push se repite**: se marca en `outages` con `UPDATE … WHERE …_notified_at IS NULL RETURNING` antes de enviar.
12. **Secretos con `wrangler secret put`**; la cadena de conexión, solo en Hyperdrive y en los secretos de GitHub; en local, en `.dev.vars` (en `.gitignore`), que lleva también `TOKEN_SIGNING_KEY` (genéralo con `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`; rotarlo invalida todos los tokens). Nada secreto en `wrangler.jsonc`.
13. **Al terminar una tarea, márcala en el archivo de su fase (`pulso-app/docs/phases/`)** y sigue los pasos 3 y 4 de «Para trabajar una fase» del tablero (`pulso-app/docs/roadmap.md`): es lo que lee la siguiente sesión para saber por dónde seguir. Ese cambio va en un commit de `pulso-app` hecho junto al de este repo. Las decisiones internas se registran en `docs/decisions.md`.

## Trampas conocidas

- **Sentry solo con `SENTRY_DSN` y siempre limpio** (A-039): `src/index.ts` exporta `withOptionalSentry`, que envuelve con `withSentry` solo las invocaciones cuyo `env` trae el DSN. Hono atrapa los errores en `app.onError`, así que `withSentry` no los ve: `errorHandler` llama a `captureException` en cada 500. Todo lo que sale pasa por `scrubEvent` y `scrubBreadcrumb` (`src/lib/sentry.ts`). No cambies las opciones sin mantener esos filtros. La v11 del SDK no tiene `sendDefaultPii`: se usa `dataCollection`.
- **10 ms de CPU por petición en el plan gratuito**: la espera de la base no cuenta, pero el JSON y Zod sí. La clasificación corre solo sobre la ventana de la casa. Nada pesado en una petición.
- **Una conexión por petición**: el cliente de postgres.js se crea dentro del handler con `env.HYPERDRIVE.connectionString`, nunca a nivel de módulo.
- **`bigint` en postgres.js** llega como `string` por defecto. Configurar Drizzle con `mode: 'number'` en las columnas de horas (los epoch ms caben en un `number`).
- **Migraciones por el pooler de sesión** de Supabase (IPv4, puerto 5432, usuario `pulso_api.<ref>` con la contraseña de `pulso_api`, no la de `postgres`, A-017). Staging está en `us-west-2`: host `aws-1-us-west-2.pooler.supabase.com` (A-026); un host de otra región responde "tenant not found". Nunca por Hyperdrive ni por el pooler en modo transacción (puerto 6543). La conexión directa de Supabase gratis es solo IPv6 y los runners de GitHub no la alcanzan; Hyperdrive sí usa la directa.
- **Supabase pausa un proyecto tras 1 semana sin actividad.** Por eso el proyecto de producción se creó justo antes de usarlo (A-018); con latidos constantes no se pausa, pero sin tráfico sí. Staging también puede pausarse. Reactivarlo desde el panel.
- **Supabase gratis no incluye respaldos descargables**: el respaldo es el workflow nocturno propio (A-010).
- **Versiones viejas de la app** siguen mandando lotes durante meses. Un campo obligatorio nuevo las rompe.
- **`sql.json()` no sirve con el cliente de Drizzle**: `drizzle-orm/postgres-js` reemplaza los serializadores de `json` y `jsonb` (114 y 3802) del cliente compartido por unos que no hacen nada, y un objeto llega como objeto a postgres.js. Para un parámetro `jsonb` se pasa `JSON.stringify(...)`.
- **Expo Push**: el envío devuelve tickets y el resultado real llega después en los recibos. Un `DeviceNotRegistered` significa borrar el `push_token`.

## Documentación

- `docs/architecture.md`: stack, estructura, recorrido de un lote, seguridad de Supabase, entornos, CI, respaldos, costos y techos
- `docs/api.md`: endpoints, contrato de eventos, límites y reglas de push
- `docs/classifier.md`: reglas del clasificador y tests obligatorios
- `docs/data-model.md`: esquema de PostgreSQL, funciones de ingesta, retención y presupuesto de consultas
- `docs/decisions.md`: decisiones internas del backend (A-0xx)
- `docs/roadmap.md`: lo que el backend ya construyó y qué le toca en cada fase del tablero maestro
- `docs/runbook.md`: desplegar, volver atrás, restaurar, rotar secretos, reactivar un proyecto pausado y revisar el respaldo
- `docs/plans/`: planes de las fases 0 a 5 del backend (histórico)
- En `pulso-app/docs/`: `product.md`, `detection.md`, `security-privacy.md`, `decisions.md` (D-0xx), y el tablero `roadmap.md` con los archivos de `phases/`, donde vive el estado
