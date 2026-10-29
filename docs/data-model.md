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
  updated_at         bigint NOT NULL,
  created_at         bigint                                  -- cuándo lo conoció el servidor (A-033, 0003); NULL en las filas de antes
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
- **Los avisos quedan marcados en `outages`** (`start_notified_at`, `end_notified_at`, `confirm_asked_at`) con un `UPDATE … WHERE start_notified_at IS NULL RETURNING`, antes de enviar. Solo quien gana esa actualización manda el push, así que no se repite aunque el cron corra dos veces. El inicio lo marca el cron `sweep`; el resto, `apply_outages` (ver abajo y `docs/api.md`, "Cuándo sale cada push"). `created_at` dice desde cuándo lo conoce el servidor: el push de inicio sale solo si es de hace 30 min o menos (A-033).
- **La ingesta va en funciones de PostgreSQL** (A-004), para gastar pocas consultas de Hyperdrive y que cada paso sea atómico. Están en la sección siguiente. El clasificador no está en SQL: corre en el Worker entre las dos llamadas.

## Funciones de ingesta

Las dos primeras viven en `drizzle/0001_ingest_functions.sql`, que también agrega `homes.pending_anchor`. Son `plpgsql`, `SECURITY INVOKER`, de `pulso_api` y sin `EXECUTE` para `PUBLIC`. Cada llamada es una consulta por Hyperdrive y corre en su propia transacción: o se aplica todo o nada.

```sql
app.ingest_batch(p_device_id uuid, p_home_id uuid, p_events jsonb,
                 p_offset_ms bigint, p_received_at bigint) RETURNS jsonb
-- { accepted, duplicated, revision, mode, status: { state, since }, window, outages }

app.apply_outages(p_home_id uuid, p_revision bigint, p_changes jsonb,
                  p_status jsonb, p_now bigint) RETURNS jsonb
-- { applied, status: { state, since, alias, openOutageStart },
--   notify: [{ kind, homeId, outageStart, outageEnd, alias, targets: [{ deviceId, pushToken, alias }] }] }
```

`apply_outages` se reemplazó en `drizzle/0003_push_notifications.sql` (`CREATE OR REPLACE`, misma firma y mismos permisos), que también agrega `outages.created_at`. `ingest_batch` se reemplazó en `drizzle/0004_staleness.sql` (igual), que también agrega `mark_stale` (ver "Sin noticias y `sin_datos`").

```sql
app.replace_share_code(p_home_id uuid, p_code text) RETURNS text
-- el código nuevo, o NULL si la casa no existe (no borra nada)
```

**`replace_share_code`** (`drizzle/0002_replace_share_code.sql`, A-041) cambia `homes.share_code` y borra todos los `follows` de la casa. Tiene las mismas propiedades que las de ingesta (`plpgsql`, `SECURITY INVOKER`, `search_path = app, pg_temp`, de `pulso_api`, sin `EXECUTE` para `PUBLIC`). Es una función y no un solo CTE por la concurrencia: el `UPDATE` toma el candado de la fila (cambia una columna con índice único) y el `DELETE` va como sentencia aparte, cuya instantánea es posterior al candado, así que ve un follow confirmado mientras el `UPDATE` esperaba. La otra mitad de la carrera la cierra la consulta de `POST /v1/follows`, que busca la casa con `FOR KEY SHARE`: si el código cambia mientras espera el candado, lo vuelve a comprobar y responde 404. Si el código nuevo choca (`23505`) se deshace todo y el Worker reintenta.

**`ingest_batch`** guarda cada evento de `p_events` (ya validado por Zod) con `INSERT … ON CONFLICT (device_id, id) DO NOTHING`: `device_at` es su `at` tal cual, `at = device_at + p_offset_ms`, `payload` es el evento original y `received_at = p_received_at`. `duplicated` es lo que no entró.

