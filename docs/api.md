# API

**Qué responde este documento**

- Qué endpoints existen, quién puede llamarlos y qué devuelven
- Cuál es el contrato de eventos que manda el módulo Kotlin de la app
- Cómo se publica el contrato OpenAPI que consume la app
- Cómo se limitan las peticiones y cuándo sale cada push

Base: `/v1`. El teléfono se autentica con `Authorization: Bearer <token>`. Para la app el token es opaco: lo guarda tal cual lo devuelve `POST /v1/devices`. Por dentro es `<aleatorio>.<firma>` (A-021): el Worker verifica la firma HMAC antes de consultar la base, y un token sin firma válida responde `401 invalid_token` sin tocar la base ni el límite. Cada ruta se define con `createRoute` de `@hono/zod-openapi` (A-002): el mismo esquema Zod valida la petición y genera el contrato. `openapi.json` (versionado en la raíz del repo) es el contrato que consume la app. `GET /openapi.json` sirve ese archivo tal cual, byte a byte (A-040): el CI verifica que coincide con las rutas, y `deploy.yml` compara lo servido por staging con el archivo después de cada despliegue. El contrato no trae `servers`; probablemente lo agrega un cliente como Scalar en su vista, pero no se verificó.

## Endpoints

| Método y ruta | Auth | Para qué | Respuesta | Fase |
| --- | --- | --- | --- | --- |
| `POST /v1/devices` | Ninguna; límite por IP | Registrar el teléfono al primer arranque | `201 { deviceId, token }` | 1 |
| `PATCH /v1/devices/me` | Token | Push token y versión de la app | `204` | 1 |
| `DELETE /v1/devices/me` | Token | Borrar el dispositivo, su casa y todo lo asociado | `204` | 1 |
| `POST /v1/homes` | Token | "Este teléfono vigila mi casa": crea la casa del dispositivo | `201 { homeId, shareCode }` | 1 |
| `PATCH /v1/homes/me` | Token | Alias y modo (`base` o `ups`) | `204` | 1 |
| `GET /v1/homes/me/status` | Token | Estado actual de mi casa | `HomeStatus` | 1 |
| `GET /v1/homes/me/outages?from&to` | Token | Historial con resumen por día | `OutageHistory { items, reports, totalMs, days }` | 2 |
| `POST /v1/homes/me/share-code` | Token | Regenerar el código: el viejo deja de servir y se quita a todos los seguidores (A-041, D-030) | `{ shareCode }` | 3 |
| `POST /v1/events` | Token | Lote de eventos (hasta 200) o latido vacío | `{ accepted, duplicated, status }` | 1 |
| `POST /v1/follows` | Token | Seguir una casa con su código | `201 { homeId, alias, status }` | 3 |
| `GET /v1/follows` | Token | Casas que sigo, con su estado | `{ items }` | 3 |
| `DELETE /v1/follows/:homeId` | Token | Dejar de seguir | `204` | 3 |
| `GET /c/:code` | Pública; límite por IP; caché 30 s | Página HTML de la familia | HTML | 3 |
| `GET /privacidad` | Pública | Política de privacidad | HTML | 2 |
| `GET /borrar-datos` | Pública | Cómo borrar los datos desde la app o por correo (lo pide el formulario de Play) | HTML | 2 |
| `GET /.well-known/assetlinks.json` | Pública | Abrir `/c/:code` dentro de la app (App Links) | JSON | 3 |
| `GET /health` | Pública; límite por IP | Monitoreo (1 consulta) | `{ ok: true }` | 1 |
| `GET /openapi.json` | Pública | Contrato para generar el cliente de la app | JSON | 1 |
| `GET /docs` | Pública solo en staging | Referencia navegable (Scalar) | HTML | 1 |

Errores: `{ error: { code, message } }`.

| HTTP | `code` |
| --- | --- |
| 400 | `validation_failed` (incluye `issues` de Zod) |
| 401 | `invalid_token` (falta el token, está mal formado o su firma no es válida) |
| 404 | `not_found` (por ejemplo, un código inexistente) |
| 409 | `home_exists` (el dispositivo ya vigila una casa) |
| 413 | `validation_failed` (el cuerpo JSON pasa de 256 KB, sin `issues`; A-025) |
| 429 | `rate_limited` (incluye la cabecera `Retry-After: 60`) |
| 500 | `internal_error` (mensaje genérico; el error real va al log, sin cabeceras ni cuerpo y con el token tapado) |

