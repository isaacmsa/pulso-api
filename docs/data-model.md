# Modelo de datos

**Qué responde este documento**

- Qué tablas tiene PostgreSQL y por qué
- Qué funciones de PostgreSQL hacen la ingesta y cómo se protegen los datos en Supabase
- Cómo se evitan duplicados y se corrige el reloj del teléfono
- Cuánto tiempo vive cada dato y cuánto escribe cada teléfono

Seis tablas en PostgreSQL (Supabase), en el esquema `app`. Ninguna guarda nombre, teléfono, correo, ubicación ni nombre de la red.

La fuente es `src/db/schema.ts` (Drizzle). `drizzle-kit generate` produce el SQL en `drizzle/`, y ese SQL es lo que se revisa en cada PR. El esquema equivalente:

```sql
-- drizzle/0000_init.sql (equivalente; el archivo real lo genera drizzle-kit)
CREATE SCHEMA app AUTHORIZATION pulso_api;   -- el rol se crea a mano una vez por proyecto

CREATE TABLE app.homes (
  id                 uuid PRIMARY KEY,                       -- uuid v7 generado en la API
  share_code         text NOT NULL UNIQUE,                   -- 8 caracteres de 23456789ABCDEFGHJKMNPQRSTUVWXYZ
  alias              text NOT NULL DEFAULT 'Casa',
  mode               text NOT NULL DEFAULT 'base' CHECK (mode IN ('base','ups')),
  status             text NOT NULL DEFAULT 'con_luz'
                     CHECK (status IN ('con_luz','sin_luz','sin_noticias')),
  status_since       bigint NOT NULL,                        -- epoch ms
  ingest_revision    bigint NOT NULL DEFAULT 0,              -- sube con cada lote; apply_outages solo aplica si no cambió (A-016)
  pending_anchor     bigint,                                 -- ancla más vieja sin clasificar; NULL = nada pendiente (A-024)
  created_at         bigint NOT NULL
);

CREATE TABLE app.devices (
  id            uuid PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,                        -- sha-256 hex del token
  home_id       uuid REFERENCES app.homes(id) ON DELETE SET NULL, -- NULL = solo sigue casas
  push_token    text,
  app_version   text NOT NULL,
  diagnostics   jsonb,                                       -- último diagnóstico recibido
  created_at    bigint NOT NULL,
  last_seen_at  bigint NOT NULL                              -- último latido o petición
);
CREATE INDEX devices_home ON app.devices (home_id);
CREATE INDEX devices_last_seen ON app.devices (last_seen_at);

CREATE TABLE app.events (
  device_id    uuid NOT NULL REFERENCES app.devices(id) ON DELETE CASCADE,
  id           uuid NOT NULL,                                -- uuid v7 generado en el teléfono
  home_id      uuid NOT NULL REFERENCES app.homes(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('snapshot','report','confirmation')),
  device_at    bigint NOT NULL,                              -- hora original del teléfono, sin tocar
  at           bigint NOT NULL,                              -- device_at + desfase del lote
  payload      jsonb NOT NULL,                               -- validado por Zod
  received_at  bigint NOT NULL,
  PRIMARY KEY (device_id, id)                                -- reintentos idempotentes
);
CREATE INDEX events_home_at ON app.events (home_id, at);

CREATE TABLE app.outages (
  id                 uuid PRIMARY KEY,
  home_id            uuid NOT NULL REFERENCES app.homes(id) ON DELETE CASCADE,
  started_at         bigint NOT NULL,
  ended_at           bigint,                                 -- NULL = en curso
  status             text NOT NULL
                     CHECK (status IN ('abierto','cerrado','descartado','sin_datos')),
  confidence         text NOT NULL CHECK (confidence IN ('alta','media','manual')),
  confirmed          boolean,                                -- NULL sin respuesta
  start_notified_at  bigint,                                 -- push de inicio enviado
  end_notified_at    bigint,                                 -- push de regreso enviado
  confirm_asked_at   bigint,                                 -- confirmación pedida
  updated_at         bigint NOT NULL
);
CREATE INDEX outages_home_started ON app.outages (home_id, started_at DESC);
CREATE INDEX outages_open ON app.outages (home_id) WHERE status = 'abierto';

CREATE TABLE app.follows (
  home_id             uuid NOT NULL REFERENCES app.homes(id) ON DELETE CASCADE,
  follower_device_id  uuid NOT NULL REFERENCES app.devices(id) ON DELETE CASCADE,
  alias               text NOT NULL,                         -- "Casa de mamá"
  created_at          bigint NOT NULL,
  PRIMARY KEY (home_id, follower_device_id)
);
CREATE INDEX follows_follower ON app.follows (follower_device_id);

CREATE TABLE app.push_tickets (
  ticket_id   text PRIMARY KEY,                              -- ticket de Expo Push
  device_id   uuid NOT NULL REFERENCES app.devices(id) ON DELETE CASCADE,
  created_at  bigint NOT NULL
);

-- Supabase expone `public` en su API REST; `app` no. Además, RLS sin políticas (A-005).
ALTER TABLE app.homes ENABLE ROW LEVEL SECURITY;   -- y lo mismo en las otras cinco tablas
-- El esquema y las tablas son de `pulso_api` (las migraciones corren con ese rol).
-- El dueño no pasa por RLS; `anon`, `authenticated` y cualquier otro rol no ven nada.
```