- Si aceptó algo, sube `homes.ingest_revision` (A-016), guarda `pending_anchor = least(pending_anchor, anchor)` y devuelve la revisión nueva, el `mode` de la casa, la ventana y los cortes.
- Si `accepted = 0` y `pending_anchor` es `NULL` (un reenvío de algo ya clasificado), no sube la revisión y devuelve `window: []` y `outages: []`.
- Si `accepted = 0` y `pending_anchor` no es `NULL` (un lote anterior guardó eventos y su `apply_outages` no aplicó), sube la revisión y devuelve la ventana desde `pending_anchor` igual que si hubiera aceptado algo. El Worker clasifica y aplica: 3 consultas solo en ese caso (A-024).
- `status` es el `{ state, since }` de `homes` leído en el mismo `UPDATE … RETURNING` que sube la revisión, con la fila bloqueada. Ya incluye todo `apply_outages` que aplicó antes, y la revisión nueva hace que ninguno aplique después sin que este lote lo note. Por eso `deriveHomeStatus` parte de este estado y no del de la auth (A-023).
- `window`: los eventos de la casa en la ventana, ordenados por `(at, id)`. Cada uno es su `payload` con `at` ya corregido.
- `outages`: `{ id, start, end, status, confidence, confirmed }`, ordenados por `start`. Son los guardados que `reconcileOutages` compara con lo detectado: los que empiezan en la ventana, de cualquier estado. Un `sin_datos` entra para que unos eventos atrasados lo reclasifiquen en vez de duplicarlo (A-038). Uno que empieza antes de `from` queda fuera, también si sigue `abierto`: sus eventos de inicio ya no están y la reconciliación lo reescribiría a `descartado` (A-042).

**La ventana de la casa:**

```text
anchor  = mínimo de:
          · el at más viejo de los eventos aceptados en este lote,
          · outageStart − CONFIRMATION_TOLERANCE_MS de cada confirmación aceptada,
          · homes.pending_anchor (el ancla de un lote cuyo apply_outages no aplicó)
pending_anchor = anchor   (antes de ampliarlo por los cortes; apply_outages lo vuelve NULL)
anchor  = mínimo entre anchor y el started_at de cada corte guardado que lo contiene:
          started_at < anchor, (ended_at IS NULL o ended_at >= anchor) y
          started_at >= el at más viejo de la casa. Incluye el corte abierto y el sin_datos.
from    = at del último snapshot powered de la casa con at < anchor,
          donde powered = plugged AND coalesce(homeWifi, onWifi) sobre el payload;
          si no hay ninguno, el at más viejo de la casa
window  = eventos de la casa con at >= from
outages = cortes de la casa con started_at >= from (cualquier estado, incluidos abierto y sin_datos)
```

Un `sin_datos` amplía el ancla como un `abierto` (no tiene fin): un `hay_luz` atrasado de un corte manual con snapshots `powered` repetidos dentro tiene que alcanzar su `sin_luz` (A-038). Un corte que empieza antes del evento más viejo de la casa no amplía nada: sus eventos de inicio se purgaron, no hay snapshot `powered` antes, `from` caería en ese evento más viejo y cada lote clasificaría los 30 días de la casa; tampoco entra en `outages` (A-042).

Empezar en un snapshot `powered` reproduce el estado exacto del clasificador: armado y sin corte abierto. Por eso el ancla nunca cae dentro de un corte guardado. Un corte manual sigue abierto aunque lleguen snapshots `powered` repetidos, y empezar a mitad de él haría que el clasificador inventara otro corte, por ejemplo con un evento atrasado que cae dentro de un corte manual ya cerrado. `outageStart` no lleva desfase, porque es la hora del servidor que el teléfono devuelve.

`pending_anchor` (A-024) es el ancla más vieja que `ingest_batch` guardó y ningún `apply_outages` aplicó. Cubre dos casos en los que unos eventos quedarían guardados sin clasificar: el Worker muere entre `ingest_batch` y `apply_outages` (el teléfono reenvía el lote y todo llega como duplicado), y un reintento que se cruza, que sube la revisión y hace que el `apply_outages` del lote original no aplique mientras su propia ventana empieza después de esos eventos. Se guarda antes de ampliar el ancla por los cortes guardados: los cortes se vuelven a leer en cada llamada, y mientras `pending_anchor` siga puesto ningún `apply_outages` los cambió, así que un reintento reproduce la misma ventana. `mark_stale` y la retención sí pueden cambiar entretanto el estado de un corte (`abierto` ↔ `sin_datos`), pero no sus horas, y la ventana depende solo de las horas. Si la revisión coincide, `apply_outages` la vuelve `NULL`: la ventana que se clasificó arrancó en ella o antes. El 300 000 de la función es `CONFIRMATION_TOLERANCE_MS`: si cambia la constante, cambia la función en una migración nueva.

