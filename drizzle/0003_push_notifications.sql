ALTER TABLE "app"."outages" ADD COLUMN "created_at" bigint;--> statement-breakpoint

-- Avisos de push en apply_outages (A-031 a A-034, regla 11). Misma firma que en 0001: solo cambia
-- el cuerpo. Todo en la transacción de la llamada, con la casa bloqueada y, antes de leer marcas,
-- también los cortes que va a actualizar (en orden de id):
--   · cada insert sella created_at = p_now (A-033: el push de inicio sale solo si el servidor
--     conoce el corte desde hace 30 min o menos; lo reclama el cron sweep, no esta función);
--   · un corte que esta llamada deja descartado tiene por identidad otro corte de esta llamada:
--     el que contiene su aviso de inicio, o, sin inicio, el que se solapa con él con el
--     started_at más cercano; si esa identidad queda sin descartar (insert o update), le pasa sus
--     marcas, y a un insert también su created_at (A-032): reclasificar no repite el inicio ni
--     manda un "volvió la luz" de un corte que sigue;
--   · marca end_notified_at en cada corte que esta llamada deja cerrado (regreso o resumen tardío),
--     o descartado con push de inicio y sin heredero (A-034), si no la tenía;
--   · marca confirm_asked_at en los que deja cerrado: siempre con confianza media; con alta, hasta
--     2 en 24 h por casa. Solo si el teléfono de la casa tiene push_token;
--   · devuelve en notify a quién avisar. Un aviso sin destinatarios queda marcado y no se devuelve.
-- Las marcas usan UPDATE … WHERE …_notified_at IS NULL RETURNING: el cron sweep toca las mismas
-- filas, y el candado de la fila decide quién gana.
CREATE OR REPLACE FUNCTION app.apply_outages(
  p_home_id uuid,
  p_revision bigint,
  p_changes jsonb,
  p_status jsonb,
  p_now bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_revision bigint;
  v_applied boolean;
  v_expected integer;
  v_updated integer;
  v_home app.homes%ROWTYPE;
  v_open_start bigint;
  v_closing uuid[] := '{}';   -- cortes que esta llamada deja cerrado
  v_dropped uuid[] := '{}';   -- cortes guardados que esta llamada deja descartado
  v_moved uuid[] := '{}';     -- de esos, los que tienen heredero (A-032): no avisan su fin
  v_alta_asked integer;
  v_claims jsonb := '[]'::jsonb;   -- [{ kind, outageStart, outageEnd }]
  v_followers jsonb;
  v_phone jsonb;
  v_notify jsonb := '[]'::jsonb;
BEGIN
  SELECT ingest_revision INTO v_revision FROM app.homes WHERE id = p_home_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_outages: la casa % no existe', p_home_id USING ERRCODE = 'no_data_found';
  END IF;

  v_applied := v_revision = p_revision;

  IF v_applied THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_changes) AS c
      WHERE c->>'op' IS DISTINCT FROM 'insert' AND c->>'op' IS DISTINCT FROM 'update'
    ) THEN
      RAISE EXCEPTION 'apply_outages: op desconocida en p_changes' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Regla 11: los cortes que se van a actualizar se bloquean antes de leer sus marcas, en orden
    -- de id (el mismo para todos, sin interbloqueos entre lotes). Si un sweep marcó el inicio de
    -- uno y no confirmó, se espera aquí: todo lo que sigue ve su marca. Y un sweep que llegue
    -- después espera a esta transacción y vuelve a evaluar su WHERE con el corte ya cambiado.
    PERFORM 1
    FROM app.outages
    WHERE home_id = p_home_id
      AND id IN (SELECT (c->>'id')::uuid FROM jsonb_array_elements(p_changes) AS c
                 WHERE c->>'op' = 'update')
    ORDER BY id
    FOR UPDATE;

    -- Antes de aplicar: qué cortes guardados pasan a cerrado o a descartado en esta llamada. Un
    -- update que no cambia el estado (p. ej. una respuesta a la confirmación) no avisa nada.
    SELECT
      coalesce(array_agg(o.id) FILTER (
        WHERE c->'outage'->>'status' = 'cerrado' AND o.status <> 'cerrado'), '{}'),
      coalesce(array_agg(o.id) FILTER (
        WHERE c->'outage'->>'status' = 'descartado' AND o.status <> 'descartado'), '{}')
    INTO v_closing, v_dropped
    FROM jsonb_array_elements(p_changes) AS c
    JOIN app.outages AS o ON o.id = (c->>'id')::uuid AND o.home_id = p_home_id
    WHERE c->>'op' = 'update';

    INSERT INTO app.outages (id, home_id, started_at, ended_at, status, confidence, confirmed,
                             updated_at, created_at)
    SELECT (c->>'id')::uuid, p_home_id,
           (c->'outage'->>'start')::bigint, (c->'outage'->>'end')::bigint,
           c->'outage'->>'status', c->'outage'->>'confidence',
           (c->'outage'->>'confirmed')::boolean, p_now, p_now
    FROM jsonb_array_elements(p_changes) AS c
    WHERE c->>'op' = 'insert';

    -- A-032: el corte cambió de id, o una reconciliación posterior revive el viejo y descarta el
    -- nuevo. La identidad de cada corte G que esta llamada deja descartado se busca entre los
    -- otros cortes de esta llamada (insert o update, descartado o no, con su intervalo nuevo;
    -- abierto = hasta el infinito):
    --   1. si G tuvo push de inicio, el que contiene start_notified_at: el sweep solo reclama
    --      cortes abiertos, así que ese instante cae dentro del corte que el aviso anunció;
    --   2. si G tuvo inicio y ninguno lo contiene, G es su propia identidad (no hay heredero);
    --   3. sin inicio, el que se solapa con G (su intervalo de antes) con el started_at más
    --      cercano: la cercanía de reconcileOutages, sin su tope de 5 min.
    -- Entre varios candidatos gana el de started_at más cercano. Si la identidad queda sin
    -- descartar es su heredero: toma las marcas que no tenía y, si es un insert, también el
    -- created_at (el más viejo; NULL si alguno es de antes de 0003). Si no hay heredero, G avisa
    -- su fin, y un corte posterior del mismo lote no hereda un inicio que no es suyo. G conserva
    -- sus marcas (son lo que de verdad se le avisó), salvo confirm_asked_at, que se mueve al
    -- heredero: así el cupo de alta no cuenta dos veces la misma pregunta. Va antes del UPDATE de
    -- abajo, que no toca marcas.
    WITH touched AS (
      SELECT (c->>'id')::uuid AS id,
             c->>'op' = 'insert' AS is_insert,
             c->'outage'->>'status' <> 'descartado' AS is_live,
             (c->'outage'->>'start')::bigint AS started_at,
             coalesce((c->'outage'->>'end')::bigint, 9223372036854775807) AS ended_at
      FROM jsonb_array_elements(p_changes) AS c
    ),
    identities AS (
      SELECT DISTINCT ON (g.id) g.id AS old_id, n.id AS new_id, n.is_insert, n.is_live
      FROM app.outages AS g
      JOIN touched AS n
        ON n.id <> g.id
       AND CASE
             WHEN g.start_notified_at IS NOT NULL
               THEN n.started_at <= g.start_notified_at AND g.start_notified_at <= n.ended_at
             ELSE n.started_at < coalesce(g.ended_at, 9223372036854775807)
                  AND g.started_at < n.ended_at
           END
      WHERE g.id = ANY(v_dropped) AND g.home_id = p_home_id
      ORDER BY g.id, abs(n.started_at - g.started_at), n.started_at, n.id
    ),
    heirs AS (
      SELECT old_id, new_id, is_insert FROM identities WHERE is_live
    ),
    inherited AS (
      SELECT h.new_id,
             bool_or(h.is_insert) AS is_insert,
             CASE WHEN bool_or(g.created_at IS NULL) THEN NULL ELSE min(g.created_at) END
               AS created_at,
             max(g.start_notified_at) AS start_notified_at,
             max(g.end_notified_at) AS end_notified_at,
             max(g.confirm_asked_at) AS confirm_asked_at
      FROM heirs AS h JOIN app.outages AS g ON g.id = h.old_id
      GROUP BY h.new_id
    ),
    stamped AS (
      UPDATE app.outages AS o
      SET created_at = CASE WHEN i.is_insert THEN i.created_at ELSE o.created_at END,
          start_notified_at = coalesce(o.start_notified_at, i.start_notified_at),
          end_notified_at = coalesce(o.end_notified_at, i.end_notified_at),
          confirm_asked_at = coalesce(o.confirm_asked_at, i.confirm_asked_at)
      FROM inherited AS i
      WHERE o.id = i.new_id
      RETURNING o.id
    )
    SELECT coalesce(array_agg(old_id), '{}') INTO v_moved FROM heirs;

    UPDATE app.outages SET confirm_asked_at = NULL
    WHERE id = ANY(v_moved) AND confirm_asked_at IS NOT NULL;

    SELECT count(*) INTO v_expected
    FROM jsonb_array_elements(p_changes) AS c WHERE c->>'op' = 'update';

    UPDATE app.outages AS o
    SET started_at = (c->'outage'->>'start')::bigint,
        ended_at = (c->'outage'->>'end')::bigint,
        status = c->'outage'->>'status',
        confidence = c->'outage'->>'confidence',
        confirmed = (c->'outage'->>'confirmed')::boolean,
        updated_at = p_now
    FROM jsonb_array_elements(p_changes) AS c
    WHERE c->>'op' = 'update' AND o.id = (c->>'id')::uuid AND o.home_id = p_home_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    -- Un update sin su corte es un error del Worker: mejor fallar que perderlo en silencio.
    IF v_updated <> v_expected THEN
      RAISE EXCEPTION 'apply_outages: % de % updates no encontraron su corte',
        v_expected - v_updated, v_expected USING ERRCODE = 'no_data_found';
    END IF;

    -- Un insert que ya llega cerrado (el teléfono subió el corte entero) también se cierra aquí.
    SELECT v_closing || coalesce(array_agg((c->>'id')::uuid), '{}')
    INTO v_closing
    FROM jsonb_array_elements(p_changes) AS c
    WHERE c->>'op' = 'insert' AND c->'outage'->>'status' = 'cerrado';

    -- Regla 11: regreso o resumen tardío al cerrarse, y "volvió la luz" sin duración al quedar
    -- descartado uno que ya tuvo push de inicio (A-034). Solo el que pone la marca avisa.
    WITH claimed AS (
      UPDATE app.outages
      SET end_notified_at = p_now
      WHERE home_id = p_home_id
        AND end_notified_at IS NULL
        AND (id = ANY(v_closing)
             OR (id = ANY(v_dropped) AND NOT id = ANY(v_moved)
                 AND start_notified_at IS NOT NULL))
      RETURNING started_at, ended_at, status, start_notified_at
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'kind', CASE WHEN status = 'descartado' THEN 'return_plain'
                          WHEN start_notified_at IS NULL THEN 'late'
                          ELSE 'return' END,
             'outageStart', started_at,
             'outageEnd', ended_at
           ) ORDER BY started_at), '[]'::jsonb)
    INTO v_claims
    FROM claimed;

    -- Confirmación al teléfono de la casa, solo si puede recibirla: con confianza media siempre;
    -- con alta, hasta 2 en las últimas 24 h de la casa (cuentan solo las de alta).
    IF EXISTS (
      SELECT 1 FROM app.devices WHERE home_id = p_home_id AND push_token IS NOT NULL
    ) THEN
      SELECT count(*) INTO v_alta_asked
      FROM app.outages
      WHERE home_id = p_home_id AND confidence = 'alta' AND confirm_asked_at > p_now - 86400000;

      WITH candidates AS (
        SELECT id, confidence,
               row_number() OVER (PARTITION BY confidence ORDER BY started_at, id) AS n
        FROM app.outages
        WHERE id = ANY(v_closing) AND status = 'cerrado'
          AND confirm_asked_at IS NULL AND confirmed IS NULL
          AND confidence IN ('media', 'alta')
      ),
      asked AS (
        UPDATE app.outages AS o
        SET confirm_asked_at = p_now
        FROM candidates AS c
        WHERE o.id = c.id AND o.confirm_asked_at IS NULL
          AND (c.confidence = 'media' OR c.n <= 2 - v_alta_asked)
        RETURNING o.started_at, o.ended_at
      )
      SELECT v_claims || coalesce(jsonb_agg(jsonb_build_object(
               'kind', 'confirm', 'outageStart', started_at, 'outageEnd', ended_at
             ) ORDER BY started_at), '[]'::jsonb)
      INTO v_claims
      FROM asked;
    END IF;

    IF p_status IS NOT NULL AND p_status <> 'null'::jsonb THEN
      UPDATE app.homes
      SET status = p_status->>'state', status_since = (p_status->>'since')::bigint
      WHERE id = p_home_id
        AND (status, status_since)
            IS DISTINCT FROM (p_status->>'state', (p_status->>'since')::bigint);
    END IF;

    -- La revisión coincide: la ventana que se clasificó arrancó en el ancla pendiente o antes,
    -- así que ya no queda nada sin clasificar (A-024).
    UPDATE app.homes SET pending_anchor = NULL
    WHERE id = p_home_id AND pending_anchor IS NOT NULL;
  END IF;

  SELECT * INTO v_home FROM app.homes WHERE id = p_home_id;
  SELECT max(started_at) INTO v_open_start
  FROM app.outages WHERE home_id = p_home_id AND status = 'abierto';

  -- A quién avisar: los seguidores con push_token, cada uno con el alias que le puso a la casa; la
  -- confirmación, al teléfono de la casa. Un token repetido (el dueño que sigue su propia casa
  -- recibe como seguidor; dos registros con el mismo token) recibe una sola vez.
  IF jsonb_array_length(v_claims) > 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'deviceId', t.id, 'pushToken', t.push_token, 'alias', t.alias)), '[]'::jsonb)
    INTO v_followers
    FROM (
      SELECT DISTINCT ON (d.push_token) d.id, d.push_token, f.alias
      FROM app.follows AS f
      JOIN app.devices AS d ON d.id = f.follower_device_id
      WHERE f.home_id = p_home_id AND d.push_token IS NOT NULL
      ORDER BY d.push_token, f.created_at, d.id
    ) AS t;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'deviceId', t.id, 'pushToken', t.push_token, 'alias', v_home.alias)), '[]'::jsonb)
    INTO v_phone
    FROM (
      SELECT DISTINCT ON (push_token) id, push_token
      FROM app.devices
      WHERE home_id = p_home_id AND push_token IS NOT NULL
      ORDER BY push_token, id
    ) AS t;

    SELECT coalesce(jsonb_agg(n.claim || jsonb_build_object(
             'homeId', p_home_id, 'alias', v_home.alias, 'targets', n.targets)), '[]'::jsonb)
    INTO v_notify
    FROM (
      SELECT c AS claim,
             CASE WHEN c->>'kind' = 'confirm' THEN v_phone ELSE v_followers END AS targets
      FROM jsonb_array_elements(v_claims) AS c
    ) AS n
    WHERE jsonb_array_length(n.targets) > 0;
  END IF;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'status', jsonb_build_object(
      'state', v_home.status,
      'since', v_home.status_since,
      'alias', v_home.alias,
      'openOutageStart', v_open_start
    ),
    'notify', v_notify
  );
END;
$$;