## Por qué así

- **La casa y el teléfono son tablas distintas.** Un familiar que solo sigue casas es un `device` sin `home_id`. Así caben, sin migrar, un iPhone que solo sigue (v1.1) y, más adelante, dos teléfonos en una casa.
- **La clave de idempotencia es el `id` del evento**, un UUID v7 que genera el teléfono. Un reintento con otro `sentAt` no duplica nada.
- **La hora original no se toca.** `device_at` queda igual que la mandó el teléfono, y `at` es la hora corregida con el desfase del lote (`receivedAt − sentAt`). El clasificador usa `at`.
- **Horas en `bigint` (epoch ms)**, igual que en el contrato y en el clasificador (A-005). Para mirar a mano: `to_timestamp(at / 1000.0) AT TIME ZONE 'America/Caracas'`.
- **`payload` en `jsonb`** (A-004): los campos del snapshot van a cambiar con la prueba técnica. Zod valida la forma en la entrada, así que agregar un campo no exige migración.
- **El estado de la casa vive materializado** en `homes.status`. La página pública lee una fila, y el push compara el estado anterior con el nuevo para avisar solo en las transiciones.
- **Los avisos quedan marcados en `outages`** (`start_notified_at`, `end_notified_at`, `confirm_asked_at`) con un `UPDATE … WHERE start_notified_at IS NULL RETURNING`, antes de enviar. Solo quien gana esa actualización manda el push, así que no se repite aunque el cron corra dos veces.
- **La ingesta va en funciones de PostgreSQL** (A-004), para gastar pocas consultas de Hyperdrive y que cada paso sea atómico. Están en la sección siguiente. El clasificador no está en SQL: corre en el Worker entre las dos llamadas.

## Funciones de ingesta

Viven en `drizzle/0001_ingest_functions.sql`, que también agrega `homes.pending_anchor`. Son `plpgsql`, `SECURITY INVOKER`, de `pulso_api` y sin `EXECUTE` para `PUBLIC`. Cada llamada es una consulta por Hyperdrive y corre en su propia transacción: o se aplica todo o nada.

```sql
app.ingest_batch(p_device_id uuid, p_home_id uuid, p_events jsonb,
                 p_offset_ms bigint, p_received_at bigint) RETURNS jsonb
-- { accepted, duplicated, revision, mode, status: { state, since }, window, outages }

app.apply_outages(p_home_id uuid, p_revision bigint, p_changes jsonb,
                  p_status jsonb, p_now bigint) RETURNS jsonb
-- { applied, status: { state, since, alias, openOutageStart } }
```