**`apply_outages`** bloquea la casa con `SELECT … FOR UPDATE` y compara `homes.ingest_revision` con `p_revision`. Si otro lote ingirió entretanto, no aplica nada, deja `pending_anchor` como está y devuelve `applied: false` con el estado actual (A-016). Si coincide, borra `pending_anchor` y:

- `p_changes` es la salida de `reconcileOutages` con el id ya puesto: `[{ op: 'insert' | 'update', id, outage }]`, con `outage` de tipo `DetectedOutage`. Cada insert y cada update sella `updated_at = p_now`. Un `op` desconocido o un update sin su corte hace fallar toda la llamada.
- `p_status` es `{ state, since }` (de `deriveHomeStatus`) o `null`. Si cambia algo, se guarda en `homes.status` y `status_since`.
- `status.openOutageStart` es el `started_at` del corte `abierto` más reciente, o `null`.

Y marca los avisos (A-031 a A-034, regla 11), en la misma transacción:

- Primero bloquea, en orden de id, los cortes que va a actualizar (`SELECT … ORDER BY id FOR UPDATE`). Si un `sweep` marcó el inicio de uno y no confirmó, espera: todo lo que sigue ve esa marca, y un `sweep` posterior espera a esta transacción y vuelve a evaluar su `WHERE` con el corte ya cambiado. Sin ese candado, el heredero de A-032 podía copiar una marca vieja (`NULL`) y el inicio salía dos veces.
- Antes de aplicar, anota qué cortes guardados pasan a `cerrado` y cuáles a `descartado` en esta llamada (solo los que cambian de estado). Un insert que ya llega `cerrado` cuenta como que se cierra.
- Cada insert sella `created_at = p_now`.
- **A-032:** la **identidad** de un corte G que esta llamada deja `descartado` se busca entre los cortes que esta llamada inserta o actualiza (descartados o no, con su intervalo nuevo; uno abierto llega hasta el infinito). Si G tuvo push de inicio, es el corte que ese aviso anunció, y el `sweep` solo reclama cortes `abierto`, así que su `start_notified_at` cae dentro de él: (1) otro corte que contiene `start_notified_at`; (2) si no, G mismo, si su intervalo nuevo lo contiene y el clasificador lo movió (un G que `reconcileOutages` deja sin pareja llega con su intervalo de antes, que siempre contiene el aviso y no prueba nada); (3) si no, otro corte que empezó en `start_notified_at` o antes y se solapa con el intervalo de antes de G: el anunciado ya había terminado cuando salió el aviso, pero ya existía; (4) si no, G mismo. Un corte que empezó después del aviso nunca es el anunciado. En la regla 3 gana primero el que contiene el `started_at` de antes de G, luego uno que queda sin descartar y luego el más cercano: un parpadeo `descartado` más cercano a G no le gana a la continuación del corte. Si G no tuvo inicio, su identidad es otro corte que se solapa con su intervalo de antes y que empezó cuando el servidor ya conocía G o antes (`created_at`; `updated_at` en las filas de antes de `0003`), con la cercanía de `reconcileOutages` sin su tope de 5 min (un corte revivido puede estar más lejos). Por lo demás, entre varios candidatos de la misma regla gana el de `started_at` más cercano al de G y, empatados, el más temprano. Si la identidad es otro corte que queda sin descartar, es su **heredero**; si no (queda `descartado`, o es G), no hay heredero, y ningún otro corte hereda un inicio que no es suyo. El heredero toma las marcas que no tenía (`coalesce`) y, si es un insert, también el `created_at` (el más viejo de los que hereda; `NULL` si alguno es de antes de `0003`). El descartado conserva sus marcas, que son lo que de verdad se le avisó, salvo `confirm_asked_at`, que se mueve al heredero para que el cupo de `alta` no cuente dos veces la misma pregunta. Así cubre el cambio de id (el inicio no se repite, y si el corte nuevo ya terminó, sale su regreso y no un resumen tardío más un "volvió la luz") y el caso inverso, una reconciliación posterior que revive el viejo y descarta el nuevo (las marcas vuelven al viejo y su regreso sale normal). Un descartado sin heredero (por ejemplo, el corte nuevo también llega `descartado`) avisa su fin él mismo.
- Marca `end_notified_at` en cada corte que deja `cerrado`, y en cada uno que deja `descartado` con `start_notified_at` puesto y sin heredero, si no la tenía. Eso da `return` (con inicio), `late` (sin inicio) o `return_plain` (descartado, A-034).
- Si el teléfono de la casa tiene `push_token`, marca `confirm_asked_at` en los que deja `cerrado`, sin respuesta y sin marca: siempre con confianza `media`; con `alta`, hasta completar 2 de `alta` en las últimas 24 h de la casa, del más viejo al más nuevo. `manual` nunca.
- `notify` trae un elemento por aviso marcado, con sus destinatarios: los seguidores con `push_token` (cada uno con el alias que le puso a la casa en `follows`) o, para `confirm`, el teléfono de la casa. Un mismo `push_token` va una sola vez. Un aviso sin destinatarios queda marcado y no se devuelve. Si la revisión no coincide, `notify` es `[]`.