Una ruta que no existe también responde `404 not_found`, y un cuerpo que no es JSON, `400 validation_failed` con `issues` vacío. Las rutas con cuerpo aceptan hasta 256 KB (un lote de 200 eventos ronda los 60 KB): con `Content-Length` se corta antes de leer, y sin él, al pasar del tope leyendo.

Cada esquema de petición y respuesta es un componente con nombre en `openapi.json` (`EventBatch`, `DeviceEvent`, `SnapshotEvent`, `HomeStatus`, `RegisterDeviceRequest`, …), para que el cliente que genera la app tenga tipos estables. El test del contrato lista los nombres: renombrar uno rompe el cliente de la app.

## Historial de cortes

`GET /v1/homes/me/outages?from=<epochMs>&to=<epochMs>` (A-027). `from` y `to` son obligatorios, enteros positivos en epoch ms (hasta el año 2100, `4102444800000`), con `from < to` y `to − from ≤ 92 días`; el rango es `[from, to)`. Un rango inválido responde `400 validation_failed` con `issues` y **sin tocar la base** (se valida después del token y del límite, y antes de la consulta de auth). Un dispositivo sin casa responde `404 not_found`. Cuesta **2 consultas**: la auth y un CTE que trae los cortes y los reportes. Los `reports` son como máximo los 1000 más recientes del rango.

```ts
OutageHistory = {
  items: OutageItem[],      // cortes que se solapan con [from, to): started_at < to y (ended_at es null o > from), el más reciente primero
  reports: ReportItem[],    // reportes con at en [from, to), el más reciente primero; solo hay hasta donde llega la retención de events (30 días)
  totalMs: number,          // suma de los cortes cerrado y abierto (este hasta ahora) recortados al rango; descartado y sin_datos no suman
  days: DaySummary[],       // todos los días del rango en hora de Caracas (UTC−4), también los que suman 0
}
OutageItem  = { id, start, end /* null si sigue abierto */, status, confidence, confirmed /* null sin respuesta */ }
ReportItem  = { at, value: 'hay_luz' | 'fluctuando' | 'sin_luz' }
DaySummary  = { date: 'AAAA-MM-DD', ms }
```

`OutageItem.status` declara desde ya los cuatro valores (`abierto`, `cerrado`, `descartado`, `sin_datos`) porque D-023 prohíbe agregar uno después; `confidence` es `alta`, `media` o `manual`. `items` incluye también los cortes `descartado`.

## Seguir una casa

La familia sigue una casa con su código de 8 caracteres (alfabeto de 31, sin `0`, `1`, `I`, `L` ni `O`). Las tres rutas usan el límite general de 120 por minuto por dispositivo. `GET /v1/follows` ordena por alias con la collation ICU `und-x-icu` (acentos y mayúsculas como una persona).

| Ruta | Cuerpo | Respuesta | Consultas |
| --- | --- | --- | --- |
| `POST /v1/follows` | `FollowRequest { code, alias }` | `201 FollowItem { homeId, alias, status: HomeStatus }` | 2: la auth y un CTE que busca la casa, cuenta, hace el upsert y lee el estado y el corte abierto |
| `GET /v1/follows` | | `200 FollowList { items: FollowItem[] }`, ordenada por alias | 2 |
| `DELETE /v1/follows/:homeId` | | `204`, también si no la seguía | 2: la auth y el `DELETE` |

- `code` se pasa a mayúsculas **antes** de validarlo: `k7m2qx9p` se acepta. Un código mal formado (largo distinto de 8 o letras fuera del alfabeto) responde `400 validation_failed`. `alias` son 1 a 40 caracteres, recortados.
- Es idempotente (A-036): seguir otra vez la misma casa actualiza el alias y también responde `201`. Seguir la propia casa se permite.
- Un código que no existe responde `404 not_found`.
- Un dispositivo sigue como máximo **20 casas** (A-036): la 21 responde `400 validation_failed` con el mensaje "Ya sigues 20 casas." (los códigos de error son un enum de respuesta y no se agregan, D-023). Volver a seguir una de las 20 sí se permite. Con dos peticiones a la vez el tope puede pasarse por una: es un tope de cortesía, no de seguridad.
- `FollowItem.alias` es el que le puse yo a la casa; `status.alias` es el del dueño. `status` es el mismo `HomeStatus` de `GET /v1/homes/me/status`.
- `DELETE` solo borra el follow del dispositivo que llama; `homeId` que no es uuid responde `400`.
- `POST /v1/homes/me/share-code` cambia el código y borra todos los `follows` de la casa con `app.replace_share_code`, en una sola transacción (A-041): el código viejo deja de servir, y quien seguía la casa tiene que volver a seguirla con el código nuevo. Un follow que llega al mismo tiempo no sobrevive: o responde 404 (leyó el código viejo) o se borra con los demás. Cuesta 2 consultas (la auth y esa función); si el código nuevo choca (`23505`), reintenta hasta 3 veces en total, una consulta más por intento, y un intento fallido no quita a nadie. Un dispositivo sin casa responde `404 not_found`.