**`ingest_batch`** guarda cada evento de `p_events` (ya validado por Zod) con `INSERT … ON CONFLICT (device_id, id) DO NOTHING`: `device_at` es su `at` tal cual, `at = device_at + p_offset_ms`, `payload` es el evento original y `received_at = p_received_at`. `duplicated` es lo que no entró.

- Si aceptó algo, sube `homes.ingest_revision` (A-016), guarda `pending_anchor = least(pending_anchor, anchor)` y devuelve la revisión nueva, el `mode` de la casa, la ventana y los cortes.
- Si `accepted = 0` y `pending_anchor` es `NULL` (un reenvío de algo ya clasificado), no sube la revisión y devuelve `window: []` y `outages: []`.
- Si `accepted = 0` y `pending_anchor` no es `NULL` (un lote anterior guardó eventos y su `apply_outages` no aplicó), sube la revisión y devuelve la ventana desde `pending_anchor` igual que si hubiera aceptado algo. El Worker clasifica y aplica: 3 consultas solo en ese caso (A-024).
- `status` es el `{ state, since }` de `homes` leído en el mismo `UPDATE … RETURNING` que sube la revisión, con la fila bloqueada. Ya incluye todo `apply_outages` que aplicó antes, y la revisión nueva hace que ninguno aplique después sin que este lote lo note. Por eso `deriveHomeStatus` parte de este estado y no del de la auth (A-023).
- `window`: los eventos de la casa en la ventana, ordenados por `(at, id)`. Cada uno es su `payload` con `at` ya corregido.
- `outages`: `{ id, start, end, status, confidence, confirmed }`, ordenados por `start`. Son los guardados que `reconcileOutages` compara con lo detectado.

**La ventana de la casa:**

```text
anchor  = mínimo de:
          · el at más viejo de los eventos aceptados en este lote,
          · outageStart − CONFIRMATION_TOLERANCE_MS de cada confirmación aceptada,
          · homes.pending_anchor (el ancla de un lote cuyo apply_outages no aplicó)
pending_anchor = anchor   (antes de ampliarlo por los cortes; apply_outages lo vuelve NULL)
anchor  = mínimo entre anchor y el started_at de cada corte guardado que lo contiene:
          status <> 'sin_datos', started_at < anchor y (ended_at IS NULL o ended_at >= anchor).
          Incluye el corte abierto.
from    = at del último snapshot powered de la casa con at < anchor,
          donde powered = plugged AND coalesce(homeWifi, onWifi) sobre el payload;
          si no hay ninguno, el at más viejo de la casa
window  = eventos de la casa con at >= from
outages = cortes de la casa con status <> 'sin_datos' y (status = 'abierto' o started_at >= from)
```

Empezar en un snapshot `powered` reproduce el estado exacto del clasificador: armado y sin corte abierto. Por eso el ancla nunca cae dentro de un corte guardado. Un corte manual sigue abierto aunque lleguen snapshots `powered` repetidos, y empezar a mitad de él haría que el clasificador inventara otro corte, por ejemplo con un evento atrasado que cae dentro de un corte manual ya cerrado. `outageStart` no lleva desfase, porque es la hora del servidor que el teléfono devuelve.

`pending_anchor` (A-024) es el ancla más vieja que `ingest_batch` guardó y ningún `apply_outages` aplicó. Cubre dos casos en los que unos eventos quedarían guardados sin clasificar: el Worker muere entre `ingest_batch` y `apply_outages` (el teléfono reenvía el lote y todo llega como duplicado), y un reintento que se cruza, que sube la revisión y hace que el `apply_outages` del lote original no aplique mientras su propia ventana empieza después de esos eventos. Se guarda antes de ampliar el ancla por los cortes guardados: los cortes se vuelven a leer en cada llamada, y mientras `pending_anchor` siga puesto ningún `apply_outages` los cambió, así que un reintento reproduce la misma ventana. Si la revisión coincide, `apply_outages` la vuelve `NULL`: la ventana que se clasificó arrancó en ella o antes. El 300 000 de la función es `CONFIRMATION_TOLERANCE_MS`: si cambia la constante, cambia la función en una migración nueva.