## Sin noticias y `sin_datos`

```sql
app.mark_stale(p_now bigint) RETURNS jsonb
-- { noNews, noData, reopened }: casas que pasaron a sin_noticias, cortes que pasaron a sin_datos
-- y cortes sin_datos que volvieron a abierto
```

**`mark_stale`** (`drizzle/0004_staleness.sql`, A-037, A-038, A-049) es la última consulta de cada pasada del cron `sweep` (`markStale` en `src/jobs/sweep.ts`). Tiene las mismas propiedades que las de ingesta. Todo se mide con el latido del teléfono de la casa (`max(last_seen_at)` de sus `devices`), no con sus eventos: el teléfono sube solo cambios, así que un corte largo con el teléfono vivo no trae eventos. En orden:

1. Bloquea en orden de id (`SELECT … ORDER BY id FOR UPDATE OF h`) las casas candidatas de los pasos 2 a 4. Bloquea la casa antes que sus cortes, como `apply_outages`, así que no se interbloquean, y un lote de esas casas espera.
2. **Vuelta:** si el corte más reciente de la casa está `sin_datos`, empezó hace 30 días o menos, el teléfono tiene latido en las últimas 24 h y la casa no está en `con_luz`, el corte vuelve a `abierto` y la casa a `sin_luz` desde su inicio. El teléfono volvió sin cambios que subir: la luz sigue sin volver. Uno de más de 30 días no vuelve: sus eventos de inicio ya no están y la retención lo dejó `sin_datos` a propósito (A-042). Si la casa está en `con_luz`, un lote ya decidió que hay luz.
3. Pasa a `sin_datos` cada corte `abierto` de una casa cuyo teléfono no tiene latido desde hace 24 h o más (`ended_at` sigue en `NULL`).
4. Pasa a `sin_noticias`, con `status_since` = el último latido, cada casa candidata que no está en `sin_noticias`, cuyo teléfono no tiene latido desde hace 40 min o más y que no tiene corte `abierto`, ya contando los del paso 3. Un corte abierto con latido reciente deja la casa en `sin_luz`; uno sin latido por 24 h la pasa, en la misma pasada, a `sin_datos` y a `sin_noticias`.
5. Sube `ingest_revision` de cada casa que tocó (A-023): un lote que ya pasó por `ingest_batch` no aplica encima un estado calculado antes.

Un latido que llega mientras `mark_stale` lee puede quedar detrás de su foto: la casa queda en `sin_noticias` con el teléfono vivo hasta el latido siguiente.

La vuelta de "sin noticias" la hace la consulta de auth (`authenticate`, sigue siendo 1 consulta): un CTE más devuelve a `con_luz` desde `now`, y sube la revisión, la casa del dispositivo que se autentica, solo si la petición es un `POST /v1/events` vacío (`revive: true`; las demás rutas no lo piden), si está en `sin_noticias`, sin corte `abierto` y su corte más reciente no es un `sin_datos` de 30 días o menos (ese lo reabre el paso 2). `POST /v1/events` con eventos y todas las demás rutas no la usan (`revive` es `false` por defecto): decide `deriveHomeStatus`, que desde `sin_noticias` da `con_luz` desde el fin más tardío posterior al último latido, o `sin_luz` si hay corte abierto. El CTE no escribe `outages` (orden de candados). Un seguidor no tiene `home_id` y no toca ninguna casa. Un recibo `ok` de Expo no renueva el `last_seen_at` del teléfono de una casa (A-047).

