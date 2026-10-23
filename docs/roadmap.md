# Roadmap del backend

**Qué responde este documento**

- Qué falta en `pulso-api` en cada fase, con horas y criterio de cierre

El calendario maestro, las cuentas y los hitos de Play están en `pulso-app/docs/roadmap.md`. Las semanas coinciden: S1 es del 19 al 25 de octubre.

**Estado actual:** fase 1 en staging (`https://pulso-api-staging.isaac-mendozasa.workers.dev`). Falta que Isaac confirme en el panel de Hyperdrive que un latido gasta una consulta y que `anon` no lee `app.homes`. Plan detallado en `docs/plans/2026-10-20-fase-1-api.md`.

## Fase 0 · Contrato y clasificador (S1 y S2, ~8,5 h)

- [x] Repo, Biome, Vitest y CI (1 h)
- [x] Contrato de eventos en Zod (1 h)
- [x] Clasificador: modo base, modo UPS, reportes y confirmaciones, con todos los tests de `docs/classifier.md` (4 h)
- [x] Resumen por día en America/Caracas (1 h)
- [x] `pnpm spike:analyze` (1,5 h)

**Lista cuando:** `pnpm test` está en verde y un exporte real del Xiaomi pasa por `pnpm spike:analyze`.

## Fase 1 · API en staging (S3, ~10 h)

- [x] Cuentas de Cloudflare y Supabase. Proyecto `pulso-staging` en `us-west-2` (A-026) con el rol `pulso_api`, su Hyperdrive (sin caché) y el `id` en `wrangler.jsonc`. Producción se crea en la fase 2 (A-018) y los crons llegan en las fases 3 y 4 (A-019) (1 h)
- [x] Drizzle: `src/db/schema.ts` en el esquema `app` con RLS, `drizzle-kit generate`, `compose.dev.yaml` con PostgreSQL local y Hyperdrive con `localConnectionString` (1,5 h)
- [x] Funciones `app.ingest_batch` y `app.apply_outages` en una migración, con tests de integración contra PostgreSQL (1,5 h)
- [x] Middleware: auth con SHA-256 y latido en un solo `UPDATE … RETURNING`, rate limit y errores (1,5 h)
- [x] `devices` y `homes`: `POST /v1/devices`, `POST /v1/homes`, `PATCH`, `DELETE` en cascada (1 h)
- [x] `POST /v1/events` con `reconcileOutages` y `deriveHomeStatus` en `domain/` (con tests) y `GET /v1/homes/me/status` (2 h)
- [x] `GET /openapi.json`, `/docs` en staging, `pnpm openapi:export` y `openapi:check`; test de contrato con un lote real; `deploy.yml` con migraciones y deploy a staging (1,5 h)

**Lista cuando:** reenviar el mismo lote devuelve `duplicated` igual al número de eventos en staging, y un latido gasta una sola consulta (verificado en el panel de Hyperdrive).

## Fase 2 · Historial, privacidad y producción (S4, ~2,5 h)

- [x] `GET /v1/homes/me/outages` con `summarizeOutages` (1 h)
- [x] `GET /privacidad` y `GET /borrar-datos` con `hono/jsx`, con el contenido de `pulso-app/docs/security-privacy.md` (0,5 h)
- [ ] Proyecto de Supabase `pulso` con el rol `pulso_api` y su Hyperdrive (A-018). Entorno `production` y despliegue manual con aprobación; workflow nocturno de respaldo con `pg_dump` cifrado (1 h)

**Lista cuando:** la URL de `/privacidad` de producción carga y está puesta en Play Console, y existe el primer respaldo.

## Fase 3 · Push y familia (S5, ~6 h)

- [ ] Módulo `push`: envío a Expo Push, `push_tickets`, recibos y limpieza de tokens con `DeviceNotRegistered` (2 h)
- [ ] Reglas de `docs/api.md` (inicio, regreso, resumen tardío, confirmación), en el cron `sweep` y al cerrar un corte, sin repetir avisos (1,5 h)
- [ ] `POST/GET/DELETE /v1/follows` y `POST /v1/homes/me/share-code` (1,5 h)
- [ ] `GET /c/:code` con caché de 30 s y `/.well-known/assetlinks.json` (1 h)

**Lista cuando:** un corte simulado produce exactamente un push de inicio y uno de regreso, aunque el cron corra dos veces.

## Fase 4 · Robustez (S6, ~4,5 h)

- [ ] `sweep`: "sin noticias" (40 min sin latido) y `sin_datos` (24 h abierto sin eventos); cron `retention` (2 h)
- [ ] `@sentry/cloudflare` con los filtros de `pulso-app/docs/security-privacy.md` (0,75 h)
- [ ] Ajuste de umbrales con las confirmaciones, con un test por caso (1,25 h)
- [ ] Primera restauración probada de un respaldo en el PostgreSQL local (0,5 h)

**Lista cuando:** 45 minutos sin latido dejan la casa en `sin_noticias`, el siguiente latido la regresa, y hay una restauración anotada.

## Fase 5 · Producción (S7 y S8)

- [ ] Revisión de seguridad y rendimiento (skill `security-perf-review`), con atención al aislamiento del esquema `app` en Supabase
- [ ] Confirmar los límites gratuitos de Workers, Hyperdrive y Supabase
- [ ] `docs/runbook.md`: desplegar, volver atrás, restaurar, rotar secretos y la contraseña de la base, reactivar un proyecto pausado
- [ ] Lote de la versión de producción de la app agregado a `test/fixtures/`
- [ ] Despliegue a producción con las migraciones aplicadas