## Contrato de eventos

```ts
// src/domain/events/schema.ts
import { z } from '@hono/zod-openapi'; // el z de Zod 4 con .openapi()

export const epochMs = z.number().int().positive();

export const snapshotSourceSchema = z.enum([
  'network_callback', 'heartbeat', 'charging_job', 'power_receiver',
  'transition_check', 'app_open', 'boot',
]);

export const snapshotEventSchema = z.object({
  kind: z.literal('snapshot'),
  id: z.uuid(),                       // uuid v7 del teléfono: clave de idempotencia
  at: epochMs,                        // reloj del teléfono
  source: snapshotSourceSchema,
  plugged: z.boolean(),
  onWifi: z.boolean(),
  homeWifi: z.boolean().nullable(),
  internet: z.boolean().nullable(),
  interactive: z.boolean().nullable(),
  batteryPct: z.number().int().min(0).max(100).nullable(),
});

export const reportEventSchema = z.object({
  kind: z.literal('report'),
  id: z.uuid(),
  at: epochMs,
  value: z.enum(['hay_luz', 'fluctuando', 'sin_luz']),
});

export const confirmationEventSchema = z.object({
  kind: z.literal('confirmation'),
  id: z.uuid(),
  at: epochMs,
  outageStart: epochMs,               // el teléfono no conoce el id del servidor
  answer: z.boolean(),
});

export const deviceEventSchema = z.discriminatedUnion('kind', [
  snapshotEventSchema, reportEventSchema, confirmationEventSchema,
]);

export const diagnosticsSchema = z.object({
  appVersion: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  sdkInt: z.number().int(),
  standbyBucket: z.number().int().nullable(),   // UsageStatsManager.getAppStandbyBucket()
  ignoringBatteryOptimizations: z.boolean(),
  pendingEvents: z.number().int().min(0),
});

export const eventBatchSchema = z.object({
  sentAt: epochMs,                    // para corregir el desfase de reloj
  diagnostics: diagnosticsSchema,
  events: z.array(deviceEventSchema).max(200), // vacío = solo latido
});

export type DeviceEvent = z.infer<typeof deviceEventSchema>;
export type SnapshotEvent = z.infer<typeof snapshotEventSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;
```

```ts
// src/domain/homes/schema.ts
export const homeStatusSchema = z.object({
  state: z.enum(['con_luz', 'sin_luz', 'sin_noticias']),
  since: epochMs,
  alias: z.string(),
  openOutageStart: epochMs.nullable(),
});
export type HomeStatus = z.infer<typeof homeStatusSchema>;
```

Kotlin arma el JSON a mano. Para que no se desvíe del contrato, el test de contrato valida con `eventBatchSchema` un lote real capturado del teléfono (`test/fixtures/`). Cada versión de la app que llegue a Play deja su lote ahí, y los cambios del contrato tienen que seguir aceptándolos: solo se hacen cambios aditivos en `/v1`.

## Qué hace `POST /v1/events`

