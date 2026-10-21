-- Funciones de ingesta (docs/data-model.md, "Funciones de ingesta"). Cada una es una sola
-- consulta por Hyperdrive y corre en la transacción de esa consulta: o se aplica todo o nada.
-- El clasificador no está aquí: corre en el Worker entre las dos llamadas.

-- Guarda un lote sin duplicar (por device_id, id), sube la revisión de la casa (A-016) si
-- aceptó algo y devuelve la ventana que el Worker tiene que clasificar, con el estado de la casa
-- leído bajo el mismo candado (A-023).
CREATE FUNCTION app.ingest_batch(
  p_device_id uuid,
  p_home_id uuid,
  p_events jsonb,
  p_offset_ms bigint,
  p_received_at bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_total integer := jsonb_array_length(p_events);
  v_accepted integer;
  v_oldest_at bigint;
  v_confirmation_anchor bigint;
  v_anchor bigint;
  v_from bigint;
  v_revision bigint;
  v_mode text;
  v_status text;
  v_status_since bigint;
  v_window jsonb;
  v_outages jsonb;
BEGIN
  -- device_at queda como llegó; at es la hora corregida con el desfase del lote.
  WITH inserted AS (
    INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
    SELECT p_device_id, (e->>'id')::uuid, p_home_id, e->>'kind',
           (e->>'at')::bigint, (e->>'at')::bigint + p_offset_ms, e, p_received_at
    FROM jsonb_array_elements(p_events) AS e
    ON CONFLICT (device_id, id) DO NOTHING
    RETURNING kind, at, payload
  )
  SELECT count(*),
         min(at),
         -- outageStart es la hora del servidor que devolvió la API: no lleva desfase.
         -- 300000 = CONFIRMATION_TOLERANCE_MS (src/domain/detection/constants.ts).
         min((payload->>'outageStart')::bigint - 300000) FILTER (WHERE kind = 'confirmation')
  INTO v_accepted, v_oldest_at, v_confirmation_anchor
  FROM inserted;

  IF v_accepted = 0 THEN
    SELECT ingest_revision, mode, status, status_since
    INTO v_revision, v_mode, v_status, v_status_since
    FROM app.homes WHERE id = p_home_id;
    RETURN jsonb_build_object(
      'accepted', 0,
      'duplicated', v_total,
      'revision', v_revision,
      'mode', v_mode,
      'status', jsonb_build_object('state', v_status, 'since', v_status_since),
      'window', '[]'::jsonb,
      'outages', '[]'::jsonb
    );
  END IF;

  -- Toma el candado de la casa: un lote en paralelo espera aquí y, al seguir, ya ve estos eventos.
  -- El estado sale de esta misma fila: incluye todo apply_outages que aplicó antes, y la revisión
  -- nueva impide que otro aplique después sin que apply_outages de este lote lo note (A-023).
  UPDATE app.homes SET ingest_revision = ingest_revision + 1
  WHERE id = p_home_id
  RETURNING ingest_revision, mode, status, status_since
  INTO v_revision, v_mode, v_status, v_status_since;

  v_anchor := least(v_oldest_at, v_confirmation_anchor);

  -- Si el ancla cae dentro de un corte guardado (abierto, o que terminó en el ancla o después),
  -- la ventana arranca antes de ese corte. Un corte manual sigue abierto aunque haya snapshots
  -- powered repetidos dentro: empezar a mitad de corte haría que el clasificador inventara otro.
  SELECT least(v_anchor, min(started_at)) INTO v_anchor
  FROM app.outages
  WHERE home_id = p_home_id
    AND status <> 'sin_datos'
    AND started_at < v_anchor
    AND (ended_at IS NULL OR ended_at >= v_anchor);

  -- Desde el último snapshot powered (plugged y en casa) antes del ancla: ahí el clasificador
  -- está armado y sin corte abierto.
  SELECT at INTO v_from
  FROM app.events
  WHERE home_id = p_home_id
    AND at < v_anchor
    AND kind = 'snapshot'
    AND (payload->>'plugged')::boolean
    AND coalesce((payload->>'homeWifi')::boolean, (payload->>'onWifi')::boolean)
  ORDER BY at DESC
  LIMIT 1;

  IF v_from IS NULL THEN
    SELECT min(at) INTO v_from FROM app.events WHERE home_id = p_home_id;
  END IF;

  SELECT coalesce(jsonb_agg(payload || jsonb_build_object('at', at) ORDER BY at, id), '[]'::jsonb)
  INTO v_window
  FROM app.events
  WHERE home_id = p_home_id AND at >= v_from;

  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', id,
               'start', started_at,
               'end', ended_at,
               'status', status,
               'confidence', confidence,
               'confirmed', confirmed
             )
             ORDER BY started_at, id
           ),
           '[]'::jsonb
         )
  INTO v_outages
  FROM app.outages
  WHERE home_id = p_home_id
    AND status <> 'sin_datos'
    AND (status = 'abierto' OR started_at >= v_from);

  RETURN jsonb_build_object(
    'accepted', v_accepted,
    'duplicated', v_total - v_accepted,
    'revision', v_revision,
    'mode', v_mode,
    'status', jsonb_build_object('state', v_status, 'since', v_status_since),
    'window', v_window,
    'outages', v_outages
  );
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.ingest_batch(uuid, uuid, jsonb, bigint, bigint) FROM PUBLIC;
--> statement-breakpoint

-- Aplica lo que decidió reconcileOutages y el estado nuevo de la casa, solo si nadie más
-- ingirió desde que se calculó (A-016). Devuelve el estado de la casa tal como queda.
CREATE FUNCTION app.apply_outages(
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

    INSERT INTO app.outages (id, home_id, started_at, ended_at, status, confidence, confirmed, updated_at)
    SELECT (c->>'id')::uuid, p_home_id,
           (c->'outage'->>'start')::bigint, (c->'outage'->>'end')::bigint,
           c->'outage'->>'status', c->'outage'->>'confidence',
           (c->'outage'->>'confirmed')::boolean, p_now
    FROM jsonb_array_elements(p_changes) AS c
    WHERE c->>'op' = 'insert';

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

    IF p_status IS NOT NULL AND p_status <> 'null'::jsonb THEN
      UPDATE app.homes
      SET status = p_status->>'state', status_since = (p_status->>'since')::bigint
      WHERE id = p_home_id
        AND (status, status_since)
            IS DISTINCT FROM (p_status->>'state', (p_status->>'since')::bigint);
    END IF;
  END IF;

  SELECT * INTO v_home FROM app.homes WHERE id = p_home_id;
  SELECT max(started_at) INTO v_open_start
  FROM app.outages WHERE home_id = p_home_id AND status = 'abierto';

  RETURN jsonb_build_object(
    'applied', v_applied,
    'status', jsonb_build_object(
      'state', v_home.status,
      'since', v_home.status_since,
      'alias', v_home.alias,
      'openOutageStart', v_open_start
    )
  );
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.apply_outages(uuid, bigint, jsonb, jsonb, bigint) FROM PUBLIC;
