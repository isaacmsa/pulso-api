# Pulso · API

Backend de Pulso, la app Android que detecta sola los cortes de luz de una casa y avisa a la familia que la sigue. Es un Cloudflare Worker en TypeScript con Hono, sobre PostgreSQL en Supabase (conectado por Hyperdrive, con Drizzle). Cuesta USD 0 en sus planes gratuitos. Hace cuatro cosas:

- Recibe los eventos del teléfono, los guarda sin duplicar y los clasifica en cortes. Es la única implementación del clasificador.
- Decide y manda los push.
- Sirve `/privacidad`, `/borrar-datos` y `/c/:code`.
- Publica el contrato en `openapi.json`, del que la app genera su cliente.

La app vive en `pulso-app` (`~/projects/personal/mobile/pulso-app`). Ahí están el producto, la detección en el teléfono, la privacidad, Play Store y el roadmap maestro.

**Estado actual:** fase 0 (contrato y clasificador). Lo pendiente está en `docs/roadmap.md` y el plan paso a paso en `docs/plans/`.

## Comandos

Los de la fase 1 se confirman al crearlos. Si cambian, actualiza esta tabla en el mismo commit.

| Tarea | Comando |
| --- | --- |
| Instalar dependencias | `pnpm install` |
| Lint, tipos y tests (los de integración necesitan `pnpm db:up` y un `.env` copiado de `.env.example`) | `pnpm lint && pnpm typecheck && pnpm test` |
| Solo los tests unitarios (sin Docker) | `pnpm test:unit` |
| Analizar un exporte del registrador | `pnpm spike:analyze <archivo.json>` |
| PostgreSQL local | `pnpm db:up` (`docker compose -f compose.dev.yaml up -d --wait`, puerto 54322) |
| API local (fase 1) | `pnpm dev` (`wrangler dev`, puerto 8787) |
| El Xiaomi contra la API local (fase 1) | `adb reverse tcp:8787 tcp:8787` |
| Generar y aplicar migraciones | `pnpm db:generate` / `pnpm db:migrate` (usa `DATABASE_URL`) |
| Regenerar y verificar el contrato (fase 1) | `pnpm openapi:export` / `pnpm openapi:check` |
| Deploy a staging (fase 1) | Con cada push a `main` (`deploy.yml`); a mano: `pnpm deploy:staging` |
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
6. **El contrato en `/v1` solo cambia de forma aditiva.** Los lotes de `test/fixtures/` (uno por versión de la app publicada) tienen que seguir validando. `openapi.json` se regenera en el mismo commit, y el CI lo verifica.
7. **Los tokens se guardan solo como SHA-256.** Nunca en logs, respuestas (salvo la única vez en `POST /v1/devices`) ni en Sentry.
8. **Nada de Pulso es accesible por la API REST de Supabase**: esquema `app`, RLS activado sin políticas, rol `pulso_api` dueño. Las claves `anon` y `service_role` no se usan.
9. **Límites por dispositivo, no por IP**, salvo en el registro y en las páginas públicas (CGNAT).
10. **Cada cambio de esquema es una migración nueva generada por `drizzle-kit`.** Nunca editar una ya aplicada. Las migraciones solo agregan, para que `wrangler rollback` funcione, y se aplican antes de desplegar el código.
11. **Ningún push se repite**: se marca en `outages` con `UPDATE … WHERE …_notified_at IS NULL RETURNING` antes de enviar.
12. **Secretos con `wrangler secret put`**; la cadena de conexión, solo en Hyperdrive y en los secretos de GitHub; en local, en `.dev.vars` (en `.gitignore`). Nada secreto en `wrangler.jsonc`.
13. **Al terminar una tarea, márcala en `docs/roadmap.md` en el mismo commit**, y registra las decisiones internas en `docs/decisions.md`.

## Trampas conocidas

- **10 ms de CPU por petición en el plan gratuito**: la espera de la base no cuenta, pero el JSON y Zod sí. La clasificación corre solo sobre la ventana de la casa. Nada pesado en una petición.
- **Una conexión por petición**: el cliente de postgres.js se crea dentro del handler con `env.HYPERDRIVE.connectionString`, nunca a nivel de módulo.
- **`bigint` en postgres.js** llega como `string` por defecto. Configurar Drizzle con `mode: 'number'` en las columnas de horas (los epoch ms caben en un `number`).
- **Migraciones con la conexión directa** de Supabase (puerto 5432), no por Hyperdrive ni por el pooler en modo transacción.
- **Supabase pausa un proyecto tras 1 semana sin actividad.** Producción nunca se pausa porque los latidos son constantes; staging sí puede pausarse. Reactivarlo desde el panel.
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
- `docs/roadmap.md`: tareas del backend por fase
- `docs/plans/`: plan paso a paso de cada fase
- En `pulso-app/docs/`: `product.md`, `detection.md`, `security-privacy.md`, `decisions.md` (D-0xx) y el roadmap maestro