**`apply_outages`** bloquea la casa con `SELECT … FOR UPDATE` y compara `homes.ingest_revision` con `p_revision`. Si otro lote ingirió entretanto, no aplica nada, deja `pending_anchor` como está y devuelve `applied: false` con el estado actual (A-016). Si coincide, borra `pending_anchor` y:

- `p_changes` es la salida de `reconcileOutages` con el id ya puesto: `[{ op: 'insert' | 'update', id, outage }]`, con `outage` de tipo `DetectedOutage`. Cada insert y cada update sella `updated_at = p_now`. Un `op` desconocido o un update sin su corte hace fallar toda la llamada.
- `p_status` es `{ state, since }` (de `deriveHomeStatus`) o `null`. Si cambia algo, se guarda en `homes.status` y `status_since`.
- `status.openOutageStart` es el `started_at` del corte `abierto` más reciente, o `null`.

## Retención

| Dato | Se guarda | Cómo se borra |
| --- | --- | --- |
| `events` | 30 días (`at`) | Cron `retention`, diario a las 4:00 a. m. de Caracas |
| `outages` | Mientras exista la casa | Al borrar la casa (cascada) |
| `devices` sin actividad | 180 días sin `last_seen_at` | Cron `retention`: borra el dispositivo y su casa (si tiene), y la cascada lleva eventos, cortes y follows |
| `devices` registrados que nunca mandaron nada | 7 días, sin casa, sin follows y con `last_seen_at = created_at` | Cron `retention` |
| `push_tickets` | Hasta leer el recibo (unos 15 min) | Cron `sweep` |

`retention` es `runRetention` de `src/jobs/retention.ts`: **una consulta** con tres `DELETE` en CTE (todos ven la misma foto de la base), que devuelve cuántas filas borró de cada tipo y las deja en el log. Corre con el cron `0 8 * * *` (8:00 UTC) que `src/jobs/scheduled.ts` despacha, en staging y producción (A-042). Un dispositivo inactivo se borra junto con su casa, igual que `DELETE /v1/devices/me`; las cascadas disparan al terminar la consulta. Un registro sin uso de más de 180 días se cuenta una sola vez, como inactivo.

Un corte `abierto` que pasa 24 horas sin eventos nuevos de su casa queda `sin_datos` y no suma horas sin luz.

## Volumen

El teléfono sube un snapshot solo si cambió `(plugged, onWifi, homeWifi, internet)` (D-008 del producto). El latido viaja aunque no haya cambios, pero es una sola consulta: el mismo `UPDATE` que autentica.

| Por teléfono que vigila una casa, por día | Peticiones | Consultas por Hyperdrive | Filas nuevas |
| --- | --- | --- | --- |
| Latidos (96 de 15 min) | 96 | 96 | 0 |
| Lotes con cambios y reportes | ~20 | ~60 (auth, `ingest_batch`, `apply_outages`) | ~10 a 30 |
| Cron (repartido entre todas las casas) | | ~1 | |
| **Total** | **~116** | **~157** | **~20** |

Con el plan gratuito de Hyperdrive (100.000 consultas al día) eso da **~640 teléfonos**. Las peticiones de las familias (estado, historial, `/c/:code`) suman algo más, así que el techo práctico ronda los 500 a 600. Antes de llegar ahí: Workers Paid (USD 5 al mes).

Con 1.000 teléfonos, `events` crecería ~20.000 filas al día. Con 30 días de retención son ~600.000 filas, unos 250 a 300 MB con índices, dentro de los 500 MB de Supabase gratis.