1. Valida con `eventBatchSchema`. Un lote inválido o de más de 200 eventos responde `400 validation_failed` sin tocar la base.
2. Autentica y registra el latido en una sola consulta: `UPDATE app.devices SET last_seen_at = $now, diagnostics = $diag WHERE token_hash = $hash RETURNING id, home_id`, junto con el estado de la casa. Sin fila responde `401 invalid_token`; si el dispositivo no vigila una casa, `404 not_found`.
3. Si el lote viene vacío, responde con el estado de la casa y termina (1 consulta).
4. Calcula `offset = receivedAt − sentAt` y llama a `app.ingest_batch(device_id, home_id, events, offset, receivedAt)`. La función guarda cada evento con `device_at` sin tocar y `at = device_at + offset`, inserta con `ON CONFLICT (device_id, id) DO NOTHING` y devuelve `accepted`, `duplicated`, la revisión de la casa, la ventana y los cortes guardados que hay que reconciliar. La ventana está definida en `data-model.md` ("Funciones de ingesta"). Si no entró ningún evento nuevo (`accepted = 0`, un reintento) y no queda nada sin clasificar, la ventana viene vacía: responde con el estado del paso 2 y termina (2 consultas). Si un lote anterior guardó eventos y su `apply_outages` no llegó a aplicar (el Worker murió entre las dos consultas, o la revisión lo rechazó), `homes.pending_anchor` sigue puesto: entonces un reintento con `accepted = 0` también trae ventana, desde ese ancla, y sigue con los pasos 5 y 6 (3 consultas, A-024).
5. En el Worker corren, solo si llegó ventana, `classify` sobre la ventana con el modo de la casa, `reconcileOutages` (con un uuid v7 para cada insert) y `deriveHomeStatus`, que parte del estado que devolvió `ingest_batch` (no del de la auth: otro lote pudo aplicar entre las dos consultas, A-023).
6. `app.apply_outages(home_id, revision, cambios, estado, now)` aplica todo en una transacción, solo si la revisión no cambió (A-016), borra `pending_anchor` y devuelve el estado de la casa, que es lo que responde la ruta (3 consultas). Si no aplicó porque otro lote ingirió entretanto, deja una línea en el log con la casa y la revisión. Si el estado no cambió, `estado` va como `null` para no escribirlo. Los push de los cortes que se cierran se encolan con `ctx.waitUntil` (fase 3).

## Límites de peticiones

Muchos usuarios de CANTV, Digitel y Movistar comparten IP (CGNAT), y cuando vuelve la luz en una zona todos suben a la vez. Por eso se limita por token siempre que se puede y el límite por IP es holgado.

| Ruta | Clave | Límite |
| --- | --- | --- |
| `POST /v1/devices` | IP | 5 por minuto (A-014) |
| `POST /v1/events` | Dispositivo | 30 por minuto |
| Resto con token | Dispositivo | 120 por minuto |
| `GET /health` | IP | 60 por minuto (`RATE_LIMIT_PUBLIC`) |
| `GET /c/:code` | IP | 60 por minuto, con caché de 30 s (`RATE_LIMIT_PUBLIC`, fase 3) |

Se usa el binding Rate Limiting de Workers, con clave por dispositivo, o por IP en las rutas públicas (A-009). El binding solo admite periodos de 10 o 60 segundos. La clave por dispositivo es el SHA-256 del token, así que el límite corre antes de tocar la base, y un token ausente, mal formado o con firma inválida responde 401 sin consultarla ni llegar al límite (A-021). El teléfono espera entre 0 y 60 segundos al azar antes de subir tras recuperar la red, para no llegar todos en el mismo segundo.

## Cuándo sale cada push

| Push | A quién | Cuándo | Texto |
| --- | --- | --- | --- |
| Inicio | Seguidores | Cron `sweep`, cada 5 min: corte `abierto` de `MIN_OUTAGE_MS` o más, sin `start_notified_at`, conocido hace 30 min o menos | "Se fue la luz en Casa de mamá (6:05 p. m.)" |
| Regreso | Seguidores | Al cerrarse como `cerrado`, si hubo push de inicio | "Volvió la luz en Casa de mamá tras 2 h 10 min" |
| Resumen tardío | Seguidores | Al cerrarse como `cerrado` sin push de inicio (el teléfono no tenía datos) | "En Casa de mamá se fue la luz de 6:05 a 8:15 p. m. (2 h 10 min)" |
| Confirmación | Teléfono de la casa | Al cerrarse: siempre con confianza `media`; con `alta`, durante el piloto, máximo 2 al día | "¿Se fue la luz de 6:05 a 8:15 p. m.?" con botones Sí y No |

"Sin noticias" no genera push en la v1: la familia lo ve al abrir la app o el enlace. El cron `sweep` lee los recibos de Expo Push y borra los `push_token` que respondan `DeviceNotRegistered`.

Amenazas y privacidad en `pulso-app/docs/security-privacy.md`.