Un `sin_datos` no suma horas, no es el corte abierto de la casa (`openOutageStart`) y no reclama push de inicio. Entra en la reconciliación si empieza en la ventana de un lote (ver arriba): emparejado, toma lo detectado; sin pareja, no cambia (nunca pasa a `descartado`). Si queda `cerrado`, `apply_outages` avisa como en cualquier cierre: resumen tardío si nunca tuvo inicio, regreso si lo tuvo.

## Retención

| Dato | Se guarda | Cómo se borra |
| --- | --- | --- |
| `events` | 30 días (`at`) | Cron `retention`, diario a las 4:00 a. m. de Caracas |
| `outages` | Mientras exista la casa | Al borrar la casa (cascada) |
| `devices` sin actividad | 180 días sin `last_seen_at` (un latido, una petición o, si solo sigue casas, un recibo `ok` de un push, A-047) | Cron `retention`: borra el dispositivo y su casa (si tiene), y la cascada lleva eventos, cortes y follows |
| `devices` registrados que nunca mandaron nada | 7 días, sin casa, sin follows y con `last_seen_at = created_at` | Cron `retention` |
| `push_tickets` | Hasta leer el recibo (unos 15 min) | Cron `sweep` (`processReceipts` los toma con `DELETE … RETURNING`; ver A-044) |

`retention` es `runRetention` de `src/jobs/retention.ts`: **una consulta** con tres `DELETE` y un `UPDATE` en CTE (todos ven la misma foto de la base), que devuelve cuántas filas borró de cada tipo y cuántos cortes pasó a `sin_datos`, y lo deja en el log. Corre con el cron `0 8 * * *` (8:00 UTC) que `src/jobs/scheduled.ts` despacha, en staging y producción (A-042). Un dispositivo inactivo se borra junto con su casa, igual que `DELETE /v1/devices/me`; las cascadas disparan al terminar la consulta. Un registro sin uso de más de 180 días se cuenta una sola vez, como inactivo.

Interacción con los cortes: un corte `abierto` de más de 30 días pierde los eventos de su inicio, así que la ventana de `ingest_batch` arrancaría a mitad del corte. Ni `ingest_batch` lo devuelve (ni amplía el ancla por él) ni `reconcileOutages` (opción `windowStart`) lo empareja o lo reescribe; sin eso se reescribiría a `descartado`. Para que no quede abierto para siempre, la misma consulta de `retention` lo pasa a `sin_datos` (un `UPDATE` en CTE, salvo en las casas que se borran en esa pasada), y `mark_stale` nunca lo reabre (A-042). No sube la revisión de la casa: su estado no cambia, el corte ya está fuera de toda reconciliación, y bloquear la casa después del corte invertiría el orden de `mark_stale`, que corre a la misma hora.

Un corte `abierto` cuya casa pasa 24 horas sin latido de su teléfono queda `sin_datos` y no suma horas sin luz (cron `sweep`, ver "Sin noticias y `sin_datos`").

## Volumen

El teléfono sube un snapshot solo si cambió `(plugged, onWifi, homeWifi, internet)` (D-008 del producto). El latido viaja aunque no haya cambios, pero es una sola consulta: el mismo `UPDATE` que autentica.

| Por teléfono que vigila una casa, por día | Peticiones | Consultas por Hyperdrive | Filas nuevas |
| --- | --- | --- | --- |
| Latidos (96 de 15 min) | 96 | 96 | 0 |
| Lotes con cambios y reportes | ~20 | ~60 (auth, `ingest_batch`, `apply_outages`) | ~10 a 30 |
| Cron `sweep` (3 consultas cada 5 min, ~864 al día entre todas las casas) | | ~1 | |
| Push de un corte (tickets de los avisos, solo cuando sale uno) | | ~0,1 | |
| **Total** | **~116** | **~157** | **~20** |

Con el plan gratuito de Hyperdrive (100.000 consultas al día) eso da **~640 teléfonos**. Las peticiones de las familias (estado, historial, `/c/:code`) suman algo más, así que el techo práctico ronda los 500 a 600. Antes de llegar ahí: Workers Paid (USD 5 al mes).

Con 1.000 teléfonos, `events` crecería ~20.000 filas al día. Con 30 días de retención son ~600.000 filas, unos 250 a 300 MB con índices, dentro de los 500 MB de Supabase gratis.
